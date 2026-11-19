// Every server carries an identical copy of src/alter.ts (the Alter client,
// approval handling and error messages) so each package publishes on its own
// with no internal dependency. This check keeps the copies from drifting.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../packages/", import.meta.url).pathname;
const copies = readdirSync(root).map((name) => ({
  name,
  text: readFileSync(join(root, name, "src", "alter.ts"), "utf8"),
}));
const [first, ...rest] = copies;
const drifted = rest.filter((copy) => copy.text !== first.text);
if (drifted.length > 0) {
  console.error(
    `src/alter.ts differs from packages/${first.name}/src/alter.ts in: ${drifted
      .map((copy) => `packages/${copy.name}`)
      .join(", ")}. Keep every copy identical.`,
  );
  process.exit(1);
}
console.log(`src/alter.ts identical across ${copies.length} packages`);
