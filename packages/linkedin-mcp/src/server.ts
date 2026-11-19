import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  type AlterCaller,
  type ProxyOutcome,
  describeApproval,
  describeError,
  describePending,
} from "./alter.js";
import {
  DEFAULT_API_VERSION,
  LINKEDIN,
  MAX_COMMENT_CHARS,
  MAX_POST_CHARS,
  POST_URN,
  REACTIONS,
  escapeLittleText,
  postUrl,
} from "./linkedin.js";
import { VERSION } from "./version.js";

export const SERVER_NAME = "@alter-ai/linkedin-mcp";
const PROVIDER = "LinkedIn";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

class Held extends Error {
  constructor(readonly outcome: Extract<ProxyOutcome, { kind: "pending" }>) {
    super("held for approval");
  }
}

class ProviderFailure extends Error {}

/** The provider response, or a thrown error for a hold or a 4xx/5xx. */
function result(outcome: ProxyOutcome, what: string): Extract<ProxyOutcome, { kind: "result" }> {
  if (outcome.kind === "pending") throw new Held(outcome);
  if (outcome.status >= 400) {
    let detail = "";
    try {
      const parsed = JSON.parse(outcome.body) as { message?: string };
      detail = parsed.message ?? "";
    } catch {
      detail = "";
    }
    throw new ProviderFailure(
      `LinkedIn refused to ${what} (HTTP ${outcome.status})${detail ? `: ${detail.slice(0, 300)}` : ""}.`,
    );
  }
  return outcome;
}

const postUrn = z
  .string()
  .regex(POST_URN, "a LinkedIn post URN such as urn:li:share:123")
  .describe("The post's URN, for example urn:li:share:7212345678901234567.");
const reason = z.string().max(500).optional().describe("Why this is being done. Shown to the approver.");

export interface ServerOptions {
  apiVersion?: string;
  log?: (message: string, error: unknown) => void;
}

export function createLinkedInServer(caller: AlterCaller, options: ServerOptions = {}): McpServer {
  const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
  const log = options.log ?? ((message, error) => console.error(`[${SERVER_NAME}] ${message}`, error));
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
  const restHeaders = { "LinkedIn-Version": apiVersion, "X-Restli-Protocol-Version": "2.0.0" };

  const run = async (tool: string, action: () => Promise<ToolResult>): Promise<ToolResult> => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof Held) return ok(describePending(error.outcome, tool));
      if (error instanceof ProviderFailure) return fail(error.message);
      log(`${tool} failed`, error);
      return fail(describeError(error, PROVIDER));
    }
  };

  interface Profile {
    sub: string;
    name?: string;
    email?: string;
  }
  let profile: Promise<Profile> | undefined;
  const me = (): Promise<Profile> => {
    profile ??= (async () => {
      const response = result(
        await caller.proxy({ method: "GET", url: `${LINKEDIN}/v2/userinfo`, tool: "linkedin.get_profile" }),
        "read your profile",
      );
      const parsed = JSON.parse(response.body) as Profile;
      if (!parsed.sub) throw new ProviderFailure("LinkedIn's profile response had no member id.");
      return parsed;
    })().catch((error: unknown) => {
      profile = undefined;
      throw error;
    });
    return profile;
  };
  const author = async () => `urn:li:person:${(await me()).sub}`;

  server.registerTool(
    "get_profile",
    {
      title: "Get my LinkedIn profile",
      description: "The connected member's name, email and member URN (the author of posts and comments).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () =>
      run("get_profile", async () => {
        const profileValue = await me();
        return ok(
          [
            `name: ${profileValue.name ?? ""}`,
            `email: ${profileValue.email ?? ""}`,
            `member urn: urn:li:person:${profileValue.sub}`,
          ].join("\n"),
        );
      }),
  );

  server.registerTool(
    "create_post",
    {
      title: "Post on LinkedIn",
      description: `Publish a text post on the member's profile through LinkedIn's official API. With the recommended policy, this returns an approval link and nothing is posted until a person approves exactly this post in the Alter Wallet. Up to ${MAX_POST_CHARS} characters; links appear as written, and hashtags appear as plain text.`,
      inputSchema: {
        text: z.string().min(1).max(MAX_POST_CHARS),
        visibility: z.enum(["PUBLIC", "CONNECTIONS"]).default("PUBLIC"),
        reason,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ text, visibility, reason: why }) =>
      run("publish a LinkedIn post", async () => {
        const response = result(
          await caller.proxy({
            method: "POST",
            url: `${LINKEDIN}/rest/posts`,
            headers: restHeaders,
            json: {
              author: await author(),
              commentary: escapeLittleText(text),
              visibility,
              distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
              lifecycleState: "PUBLISHED",
              isReshareDisabledByAuthor: false,
            },
            ...(why ? { reason: why } : {}),
            tool: "linkedin.create_post",
          }),
          "publish the post",
        );
        const urn = response.headers["x-restli-id"];
        return ok(urn ? `Posted: ${postUrl(urn)} (${urn})` : "Posted.");
      }),
  );

  server.registerTool(
    "comment_on_post",
    {
      title: "Comment on a LinkedIn post",
      description: `Comment on a post as the member. With the recommended policy, this is held for approval like a post. Up to ${MAX_COMMENT_CHARS} characters.`,
      inputSchema: { post_urn: postUrn, text: z.string().min(1).max(MAX_COMMENT_CHARS), reason },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ post_urn, text, reason: why }) =>
      run("comment on a LinkedIn post", async () => {
        result(
          await caller.proxy({
            method: "POST",
            url: `${LINKEDIN}/v2/socialActions/{urn}/comments`,
            pathParams: { urn: post_urn },
            headers: { "X-Restli-Protocol-Version": "2.0.0" },
            json: { actor: await author(), object: post_urn, message: { text } },
            ...(why ? { reason: why } : {}),
            tool: "linkedin.comment_on_post",
          }),
          "add the comment",
        );
        return ok(`Commented on ${postUrl(post_urn)}.`);
      }),
  );

  server.registerTool(
    "react_to_post",
    {
      title: "React to a LinkedIn post",
      description: "Add a reaction to a post as the member: LIKE, PRAISE (celebrate), EMPATHY (love), INTEREST (insightful), APPRECIATION (support) or ENTERTAINMENT (funny).",
      inputSchema: { post_urn: postUrn, reaction: z.enum(REACTIONS).default("LIKE") },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ post_urn, reaction }) =>
      run("react to a LinkedIn post", async () => {
        result(
          await caller.proxy({
            method: "POST",
            url: `${LINKEDIN}/rest/reactions`,
            queryParams: { actor: await author() },
            headers: restHeaders,
            json: { root: post_urn, reactionType: reaction },
            tool: "linkedin.react_to_post",
          }),
          "add the reaction",
        );
        return ok(`Reacted ${reaction} to ${postUrl(post_urn)}.`);
      }),
  );

  server.registerTool(
    "check_approval",
    {
      title: "Check an approval",
      description:
        "Check what happened to a request held for approval: still waiting, approved and done, denied, expired, or failed when it ran.",
      inputSchema: { approval_id: z.string().min(1).max(100) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ approval_id }) =>
      run("check_approval", async () => ok(describeApproval(await caller.approvalStatus(approval_id)))),
  );

  return server;
}
