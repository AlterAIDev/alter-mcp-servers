import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { AlterCaller, ProxyArgs, ProxyOutcome } from "../src/alter.js";
import { NOTION_VERSION, columnConfig, propertyText, propertyValue } from "../src/notion.js";
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
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "add_comment",
    "add_database_columns",
    "append_to_page",
    "check_approval",
    "create_database",
    "create_page",
    "edit_page",
    "move_page",
    "query_database",
    "read_page",
    "restore_page",
    "search",
    "trash_page",
    "update_page",
  ]);
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

// Editing, organizing and deleting.

const ROW = {
  object: "page",
  id: PAGE_ID,
  properties: {
    Hypothesis: { type: "title" },
    Status: { type: "status" },
    Segment: { type: "multi_select" },
    Confidence: { type: "select" },
    Score: { type: "number" },
    Start: { type: "date" },
    Validated: { type: "checkbox" },
    Notes: { type: "rich_text" },
    Created: { type: "created_time" },
  },
};

test("update_page reads the page's schema and writes plain values in each property's format, silently", async () => {
  const { caller, calls } = fakeCaller((args) => (args.method === "GET" ? json(ROW) : json({ object: "page", id: PAGE_ID })));
  const client = await connect(caller);
  const result = await client.callTool({
    name: "update_page",
    arguments: {
      page_id: PAGE_ID,
      title: "Ops leads buy before security",
      properties: { Status: "Testing", Segment: ["MSP", "Fintech"], Confidence: "High", Score: "7", Start: ["2026-11-21", "2026-12-05"], Validated: false, Notes: null },
    },
  });
  assert.match(textOf(result), /Updated 8 properties/);
  const patch = calls.find((call) => call.method === "PATCH");
  assert.equal(patch?.url, "https://api.notion.com/v1/pages/{id}");
  assert.deepEqual(patch?.json, {
    properties: {
      Status: { status: { name: "Testing" } },
      Segment: { multi_select: [{ name: "MSP" }, { name: "Fintech" }] },
      Confidence: { select: { name: "High" } },
      Score: { number: 7 },
      Start: { date: { start: "2026-11-21", end: "2026-12-05" } },
      Validated: { checkbox: false },
      Notes: { rich_text: [] },
      Hypothesis: { title: [{ text: { content: "Ops leads buy before security" } }] },
    },
    notifications: { mode: "silent" },
  });
});

test("update_page refuses an unknown or computed property before writing anything", async () => {
  const { caller, calls } = fakeCaller(() => json(ROW));
  const client = await connect(caller);
  const unknown = await client.callTool({ name: "update_page", arguments: { page_id: PAGE_ID, properties: { Owner: "Sam" } } });
  assert.match(textOf(unknown), /There is no property "Owner" here\. Properties: Confidence, Created, Hypothesis/);
  const computed = await client.callTool({ name: "update_page", arguments: { page_id: PAGE_ID, properties: { Created: "2026-11-21" } } });
  assert.match(textOf(computed), /"Created" is a created_time property; give nothing: it is computed by Notion/);
  const badDate = await client.callTool({ name: "update_page", arguments: { page_id: PAGE_ID, properties: { Start: "next week" } } });
  assert.match(textOf(badDate), /"Start" is a date property; give a date like/);
  assert.ok(calls.every((call) => call.method === "GET"));
});

