#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createAlterCaller, loadConfig } from "./alter.js";
import { type MediaOptions, rejectPrivateHost } from "./media.js";
import { SERVER_NAME, createXServer } from "./server.js";

/** Running on the user's own computer: attachments may be local files, and URLs must be public. */
const LOCAL_MEDIA: MediaOptions = { allowFiles: true, checkHost: rejectPrivateHost };

async function main(): Promise<void> {
  let caller;
  try {
    caller = createAlterCaller(loadConfig(process.env), "twitter", SERVER_NAME);
  } catch (error) {
    // A missing or malformed key: one clear line, no stack trace.
    console.error(`${SERVER_NAME}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const server = createXServer(caller, { media: LOCAL_MEDIA });
  const shutdown = async () => {
    await server.close();
    await caller.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(`${SERVER_NAME} failed to start`, error);
  process.exit(1);
});
