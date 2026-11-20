// LinkedIn's official API: only what a member app can do with the
// "Sign In with LinkedIn using OpenID Connect" and "Share on LinkedIn"
// products. LinkedIn offers no API for messages or connection requests.

export const LINKEDIN = "https://api.linkedin.com";

/** LinkedIn's versioned (/rest) endpoints need a YYYYMM version header. Override with LINKEDIN_API_VERSION. */
export const DEFAULT_API_VERSION = "202609";

export const MAX_POST_CHARS = 3000;
export const MAX_COMMENT_CHARS = 1250;
/** Article link cards: LinkedIn truncates longer titles and descriptions in the card. */
export const MAX_LINK_TITLE_CHARS = 200;
export const MAX_LINK_DESCRIPTION_CHARS = 300;

export const REACTIONS = ["LIKE", "PRAISE", "EMPATHY", "INTEREST", "APPRECIATION", "ENTERTAINMENT"] as const;

export const POST_URN = /^urn:li:(share|ugcPost|activity):\d{1,25}$/;

export function apiVersionFrom(env: NodeJS.ProcessEnv): string {
  const value = env.LINKEDIN_API_VERSION?.trim();
  if (!value) return DEFAULT_API_VERSION;
  if (!/^\d{6}$/.test(value)) {
    throw new Error("LINKEDIN_API_VERSION must be a LinkedIn API version in YYYYMM form, for example 202609.");
  }
  return value;
}

/**
 * Post commentary uses LinkedIn's "little text" format, where these characters
 * have meaning and must be escaped to appear as written.
 */
export function escapeLittleText(text: string): string {
  return text.replace(/[\\|{}@[\]()<>#*_~]/g, (char) => `\\${char}`);
}

export function postUrl(urn: string): string {
  return `https://www.linkedin.com/feed/update/${urn}/`;
}
