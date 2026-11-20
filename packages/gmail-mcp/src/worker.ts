// Cloudflare Worker entry for the hosted, multi-user Gmail MCP server. See README, "Host on Cloudflare".
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

import { createAlterCaller, loadConfig } from "./alter.js";
import { type HostedEnv, hostedWorker } from "./hosted.js";
import { SERVER_NAME, createGmailServer } from "./server.js";

type Env = Omit<HostedEnv, "OAUTH_PROVIDER">;

export default hostedWorker<Env>((options) => new OAuthProvider(options), {
  title: "Alter Gmail MCP",
  accountName: "Gmail",
  provider: "google",
  makeServer(env, grantId) {
    // grantId is the signed-in person's own Gmail connection, pinned at sign-in.
    const caller = createAlterCaller(loadConfig({ ALTER_AGENT_API_KEY: env.ALTER_AGENT_API_KEY, ALTER_GRANT_ID: grantId }), "google", SERVER_NAME);
    return { server: createGmailServer(caller), close: () => caller.close() };
  },
});
