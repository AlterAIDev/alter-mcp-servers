#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createAlterCaller, loadConfig } from "./alter.js";
import { apiVersionFrom } from "./linkedin.js";
import { SERVER_NAME, createLinkedInServer } from "./server.js";

async function main(): Promise<void> {
  let caller;
  let apiVersion;
  try {
    apiVersion = apiVersionFrom(process.env);
    caller = createAlterCaller(loadConfig(process.env), "linkedin", SERVER_NAME);
  } catch (error) {
    // A missing or malformed key or version: one clear line, no stack trace.
    console.error(`${SERVER_NAME}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
  const server = createLinkedInServer(caller, { apiVersion });
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
