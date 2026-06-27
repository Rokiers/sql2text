#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { MySQLDriver } from "./drivers/mysql.js";
import { SQLiteDriver } from "./drivers/sqlite.js";
import type { DatabaseDriver } from "./drivers/base.js";
import { registerTools } from "./server.js";
import { loadClusters } from "./analysis/clusters.js";
import { createHttpServer } from "./transports/http.js";

function parseModeArg(): "http" | "stdio" | null {
  const i = process.argv.indexOf("--mode");
  if (i === -1) return null;
  const val = process.argv[i + 1];
  if (val === "http" || val === "stdio") return val;
  return null;
}

function resolveMode(configApiKey?: string): "http" | "stdio" {
  const arg = parseModeArg();
  if (arg) return arg;
  if (configApiKey) return "http";
  return "stdio";
}

async function main() {
  const config = loadConfig();

  if (config.connections.length === 0) {
    throw new Error(
      "No database connections configured. Add at least one connection to config.json."
    );
  }

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
      throw new Error(
        `Unsupported database type: ${(primaryConnection as { type: string }).type}`
      );
  }

  try {
    await driver.connect();
    console.error(
      `[sql2text] Connected to ${primaryConnection.name} (${primaryConnection.type})`
    );

    const server = new McpServer({
      name: "sql2text",
      version: "1.0.0",
    });

    const clusters = loadClusters(config.settings.clustersPath);
    registerTools(server, driver, config.settings, clusters);

    const mode = resolveMode(config.settings.apiKey);

    const cleanup = async () => {
      console.error("[sql2text] Shutting down...");
      await driver.disconnect();
      await server.close();
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

    if (mode === "http") {
      const apiKey = config.settings.apiKey!;
      const { port, host } = config.settings;

      const httpServer = createHttpServer(server, { port, host, apiKey });

      await new Promise<void>((resolve) => {
        httpServer.listen(port, host, () => {
          console.error(
            `[sql2text] HTTP server listening on http://${host}:${port}`
          );
          console.error(`[sql2text] MCP endpoint: http://${host}:${port}/sse`);
          console.error(
            `[sql2text] Health check: http://${host}:${port}/health`
          );
          resolve();
        });
      });

      process.on("SIGINT", () => {
        httpServer.close(() => cleanup());
      });
      process.on("SIGTERM", () => {
        httpServer.close(() => cleanup());
      });
    } else {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.error("[sql2text] MCP Server ready (stdio)");
    }
  } catch (err) {
    console.error(
      `[sql2text] Failed to start: ${err instanceof Error ? err.message : String(err)}`
    );
    await driver.disconnect().catch(() => {});
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(
    `[sql2text] Fatal error: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
});
