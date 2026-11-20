import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import { WebhookEvent, verifyWebhook } from "@alter-ai/alter-sdk";

import { type Approvals, type BridgeDeps, decide, handleAlterWebhook, handleSlackInteraction } from "../src/bridge.js";
import { type ApprovalView, approvalBlocks } from "../src/render.js";
import { type SlackApi, verifySlackSignature } from "../src/slack.js";

const SIGNING_SECRET = "slack-signing-secret";

function status(overrides: Partial<ApprovalView & { decidedBy: string | null }> = {}): ApprovalView & { decidedBy: string | null } {
  return {
    approvalId: "ap_1",
    status: "pending",
    summary: { reason: "Weekly post", body_as_sent: { commentary: "Hello", visibility: "PUBLIC" } },
    requiredSummaryVersion: 4,
    requestDigest: "digest_1",
    approvers: ["approver@example.com"],
    context: { tool: "linkedin.create_post", server: "@alter-ai/linkedin-mcp" },
    expiresAt: new Date("2026-11-21T00:00:00Z"),
    decidedBy: null,
    ...overrides,
  };
}

class BackendError extends Error {
  override name = "BackendError";
  constructor(readonly details: Record<string, unknown>) {
    super(String(details.error));
  }
}

function fakes(options: { email?: string; isBot?: boolean; decideError?: Error; current?: ReturnType<typeof status> } = {}) {
  const posted: { channel: string; text: string; blocks?: unknown[] }[] = [];
  const responses: Record<string, unknown>[] = [];
  const decisions: unknown[] = [];
  const slack: SlackApi = {
    postMessage: async (channel, text, blocks) => {
      posted.push({ channel, text, ...(blocks ? { blocks } : {}) });
    },
    member: async () => ({ ...(options.email !== undefined ? { email: options.email } : { email: "approver@example.com" }), isBot: options.isBot ?? false }),
    respond: async (_url, message) => {
      responses.push(message);
    },
  };
  const approvals: Approvals = {
    getApprovalStatus: async () => options.current ?? status(),
    decideApprovalBatch: async (items, opts) => {
      decisions.push({ kind: "batch", items, opts });
      if (options.decideError) throw options.decideError;
      return { decidedBy: opts.actorEmail };
    },
    decideApproval: async (id, opts) => {
      decisions.push({ kind: "single", id, opts });
      if (options.decideError) throw options.decideError;
      return { decidedBy: opts.actorEmail };
    },
  };
  const deps: BridgeDeps = {
    approvals,
    slack,
    channel: "C1",
    signingSecret: SIGNING_SECRET,
    verifyWebhook: (body) => {
      const parsed = JSON.parse(body) as { type: string; data: Record<string, unknown> };
      if (parsed.type === "bad") throw new Error("bad signature");
      return new WebhookEvent({ id: "msg_1", type: parsed.type, occurred_at: new Date(), sequence: 1, api_version: "2026-10-01", data: parsed.data });
    },
  };
  return { deps, posted, responses, decisions };
}

const webhook = (type: string, data: Record<string, unknown> = {}) =>
  new Request("https://bridge.example.com/alter/webhook", { method: "POST", body: JSON.stringify({ type, data }) });

test("a held request is posted to the channel with what will be sent", async () => {
  const { deps, posted } = fakes();
  const response = await handleAlterWebhook(webhook("approval.requested", { approval_id: "ap_1", approvable: true }), deps);
  assert.equal(response.status, 200);
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.channel, "C1");
  assert.equal(posted[0]?.text, "Approval needed: Publish a LinkedIn post");
  assert.match(JSON.stringify(posted[0]?.blocks), /"approve"/);
  assert.match(JSON.stringify(posted[0]?.blocks), />Hello/);
});

test("a request needing a newer summary, or marked not approvable, offers only deny", async () => {
  const newer = fakes({ current: status({ requiredSummaryVersion: 99 }) });
  await handleAlterWebhook(webhook("approval.requested", { approval_id: "ap_1" }), newer.deps);
  assert.ok(!JSON.stringify(newer.posted[0]?.blocks).includes('"approve"'));
  const unapprovable = fakes();
  await handleAlterWebhook(webhook("approval.requested", { approval_id: "ap_1", approvable: false }), unapprovable.deps);
  assert.ok(!JSON.stringify(unapprovable.posted[0]?.blocks).includes('"approve"'));
});

test("a request already decided when the webhook arrives posts nothing", async () => {
  const { deps, posted } = fakes({ current: status({ status: "approved" }) });
  await handleAlterWebhook(webhook("approval.requested", { approval_id: "ap_1" }), deps);
  assert.equal(posted.length, 0);
});

test("a bad webhook signature is 400 and acts on nothing; a Slack failure is 500 so Alter retries", async () => {
  const { deps, posted } = fakes();
  assert.equal((await handleAlterWebhook(webhook("bad"), deps)).status, 400);
  assert.equal(posted.length, 0);
  deps.slack.postMessage = async () => {
    throw new Error("slack down");
  };
  assert.equal((await handleAlterWebhook(webhook("approval.requested", { approval_id: "ap_1" }), deps)).status, 500);
});

test("the real verifier rejects an unsigned delivery", () => {
  const fakeSecret = `whsec_${Buffer.from("not-a-real-secret").toString("base64")}`;
  assert.throws(() => verifyWebhook("{}", new Headers(), fakeSecret));
});

test("a test event and a failed execution are reported in the channel", async () => {
  const { deps, posted } = fakes();
  await handleAlterWebhook(webhook("webhook.test"), deps);
  await handleAlterWebhook(webhook("approval.failed", { approval_id: "ap_2", execution_error: "HTTP 422", context: { tool: "gmail.send_email" } }), deps);
  assert.match(posted[0]?.text ?? "", /Alter is connected/);
  assert.match(posted[1]?.text ?? "", /failed when Alter sent it: Send an email \(approval ap_2\): HTTP 422/);
});

