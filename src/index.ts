#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { MySQLDriver } from "./drivers/mysql.js";
import { SQLiteDriver } from "./drivers/sqlite.js";
import type { DatabaseDriver } from "./drivers/base.js";
import { registerTools } from "./server.js";

async function main() {
  const config = loadConfig();

  if (config.connections.length === 0) {
    throw new Error("No database connections configured. Add at least one connection to config.json.");
  }

  // Create a server for each connection, but the first one is the primary
  // For simplicity, we use the first connection as the active one
  const primaryConnection = config.connections[0];

  let driver: DatabaseDriver;

  switch (primaryConnection.type) {
    case "mysql":
      driver = new MySQLDriver(primaryConnection);
      break;
    case "sqlite":
      driver = new SQLiteDriver(primaryConnection);
      break;
    default:
      throw new Error(`Unsupported database type: ${(primaryConnection as { type: string }).type}`);
  }

  try {
    await driver.connect();
    console.error(`[sql2text] Connected to ${primaryConnection.name} (${primaryConnection.type})`);

    const server = new McpServer({
      name: "sql2text",
      version: "1.0.0",
      description: `${primaryConnection.name} database (${primaryConnection.type}) - Read-only access for schema exploration, querying, and analysis`,
    });

    registerTools(server, driver, config.settings);

    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error(`[sql2text] MCP Server ready. ${Object.keys(server).length} tools registered.`);

    // Handle graceful shutdown
    process.on("SIGINT", async () => {
      console.error("[sql2text] Shutting down...");
      await driver.disconnect();
      await server.close();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      console.error("[sql2text] Shutting down...");
      await driver.disconnect();
      await server.close();
      process.exit(0);
    });
  } catch (err) {
    console.error(
      `[sql2text] Failed to start: ${err instanceof Error ? err.message : String(err)}`
    );
    await driver.disconnect().catch(() => {});
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[sql2text] Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
