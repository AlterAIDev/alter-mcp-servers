// Alter → Slack: each held request becomes a Slack message showing what will
// be sent, with Approve and Deny. Slack → Alter: a click decides the request
// as the clicking person, by the email Slack holds for them. Alter accepts
// that only if the email is one of the request's approvers (recorded as
// asserted_by_integration), so a bystander's click decides nothing.

import type { WebhookEvent } from "@alter-ai/alter-sdk";

import { type ApprovalView, type Block, type ButtonValue, SHOWN_SUMMARY_VERSION, approvalBlocks, settledBlocks, titleOf } from "./render.js";
import { type SlackApi, verifySlackSignature } from "./slack.js";

export interface Decided {
  decidedBy: string;
}

/** The slice of the Alter SDK's `App` the bridge uses. */
export interface Approvals {
  getApprovalStatus(approvalId: string, options: { summaryVersion: number }): Promise<ApprovalView & { decidedBy: string | null }>;
  decideApprovalBatch(
    decisions: readonly { approvalId: string; requestDigest: string }[],
    options: { decision: "approved"; actorEmail: string; summaryVersion: number; reason: string },
  ): Promise<Decided>;
  decideApproval(approvalId: string, options: { decision: "denied"; actorEmail: string; reason: string }): Promise<Decided>;
}

export interface BridgeDeps {
  approvals: Approvals;
  slack: SlackApi;
  channel: string;
  verifyWebhook: (body: string, headers: Headers) => WebhookEvent;
  signingSecret: string;
  log?: (message: string, error?: unknown) => void;
}

const text = (body: string, status: number) => new Response(body, { status });

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** Receives Alter's outbound webhook. Answers 5xx on a Slack or Alter failure so Alter retries. */
export async function handleAlterWebhook(request: Request, deps: BridgeDeps): Promise<Response> {
  const body = await request.text();
  let event: WebhookEvent;
  try {
    event = deps.verifyWebhook(body, request.headers);
  } catch (error) {
    deps.log?.("webhook rejected", error);
    return text("invalid signature", 400);
  }
  try {
    if (event.type === "webhook.test") {
      await deps.slack.postMessage(deps.channel, "Alter is connected: requests held for approval will appear in this channel.");
    } else if (event.type === "approval.requested") {
      await postApproval(event, deps);
    } else if (event.type === "approval.failed") {
      const context = (event.data.context ?? null) as Record<string, string> | null;
      const title = titleOf({ summary: (event.data.summary ?? {}) as Record<string, unknown>, context });
      const error = str(event.data.execution_error) ?? "no detail";
      await deps.slack.postMessage(
        deps.channel,
        `:warning: Approved, but it failed when Alter sent it: ${title} (approval ${str(event.data.approval_id) ?? "?"}): ${error}`,
      );
    }
    return text("ok", 200);
  } catch (error) {
    deps.log?.(`webhook ${event.type} failed`, error);
    return text("failed", 500);
  }
}

async function postApproval(event: WebhookEvent, deps: BridgeDeps): Promise<void> {
  const approvalId = str(event.data.approval_id);
  if (!approvalId) return;
  const status = await deps.approvals.getApprovalStatus(approvalId, { summaryVersion: SHOWN_SUMMARY_VERSION });
  if (status.status !== "pending") return; // decided before the webhook arrived
  const approvable = event.data.approvable !== false && status.requiredSummaryVersion <= SHOWN_SUMMARY_VERSION;
  await deps.slack.postMessage(deps.channel, `Approval needed: ${titleOf(status)}`, approvalBlocks(status, { approvable }));
}

interface BlockActionsPayload {
  type: string;
  user?: { id?: string };
  response_url?: string;
  message?: { blocks?: Block[] };
  actions?: { action_id?: string; value?: string }[];
}

