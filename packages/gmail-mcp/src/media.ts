// Images, video and files to attach to a post or an email. Each comes from a
// public https URL or, only when the server runs on the user's own computer,
// an absolute file path. Content is read in pieces, so a video never has to
// fit in memory, and sizes are enforced while reading.

export class MediaError extends Error {}

export interface MediaOptions {
  /** Accept absolute file paths. Only for a server running on the user's own computer. */
  allowFiles: boolean;
  /**
   * Called with each URL's host before it is fetched, to refuse private
   * addresses. A hosted Worker relies on Cloudflare's
   * `global_fetch_strictly_public` flag instead.
   */
  checkHost?: (hostname: string) => Promise<void>;
  fetch?: typeof fetch;
}

export interface Media {
  /** The URL or path as given; shown to the approver. */
  readonly source: string;
  readonly filename: string;
  /** Detected from the content for images and video, otherwise as declared. */
  readonly contentType: string;
  readonly size: number;
  /** The next `count` bytes, fewer only at the end. */
  read(count: number): Promise<Uint8Array<ArrayBuffer>>;
  /** Releases the file or connection. Safe to call more than once. */
  close(): Promise<void>;
}

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 120_000;
const FILE_PIECE_BYTES = 1024 * 1024;

const ascii = (bytes: Uint8Array, start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));

