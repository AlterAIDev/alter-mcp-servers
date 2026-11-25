// Shared by every server in this repository. Keep the copies identical
// (scripts/check-shared.mjs fails the build otherwise).
//
// Remote, multi-user hosting on Cloudflare Workers. The Worker is the OAuth
// server MCP clients (claude.ai, Claude Code) sign in with, built on
// @cloudflare/workers-oauth-provider, and it signs each person in through
// Alter: the identity provider configured on the Alter app (Clerk, Auth0,
// Okta, ...) runs the login, so the Worker holds no identity-provider secret.
//
//   client ──/authorize──▶ consent page ──Allow──▶ Alter sign-in (popup)
//                          the popup comes back to /authorize/return with a
//                          one-time code, which the Worker redeems only for
//                          the browser that started the sign-in
//          ◀──code──────── the page polls until that has happened; the
//                          Worker checks ALLOWED_USERS, asks Alter for THIS
//                          person's own connection delegated to the agent
//                          (offering to connect one if there is none), and
//                          issues the client a token bound to that connection
//
// The sign-in is bound to the browser that started it. Alter sends the
// one-time code to this Worker's own return address, in the browser that
// signed in, and the Worker redeems it only when that browser also holds the
// cookie set with the sign-in page. A sign-in link forwarded to someone else
// therefore gives the sender nothing: the other person's browser has no
// cookie, and the sender's browser never receives the code.
//
// Every tool call then runs through the signed-in person's own connection,
// under the policies set in Alter on the agent and on that person, and is
// audited as them. Nobody can reach another person's account: the
// connection is found with the person's identity-provider token, which Alter
// verifies, and pinned to the client's token.
//
// Credentials, never mixed: the client's token for this Worker (issued here,
// stored hashed in KV), ALTER_SIGNIN_KEY (an Alter app key that runs sign-ins
// and starts connections), and the agent key the tools use.
//
// Only the type of the OAuth library is imported here, so this module runs
// under Node for tests; each src/worker.ts constructs the provider.

import type {
  AuthRequest,
  ConsentDescription,
  OAuthHelpers,
  OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { Agent, App } from "@alter-ai/alter-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

export const MCP_PATH = "/mcp";
const AUTHORIZE_PATH = "/authorize";
const WAIT_PATH = "/authorize/wait";
/**
 * Where Alter sends the browser after the identity provider's login. The full
 * URL (the Worker's origin plus this path) must be registered on the Alter app
 * as a sign-in return URL.
 */
export const RETURN_PATH = "/authorize/return";
/** The per-sign-in cookie that proves which browser started it; the sign-in's id is appended. */
const BINDING_COOKIE = "__Host-alter-signin";
/** How long one poll waits before answering "still pending". */
const POLL_WINDOW_MS = 20_000;
const CONNECT_CHECK_INTERVAL_MS = 2_500;
const SIGNIN_CHECK_INTERVAL_MS = 1_500;
/** How long a person has to finish signing in and connecting. */
const PENDING_TTL_SECONDS = 900;

/** The slice of a Workers KV namespace this module uses. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface HostedEnv {
  OAUTH_KV: KvLike;
  /** Injected by the OAuth library into the default handler's env. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** The agent's key; the tools act as this agent. */
  ALTER_AGENT_API_KEY: string;
  /** Alter app key with idp_users:read, idp_users:write, connect:initiate and grants:write. */
  ALTER_SIGNIN_KEY: string;
  /** Who may sign in: user ids, emails, @domains, or * for anyone the identity provider signs in. */
  ALLOWED_USERS: string;
}

/** What the client's token carries: who signed in and which of their connections the tools use. */
export interface HostedProps {
  userId: string;
  email?: string;
  grantId: string;
}

export interface SignedInUser {
  sub: string;
  email?: string;
  name?: string;
}

export type RedeemResult =
  | { status: "completed"; user: SignedInUser; userToken: string }
  | { status: "failed"; message: string };

