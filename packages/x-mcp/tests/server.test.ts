import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { AlterCaller, ProxyArgs, ProxyOutcome } from "../src/alter.js";
import { type ServerOptions, createXServer } from "../src/server.js";
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

async function connect(caller: AlterCaller, options: Omit<ServerOptions, "log"> = {}) {
  const server = createXServer(caller, { log: () => {}, ...options });
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

// Media.

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
/** An MP4 header ("ftypisom") followed by filler, 9 MB so it takes three 4 MB segments. */
const MP4 = (() => {
  const bytes = new Uint8Array(9 * 1024 * 1024);
  bytes.set([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypisom")]);
  return bytes;
})();

function serve(files: Record<string, Uint8Array<ArrayBuffer>>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const file = files[String(input instanceof Request ? input.url : input)];
    if (!file) return new Response("missing", { status: 404 });
    return new Response(file, { headers: { "content-length": String(file.length) } });
  }) as typeof fetch;
}

/** Answers X's upload endpoints; finalize reports processing once when `processing` is set. */
function uploads(options: { processing?: boolean; held?: boolean } = {}) {
  let checks = 0;
  return (args: ProxyArgs): ProxyOutcome => {
    if (args.url.endsWith("/2/media/upload/initialize")) {
      return options.held
        ? { kind: "pending", approvalId: "ap_up", approvalUrls: ["https://wallet.example.com/approvals/ap_up"], expiresAt: "2026-11-21T00:00:00.000Z" }
        : json({ data: { id: `m${(args.json as { total_bytes: number }).total_bytes}` } });
    }
    if (args.url.endsWith("/append")) return json({});
    if (args.url.endsWith("/finalize")) {
      return json({ data: { id: args.pathParams?.id, ...(options.processing ? { processing_info: { state: "pending", check_after_secs: 5 } } : {}) } });
    }
    if (args.url.endsWith("/2/media/upload")) {
      checks += 1;
      return json({ data: { processing_info: { state: checks > 1 ? "succeeded" : "in_progress", check_after_secs: 1 } } });
    }
    return json({ data: { id: "1900000000000000009" } });
  };
}

test("an image is uploaded in segments, attached to the post, and named in the approval reason", async () => {
  const { caller, calls } = fakeCaller(uploads());
  const client = await connect(caller, { media: { allowFiles: false, fetch: serve({ "https://cdn.example.com/a.png": PNG }) } });
  const result = await client.callTool({
    name: "create_post",
    arguments: { text: "Look", media: ["https://cdn.example.com/a.png"], reason: "Launch post" },
  });
  assert.match(textOf(result), /Posted: https:\/\/x\.com\/samrivera\/status\/1900000000000000009/);
  const init = calls.find((call) => call.url.endsWith("/initialize"));
  assert.deepEqual(init?.json, { media_type: "image/png", total_bytes: 12, media_category: "tweet_image" });
  const append = calls.find((call) => call.url.endsWith("/append"));
  assert.equal(append?.pathParams?.id, "m12");
  assert.match(append?.headers?.["Content-Type"] ?? "", /^multipart\/form-data; boundary=/);
  const appended = new TextDecoder("latin1").decode(append?.body);
  assert.match(appended, /name="segment_index"\r\n\r\n0\r\n/);
  assert.ok(appended.includes(new TextDecoder("latin1").decode(PNG)));
  const post = calls.find((call) => call.url.endsWith("/2/tweets"));
  assert.deepEqual(post?.json, { text: "Look", media: { media_ids: ["m12"] } });
  assert.equal(post?.reason, "Launch post\nAttached (1):\n- a.png (image/png, 12 B) from https://cdn.example.com/a.png");
});

test("a video goes up in 4 MB segments and the post waits for X to finish processing it", async () => {
  const waits: number[] = [];
  const { caller, calls } = fakeCaller(uploads({ processing: true }));
  const client = await connect(caller, {
    media: { allowFiles: false, fetch: serve({ "https://cdn.example.com/demo.mp4": MP4 }) },
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  await client.callTool({ name: "create_post", arguments: { text: "Demo", media: ["https://cdn.example.com/demo.mp4"] } });
  const appends = calls.filter((call) => call.url.endsWith("/append"));
  assert.equal(appends.length, 3);
  assert.deepEqual(
    appends.map((call) => new TextDecoder("latin1").decode(call.body).match(/name="segment_index"\r\n\r\n(\d+)/)?.[1]),
    ["0", "1", "2"],
  );
  assert.equal((calls.find((call) => call.url.endsWith("/initialize"))?.json as { media_category?: string }).media_category, "tweet_video");
  assert.deepEqual(waits, [5000, 1000]);
  const status = calls.find((call) => call.method === "GET" && call.url.endsWith("/2/media/upload"));
  assert.deepEqual(status?.queryParams, { command: "STATUS", media_id: `m${MP4.length}` });
  assert.deepEqual((calls.find((call) => call.url.endsWith("/2/tweets"))?.json as { media: unknown }).media, { media_ids: [`m${MP4.length}`] });
});

test("a mix of an image and a video is refused before anything is uploaded", async () => {
  const { caller, calls } = fakeCaller(uploads());
  const client = await connect(caller, {
    media: { allowFiles: false, fetch: serve({ "https://cdn.example.com/a.png": PNG, "https://cdn.example.com/demo.mp4": MP4 }) },
  });
  const result = await client.callTool({
    name: "create_post",
    arguments: { text: "x", media: ["https://cdn.example.com/a.png", "https://cdn.example.com/demo.mp4"] },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /up to 4 images, or one GIF, or one video, not a mix/);
  assert.equal(calls.length, 0);
});

test("a file type X does not take is refused", async () => {
  const { caller, calls } = fakeCaller(uploads());
  const client = await connect(caller, { media: { allowFiles: false, fetch: serve({ "https://cdn.example.com/notes.txt": new TextEncoder().encode("hello") as Uint8Array<ArrayBuffer> }) } });
  const result = await client.callTool({ name: "create_post", arguments: { text: "x", media: ["https://cdn.example.com/notes.txt"] } });
  assert.match(textOf(result), /notes\.txt is application\/octet-stream; X takes JPEG, PNG, WEBP, GIF, MP4 or MOV/);
  assert.equal(calls.length, 0);
});

test("an upload held by the policy explains that the post, not the upload, should be held", async () => {
  const { caller, calls } = fakeCaller(uploads({ held: true }));
  const client = await connect(caller, { media: { allowFiles: false, fetch: serve({ "https://cdn.example.com/a.png": PNG }) } });
  const result = await client.callTool({ name: "create_post", arguments: { text: "x", media: ["https://cdn.example.com/a.png"] } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /Alter held a media upload for approval \(approval ap_up\).*hold the post instead/s);
  assert.ok(!calls.some((call) => call.url.endsWith("/2/tweets")));
});
