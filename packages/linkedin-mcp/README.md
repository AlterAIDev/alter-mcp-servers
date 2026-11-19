# LinkedIn MCP server on the official API (`@alter-ai/linkedin-mcp`)

A LinkedIn MCP server for AI agents that posts, comments and reacts through **LinkedIn's official API only**: no browser automation, no scraping, nothing that puts your account at risk. Posts and comments wait for a person's approval, and the server never holds a LinkedIn token. It is backed by [Alter](https://alterauth.com): Alter stores the LinkedIn credential, adds it to each request, enforces the policies you set on the agent, and records every call.

## What it can and cannot do

LinkedIn's official API lets a member app read the member's profile and publish posts, comments and reactions. It does not offer messaging or connection requests to apps, so this server does not either. Servers that claim to send LinkedIn messages or invitations do it by driving a logged-in browser or an unofficial API, which LinkedIn's terms prohibit.

| Tool | What it does | With the recommended policy |
|---|---|---|
| `get_profile` | The connected member's name, email and member URN | Allowed |
| `create_post` | Publishes a text post (public or connections only), up to 3,000 characters | **Held until you approve it** |
| `comment_on_post` | Comments on a post as the member, up to 1,250 characters | **Held until you approve it** |
| `react_to_post` | Likes, celebrates, supports and so on | **Held until you approve it** |
| `check_approval` | Reports what happened to a held request | Allowed |

## How a post works

1. The agent calls `create_post`. Alter matches your approval rule and holds the exact request, encrypted.
2. The tool returns an approval link and an approval id. Nothing has been posted.
3. You review it in the Alter Wallet, with the agent's `reason`, and approve or deny.
4. On approval Alter publishes exactly the held post, once. `check_approval` reports the outcome.

## Set up

You need an Alter account and the [`alter` CLI](https://docs.alterauth.com/reference/cli), version 0.10 or later (policy changes need it). Replace `<app-id>` and `<agent-id>` below with your app's and agent's ids. Every step can also be done in the [Alter portal](https://portal.alterauth.com).

**1. An Alter app with an identity provider** (Auth0, Clerk, Okta, WorkOS or another OIDC provider), so you can delegate your LinkedIn account to an agent. See [identity providers](https://docs.alterauth.com/admin/identity-provider).

**2. LinkedIn as a provider.** Create an app in the [LinkedIn developer portal](https://www.linkedin.com/developers/apps), add the **Sign In with LinkedIn using OpenID Connect** and **Share on LinkedIn** products (both self-service), and add it to your Alter app with the scopes `openid`, `profile`, `email` and `w_member_social`. See [LinkedIn provider setup](https://docs.alterauth.com/reference/oauth-providers/linkedin).

**3. An agent.** The key is printed once, in the `api_key` field:

```bash
alter agents create --app <app-id> --name linkedin-agent \
  --scopes '{"linkedin":["openid","profile","email","w_member_social"]}' \
  --output json | jq -r '.api_key'
```

**4. Connect your LinkedIn and delegate it to the agent.** `ALTER_API_KEY` is the app's runtime key and `USER_JWT` is your own token from the app's identity provider. Open the `connect_url` from the output and approve:

```bash
alter connect create --provider linkedin --user-token "$USER_JWT" --agent linkedin-agent --output json
```

**5. Policies.** Hold posts, comments and reactions for approval for up to 24 hours, and block deletes. With no `approvers` listed, you (who connected the account) approve:

```bash
echo '{"effect": "require_approval", "when": {"match": {"families": ["send", "write"]}}, "approval": {"channels": ["email"], "expires_in_seconds": 86400}}' | \
  alter policy rules create --app <app-id> --agent <agent-id> --type require_approval --body - --name "Approve every post"

echo '{"when": {"family": ["delete"]}, "effect": "deny"}' | \
  alter policy rules create --app <app-id> --agent <agent-id> --body - --name "No deletes"
```

**6. Your MCP client.**

Claude Code:

```bash
claude mcp add linkedin --env ALTER_AGENT_API_KEY=<agent key> -- npx -y @alter-ai/linkedin-mcp
```

Other clients (`mcpServers` in the client's config file):

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "npx",
      "args": ["-y", "@alter-ai/linkedin-mcp"],
      "env": { "ALTER_AGENT_API_KEY": "<agent key>" }
    }
  }
}
```

Until the first npm release, build from source (`pnpm install && pnpm build` at the repository root) and use `node packages/linkedin-mcp/dist/index.js` as the command.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `ALTER_AGENT_API_KEY` | yes | The agent's key from step 3 |
| `LINKEDIN_API_VERSION` | no | LinkedIn API version in `YYYYMM` form for the versioned endpoints (default `202609`) |
| `ALTER_ACCOUNT` | no | Which LinkedIn account to use when more than one is delegated to the agent |
| `ALTER_GRANT_ID` | no | Use this exact grant instead of resolving by provider (not with `ALTER_ACCOUNT`) |

## FAQ

**Will this get my LinkedIn account restricted?** It uses only LinkedIn's official API through your own LinkedIn app, the way any approved integration does. It does not drive a browser or call unofficial endpoints.

**Can it send messages or connection requests?** No. LinkedIn does not offer those to apps.

**Can it post without me?** Not with the recommended policy: Alter holds every post, comment and reaction until you approve it, and the AI client cannot skip that.

**Formatting.** Text is posted as written. LinkedIn's post format treats some characters specially, so the server escapes them; hashtags appear as plain text.

## License

MIT