/** The type an image or video file's first bytes identify, if any. */
export function sniffType(head: Uint8Array): string | undefined {
  if (head[0] === 0x89 && ascii(head, 1, 4) === "PNG") return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (ascii(head, 0, 4) === "GIF8") return "image/gif";
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return "image/webp";
  if (ascii(head, 4, 8) === "ftyp") return ascii(head, 8, 10) === "qt" ? "video/quicktime" : "video/mp4";
  return undefined;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** One line for the approver: what is attached and where it came from. */
export function describeMedia(media: Media): string {
  return `${media.filename} (${media.contentType}, ${formatBytes(media.size)}) from ${media.source}`;
}

/** Appends the attachment lines to the caller's reason, within Alter's audit reason length. */
export function reasonWithMedia(reason: string | undefined, media: Media[], max = 1000): string | undefined {
  if (media.length === 0) return reason;
  const head = `${reason ? `${reason}\n` : ""}Attached (${media.length}):`;
  const lines: string[] = [];
  for (const [index, item] of media.entries()) {
    const line = `\n- ${describeMedia(item)}`;
    const rest = media.length - index;
    const more = rest > 1 ? `\n- and ${rest - 1} more` : "";
    if ((head + lines.join("") + line + more).length > max) {
      lines.push(`\n- and ${rest} more`);
      break;
    }
    lines.push(line);
  }
  return head + lines.join("");
}

function safeFilename(name: string | undefined): string {
  const cleaned = (name ?? "").replace(/[\r\n"\\/]/g, "").trim().slice(0, 200);
  return cleaned || "attachment";
}

function filenameFromUrl(url: URL, disposition: string | null): string {
  const star = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (star) {
    try {
      return safeFilename(decodeURIComponent(star));
    } catch {
      // fall through to the plain parameter
    }
  }
  const plain = disposition?.match(/filename="?([^";]+)"?/i)?.[1];
  if (plain) return safeFilename(plain);
  const last = url.pathname.split("/").filter(Boolean).pop();
  try {
    return safeFilename(last ? decodeURIComponent(last) : undefined);
  } catch {
    return safeFilename(last);
  }
}

/** Reads `count` bytes at a time from a stream of arbitrary pieces. */
function exactReader(pieces: AsyncIterator<Uint8Array>, size: number, source: string, done: () => Promise<void>) {
  let buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let delivered = 0;
  let ended = false;

  return async (count: number): Promise<Uint8Array<ArrayBuffer>> => {
    while (bufferedBytes < count && !ended) {
      const next = await pieces.next();
      if (next.done) {
        ended = true;
        await done();
        break;
      }
      buffered.push(next.value);
      bufferedBytes += next.value.length;
      if (delivered + bufferedBytes > size) {
        ended = true;
        await done();
        throw new MediaError(`${source} is larger than the ${size} bytes it declared.`);
      }
    }
    const take = Math.min(count, bufferedBytes);
    const out = new Uint8Array(take);
    let offset = 0;
    while (offset < take) {
      const first = buffered[0] as Uint8Array;
      const n = Math.min(first.length, take - offset);
      out.set(first.subarray(0, n), offset);
      offset += n;
      if (n === first.length) buffered.shift();
      else buffered[0] = first.subarray(n);
    }
    bufferedBytes -= take;
    delivered += take;
    if (ended && bufferedBytes === 0 && delivered < size && take < count) {
      throw new MediaError(`${source} ended after ${delivered} of the ${size} bytes it declared.`);
    }
    return out;
  };
}

async function fetchPublic(source: string, options: MediaOptions): Promise<{ response: Response; url: URL }> {
  const fetchImpl = options.fetch ?? fetch;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new MediaError(`${source} is not a URL${options.allowFiles ? " or an absolute file path" : ""}.`);
  }
  for (let hop = 0; ; hop += 1) {
    if (url.protocol !== "https:") throw new MediaError(`Only https URLs can be attached (${url.href}).`);
    await options.checkHost?.(url.hostname.replace(/^\[|\]$/g, ""));
    const response = await fetchImpl(url.href, {
      redirect: "manual",
      headers: { "accept-encoding": "identity" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new MediaError(`${source} redirects more than ${MAX_REDIRECTS} times.`);
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new MediaError(`${source} answered HTTP ${response.status}.`);
    }
    return { response, url };
  }
}

async function fromUrl(source: string, maxBytes: number, options: MediaOptions) {
  const { response, url } = await fetchPublic(source, options);
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") {
    await response.body?.cancel();
    throw new MediaError(`${source} is served compressed (${encoding}), so its size is unknown and it cannot be attached.`);
  }
  const declared = Number(response.headers.get("content-length"));
  if (!Number.isFinite(declared) || declared <= 0 || !response.body) {
    await response.body?.cancel();
    throw new MediaError(`${source} does not state its size (no Content-Length), so it cannot be attached.`);
  }
  if (declared > maxBytes) {
    await response.body.cancel();
    throw new MediaError(`${source} is ${formatBytes(declared)}; the limit here is ${formatBytes(maxBytes)}.`);
  }
  const reader = response.body.getReader();
  let finished = false;
  const close = async () => {
    if (finished) return;
    finished = true;
    await reader.cancel().catch(() => undefined);
  };
  const pieces: AsyncIterator<Uint8Array> = {
    next: async () => {
      const { done, value } = await reader.read();
      return done ? { done: true, value: undefined } : { done: false, value };
    },
  };
  return {
    size: declared,
    declaredType: response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase(),
    filename: filenameFromUrl(url, response.headers.get("content-disposition")),
    read: exactReader(pieces, declared, source, close),
    close,
  };
}

async function fromFile(path: string, maxBytes: number) {
  const fs = await import("node:fs/promises");
  const { basename } = await import("node:path");
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(path, "r");
  } catch (error) {
    throw new MediaError(`Cannot read ${path}: ${(error as Error).message}`);
  }
  const { size } = await handle.stat();
  if (size <= 0 || size > maxBytes) {
    await handle.close();
    throw new MediaError(size <= 0 ? `${path} is empty.` : `${path} is ${formatBytes(size)}; the limit here is ${formatBytes(maxBytes)}.`);
  }
  let position = 0;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  const pieces: AsyncIterator<Uint8Array> = {
    next: async () => {
      const buffer = new Uint8Array(FILE_PIECE_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      position += bytesRead;
      return bytesRead === 0 ? { done: true, value: undefined } : { done: false, value: buffer.subarray(0, bytesRead) };
    },
  };
  return { size, declaredType: undefined, filename: safeFilename(basename(path)), read: exactReader(pieces, size, path, close), close };
}

/**
 * Opens media for reading. Nothing beyond the first bytes is read until the
 * caller asks, and reading past `maxBytes` (or past the declared size) fails.
 */
export async function openMedia(source: string, maxBytes: number, options: MediaOptions): Promise<Media> {
  const trimmed = source.trim();
  const isPath = trimmed.startsWith("/");
  if (isPath && !options.allowFiles) {
    throw new MediaError("File paths work only when the server runs on your computer. Give an https URL anyone can open.");
  }
  const opened = isPath ? await fromFile(trimmed, maxBytes) : await fromUrl(trimmed, maxBytes, options);
  let head: Uint8Array<ArrayBuffer>;
  try {
    head = await opened.read(Math.min(16, opened.size));
  } catch (error) {
    await opened.close();
    throw error;
  }
  let pending: Uint8Array<ArrayBuffer> | undefined = head;
  return {
    source: trimmed,
    filename: opened.filename,
    contentType: sniffType(head) ?? opened.declaredType ?? "application/octet-stream",
    size: opened.size,
    close: opened.close,
    async read(count) {
      if (!pending) return opened.read(count);
      const first: Uint8Array<ArrayBuffer> = pending;
      pending = undefined;
      if (first.length >= count) {
        if (first.length > count) pending = first.subarray(count);
        return first.subarray(0, count);
      }
      const rest = await opened.read(count - first.length);
      const out = new Uint8Array(first.length + rest.length);
      out.set(first, 0);
      out.set(rest, first.length);
      return out;
    },
  };
}

function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  );
}

/** True for loopback, private, link-local, shared, multicast and reserved addresses. */
export function isPrivateAddress(address: string): boolean {
  const lower = address.toLowerCase();
  if (!lower.includes(":")) return isPrivateIPv4(lower);
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPrivateIPv4(mapped);
  return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || lower.startsWith("ff");
}

/**
 * Refuses a host that is, or resolves to, a private address. For a server
 * running on the user's computer; the check happens before the fetch, so a
 * host that changes its address in between is not caught.
 */
export async function rejectPrivateHost(hostname: string): Promise<void> {
  const { isIP } = await import("node:net");
  const { lookup } = await import("node:dns/promises");
  const addresses = isIP(hostname) ? [hostname] : (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new MediaError(`${hostname} is not a public address; only public URLs can be attached.`);
  }
}
