import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { AlterCaller, ProxyArgs, ProxyOutcome } from "../src/alter.js";
import { apiVersionFrom, escapeLittleText } from "../src/linkedin.js";
import { createLinkedInServer } from "../src/server.js";
import { VERSION } from "../src/version.js";

const PROFILE: ProxyOutcome = {
  kind: "result",
  status: 200,
  headers: {},
  body: JSON.stringify({ sub: "abc123", name: "Sam Rivera", email: "sam@example.com" }),
};

function fakeCaller(respond: (args: ProxyArgs) => ProxyOutcome) {
  const calls: ProxyArgs[] = [];
  const caller: AlterCaller = {
    async proxy(args) {
      calls.push(args);
      return args.url.endsWith("/v2/userinfo") ? PROFILE : respond(args);
    },
    async approvalStatus() {
      return { status: "executed", decidedAt: null, executedAt: "2026-11-19T22:00:00.000Z", decisionReason: null, executionError: null };
    },
  };
  return { caller, calls };
}

async function connect(caller: AlterCaller) {
  const server = createLinkedInServer(caller, { apiVersion: "202609", log: () => {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content.map((part) => part.text).join("\n");
}

test("version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  assert.equal(VERSION, pkg.version);
});

test("lists only official-API tools: no messaging or connection requests", async () => {
  const client = await connect(fakeCaller(() => PROFILE).caller);
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["check_approval", "comment_on_post", "create_post", "get_profile", "react_to_post"]);
});

test("escapes LinkedIn little-text characters in post commentary", () => {
  assert.equal(escapeLittleText("Ship it (v2) #launch @team_a"), "Ship it \\(v2\\) \\#launch \\@team\\_a");
});

test("reads LINKEDIN_API_VERSION and rejects malformed values", () => {
  assert.equal(apiVersionFrom({}), "202609");
  assert.equal(apiVersionFrom({ LINKEDIN_API_VERSION: "202610" }), "202610");
  assert.throws(() => apiVersionFrom({ LINKEDIN_API_VERSION: "2026-10" }), /YYYYMM/);
});

test("a held post returns the approval link and posts nothing", async () => {
  const { caller, calls } = fakeCaller(() => ({
    kind: "pending",
    approvalId: "ap_9",
    approvalUrls: ["https://wallet.example.com/approvals/ap_9"],
    expiresAt: "2026-11-20T21:00:00.000Z",
  }));
  const client = await connect(caller);
  const result = await client.callTool({
    name: "create_post",
    arguments: { text: "New article (link below)", reason: "Announce this week's article" },
  });
  const text = textOf(result);
  assert.match(text, /Held for approval/);
  assert.match(text, /https:\/\/wallet\.example\.com\/approvals\/ap_9/);
  const post = calls.find((call) => call.url.endsWith("/rest/posts"));
  assert.ok(post);
  assert.equal(post.headers?.["LinkedIn-Version"], "202609");
  assert.equal(post.reason, "Announce this week's article");
  const body = post.json as { author: string; commentary: string; visibility: string; lifecycleState: string };
  assert.equal(body.author, "urn:li:person:abc123");
  assert.equal(body.commentary, "New article \\(link below\\)");
  assert.equal(body.visibility, "PUBLIC");
  assert.equal(body.lifecycleState, "PUBLISHED");
});

test("a published post returns its URL from the x-restli-id header", async () => {
  const client = await connect(
    fakeCaller(() => ({ kind: "result", status: 201, headers: { "x-restli-id": "urn:li:share:7001" }, body: "" })).caller,
  );
  const result = await client.callTool({ name: "create_post", arguments: { text: "Hello" } });
  assert.match(textOf(result), /https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:share:7001\//);
});

test("comments go to the post's socialActions path as the member", async () => {
  const { caller, calls } = fakeCaller(() => ({ kind: "result", status: 201, headers: {}, body: "{}" }));
  const client = await connect(caller);
  await client.callTool({ name: "comment_on_post", arguments: { post_urn: "urn:li:share:7001", text: "Great point" } });
  const comment = calls.find((call) => call.url.includes("socialActions"));
  assert.equal(comment?.pathParams?.urn, "urn:li:share:7001");
  assert.deepEqual(comment?.json, {
    actor: "urn:li:person:abc123",
    object: "urn:li:share:7001",
    message: { text: "Great point" },
  });
});

test("rejects a malformed post URN before calling Alter", async () => {
  const { caller, calls } = fakeCaller(() => PROFILE);
  const client = await connect(caller);
  const result = await client.callTool({
    name: "react_to_post",
    arguments: { post_urn: "https://www.linkedin.com/feed/update/urn:li:share:1", reaction: "LIKE" },
  });
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.equal(calls.length, 0);
});

test("reports LinkedIn's error message on a 4xx", async () => {
  const client = await connect(
    fakeCaller(() => ({ kind: "result", status: 422, headers: {}, body: JSON.stringify({ message: "Duplicate post" }) })).caller,
  );
  const result = await client.callTool({ name: "create_post", arguments: { text: "Hello" } });
  assert.equal((result as { isError?: boolean }).isError, true);
  assert.match(textOf(result), /LinkedIn refused to publish the post \(HTTP 422\): Duplicate post/);
});

test("check_approval reports a completed request", async () => {
  const client = await connect(fakeCaller(() => PROFILE).caller);
  const result = await client.callTool({ name: "check_approval", arguments: { approval_id: "ap_9" } });
  assert.match(textOf(result), /Approved and done at 2026-11-19T22:00:00\.000Z/);
});
