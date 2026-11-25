# Gmail MCP server with approvals (`@alter-ai/gmail-mcp`)

A Gmail MCP server for AI agents that can search, read, draft and **send**, where the server never holds a Google token and every send waits for a person's approval. It is backed by [Alter](https://alterauth.com): Alter stores the Google credential, adds it to each request, enforces the policies you set on the agent, and records every call.

Many Gmail MCP servers keep a Google token on the machine that runs them, and any approval step lives in the AI client. This one keeps the token in Alter and enforces approvals there, so the agent's key alone cannot reach your mailbox beyond what its policies allow.

## Tools

| Tool | What it does | With the recommended policy |
|---|---|---|
| `search_emails` | Searches with Gmail syntax (`from:alex@example.com newer_than:7d`); returns sender, recipients, subject, date, id and snippet | Allowed |
| `read_email` | Reads one message: headers, plain-text body (HTML converted, long bodies cut), attachment names | Allowed |
| `create_draft` | Writes a draft from your primary address or a verified alias, with that address's signature and any attachments, optionally as a reply in a thread; nothing is sent | Allowed |
| `send_email` | Sends an email from your primary address or a verified alias, with that address's signature and any attachments, optionally as a reply | **Held until you approve it** |
| `check_approval` | Reports what happened to a held request: waiting, done, denied, expired or failed | Allowed |

Deleting mail is not a tool, and the recommended policy also blocks Gmail's delete operations for the agent.

## Sending address, signature and attachments

`from` picks the sending address: the account's primary address (the default) or an alias verified in Gmail (Settings, Accounts, Send mail as). Any other address is refused, and the error lists the ones that work. The message carries that address's display name, and the approver sees the `From` line.

Gmail does not add your signature to mail sent through its API, so the server does: before each send or draft it reads the signature of the sending address from Gmail's send-as settings and adds it directly under the last line of the body (no `-- ` separator), as plain text and as HTML (links and formatting kept), the way Gmail's editor does. The HTML version sets Arial at 14px, so clients do not substitute their own font, and lines starting with `- ` become a spaced list. If the signature cannot be read, nothing is sent; pass `include_signature: false` to go ahead without it. An account with no signature set sends without one, and the tool says so.

`attachments` takes up to 10 files of any type (images, video, PDFs), 5 MB in total: Alter accepts requests up to 10 MB, and an attachment roughly doubles in size inside an email. Each file is an `https` URL anyone can open, or, when the server runs on your computer (`npx`), an absolute file path. A hosted server takes URLs only, and a local one refuses URLs that point at private network addresses. A file you drop into a chat cannot be passed to a remote MCP server, so put it at a URL first. The approver sees each file's name, type, size and source in the agent's reason.

## How a send works

1. The agent calls `send_email`. The request reaches Alter, which matches your approval rule and holds the exact request, encrypted.
2. The tool returns an approval link and an approval id. Nothing has been sent.
3. You open the link in the Alter Wallet (or see the request in Slack, with [`slack-approvals`](../slack-approvals)). It shows the operation and the recipients, sender and subject the policy reads, plus the agent's `reason`.
4. You approve or deny. On approval Alter sends exactly the held request, once, even if the agent has stopped. On denial nothing is sent.
5. The agent (or you) can call `check_approval` with the id to see the outcome.

For first-contact emails where the wording matters most, have the agent use `create_draft` instead and send from Gmail yourself.

## Set up