/**
 * Alter's redirect sign-in: start a session, send the browser to `authUrl`,
 * and redeem the one-time code Alter returns to `returnUrl`. The caller must
 * redeem only for the browser that started the sign-in.
 */
export interface SignIn {
  /** Throws SignInStartError, with a message fit to show, when no bound sign-in can be started. */
  start(options: { returnUrl: string; state: string }): Promise<{ authUrl: string; sessionToken: string; expiresIn: number }>;
  redeem(sessionToken: string, code: string): Promise<RedeemResult>;
  close(): Promise<void>;
}

/** A sign-in could not be started; `message` is shown to the person. */
export class SignInStartError extends Error {
  override name = "SignInStartError";
}

/** The signed-in person's own connection to the provider, delegated to this server's agent. */
export interface Access {
  /** The person's active delegated connection, found with their identity-provider token, or null. */
  find(userToken: string): Promise<{ grantId: string } | null>;
  /** A Connect link that connects the person's account and delegates it to the agent. */
  connect(userToken: string): Promise<string>;
  close(): Promise<void>;
}

export interface HostedDeps {
  signIn(env: HostedEnv): SignIn;
  access(env: HostedEnv): Access;
  /** Overridable for tests. */
  pollWindowMs?: number;
}

/**
 * The redirect sign-in calls of the Alter SDK, typed here because the SDK
 * release that declares them is not published yet. Once it is, delete this
 * interface and the cast in alterSignIn, and call `app` directly.
 */
interface RedirectSignInApp {
  createAuthSession(options: {
    mode: "redirect";
    returnUrl: string;
    state: string;
  }): Promise<{ authUrl: string; sessionToken: string; expiresIn: number; mode?: string }>;
  redeemAuthSession(sessionToken: string, code: string): Promise<{ userToken: string; userInfo: Record<string, unknown> }>;
}

export function alterSignIn(apiKey: string): SignIn {
  const app = new App({ apiKey });
  const redirect = app as unknown as RedirectSignInApp;
  return {
    async start({ returnUrl, state }) {
      let session: Awaited<ReturnType<RedirectSignInApp["createAuthSession"]>>;
      try {
        session = await redirect.createAuthSession({ mode: "redirect", returnUrl, state });
      } catch (error) {
        // Alter refuses a return URL that is not registered on the app (signin_return_url_not_allowed).
        if (error instanceof Error && /signin_return_url_not_allowed/.test(`${error.message} ${JSON.stringify((error as { details?: unknown }).details ?? "")}`)) {
          throw new SignInStartError(`This server is not set up for sign-in yet: its operator must add ${returnUrl} to the Alter app's sign-in return URLs.`);
        }
        throw new SignInStartError("The sign-in could not be started. Try again from your MCP client.");
      }
      // Anything but a redirect session could be finished by whoever holds its link, so refuse it.
      // An SDK older than the redirect sign-in ignores the options above and lands here.
      if (session.mode !== "redirect") {
        throw new SignInStartError("This server cannot start a sign-in bound to this browser. Its operator must update it.");
      }
      return { authUrl: session.authUrl, sessionToken: session.sessionToken, expiresIn: session.expiresIn };
    },
    async redeem(sessionToken, code) {
      try {
        const result = await redirect.redeemAuthSession(sessionToken, code);
        const info = result.userInfo;
        const sub = typeof info.sub === "string" ? info.sub : "";
        if (!sub) return { status: "failed", message: "The identity provider did not return a user id." };
        return {
          status: "completed",
          userToken: result.userToken,
          user: {
            sub,
            ...(typeof info.email === "string" ? { email: info.email } : {}),
            ...(typeof info.name === "string" ? { name: info.name } : {}),
          },
        };
      } catch {
        // The code is single use and short-lived, and Alter burns it on the first attempt.
        return { status: "failed", message: SIGNIN_FAILED };
      }
    },
    close: () => app.close(),
  };
}

