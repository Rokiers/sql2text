import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

interface HttpServerOptions {
  port: number;
  host: string;
  apiKey: string;
}

const transports = new Map<string, SSEServerTransport>();

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function authMiddleware(
  apiKey: string,
  req: http.IncomingMessage
): boolean {
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

  const httpServer = http.createServer(
    async (req: http.IncomingMessage, res: http.ServerResponse) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS"
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, Mcp-Session-Id"
      );
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = req.url || "/";
      const urlObj = new URL(url, `http://${host}:${port}`);

      // Health check — no auth required
      if (urlObj.pathname === "/health" && req.method === "GET") {
        sendJson(res, 200, { status: "ok", mode: "http", driver: "connected" });
        return;
      }

      // Auth check for all other endpoints
      if (!authMiddleware(apiKey, req)) {
        sendJson(res, 401, {
          error: "Unauthorized",
          message: "Valid Bearer token required. Set Authorization: Bearer <apiKey> header.",
        });
        return;
      }

      try {
        // SSE endpoint
        if (urlObj.pathname === "/sse" && req.method === "GET") {
          const transport = new SSEServerTransport("/messages", res);
          transports.set(transport.sessionId, transport);

          res.on("close", () => {
            transports.delete(transport.sessionId);
          });

          await transport.start();
          await server.connect(transport);
          return;
        }

        // DELETE session endpoint
        if (urlObj.pathname === "/sse" && req.method === "DELETE") {
          const sessionId = req.headers["mcp-session-id"] as string;
          if (sessionId && transports.has(sessionId)) {
            const transport = transports.get(sessionId)!;
            transports.delete(sessionId);
            await transport.close();
            sendJson(res, 200, { message: "Session closed" });
          } else {
            sendJson(res, 404, { error: "Session not found" });
          }
          return;
        }

        // Message endpoint
        if (urlObj.pathname === "/messages" && req.method === "POST") {
          const sessionId = urlObj.searchParams.get("sessionId");
          if (!sessionId) {
            sendJson(res, 400, { error: "Missing sessionId query parameter" });
            return;
          }

          const transport = transports.get(sessionId);
          if (!transport) {
            sendJson(res, 404, {
              error: "Session not found",
              message: "No active SSE connection for this sessionId. Call GET /sse first.",
            });
            return;
          }

          const body = await readBody(req);
          const parsed = body ? JSON.parse(body) : undefined;
          await transport.handlePostMessage(req, res, parsed);
          return;
        }

        // 404
        sendJson(res, 404, { error: "Not found" });
      } catch (err) {
        console.error(
          `[sql2text] HTTP error: ${err instanceof Error ? err.message : String(err)}`
        );
        if (!res.headersSent) {
          sendJson(res, 500, { error: "Internal server error" });
        }
      }
    }
  );

  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[sql2text] Port ${port} is already in use. Choose a different port or stop the other process.`
      );
      process.exit(1);
    }
    throw err;
  });

  return httpServer;
}
