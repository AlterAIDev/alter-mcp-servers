// Decodes the raw RFC 5322 message a Gmail send carries (base64url in the
// request body), so an approver sees the recipients, subject and text Alter
// will send. Works on bytes as a latin-1 "binary string" until a charset is
// known, so 8-bit, base64 and quoted-printable bodies all decode correctly.

export interface DecodedEmail {
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  text: string;
  /** Files attached to the message: what the approver must know is going out. */
  attachments: { filename: string; contentType: string; size: number }[];
}

function binaryFromBase64(data: string): string {
  const clean = data.replace(/[^A-Za-z0-9+/]/g, "");
  return atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, "="));
}

function bytesOf(binary: string): Uint8Array {
  return Uint8Array.from(binary, (char) => char.charCodeAt(0) & 0xff);
}

function decodeText(binary: string, charset = "utf-8"): string {
  try {
    return new TextDecoder(charset).decode(bytesOf(binary));
  } catch {
    return new TextDecoder("utf-8").decode(bytesOf(binary));
  }
}

function quotedPrintable(binary: string): string {
  return binary.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** RFC 2047 encoded words, e.g. =?UTF-8?B?...?= in a Subject. */
export function decodeEncodedWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, "$1")
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset: string, kind: string, text: string) =>
      decodeText(kind.toUpperCase() === "B" ? binaryFromBase64(text) : quotedPrintable(text.replace(/_/g, " ")), charset),
    );
}

interface Part {
  headers: Map<string, string>;
  body: string;
}

function parsePart(binary: string): Part {
  const split = binary.search(/\r?\n\r?\n/);
  const head = split < 0 ? binary : binary.slice(0, split);
  const body = split < 0 ? "" : binary.slice(split).replace(/^\r?\n\r?\n/, "");
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function parameter(header: string | undefined, name: string): string | undefined {
  const match = header?.match(new RegExp(`${name}="?([^";]+)"?`, "i"));
  return match?.[1];
}

function textOf(part: Part): string | undefined {
  const type = part.headers.get("content-type") ?? "text/plain";
  if (/^multipart\//i.test(type)) {
    const boundary = parameter(type, "boundary");
    if (!boundary) return undefined;
    const children = part.body
      .split(`--${boundary}`)
      .slice(1)
      .filter((chunk) => !chunk.startsWith("--"))
      .map((chunk) => parsePart(chunk.replace(/^\r?\n/, "")));
    const plain = children.find((child) => /^text\/plain/i.test(child.headers.get("content-type") ?? "text/plain"));
    return (plain && textOf(plain)) ?? children.map(textOf).find((text) => text !== undefined);
  }
  if (!/^text\//i.test(type)) return undefined;
  const encoding = (part.headers.get("content-transfer-encoding") ?? "7bit").toLowerCase();
  const binary =
    encoding === "base64" ? binaryFromBase64(part.body) : encoding === "quoted-printable" ? quotedPrintable(part.body) : part.body;
  const text = decodeText(binary, parameter(type, "charset") ?? "utf-8");
  return /^text\/html/i.test(type) ? text.replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ") : text;
}

function children(part: Part): Part[] {
  const boundary = parameter(part.headers.get("content-type"), "boundary");
  if (!boundary) return [];
  return part.body
    .split(`--${boundary}`)
    .slice(1)
    .filter((chunk) => !chunk.startsWith("--"))
    .map((chunk) => parsePart(chunk.replace(/^\r?\n/, "")));
}

/** Every part sent as a file: marked as an attachment, or carrying a file name. */
function attachmentsOf(part: Part): DecodedEmail["attachments"] {
  const type = part.headers.get("content-type") ?? "text/plain";
  if (/^multipart\//i.test(type)) return children(part).flatMap(attachmentsOf);
  const disposition = part.headers.get("content-disposition");
  const encoded = parameter(disposition, "filename\\*") ?? parameter(type, "name\\*");
  let filename = parameter(disposition, "filename") ?? parameter(type, "name");
  if (encoded) {
    try {
      filename = decodeURIComponent(encoded.replace(/^UTF-8''/i, ""));
    } catch {
      filename = encoded;
    }
  }
  if (!/^attachment/i.test(disposition ?? "") && !filename) return [];
  const encoding = (part.headers.get("content-transfer-encoding") ?? "7bit").toLowerCase();
  const size = encoding === "base64" ? binaryFromBase64(part.body).length : part.body.length;
  return [{ filename: decodeEncodedWords(filename ?? "unnamed"), contentType: type.split(";")[0]?.trim() ?? type, size }];
}

/** Decodes Gmail's `raw` field (base64url of the whole message). */
export function decodeGmailRaw(raw: string): DecodedEmail {
  const part = parsePart(binaryFromBase64(raw.replace(/-/g, "+").replace(/_/g, "/")));
  const header = (name: string) => {
    const value = part.headers.get(name);
    return value === undefined ? undefined : decodeEncodedWords(decodeText(value));
  };
  const email: DecodedEmail = { text: (textOf(part) ?? "").replace(/\r\n/g, "\n").trim(), attachments: attachmentsOf(part) };
  for (const name of ["from", "to", "cc", "bcc", "subject"] as const) {
    const value = header(name);
    if (value !== undefined) email[name] = value;
  }
  return email;
}
