#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createAlterCaller, loadConfig } from "./alter.js";
import { SERVER_NAME, createGmailServer } from "./server.js";

async function main(): Promise<void> {
  let caller;
  try {
    caller = createAlterCaller(loadConfig(process.env), "google", SERVER_NAME);
  } catch (error) {
    // A missing or malformed key: one clear line, no stack trace.
    console.error(`${SERVER_NAME}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const server = createGmailServer(caller);
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