export function alterAccess(env: Pick<HostedEnv, "ALTER_AGENT_API_KEY" | "ALTER_SIGNIN_KEY">, provider: string): Access {
  const agent = new Agent({ apiKey: env.ALTER_AGENT_API_KEY });
  let app: App | undefined;
  return {
    async find(userToken) {
      // endUserToken scopes the agent's delegated connections to this person; Alter verifies the token.
      const page = await agent.listGrants({ providerId: provider, status: "active", endUserToken: userToken });
      const mine = page.grants
        .filter((grant) => grant.grantKind === "oauth" && grant.accessVia === "oauth_delegation")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return mine[0] ? { grantId: mine[0].grantId } : null;
    },
    async connect(userToken) {
      const self = await agent.me();
      app ??= new App({ apiKey: env.ALTER_SIGNIN_KEY });
      const session = await app.createConnectSession({ allowedProviders: [provider], agent: self.id, userToken });
      return session.connectUrl;
    },
    async close() {
      await agent.close();
      await app?.close();
    },
  };
}

/** ALLOWED_USERS: user ids, emails, "@example.com" for a whole email domain, or "*" for anyone the identity provider signs in. */
export function parseAllowedUsers(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowed(user: SignedInUser, allowed: Set<string>): boolean {
  if (allowed.has("*")) return true;
  if (allowed.has(user.sub.toLowerCase())) return true;
  const email = user.email?.toLowerCase();
  if (!email) return false;
  return allowed.has(email) || allowed.has(email.slice(email.lastIndexOf("@")));
}

// ── The pending sign-in, between the Allow click and the last poll ──────────
// Keyed and encrypted by the upstream `state`, which this browser holds and
// Alter echoes back to the return address: reading KV alone reveals neither
// Alter's session token nor the person's identity-provider token.

const SIGNIN_FAILED = "The sign-in failed or expired. Start again from your MCP client.";

type Pending =
  /** Waiting for the popup to come back; `bindingHash` is the SHA-256 of the starting browser's cookie value. */
  | { stage: "signin"; sessionToken: string; bindingHash: string }
  /** The return address redeemed the code for the starting browser. */
  | { stage: "signedin"; userToken: string; user: SignedInUser }
  /** The return address was told the sign-in failed, by the starting browser. */
  | { stage: "failed"; message: string }
  | { stage: "connect"; userToken: string; user: SignedInUser; connectUrl: string };

const encoder = new TextEncoder();

function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(text));
}

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

async function pendingKey(state: string): Promise<string> {
  return `alter-signin:${hex(await sha256(`kv:${state}`))}`;
}

async function cipherKey(state: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await sha256(`key:${state}`), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function savePending(kv: KvLike, state: string, pending: Pending, ttlSeconds = PENDING_TTL_SECONDS): Promise<void> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cipherKey(state), encoder.encode(JSON.stringify(pending))),
  );
  const value = btoa(String.fromCharCode(...iv, ...sealed));
  await kv.put(await pendingKey(state), value, { expirationTtl: Math.max(60, Math.min(ttlSeconds, PENDING_TTL_SECONDS)) });
}

export async function loadPending(kv: KvLike, state: string): Promise<Pending | null> {
  const value = await kv.get(await pendingKey(state));
  if (!value) return null;
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await cipherKey(state), bytes.slice(12));
    return JSON.parse(new TextDecoder().decode(plain)) as Pending;
  } catch {
    return null;
  }
}

export async function deletePending(kv: KvLike, state: string): Promise<void> {
  await kv.delete(await pendingKey(state));
}

// ── The binding cookie: which browser started this sign-in ──────────────────
// The OAuth library binds its upstream `state` to the browser with a cookie of
// its own, but checks it only inside finishUpstream(), which also consumes the
// state. The return address has to check the browser first and keep the state
// for the last poll, so the Worker sets its own cookie beside the library's: a
// random value only this browser receives, whose hash is kept in the pending
// record. One cookie per sign-in, so two tabs do not replace each other's.

async function bindingCookieName(state: string): Promise<string> {
  return `${BINDING_COOKIE}-${hex(await sha256(`cookie:${state}`)).slice(0, 16)}`;
}

