// Gmail wire format: building RFC 822 messages and reading message payloads.

export const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

/** Email bodies longer than this are cut, so one message cannot flood the model's context. */
export const MAX_BODY_CHARS = 20_000;

/**
 * Attachments, in total. Alter accepts requests up to 10 MB, and an attachment
 * grows by about 1.8 times on the way: base64 inside the message, then the
 * whole message base64url-encoded again for Gmail's `raw` field.
 */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

export interface Attachment {
  filename: string;
  contentType: string;
  data: Uint8Array;
}

export interface OutgoingMessage {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
  /** The sender's Gmail signature (HTML, as Gmail stores it), added below the body. */
  signatureHtml?: string;
  attachments?: Attachment[];
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

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** A Gmail signature's HTML as plain text, for the text version of the message. */
export function signatureText(html: string): string {
  return html
    .replace(/<a\b[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, "").trim();
      // The address is held in placeholders until the tags are stripped, so it is not taken for one.
      return text && text !== href && text !== href.replace(/^https?:\/\//, "") ? `${text}\u0000${href}\u0001` : href;
    })
    .replace(/<br\s*\/?>|<\/(div|p|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity: string, name: string) => {
      if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(parseInt(name.slice(2), 16));
      if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
      return ENTITIES[name.toLowerCase()] ?? entity;
    })
    .replace(/\u0000([^\u0001]*)\u0001/g, " <$1>")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const base64Lines = (data: Uint8Array | string) =>
  Buffer.from(data as Uint8Array).toString("base64").replace(/.{1,76}/g, "$&\r\n");

const crlf = (text: string) => text.replace(/\r?\n/g, "\r\n");

function boundary(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `alter_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** A filename parameter, RFC 2231-encoded when it is not plain ASCII. */
function filenameParameter(name: string, filename: string): string {
  const safe = filename.replace(/[\r\n"\\]/g, "");
  if (/^[\x20-\x7e]*$/.test(safe)) return `${name}="${safe}"`;
  return `${name}*=UTF-8''${encodeURIComponent(safe)}`;
}

function textPart(contentType: string, text: string): string {
  return `Content-Type: ${contentType}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(Buffer.from(text, "utf8"))}`;
}

function multipart(subtype: string, parts: string[]): { header: string; body: string } {
  const mark = boundary();
  return {
    header: `multipart/${subtype}; boundary="${mark}"`,
    body: `${parts.map((part) => `--${mark}\r\n${part}`).join("\r\n")}\r\n--${mark}--\r\n`,
  };
}

/** The base64url `raw` value Gmail's drafts and send endpoints take. */
export function buildRawMessage(message: OutgoingMessage): string {
  const headers = [`To: ${message.to.join(", ")}`];
  if (message.cc?.length) headers.push(`Cc: ${message.cc.join(", ")}`);
  if (message.bcc?.length) headers.push(`Bcc: ${message.bcc.join(", ")}`);
  headers.push(`Subject: ${encodeHeaderText(message.subject)}`);
  if (message.inReplyTo) headers.push(`In-Reply-To: ${message.inReplyTo}`);
  if (message.references) headers.push(`References: ${message.references}`);
  headers.push("MIME-Version: 1.0");

  const signatureHtml = message.signatureHtml?.trim();
  const attachments = message.attachments ?? [];
  if (!signatureHtml && attachments.length === 0) {
    headers.push('Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64");
    const body = base64Lines(Buffer.from(crlf(message.body), "utf8"));
    return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8").toString("base64url");
  }

  let content: { header: string; body: string };
  if (signatureHtml) {
    const signature = signatureText(signatureHtml);
    const text = crlf(`${message.body}${signature ? `\n\n-- \n${signature}` : ""}`);
    const html =
      `<div dir="ltr">${escapeHtml(message.body).replace(/\r?\n/g, "<br>")}</div>` +
      `<br><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature">${signatureHtml}</div>`;
    content = multipart("alternative", [textPart("text/plain", text), textPart("text/html", html)]);
  } else {
    content = { header: 'text/plain; charset="UTF-8"', body: base64Lines(Buffer.from(crlf(message.body), "utf8")) };
  }

  if (attachments.length > 0) {
    const first =
      content.header.startsWith("multipart/")
        ? `Content-Type: ${content.header}\r\n\r\n${content.body}`
        : `Content-Type: ${content.header}\r\nContent-Transfer-Encoding: base64\r\n\r\n${content.body}`;
    const files = attachments.map(
      (file) =>
        `Content-Type: ${file.contentType}; ${filenameParameter("name", file.filename)}\r\n` +
        `Content-Disposition: attachment; ${filenameParameter("filename", file.filename)}\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n${base64Lines(file.data)}`,
    );
    content = multipart("mixed", [first, ...files]);
  }
  headers.push(`Content-Type: ${content.header}`);
  if (!content.header.startsWith("multipart/")) headers.push("Content-Transfer-Encoding: base64");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${content.body}`, "utf8").toString("base64url");
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
