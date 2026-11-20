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

// Media: the Images and Videos APIs.
// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api

/** A post carries one image, 2 to 20 images (a multi-image post), or one video. */
export const MAX_IMAGES = 20;
/** LinkedIn states no image size limit; Alter accepts requests up to 10 MB. */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif"];
/** LinkedIn's video limits: MP4, 75 KB to 500 MB, 3 seconds to 30 minutes. */
export const MIN_VIDEO_BYTES = 75 * 1024;
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const MAX_ALT_TEXT_CHARS = 4086;
export const MAX_VIDEO_TITLE_CHARS = 400;

/** LinkedIn's upload URLs: https on www.linkedin.com under /dms-uploads/. */
export function isLinkedInUploadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.linkedin.com" && url.pathname.startsWith("/dms-uploads/");
  } catch {
    return false;
  }
}

export interface UploadInstruction {
  uploadUrl: string;
  firstByte: number;
  lastByte: number;
}
