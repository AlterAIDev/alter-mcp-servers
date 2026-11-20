// The few Slack Web API calls the bridge makes, and Slack's request signature
// check (https://api.slack.com/authentication/verifying-requests-from-slack).

import type { Block } from "./render.js";

const encoder = new TextEncoder();

/** Checks `X-Slack-Signature` over `v0:{timestamp}:{body}`, rejecting requests older than five minutes. */
export async function verifySlackSignature(
  signingSecret: string,
  headers: Headers,
  body: string,
  nowSeconds: number = Date.now() / 1000,
): Promise<boolean> {
  const timestamp = headers.get("x-slack-request-timestamp");
  const signature = headers.get("x-slack-signature");
  if (!timestamp || !signature?.startsWith("v0=") || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false;
  const hex = signature.slice(3);
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const expected = Uint8Array.from(hex.match(/../g) ?? [], (byte) => parseInt(byte, 16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(signingSecret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify",
  ]);
  // subtle.verify compares in constant time.
  return crypto.subtle.verify("HMAC", key, expected, encoder.encode(`v0:${timestamp}:${body}`));
}

export interface SlackApi {
  postMessage(channel: string, text: string, blocks?: Block[]): Promise<void>;
  /** The member's email (needs the users:read.email scope) and whether the member is a bot. */
  member(userId: string): Promise<{ email?: string; isBot: boolean }>;
  /** Replies through an interaction's response_url. */
  respond(responseUrl: string, message: Record<string, unknown>): Promise<void>;
}

export class SlackError extends Error {
  override name = "SlackError";
}

export function createSlackApi(token: string, fetchImpl: typeof fetch = fetch): SlackApi {
  const call = async (method: string, body: Record<string, unknown>) => {
    const response = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as { ok?: boolean; error?: string } & Record<string, unknown>;
    if (!result.ok) throw new SlackError(`Slack ${method} failed: ${result.error ?? response.status}`);
    return result;
  };
  return {
    async postMessage(channel, text, blocks) {
      await call("chat.postMessage", { channel, text, ...(blocks ? { blocks } : {}), unfurl_links: false });
    },
    async member(userId) {
      // users.info takes form or query arguments, not JSON.
      const response = await fetchImpl(`https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const result = (await response.json()) as {
        ok?: boolean;
        error?: string;
        user?: { is_bot?: boolean; profile?: { email?: string } };
      };
      if (!result.ok) throw new SlackError(`Slack users.info failed: ${result.error ?? response.status}`);
      const email = result.user?.profile?.email?.toLowerCase();
      return { ...(email ? { email } : {}), isBot: result.user?.is_bot === true };
    },
    async respond(responseUrl, message) {
      if (!responseUrl.startsWith("https://hooks.slack.com/")) throw new SlackError("Unexpected response_url host.");
      const response = await fetchImpl(responseUrl, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(message),
      });
      if (!response.ok) throw new SlackError(`Slack response_url failed: HTTP ${response.status}`);
    },
  };
}
