import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeEncodedWords, decodeGmailRaw } from "../src/mime.js";
import { type ApprovalView, approvalBlocks, contentSections, escapeSlack, settledBlocks, titleOf, unescapeLittleText } from "../src/render.js";

// The same shape @alter-ai/gmail-mcp builds: base64 UTF-8 body, RFC 2047 subject.
function gmailRaw(subject: string, body: string): string {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const head = ["To: Ana <ana@example.com>", "Cc: ops@example.com", `Subject: ${encodedSubject}`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64"];
  const encodedBody = Buffer.from(body.replace(/\n/g, "\r\n"), "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n");
  return Buffer.from(`${head.join("\r\n")}\r\n\r\n${encodedBody}`, "utf8").toString("base64url");
}

function view(summary: Record<string, unknown>, overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    approvalId: "ap_1",
    status: "pending",
    summary,
    requiredSummaryVersion: 4,
    requestDigest: "digest_1",
    approvers: ["approver@example.com"],
    context: { tool: "gmail.send_email", server: "@alter-ai/gmail-mcp" },
    expiresAt: new Date("2026-11-21T00:00:00Z"),
    ...overrides,
  };
}

test("decodes a Gmail raw message: headers, encoded subject and UTF-8 body", () => {
  const email = decodeGmailRaw(gmailRaw("Résumé ✓", "Hi Ana,\nThanks — talk soon."));
  assert.equal(email.to, "Ana <ana@example.com>");
  assert.equal(email.cc, "ops@example.com");
  assert.equal(email.subject, "Résumé ✓");
  assert.equal(email.text, "Hi Ana,\nThanks — talk soon.");
});

test("decodes quoted-printable and multipart bodies", () => {
  const qp = Buffer.from('Subject: =?UTF-8?Q?Caf=C3=A9_time?=\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=C3=A9 at 3=\r\npm', "utf8").toString("base64url");
  assert.deepEqual(decodeGmailRaw(qp), { subject: "Café time", text: "Café at 3pm" });
  const multipart = Buffer.from(
    'Content-Type: multipart/alternative; boundary="b1"\r\n\r\n--b1\r\nContent-Type: text/html\r\n\r\n<p>html</p>\r\n--b1\r\nContent-Type: text/plain\r\n\r\nplain text\r\n--b1--\r\n',
    "utf8",
  ).toString("base64url");
  assert.equal(decodeGmailRaw(multipart).text, "plain text");
  assert.equal(decodeEncodedWords("=?UTF-8?B?SGk=?= =?UTF-8?B?IHRoZXJl?="), "Hi there");
});

test("a held Gmail send shows recipients, subject and the message Alter will send", () => {
  const sections = contentSections({ body_as_sent: { raw: gmailRaw("Intro", "Hello <team> & co") } });
  assert.equal(sections[0]?.label, "Email");
  assert.match(sections[0]?.text ?? "", /To: Ana <ana@example.com>\nCc: ops@example.com\nSubject: Intro/);
  assert.equal(sections[1]?.text, "Hello <team> & co");
  const blocks = JSON.stringify(approvalBlocks(view({ body_as_sent: { raw: gmailRaw("Intro", "Hello <team> & co") } }), { approvable: true }));
  assert.match(blocks, /Hello &lt;team&gt; &amp; co/); // escaped for Slack
});

test("a held LinkedIn post shows the post as readers will see it, with its link card", () => {
  const sections = contentSections({
    body_as_sent: {
      commentary: "Ship it \\(v2\\) \\#launch",
      visibility: "PUBLIC",
      content: { article: { source: "https://example.com/a", title: "The article", description: "Why" } },
    },
  });
  assert.deepEqual(sections, [
    { label: "Post (PUBLIC)", text: "Ship it (v2) #launch" },
    { label: "Link card", text: "The article\nWhy\nhttps://example.com/a" },
  ]);
  assert.equal(unescapeLittleText("a\\_b \\@c"), "a_b @c");
});

test("a request with no content in the summary says to review it in the Wallet", () => {
  assert.match(contentSections({ method: "POST" })[0]?.text ?? "", /Alter Wallet/);
  assert.equal(contentSections({ body_as_sent: { foo: 1 } })[0]?.label, "Request body");
});

test("titles come from the tool, then the operation, then the method and path", () => {
  assert.equal(titleOf(view({})), "Send an email");
  assert.equal(titleOf(view({ operation: { summary: "Create a post" } }, { context: null })), "Create a post");
  assert.equal(titleOf(view({ method: "POST", host: "api.example.com", path_summary: "/v1/x" }, { context: null })), "POST api.example.com/v1/x");
});

test("approve carries the digest and the shown summary version; not approvable offers only deny", () => {
  const approvable = approvalBlocks(view({}), { approvable: true });
  const actions = approvable.find((block) => block.type === "actions") as { elements: { action_id: string; value: string }[] };
  assert.deepEqual(actions.elements.map((element) => element.action_id), ["approve", "deny"]);
  assert.deepEqual(JSON.parse(actions.elements[0]?.value ?? ""), { a: "ap_1", d: "digest_1", v: 7 });

  const denyOnly = approvalBlocks(view({}), { approvable: false });
  const denyActions = denyOnly.find((block) => block.type === "actions") as { elements: { action_id: string }[] };
  assert.deepEqual(denyActions.elements.map((element) => element.action_id), ["deny"]);
  const noDigest = approvalBlocks(view({}, { requestDigest: null }), { approvable: true });
  assert.ok(!JSON.stringify(noDigest).includes('"approve"'));
});

test("recipients outside a rule's list are flagged", () => {
  const blocks = JSON.stringify(approvalBlocks(view({ recipient_checks: [{ address: "x@other.com", in_list: false }, { address: "ok@example.com", in_list: true }] }), { approvable: true }));
  assert.match(blocks, /outside the rule's list: x@other.com/);
  assert.ok(!blocks.includes("ok@example.com\""));
});

test("a settled message keeps the content and replaces the buttons with the outcome", () => {
  const settled = settledBlocks(approvalBlocks(view({}), { approvable: false }), "Denied");
  assert.ok(!settled.some((block) => block.type === "actions"));
  assert.ok(!JSON.stringify(settled).includes("Slack can only deny"));
  assert.match(JSON.stringify(settled.at(-1)), /Denied/);
  assert.equal(escapeSlack("<a&b>"), "&lt;a&amp;b&gt;");
});
