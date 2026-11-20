// Every MCP server carries identical copies of the shared modules so each
// package publishes on its own with no internal dependency:
// - src/alter.ts: the Alter client, approval handling and error messages
// - src/hosted.ts: remote hosting on Cloudflare, signing people in through Alter
// This check keeps the copies from drifting.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SHARED = ["alter.ts", "hosted.ts"];
const root = new URL("../packages/", import.meta.url).pathname;
const servers = readdirSync(root).filter((name) => name.endsWith("-mcp"));

let failed = false;
for (const file of SHARED) {
  const copies = servers.map((name) => ({
    name,
    text: readFileSync(join(root, name, "src", file), "utf8"),
  }));
  const [first, ...rest] = copies;
  const drifted = rest.filter((copy) => copy.text !== first.text);
  if (drifted.length > 0) {
    failed = true;
    console.error(
      `src/${file} differs from packages/${first.name}/src/${file} in: ${drifted
        .map((copy) => `packages/${copy.name}`)
        .join(", ")}. Keep every copy identical.`,
    );
  } else {
    console.log(`src/${file} identical across ${copies.length} servers`);
  }
}
if (failed) process.exit(1);