test("edit_page replaces content or finds and replaces, keeping child pages unless removal is allowed", async () => {
  const { caller, calls } = fakeCaller(() => json({ object: "page_markdown", id: PAGE_ID, markdown: "", truncated: false, unknown_block_ids: [] }));
  const client = await connect(caller);
  await client.callTool({ name: "edit_page", arguments: { page_id: PAGE_ID, replace_with: "# v2\n\nNew plan" } });
  assert.deepEqual(calls[0]?.json, { type: "replace_content", replace_content: { new_str: "# v2\n\nNew plan" } });
  await client.callTool({ name: "edit_page", arguments: { page_id: PAGE_ID, find_replace: [{ find: "Q1", replace: "Q2", all: true }, { find: "draft", replace: "final" }] } });
  assert.deepEqual(calls[1]?.json, {
    type: "update_content",
    update_content: { content_updates: [{ old_str: "Q1", new_str: "Q2", replace_all_matches: true }, { old_str: "draft", new_str: "final", replace_all_matches: false }] },
  });
  await client.callTool({ name: "edit_page", arguments: { page_id: PAGE_ID, replace_with: "x", allow_removing_child_pages: true } });
  assert.deepEqual(calls[2]?.json, { type: "replace_content", replace_content: { new_str: "x", allow_deleting_content: true } });
  assert.equal(calls[0]?.method, "PATCH");
  assert.ok(calls[0]?.url.endsWith("/v1/pages/{id}/markdown"));
  const both = await client.callTool({ name: "edit_page", arguments: { page_id: PAGE_ID, replace_with: "x", find_replace: [{ find: "a", replace: "b" }] } });
  assert.equal(both.isError, true);
  assert.equal(calls.length, 3);
});

