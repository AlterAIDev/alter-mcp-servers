# Alter MCP servers

Open-source MCP servers for AI agents where **the server never holds the provider token** and risky actions **wait for a person's approval**. Each server holds only an [Alter](https://alterauth.com) agent key. Alter stores the provider credential, adds it to each request, enforces the policies set on the agent, holds what needs approval, and records every call.

| Server | Package | What it does |
|---|---|---|
| [Gmail](packages/gmail-mcp) | `@alter-ai/gmail-mcp` | Search, read, draft and send email; sends held for approval |
| [LinkedIn](packages/linkedin-mcp) | `@alter-ai/linkedin-mcp` | Post, comment and react through LinkedIn's official API only; posts held for approval |

Run each server locally over stdio (`npx`), or host it as a multi-user Cloudflare Worker: everyone in your organization signs in through your Alter app's identity provider and works with their own account, under your Alter policies (see each package's "Host on Cloudflare").

[`slack-approvals`](packages/slack-approvals) is a companion Cloudflare Worker: it posts each held request to a Slack channel, showing exactly what Alter will send, with Approve and Deny buttons.

## Why build an MCP server this way

- **No token on the machine running the agent.** A leaked agent key reaches only what its policies allow, and you can revoke it in one place.
- **Approvals the AI client cannot skip.** Alter holds a matching request on its side and runs exactly what the approver saw, once. A prompt or a misbehaving client cannot route around it.
- **Rules per operation, not per tool.** Alter classifies each provider operation (read, write, send, delete, payment, admin), so one rule such as "approve every send" or "block every delete" covers every tool that reaches it.
- **An audit trail.** Every call, approval and denial is recorded with the agent and the tool.
- **Official APIs only.** No browser automation or scraping.

## How it works

```
AI client  ──MCP──▶  @alter-ai/gmail-mcp  ──agent key──▶  Alter  ──Google token──▶  Gmail API
                     (holds no token)                     policy, approvals, audit
```

Each package README covers its setup: an Alter app, the provider, an agent, connecting your account, the recommended policies, and your MCP client's config.

## How sign-in works on a hosted server

A hosted server uses the MCP standard's own authorization flow ([OAuth 2.1, as the MCP specification defines it](https://modelcontextprotocol.io/specification/draft/basic/authorization)). It is not tied to any one client: Claude (web, desktop and Claude Code) and other MCP clients that support remote servers with OAuth sign in the same way. Clients register themselves, through Dynamic Client Registration or a Client ID Metadata Document, so there is nothing to set up per client.

The server is the sign-in service the client talks to, but it does not run the login. It hands that to Alter, which uses the identity provider configured on your Alter app (Clerk, Auth0, Okta, WorkOS or any OIDC provider).

```
MCP client ──opens in your browser──▶ MCP server: consent page
                                        "Allow <client> to use <server> as you?"
                                              │ Allow and sign in
                                              ▼
                                      Alter sign-in ──▶ your identity provider's login page
                                              │
                                      MCP server: checks ALLOWED_USERS, finds YOUR own
                                      connection through Alter (or offers to connect one)
                                              │
MCP client ◀──one-time code─────────── your browser returns to the client
MCP client ──code──▶ MCP server ──▶ an access token for this server, bound to that connection
```

**Who sees what**

| | The MCP client (Claude or another) | The MCP server | Alter | Your identity provider |
|---|---|---|---|---|
| The consent and sign-in pages | No: they go to your browser | Serves them | Runs the sign-in | Shows the login |
| Your password | No | No | No | Yes |
| Your identity-provider token | No | Briefly, to find your connection; kept encrypted only until sign-in finishes | Verifies it | Issues it |
| An access token for this server | Yes, and it works nowhere else | Issues it; stores only a hash | No | No |
| Your Gmail or LinkedIn credential | No | No | Holds it and adds it to each request | No |

The AI model never takes part in sign-in. It sees only the tools and what they return.

**Where the one-time code goes.** A web client receives it at its own callback address; the consent page shows that host, for example `claude.ai`. A local client such as Claude Code receives it on your computer at a `localhost` address, and the consent page warns that access is going to an app on this computer, so continue only if you just started connecting from it.

**After sign-in.** The client sends its access token with every tool call. The server checks it, acts through the one connection the token is bound to, and Alter applies your policies and records the call. Access tokens last an hour and the client refreshes them; you sign in again after 30 days, or after you reconnect your account in Alter.

**One caution.** Alter's sign-in is link-based: whoever started a sign-in gets its result. Start sign-ins only from your MCP client, and never finish a sign-in link someone sends you.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test     # also checks that every server's src/alter.ts and src/hosted.ts are identical
pnpm build
```

Node 20 or later. Tests use Node's built-in test runner against a fake Alter client.

## Security

See [SECURITY.md](SECURITY.md). Report vulnerabilities privately, never in a public issue.

## License

[MIT](LICENSE)
