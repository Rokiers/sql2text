import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { DatabaseDriver } from "./drivers/base.js";
import type { AppSettings } from "./config.js";
import type { ClusterManager } from "./analysis/clusters.js";
import { profileTable } from "./analysis/profiler.js";
import type { ColumnProfile } from "./analysis/profiler.js";

function registerTools(
  server: McpServer,
  driver: DatabaseDriver,
  settings: AppSettings,
  clusters: ClusterManager | null
) {
  const label = `[${driver.name}:${driver.type}]`;

  // ── list_databases ───
  server.registerTool(
    "list_databases",
    { description: "List all databases available on the server" },
    async () => {
      const dbs = await driver.listDatabases();
      return textResult(
        `${label} Databases (${dbs.length}):\n${dbs.map((d) => `  • ${d}`).join("\n")}`
      );
    }
  );

  // ── list_tables ───
  server.registerTool(
    "list_tables",
    {
      description:
        "List all tables in the current database or a specified database",
      inputSchema: {
        database: z
          .string()
          .optional()
          .describe("Optional database name to list tables from"),
      },
    },
    async ({ database }) => {
      const tables = await driver.listTables(database);
      return textResult(
        `${label} Tables (${tables.length}):\n${tables.map((t) => `  • ${t}`).join("\n")}`
      );
    }
  );

  // ── describe_table ───
  server.registerTool(
    "describe_table",
    {
      description: "Get the full structure of a table including columns, indexes, foreign keys, and row count",
      inputSchema: {
        table: z.string().describe("The table name to describe"),
        database: z.string().optional().describe("Optional database name"),
      },
    },
    async ({ table, database }) => {
      const info = await driver.describeTable(table, database);
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
  );

  // ── get_schema_overview ───
  server.registerTool(
    "get_schema_overview",
    {
      description: "Get a complete overview of the database schema — all tables with their columns and relationships",
      inputSchema: {
        database: z.string().optional().describe("Optional database name"),
      },
    },
    async ({ database }) => {
      const tables = await driver.listTables(database);
      const lines = [
        `${label} Schema Overview`,
        `Total tables: ${tables.length}`,
        "",
      ];
      for (const table of tables) {
        const info = await driver.describeTable(table, database);
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
  );

  // ── query ───
  server.registerTool(
    "query",
    {
      description: "Execute a READ-ONLY SQL query (only SELECT, SHOW, DESCRIBE, EXPLAIN, WITH allowed). Results are auto-limited.",
      inputSchema: {
        sql: z.string().describe("The SQL query to execute (SELECT only)"),
        database: z
          .string()
          .optional()
          .describe("Optional database name to switch to"),
        limit: z
          .number()
          .optional()
          .default(settings.defaultLimit)
          .describe(`Maximum rows returned (default: ${settings.defaultLimit})`),
      },
    },
    async ({ sql, database, limit }) => {
      const result = await driver.query(sql, limit, settings.queryTimeoutMs);
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
        const sep =
          "│ " + widths.map((w) => "─".repeat(w)).join(" │ ") + " │";
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
  );

  // ── explain_query ───
  server.registerTool(
    "explain_query",
    {
      description: "Analyze a SQL query with EXPLAIN to show the execution plan and index usage",
      inputSchema: {
        sql: z.string().describe("The SQL query to analyze with EXPLAIN"),
        database: z.string().optional().describe("Optional database name"),
      },
    },
    async ({ sql, database }) => {
      const result = await driver.explainQuery(sql);
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
        const sep =
          "│ " + widths.map((w) => "─".repeat(w)).join(" │ ") + " │";
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
  );

  // ── get_indexes ───
  server.registerTool(
    "get_indexes",
    {
      description: "Get all indexes for a specific table",
      inputSchema: {
        table: z.string().describe("The table name"),
        database: z.string().optional().describe("Optional database name"),
      },
    },
    async ({ table, database }) => {
      const indexes = await driver.getIndexes(table, database);
      if (indexes.length === 0) {
        return textResult(`No indexes found on table '${table}'`);
      }
      const lines = [`Indexes on '${table}':`];
      for (const idx of indexes) {
        const t = idx.unique ? "UNIQUE" : "INDEX";
        lines.push(
          `  • ${idx.name} (${t}, ${idx.type}): ${idx.columns.join(", ")}`
        );
      }
      return textResult(lines.join("\n"));
    }
  );

  // ── get_foreign_keys ───
  server.registerTool(
    "get_foreign_keys",
    {
      description: "Get all foreign key relationships for a specific table",
      inputSchema: {
        table: z.string().describe("The table name"),
        database: z.string().optional().describe("Optional database name"),
      },
    },
    async ({ table, database }) => {
      const fks = await driver.getForeignKeys(table, database);
      if (fks.length === 0) {
        return textResult(`No foreign keys found on table '${table}'`);
      }
      const lines = [`Foreign keys on '${table}':`];
      for (const fk of fks) {
        lines.push(
          `  • ${fk.name}: ${fk.column} → ${fk.refTable}.${fk.refColumn}`
        );
      }
      return textResult(lines.join("\n"));
    }
  );

  // ── sample_data ───
  server.registerTool(
    "sample_data",
    {
      description: "Preview the first N rows from a table to understand its data",
      inputSchema: {
        table: z.string().describe("The table name to preview"),
        limit: z
          .number()
          .optional()
          .default(10)
          .describe("Number of rows to preview (default: 10, max: 100)"),
        database: z.string().optional().describe("Optional database name"),
      },
    },
    async ({ table, limit, database }) => {
      const safeLimit = Math.min(limit, 100);
      const sql = `SELECT * FROM \`${table.replace(/`/g, "``")}\` LIMIT ${safeLimit}`;
      const result = await driver.query(sql, safeLimit, settings.queryTimeoutMs);
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
        const sep =
          "│ " + widths.map((w) => "─".repeat(w)).join(" │ ") + " │";
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
  );

  // ── suggest_query ───
  server.registerTool(
    "suggest_query",
    {
      description: "Get query suggestions for common analysis tasks on a table, based on its schema",
      inputSchema: {
        table: z
          .string()
          .describe("The table name to get suggestions for"),
        database: z.string().optional().describe("Optional database name"),
      },
    },
    async ({ table, database }) => {
      const info = await driver.describeTable(table, database);
      const suggestions: string[] = [];

      suggestions.push(
        `-- Total row count\nSELECT COUNT(*) FROM \`${table}\`;\n`
      );

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
  );

  // ── list_clusters ───
  server.registerTool(
    "list_clusters",
    { description: "List all configured business clusters — groups of related tables with their relationships" },
    async () => {
      if (!clusters) {
        return textResult(
          "No business clusters configured. Create a clusters.json file to define table groupings."
        );
      }
      const list = clusters.listClusters();
      if (list.length === 0) {
        return textResult("No clusters defined in clusters.json");
      }
      const lines = [`Business Clusters (${list.length})`, ""];
      for (const c of list) {
        lines.push(`[${c.name}] ${c.description || ""} (${c.tableCount} tables)`);
        for (const t of c.tables) {
          lines.push(`  • ${t}`);
        }
        lines.push("");
      }
      return textResult(lines.join("\n"));
    }
  );

  // ── get_table_cluster ───
  server.registerTool(
    "get_table_cluster",
    {
      description: "Get all business clusters a table belongs to, including related tables and their field-level relationships",
      inputSchema: {
        table: z.string().describe("The table name to look up"),
      },
    },
    async ({ table }) => {
      if (!clusters) {
        return textResult(
          "No business clusters configured. Create a clusters.json file to define table groupings."
        );
      }
      const results = clusters.getTableCluster(table);
      if (results.length === 0) {
        return textResult(
          `Table '${table}' is not assigned to any business cluster.`
        );
      }
      const lines = [`'${table}' belongs to ${results.length} cluster(s):`, ""];
      for (const cluster of results) {
        lines.push(`[${cluster.name}] ${cluster.description || ""}`);
        for (const [tName, tInfo] of Object.entries(cluster.tables)) {
          const marker = tName === table ? " ◀ current" : "";
          lines.push(`  ${tName}${marker}${tInfo.description ? ` — ${tInfo.description}` : ""}`);
          if (tInfo.refs) {
            for (const [field, targets] of Object.entries(tInfo.refs)) {
              for (const target of targets) {
                lines.push(`    ${tName}.${field} → ${target}`);
              }
            }
          }
        }
        lines.push("");
      }
      return textResult(lines.join("\n"));
    }
  );

  // ── get_column_profile ───
  server.registerTool(
    "get_column_profile",
    {
      description: "Profile column data — value distribution, numeric stats, date ranges, or text length/samples. Filters out NULL and empty strings for text columns.",
      inputSchema: {
        table: z.string().describe("The table name"),
        column: z
          .string()
          .optional()
          .describe("Specific column name. If omitted, profiles all columns."),
        database: z.string().optional().describe("Optional database name"),
      },
    },
    async ({ table, column, database }) => {
      const profiles = await profileTable(driver, table, column);
      const lines: string[] = [];

      for (const p of profiles) {
        lines.push(`${table}.${p.name} (${p.type})`);
        if (p.comment) lines.push(`  comment: ${p.comment}`);

        const validCount = p.totalRows - p.nullCount - p.emptyCount;
        const parts = [`total: ${p.totalRows}`, `NULL: ${p.nullCount}`];
        if (p.emptyCount > 0) parts.push(`empty: ${p.emptyCount}`);
        parts.push(`valid: ${validCount}`);
        lines.push(`  ${parts.join(", ")}`);

        if (p.distribution && p.distribution.length > 0) {
          lines.push("  distribution:");
          for (const d of p.distribution) {
            const pct =
              validCount > 0
                ? ` (${((d.count / validCount) * 100).toFixed(1)}%)`
                : "";
            lines.push(`    ${d.value} → ${d.count}${pct}`);
          }
        }

        if (p.numericStats) {
          lines.push(
            `  stats: min=${p.numericStats.min}, max=${p.numericStats.max}, avg=${p.numericStats.avg}`
          );
        }

        if (p.dateRange) {
          lines.push(`  range: ${p.dateRange.min} ~ ${p.dateRange.max}`);
        }

        if (p.lengthStats) {
          lines.push(
            `  length: avg=${p.lengthStats.avgLength}, min=${p.lengthStats.minLength}, max=${p.lengthStats.maxLength}`
          );
        }

        if (p.samples && p.samples.length > 0) {
          lines.push("  samples (first 100 chars):");
          for (let i = 0; i < p.samples.length; i++) {
            lines.push(`    ${i + 1}. ${p.samples[i]}`);
          }
        }

        lines.push("");
      }

      return textResult(lines.join("\n"));
    }
  );
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

export { registerTools };