const bindingHash = async (value: string) => hex(await sha256(`binding:${value}`));

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator !== -1 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return undefined;
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

/** Whether this request comes from the browser that started the sign-in `state` names. */
async function startedInThisBrowser(request: Request, state: string, expectedHash: string): Promise<boolean> {
  const value = readCookie(request, await bindingCookieName(state));
  return Boolean(value) && sameText(await bindingHash(value as string), expectedHash);
}

// ── Pages ───────────────────────────────────────────────────────────────────

export interface HostedUi {
  /** e.g. "Alter Gmail MCP" */
  title: string;
  /** What each person connects, e.g. "Gmail" */
  accountName: string;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const STYLE = `body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#111}
h1{font-size:1.4rem}button{font:inherit;padding:.5rem 1.1rem;margin-right:.5rem;border-radius:6px;border:1px solid #111;cursor:pointer}
button.primary{background:#111;color:#fff}.note{color:#555;font-size:.9rem}.warn{background:#fff4e5;padding:.6rem .8rem;border-radius:6px}`;

function page(title: string, body: string, nonce?: string, script?: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style><body>${body}${script && nonce ? `<script nonce="${nonce}">${script}</script>` : ""}</body></html>`;
}

function html(body: string, status: number, headers: Headers, nonce?: string): Response {
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'unsafe-inline'; ${nonce ? `script-src 'nonce-${nonce}'; connect-src 'self'; ` : ""}frame-ancestors 'none'; base-uri 'none'`,
  );
  headers.set("X-Frame-Options", "DENY");
  // The return address carries a one-time code in its URL.
  headers.set("Referrer-Policy", "no-referrer");
  return new Response(body, { status, headers });
}

export function consentPage(ui: HostedUi, details: ConsentDescription, handle: string): string {
  const client = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  const loopback = details.redirectIsLoopback
    ? `<p class="warn"><strong>Access goes to an app on this computer.</strong> Continue only if you just started connecting from it.</p>`
    : "";
  return page(
    `Connect ${client}`,
    `<h1>Allow ${client} to use ${escapeHtml(ui.title)} as you?</h1>
<p>${origin} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>${loopback}
<p>Next you sign in with your account. ${escapeHtml(ui.title)} then works with your own ${escapeHtml(ui.accountName)}, within the policies set in Alter.</p>
<form method="post" action="${AUTHORIZE_PATH}"><input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button class="primary" name="decision" value="approve">Allow and sign in</button><button name="decision" value="deny">Deny</button></form>`,
  );
}

export function signInPage(ui: HostedUi, state: string, authUrl: string, nonce: string): string {
  const script = `const state=${JSON.stringify(state)},authUrl=${JSON.stringify(authUrl)};
const status=document.getElementById("status"),connect=document.getElementById("connect");let connectUrl="";
const popup=(url)=>{if(!window.open(url,"alter","popup,width=520,height=720"))location.href=url;};
document.getElementById("go").addEventListener("click",()=>popup(authUrl));
document.getElementById("connect-go").addEventListener("click",()=>popup(connectUrl));
async function wait(){for(;;){let r;try{r=await fetch(${JSON.stringify(WAIT_PATH)}+"?state="+encodeURIComponent(state),{credentials:"same-origin"});}catch{await new Promise(s=>setTimeout(s,2000));continue;}
const d=await r.json().catch(()=>({}));
if(r.status===202){if(d.status==="connect"&&d.connectUrl&&!connectUrl){connectUrl=d.connectUrl;connect.hidden=false;status.textContent="Signed in.";}continue;}
if(r.ok&&d.redirectTo){status.textContent="Done. Returning to your app…";location.replace(d.redirectTo);return;}
status.textContent=d.error||"Sign-in failed. Start again from your MCP client.";connect.hidden=true;return;}}
wait();`;
  const name = escapeHtml(ui.accountName);
  return page(
    `Sign in to ${ui.title}`,
    `<h1>Sign in to ${escapeHtml(ui.title)}</h1>
<p>Sign in with your account in the window that opens. This page continues on its own when you are done.</p>
<p><button class="primary" id="go">Sign in</button></p>
<div id="connect" hidden><h2>Connect your ${name}</h2><p>One more step: connect your own ${name}. Alter stores the credential and this server never sees it; every request is checked against the policies set in Alter and recorded.</p>
<p><button class="primary" id="connect-go">Connect ${name}</button></p></div>
<p id="status" role="status"></p>
<p class="note">Only sign in from this page. The sign-in finishes only in the browser that started it. Never complete a sign-in or connect link someone sent you.</p>`,
    nonce,
    script,
  );
}

