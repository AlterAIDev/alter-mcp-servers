import assert from "node:assert/strict";
import { test } from "node:test";

import { BODY_STYLE, bodyHtml, buildRawMessage, formatAddress, signatureText } from "../src/gmail.js";

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

test("sender display names are written plain, quoted or encoded as needed", () => {
  assert.equal(formatAddress({ email: "a@example.com" }), "a@example.com");
  assert.equal(formatAddress({ email: "a@example.com", name: "Sam Rivera" }), "Sam Rivera <a@example.com>");
  assert.equal(formatAddress({ email: "a@example.com", name: 'Sam "S" Rivera, CEO' }), '"Sam \\"S\\" Rivera, CEO" <a@example.com>');
  assert.equal(formatAddress({ email: "a@example.com", name: "Zoë\r\nBcc: x" }), "=?UTF-8?B?Wm/DqyBCY2M6IHg=?= <a@example.com>");
});

test("the HTML version sets a font and turns bullet lines into a spaced list", () => {
  const html = bodyHtml("Hey Ana,\n\nWe built:\n\n- one URL\n\n- no tokens <ever>\n* audit\n\nCode: https://example.com\nThanks,");
  assert.equal(
    html,
    'Hey Ana,<br><br>We built:<ul style="margin:8px 0 12px;padding-left:24px"><li style="margin:0 0 8px">one URL</li><li style="margin:0 0 8px">no tokens &lt;ever&gt;</li><li style="margin:0 0 8px">audit</li></ul>Code: https://example.com<br>Thanks,',
  );
  assert.equal(bodyHtml("No list\nhere"), "No list<br>here");
  const raw = Buffer.from(
    buildRawMessage({ to: ["a@example.com"], subject: "Hi", body: "x", signatureHtml: "<div>Sig</div>" }),
    "base64url",
  ).toString("utf8");
  const htmlPart = raw.split("text/html")[1] ?? "";
  const decoded = Buffer.from(htmlPart.split("\r\n\r\n")[1]?.split("\r\n--")[0]?.replace(/\s/g, "") ?? "", "base64").toString("utf8");
  assert.ok(decoded.startsWith(`<div dir="ltr" style="${BODY_STYLE}"><div>x</div>`));
});
