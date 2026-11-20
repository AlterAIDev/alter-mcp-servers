import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { AlterCaller, ProxyArgs, ProxyOutcome } from "../src/alter.js";
import { apiVersionFrom, escapeLittleText } from "../src/linkedin.js";
import { type ServerOptions, createLinkedInServer } from "../src/server.js";
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

async function connect(caller: AlterCaller, options: Omit<ServerOptions, "log" | "apiVersion"> = {}) {
  const server = createLinkedInServer(caller, { apiVersion: "202609", log: () => {}, ...options });
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

test("a post with a link attaches it as an article card", async () => {
  const { caller, calls } = fakeCaller(() => ({ kind: "result", status: 201, headers: {}, body: "" }));
  const client = await connect(caller);
  await client.callTool({
    name: "create_post",
    arguments: {
      text: "New article",
      link: { url: "https://example.com/blog/post?utm_source=linkedin", title: "The post", description: "What it covers" },
    },
  });
  const post = calls.find((call) => call.url.endsWith("/rest/posts"));
  const body = post?.json as { content?: unknown };
  assert.deepEqual(body.content, {
    article: { source: "https://example.com/blog/post?utm_source=linkedin", title: "The post", description: "What it covers" },
  });
});

test("a post without a link carries no content, and a non-https link is refused", async () => {
  const { caller, calls } = fakeCaller(() => ({ kind: "result", status: 201, headers: {}, body: "" }));
  const client = await connect(caller);
  await client.callTool({ name: "create_post", arguments: { text: "Plain" } });
  const plain = calls.find((call) => call.url.endsWith("/rest/posts"));
  assert.equal((plain?.json as { content?: unknown }).content, undefined);

  const refused = await client.callTool({
    name: "create_post",
    arguments: { text: "Bad link", link: { url: "http://example.com/post", title: "Insecure" } },
  });
  assert.equal(refused.isError, true);
  assert.equal(calls.filter((call) => call.url.endsWith("/rest/posts")).length, 1);
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

// Images and video.

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
/** An MP4 just over two LinkedIn parts (4,194,304 bytes each). */
const MP4 = (() => {
  const bytes = new Uint8Array(4_194_304 * 2 + 100);
  bytes.set([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypisom")]);
  return bytes;
})();
const UPLOAD = "https://www.linkedin.com/dms-uploads/sp/v2/D5610AQ/uploaded-image/0?ca=vector&cn=uploads";

function serve(files: Record<string, Uint8Array<ArrayBuffer>>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const file = files[String(input instanceof Request ? input.url : input)];
    if (!file) return new Response("missing", { status: 404 });
    return new Response(file, { headers: { "content-length": String(file.length) } });
  }) as typeof fetch;
}

const ok201 = (headers: Record<string, string> = {}): ProxyOutcome => ({ kind: "result", status: 201, headers, body: "" });
const value = (body: unknown): ProxyOutcome => ({ kind: "result", status: 200, headers: {}, body: JSON.stringify({ value: body }) });

function imageApi(uploadUrl = UPLOAD) {
  let n = 0;
  return (args: ProxyArgs): ProxyOutcome => {
    if (args.url.endsWith("/rest/images")) return value({ uploadUrl, image: `urn:li:image:I${(n += 1)}` });
    if (args.method === "PUT") return ok201();
    return ok201({ "x-restli-id": "urn:li:share:7300000000000000001" });
  };
}

test("one image is uploaded through Alter with the member's token and posted with its alt text", async () => {
  const { caller, calls } = fakeCaller(imageApi());
  const client = await connect(caller, { media: { allowFiles: false, fetch: serve({ "https://cdn.example.com/chart.png": PNG }) } });
  const result = await client.callTool({
    name: "create_post",
    arguments: { text: "New chart", images: [{ source: "https://cdn.example.com/chart.png", alt_text: "Bar chart" }], reason: "Weekly update" },
  });
  assert.match(textOf(result), /Posted: .*urn:li:share:7300000000000000001/);
  const init = calls.find((call) => call.url.endsWith("/rest/images"));
  assert.deepEqual(init?.queryParams, { action: "initializeUpload" });
  assert.deepEqual(init?.json, { initializeUploadRequest: { owner: "urn:li:person:abc123" } });
  const put = calls.find((call) => call.method === "PUT");
  assert.equal(put?.url, UPLOAD);
  assert.deepEqual(put?.body, PNG);
  assert.equal(put?.headers?.["Content-Type"], "image/png");
  const post = calls.find((call) => call.url.endsWith("/rest/posts"));
  assert.deepEqual((post?.json as { content: unknown }).content, { media: { id: "urn:li:image:I1", altText: "Bar chart" } });
  assert.equal(post?.reason, "Weekly update\nAttached (1):\n- chart.png (image/png, 10 B) from https://cdn.example.com/chart.png");
});

test("several images become a multi-image post in the order given", async () => {
  const { caller, calls } = fakeCaller(imageApi());
  const files = { "https://cdn.example.com/1.png": PNG, "https://cdn.example.com/2.png": PNG };
  const client = await connect(caller, { media: { allowFiles: false, fetch: serve(files) } });
  await client.callTool({ name: "create_post", arguments: { text: "Two", images: [{ source: "https://cdn.example.com/1.png" }, { source: "https://cdn.example.com/2.png", alt_text: "Second" }] } });
  const post = calls.find((call) => call.url.endsWith("/rest/posts"));
  assert.deepEqual((post?.json as { content: unknown }).content, {
    multiImage: { images: [{ id: "urn:li:image:I1" }, { id: "urn:li:image:I2", altText: "Second" }] },
  });
});

test("a video's parts go straight to LinkedIn with no token, then the upload is finalized through Alter with their ETags", async () => {
  const puts: { url: string; headers: Headers; size: number }[] = [];
  const direct = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://cdn.example.com/")) return serve({ "https://cdn.example.com/demo.mp4": MP4 })(input, init);
    puts.push({ url, headers: new Headers(init?.headers), size: (init?.body as Uint8Array).length });
    return new Response(null, { status: 200, headers: { etag: `"etag-${puts.length}"` } });
  }) as typeof fetch;
  const { caller, calls } = fakeCaller((args) => {
    if (args.url.endsWith("/rest/videos") && args.queryParams?.action === "initializeUpload") {
      return value({
        video: "urn:li:video:V1",
        uploadToken: "",
        uploadInstructions: [
          { uploadUrl: "https://www.linkedin.com/dms-uploads/sp/v2/V1/part/1", firstByte: 4_194_304, lastByte: MP4.length - 1 },
          { uploadUrl: "https://www.linkedin.com/dms-uploads/sp/v2/V1/part/0", firstByte: 0, lastByte: 4_194_303 },
        ],
      });
    }
    if (args.url.endsWith("/rest/videos")) return { kind: "result", status: 200, headers: {}, body: "" };
    return ok201({ "x-restli-id": "urn:li:share:7300000000000000002" });
  });
  const client = await connect(caller, { media: { allowFiles: false, fetch: direct }, fetch: direct });
  await client.callTool({ name: "create_post", arguments: { text: "Demo", video: { source: "https://cdn.example.com/demo.mp4", title: "Product demo" } } });
  assert.deepEqual(
    puts.map((put) => [put.url.split("/").pop(), put.size, put.headers.get("authorization")]),
    [["0", 4_194_304, null], ["1", MP4.length - 4_194_304, null]],
  );
  const init = calls.find((call) => call.queryParams?.action === "initializeUpload");
  assert.deepEqual(init?.json, { initializeUploadRequest: { owner: "urn:li:person:abc123", fileSizeBytes: MP4.length, uploadCaptions: false, uploadThumbnail: false } });
  const finalize = calls.find((call) => call.queryParams?.action === "finalizeUpload");
  assert.deepEqual(finalize?.json, { finalizeUploadRequest: { video: "urn:li:video:V1", uploadToken: "", uploadedPartIds: ['"etag-1"', '"etag-2"'] } });
  const post = calls.find((call) => call.url.endsWith("/rest/posts"));
  assert.deepEqual((post?.json as { content: unknown }).content, { media: { id: "urn:li:video:V1", title: "Product demo" } });
});

test("a post with both a link and images is refused before anything is uploaded", async () => {
  const { caller, calls } = fakeCaller(imageApi());
  const client = await connect(caller);
  const result = await client.callTool({
    name: "create_post",
    arguments: { text: "x", link: { url: "https://alterauth.com/blog/x", title: "X" }, images: [{ source: "https://cdn.example.com/1.png" }] },
  });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /one of link, images or video/);
  assert.equal(calls.length, 0);
});

test("an upload URL that is not LinkedIn's is never used", async () => {
  const { caller, calls } = fakeCaller(imageApi("https://attacker.example/dms-uploads/x"));
  const client = await connect(caller, { media: { allowFiles: false, fetch: serve({ "https://cdn.example.com/chart.png": PNG }) } });
  const result = await client.callTool({ name: "create_post", arguments: { text: "x", images: [{ source: "https://cdn.example.com/chart.png" }] } });
  assert.match(textOf(result), /did not return a usable image upload URL/);
  assert.ok(!calls.some((call) => call.method === "PUT"));
});

test("a video that is not MP4 is refused", async () => {
  const { caller, calls } = fakeCaller(imageApi());
  const client = await connect(caller, { media: { allowFiles: false, fetch: serve({ "https://cdn.example.com/chart.png": PNG }) } });
  const result = await client.callTool({ name: "create_post", arguments: { text: "x", video: { source: "https://cdn.example.com/chart.png" } } });
  assert.match(textOf(result), /chart\.png is image\/png; LinkedIn videos are MP4/);
  assert.ok(!calls.some((call) => call.url.endsWith("/rest/videos")));
});
