# X (Twitter) MCP server on the official API (`@alter-ai/x-mcp`)

An X MCP server for AI agents that searches, reads mentions, posts, likes and reposts through **X's official API only**: no browser automation, no scraping. Posts wait for a person's approval, and the server never holds an X token. It is backed by [Alter](https://alterauth.com): Alter stores the X credential, adds it to each request, enforces the policies you set on the agent, and records every call.

## Tools

| Tool | What it does | With the recommended policy |
|---|---|---|
| `get_profile` | The connected account's name, handle, user id and follower counts | Allowed |
| `search_posts` | Searches posts from the last 7 days with X's search syntax (`"mcp server" -is:retweet lang:en`); returns author, time, link, engagement and text | Allowed |
| `get_mentions` | The most recent posts that mention the connected account | Allowed |
| `create_post` | Publishes a post, or a reply with `reply_to`, optionally with up to 4 images, a GIF or a video (`media`) | **Held until you approve it** |
| `like_post` | Likes a post | **Held until you approve it** |
| `repost` | Reposts a post | **Held until you approve it** |
| `check_approval` | Reports what happened to a held request | Allowed |

Direct messages are not a tool: cold DMs are where automated accounts get restricted.

## Images and video

`create_post` takes `media`: up to 4 images (JPEG, PNG or WEBP, 5 MB each), or one GIF (15 MB), or one video (MP4 or MOV, up to 512 MB), never a mix. Each file is an `https` URL anyone can open, or, when the server runs on your computer (`npx`), an absolute file path. A hosted server takes URLs only, and a local one refuses URLs that point at private network addresses. A file you drop into a chat cannot be passed to a remote MCP server, so put it at a URL first.

The server uploads each file through Alter with X's chunked upload (4 MB pieces), waits for X to finish processing a video, then submits the post with the media attached. The post is what waits for approval: the approver sees the post and, in the agent's reason, each file's name, type, size and source. If the post is denied, X discards the unused media after 24 hours.

## X charges for API use

X bills API calls from prepaid credits you buy in the X Developer Console. At the time of writing, each post returned by a search or a mentions read costs $0.005, publishing a post costs $0.015, or $0.20 when it contains a URL, and a like or repost costs $0.015; a 10-post search therefore costs about $0.05. Prices change: check [X's API pricing](https://docs.x.com/x-api/getting-started/pricing) before you set this up. When X refuses a call because the app has no credits or no access, the tool says so.

## How a post works

1. The agent calls `create_post`. Alter matches your approval rule and holds the exact request, encrypted.
2. The tool returns an approval link and an approval id. Nothing has been posted.
3. You review it in the Alter Wallet (or in Slack, with [`slack-approvals`](../slack-approvals)) and approve or deny.
4. On approval Alter publishes exactly the held post, once. `check_approval` reports the outcome.

## Set up

You need an Alter account and the [`alter` CLI](https://docs.alterauth.com/reference/cli), version 0.10 or later. Replace `<app-id>` and `<agent-id>` below. Every step can also be done in the [Alter portal](https://portal.alterauth.com).

**1. An Alter app with an identity provider** (Auth0, Clerk, Okta, WorkOS or another OIDC provider), so you can delegate your X account to an agent. See [identity providers](https://docs.alterauth.com/admin/identity-provider).

**2. X as a provider.** In the [X developer portal](https://developer.x.com/en/portal/dashboard), create an app, turn on OAuth 2.0 as a **Web App**, add Alter's callback URL, and copy the client ID and secret. Add X (provider `twitter`) to your Alter app with the scopes `tweet.read`, `tweet.write`, `users.read`, `like.write`, `media.write` and `offline.access`. See [X provider setup](https://docs.alterauth.com/reference/oauth-providers/twitter).

**3. An agent.** The key is printed once, in the `api_key` field:

```bash
alter agents create --app <app-id> --name x-agent \
  --scopes '{"twitter":["tweet.read","tweet.write","users.read","like.write","media.write","offline.access"]}' \
  --output json | jq -r '.api_key'
```

**4. Connect your X account and delegate it to the agent.** `ALTER_API_KEY` is the app's runtime key and `USER_JWT` is your own token from the app's identity provider. Open the `connect_url` from the output and approve:

```bash
alter connect create --provider twitter --user-token "$USER_JWT" --agent x-agent --output json
```

**5. Policies.** Hold posts, likes and reposts for approval for up to 24 hours, and block deletes. Alter classifies posting as a `send` operation, and likes, reposts and media uploads as `write`. An upload is not visible to anyone until the post carrying it is published, so the rule holds posts and names the like and repost operations rather than holding every `write` (which would stop each upload piece for approval):

```bash
echo '{"effect": "require_approval", "when": {"match": {"families": ["send"], "operations": ["likePost", "repostPost"]}}, "approval": {"approvers": ["you@example.com"], "channels": ["email"], "expires_in_seconds": 86400}}' | \
  alter policy rules create --app <app-id> --agent <agent-id> --type require_approval --body - --name "Approve every post, like and repost"

echo '{"when": {"family": ["delete"]}, "effect": "deny"}' | \
  alter policy rules create --app <app-id> --agent <agent-id> --body - --name "No deletes"
```

**6. Your MCP client.**

Claude Code:

```bash
claude mcp add x --env ALTER_AGENT_API_KEY=<agent key> -- npx -y @alter-ai/x-mcp
```

Other clients (`mcpServers` in the client's config file):

```json
{
  "mcpServers": {
    "x": {
      "command": "npx",
      "args": ["-y", "@alter-ai/x-mcp"],
      "env": { "ALTER_AGENT_API_KEY": "<agent key>" }
    }
  }
}
```

Until the first npm release, build from source (`pnpm install && pnpm build` at the repository root) and use `node packages/x-mcp/dist/index.js` as the command.

## Host on Cloudflare (remote, multi-user MCP)

Run the server as a Cloudflare Worker so claude.ai, Claude Code and other clients connect to it over HTTPS, and scheduled agents can use it while your computer is off. Hosted, the server is **multi-user**: everyone in your organization signs in with the identity provider already configured on your Alter app (Clerk, Auth0, Okta, WorkOS or another OIDC provider), and each person's requests go through **their own X account**, under the policies set in Alter, recorded as them. The Worker holds no identity-provider secret and no X account credential.

What happens when someone connects a client:

1. The client registers itself and opens the Worker's consent page, which names the client and where its access will go.
2. They choose **Allow and sign in**. A window opens with your app's sign-in page, through Alter. When they have signed in, Alter sends that window back to the Worker with a one-time code, and the Worker accepts it only in the browser that started the sign-in.
3. The Worker checks they are on `ALLOWED_USERS`, then asks Alter, with their identity-provider token, for their own X account connection delegated to this server's agent. If they have none yet, the page offers **Connect X account**: they connect it once through Alter Connect, delegated to the agent.
4. The client gets a token for this server bound to that one connection. Every tool call uses it, so nobody can reach another person's X account. Tokens are stored hashed in Workers KV.

This is the MCP standard's authorization flow, so it works the same in any MCP client that supports remote servers, not only Claude. [How sign-in works](https://github.com/AlterAIDev/alter-mcp-servers#how-sign-in-works-on-a-hosted-server) shows each step and what the client, the server, Alter and your identity provider each see: the client never sees your password, your identity-provider token or the provider credential.

One agent serves everyone: its rules (for example "approve every send") apply to all of them, and each person's own rules in Alter apply on top.

**1. An Alter app key for sign-in and connecting** (separate from the agent key). The key is printed once, in the `plain_key` field:

```bash
alter keys mint --app <app-id> --name mcp-hosted \
  --scopes idp_users:read,idp_users:write,connect:initiate,grants:write --output json | jq -r '.plain_key'
```

**2. Deploy** from `packages/x-mcp`, then set the secrets. The first deploy creates the Worker's KV namespace.

```bash
npx wrangler deploy
npx wrangler secret put ALTER_AGENT_API_KEY
npx wrangler secret put ALTER_SIGNIN_KEY
npx wrangler secret put ALLOWED_USERS
```

`ALLOWED_USERS` is a comma-separated list of identity-provider user ids, emails, whole email domains (`@example.com`), or `*` for anyone your identity provider signs in. Prefer user ids, or a domain your provider verifies, when people can sign up with an email they have not verified. `ALTER_ACCOUNT` and `ALTER_GRANT_ID` do not apply, since each person's connection is chosen at sign-in.

**3. Register the Worker's sign-in return URL** on the Alter app. In the Alter dashboard, open the app's sign-in settings and add this exact address to its return URLs (the Worker's address followed by `/authorize/return`; use your own domain instead if the Worker is served from one):

```
https://alter-x-mcp.<your-subdomain>.workers.dev/authorize/return
```

Until it is registered, Alter refuses to start a sign-in and the page says so.

**4. Connect a client** to `https://alter-x-mcp.<your-subdomain>.workers.dev/mcp` and sign in when asked:

- claude.ai and Claude Desktop: **Settings**, **Connectors**, **Add custom connector**.
- Claude Code: `claude mcp add --transport http x https://alter-x-mcp.<your-subdomain>.workers.dev/mcp`, then `/mcp` to sign in.
- Any other MCP client that supports remote servers with OAuth: add the URL as a remote (HTTP) server.

If someone reconnects their X account in Alter later, their client's next call is refused until they sign in again, which picks up the new connection.

A sign-in finishes only in the browser that started it: the Worker redeems Alter's one-time code only for the browser holding the cookie it set with the sign-in page, so a sign-in link sent to someone else gives the sender nothing. Still start sign-ins only from your MCP client, and never complete a sign-in or connect link someone sends you.

To approve held requests from Slack instead of the Wallet, add [`slack-approvals`](../slack-approvals).

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `ALTER_AGENT_API_KEY` | yes | The agent's key from step 3 |
| `ALTER_ACCOUNT` | no | Which X account to use when more than one is delegated to the agent |
| `ALTER_GRANT_ID` | no | Use this exact grant instead of resolving by provider (not with `ALTER_ACCOUNT`) |

## FAQ

**Will this get my account restricted?** It uses only X's official API through your own developer app. It does not drive a browser or call unofficial endpoints. Posting often or replying to strangers in bulk can still break X's automation rules; the approval rule keeps a person in that loop.

**Can it post without me?** Not with the recommended policy: Alter holds every post, like and repost until you approve it, and the AI client cannot skip that.

**What about instructions hidden in posts?** Post text reaches the model, so a post can try to steer it (prompt injection). The tools label post content as untrusted, and anything the agent publishes is held for your approval.

## License

MIT
