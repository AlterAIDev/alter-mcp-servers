import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRawMessage, encodeHeaderText, extractText, htmlToText, truncate } from "../src/gmail.js";

const decodeRaw = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

test("builds a plain-text RFC 822 message with CRLF line endings", () => {
  const message = decodeRaw(
    buildRawMessage({
      to: ["a@example.com", "b@example.com"],
      cc: ["c@example.com"],
      subject: "Hello",
      body: "Line one\nLine two",
    }),
  );
  const [head, body] = message.split("\r\n\r\n");
  assert.ok(head);
  assert.ok(body);
  assert.match(head, /^To: a@example\.com, b@example\.com\r\nCc: c@example\.com\r\nSubject: Hello\r\n/);
  assert.match(head, /Content-Transfer-Encoding: base64$/);
  assert.equal(Buffer.from(body.replace(/\r\n/g, ""), "base64").toString("utf8"), "Line one\r\nLine two");
});

test("encodes non-ASCII subjects as RFC 2047 words and leaves ASCII alone", () => {
  assert.equal(encodeHeaderText("Plain subject"), "Plain subject");
  const encoded = encodeHeaderText("Café réunion à 9h, merci beaucoup pour votre aide aujourd'hui");
  const words = encoded.split("\r\n ");
  assert.ok(words.length > 1, "long text is split into several encoded words");
  const decoded = words
    .map((word) => Buffer.from(word.replace(/^=\?UTF-8\?B\?|\?=$/g, ""), "base64").toString("utf8"))
    .join("");
  assert.equal(decoded, "Café réunion à 9h, merci beaucoup pour votre aide aujourd'hui");
  for (const word of words) assert.ok(word.length <= 75, `encoded word too long: ${word.length}`);
});

test("adds reply headers when given", () => {
  const message = decodeRaw(
    buildRawMessage({
      to: ["a@example.com"],
      subject: "Re: Hi",
      body: "Thanks",
      inReplyTo: "<abc@mail.example.com>",
      references: "<root@mail.example.com> <abc@mail.example.com>",
    }),
  );
  assert.match(message, /\r\nIn-Reply-To: <abc@mail\.example\.com>\r\n/);
  assert.match(message, /\r\nReferences: <root@mail\.example\.com> <abc@mail\.example\.com>\r\n/);
});

test("extracts the plain-text part first, then HTML as text", () => {
  const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");
  assert.equal(
    extractText({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64("<p>HTML</p>") } },
        { mimeType: "text/plain", body: { data: b64("Plain wins") } },
      ],
    }),
    "Plain wins",
  );
  assert.equal(
    extractText({ mimeType: "text/html", body: { data: b64("<p>Hi&nbsp;there</p><script>x()</script>") } }),
    "Hi there",
  );
  assert.equal(
    extractText({
      mimeType: "multipart/mixed",
      parts: [{ mimeType: "text/plain", filename: "notes.txt", body: { data: b64("attachment") } }],
    }),
    "",
    "an attached text file is not the body",
  );
});

test("converts common HTML to readable text", () => {
  assert.equal(htmlToText("<div>a<br>b</div><p>&lt;c&gt; &amp; d</p>"), "a\nb\n<c> & d");
});

test("cuts long bodies with a marker", () => {
  assert.equal(truncate("abcdef", 3), "abc\n[... cut at 3 characters]");
  assert.equal(truncate("abc", 3), "abc");
});