/** What the popup shows once it is back from the identity provider; it closes itself where the browser allows. */
export function returnPage(heading: string, message: string, nonce: string): string {
  return page(heading, `<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p>`, nonce, "window.close();");
}

function errorPage(message: string, status = 400, headers = new Headers()): Response {
  return html(page("Cannot connect", `<h1>Cannot connect</h1><p>${escapeHtml(message)}</p>`), status, headers);
}

const json = (body: unknown, status: number, headers = new Headers()) => {
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── The default handler: /authorize and the sign-in poll ────────────────────

function isAuthorizationError(error: unknown): error is Error & { redirectTo?: string; description?: string } {
  return error instanceof Error && error.name === "AuthorizationError";
}

export async function handleAuthorize(request: Request, env: HostedEnv, ui: HostedUi, deps: HostedDeps): Promise<Response> {
  const url = new URL(request.url);
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (url.pathname === AUTHORIZE_PATH && request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return html(consentPage(ui, details, consent.handle), 200, consent.headers);
    }

    if (url.pathname === AUTHORIZE_PATH && request.method === "POST") {
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle);
      const upstream = await oauth.beginUpstream(approved.request, { headers: approved.headers });
      const signIn = deps.signIn(env);
      try {
        const session = await signIn.start({ returnUrl: `${url.origin}${RETURN_PATH}`, state: upstream.state });
        // Only this response, so only this browser, ever carries the binding value; KV keeps its hash.
        const binding = hex(crypto.getRandomValues(new Uint8Array(32)));
        await savePending(env.OAUTH_KV, upstream.state, {
          stage: "signin",
          sessionToken: session.sessionToken,
          bindingHash: await bindingHash(binding),
        });
        upstream.headers.append(
          "Set-Cookie",
          `${await bindingCookieName(upstream.state)}=${binding}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${PENDING_TTL_SECONDS}`,
        );
        const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
        return html(signInPage(ui, upstream.state, session.authUrl, nonce), 200, upstream.headers, nonce);
      } finally {
        await signIn.close();
      }
    }

    if (url.pathname === RETURN_PATH && request.method === "GET") {
      return await signInReturn(request, url, env, deps);
    }

    if (url.pathname === WAIT_PATH && request.method === "GET") {
      return await poll(request, url.searchParams.get("state") ?? "", env, deps);
    }

    return new Response("Not found", { status: 404 });
  } catch (error) {
    if (isAuthorizationError(error)) {
      if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
      if (url.pathname === WAIT_PATH) return json({ error: error.description ?? error.message }, 400);
      return errorPage(error.description ?? error.message);
    }
    if (error instanceof Error && error.name === "CimdFetchError") return errorPage("This app could not be verified.");
    if (error instanceof SignInStartError) return errorPage(error.message, 502);
    throw error;
  }
}

/**
 * The popup, back from the identity provider with Alter's one-time `code` (or
 * an `error`) and the `state` this Worker chose. Nothing is redeemed, and the
 * pending sign-in is left untouched, unless this browser holds the binding
 * cookie set with the sign-in page: a person who was sent someone else's
 * sign-in link arrives here without it.
 */
