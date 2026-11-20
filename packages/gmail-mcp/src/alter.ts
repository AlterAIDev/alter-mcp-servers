// Shared by every server in this repository. Keep the copies identical
// (scripts/check-shared.mjs fails the build otherwise).
//
// The server holds only an Alter agent key. Alter holds the provider token,
// injects it into each request, enforces the policies set on the agent, and
// records every call. A request a policy holds for approval comes back as
// "pending" and runs only after a person approves it in the Alter Wallet.

import {
  Agent,
  AgentDelegationMissingError,
  AlterSDKError,
  AmbiguousGrantError,
  ApprovalPayloadTooLargeError,
  CredentialRevokedError,
  GrantExpiredError,
  GrantNotFoundError,
  GrantRevokedError,
  NoDelegatedGrantError,
  PendingApproval,
  PolicyViolationError,
  QuotaExceededError,
  RateLimitError,
  ReAuthRequiredError,
} from "@alter-ai/alter-sdk";

export class ConfigError extends Error {
  override name = "ConfigError";
}

export interface Config {
  apiKey: string;
  grantId?: string;
  account?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const apiKey = env.ALTER_AGENT_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError(
      "ALTER_AGENT_API_KEY is not set. Create an agent in Alter, connect the account to it, and set the agent's key (see the README).",
    );
  }
  const grantId = env.ALTER_GRANT_ID?.trim() || undefined;
  const account = env.ALTER_ACCOUNT?.trim() || undefined;
  if (grantId && account) {
    throw new ConfigError("Set ALTER_GRANT_ID or ALTER_ACCOUNT, not both.");
  }
  return { apiKey, ...(grantId ? { grantId } : {}), ...(account ? { account } : {}) };
}

export interface ProxyArgs {
  method: "GET" | "POST" | "PATCH";
  url: string;
  /** `{name}` placeholders in `url`, URL-encoded by the SDK. */
  pathParams?: Record<string, string>;
  queryParams?: Record<string, string | number>;
  json?: unknown;
  headers?: Record<string, string>;
  /** Shown to the approver when a policy holds the request. */
  reason?: string;
  /** Recorded in Alter's audit log with the call. */
  tool: string;
}

export type ProxyOutcome =
  | { kind: "pending"; approvalId: string; approvalUrls: string[]; expiresAt: string }
  | { kind: "result"; status: number; headers: Record<string, string>; body: string };

export interface ApprovalOutcome {
  status: string;
  decidedAt: string | null;
  executedAt: string | null;
  decisionReason: string | null;
  executionError: string | null;
}

export interface AlterCaller {
  proxy(args: ProxyArgs): Promise<ProxyOutcome>;
  approvalStatus(approvalId: string): Promise<ApprovalOutcome>;
}

export function createAlterCaller(
  config: Config,
  provider: string,
  serverName: string,
): AlterCaller & { close(): Promise<void> } {
  const agent = new Agent({ apiKey: config.apiKey, caller: serverName });
  const grant = config.grantId
    ? { grantId: config.grantId }
    : { provider, ...(config.account ? { account: config.account } : {}) };

  return {
    async proxy(args) {
      const result = await agent.proxyRequest({
        method: args.method,
        url: args.url,
        ...grant,
        ...(args.pathParams ? { pathParams: args.pathParams } : {}),
        ...(args.queryParams ? { queryParams: args.queryParams } : {}),
        ...(args.json !== undefined ? { json: args.json } : {}),
        ...(args.headers ? { extraHeaders: args.headers } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
        context: { tool: args.tool, framework: "mcp", server: serverName },
      });
      if (result instanceof PendingApproval) {
        const urls = result.gates.map((gate) => gate.approvalUrl);
        return {
          kind: "pending",
          approvalId: result.approvalId,
          approvalUrls: urls.length > 0 ? urls : [result.approvalUrl],
          expiresAt: result.expiresAt.toISOString(),
        };
      }
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(result.headers)) {
        headers[key.toLowerCase()] = value;
      }
      return { kind: "result", status: result.statusCode, headers, body: result.bodyText() };
    },

    async approvalStatus(approvalId) {
      const status = await agent.getApprovalStatus(approvalId);
      return {
        status: status.status,
        decidedAt: status.decidedAt ? status.decidedAt.toISOString() : null,
        executedAt: status.executedAt ? status.executedAt.toISOString() : null,
        decisionReason: status.decisionReason,
        executionError: status.executionError,
      };
    },

    close: () => agent.close(),
  };
}

// The SDK's classes are matched by instance and by name, so an error still
// maps correctly if two copies of the SDK end up installed.
function is(error: unknown, type: abstract new (...args: never[]) => Error): boolean {
  return error instanceof type || (error instanceof Error && error.name === type.name);
}

/** A message safe to show the model and the user; never a stack or raw payload. */
export function describeError(error: unknown, providerName: string): string {
  if (
    is(error, GrantNotFoundError) ||
    is(error, NoDelegatedGrantError) ||
    is(error, AgentDelegationMissingError)
  ) {
    return `No ${providerName} account is connected to this agent. Connect it in Alter and delegate it to the agent (see the README).`;
  }
  if (is(error, AmbiguousGrantError)) {
    return `More than one ${providerName} account is connected to this agent. Set ALTER_ACCOUNT to the one to use.`;
  }
  if (
    is(error, ReAuthRequiredError) ||
    is(error, GrantExpiredError) ||
    is(error, GrantRevokedError) ||
    is(error, CredentialRevokedError)
  ) {
    return `The ${providerName} connection was revoked or expired. Reconnect it in Alter.`;
  }
  if (is(error, PolicyViolationError)) {
    return `Blocked by a policy on this agent: ${(error as Error).message}`;
  }
  if (is(error, ApprovalPayloadTooLargeError)) {
    return "The request is too large to hold for approval. Shorten it and try again.";
  }
  if (is(error, RateLimitError) || is(error, QuotaExceededError)) {
    return "Alter's rate limit or quota was reached. Wait and try again.";
  }
  if (error instanceof ConfigError) {
    return error.message;
  }
  if (is(error, AlterSDKError)) {
    return `Alter refused the request: ${(error as Error).message}`;
  }
  return "Unexpected error. See the server's log for details.";
}

/** Tool text for a request a policy held: nothing has happened yet. */
export function describePending(outcome: Extract<ProxyOutcome, { kind: "pending" }>, action: string): string {
  return [
    `Held for approval: ${action}. Nothing has happened yet.`,
    `Approve or deny it in the Alter Wallet: ${outcome.approvalUrls.join(" , ")}`,
    `Approval id: ${outcome.approvalId} (expires ${outcome.expiresAt}).`,
    "Once approved, Alter runs exactly the request the approver saw. Use check_approval with the approval id to see the outcome.",
  ].join("\n");
}

export function describeApproval(outcome: ApprovalOutcome): string {
  switch (outcome.status) {
    case "pending":
      return "Still waiting for a decision.";
    case "approved":
    case "executing":
      return "Approved; Alter is running the request.";
    case "executed":
      return `Approved and done${outcome.executedAt ? ` at ${outcome.executedAt}` : ""}.`;
    case "denied":
      return `Denied${outcome.decisionReason ? `: ${outcome.decisionReason}` : ""}. Nothing was sent.`;
    case "expired":
      return "Expired before anyone decided. Nothing was sent.";
    case "failed":
      return `Approved, but the request failed when it ran${outcome.executionError ? `: ${outcome.executionError}` : ""}.`;
    default:
      return `Status: ${outcome.status}.`;
  }
}
