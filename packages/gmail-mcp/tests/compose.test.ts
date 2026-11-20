import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRawMessage, signatureText } from "../src/gmail.js";

const decode = (raw: string) => Buffer.from(raw, "base64url").toString("utf8");

test("a message with no signature or attachments stays a single text part", () => {
  const raw = decode(buildRawMessage({ to: ["a@example.com"], subject: "Hi", body: "x" }));
  assert.match(raw, /\r\nContent-Type: text\/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\neA==\r\n$/);
});

test("signatures become readable text: line breaks, links with their address, entities", () => {
  assert.equal(
    signatureText('<div>Jane Roe<br/>CEO, <b>Acme</b></div><div><a href="https://acme.example">acme.example</a> | <a href="https://acme.example/demo">Book a demo</a></div><p>&lt;3 &#8212; &#x2014;&nbsp;x</p>'),
    "Jane Roe\nCEO, Acme\nhttps://acme.example | Book a demo <https://acme.example/demo>\n<3 — — x",
  );
});

test("a non-ASCII attachment name is encoded per RFC 2231, and line breaks are stripped", () => {
  const raw = decode(
    buildRawMessage({
      to: ["a@example.com"],
      subject: "Hi",
      body: "x",
      attachments: [{ filename: "résumé\r\n.pdf", contentType: "application/pdf", data: new Uint8Array([1, 2]) }],
    }),
  );
  assert.match(raw, /Content-Type: application\/pdf; name\*=UTF-8''r%C3%A9sum%C3%A9\.pdf\r\nContent-Disposition: attachment; filename\*=UTF-8''r%C3%A9sum%C3%A9\.pdf\r\n/);
});
