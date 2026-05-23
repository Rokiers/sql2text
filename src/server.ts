import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DatabaseDriver } from "./drivers/base.js";
import type { AppSettings } from "./config.js";

export function registerTools(server: McpServer, driver: DatabaseDriver, settings: AppSettings) {
  const driverLabel = `[${driver.name}:${driver.type}]`;

  // ── list_databases ───
  server.tool(
    "list_databases",
    "List all databases available on the server",
    {},
    async () => {
      const dbs = await driver.listDatabases();
      return {
        content: [
          {
            type: "text",
            text: `${driverLabel} Databases (${dbs.length}):\n${dbs.map((d) => `  • ${d}`).join("\n")}`,
          },
        ],
      };
    }
  );

  // ── list_tables ───
  server.tool(
    "list_tables",
    "List all tables in the current database or a specified database",
    {
      database: z
        .string()
        .optional()
        .describe("Optional database name to list tables from"),
    },
    async ({ database }) => {
      const tables = await driver.listTables(database);
      return {
        content: [
          {
            type: "text",
            text: `${driverLabel} Tables (${tables.length}):\n${tables.map((t) => `  • ${t}`).join("\n")}`,
          },
        ],
      };
    }
  );

  // ── describe_table ───
  server.tool(
    "describe_table",
    "Get the full structure of a table including columns, indexes, foreign keys, and row count",
    {
      table: z.string().describe("The table name to describe"),
      database: z.string().optional().describe("Optional database name"),
    },
    async ({ table, database }) => {
      const info = await driver.describeTable(table, database);

      const lines: string[] = [];
      lines.push(`Table: ${info.name}  (${info.columns.length} cols, ~${info.rowCount.toLocaleString()} rows)`);
      lines.push(`Database: ${info.database}`);
      lines.push("");
      lines.push("─ Columns ─");
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
        lines.push("");
        lines.push("─ Indexes ─");
        for (const idx of info.indexes) {
          const type = idx.unique ? "UNIQUE" : "INDEX";
          lines.push(`  ${idx.name} (${type}, ${idx.type}): ${idx.columns.join(", ")}`);
        }
      }

      if (info.foreignKeys.length > 0) {
        lines.push("");
        lines.push("─ Foreign Keys ─");
        for (const fk of info.foreignKeys) {
          lines.push(`  ${fk.name}: ${fk.column} → ${fk.refTable}.${fk.refColumn}`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── get_schema_overview ───
  server.tool(
    "get_schema_overview",
    "Get a complete overview of the database schema - all tables with their columns and relationships",
    {
      database: z.string().optional().describe("Optional database name"),
    },
    async ({ database }) => {
      const tables = await driver.listTables(database);

      const lines: string[] = [];
      lines.push(`${driverLabel} Schema Overview`);
      lines.push(`Total tables: ${tables.length}`);
      lines.push("");

      for (const table of tables) {
        const info = await driver.describeTable(table, database);

        // Table header
        const pkCols = info.columns.filter((c) => c.key === "PRI").map((c) => c.name).join(", ");
        const fkInfo =
          info.foreignKeys.length > 0
            ? " → " + info.foreignKeys.map((fk) => `${fk.refTable}.${fk.refColumn}`).join(", ")
            : "";

        lines.push(
          `┌─ ${info.name} (${info.columns.length} cols, ~${info.rowCount.toLocaleString()} rows)${pkCols ? ` PK: ${pkCols}` : ""}${fkInfo}`
        );

        // Columns
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

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── query ───
  server.tool(
    "query",
    "Execute a READ-ONLY SQL query (only SELECT, SHOW, DESCRIBE, EXPLAIN, WITH allowed). Results are limited by default.",
    {
      sql: z.string().describe("The SQL query to execute (SELECT only)"),
      database: z.string().optional().describe("Optional database name to switch to"),
      limit: z
        .number()
        .optional()
        .default(settings.defaultLimit)
        .describe(`Maximum rows returned (default: ${settings.defaultLimit})`),
    },
    async ({ sql, database, limit }) => {
      const result = await driver.query(sql, limit, settings.queryTimeoutMs);

      const lines: string[] = [];
      lines.push(
        `Query OK. ${result.rowCount} rows, ${result.executionTimeMs}ms`
      );
      if (result.rowCount === limit) {
        lines.push(`(Result limited to ${limit} rows)`);
      }
      lines.push("");

      if (result.rows.length === 0) {
        lines.push("(empty result set)");
      } else {
        // Simple table format
        const widths = result.columns.map((col) =>
          Math.max(
            col.length,
            ...result.rows.map(
              (r) => String(r[col] ?? "NULL").length
            )
          )
        );

        const separator =
          "│ " + widths.map((w) => "─".repeat(w)).join(" │ ") + " │";
        const header =
          "│ " +
          result.columns
            .map((col, i) => col.padEnd(widths[i]))
            .join(" │ ") +
          " │";

        lines.push(separator.replace(/─/g, "━"));
        lines.push(header);
        lines.push(separator);

        for (const row of result.rows) {
          const vals = result.columns
            .map((col, i) => {
              const val = row[col];
              if (val === null) return "NULL";
              return String(val).padEnd(widths[i]);
            })
            .join(" │ ");
          lines.push("│ " + vals + " │");
        }
        lines.push(separator);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── explain_query ───
  server.tool(
    "explain_query",
    "Analyze a SQL query with EXPLAIN to show the execution plan and index usage",
    {
      sql: z.string().describe("The SQL query to analyze with EXPLAIN"),
      database: z.string().optional().describe("Optional database name"),
    },
    async ({ sql, database }) => {
      const result = await driver.explainQuery(sql);

      const lines: string[] = [];
      lines.push(`EXPLAIN result (${result.executionTimeMs}ms)`);
      lines.push("");

      if (result.rows.length === 0) {
        lines.push("(empty result)");
      } else {
        const columns = result.columns;
        const widths = columns.map((col) =>
          Math.max(
            col.length,
            ...result.rows.map((r) => String(r[col] ?? "").length)
          )
        );

        const separator =
          "│ " + widths.map((w) => "─".repeat(w)).join(" │ ") + " │";
        const header =
          "│ " +
          columns.map((col, i) => col.padEnd(widths[i])).join(" │ ") +
          " │";

        lines.push(separator.replace(/─/g, "━"));
        lines.push(header);
        lines.push(separator);

        for (const row of result.rows) {
          const vals = columns
            .map((col, i) => {
              const val = row[col];
              if (val === null) return "NULL";
              return String(val).padEnd(widths[i]);
            })
            .join(" │ ");
          lines.push("│ " + vals + " │");
        }
        lines.push(separator);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── get_indexes ───
  server.tool(
    "get_indexes",
    "Get all indexes for a specific table",
    {
      table: z.string().describe("The table name"),
      database: z.string().optional().describe("Optional database name"),
    },
    async ({ table, database }) => {
      const indexes = await driver.getIndexes(table, database);

      if (indexes.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No indexes found on table '${table}'`,
            },
          ],
        };
      }

      const lines: string[] = [];
      lines.push(`Indexes on '${table}':`);
      for (const idx of indexes) {
        const type = idx.unique ? "UNIQUE" : "INDEX";
        lines.push(`  • ${idx.name} (${type}, ${idx.type}): ${idx.columns.join(", ")}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── get_foreign_keys ───
  server.tool(
    "get_foreign_keys",
    "Get all foreign key relationships for a specific table",
    {
      table: z.string().describe("The table name"),
      database: z.string().optional().describe("Optional database name"),
    },
    async ({ table, database }) => {
      const fks = await driver.getForeignKeys(table, database);

      if (fks.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No foreign keys found on table '${table}'`,
            },
          ],
        };
      }

      const lines: string[] = [];
      lines.push(`Foreign keys on '${table}':`);
      for (const fk of fks) {
        lines.push(`  • ${fk.name}: ${fk.column} → ${fk.refTable}.${fk.refColumn}`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── sample_data ───
  server.tool(
    "sample_data",
    "Preview the first N rows from a table to understand its data",
    {
      table: z.string().describe("The table name to preview"),
      limit: z
        .number()
        .optional()
        .default(10)
        .describe("Number of rows to preview (default: 10, max: 100)"),
      database: z.string().optional().describe("Optional database name"),
    },
    async ({ table, limit, database }) => {
      const safeLimit = Math.min(limit, 100);
      const sql = `SELECT * FROM \`${table.replace(/`/g, "``")}\` LIMIT ${safeLimit}`;
      const result = await driver.query(sql, safeLimit, settings.queryTimeoutMs);

      const lines: string[] = [];
      lines.push(
        `Sample from '${table}' (${result.rowCount} of ${safeLimit} rows)`
      );
      lines.push("");

      if (result.rows.length === 0) {
        lines.push("(empty table)");
      } else {
        const cols = result.columns.slice(0, 8); // Show max 8 columns for readability
        const widths = cols.map((col) =>
          Math.min(
            40,
            Math.max(
              col.length,
              ...result.rows.map(
                (r) => String(r[col] ?? "NULL").length
              )
            )
          )
        );

        const separator =
          "│ " + widths.map((w) => "─".repeat(w)).join(" │ ") + " │";
        const header =
          "│ " +
          cols.map((col, i) => col.padEnd(widths[i])).join(" │ ") +
          " │";

        lines.push(separator.replace(/─/g, "━"));
        lines.push(header);
        lines.push(separator);

        for (const row of result.rows) {
          const vals = cols
            .map((col, i) => {
              const val = row[col];
              if (val === null) return "NULL";
              const s = String(val);
              return s.length > widths[i]
                ? s.substring(0, widths[i] - 1) + "…"
                : s.padEnd(widths[i]);
            })
            .join(" │ ");
          lines.push("│ " + vals + " │");
        }
        lines.push(separator);

        if (result.columns.length > 8) {
          lines.push(
            `(Showing ${8} of ${result.columns.length} columns)`
          );
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── suggest_query ───
  server.tool(
    "suggest_query",
    "Get query suggestions for common analysis tasks on a table, based on its schema",
    {
      table: z.string().describe("The table name to get suggestions for"),
      database: z.string().optional().describe("Optional database name"),
    },
    async ({ table, database }) => {
      const info = await driver.describeTable(table, database);

      const suggestions: string[] = [];

      // Basic count
      suggestions.push(`-- Total row count`);
      suggestions.push(`SELECT COUNT(*) FROM \`${table}\`;\n`);

      // If has nullable columns
      const nullableCols = info.columns.filter((c) => c.nullable && c.key !== "PRI");
      if (nullableCols.length > 0) {
        suggestions.push(`-- Check for NULL values`);
        for (const col of nullableCols.slice(0, 3)) {
          suggestions.push(
            `SELECT COUNT(*) as null_count FROM \`${table}\` WHERE \`${col.name}\` IS NULL;`
          );
        }
        suggestions.push("");
      }

      // If has date/time columns
      const dateCols = info.columns.filter(
        (c) =>
          c.type.toLowerCase().includes("date") ||
          c.type.toLowerCase().includes("time") ||
          c.type.toLowerCase().includes("timestamp")
      );
      if (dateCols.length > 0) {
        suggestions.push(`-- Date range analysis`);
        for (const col of dateCols.slice(0, 2)) {
          suggestions.push(
            `SELECT MIN(\`${col.name}\`), MAX(\`${col.name}\`), COUNT(*) FROM \`${table}\`;`
          );
        }
        suggestions.push("");
      }

      // Enum-like columns (varchar/enum)
      const enumCols = info.columns.filter(
        (c) =>
          c.type.toLowerCase().includes("enum") ||
          c.type.toLowerCase().includes("char(") ||
          c.type.toLowerCase().includes("varchar(")
      );
      if (enumCols.length > 0) {
        suggestions.push(`-- Value distribution`);
        for (const col of enumCols.slice(0, 2)) {
          suggestions.push(
            `SELECT \`${col.name}\`, COUNT(*) as cnt FROM \`${table}\` GROUP BY \`${col.name}\` ORDER BY cnt DESC LIMIT 20;`
          );
        }
        suggestions.push("");
      }

      // Numeric columns for stats
      const numCols = info.columns.filter(
        (c) =>
          c.type.toLowerCase().includes("int") ||
          c.type.toLowerCase().includes("float") ||
          c.type.toLowerCase().includes("double") ||
          c.type.toLowerCase().includes("decimal") ||
          c.type.toLowerCase().includes("number")
      );
      if (numCols.length > 0) {
        suggestions.push(`-- Numeric statistics`);
        for (const col of numCols.slice(0, 2)) {
          suggestions.push(
            `SELECT AVG(\`${col.name}\`), MIN(\`${col.name}\`), MAX(\`${col.name}\`), SUM(\`${col.name}\`) FROM \`${table}\`;`
          );
        }
        suggestions.push("");
      }

      // Foreign key joins
      if (info.foreignKeys.length > 0) {
        suggestions.push(`-- Join with related tables`);
        for (const fk of info.foreignKeys.slice(0, 3)) {
          suggestions.push(
            `SELECT * FROM \`${table}\` t JOIN \`${fk.refTable}\` r ON t.\`${fk.column}\` = r.\`${fk.refColumn}\` LIMIT 10;`
          );
        }
        suggestions.push("");
      }

      if (suggestions.length === 0) {
        suggestions.push(
          `SELECT * FROM \`${table}\` LIMIT 10;`
        );
      }

      return {
        content: [
          {
            type: "text",
            text: `Query suggestions for '${table}':\n\n${suggestions.join("\n")}`,
          },
        ],
      };
    }
  );
}