async function signInReturn(request: Request, url: URL, env: HostedEnv, deps: HostedDeps): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const pending = state ? await loadPending(env.OAUTH_KV, state) : null;
  if (!pending) return errorPage("This sign-in expired. Start again from your MCP client.", 410);
  if (pending.stage !== "signin") return errorPage("This sign-in was already completed. Go back to the page where you started.", 409);
  if (!(await startedInThisBrowser(request, state, pending.bindingHash))) {
    return errorPage(
      "This sign-in was not started in this browser, so it was not completed and nobody was given access. If someone sent you this link, do not try again. To connect your own app, start from your MCP client.",
      403,
    );
  }

  // From here on the request is the starting browser's. Its cookie has done its work.
  const headers = new Headers({ "Set-Cookie": `${await bindingCookieName(state)}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` });
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const failed = async (message: string): Promise<Response> => {
    // A second request racing a successful one must not undo it.
    if ((await loadPending(env.OAUTH_KV, state))?.stage === "signin") await savePending(env.OAUTH_KV, state, { stage: "failed", message });
    return html(returnPage("Sign-in failed", "Close this window and start again from your MCP client.", nonce), 400, headers, nonce);
  };

  const code = url.searchParams.get("code") ?? "";
  if (url.searchParams.get("error") || !code) return failed(SIGNIN_FAILED);

  const signIn = deps.signIn(env);
  let result: RedeemResult;
  try {
    result = await signIn.redeem(pending.sessionToken, code);
  } finally {
    await signIn.close();
  }
  if (result.status === "failed") return failed(result.message);
  await savePending(env.OAUTH_KV, state, { stage: "signedin", userToken: result.userToken, user: result.user });
  return html(returnPage("Signed in", "You can close this window and go back to the page where you started.", nonce), 200, headers, nonce);
}

async function poll(request: Request, state: string, env: HostedEnv, deps: HostedDeps): Promise<Response> {
  const pending = state ? await loadPending(env.OAUTH_KV, state) : null;
  if (!pending) return json({ error: "This sign-in expired. Start again from your MCP client." }, 410);
  const oauth = env.OAUTH_PROVIDER;

  /** Ends the flow: consumes the state (refused unless this browser holds its binding cookie). */
  const finish = async (user: SignedInUser, grantId: string): Promise<Response> => {
    await deletePending(env.OAUTH_KV, state);
    const resumed = await oauth.finishUpstream(request);
    const original: AuthRequest = resumed.request;
    const props: HostedProps = { userId: user.sub, ...(user.email ? { email: user.email } : {}), grantId };
    const { redirectTo } = await oauth.completeAuthorization({ request: original, userId: user.sub, metadata: {}, scope: original.scope, props });
    return json({ redirectTo }, 200, resumed.headers);
  };
  const refuse = async (status: number, message: string): Promise<Response> => {
    await deletePending(env.OAUTH_KV, state);
    const resumed = await oauth.finishUpstream(request);
    return json({ error: message }, status, resumed.headers);
  };

  const deadline = Date.now() + (deps.pollWindowMs ?? POLL_WINDOW_MS);
  const access = deps.access(env);
  try {
    // stage "signin": wait for the return address to store who signed in. Alter is
    // never asked here: only the return address, in the starting browser, redeems.
    let current: Pending = pending;
    while (current.stage === "signin") {
      if (Date.now() + SIGNIN_CHECK_INTERVAL_MS > deadline) return json({ status: "pending" }, 202);
      await sleep(SIGNIN_CHECK_INTERVAL_MS);
      const reloaded = await loadPending(env.OAUTH_KV, state);
      if (!reloaded) return json({ error: "This sign-in expired. Start again from your MCP client." }, 410);
      current = reloaded;
    }
    if (current.stage === "failed") {
      await deletePending(env.OAUTH_KV, state);
      return json({ error: current.message }, 400);
    }
    if (current.stage === "signedin") {
      if (!isAllowed(current.user, parseAllowedUsers(env.ALLOWED_USERS))) return refuse(403, "This account may not use this server.");
      const found = await access.find(current.userToken);
      if (found) return finish(current.user, found.grantId);
      const connectUrl = await access.connect(current.userToken);
      await savePending(env.OAUTH_KV, state, { stage: "connect", userToken: current.userToken, user: current.user, connectUrl });
      return json({ status: "connect", connectUrl }, 202);
    }
    const connecting = current;

    // stage "connect": wait for the person's new connection to appear.
    for (;;) {
      let found: { grantId: string } | null;
      try {
        found = await access.find(connecting.userToken);
      } catch {
        // Typically the identity-provider token expired while connecting.
        return refuse(400, "The sign-in expired before the connection finished. Start again from your MCP client.");
      }
      if (found) return finish(connecting.user, found.grantId);
      if (Date.now() + CONNECT_CHECK_INTERVAL_MS > deadline) break;
      await sleep(CONNECT_CHECK_INTERVAL_MS);
    }
    return json({ status: "connect", connectUrl: connecting.connectUrl }, 202);
  } finally {
    await access.close();
  }
}

