// Cloudflare Worker entry for the hosted, multi-user X MCP server. See README, "Host on Cloudflare".
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

import { createAlterCaller, loadConfig } from "./alter.js";
import { type HostedEnv, hostedWorker } from "./hosted.js";
import { SERVER_NAME, createXServer } from "./server.js";

type Env = Omit<HostedEnv, "OAUTH_PROVIDER">;

export default hostedWorker<Env>((options) => new OAuthProvider(options), {
  title: "Alter X MCP",
  accountName: "X account",
  provider: "twitter",
  makeServer(env, grantId) {
    // grantId is the signed-in person's own X connection, pinned at sign-in.
    const caller = createAlterCaller(loadConfig({ ALTER_AGENT_API_KEY: env.ALTER_AGENT_API_KEY, ALTER_GRANT_ID: grantId }), "twitter", SERVER_NAME);
    return { server: createXServer(caller), close: () => caller.close() };
  },
});
