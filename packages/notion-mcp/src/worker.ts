// Cloudflare Worker entry for the hosted, multi-user Notion MCP server. See README, "Host on Cloudflare".
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

import { createAlterCaller, loadConfig } from "./alter.js";
import { type HostedEnv, hostedWorker } from "./hosted.js";
import { SERVER_NAME, createNotionServer } from "./server.js";

type Env = Omit<HostedEnv, "OAUTH_PROVIDER">;

export default hostedWorker<Env>((options) => new OAuthProvider(options), {
  title: "Alter Notion MCP",
  accountName: "Notion",
  provider: "notion",
  makeServer(env, grantId) {
    // grantId is the signed-in person's own Notion connection, pinned at sign-in.
    const caller = createAlterCaller(loadConfig({ ALTER_AGENT_API_KEY: env.ALTER_AGENT_API_KEY, ALTER_GRANT_ID: grantId }), "notion", SERVER_NAME);
    return { server: createNotionServer(caller), close: () => caller.close() };
  },
});