/** Receives Slack's interactivity request: acknowledge within Slack's 3 s, decide in the background. */
export async function handleSlackInteraction(
  request: Request,
  deps: BridgeDeps,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const body = await request.text();
  if (!(await verifySlackSignature(deps.signingSecret, request.headers, body))) return text("invalid signature", 401);
  let payload: BlockActionsPayload;
  try {
    payload = JSON.parse(new URLSearchParams(body).get("payload") ?? "") as BlockActionsPayload;
  } catch {
    return text("bad payload", 400);
  }
  const action = payload.actions?.[0];
  if (payload.type !== "block_actions" || (action?.action_id !== "approve" && action?.action_id !== "deny")) {
    return new Response(null, { status: 200 });
  }
  waitUntil(
    decide(payload, action.action_id, action.value ?? "", deps).catch((error: unknown) => deps.log?.("decision failed", error)),
  );
  return new Response(null, { status: 200 });
}

function backendCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== "BackendError") return undefined;
  const details = (error as Error & { details?: Record<string, unknown> }).details;
  return str(details?.error);
}

export async function decide(payload: BlockActionsPayload, kind: "approve" | "deny", rawValue: string, deps: BridgeDeps): Promise<void> {
  const responseUrl = payload.response_url;
  const userId = payload.user?.id;
  if (!responseUrl || !userId) return;
  const tell = (message: string) => deps.slack.respond(responseUrl, { response_type: "ephemeral", replace_original: false, text: message });

  let value: Partial<ButtonValue>;
  try {
    value = JSON.parse(rawValue) as Partial<ButtonValue>;
  } catch {
    return;
  }
  const approvalId = str(value.a);
  if (!approvalId) return;

  const member = await deps.slack.member(userId);
  if (member.isBot) return;
  if (!member.email) {
    await tell("Slack did not share your email address with this app, so Alter cannot check that you are an approver.");
    return;
  }
  const reason = `Decided in Slack by ${member.email}`;
  try {
    let decided: Decided;
    if (kind === "approve") {
      if (!str(value.d) || typeof value.v !== "number") return;
      decided = await deps.approvals.decideApprovalBatch([{ approvalId, requestDigest: value.d as string }], {
        decision: "approved",
        actorEmail: member.email,
        summaryVersion: value.v,
        reason,
      });
    } else {
      decided = await deps.approvals.decideApproval(approvalId, { decision: "denied", actorEmail: member.email, reason });
    }
    const outcome =
      kind === "approve"
        ? `:white_check_mark: Approved by ${decided.decidedBy} in Slack. Alter is sending it now.`
        : `:x: Denied by ${decided.decidedBy} in Slack. Nothing was sent.`;
    await deps.slack.respond(responseUrl, { replace_original: true, text: outcome, blocks: settledBlocks(payload.message?.blocks ?? [], outcome) });
  } catch (error) {
    const code = backendCode(error);
    if (code === "approval_not_found") return tell("Only this request's approvers can decide it, and your Slack email is not one of them.");
    if (code === "approval_requires_end_user" || code === "step_up_required") return tell("This request has to be decided in the Alter Wallet.");
    if (code === "already_decided" || code === "approval_expired" || code === "batch_changed" || code === "approval_summary_version_required") {
      return refresh(approvalId, responseUrl, deps);
    }
    await tell(`Alter did not accept the decision (${code ?? "unexpected error"}). Try again, or decide it in the Alter Wallet.`);
    throw error;
  }
}

/** The request changed since the message was posted: show where it stands now. */
async function refresh(approvalId: string, responseUrl: string, deps: BridgeDeps): Promise<void> {
  const status = await deps.approvals.getApprovalStatus(approvalId, { summaryVersion: SHOWN_SUMMARY_VERSION });
  if (status.status === "pending") {
    const approvable = status.requiredSummaryVersion <= SHOWN_SUMMARY_VERSION;
    await deps.slack.respond(responseUrl, {
      replace_original: true,
      text: `Approval needed: ${titleOf(status)}`,
      blocks: approvalBlocks(status, { approvable, note: ":arrows_counterclockwise: This request changed since it was posted. Review it again." }),
    });
    return;
  }
  const outcome = `This request is already ${status.status}${status.decidedBy ? ` (decided by ${status.decidedBy})` : ""}.`;
  await deps.slack.respond(responseUrl, {
    replace_original: true,
    text: outcome,
    blocks: settledBlocks(approvalBlocks(status, { approvable: false }), outcome),
  });
}
