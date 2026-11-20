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
