import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { DatabaseDriver } from "./drivers/base.js";
import type { AppSettings } from "./config.js";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

function registerTools(
  server: Server,
  driver: DatabaseDriver,
  settings: AppSettings
) {
  const label = `[${driver.name}:${driver.type}]`;

  const tools: ToolDef[] = [
    {
      name: "list_databases",
      description: "List all databases available on the server",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "list_tables",
      description:
        "List all tables in the current database or a specified database",
      inputSchema: {
        type: "object",
        properties: {
          database: {
            type: "string",
            description: "Optional database name to list tables from",
          },
        },
      },
    },
    {
      name: "describe_table",
      description:
        "Get the full structure of a table including columns, indexes, foreign keys, and row count",
      inputSchema: {
        type: "object",
        properties: {
          table: { type: "string", description: "The table name to describe" },
          database: { type: "string", description: "Optional database name" },
        },
        required: ["table"],
      },
    },
    {
      name: "get_schema_overview",
      description:
        "Get a complete overview of the database schema — all tables with their columns and relationships",
      inputSchema: {
        type: "object",
        properties: {
          database: { type: "string", description: "Optional database name" },
        },
      },
    },
    {
      name: "query",
      description:
        "Execute a READ-ONLY SQL query (only SELECT, SHOW, DESCRIBE, EXPLAIN, WITH allowed). Results are auto-limited.",
      inputSchema: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description: "The SQL query to execute (SELECT only)",
          },
          database: {
            type: "string",
            description: "Optional database name to switch to",
          },
          limit: {
            type: "number",
            description: `Maximum rows returned (default: ${settings.defaultLimit})`,
          },
        },
        required: ["sql"],
      },
    },
    {
      name: "explain_query",
      description:
        "Analyze a SQL query with EXPLAIN to show the execution plan and index usage",
      inputSchema: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description: "The SQL query to analyze with EXPLAIN",
          },
          database: { type: "string", description: "Optional database name" },
        },
        required: ["sql"],
      },
    },
    {
      name: "get_indexes",
      description: "Get all indexes for a specific table",
      inputSchema: {
        type: "object",
        properties: {
          table: { type: "string", description: "The table name" },
          database: { type: "string", description: "Optional database name" },
        },
        required: ["table"],
      },
    },
    {
      name: "get_foreign_keys",
      description: "Get all foreign key relationships for a specific table",
      inputSchema: {
        type: "object",
        properties: {
          table: { type: "string", description: "The table name" },
          database: { type: "string", description: "Optional database name" },
        },
        required: ["table"],
      },
    },
    {
      name: "sample_data",
      description:
        "Preview the first N rows from a table to understand its data",
      inputSchema: {
        type: "object",
        properties: {
          table: {
            type: "string",
            description: "The table name to preview",
          },
          limit: {
            type: "number",
            description: "Number of rows to preview (default: 10, max: 100)",
          },
          database: { type: "string", description: "Optional database name" },
        },
        required: ["table"],
      },
    },
    {
      name: "suggest_query",
      description:
        "Get query suggestions for common analysis tasks on a table, based on its schema",
      inputSchema: {
        type: "object",
        properties: {
          table: {
            type: "string",
            description: "The table name to get suggestions for",
          },
          database: { type: "string", description: "Optional database name" },
        },
        required: ["table"],
      },
    },
  ];

  // ── Handler: list tools ───
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools,
  }));

  // ── Handler: call tool ───
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    // args might be undefined or null in some clients
    const params = (args ?? {}) as Record<string, unknown>;

    try {
      switch (name) {
        case "list_databases": {
          const dbs = await driver.listDatabases();
          return textResult(
            `${label} Databases (${dbs.length}):\n${dbs.map((d) => `  • ${d}`).join("\n")}`
          );
        }

        case "list_tables": {
          const tables = await driver.listTables(
            params.database as string | undefined
          );
          return textResult(
            `${label} Tables (${tables.length}):\n${tables.map((t) => `  • ${t}`).join("\n")}`
          );
        }

        case "describe_table": {
          const info = await driver.describeTable(
            params.table as string,
            params.database as string | undefined
          );
          const lines = [
            `Table: ${info.name}  (${info.columns.length} cols, ~${info.rowCount.toLocaleString()} rows)`,
            `Database: ${info.database}`,
            "",
            "─ Columns ─",
          ];
          for (const col of info.columns) {
            const flags: string[] = [];
            if (col.key === "PRI") flags.push("PK");
            if (col.key === "UNI") flags.push("UNIQUE");
            if (col.key === "MUL") flags.push("INDEXED");
            if (!col.nullable) flags.push("NOT NULL");
            if (col.extra) flags.push(col.extra);
            if (col.default !== null) flags.push(`DEFAULT ${col.default}`);
            lines.push(
              `  ${col.name.padEnd(30)} ${col.type.padEnd(20)} ${flags.join(" ") || "-"}`
            );
            if (col.comment) lines.push(`    └ comment: ${col.comment}`);
          }

          if (info.indexes.length > 0) {
            lines.push("", "─ Indexes ─");
            for (const idx of info.indexes) {
              const t = idx.unique ? "UNIQUE" : "INDEX";
              lines.push(
                `  ${idx.name} (${t}, ${idx.type}): ${idx.columns.join(", ")}`
              );
            }
          }

          if (info.foreignKeys.length > 0) {
            lines.push("", "─ Foreign Keys ─");
            for (const fk of info.foreignKeys) {
              lines.push(
                `  ${fk.name}: ${fk.column} → ${fk.refTable}.${fk.refColumn}`
              );
            }
          }
          return textResult(lines.join("\n"));
        }

        case "get_schema_overview": {
          const tables = await driver.listTables(
            params.database as string | undefined
          );
          const lines = [
            `${label} Schema Overview`,
            `Total tables: ${tables.length}`,
            "",
          ];
          for (const table of tables) {
            const info = await driver.describeTable(
              table,
              params.database as string | undefined
            );
            const pkCols = info.columns
              .filter((c) => c.key === "PRI")
              .map((c) => c.name)
              .join(", ");
            const fkInfo =
              info.foreignKeys.length > 0
                ? " → " +
                  info.foreignKeys
                    .map((fk) => `${fk.refTable}.${fk.refColumn}`)
                    .join(", ")
                : "";
            lines.push(
              `┌─ ${info.name} (${info.columns.length} cols, ~${info.rowCount.toLocaleString()} rows)${pkCols ? ` PK: ${pkCols}` : ""}${fkInfo}`
            );
            for (const col of info.columns) {
              const marks: string[] = [];
              if (col.key === "PRI") marks.push("🔑");
              if (col.key === "MUL" || col.key === "UNI") marks.push("🔍");
              if (!col.nullable) marks.push("•");
              lines.push(
                `│  ${(marks.join("") || "  ").padEnd(4)} ${col.name.padEnd(28)} ${col.type}`
              );
            }
            lines.push("│");
          }
          return textResult(lines.join("\n"));
        }

        case "query": {
          const limit = (params.limit as number) ?? settings.defaultLimit;
          const result = await driver.query(
            params.sql as string,
            limit,
            settings.queryTimeoutMs
          );
          const lines = [
            `Query OK. ${result.rowCount} rows, ${result.executionTimeMs}ms`,
          ];
          if (result.rowCount === limit)
            lines.push(`(Result limited to ${limit} rows)`);
          lines.push("");
          if (result.rows.length === 0) {
            lines.push("(empty result set)");
          } else {
            const cols = result.columns;
            const widths = cols.map((col) =>
              Math.max(
                col.length,
                ...result.rows.map((r) => String(r[col] ?? "NULL").length)
              )
            );
            const sep = "│ " + widths.map((w) => "─".repeat(w)).join(" │ ") + " │";
            const hdr =
              "│ " +
              cols.map((c, i) => c.padEnd(widths[i])).join(" │ ") +
              " │";
            lines.push(sep.replace(/─/g, "━"));
            lines.push(hdr);
            lines.push(sep);
            for (const row of result.rows) {
              const vals = cols
                .map((c, i) => {
                  const v = row[c];
                  if (v === null) return "NULL";
                  return String(v).padEnd(widths[i]);
                })
                .join(" │ ");
              lines.push("│ " + vals + " │");
            }
            lines.push(sep);
          }
          return textResult(lines.join("\n"));
        }

        case "explain_query": {
          const result = await driver.explainQuery(params.sql as string);
          const lines = [`EXPLAIN result (${result.executionTimeMs}ms)`, ""];
          if (result.rows.length === 0) {
            lines.push("(empty result)");
          } else {
            const cols = result.columns;
            const widths = cols.map((col) =>
              Math.max(
                col.length,
                ...result.rows.map((r) => String(r[col] ?? "").length)
              )
            );
            const sep = "│ " + widths.map((w) => "─".repeat(w)).join(" │ ") + " │";
            const hdr =
              "│ " +
              cols.map((c, i) => c.padEnd(widths[i])).join(" │ ") +
              " │";
            lines.push(sep.replace(/─/g, "━"));
            lines.push(hdr);
            lines.push(sep);
            for (const row of result.rows) {
              const vals = cols
                .map((c, i) => {
                  const v = row[c];
                  if (v === null) return "NULL";
                  return String(v).padEnd(widths[i]);
                })
                .join(" │ ");
              lines.push("│ " + vals + " │");
            }
            lines.push(sep);
          }
          return textResult(lines.join("\n"));
        }

        case "get_indexes": {
          const indexes = await driver.getIndexes(
            params.table as string,
            params.database as string | undefined
          );
          if (indexes.length === 0) {
            return textResult(
              `No indexes found on table '${params.table}'`
            );
          }
          const lines = [`Indexes on '${params.table}':`];
          for (const idx of indexes) {
            const t = idx.unique ? "UNIQUE" : "INDEX";
            lines.push(
              `  • ${idx.name} (${t}, ${idx.type}): ${idx.columns.join(", ")}`
            );
          }
          return textResult(lines.join("\n"));
        }

        case "get_foreign_keys": {
          const fks = await driver.getForeignKeys(
            params.table as string,
            params.database as string | undefined
          );
          if (fks.length === 0) {
            return textResult(
              `No foreign keys found on table '${params.table}'`
            );
          }
          const lines = [`Foreign keys on '${params.table}':`];
          for (const fk of fks) {
            lines.push(
              `  • ${fk.name}: ${fk.column} → ${fk.refTable}.${fk.refColumn}`
            );
          }
          return textResult(lines.join("\n"));
        }

        case "sample_data": {
          const raw = (params.limit as number) ?? 10;
          const safeLimit = Math.min(raw, 100);
          const table = params.table as string;
          const sql = `SELECT * FROM \`${table.replace(/`/g, "``")}\` LIMIT ${safeLimit}`;
          const result = await driver.query(
            sql,
            safeLimit,
            settings.queryTimeoutMs
          );
          const lines = [
            `Sample from '${table}' (${result.rowCount} of ${safeLimit} rows)`,
            "",
          ];
          if (result.rows.length === 0) {
            lines.push("(empty table)");
          } else {
            const cols = result.columns.slice(0, 8);
            const widths = cols.map((col) =>
              Math.min(
                40,
                Math.max(
                  col.length,
                  ...result.rows.map((r) => String(r[col] ?? "NULL").length)
                )
              )
            );
            const sep = "│ " + widths.map((w) => "─".repeat(w)).join(" │ ") + " │";
            const hdr =
              "│ " +
              cols.map((c, i) => c.padEnd(widths[i])).join(" │ ") +
              " │";
            lines.push(sep.replace(/─/g, "━"));
            lines.push(hdr);
            lines.push(sep);
            for (const row of result.rows) {
              const vals = cols
                .map((c, i) => {
                  const v = row[c];
                  if (v === null) return "NULL";
                  const s = String(v);
                  return s.length > widths[i]
                    ? s.substring(0, widths[i] - 1) + "…"
                    : s.padEnd(widths[i]);
                })
                .join(" │ ");
              lines.push("│ " + vals + " │");
            }
            lines.push(sep);
            if (result.columns.length > 8) {
              lines.push(`(Showing ${8} of ${result.columns.length} columns)`);
            }
          }
          return textResult(lines.join("\n"));
        }

        case "suggest_query": {
          const table = params.table as string;
          const info = await driver.describeTable(
            table,
            params.database as string | undefined
          );
          const suggestions: string[] = [];

          // Basic count
          suggestions.push(
            `-- Total row count\nSELECT COUNT(*) FROM \`${table}\`;\n`
          );

          // Nullable columns
          const nullableCols = info.columns.filter(
            (c) => c.nullable && c.key !== "PRI"
          );
          if (nullableCols.length > 0) {
            suggestions.push("-- Check for NULL values");
            for (const col of nullableCols.slice(0, 3)) {
              suggestions.push(
                `SELECT COUNT(*) as null_count FROM \`${table}\` WHERE \`${col.name}\` IS NULL;`
              );
            }
            suggestions.push("");
          }

          // Date/time columns
          const dateCols = info.columns.filter((c) =>
            /date|time|timestamp/i.test(c.type)
          );
          if (dateCols.length > 0) {
            suggestions.push("-- Date range analysis");
            for (const col of dateCols.slice(0, 2)) {
              suggestions.push(
                `SELECT MIN(\`${col.name}\`), MAX(\`${col.name}\`), COUNT(*) FROM \`${table}\`;`
              );
            }
            suggestions.push("");
          }

          // Enum-like columns
          const enumCols = info.columns.filter((c) =>
            /enum|char\(|varchar\(/i.test(c.type)
          );
          if (enumCols.length > 0) {
            suggestions.push("-- Value distribution");
            for (const col of enumCols.slice(0, 2)) {
              suggestions.push(
                `SELECT \`${col.name}\`, COUNT(*) as cnt FROM \`${table}\` GROUP BY \`${col.name}\` ORDER BY cnt DESC LIMIT 20;`
              );
            }
            suggestions.push("");
          }

          // Numeric columns
          const numCols = info.columns.filter((c) =>
            /int|float|double|decimal|number/i.test(c.type)
          );
          if (numCols.length > 0) {
            suggestions.push("-- Numeric statistics");
            for (const col of numCols.slice(0, 2)) {
              suggestions.push(
                `SELECT AVG(\`${col.name}\`), MIN(\`${col.name}\`), MAX(\`${col.name}\`), SUM(\`${col.name}\`) FROM \`${table}\`;`
              );
            }
            suggestions.push("");
          }

          // Foreign key joins
          if (info.foreignKeys.length > 0) {
            suggestions.push("-- Join with related tables");
            for (const fk of info.foreignKeys.slice(0, 3)) {
              suggestions.push(
                `SELECT * FROM \`${table}\` t JOIN \`${fk.refTable}\` r ON t.\`${fk.column}\` = r.\`${fk.refColumn}\` LIMIT 10;`
              );
            }
            suggestions.push("");
          }

          if (suggestions.length === 0) {
            suggestions.push(`SELECT * FROM \`${table}\` LIMIT 10;`);
          }

          return textResult(
            `Query suggestions for '${table}':\n\n${suggestions.join("\n")}`
          );
        }

        default:
          return errorResult(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return errorResult(
        `Tool '${name}' failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });
}

function textResult(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
  };
}

function errorResult(text: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text }],
  };
}

export { registerTools, type ToolDef };
