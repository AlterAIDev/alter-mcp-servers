# Notion MCP server with policy and approvals (`@alter-ai/notion-mcp`)

A Notion MCP server for AI agents that searches, reads pages as Markdown, queries databases, creates and adds to pages, and comments, where the server never holds a Notion token. It is backed by [Alter](https://alterauth.com): Alter stores the Notion credential, adds it to each request, enforces the policies you set on the agent, and records every call.

## Tools

| Tool | What it does | With the recommended policy |
|---|---|---|
| `search` | Finds pages and databases shared with the connection, by title | Allowed |
| `read_page` | A page's content as Markdown (long pages are cut) | Allowed |
| `query_database` | Rows of a database with their filled properties; takes Notion's `filter` and `sorts` | Allowed |
| `create_page` | A page under another page, or a row in a database, with optional Markdown content | Allowed, or held if you hold sends (see Policies) |
| `append_to_page` | Adds Markdown to the end of a page, silently; nothing on the page is changed or removed | Allowed |
| `add_comment` | Comments on a page | Allowed, or held if you hold sends |
| `check_approval` | Reports what happened to a held request | Allowed |

Deleting is not a tool, and the recommended policy also blocks Notion's delete operations (trashing pages and blocks, erasing content) for the agent.

## What the agent can reach

Notion takes no OAuth scopes. What a connection can do is set by the capabilities you choose on the Notion connection (read, update and insert content, read and insert comments), and the person who connects picks which pages and databases to share. The agent sees only those. Alter's policies then decide what it may do with them.

## Set up

You need an Alter account and the [`alter` CLI](https://docs.alterauth.com/reference/cli), version 0.10 or later. Replace `<app-id>` and `<agent-id>` below. Every step can also be done in the [Alter portal](https://portal.alterauth.com).

**1. An Alter app with an identity provider** (Auth0, Clerk, Okta, WorkOS or another OIDC provider), so you can delegate your Notion to an agent. See [identity providers](https://docs.alterauth.com/admin/identity-provider).

**2. Notion as a provider.** In the [Notion developer portal](https://app.notion.com/developers), create a public connection, add Alter's redirect URI, choose its capabilities (for these tools: read content, update content, insert content, read comments, insert comments), and copy the OAuth client ID and secret into your Alter app. See [Notion provider setup](https://docs.alterauth.com/reference/oauth-providers/notion).

**3. An agent.** Because Notion grants carry no scopes, the agent's Notion entry needs only one placeholder value. The key is printed once, in the `api_key` field:

```bash
alter agents create --app <app-id> --name notion-agent \
  --scopes '{"notion":["notion"]}' --output json | jq -r '.api_key'
```

**4. Connect your Notion and delegate it to the agent.** `ALTER_API_KEY` is the app's runtime key and `USER_JWT` is your own token from the app's identity provider. Open the `connect_url` from the output, pick the pages to share, and approve:

```bash
alter connect create --provider notion --user-token "$USER_JWT" --agent notion-agent --output json
```

**5. Policies.** Block deletes:

```bash
echo '{"when": {"family": ["delete"]}, "effect": "deny"}' | \
  alter policy rules create --app <app-id> --agent <agent-id> --body - --name "No deletes"
```

Notion treats creating a page and commenting as operations that can notify people, so Alter classifies them as `send`. To review each one before it happens, also hold sends; every new page and comment then waits for approval, while reads and `append_to_page` do not:

```bash
echo '{"effect": "require_approval", "when": {"match": {"families": ["send"]}}, "approval": {"approvers": ["you@example.com"], "channels": ["email"], "expires_in_seconds": 86400}}' | \
  alter policy rules create --app <app-id> --agent <agent-id> --type require_approval --body - --name "Approve new pages and comments"
```

**6. Your MCP client.**

Claude Code:

```bash
claude mcp add notion --env ALTER_AGENT_API_KEY=<agent key> -- npx -y @alter-ai/notion-mcp
```

Other clients (`mcpServers` in the client's config file):

```json
{
  "mcpServers": {
    "notion": {
      "command": "npx",
      "args": ["-y", "@alter-ai/notion-mcp"],
      "env": { "ALTER_AGENT_API_KEY": "<agent key>" }
    }
  }
}
```

Until the first npm release, build from source (`pnpm install && pnpm build` at the repository root) and use `node packages/notion-mcp/dist/index.js` as the command.

## Host on Cloudflare (remote, multi-user MCP)

Run the server as a Cloudflare Worker so claude.ai, Claude Code and other clients connect to it over HTTPS, and scheduled agents can use it while your computer is off. Hosted, the server is **multi-user**: everyone in your organization signs in with the identity provider already configured on your Alter app (Clerk, Auth0, Okta, WorkOS or another OIDC provider), and each person's requests go through **their own Notion**, under the policies set in Alter, recorded as them. The Worker holds no identity-provider secret and no Notion credential.

What happens when someone connects a client:

1. The client registers itself and opens the Worker's consent page, which names the client and where its access will go.
2. They choose **Allow and sign in**. A window opens with your app's sign-in page, through Alter.
3. The Worker checks they are on `ALLOWED_USERS`, then asks Alter, with their identity-provider token, for their own Notion connection delegated to this server's agent. If they have none yet, the page offers **Connect Notion**: they connect it once through Alter Connect, delegated to the agent.
4. The client gets a token for this server bound to that one connection. Every tool call uses it, so nobody can reach another person's Notion. Tokens are stored hashed in Workers KV.

This is the MCP standard's authorization flow, so it works the same in any MCP client that supports remote servers, not only Claude. [How sign-in works](https://github.com/AlterAIDev/alter-mcp-servers#how-sign-in-works-on-a-hosted-server) shows each step and what the client, the server, Alter and your identity provider each see: the client never sees your password, your identity-provider token or the provider credential.

One agent serves everyone: its rules (for example "approve every send") apply to all of them, and each person's own rules in Alter apply on top.

**1. An Alter app key for sign-in and connecting** (separate from the agent key). The key is printed once, in the `plain_key` field:

```bash
alter keys mint --app <app-id> --name mcp-hosted \
  --scopes idp_users:read,idp_users:write,connect:initiate,grants:write --output json | jq -r '.plain_key'
```

**2. Deploy** from `packages/notion-mcp`, then set the secrets. The first deploy creates the Worker's KV namespace.

```bash
npx wrangler deploy
npx wrangler secret put ALTER_AGENT_API_KEY
npx wrangler secret put ALTER_SIGNIN_KEY
npx wrangler secret put ALLOWED_USERS
```

`ALLOWED_USERS` is a comma-separated list of identity-provider user ids, emails, whole email domains (`@example.com`), or `*` for anyone your identity provider signs in. Prefer user ids, or a domain your provider verifies, when people can sign up with an email they have not verified. `ALTER_ACCOUNT` and `ALTER_GRANT_ID` do not apply, since each person's connection is chosen at sign-in.

**3. Connect a client** to `https://alter-notion-mcp.<your-subdomain>.workers.dev/mcp` and sign in when asked:

- claude.ai and Claude Desktop: **Settings**, **Connectors**, **Add custom connector**.
- Claude Code: `claude mcp add --transport http notion https://alter-notion-mcp.<your-subdomain>.workers.dev/mcp`, then `/mcp` to sign in.
- Any other MCP client that supports remote servers with OAuth: add the URL as a remote (HTTP) server.

If someone reconnects their Notion in Alter later, their client's next call is refused until they sign in again, which picks up the new connection.

Start sign-ins only from your MCP client, and never complete a sign-in link someone sends you: Alter's sign-in is link-based, so whoever started the sign-in gets the access.

To approve held requests from Slack instead of the Wallet, add [`slack-approvals`](../slack-approvals).

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `ALTER_AGENT_API_KEY` | yes | The agent's key from step 3 |
| `ALTER_ACCOUNT` | no | Which Notion workspace connection to use when more than one is delegated to the agent |
| `ALTER_GRANT_ID` | no | Use this exact grant instead of resolving by provider (not with `ALTER_ACCOUNT`) |

The server uses Notion API version `2026-03-11`, the version Alter's Notion operation catalog is checked against.

## FAQ

**Why does a page come back as "not found"?** Notion answers 404 for pages the connection cannot see. Share the page with the connection in Notion, or reconnect and pick it.

**Can it delete my pages?** Not with the recommended policy: Alter blocks Notion's delete operations for the agent, and no tool asks for one.

**What about instructions hidden in pages?** Page text reaches the model, so a page someone else edited can try to steer it (prompt injection). The tools label page content as untrusted and nothing can be deleted; hold sends if new pages and comments should be reviewed too.

## License

MIT
