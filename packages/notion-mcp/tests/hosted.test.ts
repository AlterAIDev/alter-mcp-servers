// Tests for the shared src/hosted.ts (identical in every server package).
import assert from "node:assert/strict";
import { test } from "node:test";

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  type Access,
  type HostedEnv,
  type KvLike,
  type PollResult,
  type SignIn,
  consentPage,
  handleAuthorize,
  hostedWorker,
  isAllowed,
  loadPending,
  parseAllowedUsers,
  providerOptions,
  savePending,
  serveMcp,
} from "../src/hosted.js";

const ORIGIN = "https://mcp.example.com";
const UI = { title: "Alter Gmail MCP", accountName: "Gmail" };
const STATE = "upstream-state-123";
const AUTH_REQUEST = {
  responseType: "code",
  clientId: "client_1",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  scope: [],
  state: "client-state",
};
const ANA = { sub: "user_1", email: "ana@example.com" };

class AuthorizationError extends Error {
  override name = "AuthorizationError";
  constructor(readonly description: string) {
    super(description);
  }
}

function memoryKv(): KvLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (key) => data.get(key) ?? null,
    put: async (key, value) => {
      data.set(key, value);
    },
    delete: async (key) => {
      data.delete(key);
    },
  };
}

interface Options {
  poll?: PollResult;
  allowed?: string;
  finishFails?: boolean;
  /** The connection Access.find returns for each call, in order (the last repeats). */
  found?: ({ grantId: string } | null | "throw")[];
}

function setup(options: Options = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const cookie = (name: string) => new Headers({ "Set-Cookie": `${name}=1; Secure; HttpOnly` });
  const helpers = {
    parseAuthRequest: async () => AUTH_REQUEST,
    describeConsent: async () => ({
      clientId: "client_1",
      clientName: "Claude <script>",
      redirectUri: AUTH_REQUEST.redirectUri,
      redirectHost: "claude.ai",
      redirectIsLoopback: false,
      scope: [],
    }),
    beginConsent: async () => ({ handle: "handle_1", headers: cookie("consent") }),
    denyConsent: async () => ({
      request: AUTH_REQUEST,
      redirectTo: "https://claude.ai/api/mcp/auth_callback?error=access_denied",
      headers: new Headers({ Location: "https://claude.ai/api/mcp/auth_callback?error=access_denied" }),
    }),
    approveConsent: async (_req: Request, handle: string) => {
      calls.push({ name: "approveConsent", args: [handle] });
      return { request: AUTH_REQUEST, headers: cookie("approved") };
    },
    beginUpstream: async (request: unknown, opts: { headers: Headers }) => {
      calls.push({ name: "beginUpstream", args: [request] });
      opts.headers.append("Set-Cookie", "upstream=1; Secure; HttpOnly");
      return { state: STATE, headers: opts.headers };
    },
    finishUpstream: async () => {
      calls.push({ name: "finishUpstream", args: [] });
      if (options.finishFails) throw new AuthorizationError("This sign-in was opened in another browser.");
      return { request: AUTH_REQUEST, data: undefined, headers: new Headers({ "Set-Cookie": "upstream=; Max-Age=0" }) };
    },
    completeAuthorization: async (opts: unknown) => {
      calls.push({ name: "completeAuthorization", args: [opts] });
      return { redirectTo: "https://claude.ai/api/mcp/auth_callback?code=abc&state=client-state" };
    },
  };
  const kv = memoryKv();
  const env = {
    OAUTH_KV: kv,
    OAUTH_PROVIDER: helpers as unknown as OAuthHelpers,
    ALTER_AGENT_API_KEY: "unused",
    ALTER_SIGNIN_KEY: "unused",
    ALLOWED_USERS: options.allowed ?? "user_1",
  } satisfies HostedEnv;
  const signIn: SignIn = {
    start: async () => ({ authUrl: "https://idp.example.com/authorize?x=1", sessionToken: "alter-session-secret", expiresIn: 600 }),
    poll: async (token) => {
      calls.push({ name: "poll", args: [token] });
      return options.poll ?? { status: "pending" };
    },
    close: async () => undefined,
  };
  const found = [...(options.found ?? [{ grantId: "grant_ana" }])];
  const access: Access = {
    find: async (userToken) => {
      calls.push({ name: "find", args: [userToken] });
      const next = found.length > 1 ? found.shift() : found[0];
      if (next === "throw") throw new Error("token expired");
      return next ?? null;
    },
    connect: async (userToken) => {
      calls.push({ name: "connect", args: [userToken] });
      return "https://connect.example.com/session/1";
    },
    close: async () => undefined,
  };
  const run = (request: Request) => handleAuthorize(request, env, UI, { signIn: () => signIn, access: () => access, pollWindowMs: 0 });
  const names = () => calls.map((call) => call.name);
  const completed = () => calls.find((call) => call.name === "completeAuthorization")?.args[0] as { userId: string; props: unknown } | undefined;
  return { run, calls, names, completed, kv };
}

