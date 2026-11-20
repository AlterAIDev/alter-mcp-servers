// X's official API (v2): what a member app can do with OAuth 2.0 user context.

export const X_API = "https://api.x.com";

/** Accounts without X Premium can post up to 280 characters; Premium accounts up to 25,000. */
export const MAX_POST_CHARS = 25_000;
export const STANDARD_POST_CHARS = 280;
/** X caps recent-search queries at 512 characters. */
export const MAX_QUERY_CHARS = 512;

export const POST_ID = /^\d{1,25}$/;

export const TWEET_FIELDS = "created_at,author_id,public_metrics,conversation_id";
export const USER_FIELDS = "username,name";

export interface XUser {
  id: string;
  username?: string;
  name?: string;
}

export interface XPost {
  id: string;
  text?: string;
  author_id?: string;
  created_at?: string;
  public_metrics?: { like_count?: number; reply_count?: number; retweet_count?: number; quote_count?: number };
}

export interface XPostPage {
  data?: XPost[];
  includes?: { users?: XUser[] };
  meta?: { result_count?: number; next_token?: string };
}

export function postUrl(id: string, username?: string): string {
  return `https://x.com/${username ?? "i"}/status/${id}`;
}

/** One line per post: author, time, link, engagement, then the text. */
export function formatPosts(page: XPostPage): string[] {
  const users = new Map((page.includes?.users ?? []).map((user) => [user.id, user]));
  return (page.data ?? []).map((post) => {
    const author = post.author_id ? users.get(post.author_id) : undefined;
    const handle = author?.username ? `@${author.username}` : (post.author_id ?? "unknown");
    const metrics = post.public_metrics;
    const counts = metrics
      ? ` · ${metrics.like_count ?? 0} likes, ${metrics.reply_count ?? 0} replies, ${metrics.retweet_count ?? 0} reposts`
      : "";
    return [
      `${handle}${author?.name ? ` (${author.name})` : ""} · ${post.created_at ?? ""} · ${postUrl(post.id, author?.username)}${counts}`,
      `id: ${post.id}`,
      (post.text ?? "").trim(),
    ].join("\n");
  });
}

/** X error bodies come as {detail, title} (problem details) or {errors: [{message}]}. */
export function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { detail?: string; title?: string; errors?: { message?: string }[] };
    return parsed.detail ?? parsed.errors?.[0]?.message ?? parsed.title ?? "";
  } catch {
    return "";
  }
}