You need an Alter account and the [`alter` CLI](https://docs.alterauth.com/reference/cli), version 0.10 or later (policy changes need it). Replace `<app-id>` and `<agent-id>` below with your app's and agent's ids. The steps below use the CLI; every step can also be done in the [Alter portal](https://portal.alterauth.com).

**1. An Alter app with an identity provider.** Delegating your Google account to an agent needs your identity, so the app needs an identity provider (Auth0, Clerk, Okta, WorkOS or another OIDC provider). See [identity providers](https://docs.alterauth.com/admin/identity-provider).

**2. Google as a provider.** Add Google to the app with your own Google Cloud OAuth client, requesting these scopes:

- `https://www.googleapis.com/auth/gmail.readonly` (search and read)
- `https://www.googleapis.com/auth/gmail.compose` (drafts and send)

For a Google Workspace domain, set the OAuth consent screen's user type to **Internal**. See [Google provider setup](https://docs.alterauth.com/reference/oauth-providers/google).

**3. An agent.** The key is printed once, in the `api_key` field:

```bash
alter agents create --app <app-id> --name gmail-agent \
  --scopes '{"google":["https://www.googleapis.com/auth/gmail.readonly","https://www.googleapis.com/auth/gmail.compose"]}' \
  --output json | jq -r '.api_key'
```

**4. Connect your Gmail and delegate it to the agent.** `ALTER_API_KEY` is the app's runtime key and `USER_JWT` is your own token from the app's identity provider. Open the `connect_url` from the output in a browser and approve:

```bash
alter connect create --provider google --user-token "$USER_JWT" --agent gmail-agent --output json
```

**5. Policies.** Hold every send for approval for up to 24 hours, and block deletes. With no `approvers` listed, the person who connected the account (you) approves:

```bash
echo '{"effect": "require_approval", "when": {"match": {"families": ["send"]}}, "approval": {"channels": ["email"], "expires_in_seconds": 86400}}' | \
  alter policy rules create --app <app-id> --agent <agent-id> --type require_approval --body - --name "Approve every send"

echo '{"when": {"family": ["delete"]}, "effect": "deny"}' | \
  alter policy rules create --app <app-id> --agent <agent-id> --body - --name "No deletes"
```

Optionally, limit who the agent can email at all:

```bash
echo '{"match": {"families": ["send"]}, "params": [{"name": "recipients", "op": "not_subset_of", "value": ["*@example.com"]}], "effect": "deny"}' | \
  alter policy rules create --app <app-id> --agent <agent-id> --type content_match --body - --name "Only example.com recipients"
```

See [setting policies](https://docs.alterauth.com/guides/set-policies) and [human approvals](https://docs.alterauth.com/guides/add-human-in-the-loop-approvals).

**6. Your MCP client.**

Claude Code:

```bash
claude mcp add gmail --env ALTER_AGENT_API_KEY=<agent key> -- npx -y @alter-ai/gmail-mcp
```

Claude Desktop, Cursor and other clients (`mcpServers` in the client's config file):

```json
{
  "mcpServers": {
    "gmail": {
      "command": "npx",
      "args": ["-y", "@alter-ai/gmail-mcp"],
      "env": { "ALTER_AGENT_API_KEY": "<agent key>" }
    }
  }
}
```

Until the first npm release, build from source (`pnpm install && pnpm build` at the repository root) and use `node packages/gmail-mcp/dist/index.js` as the command.

## Host on Cloudflare (remote, multi-user MCP)

Run the server as a Cloudflare Worker so claude.ai, Claude Code and other clients connect to it over HTTPS, and scheduled agents can use it while your computer is off. Hosted, the server is **multi-user**: everyone in your organization signs in with the identity provider already configured on your Alter app (Clerk, Auth0, Okta, WorkOS or another OIDC provider), and each person's requests go through **their own Gmail**, under the policies set in Alter, recorded as them. The Worker holds no identity-provider secret and no Gmail credential.

What happens when someone connects a client:

1. The client registers itself and opens the Worker's consent page, which names the client and where its access will go.
2. They choose **Allow and sign in**. A window opens with your app's sign-in page, through Alter. When they have signed in, Alter sends that window back to the Worker with a one-time code, and the Worker accepts it only in the browser that started the sign-in.
3. The Worker checks they are on `ALLOWED_USERS`, then asks Alter, with their identity-provider token, for their own Gmail connection delegated to this server's agent. If they have none yet, the page offers **Connect Gmail**: they connect it once through Alter Connect, delegated to the agent.
4. The client gets a token for this server bound to that one connection. Every tool call uses it, so nobody can reach another person's Gmail. Tokens are stored hashed in Workers KV.

This is the MCP standard's authorization flow, so it works the same in any MCP client that supports remote servers, not only Claude. [How sign-in works](https://github.com/AlterAIDev/alter-mcp-servers#how-sign-in-works-on-a-hosted-server) shows each step and what the client, the server, Alter and your identity provider each see: the client never sees your password, your identity-provider token or the provider credential.

One agent serves everyone: its rules (for example "approve every send") apply to all of them, and each person's own rules in Alter apply on top.

**1. An Alter app key for sign-in and connecting** (separate from the agent key). The key is printed once, in the `plain_key` field:

```bash
alter keys mint --app <app-id> --name mcp-hosted \
  --scopes idp_users:read,idp_users:write,connect:initiate,grants:write --output json | jq -r '.plain_key'
```

**2. Deploy** from `packages/gmail-mcp`, then set the secrets. The first deploy creates the Worker's KV namespace.

```bash
npx wrangler deploy
npx wrangler secret put ALTER_AGENT_API_KEY
npx wrangler secret put ALTER_SIGNIN_KEY
npx wrangler secret put ALLOWED_USERS
```

`ALLOWED_USERS` is a comma-separated list of identity-provider user ids, emails, whole email domains (`@example.com`), or `*` for anyone your identity provider signs in. Prefer user ids, or a domain your provider verifies, when people can sign up with an email they have not verified. `ALTER_ACCOUNT` and `ALTER_GRANT_ID` do not apply, since each person's connection is chosen at sign-in.

**3. Register the Worker's sign-in return URL** on the Alter app. In the Alter dashboard, open the app's sign-in settings and add this exact address to its return URLs (the Worker's address followed by `/authorize/return`; use your own domain instead if the Worker is served from one):

```
https://alter-gmail-mcp.<your-subdomain>.workers.dev/authorize/return
```

Until it is registered, Alter refuses to start a sign-in and the page says so.

**4. Connect a client** to `https://alter-gmail-mcp.<your-subdomain>.workers.dev/mcp` and sign in when asked:

- claude.ai and Claude Desktop: **Settings**, **Connectors**, **Add custom connector**.
- Claude Code: `claude mcp add --transport http gmail https://alter-gmail-mcp.<your-subdomain>.workers.dev/mcp`, then `/mcp` to sign in.
- Any other MCP client that supports remote servers with OAuth: add the URL as a remote (HTTP) server.

If someone reconnects their Gmail in Alter later, their client's next call is refused until they sign in again, which picks up the new connection.

A sign-in finishes only in the browser that started it: the Worker redeems Alter's one-time code only for the browser holding the cookie it set with the sign-in page, so a sign-in link sent to someone else gives the sender nothing. Still start sign-ins only from your MCP client, and never complete a sign-in or connect link someone sends you.

To approve held requests from Slack instead of the Wallet, add [`slack-approvals`](../slack-approvals).

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `ALTER_AGENT_API_KEY` | yes | The agent's key from step 3 |
| `ALTER_ACCOUNT` | no | Which Google account to use when more than one is delegated to the agent |
| `ALTER_GRANT_ID` | no | Use this exact grant instead of resolving by provider (not with `ALTER_ACCOUNT`) |

## FAQ

**Can it send email without me?** Not with the recommended policy: every send is held until you approve it in the Alter Wallet, and the hold is enforced by Alter, not by the AI client, so the agent cannot skip it.

**Where is my Google token?** In Alter. The server holds only the agent key; Alter adds the Google credential to each request after checking policy.

**What about instructions hidden in emails?** Email text reaches the model, so a message can try to steer it (prompt injection). The tools label email content as untrusted, sends are held for your approval, and deletes are blocked. Read each approval before you approve it.

**Can I see what the agent did?** Every call is in Alter's audit log with the agent, the tool and the outcome.

## License

MIT