const approveForm = (decision: string) =>
  new Request(`${ORIGIN}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `handle=handle_1&decision=${decision}`,
  });
const wait = (state = STATE) => new Request(`${ORIGIN}/authorize/wait?state=${encodeURIComponent(state)}`);
const signedIn = (user = ANA): PollResult => ({ status: "completed", user, userToken: "idp-token-ana" });

test("the consent page names the client (escaped), where access goes, and that each person uses their own account", async () => {
  const { run } = setup();
  const response = await run(new Request(`${ORIGIN}/authorize?client_id=client_1`));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Allow Claude &#60;script&#62; to use Alter Gmail MCP as you\?/);
  assert.match(body, /<strong>claude\.ai<\/strong>/);
  assert.match(body, /your own Gmail/);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.match(response.headers.get("set-cookie") ?? "", /consent=1/);
});

test("a loopback redirect is called out on the consent page", () => {
  const body = consentPage(
    UI,
    { clientId: "c", clientName: "Claude Code", redirectUri: "http://localhost:3000/cb", redirectHost: "localhost", redirectIsLoopback: true, scope: [] } as never,
    "h",
  );
  assert.match(body, /an app on this computer/);
});

test("deny redirects back to the client without starting a sign-in", async () => {
  const { run, calls } = setup();
  const response = await run(approveForm("deny"));
  assert.equal(response.status, 302);
  assert.match(response.headers.get("location") ?? "", /error=access_denied/);
  assert.equal(calls.length, 0);
});

test("allow starts an Alter sign-in, keeps its session token encrypted, and shows the sign-in page", async () => {
  const { run, names, kv } = setup();
  const response = await run(approveForm("approve"));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /https:\/\/idp\.example\.com\/authorize\?x=1/);
  assert.match(body, new RegExp(STATE));
  assert.match(body, /<div id="connect" hidden>/);
  assert.ok(!body.includes("alter-session-secret"), "the session token never reaches the page");
  assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'nonce-[0-9a-f]{32}'/);
  assert.match(response.headers.get("set-cookie") ?? "", /upstream=1/);
  assert.deepEqual(names(), ["approveConsent", "beginUpstream"]);
  const [key, value] = [...kv.data.entries()][0] ?? [];
  assert.ok(value && !value.includes("alter-session-secret"), "KV holds only ciphertext");
  assert.ok(key && !key.includes(STATE), "KV keys are hashed");
  assert.deepEqual(await loadPending(kv, STATE), { stage: "signin", sessionToken: "alter-session-secret" });
  assert.equal(await loadPending(kv, "another-state"), null);
});

test("while the person is still signing in, the poll answers 202", async () => {
  const { run, kv } = setup({ poll: { status: "pending" } });
  await savePending(kv, STATE, { stage: "signin", sessionToken: "s" });
  const response = await run(wait());
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "pending" });
});

test("a person who already connected gets a token pinned to their own connection", async () => {
  const { run, calls, names, completed, kv } = setup({ poll: signedIn(), found: [{ grantId: "grant_ana" }] });
  await savePending(kv, STATE, { stage: "signin", sessionToken: "s" });
  const response = await run(wait());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { redirectTo: "https://claude.ai/api/mcp/auth_callback?code=abc&state=client-state" });
  assert.deepEqual(calls.find((call) => call.name === "find")?.args, ["idp-token-ana"], "looked up with the person's own token");
  assert.ok(!names().includes("connect"));
  assert.equal(completed()?.userId, "user_1");
  assert.deepEqual(completed()?.props, { userId: "user_1", email: "ana@example.com", grantId: "grant_ana" });
  assert.equal(kv.data.size, 0, "the pending sign-in is gone");
});

test("a first-time person is asked to connect their account, then gets a token for the new connection", async () => {
  const { run, calls, names, completed, kv } = setup({ poll: signedIn(), found: [null, null, { grantId: "grant_new" }] });
  await savePending(kv, STATE, { stage: "signin", sessionToken: "s" });

  const first = await run(wait());
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { status: "connect", connectUrl: "https://connect.example.com/session/1" });
  assert.deepEqual(calls.find((call) => call.name === "connect")?.args, ["idp-token-ana"]);
  assert.ok(!names().includes("finishUpstream"), "the state is kept for the next poll");
  const stored = [...kv.data.values()][0] ?? "";
  assert.ok(!stored.includes("idp-token-ana"), "the identity-provider token is stored encrypted");
  assert.equal((await loadPending(kv, STATE))?.stage, "connect");

  const second = await run(wait());
  assert.equal(second.status, 202, "still connecting");
  assert.equal(names().filter((name) => name === "connect").length, 1, "one Connect session, not one per poll");

  const third = await run(wait());
  assert.equal(third.status, 200);
  assert.deepEqual(completed()?.props, { userId: "user_1", email: "ana@example.com", grantId: "grant_new" });
  assert.equal(kv.data.size, 0);
});

test("if the identity-provider token expires while connecting, the flow ends cleanly", async () => {
  const { run, names, kv } = setup({ found: ["throw"] });
  await savePending(kv, STATE, { stage: "connect", userToken: "t", user: ANA, connectUrl: "https://c" });
  const response = await run(wait());
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /expired before the connection finished/);
  assert.ok(names().includes("finishUpstream"), "the state is consumed");
  assert.equal(kv.data.size, 0);
});

test("someone not on the allowed list is refused before any connection is looked up", async () => {
  const { run, names, kv } = setup({ poll: signedIn({ sub: "user_2", email: "x@other.com" }) });
  await savePending(kv, STATE, { stage: "signin", sessionToken: "s" });
  const response = await run(wait());
  assert.equal(response.status, 403);
  assert.ok(!names().includes("find") && !names().includes("completeAuthorization"));
  assert.ok(names().includes("finishUpstream"), "the state is consumed");
  assert.equal(kv.data.size, 0);
});

test("allowed users: ids, emails, a whole @domain, or *; an empty list refuses everyone", () => {
  const allowed = (list: string, user: { sub: string; email?: string }) => isAllowed(user, parseAllowedUsers(list));
  assert.equal(allowed("user_1", { sub: "USER_1" }), true);
  assert.equal(allowed("Ana@Example.com", ANA), true);
  assert.equal(allowed("@example.com", ANA), true);
  assert.equal(allowed("@example.com", { sub: "u", email: "ana@example.com.evil.io" }), false);
  assert.equal(allowed("@example.com", { sub: "u" }), false, "a domain rule needs an email");
  assert.equal(allowed("*", { sub: "anyone" }), true);
  assert.equal(allowed("", ANA), false);
  assert.deepEqual([...parseAllowedUsers(" user_1, ,A@B.com ")], ["user_1", "a@b.com"]);
});

test("a poll from another browser is refused by the state binding", async () => {
  const { run, names, kv } = setup({ poll: signedIn(), finishFails: true });
  await savePending(kv, STATE, { stage: "signin", sessionToken: "s" });
  const response = await run(wait());
  assert.equal(response.status, 400);
  assert.ok(!names().includes("completeAuthorization"));
});

test("a failed or expired sign-in, or an unknown state, ends the flow", async () => {
  const failed = setup({ poll: { status: "failed", message: "The sign-in failed or expired." } });
  await savePending(failed.kv, STATE, { stage: "signin", sessionToken: "s" });
  const response = await failed.run(wait());
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /failed or expired/);
  assert.equal((await setup().run(wait("nothing-stored"))).status, 410);
});

function server() {
  const made = new McpServer({ name: "test", version: "0.0.0" });
  made.registerTool("ping", { description: "Ping" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
  return made;
}

const rpc = (body: unknown) =>
  new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });

test("the MCP endpoint serves a fresh server per request and closes it", async () => {
  let closed = 0;
  const made = () => ({ server: server(), close: async () => void (closed += 1) });
  const init = await serveMcp(
    rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    made(),
  );
  assert.equal(init.status, 200);
  const list = await serveMcp(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }), made());
  assert.match(JSON.stringify(await list.json()), /"ping"/);
  assert.equal(closed, 2);
});

test("tools run through the connection pinned to the token; a token without one is sent to sign in again", async () => {
  const used: string[] = [];
  const options = providerOptions(ORIGIN, {
    ...UI,
    provider: "google",
    makeServer: (_env, grantId) => {
      used.push(grantId);
      return { server: server() };
    },
  }) as unknown as {
    apiHandler: { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> | Response };
    apiRoute: string;
    authorizeEndpoint: string;
    clientRegistrationEndpoint: string;
    clientIdMetadataDocumentEnabled: boolean;
    resourceMetadata: { resource: string; authorization_servers: string[] };
  };
  const list = rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const ok = await options.apiHandler.fetch(list, {}, { props: { userId: "user_1", grantId: "grant_ana" } });
  assert.equal(ok.status, 200);
  assert.deepEqual(used, ["grant_ana"]);

  const stale = await options.apiHandler.fetch(rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }), {}, { props: { userId: "user_1" } });
  assert.equal(stale.status, 401);
  assert.match(stale.headers.get("www-authenticate") ?? "", /invalid_token.*resource_metadata="https:\/\/mcp\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.deepEqual(used, ["grant_ana"], "no server was built for the stale token");

  assert.equal(options.apiRoute, "/mcp");
  assert.equal(options.authorizeEndpoint, "/authorize");
  assert.equal(options.clientRegistrationEndpoint, "/oauth/register");
  assert.equal(options.clientIdMetadataDocumentEnabled, true);
  assert.deepEqual(options.resourceMetadata, { resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
});

test("the provider is built once per origin the Worker is reached at", async () => {
  const built: string[] = [];
  const worker = hostedWorker(
    (opts) => {
      built.push((opts as unknown as { resourceMetadata: { resource: string } }).resourceMetadata.resource);
      return { fetch: () => new Response("ok") };
    },
    { ...UI, provider: "google", makeServer: () => ({ server: server() }) },
  );
  const env = {} as never;
  await worker.fetch(new Request(`${ORIGIN}/a`), env, {});
  await worker.fetch(new Request(`${ORIGIN}/b`), env, {});
  await worker.fetch(new Request("https://other.example.com/a"), env, {});
  assert.deepEqual(built, [`${ORIGIN}/mcp`, "https://other.example.com/mcp"]);
});