test("trash_page and restore_page set in_trash on a page or a database", async () => {
  const { caller, calls } = fakeCaller(() => json({ object: "page", id: PAGE_ID }));
  const client = await connect(caller);
  assert.match(textOf(await client.callTool({ name: "trash_page", arguments: { id: PAGE_ID, reason: "Hypothesis abandoned" } })), /Moved the page to Notion's trash/);
  assert.deepEqual(calls[0]?.json, { in_trash: true, notifications: { mode: "silent" } });
  assert.equal(calls[0]?.reason, "Hypothesis abandoned");
  await client.callTool({ name: "trash_page", arguments: { id: DB_ID, kind: "database" } });
  assert.equal(calls[1]?.url, "https://api.notion.com/v1/databases/{id}");
  assert.deepEqual(calls[1]?.json, { in_trash: true });
  await client.callTool({ name: "restore_page", arguments: { id: PAGE_ID } });
  assert.deepEqual(calls[2]?.json, { in_trash: false, notifications: { mode: "silent" } });
});

test("a trash held by the policy returns the approval link", async () => {
  const { caller } = fakeCaller(() => ({ kind: "pending", approvalId: "ap_t", approvalUrls: ["https://wallet.example.com/approvals/ap_t"], expiresAt: "2026-11-22T00:00:00.000Z" }));
  const client = await connect(caller);
  assert.match(textOf(await client.callTool({ name: "trash_page", arguments: { id: PAGE_ID } })), /Held for approval/);
});

test("create_database builds typed columns under a page and returns both ids", async () => {
  const { caller, calls } = fakeCaller(() => json({ object: "database", id: DB_ID, url: "https://www.notion.so/gtm", data_sources: [{ id: "3c4d5e6f-7081-4293-a4b5-c6d7e8f90123" }] }));
  const client = await connect(caller);
  const text = textOf(
    await client.callTool({
      name: "create_database",
      arguments: {
        parent_page_id: PAGE_ID,
        title: "GTM hypotheses",
        title_column: "Hypothesis",
        columns: [
          { name: "Status", type: "status", options: ["Untested", "Testing", "Validated", "Invalidated"] },
          { name: "Segment", type: "multi_select", options: ["MSP", "Fintech"] },
          { name: "Score", type: "number" },
          { name: "Start", type: "date" },
        ],
      },
    }),
  );
  assert.match(text, /Created "GTM hypotheses": https:\/\/www\.notion\.so\/gtm/);
  assert.match(text, /data source id \(for query_database, create_page, add_database_columns\): 3c4d5e6f/);
  const body = calls[0]?.json as { parent: unknown; title: unknown; initial_data_source: { properties: Record<string, unknown> } };
  assert.deepEqual(body.parent, { type: "page_id", page_id: PAGE_ID });
  assert.deepEqual(body.title, [{ text: { content: "GTM hypotheses" } }]);
  assert.deepEqual(Object.keys(body.initial_data_source.properties), ["Hypothesis", "Status", "Segment", "Score", "Start"]);
  assert.deepEqual(body.initial_data_source.properties.Hypothesis, { title: {} });
  assert.deepEqual(body.initial_data_source.properties.Score, { number: { format: "number" } });
  const duplicate = await client.callTool({ name: "create_database", arguments: { parent_page_id: PAGE_ID, title: "x", columns: [{ name: "Name", type: "text" }] } });
  assert.match(textOf(duplicate), /Column names must be unique/);
});

test("add_database_columns patches the data source", async () => {
  const { caller, calls } = fakeCaller(() => json({ object: "data_source", id: DB_ID }));
  const client = await connect(caller);
  await client.callTool({ name: "add_database_columns", arguments: { database_id: DB_ID, columns: [{ name: "Confidence", type: "select", options: ["Low", "High"] }] } });
  assert.equal(calls[0]?.method, "PATCH");
  assert.equal(calls[0]?.url, "https://api.notion.com/v1/data_sources/{id}");
  assert.deepEqual(calls[0]?.json, { properties: { Confidence: { select: { options: [{ name: "Low", color: "gray" }, { name: "High", color: "brown" }] } } } });
});

test("move_page moves under a page or into a database, and needs exactly one", async () => {
  const { caller, calls } = fakeCaller(() => json({ object: "page", id: PAGE_ID }));
  const client = await connect(caller);
  await client.callTool({ name: "move_page", arguments: { page_id: PAGE_ID, to_page_id: DB_ID } });
  assert.deepEqual(calls[0]?.json, { parent: { type: "page_id", page_id: DB_ID } });
  assert.ok(calls[0]?.url.endsWith("/v1/pages/{id}/move"));
  await client.callTool({ name: "move_page", arguments: { page_id: PAGE_ID, to_database_id: DB_ID } });
  assert.deepEqual(calls[1]?.json, { parent: { type: "data_source_id", data_source_id: DB_ID } });
  assert.equal((await client.callTool({ name: "move_page", arguments: { page_id: PAGE_ID } })).isError, true);
});

test("create_page sets a database row's other columns from plain values", async () => {
  const { caller, calls } = fakeCaller((args) => (args.method === "GET" ? json({ object: "data_source", id: DB_ID, properties: ROW.properties }) : json({ object: "page", id: PAGE_ID })));
  const client = await connect(caller);
  await client.callTool({ name: "create_page", arguments: { title: "Ops leads buy first", database_id: DB_ID, properties: { Status: "Untested", Score: 5 } } });
  const create = calls.find((call) => call.method === "POST");
  assert.deepEqual((create?.json as { properties: unknown }).properties, {
    Status: { status: { name: "Untested" } },
    Score: { number: 5 },
    Hypothesis: { title: [{ text: { content: "Ops leads buy first" } }] },
  });
  const onPage = await client.callTool({ name: "create_page", arguments: { title: "x", parent_page_id: PAGE_ID, properties: { Status: "x" } } });
  assert.match(textOf(onPage), /properties apply to a database row/);
});

test("plain values convert by property type, and column specs by column type", () => {
  assert.deepEqual(propertyValue("Tags", "multi_select", "a, b"), { multi_select: [{ name: "a" }, { name: "b" }] });
  assert.deepEqual(propertyValue("Done", "checkbox", "true"), { checkbox: true });
  assert.deepEqual(propertyValue("Owner", "people", [PAGE_ID]), { people: [{ id: PAGE_ID }] });
  assert.throws(() => propertyValue("Owner", "people", ["Sam"]), /Notion user ids/);
  assert.deepEqual(columnConfig({ name: "Phase", type: "status" }), { status: {} });
  assert.deepEqual(columnConfig({ name: "Phone", type: "phone" }), { phone_number: {} });
});
