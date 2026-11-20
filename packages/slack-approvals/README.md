# Approve agent requests from Slack (`slack-approvals`)

A Cloudflare Worker that puts [Alter](https://alterauth.com)'s held requests in a Slack channel. When a policy holds an agent's request for approval (an email send, a LinkedIn post, any provider call), the Worker posts a message showing exactly what Alter will send, with **Approve** and **Deny** buttons. A click decides the request as the person who clicked.

It works with any agent on the Alter app, including the [Gmail](../gmail-mcp) and [LinkedIn](../linkedin-mcp) MCP servers in this repository.

## What the approver sees

The message is built from Alter's approver summary, which Alter reads from the held request itself, not from anything the agent wrote:

- the tool or operation, the agent, the provider and when the request expires;
- the agent's stated reason;
- the content: an email's recipients, subject, text and attachments (name, type and size); a LinkedIn post as readers will see it, with its link card or its images and video; an X post with the post it replies to and its media; a comment or reaction; or the request body for other operations;
- recipients outside the rule's allowed list, when the rule has one.

**Approve** asks for confirmation, then Alter runs exactly the held request, once. **Deny** discards it.

## How a click is trusted

- Slack signs each button click. The Worker rejects any click whose signature does not check out, or that is more than five minutes old.
- The Worker looks up the clicking member's email in Slack and sends it to Alter as the decider. Alter accepts it only if that email is one of the request's approvers; anyone else gets a private "not an approver" reply and nothing changes. Alter records the decision as asserted by an integration, with the email.
- An approve carries the request digest and summary version the message showed. If the request changed after the message was posted, Alter refuses the approval and the message is redrawn for a fresh decision.
- Requests that only the account owner may decide (a rule with no approvers listed, or a rule that requires a fresh sign-in) have to be decided in the Alter Wallet; the Worker says so.

So the rules that should be decided in Slack must **name their approvers**, with the email each approver uses in Slack.

## Set up

You need the [`alter` CLI](https://docs.alterauth.com/reference/cli) (0.10 or later), a Cloudflare account and a Slack workspace where you can install apps. Replace `<app-id>` with your Alter app's id.

**1. An Alter key that can read and decide approvals.** The key is printed once, in the `plain_key` field:

```bash
alter keys mint --app <app-id> --name slack-approvals \
  --scopes approvals:read,approvals:decide --output json | jq -r '.plain_key'
```

**2. Deploy the Worker** from this directory:

```bash
npx wrangler deploy
```

It prints the Worker's URL, `https://alter-slack-approvals.<your-subdomain>.workers.dev`.

**3. A Slack app.** At [api.slack.com/apps](https://api.slack.com/apps), choose **Create New App**, then **From a manifest**, pick the workspace, and paste this manifest with your Worker's URL:

```yaml
display_information:
  name: Alter Approvals
  description: Approve or deny agent requests that Alter holds for review.
features:
  bot_user:
    display_name: Alter Approvals
oauth_config:
  scopes:
    bot:
      - chat:write
      - users:read
      - users:read.email
settings:
  interactivity:
    is_enabled: true
    request_url: https://alter-slack-approvals.<your-subdomain>.workers.dev/slack/interactions
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

Install it to the workspace. Copy the **Bot User OAuth Token** (`xoxb-…`, under **OAuth & Permissions**) and the **Signing Secret** (under **Basic Information**). Create the approvals channel, invite the app to it (`/invite @Alter Approvals`), and copy the channel id (the channel's details, at the bottom).

**4. An Alter webhook** to the Worker. The signing secret is printed once, in the `signing_secret` field:

```bash
alter webhooks create --app <app-id> \
  --url https://alter-slack-approvals.<your-subdomain>.workers.dev/alter/webhook \
  --events approval.requested,approval.failed --output json | jq -r '.signing_secret'
```

**5. The Worker's secrets:**

```bash
npx wrangler secret put ALTER_APPROVALS_KEY     # step 1
npx wrangler secret put ALTER_WEBHOOK_SECRET    # step 4
npx wrangler secret put SLACK_BOT_TOKEN         # step 3
npx wrangler secret put SLACK_SIGNING_SECRET    # step 3
npx wrangler secret put SLACK_CHANNEL_ID        # step 3
```

**6. Name the approvers on your rules.** For example, hold every send and name who approves:

```bash
echo '{"effect": "require_approval", "when": {"match": {"families": ["send"]}}, "approval": {"approvers": ["you@example.com"], "channels": ["email"], "expires_in_seconds": 86400}}' | \
  alter policy rules create --app <app-id> --agent <agent-id> --type require_approval --body - --name "Approve every send"
```

To check the connection, send a test event (`alter webhooks test --app <app-id> --endpoint <endpoint-id>`, or the webhook's card in the Alter portal): the channel shows "Alter is connected".

## Events

| Alter event | In Slack |
|---|---|
| `approval.requested` | A message with the request and Approve / Deny |
| `approval.failed` | A warning that an approved request failed when Alter sent it, with the error |
| `webhook.test` | "Alter is connected" |

A request decided somewhere else (the Wallet, another approver) keeps its buttons until someone clicks one; the click then shows where the request stands.

## Configuration

| Secret | Meaning |
|---|---|
| `ALTER_APPROVALS_KEY` | Alter key with `approvals:read` and `approvals:decide` |
| `ALTER_WEBHOOK_SECRET` | The webhook endpoint's signing secret (`whsec_…`) |
| `SLACK_BOT_TOKEN` | The Slack app's bot token (`xoxb-…`) |
| `SLACK_SIGNING_SECRET` | The Slack app's signing secret |
| `SLACK_CHANNEL_ID` | The channel held requests are posted to |

## License

MIT