// ── The MCP endpoint ────────────────────────────────────────────────────────

/** Stateless Streamable HTTP: every request gets a fresh server, so the Worker keeps no session. */
export async function serveMcp(request: Request, made: { server: McpServer; close?: () => Promise<void> }): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await made.server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await made.server.close().catch(() => undefined);
    await made.close?.().catch(() => undefined);
  }
}

/** A token issued before connections were pinned (or otherwise without one): make the client sign in again. */
function reauthenticate(request: Request): Response {
  const origin = new URL(request.url).origin;
  return new Response(JSON.stringify({ error: "invalid_token", error_description: "Sign in again to connect your account." }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource${MCP_PATH}"`,
    },
  });
}

// ── The Worker ──────────────────────────────────────────────────────────────

export interface HostedConfig<E> extends HostedUi {
  /** The OAuth provider id in Alter, e.g. "google". */
  provider: string;
  /** A server whose tools act through the signed-in person's connection `grantId`. */
  makeServer(env: E, grantId: string): { server: McpServer; close?: () => Promise<void> };
}

interface Fetcher<E> {
  fetch(request: Request, env: E, ctx: unknown): Response | Promise<Response>;
}

type WorkerEnv = Omit<HostedEnv, "OAUTH_PROVIDER">;

export function providerOptions<E extends WorkerEnv>(origin: string, config: HostedConfig<E>, deps?: HostedDeps): OAuthProviderOptions<E> {
  const resolved: HostedDeps = deps ?? {
    signIn: (env) => alterSignIn(env.ALTER_SIGNIN_KEY),
    access: (env) => alterAccess(env, config.provider),
  };
  return {
    apiRoute: MCP_PATH,
    apiHandler: {
      fetch: (request: Request, env: E, ctx: { props?: Partial<HostedProps> }) => {
        const grantId = ctx.props?.grantId;
        if (!grantId) return reauthenticate(request);
        return serveMcp(request, config.makeServer(env, grantId));
      },
    },
    defaultHandler: {
      fetch: (request: Request, env: E) =>
        handleAuthorize(request, env as unknown as HostedEnv, { title: config.title, accountName: config.accountName }, resolved),
    },
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: { resource: `${origin}${MCP_PATH}`, authorization_servers: [origin] },
  } as OAuthProviderOptions<E>;
}

/**
 * The Worker's fetch handler. The provider is built on first use per origin,
 * so the resource URL is the address the Worker is reached at, with nothing to
 * configure.
 */
export function hostedWorker<E extends WorkerEnv>(
  createProvider: (options: OAuthProviderOptions<E>) => Fetcher<E>,
  config: HostedConfig<E>,
): Fetcher<E> {
  const providers = new Map<string, Fetcher<E>>();
  return {
    fetch(request, env, ctx) {
      const origin = new URL(request.url).origin;
      let provider = providers.get(origin);
      if (!provider) {
        provider = createProvider(providerOptions(origin, config));
        providers.set(origin, provider);
      }
      return provider.fetch(request, env, ctx);
    },
  };
}
