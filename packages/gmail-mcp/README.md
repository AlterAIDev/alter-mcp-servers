# Gmail MCP server with approvals (`@alter-ai/gmail-mcp`)

A Gmail MCP server for AI agents that can search, read, draft and **send**, where the server never holds a Google token and every send waits for a person's approval. It is backed by [Alter](https://alterauth.com): Alter stores the Google credential, adds it to each request, enforces the policies you set on the agent, and records every call.

Many Gmail MCP servers keep a Google token on the machine that runs them, and any approval step lives in the AI client. This one keeps the token in Alter and enforces approvals there, so the agent's key alone cannot reach your mailbox beyond what its policies allow.

## Tools

| Tool | What it does | With the recommended policy |
|---|---|---|
| `search_emails` | Searches with Gmail syntax (`from:alex@example.com newer_than:7d`); returns sender, recipients, subject, date, id and snippet | Allowed |
| `read_email` | Reads one message: headers, plain-text body (HTML converted, long bodies cut), attachment names | Allowed |
| `create_draft` | Writes a plain-text draft, optionally as a reply in a thread; nothing is sent | Allowed |
| `send_email` | Sends a plain-text email, optionally as a reply | **Held until you approve it** |
| `check_approval` | Reports what happened to a held request: waiting, done, denied, expired or failed | Allowed |

Deleting mail is not a tool, and the recommended policy also blocks Gmail's delete operations for the agent.

## How a send works

1. The agent calls `send_email`. The request reaches Alter, which matches your approval rule and holds the exact request, encrypted.
2. The tool returns an approval link and an approval id. Nothing has been sent.
3. You open the link in the Alter Wallet. It shows the operation and the recipients, sender and subject the policy reads, plus the agent's `reason`.
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
