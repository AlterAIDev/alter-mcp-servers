// Cloudflare Worker: Alter approvals in Slack. See README.
import { App, verifyWebhook } from "@alter-ai/alter-sdk";

import { type BridgeDeps, handleAlterWebhook, handleSlackInteraction } from "./bridge.js";
import { createSlackApi } from "./slack.js";

interface Env {
  /** An Alter app key with approvals:read and approvals:decide. */
  ALTER_APPROVALS_KEY: string;
  /** The webhook endpoint's signing secret (whsec_...). */
  ALTER_WEBHOOK_SECRET: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_CHANNEL_ID: string;
}

interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    const isWebhook = request.method === "POST" && pathname === "/alter/webhook";
    const isInteraction = request.method === "POST" && pathname === "/slack/interactions";
    if (!isWebhook && !isInteraction) return new Response("Not found", { status: 404 });

    const app = new App({ apiKey: env.ALTER_APPROVALS_KEY });
    const deps: BridgeDeps = {
      approvals: app,
      slack: createSlackApi(env.SLACK_BOT_TOKEN),
      channel: env.SLACK_CHANNEL_ID,
      verifyWebhook: (body, headers) => verifyWebhook(body, headers, env.ALTER_WEBHOOK_SECRET),
      signingSecret: env.SLACK_SIGNING_SECRET,
      log: (message, error) => console.error(`[slack-approvals] ${message}`, error instanceof Error ? error.message : error),
    };
    if (isWebhook) {
      try {
        return await handleAlterWebhook(request, deps);
      } finally {
        await app.close();
      }
    }
    const work: Promise<unknown>[] = [];
    const response = await handleSlackInteraction(request, deps, (promise) => work.push(promise));
    ctx.waitUntil(Promise.allSettled(work).finally(() => app.close()));
    return response;
  },
};
