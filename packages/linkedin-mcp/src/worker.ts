// Cloudflare Worker entry for the hosted, multi-user LinkedIn MCP server. See README, "Host on Cloudflare".
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

import { createAlterCaller, loadConfig } from "./alter.js";
import { type HostedEnv, hostedWorker } from "./hosted.js";
import { apiVersionFrom } from "./linkedin.js";
import { SERVER_NAME, createLinkedInServer } from "./server.js";

interface Env extends Omit<HostedEnv, "OAUTH_PROVIDER"> {
  LINKEDIN_API_VERSION?: string;
}

export default hostedWorker<Env>((options) => new OAuthProvider(options), {
  title: "Alter LinkedIn MCP",
  accountName: "LinkedIn",
  provider: "linkedin",
  makeServer(env, grantId) {
    // grantId is the signed-in person's own LinkedIn connection, pinned at sign-in.
    const caller = createAlterCaller(loadConfig({ ALTER_AGENT_API_KEY: env.ALTER_AGENT_API_KEY, ALTER_GRANT_ID: grantId }), "linkedin", SERVER_NAME);
    const apiVersion = apiVersionFrom({ LINKEDIN_API_VERSION: env.LINKEDIN_API_VERSION });
    return { server: createLinkedInServer(caller, { apiVersion }), close: () => caller.close() };
  },
});
