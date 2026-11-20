# Changelog

## 0.1.0 (unreleased)

- `@alter-ai/gmail-mcp`: `search_emails`, `read_email`, `create_draft`, `send_email` (held for approval under the recommended policy) and `check_approval`.
- Both servers can be hosted as Cloudflare Workers (`src/worker.ts`, `src/hosted.ts`, `wrangler.jsonc`): stateless Streamable HTTP behind an OAuth server built on `@cloudflare/workers-oauth-provider`. Hosted servers are multi-user: each person signs in through the Alter app's identity provider, is checked against `ALLOWED_USERS` (ids, emails, `@domain` or `*`), and their client's token is bound to their own connection delegated to the agent, found with their identity-provider token; first-time users connect their account from the sign-in page.
- `slack-approvals`: a Cloudflare Worker that turns Alter's `approval.requested` webhooks into Slack messages showing what will be sent, and decides from the Approve and Deny buttons as the clicking approver.
- `@alter-ai/linkedin-mcp`: `get_profile`, `create_post`, `comment_on_post`, `react_to_post` (held for approval under the recommended policy) and `check_approval`, on LinkedIn's official API only. `create_post` takes an optional `link` that LinkedIn shows as an article card.
