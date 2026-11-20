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

// Media: X's v2 chunked upload (initialize, append, finalize, status).
// https://docs.x.com/x-api/media/quickstart/media-upload-chunked

/** A post carries up to 4 images, or 1 GIF, or 1 video, never a mix. */
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_GIF_BYTES = 15 * 1024 * 1024;
/** X takes far larger videos; this keeps an upload inside one tool call. */
export const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
/** X recommends segments of 5 MB or less; Alter accepts requests up to 10 MB. */
export const UPLOAD_SEGMENT_BYTES = 4 * 1024 * 1024;
/** How long to wait for X to finish processing a video before giving up. */
export const PROCESSING_TIMEOUT_MS = 180_000;

export type MediaCategory = "tweet_image" | "tweet_gif" | "tweet_video";

export function mediaCategory(contentType: string): MediaCategory | undefined {
  if (contentType === "image/gif") return "tweet_gif";
  if (contentType === "image/png" || contentType === "image/jpeg" || contentType === "image/webp") return "tweet_image";
  if (contentType === "video/mp4" || contentType === "video/quicktime") return "tweet_video";
  return undefined;
}

export function maxBytesFor(category: MediaCategory): number {
  return category === "tweet_image" ? MAX_IMAGE_BYTES : category === "tweet_gif" ? MAX_GIF_BYTES : MAX_VIDEO_BYTES;
}

/** A multipart/form-data body with text fields and one binary file field. */
export function multipartBody(
  fields: Record<string, string>,
  file: { name: string; data: Uint8Array },
): { body: Uint8Array; contentType: string } {
  const random = crypto.getRandomValues(new Uint8Array(12));
  const boundary = `alter${Array.from(random, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const encoder = new TextEncoder();
  const head = Object.entries(fields)
    .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    .join("");
  const fileHead = `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const parts = [encoder.encode(head + fileHead), file.data, encoder.encode(`\r\n--${boundary}--\r\n`)];
  const body = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

export interface ProcessingInfo {
  state?: "pending" | "in_progress" | "succeeded" | "failed";
  check_after_secs?: number;
  error?: { message?: string };
}