function signed(body: string, secret = SIGNING_SECRET, timestamp = Math.floor(Date.now() / 1000)): Request {
  const signature = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  return new Request("https://bridge.example.com/slack/interactions", {
    method: "POST",
    headers: { "x-slack-request-timestamp": String(timestamp), "x-slack-signature": signature, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

const interaction = (actionId: string, value: unknown) =>
  `payload=${encodeURIComponent(
    JSON.stringify({
      type: "block_actions",
      user: { id: "U1" },
      response_url: "https://hooks.slack.com/actions/T/1/x",
      message: { blocks: approvalBlocks(status(), { approvable: true }) },
      actions: [{ action_id: actionId, value: JSON.stringify(value) }],
    }),
  )}`;

test("Slack signatures: valid passes; wrong secret or a stale timestamp fails", async () => {
  const body = "payload=%7B%7D";
  assert.equal(await verifySlackSignature(SIGNING_SECRET, signed(body).headers, body), true);
  assert.equal(await verifySlackSignature(SIGNING_SECRET, signed(body, "other").headers, body), false);
  assert.equal(await verifySlackSignature(SIGNING_SECRET, signed(body, SIGNING_SECRET, 1_000).headers, body), false);
});

test("an unsigned interaction is 401 and decides nothing", async () => {
  const { deps, decisions } = fakes();
  const request = new Request("https://bridge.example.com/slack/interactions", { method: "POST", body: interaction("approve", {}) });
  assert.equal((await handleSlackInteraction(request, deps, () => undefined)).status, 401);
  assert.equal(decisions.length, 0);
});

test("approve decides as the clicking person, at the digest and version shown, then settles the message", async () => {
  const { deps, decisions, responses } = fakes();
  const work: Promise<unknown>[] = [];
  const response = await handleSlackInteraction(signed(interaction("approve", { a: "ap_1", d: "digest_1", v: 7 })), deps, (p) => work.push(p));
  assert.equal(response.status, 200);
  await Promise.all(work);
  assert.deepEqual(decisions, [
    {
      kind: "batch",
      items: [{ approvalId: "ap_1", requestDigest: "digest_1" }],
      opts: { decision: "approved", actorEmail: "approver@example.com", summaryVersion: 7, reason: "Decided in Slack by approver@example.com" },
    },
  ]);
  assert.equal(responses[0]?.replace_original, true);
  assert.match(String(responses[0]?.text), /Approved by approver@example.com/);
  assert.ok(!JSON.stringify(responses[0]?.blocks).includes('"actions"'));
});

test("deny needs no digest", async () => {
  const { deps, decisions, responses } = fakes();
  await decide({ type: "block_actions", user: { id: "U1" }, response_url: "https://hooks.slack.com/x" }, "deny", JSON.stringify({ a: "ap_1" }), deps);
  assert.deepEqual(decisions, [{ kind: "single", id: "ap_1", opts: { decision: "denied", actorEmail: "approver@example.com", reason: "Decided in Slack by approver@example.com" } }]);
  assert.match(String(responses[0]?.text), /Denied by approver@example.com/);
});

test("a person who is not an approver is told privately and the message is unchanged", async () => {
  const { deps, responses } = fakes({ decideError: new BackendError({ error: "approval_not_found" }) });
  await decide({ type: "block_actions", user: { id: "U1" }, response_url: "https://hooks.slack.com/x" }, "approve", JSON.stringify({ a: "ap_1", d: "digest_1", v: 7 }), deps);
  assert.equal(responses[0]?.response_type, "ephemeral");
  assert.equal(responses[0]?.replace_original, false);
});

test("a request decided elsewhere settles the message with where it stands", async () => {
  const { deps, responses } = fakes({ decideError: new BackendError({ error: "already_decided" }), current: status({ status: "approved", decidedBy: "other@example.com" }) });
  await decide({ type: "block_actions", user: { id: "U1" }, response_url: "https://hooks.slack.com/x" }, "approve", JSON.stringify({ a: "ap_1", d: "digest_1", v: 7 }), deps);
  assert.equal(responses[0]?.replace_original, true);
  assert.match(String(responses[0]?.text), /already approved \(decided by other@example.com\)/);
});

test("a request that changed is shown again for a fresh decision", async () => {
  const { deps, responses } = fakes({ decideError: new BackendError({ error: "batch_changed" }), current: status({ requestDigest: "digest_2" }) });
  await decide({ type: "block_actions", user: { id: "U1" }, response_url: "https://hooks.slack.com/x" }, "approve", JSON.stringify({ a: "ap_1", d: "digest_1", v: 7 }), deps);
  assert.match(JSON.stringify(responses[0]?.blocks), /changed since it was posted/);
  assert.match(JSON.stringify(responses[0]?.blocks), /digest_2/);
});

test("bots decide nothing, and a member without a shared email is told why", async () => {
  const bot = fakes({ isBot: true });
  await decide({ type: "block_actions", user: { id: "U1" }, response_url: "https://hooks.slack.com/x" }, "deny", JSON.stringify({ a: "ap_1" }), bot.deps);
  assert.equal(bot.decisions.length, 0);
  const noEmail = fakes({ email: "" });
  await decide({ type: "block_actions", user: { id: "U1" }, response_url: "https://hooks.slack.com/x" }, "deny", JSON.stringify({ a: "ap_1" }), noEmail.deps);
  assert.equal(noEmail.decisions.length, 0);
  assert.match(String(noEmail.responses[0]?.text), /did not share your email/);
});
