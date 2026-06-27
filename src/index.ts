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

function log(msg: string) {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
  console.error(`[${ts}] ${msg}`);
}

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
    log(`Connected to ${primaryConnection.name} (${primaryConnection.type})`);

    const server = new McpServer({
      name: "sql2text",
      version: "1.0.0",
    });

    const clusters = loadClusters(config.settings.clustersPath);
    registerTools(server, driver, config.settings, clusters);

    const mode = resolveMode(config.settings.apiKey);

    const cleanup = async () => {
      log("Shutting down...");
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
          log(`HTTP server listening on http://${host}:${port}`);
          log(`MCP endpoint: http://${host}:${port}/sse`);
          log(`Health check: http://${host}:${port}/health`);
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
      log("MCP Server ready (stdio)");
    }
  } catch (err) {
    log(
      `Failed to start: ${err instanceof Error ? err.message : String(err)}`
    );
    await driver.disconnect().catch(() => {});
    process.exit(1);
  }
}

main().catch((err) => {
  log(
    `Fatal error: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
});
