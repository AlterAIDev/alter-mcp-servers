import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { AlterCaller, ProxyArgs, ProxyOutcome } from "../src/alter.js";
import { NOTION_VERSION, propertyText } from "../src/notion.js";
import { createNotionServer } from "../src/server.js";
import { VERSION } from "../src/version.js";

const PAGE_ID = "1a2b3c4d5e6f40718293a4b5c6d7e8f9";
const DB_ID = "2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901";

const json = (body: unknown, status = 200): ProxyOutcome => ({ kind: "result", status, headers: {}, body: JSON.stringify(body) });

function fakeCaller(respond: (args: ProxyArgs) => ProxyOutcome) {
  const calls: ProxyArgs[] = [];
  const caller: AlterCaller = {
    async proxy(args) {
      calls.push(args);
      return respond(args);
    },
    async approvalStatus() {
      return { status: "denied", decidedAt: "2026-11-20T00:00:00.000Z", executedAt: null, decisionReason: "Not now", executionError: null };
    },
  };
  return { caller, calls };
}

async function connect(caller: AlterCaller) {
  const server = createNotionServer(caller, { log: () => {} });
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

test("lists the Notion tools, with read-only hints on the reads", async () => {
  const client = await connect(fakeCaller(() => json({})).caller);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["add_comment", "append_to_page", "check_approval", "create_page", "query_database", "read_page", "search"]);
  for (const name of ["search", "read_page", "query_database", "check_approval"]) {
    assert.equal(tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint, true, name);
  }
});

test("every call sends the Notion version Alter's catalog is attested against", async () => {
  const { caller, calls } = fakeCaller(() => json({ results: [] }));
  const client = await connect(caller);
  await client.callTool({ name: "search", arguments: { query: "launch" } });
  assert.equal(calls[0]?.headers?.["Notion-Version"], NOTION_VERSION);
  assert.equal(NOTION_VERSION, "2026-03-11");
});

test("search lists titles, ids and links, filters databases, and labels content untrusted", async () => {
  const { caller, calls } = fakeCaller(() =>
    json({
      results: [
        { object: "page", id: PAGE_ID, url: "https://www.notion.so/Launch-plan", last_edited_time: "2026-11-19T10:00:00.000Z", properties: { Name: { type: "title", title: [{ plain_text: "Launch plan" }] } } },
        { object: "data_source", id: DB_ID, title: [{ plain_text: "Content calendar" }] },
      ],
    }),
  );
  const client = await connect(caller);
  const text = textOf(await client.callTool({ name: "search", arguments: { query: "launch", type: "database", page_size: 5 } }));
  assert.match(text, /untrusted data/);
  assert.match(text, /\[page\] Launch plan\nid: 1a2b3c4d5e6f40718293a4b5c6d7e8f9\nhttps:\/\/www\.notion\.so\/Launch-plan/);
  assert.match(text, /\[database\] Content calendar/);
  assert.deepEqual(calls[0]?.json, { query: "launch", page_size: 5, filter: { property: "object", value: "data_source" } });
});

