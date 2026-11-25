// Tests for the shared src/hosted.ts (identical in every server package).
import assert from "node:assert/strict";
import { test } from "node:test";

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  type Access,
  type HostedEnv,
  type KvLike,
  type RedeemResult,
  type SignIn,
  SignInStartError,
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
const RETURN_URL = `${ORIGIN}/authorize/return`;
/** The one-time code the fake Alter hands the browser that signed in as Ana. */
const CODE = "one-time-code-ana";
const BINDING_COOKIE = /^__Host-alter-signin-[0-9a-f]{16}$/;

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
  /** Who the fake Alter says signed in when CODE is redeemed. */
  user?: { sub: string; email?: string };
  allowed?: string;
  startFails?: boolean;
  /** The connection Access.find returns for each call, in order (the last repeats). */
  found?: ({ grantId: string } | null | "throw")[];
  /** Runs inside the first redeem, before it answers. */
  duringRedeem?: () => Promise<void>;
}

const cookieOf = (request: Request, name: string) =>
  (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([key]) => key === name)?.[1];

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
    // Like the library: consumes the state, and only for the browser holding the cookie beginUpstream set.
    finishUpstream: async (request: Request) => {
      calls.push({ name: "finishUpstream", args: [] });
      if (cookieOf(request, "upstream") !== "1") throw new AuthorizationError("This authorization was not started in this browser; start again");
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
  // Like Alter: a code works once, for the session it was issued to, and is burned by its first attempt.
  const burned = new Set<string>();
  const signIn: SignIn = {
    start: async (startOptions) => {
      calls.push({ name: "start", args: [startOptions] });
      if (options.startFails) throw new SignInStartError("The sign-in could not be started. Try again from your MCP client.");
      return { authUrl: "https://idp.example.com/authorize?x=1", sessionToken: "alter-session-secret", expiresIn: 600 };
    },
    redeem: async (sessionToken, code): Promise<RedeemResult> => {
      calls.push({ name: "redeem", args: [sessionToken, code] });
      const first = !burned.has(code);
      burned.add(code);
      if (first) await options.duringRedeem?.();
      if (!first || code !== CODE || sessionToken !== "alter-session-secret") return { status: "failed", message: "The sign-in failed or expired." };
      return { status: "completed", user: options.user ?? ANA, userToken: "idp-token-ana" };
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
  const count = (name: string) => names().filter((called) => called === name).length;
  const completed = () => calls.find((call) => call.name === "completeAuthorization")?.args[0] as { userId: string; props: unknown } | undefined;
  /** A browser: keeps the cookies the Worker sets and sends them back, as a real one does. */
  const browser = () => {
    const jar = new Map<string, string>();
    const send = async (request: Request) => {
      const headers = new Headers(request.headers);
      if (jar.size > 0) headers.set("cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
      const response = await run(new Request(request, { headers }));
      for (const line of response.headers.getSetCookie()) {
        const [pair = ""] = line.split(";");
        const name = pair.slice(0, pair.indexOf("=")).trim();
        const value = pair.slice(pair.indexOf("=") + 1).trim();
        if (/Max-Age=0/i.test(line) || value === "") jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
    const bindingName = () => [...jar.keys()].find((name) => BINDING_COOKIE.test(name));
    return { jar, send, bindingName };
  };
  return { run, calls, names, count, completed, kv, browser };
}

const approveForm = (decision: string) =>
  new Request(`${ORIGIN}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `handle=handle_1&decision=${decision}`,
  });
const wait = (state = STATE) => new Request(`${ORIGIN}/authorize/wait?state=${encodeURIComponent(state)}`);
/** The request Alter's redirect makes the browser send: the return address with a code (or an error) and the state. */
const comeBack = (params: Record<string, string> = { code: CODE }, state = STATE) =>
  new Request(`${RETURN_URL}?${new URLSearchParams({ ...params, state })}`);

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

test("allow starts a redirect sign-in that returns to this Worker, binds it to this browser with a cookie, and shows the sign-in page", async () => {
  const { run, calls, names, kv } = setup();
  const response = await run(approveForm("approve"));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /https:\/\/idp\.example\.com\/authorize\?x=1/);
  assert.match(body, new RegExp(STATE));
  assert.match(body, /<div id="connect" hidden>/);
  assert.ok(!body.includes("alter-session-secret"), "the session token never reaches the page");
  assert.match(response.headers.get("content-security-policy") ?? "", /script-src 'nonce-[0-9a-f]{32}'/);
  assert.deepEqual(names(), ["approveConsent", "beginUpstream", "start"]);
  assert.deepEqual(calls.find((call) => call.name === "start")?.args, [{ returnUrl: RETURN_URL, state: STATE }]);

  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.some((line) => line.startsWith("upstream=1")), "the library's own cookie is still set");
  const binding = cookies.find((line) => line.startsWith("__Host-alter-signin-")) ?? "";
  const [, name = "", value = ""] = /^([^=]+)=([^;]+);/.exec(binding) ?? [];
  assert.match(name, BINDING_COOKIE);
  assert.match(value, /^[0-9a-f]{64}$/, "256 random bits");
  assert.match(binding, /; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=900$/);
  assert.ok(!body.includes(value), "the binding value is not readable by the page");

  const [key, stored] = [...kv.data.entries()][0] ?? [];
  assert.ok(stored && !stored.includes("alter-session-secret"), "KV holds only ciphertext");
  assert.ok(key && !key.includes(STATE), "KV keys are hashed");
  const pending = (await loadPending(kv, STATE)) as { stage: string; sessionToken: string; bindingHash: string };
  assert.equal(pending.stage, "signin");
  assert.equal(pending.sessionToken, "alter-session-secret");
  assert.match(pending.bindingHash, /^[0-9a-f]{64}$/);
  assert.notEqual(pending.bindingHash, value, "the record holds a hash of the cookie value, not the value");
  assert.equal(await loadPending(kv, "another-state"), null);
});

test("if Alter cannot start a bound sign-in, the person sees why and nothing is left pending", async () => {
  const { run, kv } = setup({ startFails: true });
  const response = await run(approveForm("approve"));
  assert.equal(response.status, 502);
  assert.match(await response.text(), /could not be started/);
  assert.equal(kv.data.size, 0);
  assert.ok(!response.headers.getSetCookie().some((line) => line.startsWith("__Host-alter-signin-")));
});

test("the poll never asks Alter and never completes before the return address has run", async () => {
  const { browser, names, count } = setup();
  const page = browser();
  await page.send(approveForm("approve"));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await page.send(wait());
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: "pending" });
  }
  assert.deepEqual(names(), ["approveConsent", "beginUpstream", "start"], "no redeem, no connection lookup, no token");
  assert.equal(count("completeAuthorization"), 0);
});

test("the normal flow: the popup returns with a code, the Worker redeems it for the starting browser, and the poll finishes", async () => {
  const { browser, calls, names, count, completed, kv } = setup({ found: [{ grantId: "grant_ana" }] });
  const page = browser();
  await page.send(approveForm("approve"));
  assert.ok(page.bindingName(), "the browser holds the binding cookie");
  assert.equal((await page.send(wait())).status, 202);

  const returned = await page.send(comeBack());
  assert.equal(returned.status, 200);
  const body = await returned.text();
  assert.match(body, /<h1>Signed in<\/h1>/);
  assert.match(body, /<script nonce="[0-9a-f]{32}">window\.close\(\);<\/script>/);
  assert.ok(!body.includes("idp-token-ana") && !body.includes(CODE), "the page carries no credential");
  assert.equal(returned.headers.get("referrer-policy"), "no-referrer");
  assert.equal(returned.headers.get("cache-control"), "no-store");
  assert.deepEqual(calls.find((call) => call.name === "redeem")?.args, ["alter-session-secret", CODE]);
  assert.equal(page.bindingName(), undefined, "the binding cookie is cleared once used");
  assert.ok(![...kv.data.values()].some((value) => value.includes("idp-token-ana")), "the identity-provider token is stored encrypted");
  assert.deepEqual(await loadPending(kv, STATE), { stage: "signedin", userToken: "idp-token-ana", user: ANA });
  assert.ok(!names().includes("find"), "the return address only records who signed in");

  const done = await page.send(wait());
  assert.equal(done.status, 200);
  assert.deepEqual(await done.json(), { redirectTo: "https://claude.ai/api/mcp/auth_callback?code=abc&state=client-state" });
  assert.deepEqual(calls.find((call) => call.name === "find")?.args, ["idp-token-ana"], "looked up with the person's own token");
  assert.ok(!names().includes("connect"));
  assert.equal(completed()?.userId, "user_1");
  assert.deepEqual(completed()?.props, { userId: "user_1", email: "ana@example.com", grantId: "grant_ana" });
  assert.equal(count("redeem"), 1);
  assert.equal(kv.data.size, 0, "the pending sign-in is gone");
});

test("a first-time person is asked to connect their account, then gets a token for the new connection", async () => {
  const { browser, calls, names, count, completed, kv } = setup({ found: [null, null, { grantId: "grant_new" }] });
  const page = browser();
  await page.send(approveForm("approve"));
  await page.send(comeBack());

  const first = await page.send(wait());
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { status: "connect", connectUrl: "https://connect.example.com/session/1" });
  assert.deepEqual(calls.find((call) => call.name === "connect")?.args, ["idp-token-ana"]);
  assert.ok(!names().includes("finishUpstream"), "the state is kept for the next poll");
  const stored = [...kv.data.values()][0] ?? "";
  assert.ok(!stored.includes("idp-token-ana"), "the identity-provider token is stored encrypted");
  assert.equal((await loadPending(kv, STATE))?.stage, "connect");

  const second = await page.send(wait());
  assert.equal(second.status, 202, "still connecting");
  assert.equal(count("connect"), 1, "one Connect session, not one per poll");

  const third = await page.send(wait());
  assert.equal(third.status, 200);
  assert.deepEqual(completed()?.props, { userId: "user_1", email: "ana@example.com", grantId: "grant_new" });
  assert.equal(kv.data.size, 0);
});

test("a return request without the binding cookie is refused and the code is never redeemed", async () => {
  const { browser, names, kv } = setup();
  const page = browser();
  await page.send(approveForm("approve"));
  const before = [...kv.data.values()];

  const response = await browser().send(comeBack());
  assert.equal(response.status, 403);
  const body = await response.text();
  assert.match(body, /not started in this browser/);
  assert.ok(!body.includes("window.close"));
  assert.ok(!names().includes("redeem"), "the code is never redeemed");
  assert.deepEqual([...kv.data.values()], before, "the pending sign-in is untouched");

  // The browser that started it is not locked out by the stray request.
  assert.equal((await page.send(comeBack())).status, 200);
  assert.equal((await page.send(wait())).status, 200);
});

test("a return request with the wrong binding cookie is refused and the code is never redeemed", async () => {
  const { browser, names, kv } = setup();
  const page = browser();
  await page.send(approveForm("approve"));
  const name = page.bindingName() ?? "";
  const real = page.jar.get(name) ?? "";

  const guesses = ["0".repeat(64), `${real.slice(0, 63)}${real.endsWith("0") ? "1" : "0"}`, real.slice(0, 32), ""];
  // The stored hash itself is not the cookie value either.
  guesses.push(((await loadPending(kv, STATE)) as { bindingHash: string }).bindingHash);
  for (const guess of guesses) {
    const visitor = browser();
    visitor.jar.set(name, guess);
    assert.equal((await visitor.send(comeBack())).status, 403, `refused: ${guess.slice(0, 8)}`);
  }
  // Holding only the library's upstream cookie, or the right value under another sign-in's name, is not enough.
  const other = browser();
  other.jar.set("upstream", "1");
  other.jar.set("__Host-alter-signin-0000000000000000", real);
  assert.equal((await other.send(comeBack())).status, 403);
  assert.ok(!names().includes("redeem"));
  assert.equal((await loadPending(kv, STATE))?.stage, "signin");
});

test("a replayed return request redeems nothing and does not disturb the sign-in", async () => {
  const { browser, count, completed, kv } = setup();
  const page = browser();
  await page.send(approveForm("approve"));
  const cookies = new Map(page.jar);
  assert.equal((await page.send(comeBack())).status, 200);

  // Replayed by the same browser (a reload), by one that kept the old cookie, and by a stranger.
  const replays = [page, browser(), browser()];
  for (const [name, value] of cookies) replays[1]?.jar.set(name, value);
  for (const replay of replays) {
    const response = await replay.send(comeBack());
    assert.equal(response.status, 409);
    assert.match(await response.text(), /already completed/);
  }
  assert.equal(count("redeem"), 1, "the code was redeemed once");
  assert.equal((await loadPending(kv, STATE))?.stage, "signedin");

  assert.equal((await page.send(wait())).status, 200);
  assert.equal(completed()?.userId, "user_1");
  // And once the flow is over, the same request finds nothing.
  assert.equal((await page.send(comeBack())).status, 410);
  assert.equal(count("redeem"), 1);
});

test("an error return from the starting browser ends the flow; from any other browser it changes nothing", async () => {
  const { browser, names, kv } = setup();
  const page = browser();
  await page.send(approveForm("approve"));

  const stranger = await browser().send(comeBack({ error: "user_denied" }));
  assert.equal(stranger.status, 403);
  assert.equal((await loadPending(kv, STATE))?.stage, "signin", "someone else cannot cancel the sign-in");
  assert.equal((await page.send(wait())).status, 202);

  const response = await page.send(comeBack({ error: "identity_mismatch<script>" }));
  assert.equal(response.status, 400);
  const body = await response.text();
  assert.match(body, /<h1>Sign-in failed<\/h1>/);
  assert.ok(!body.includes("identity_mismatch"), "the error parameter is not echoed");
  assert.equal(page.bindingName(), undefined);

  const polled = await page.send(wait());
  assert.equal(polled.status, 400);
  assert.match(JSON.stringify(await polled.json()), /failed or expired/);
  assert.equal(kv.data.size, 0);
  assert.ok(!names().includes("redeem") && !names().includes("find") && !names().includes("completeAuthorization"));
});

test("an error return that also carries a code is still a failure, and a return with neither is too", async () => {
  for (const params of [{ error: "user_denied", code: CODE }, {}] as Record<string, string>[]) {
    const { browser, names, kv } = setup();
    const page = browser();
    await page.send(approveForm("approve"));
    assert.equal((await page.send(comeBack(params))).status, 400);
    assert.ok(!names().includes("redeem"));
    assert.equal((await loadPending(kv, STATE))?.stage, "failed");
  }
});

test("a code Alter refuses ends the flow without a token", async () => {
  const { browser, count, names, kv } = setup();
  const page = browser();
  await page.send(approveForm("approve"));
  const response = await page.send(comeBack({ code: "not-the-code" }));
  assert.equal(response.status, 400);
  assert.equal(count("redeem"), 1);
  assert.equal((await page.send(wait())).status, 400);
  assert.ok(!names().includes("completeAuthorization"));
  assert.equal(kv.data.size, 0);
});

test("a failed redeem racing a successful one does not undo it", async () => {
  const state = setup({
    // Another request from the same browser finishes first; this one's code then fails.
    duringRedeem: async () => savePending(state.kv, STATE, { stage: "signedin", userToken: "idp-token-ana", user: ANA }),
  });
  const page = state.browser();
  await page.send(approveForm("approve"));
  assert.equal((await page.send(comeBack({ code: "not-the-code" }))).status, 400);
  assert.equal((await loadPending(state.kv, STATE))?.stage, "signedin");
});

test("a state that matches no pending sign-in is refused at the return address and at the poll", async () => {
  const { browser, names } = setup();
  const page = browser();
  await page.send(approveForm("approve"));
  for (const request of [comeBack({ code: CODE }, "nothing-stored"), new Request(`${RETURN_URL}?code=${CODE}`), new Request(RETURN_URL)]) {
    const response = await page.send(request);
    assert.equal(response.status, 410);
    assert.match(await response.text(), /expired/);
  }
  assert.ok(!names().includes("redeem"));
  assert.equal((await setup().run(wait("nothing-stored"))).status, 410);
  assert.equal((await setup().run(new Request(RETURN_URL, { method: "POST" }))).status, 404, "the return address answers GET only");
});

test("the attack: a sign-in link sent to someone else gives the sender nothing", async () => {
  const { browser, names, count, kv } = setup();
  // Mallory starts /authorize in her own browser and gets the sign-in page with the identity provider link.
  const mallory = browser();
  const started = await mallory.send(approveForm("approve"));
  assert.match(await started.text(), /https:\/\/idp\.example\.com\/authorize\?x=1/);
  assert.equal((await mallory.send(wait())).status, 202);

  // She sends Ana the link. Ana signs in, and Alter redirects ANA'S browser to the return address
  // with the one-time code. Ana's browser never held Mallory's binding cookie.
  const ana = browser();
  const landed = await ana.send(comeBack());
  assert.equal(landed.status, 403);
  assert.match(await landed.text(), /not started in this browser.*nobody was given access/);
  assert.equal(count("redeem"), 0, "Ana's code is never redeemed");

  // Mallory's page keeps polling. Before this fix the poll asked Alter and received Ana's token here.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const polled = await mallory.send(wait());
    assert.equal(polled.status, 202);
    assert.deepEqual(await polled.json(), { status: "pending" });
  }
  // Mallory holds the cookie but never saw the code, which went only to Ana's browser.
  assert.equal((await mallory.send(comeBack({ code: "a-guess" }))).status, 400);
  assert.equal((await mallory.send(wait())).status, 400);

  assert.ok(!names().includes("find") && !names().includes("connect"), "no connection was looked up for anyone");
  assert.equal(count("completeAuthorization"), 0, "no token was issued");
  assert.equal(kv.data.size, 0);
});

test("if the identity-provider token expires while connecting, the flow ends cleanly", async () => {
  const { browser, names, kv } = setup({ found: [null, "throw"] });
  const page = browser();
  await page.send(approveForm("approve"));
  await page.send(comeBack());
  assert.equal((await page.send(wait())).status, 202);
  const response = await page.send(wait());
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /expired before the connection finished/);
  assert.ok(names().includes("finishUpstream"), "the state is consumed");
  assert.equal(kv.data.size, 0);
});

test("someone not on the allowed list is refused before any connection is looked up", async () => {
  const { browser, names, kv } = setup({ user: { sub: "user_2", email: "x@other.com" } });
  const page = browser();
  await page.send(approveForm("approve"));
  assert.equal((await page.send(comeBack())).status, 200, "the return address only records who signed in");
  const response = await page.send(wait());
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

test("a poll from another browser, after the sign-in is stored, is refused by the state binding", async () => {
  const { browser, names } = setup();
  const page = browser();
  await page.send(approveForm("approve"));
  await page.send(comeBack());
  const response = await browser().send(wait());
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /not started in this browser/);
  assert.ok(!names().includes("completeAuthorization"));
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
