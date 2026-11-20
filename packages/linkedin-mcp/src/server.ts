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
  IMAGE_TYPES,
  LINKEDIN,
  MAX_ALT_TEXT_CHARS,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  MAX_VIDEO_TITLE_CHARS,
  MIN_VIDEO_BYTES,
  type UploadInstruction,
  isLinkedInUploadUrl,
  MAX_COMMENT_CHARS,
  MAX_LINK_DESCRIPTION_CHARS,
  MAX_LINK_TITLE_CHARS,
  MAX_POST_CHARS,
  POST_URN,
  REACTIONS,
  escapeLittleText,
  postUrl,
} from "./linkedin.js";
import { type Media, MediaError, type MediaOptions, formatBytes, openMedia, reasonWithMedia } from "./media.js";
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
  /** Where media may come from. Defaults to public https URLs only. */
  media?: MediaOptions;
  /** Sends video parts straight to LinkedIn (they carry no token); replaced in tests. */
  fetch?: typeof fetch;
}

export function createLinkedInServer(caller: AlterCaller, options: ServerOptions = {}): McpServer {
  const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
  const log = options.log ?? ((message, error) => console.error(`[${SERVER_NAME}] ${message}`, error));
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });
  const restHeaders = { "LinkedIn-Version": apiVersion, "X-Restli-Protocol-Version": "2.0.0" };
  const mediaOptions: MediaOptions = options.media ?? { allowFiles: false };
  const fetchImpl = options.fetch ?? fetch;

  const run = async (tool: string, action: () => Promise<ToolResult>): Promise<ToolResult> => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof Held) return ok(describePending(error.outcome, tool));
      if (error instanceof ProviderFailure || error instanceof MediaError) return fail(error.message);
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

  /** An upload step's response; a hold here means the policy holds uploads, which it should not. */
  const uploadStep = (outcome: ProxyOutcome, what: string) => {
    if (outcome.kind === "pending") {
      throw new ProviderFailure(
        `Alter held a media upload for approval (approval ${outcome.approvalId}). Uploads are not visible until the post is published, so hold the post instead: see the README's recommended policy.`,
      );
    }
    return result(outcome, what);
  };

  /** Uploads one image (through Alter, which adds the member's token) and returns its URN. */
  async function uploadImage(media: Media, owner: string): Promise<string> {
    const tool = "linkedin.upload_media";
    const init = uploadStep(
      await caller.proxy({
        method: "POST",
        url: `${LINKEDIN}/rest/images`,
        queryParams: { action: "initializeUpload" },
        headers: restHeaders,
        json: { initializeUploadRequest: { owner } },
        tool,
      }),
      "start the image upload",
    );
    const value = (JSON.parse(init.body) as { value?: { uploadUrl?: string; image?: string } }).value;
    if (!value?.uploadUrl || !value.image || !isLinkedInUploadUrl(value.uploadUrl)) {
      throw new ProviderFailure("LinkedIn did not return a usable image upload URL.");
    }
    const data = await media.read(media.size);
    uploadStep(
      await caller.proxy({
        method: "PUT",
        url: value.uploadUrl,
        body: data,
        headers: { "Content-Type": media.contentType },
        tool,
      }),
      "upload the image",
    );
    return value.image;
  }

  /**
   * Uploads one video: initialized and finalized through Alter; the parts go
   * straight to LinkedIn's upload URLs, which LinkedIn requires to carry no token.
   */
  async function uploadVideo(media: Media, owner: string): Promise<string> {
    const tool = "linkedin.upload_media";
    const init = uploadStep(
      await caller.proxy({
        method: "POST",
        url: `${LINKEDIN}/rest/videos`,
        queryParams: { action: "initializeUpload" },
        headers: restHeaders,
        json: { initializeUploadRequest: { owner, fileSizeBytes: media.size, uploadCaptions: false, uploadThumbnail: false } },
        tool,
      }),
      "start the video upload",
    );
    const value = (
      JSON.parse(init.body) as { value?: { video?: string; uploadToken?: string; uploadInstructions?: UploadInstruction[] } }
    ).value;
    const instructions = value?.uploadInstructions ?? [];
    if (!value?.video || instructions.length === 0 || instructions.some((step) => !isLinkedInUploadUrl(step.uploadUrl))) {
      throw new ProviderFailure("LinkedIn did not return usable video upload instructions.");
    }
    const etags: string[] = [];
    let expected = 0;
    for (const step of [...instructions].sort((a, b) => a.firstByte - b.firstByte)) {
      if (step.firstByte !== expected || step.lastByte < step.firstByte || step.lastByte >= media.size) {
        throw new ProviderFailure("LinkedIn's video upload instructions do not cover the file in order.");
      }
      const part = await media.read(step.lastByte - step.firstByte + 1);
      const response = await fetchImpl(step.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: part,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderFailure(`LinkedIn refused part of the video upload (HTTP ${response.status}).`);
      }
      const etag = response.headers.get("etag");
      if (!etag) throw new ProviderFailure("LinkedIn did not acknowledge a video part (no ETag).");
      etags.push(etag);
      expected = step.lastByte + 1;
    }
    if (expected !== media.size) throw new ProviderFailure("LinkedIn's video upload instructions do not cover the whole file.");
    uploadStep(
      await caller.proxy({
        method: "POST",
        url: `${LINKEDIN}/rest/videos`,
        queryParams: { action: "finalizeUpload" },
        headers: restHeaders,
        json: { finalizeUploadRequest: { video: value.video, uploadToken: value.uploadToken ?? "", uploadedPartIds: etags } },
        tool,
      }),
      "finish the video upload",
    );
    return value.video;
  }

  async function openChecked(source: string, kind: "image" | "video"): Promise<Media> {
    const media = await openMedia(source, kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES, mediaOptions);
    const problem =
      kind === "image"
        ? IMAGE_TYPES.includes(media.contentType)
          ? undefined
          : `${source} is ${media.contentType}; LinkedIn images are JPEG, PNG or GIF.`
        : media.contentType !== "video/mp4"
          ? `${source} is ${media.contentType}; LinkedIn videos are MP4.`
          : media.size < MIN_VIDEO_BYTES
            ? `${source} is ${formatBytes(media.size)}; LinkedIn videos are at least ${formatBytes(MIN_VIDEO_BYTES)}.`
            : undefined;
    if (problem) {
      await media.close();
      throw new MediaError(problem);
    }
    return media;
  }

  server.registerTool(
    "create_post",
    {
      title: "Post on LinkedIn",
      description: `Publish a post on the member's profile through LinkedIn's official API, optionally with images or a video. With the recommended policy, this returns an approval link and nothing is posted until a person approves exactly this post; the approver sees where each attached file came from. Up to ${MAX_POST_CHARS} characters; hashtags appear as plain text. To share an article, pass \`link\`: LinkedIn shows it as a card with the title and description (no image), which a URL inside the text does not get. A post has one of \`link\`, \`images\` or \`video\`.`,
      inputSchema: {
        text: z.string().min(1).max(MAX_POST_CHARS),
        visibility: z.enum(["PUBLIC", "CONNECTIONS"]).default("PUBLIC"),
        link: z
          .object({
            url: z.url({ protocol: /^https$/ }).describe("The article's https URL."),
            title: z.string().min(1).max(MAX_LINK_TITLE_CHARS),
            description: z.string().max(MAX_LINK_DESCRIPTION_CHARS).optional(),
          })
          .optional()
          .describe("An article to attach as a link card."),
        images: z
          .array(
            z.object({
              source: z.string().min(1).max(2048),
              alt_text: z.string().max(MAX_ALT_TEXT_CHARS).optional().describe("Describes the image for people using screen readers."),
            }),
          )
          .min(1)
          .max(MAX_IMAGES)
          .optional()
          .describe(
            `1 to ${MAX_IMAGES} images (JPEG, PNG or GIF, up to ${formatBytes(MAX_IMAGE_BYTES)} each). \`source\` is an https URL anyone can open, or, when the server runs on this computer, an absolute file path.`,
          ),
        video: z
          .object({
            source: z.string().min(1).max(2048),
            title: z.string().max(MAX_VIDEO_TITLE_CHARS).optional(),
          })
          .optional()
          .describe(
            `One MP4 video, ${formatBytes(MIN_VIDEO_BYTES)} to ${formatBytes(MAX_VIDEO_BYTES)}, 3 seconds to 30 minutes long. \`source\` as for images.`,
          ),
        reason,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    ({ text, visibility, link, images, video, reason: why }) =>
      run("publish a LinkedIn post", async () => {
        if ([link, images, video].filter((item) => item !== undefined).length > 1) {
          return fail("A post has one of link, images or video, not several.");
        }
        const owner = await author();
        const opened: Media[] = [];
        let content: Record<string, unknown> | undefined;
        try {
          if (images) {
            const ids: string[] = [];
            for (const image of images) {
              const media = await openChecked(image.source, "image");
              opened.push(media);
              ids.push(await uploadImage(media, owner));
              await media.close();
            }
            const entries = ids.map((id, index) => {
              const alt = images[index]?.alt_text;
              return { id, ...(alt ? { altText: alt } : {}) };
            });
            content = entries.length === 1 ? { media: entries[0] } : { multiImage: { images: entries } };
          } else if (video) {
            const media = await openChecked(video.source, "video");
            opened.push(media);
            const id = await uploadVideo(media, owner);
            content = { media: { id, ...(video.title ? { title: video.title } : {}) } };
          }
        } finally {
          await Promise.all(opened.map((media) => media.close()));
        }
        const fullReason = reasonWithMedia(why, opened);
        const response = result(
          await caller.proxy({
            method: "POST",
            url: `${LINKEDIN}/rest/posts`,
            headers: restHeaders,
            json: {
              author: owner,
              commentary: escapeLittleText(text),
              visibility,
              distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
              ...(link
                ? {
                    content: {
                      article: {
                        source: link.url,
                        title: link.title,
                        ...(link.description ? { description: link.description } : {}),
                      },
                    },
                  }
                : content
                  ? { content }
                  : {}),
              lifecycleState: "PUBLISHED",
              isReshareDisabledByAuthor: false,
            },
            ...(fullReason ? { reason: fullReason } : {}),
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
