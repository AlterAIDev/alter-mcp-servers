import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { AlterCaller, ProxyArgs, ProxyOutcome } from "../src/alter.js";
import { createXServer } from "../src/server.js";
import { VERSION } from "../src/version.js";

const ME: ProxyOutcome = {
  kind: "result",
  status: 200,
  headers: {},
  body: JSON.stringify({ data: { id: "42", username: "samrivera", name: "Sam Rivera", public_metrics: { followers_count: 10 } } }),
};

const PAGE = {
  data: [
    { id: "1900000000000000001", text: "Who runs MCP servers for a whole team?", author_id: "7", created_at: "2026-11-19T10:00:00.000Z", public_metrics: { like_count: 3, reply_count: 1, retweet_count: 0 } },
  ],
  includes: { users: [{ id: "7", username: "ana_builds", name: "Ana" }] },
};

function fakeCaller(respond: (args: ProxyArgs) => ProxyOutcome) {
  const calls: ProxyArgs[] = [];
  const caller: AlterCaller = {
    async proxy(args) {
      calls.push(args);
      return args.url.endsWith("/2/users/me") ? ME : respond(args);
    },
    async approvalStatus() {
      return { status: "pending", decidedAt: null, executedAt: null, decisionReason: null, executionError: null };
    },
  };
  return { caller, calls };
}

const json = (body: unknown, status = 200): ProxyOutcome => ({ kind: "result", status, headers: {}, body: JSON.stringify(body) });

async function connect(caller: AlterCaller) {
  const server = createXServer(caller, { log: () => {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

const textOf = (result: unknown) => (result as { content: { text: string }[] }).content.map((part) => part.text).join("\n");

test("version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version);
});

test("lists the X tools, with read-only hints on the reads", async () => {
  const client = await connect(fakeCaller(() => json({})).caller);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["check_approval", "create_post", "get_mentions", "get_profile", "like_post", "repost", "search_posts"]);
  for (const name of ["get_profile", "search_posts", "get_mentions", "check_approval"]) {
    assert.equal(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint, true, name);
  }
});

test("search shows author, link and engagement, and labels the posts untrusted", async () => {
  const { caller, calls } = fakeCaller(() => json(PAGE));
  const client = await connect(caller);
  const text = textOf(await client.callTool({ name: "search_posts", arguments: { query: '"mcp server" -is:retweet', max_results: 25 } }));
  assert.match(text, /untrusted content/);
  assert.match(text, /@ana_builds \(Ana\)/);
  assert.match(text, /https:\/\/x\.com\/ana_builds\/status\/1900000000000000001/);
  assert.match(text, /3 likes, 1 replies, 0 reposts/);
  const search = calls.find((call) => call.url.endsWith("/2/tweets/search/recent"));
  assert.equal(search?.queryParams?.query, '"mcp server" -is:retweet');
  assert.equal(search?.queryParams?.max_results, 25);
  assert.equal(search?.queryParams?.expansions, "author_id");
});

test("mentions are read for the connected account's own id", async () => {
  const { caller, calls } = fakeCaller(() => json(PAGE));
  const client = await connect(caller);
  await client.callTool({ name: "get_mentions", arguments: {} });
  const mentions = calls.find((call) => call.url.includes("/mentions"));
  assert.equal(mentions?.pathParams?.id, "42");
  assert.equal(mentions?.queryParams?.max_results, 20);
});

test("a held post returns the approval link and posts nothing", async () => {
  const { caller, calls } = fakeCaller(() => ({
    kind: "pending",
    approvalId: "ap_1",
    approvalUrls: ["https://wallet.example.com/approvals/ap_1"],
    expiresAt: "2026-11-21T00:00:00.000Z",
  }));
  const client = await connect(caller);
  const text = textOf(await client.callTool({ name: "create_post", arguments: { text: "New article", reply_to: "1900000000000000001", reason: "Share the article" } }));
  assert.match(text, /Held for approval/);
  const post = calls.find((call) => call.url.endsWith("/2/tweets"));
  assert.deepEqual(post?.json, { text: "New article", reply: { in_reply_to_tweet_id: "1900000000000000001" } });
  assert.equal(post?.reason, "Share the article");
  assert.equal(post?.tool, "x.create_post");
});

test("a published post returns its URL under the account's handle", async () => {
  const client = await connect(fakeCaller(() => json({ data: { id: "1900000000000000002", text: "hi" } }, 201)).caller);
  assert.match(textOf(await client.callTool({ name: "create_post", arguments: { text: "hi" } })), /https:\/\/x\.com\/samrivera\/status\/1900000000000000002/);
});

test("likes and reposts go to the account's own id with the post id in the body", async () => {
  const { caller, calls } = fakeCaller(() => json({ data: { liked: true } }));
  const client = await connect(caller);
  await client.callTool({ name: "like_post", arguments: { post_id: "1900000000000000001" } });
  await client.callTool({ name: "repost", arguments: { post_id: "1900000000000000001" } });
  const like = calls.find((call) => call.url.endsWith("/likes"));
  const repost = calls.find((call) => call.url.endsWith("/retweets"));
  assert.equal(like?.pathParams?.id, "42");
  assert.deepEqual(like?.json, { tweet_id: "1900000000000000001" });
  assert.deepEqual(repost?.json, { tweet_id: "1900000000000000001" });
});

test("a malformed post id is refused before calling Alter", async () => {
  const { caller, calls } = fakeCaller(() => json({}));
  const client = await connect(caller);
  const result = await client.callTool({ name: "like_post", arguments: { post_id: "https://x.com/a/status/1" } });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});

test("a 403 points at the developer app's credits and access", async () => {
  const client = await connect(fakeCaller(() => json({ title: "Forbidden", detail: "Your client app is not configured with the appropriate oauth1 app permissions" }, 403)).caller);
  const result = await client.callTool({ name: "create_post", arguments: { text: "hi" } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /HTTP 403.*appropriate oauth1 app permissions.*prepaid credits/s);
});

test("check_approval reports a pending request", async () => {
  const client = await connect(fakeCaller(() => json({})).caller);
  assert.match(textOf(await client.callTool({ name: "check_approval", arguments: { approval_id: "ap_1" } })), /waiting|pending/i);
});