test("read_page returns the page's Markdown and says when it was cut", async () => {
  const { caller, calls } = fakeCaller(() => json({ object: "page_markdown", id: PAGE_ID, markdown: "# Plan\n\nShip it.", truncated: true, unknown_block_ids: [] }));
  const client = await connect(caller);
  const text = textOf(await client.callTool({ name: "read_page", arguments: { page_id: PAGE_ID } }));
  assert.match(text, /# Plan\n\nShip it\./);
  assert.match(text, /The page is longer/);
  assert.equal(calls[0]?.pathParams?.id, PAGE_ID);
  assert.ok(calls[0]?.url.endsWith("/v1/pages/{id}/markdown"));
});

test("query_database passes the filter and shows each row's filled properties", async () => {
  const { caller, calls } = fakeCaller(() =>
    json({
      results: [
        {
          object: "page",
          id: PAGE_ID,
          url: "https://www.notion.so/row",
          properties: {
            Title: { type: "title", title: [{ plain_text: "Multi-user MCP article" }] },
            Status: { type: "status", status: { name: "Draft" } },
            Channels: { type: "multi_select", multi_select: [{ name: "LinkedIn" }, { name: "X" }] },
            Notes: { type: "rich_text", rich_text: [] },
          },
        },
      ],
    }),
  );
  const client = await connect(caller);
  const filter = { property: "Status", status: { equals: "Draft" } };
  const text = textOf(await client.callTool({ name: "query_database", arguments: { database_id: DB_ID, filter } }));
  assert.match(text, /Multi-user MCP article/);
  assert.match(text, /Status: Draft\nChannels: LinkedIn, X/);
  assert.doesNotMatch(text, /Notes:/);
  assert.deepEqual(calls[0]?.json, { page_size: 25, filter });
  assert.equal(calls[0]?.pathParams?.id, DB_ID);
});

test("create_page in a database uses that database's own title property", async () => {
  const { caller, calls } = fakeCaller((args) =>
    args.method === "GET"
      ? json({ object: "data_source", id: DB_ID, properties: { Headline: { type: "title" }, Status: { type: "status" } } })
      : json({ object: "page", id: PAGE_ID, url: "https://www.notion.so/new" }),
  );
  const client = await connect(caller);
  const text = textOf(await client.callTool({ name: "create_page", arguments: { title: "Follow up with Ana", database_id: DB_ID, markdown: "Met at the meetup." } }));
  assert.match(text, /Created "Follow up with Ana": https:\/\/www\.notion\.so\/new/);
  const create = calls.find((call) => call.method === "POST");
  assert.deepEqual(create?.json, {
    parent: { data_source_id: DB_ID },
    properties: { Headline: { title: [{ text: { content: "Follow up with Ana" } }] } },
    markdown: "Met at the meetup.",
    notifications: { mode: "silent" },
  });
});

test("create_page under a page uses the title property, and needs exactly one parent", async () => {
  const { caller, calls } = fakeCaller(() => json({ object: "page", id: PAGE_ID }));
  const client = await connect(caller);
  await client.callTool({ name: "create_page", arguments: { title: "Notes", parent_page_id: PAGE_ID } });
  assert.deepEqual((calls[0]?.json as { parent: unknown; properties: unknown }).parent, { page_id: PAGE_ID });
  assert.deepEqual((calls[0]?.json as { properties: unknown }).properties, { title: { title: [{ text: { content: "Notes" } }] } });
  const both = await client.callTool({ name: "create_page", arguments: { title: "x", parent_page_id: PAGE_ID, database_id: DB_ID } });
  const neither = await client.callTool({ name: "create_page", arguments: { title: "x" } });
  assert.equal(both.isError, true);
  assert.equal(neither.isError, true);
  assert.equal(calls.length, 1);
});

test("append_to_page inserts Markdown without replacing anything", async () => {
  const { caller, calls } = fakeCaller(() => json({ object: "page_markdown", id: PAGE_ID, markdown: "", truncated: false, unknown_block_ids: [] }));
  const client = await connect(caller);
  await client.callTool({ name: "append_to_page", arguments: { page_id: PAGE_ID, markdown: "- Called Ana, follow up Friday" } });
  assert.equal(calls[0]?.method, "PATCH");
  assert.deepEqual(calls[0]?.json, { type: "insert_content", insert_content: { content: "- Called Ana, follow up Friday" } });
});

test("a held comment returns the approval link", async () => {
  const { caller, calls } = fakeCaller(() => ({
    kind: "pending",
    approvalId: "ap_2",
    approvalUrls: ["https://wallet.example.com/approvals/ap_2"],
    expiresAt: "2026-11-21T00:00:00.000Z",
  }));
  const client = await connect(caller);
  const text = textOf(await client.callTool({ name: "add_comment", arguments: { page_id: PAGE_ID, markdown: "Looks good", reason: "Sign off" } }));
  assert.match(text, /Held for approval/);
  assert.deepEqual(calls[0]?.json, { parent: { page_id: PAGE_ID }, markdown: "Looks good" });
});

test("a 404 explains that the page must be shared with the connection", async () => {
  const client = await connect(fakeCaller(() => json({ object: "error", status: 404, code: "object_not_found", message: "Could not find page" }, 404)).caller);
  const result = await client.callTool({ name: "read_page", arguments: { page_id: PAGE_ID } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /HTTP 404.*Could not find page.*share the page with the connection/s);
});

test("a malformed id is refused before calling Alter", async () => {
  const { caller, calls } = fakeCaller(() => json({}));
  const client = await connect(caller);
  const result = await client.callTool({ name: "read_page", arguments: { page_id: "https://www.notion.so/Launch-plan" } });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});

test("property values render as short text", () => {
  assert.equal(propertyText({ type: "date", date: { start: "2026-11-20", end: "2026-11-21" } }), "2026-11-20 to 2026-11-21");
  assert.equal(propertyText({ type: "checkbox", checkbox: false }), "no");
  assert.equal(propertyText({ type: "number", number: 0 }), "0");
  assert.equal(propertyText({ type: "select", select: null }), undefined);
});

test("check_approval explains a denial", async () => {
  const client = await connect(fakeCaller(() => json({})).caller);
  assert.match(textOf(await client.callTool({ name: "check_approval", arguments: { approval_id: "ap_2" } })), /denied/i);
});
