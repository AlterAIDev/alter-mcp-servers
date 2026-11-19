// Gmail wire format: building RFC 822 messages and reading message payloads.

export const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Email bodies longer than this are cut, so one message cannot flood the model's context. */
export const MAX_BODY_CHARS = 20_000;

export interface OutgoingMessage {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}

/** Header values are written into the message verbatim, so a line break would inject headers. */
export function hasLineBreak(value: string): boolean {
  return /[\r\n]/.test(value);
}

/** RFC 2047 encoded words for non-ASCII header text, in chunks short enough for one line each. */
export function encodeHeaderText(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let chunk = "";
  for (const char of value) {
    if (Buffer.byteLength(chunk + char, "utf8") > 42) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** The base64url `raw` value Gmail's drafts and send endpoints take. */
export function buildRawMessage(message: OutgoingMessage): string {
  const headers = [`To: ${message.to.join(", ")}`];
  if (message.cc?.length) headers.push(`Cc: ${message.cc.join(", ")}`);
  if (message.bcc?.length) headers.push(`Bcc: ${message.bcc.join(", ")}`);
  headers.push(`Subject: ${encodeHeaderText(message.subject)}`);
  if (message.inReplyTo) headers.push(`In-Reply-To: ${message.inReplyTo}`);
  if (message.references) headers.push(`References: ${message.references}`);
  headers.push("MIME-Version: 1.0", 'Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64");
  const body = Buffer.from(message.body.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/.{1,76}/g, "$&\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: GmailPart;
}

export function headerValue(headers: GmailHeader[] | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return headers?.find((header) => header.name.toLowerCase() === wanted)?.value;
}

function findPart(part: GmailPart, mimeType: string): GmailPart | undefined {
  if (part.mimeType === mimeType && !part.filename && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

function decode(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The readable text of a message: the plain-text part, else the HTML part as text. */
export function extractText(payload: GmailPart | undefined): string {
  if (!payload) return "";
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) return decode(plain.body.data);
  const html = findPart(payload, "text/html");
  if (html?.body?.data) return htmlToText(decode(html.body.data));
  return "";
}

export function attachmentNames(payload: GmailPart | undefined): string[] {
  const names: string[] = [];
  const walk = (part: GmailPart) => {
    if (part.filename) names.push(part.filename);
    for (const child of part.parts ?? []) walk(child);
  };
  if (payload) walk(payload);
  return names;
}

export function truncate(text: string, max = MAX_BODY_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n[... cut at ${max} characters]` : text;
}
