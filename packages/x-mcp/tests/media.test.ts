import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { MediaError, type Media, isPrivateAddress, openMedia, reasonWithMedia, sniffType } from "../src/media.js";

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>;

function respond(body: Uint8Array<ArrayBuffer> | null, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(body, { status, headers: body ? { "content-length": String(body.length), ...headers } : headers });
}

test("file types are recognised from their first bytes", () => {
  assert.equal(sniffType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "image/png");
  assert.equal(sniffType(bytes(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
  assert.equal(sniffType(text("GIF89a")), "image/gif");
  assert.equal(sniffType(text("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffType(text("\0\0\0\x18ftypisom")), "video/mp4");
  assert.equal(sniffType(text("\0\0\0\x14ftypqt  ")), "video/quicktime");
  assert.equal(sniffType(text("%PDF-1.7")), undefined);
});

test("a URL is read in exact pieces, with its type, size and file name", async () => {
  const body = text("GIF89a-0123456789");
  const media = await openMedia("https://cdn.example.com/files/loop.gif?v=2", 1024, {
    allowFiles: false,
    fetch: (async () => respond(body, { "content-type": "image/gif" })) as typeof fetch,
  });
  assert.equal(media.contentType, "image/gif");
  assert.equal(media.size, body.length);
  assert.equal(media.filename, "loop.gif");
  const pieces = [await media.read(4), await media.read(10), await media.read(10), await media.read(10)];
  assert.deepEqual(pieces.map((piece) => piece.length), [4, 10, 3, 0]);
  assert.equal(new TextDecoder().decode(Buffer.concat(pieces)), "GIF89a-0123456789");
});

test("only public https URLs of a stated, uncompressed size within the limit are read", async () => {
  const fetchOf = (response: () => Response) => ({ allowFiles: false, fetch: (async () => response()) as typeof fetch });
  await assert.rejects(openMedia("http://cdn.example.com/a.png", 100, fetchOf(() => respond(text("x")))), /Only https URLs/);
  await assert.rejects(openMedia("not a url", 100, fetchOf(() => respond(text("x")))), /is not a URL\./);
  await assert.rejects(openMedia("https://cdn.example.com/a", 100, fetchOf(() => respond(null))), /does not state its size/);
  await assert.rejects(
    openMedia("https://cdn.example.com/a", 100, fetchOf(() => respond(text("x"), { "content-encoding": "gzip" }))),
    /served compressed \(gzip\)/,
  );
  await assert.rejects(openMedia("https://cdn.example.com/a", 3, fetchOf(() => respond(text("toolong")))), /is 7 B; the limit here is 3 B/);
  await assert.rejects(openMedia("https://cdn.example.com/a", 100, fetchOf(() => respond(null, {}, 404))), /answered HTTP 404/);
});

test("redirects are followed with every host checked, and a private host is refused", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (input: string) =>
    input.startsWith("https://short.example/")
      ? new Response(null, { status: 302, headers: { location: "https://cdn.example.com/a.png" } })
      : respond(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))) as unknown as typeof fetch;
  const media = await openMedia("https://short.example/x", 100, {
    allowFiles: false,
    fetch: fetchImpl,
    checkHost: async (host) => {
      seen.push(host);
    },
  });
  assert.equal(media.contentType, "image/png");
  assert.deepEqual(seen, ["short.example", "cdn.example.com"]);
  await assert.rejects(
    openMedia("https://short.example/x", 100, {
      allowFiles: false,
      fetch: fetchImpl,
      checkHost: async (host) => {
        if (host === "cdn.example.com") throw new MediaError(`${host} is not a public address`);
      },
    }),
    /cdn\.example\.com is not a public address/,
  );
});

test("a body shorter or longer than its declared size fails", async () => {
  const declared = (body: string, length: number) => ({
    allowFiles: false,
    fetch: (async () => new Response(text(body), { headers: { "content-length": String(length) } })) as typeof fetch,
  });
  await assert.rejects(openMedia("https://cdn.example.com/a", 100, declared("abc", 10)), /ended after 3 of the 10 bytes/);
  await assert.rejects(openMedia("https://cdn.example.com/a", 100, declared("x".repeat(40), 20)), /larger than the 20 bytes it declared/);
});

test("files are read only when allowed, from absolute paths", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "media-")), "clip.mp4");
  writeFileSync(path, text("\0\0\0\x18ftypisom-video"));
  await assert.rejects(openMedia(path, 100, { allowFiles: false }), /File paths work only when the server runs on your computer/);
  const media = await openMedia(path, 100, { allowFiles: true });
  assert.equal(media.contentType, "video/mp4");
  assert.equal(media.filename, "clip.mp4");
  assert.equal((await media.read(100)).length, 18);
  await media.close();
  await media.close();
  await assert.rejects(openMedia(`${path}.missing`, 100, { allowFiles: true }), /Cannot read/);
});

test("private and reserved addresses are recognised", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "104.16.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("the approval reason lists every attachment, and summarizes what does not fit", () => {
  const item = (n: number): Media => ({
    source: `https://cdn.example.com/${"x".repeat(60)}/${n}.png`,
    filename: `${n}.png`,
    contentType: "image/png",
    size: 2048,
    read: async () => new Uint8Array(),
    close: async () => undefined,
  });
  assert.equal(reasonWithMedia("Why", []), "Why");
  assert.equal(reasonWithMedia(undefined, [item(1)]), `Attached (1):\n- 1.png (image/png, 2 KB) from ${item(1).source}`);
  const many = reasonWithMedia("Launch", Array.from({ length: 20 }, (_, n) => item(n)), 1000) ?? "";
  assert.ok(many.length <= 1000);
  assert.match(many, /^Launch\nAttached \(20\):/);
  assert.match(many, /\n- and \d+ more$/);
});
