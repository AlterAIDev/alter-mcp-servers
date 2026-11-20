// Turns Alter's approver summary into a Slack message. The content shown is
// what Alter will send: the summary's `body_as_sent` is read from the held
// request itself, not supplied by the agent.

import { decodeGmailRaw } from "./mime.js";

/**
 * The approver-summary version this renderer shows. An approve is sent at this
 * version, so Alter refuses it if the request needs a newer one (fields this
 * renderer has not been taught to show).
 */
export const SHOWN_SUMMARY_VERSION = 7;

/** Slack allows 3,000 characters in a section; leave room for the label. */
const MAX_SECTION_TEXT = 2800;

export interface ApprovalView {
  approvalId: string;
  status: string;
  summary: Readonly<Record<string, unknown>>;
  requiredSummaryVersion: number;
  requestDigest: string | null;
  approvers: readonly string[];
  context: Readonly<Record<string, string>> | null;
  expiresAt: Date;
}

/** What an Approve button carries back: the approval, the digest and version it was shown at. */
export interface ButtonValue {
  a: string;
  d: string;
  v: number;
}

export type Block = Record<string, unknown>;

const APPROVE_ELSEWHERE = "approve-elsewhere";

const TOOL_TITLES: Record<string, string> = {
  "gmail.send_email": "Send an email",
  "linkedin.create_post": "Publish a LinkedIn post",
  "linkedin.comment_on_post": "Comment on a LinkedIn post",
  "linkedin.react_to_post": "React to a LinkedIn post",
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** Slack mrkdwn needs &, < and > escaped in anything it should not interpret. */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function quote(text: string): string {
  const shown = text.length > MAX_SECTION_TEXT ? `${text.slice(0, MAX_SECTION_TEXT)}\n… (cut here; the Alter Wallet shows the rest)` : text;
  return escapeSlack(shown)
    .split("\n")
    .map((line) => `>${line}`)
    .join("\n");
}

/** LinkedIn "little text" escapes; shown as the reader will see them. */
export function unescapeLittleText(text: string): string {
  return text.replace(/\\([\\|{}@[\]()<>#*_~])/g, "$1");
}

export function titleOf(view: Pick<ApprovalView, "summary" | "context">): string {
  const tool = view.context?.tool;
  if (tool && TOOL_TITLES[tool]) return TOOL_TITLES[tool];
  const operation = str(record(view.summary.operation)?.summary);
  if (operation) return operation;
  return `${str(view.summary.method) ?? "Request"} ${str(view.summary.host) ?? ""}${str(view.summary.path_summary) ?? ""}`.trim();
}

/** The request's content as labelled sections, from what Alter will send. */
export function contentSections(summary: Readonly<Record<string, unknown>>): { label: string; text: string }[] {
  const body = record(summary.body_as_sent) ?? record(record(summary.request_as_sent)?.body);
  if (!body) {
    return [
      {
        label: "Content",
        text: "Alter's summary does not include this request's content. Review it in the Alter Wallet before approving.",
      },
    ];
  }
  const raw = str(body.raw);
  if (raw) {
    const email = decodeGmailRaw(raw);
    const headers = (["from", "to", "cc", "bcc", "subject"] as const)
      .filter((name) => email[name])
      .map((name) => `${name[0]?.toUpperCase()}${name.slice(1)}: ${email[name]}`)
      .join("\n");
    return [
      { label: "Email", text: headers || "(no headers)" },
      { label: "Message", text: email.text || "(empty)" },
    ];
  }
  const commentary = str(body.commentary);
  if (commentary !== undefined) {
    const sections = [{ label: `Post (${str(body.visibility) ?? "PUBLIC"})`, text: unescapeLittleText(commentary) }];
    const article = record(record(body.content)?.article);
    if (article) {
      const card = [str(article.title), str(article.description), str(article.source)].filter(Boolean).join("\n");
      sections.push({ label: "Link card", text: card });
    }
    return sections;
  }
  const comment = str(record(body.message)?.text);
  if (comment) return [{ label: `Comment on ${str(body.object) ?? "a post"}`, text: comment }];
  const reaction = str(body.reactionType);
  if (reaction) return [{ label: "Reaction", text: `${reaction} on ${str(body.root) ?? "a post"}` }];
  return [{ label: "Request body", text: JSON.stringify(body, null, 2) }];
}

function recipientWarnings(summary: Readonly<Record<string, unknown>>): string | undefined {
  const checks = Array.isArray(summary.recipient_checks) ? summary.recipient_checks : [];
  const outside = checks
    .map(record)
    .filter((check) => check?.in_list === false)
    .map((check) => str(check?.address))
    .filter((address): address is string => address !== undefined);
  return outside.length > 0 ? `Recipients outside the rule's list: ${outside.join(", ")}` : undefined;
}

export function approvalBlocks(view: ApprovalView, options: { approvable: boolean; note?: string }): Block[] {
  const blocks: Block[] = [
    { type: "header", text: { type: "plain_text", text: `Approval needed: ${titleOf(view)}`.slice(0, 150) } },
  ];
  const expires = Math.floor(view.expiresAt.getTime() / 1000);
  const facts = [
    `*Agent:* ${escapeSlack(view.context?.server ?? "unknown")}`,
    `*Provider:* ${escapeSlack(str(view.summary.provider_id) ?? "unknown")}`,
    `*Expires:* <!date^${expires}^{date_short_pretty} at {time}|${view.expiresAt.toISOString()}>`,
  ];
  blocks.push({ type: "section", text: { type: "mrkdwn", text: facts.join("\n") } });
  const reason = str(view.summary.reason);
  if (reason) blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Agent's reason*\n${quote(reason)}` } });
  for (const section of contentSections(view.summary)) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${escapeSlack(section.label)}*\n${quote(section.text)}` } });
  }
  const warning = recipientWarnings(view.summary);
  if (warning) blocks.push({ type: "section", text: { type: "mrkdwn", text: `:warning: ${escapeSlack(warning)}` } });
  if (options.note) blocks.push({ type: "section", text: { type: "mrkdwn", text: options.note } });
  blocks.push({
    type: "context",
    elements: [
      { type: "mrkdwn", text: `Approvers: ${escapeSlack(view.approvers.join(", ") || "the account owner")} · approval ${view.approvalId}` },
    ],
  });
  const deny = {
    type: "button",
    action_id: "deny",
    style: "danger",
    text: { type: "plain_text", text: "Deny" },
    value: JSON.stringify({ a: view.approvalId }),
  };
  if (options.approvable && view.requestDigest) {
    const value: ButtonValue = { a: view.approvalId, d: view.requestDigest, v: SHOWN_SUMMARY_VERSION };
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "approve",
          style: "primary",
          text: { type: "plain_text", text: "Approve" },
          value: JSON.stringify(value),
          confirm: {
            title: { type: "plain_text", text: "Approve this request?" },
            text: { type: "mrkdwn", text: `Alter will ${titleOf(view).toLowerCase()} exactly as shown above.` },
            confirm: { type: "plain_text", text: "Approve" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
        deny,
      ],
    });
  } else {
    blocks.push({
      type: "section",
      block_id: APPROVE_ELSEWHERE,
      text: { type: "mrkdwn", text: "Slack can only deny this request. To approve it, open it in the Alter Wallet." },
    });
    blocks.push({ type: "actions", elements: [deny] });
  }
  return blocks;
}

/** The message after a decision: everything it showed, the buttons replaced by the outcome. */
export function settledBlocks(blocks: Block[], outcome: string): Block[] {
  return [
    ...blocks.filter((block) => block.type !== "actions" && block.block_id !== APPROVE_ELSEWHERE),
    { type: "context", elements: [{ type: "mrkdwn", text: outcome }] },
  ];
}
