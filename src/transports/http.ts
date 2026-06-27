import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

function log(msg: string) {
  const ts = new Date().toISOString().replace("T", " ").substring(0, 19);
  console.error(`[${ts}] ${msg}`);
}

interface HttpServerOptions {
  port: number;
  host: string;
  apiKey: string;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function authMiddleware(apiKey: string, req: http.IncomingMessage): boolean {
  const auth = req.headers.authorization;
  if (!auth) return false;
  if (!auth.startsWith("Bearer ")) return false;
  return auth.slice(7) === apiKey;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export function createHttpServer(
  server: McpServer,
  options: HttpServerOptions
): http.Server {
  const { port, host, apiKey } = options;

  const transport = new StreamableHTTPServerTransport();

  const httpServer = http.createServer(
    async (req: http.IncomingMessage, res: http.ServerResponse) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Accept");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = req.url || "/";

      // Health check — no auth required
      if (url === "/health" && req.method === "GET") {
        sendJson(res, 200, { status: "ok", mode: "http", driver: "connected" });
        return;
      }

      // Auth check for all MCP endpoints
      if (!authMiddleware(apiKey, req)) {
        sendJson(res, 401, {
          error: "Unauthorized",
          message: "Valid Bearer token required. Set Authorization: Bearer <apiKey> header.",
        });
        return;
      }

      try {
        // Parse body for POST requests
        let parsedBody: unknown = undefined;
        if (req.method === "POST" && url === "/sse") {
          const raw = await readBody(req);
          if (raw) parsedBody = JSON.parse(raw);
        }

        // Delegate everything to StreamableHTTPServerTransport
        // It handles GET (SSE stream), POST (JSON-RPC), DELETE (session close) automatically
        await transport.handleRequest(req, res, parsedBody);
      } catch (err) {
        log(
          `HTTP error: ${err instanceof Error ? err.message : String(err)}`
        );
        if (!res.headersSent) {
          sendJson(res, 500, { error: "Internal server error" });
        }
      }
    }
  );

  // Connect MCP server to transport
  server.connect(transport).then(() => {
    log("MCP Server connected to Streamable HTTP transport");
  });

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log(
        `Port ${port} is already in use. Choose a different port or stop the other process.`
      );
      process.exit(1);
    }
    throw err;
  });

  return httpServer;
}
