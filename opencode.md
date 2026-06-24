# sql2text — Project Guide for AI Agents

## Overview

sql2text is an MCP (Model Context Protocol) server that provides **read-only** database access for AI coding agents. It supports MySQL and SQLite, exposes 13 MCP tools for schema exploration, query execution, business cluster lookup, and column profiling. Enforces strict read-only safety guards at both application and database session levels.

## Tech Stack

- **Language**: TypeScript (strict mode, ES2022 target)
- **Module system**: ESM (`"type": "module"` in package.json, `.js` extensions in imports)
- **Runtime**: Node.js
- **Key dependencies**:
  - `@modelcontextprotocol/sdk` ^1.10.1 — MCP protocol SDK, uses `McpServer.registerTool()` API
  - `mysql2` ^3.12.0 — MySQL driver (promise-based connection pool)
  - `sql.js` ^1.12.0 — SQLite driver (WASM-based, no native compilation)
  - `zod` ^3.24.2 — Schema validation for config and tool input schemas
- **Dev dependencies**: `typescript` ^5.7.3, `@types/node` ^22.13.0
- **Typecheck**: `./node_modules/.bin/tsc --noEmit`

## Project Structure

```
sql2text/
├── package.json              # NPM config, scripts, dependencies
├── tsconfig.json             # TypeScript config (rootDir: src, outDir: dist)
├── config.example.json       # Example database connection config
├── config.json               # Actual config (gitignored)
├── clusters.example.json     # Example business cluster definitions
├── clusters.json             # Actual cluster definitions (gitignored, user-maintained)
├── README.md                 # User-facing documentation with Mermaid diagrams
├── .gitignore                # Ignores: node_modules/, dist/, config.json, clusters.json, *.log
└── src/
    ├── index.ts              # Entry point — loads config + clusters, creates driver, starts MCP server
    ├── server.ts             # Registers all 13 MCP tools on the McpServer instance
    ├── config.ts             # Config loading & Zod validation (JSON file, env var support)
    ├── analysis/
    │   ├── clusters.ts       # ClusterManager — loads clusters.json, reverse index, cluster lookup
    │   └── profiler.ts       # Column profiling — type-aware stats, filters NULL/empty for strings
    ├── types/
    │   └── sql.js.d.ts       # Type declarations for sql.js module
    ├── drivers/
    │   ├── base.ts           # DatabaseDriver interface & shared types (ColumnInfo, TableInfo, etc.)
    │   ├── mysql.ts          # MySQLDriver — connection pool, read-only session, all DB operations
    │   └── sqlite.ts         # SQLiteDriver — file-based WASM driver, all DB operations
    └── guards/
        └── readonly.ts       # SQL validation — whitelist/blacklist patterns, injection prevention
```

## Build & Run

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript → dist/
npm run dev          # Watch mode compilation
npm run start        # Run the compiled server (node dist/index.js)
npm run clean        # Remove dist/
```

No test framework is currently configured.

## Configuration

### Database Config (`config.json`)

The server looks for config in this order:
1. `SQL2TEXT_CONFIG` environment variable (path to JSON file)
2. `config.json` in the current working directory
3. `config.json` next to the compiled `dist/index.js`

Config schema (validated by Zod in `src/config.ts`):

```json
{
  "connections": [
    {
      "name": "string",
      "type": "mysql",
      "host": "string",
      "port": 3306,
      "user": "string",
      "password": "string",
      "database": "string"
    }
  ],
  "settings": {
    "defaultLimit": 100,
    "queryTimeoutMs": 30000,
    "logQueries": false,
    "clustersPath": "./clusters.json"
  }
}
```

Connection types: `"mysql"` or `"sqlite"` (discriminated union). SQLite connections use `"path"` instead of host/port/user/password.

Only the **first** connection in the array is used (multi-connection is a roadmap item).

### Business Clusters (`clusters.json`)

User-maintained file that defines **business-level table groupings and field-level relationships**. This is NOT auto-generated — the user writes it to describe how tables relate in their specific business domain.

The server looks for clusters in this order:
1. `settings.clustersPath` in config.json
2. `clusters.json` in the current working directory
3. `clusters.json` next to the compiled `dist/index.js`

If not found, cluster-related tools return a "not configured" message (the server still starts normally).

Schema:

```json
{
  "簇名称": {
    "description": "簇描述",
    "tables": {
      "表名": {
        "description": "表描述",
        "refs": {
          "本表字段": ["其他表.字段", "另一个表.字段"]
        }
      }
    }
  }
}
```

Key points:
- A table can belong to **multiple clusters** (e.g. `order` can be in both "用户系统" and "游戏系统")
- `refs` uses the format `"source_field": ["target_table.target_field"]` — no naming convention restrictions, the user defines exactly which fields relate to which tables
- Validated by Zod in `src/analysis/clusters.ts`

## Architecture

### Entry Point (`src/index.ts`)

1. Loads config via `loadConfig()`
2. Creates the appropriate `DatabaseDriver` (MySQL or SQLite) based on config
3. Calls `driver.connect()` (MySQL sets `SESSION TRANSACTION READ ONLY`)
4. Creates `McpServer` instance
5. Loads clusters via `loadClusters(settings.clustersPath)` (returns `null` if no file)
6. Calls `registerTools(server, driver, settings, clusters)` to register all 13 tools
7. Connects via `StdioServerTransport` (stdin/stdout JSON-RPC)
8. Handles SIGINT/SIGTERM for graceful shutdown

### Driver Layer (`src/drivers/`)

`DatabaseDriver` interface (`base.ts`) defines:
- `connect()` / `disconnect()`
- `listDatabases()` / `listTables(database?)`
- `describeTable(table, database?)` → `TableInfo`
- `query(sql, limit, timeout)` → `QueryResult`
- `explainQuery(sql)` → `QueryResult`
- `getIndexes(table, database?)` → `IndexInfo[]`
- `getForeignKeys(table, database?)` → `ForeignKeyInfo[]`

**MySQLDriver** (`mysql.ts`):
- Uses `mysql2/promise` connection pool (3 connections max)
- Sets `SESSION TRANSACTION READ ONLY` on connect
- `multipleStatements: false` at driver level
- Calls `validateSql()` before executing user queries
- Auto-appends `LIMIT` to SELECT queries without one

**SQLiteDriver** (`sqlite.ts`):
- Reads entire `.db` file into memory via `sql.js` (WASM)
- Uses `PRAGMA` commands for schema introspection
- Same `validateSql()` guard before query execution

### Analysis Layer (`src/analysis/`)

**ClusterManager** (`clusters.ts`):
- Loads and validates `clusters.json` via Zod
- Builds a reverse index: table name → cluster name(s) it belongs to
- `getTableCluster(table)` returns all clusters containing that table with full relationship info
- `listClusters()` returns overview of all clusters

**Profiler** (`profiler.ts`):
- `profileTable(driver, table, column?)` profiles columns dynamically by querying the database
- Type-aware profiling strategy:
  - **Numeric, distinct < 20**: value distribution with counts
  - **Numeric, distinct >= 20**: MIN/MAX/AVG stats + top 20 distribution
  - **Date/timestamp**: MIN ~ MAX range
  - **Short string (varchar/char/enum)**: value distribution, **filters out NULL and empty strings**
  - **Long text (text/longtext/html)**: length stats (avg/min/max) + 3 truncated samples (first 100 chars), **filters out NULL and empty strings**
- All profiling queries go through `driver.query()` which enforces read-only validation
- 15-second timeout per query, errors are silently skipped (partial results returned)

### Read-Only Guard (`src/guards/readonly.ts`)

`validateSql(sql)` returns `{ valid: boolean; reason?: string }`:

1. **Blacklist check**: Rejects SQL containing any of 35 forbidden keywords (INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, REPLACE, GRANT, REVOKE, KILL, etc.)
2. **Whitelist check**: Only allows SQL starting with SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, USE, SET, WITH
3. **Multi-statement check**: Strips string literals, then checks for multiple semicolon-separated statements

`removeStringLiterals()` handles single quotes, double quotes, backticks, and backslash escapes to avoid false positives from keywords inside string values.

### Tool Registration (`src/server.ts`)

All 13 tools registered via `McpServer.registerTool()` with Zod input schemas:

**Schema exploration tools (original 10):**

| Tool | Input Schema | Description |
|---|---|---|
| `list_databases` | (none) | List all databases |
| `list_tables` | `database?` | List tables in a database |
| `describe_table` | `table`, `database?` | Full table structure (columns, indexes, FKs, row count) |
| `get_schema_overview` | `database?` | All tables with columns and relationships |
| `query` | `sql`, `database?`, `limit?` | Execute read-only SQL |
| `explain_query` | `sql`, `database?` | EXPLAIN execution plan |
| `get_indexes` | `table`, `database?` | Index details for a table |
| `get_foreign_keys` | `table`, `database?` | Foreign key relationships |
| `sample_data` | `table`, `limit?`, `database?` | Preview first N rows (max 100, shows max 8 columns) |
| `suggest_query` | `table`, `database?` | Auto-generated query suggestions based on column types |

**Business context tools (new 3):**

| Tool | Input Schema | Description |
|---|---|---|
| `list_clusters` | (none) | List all business clusters defined in clusters.json |
| `get_table_cluster` | `table` | Get all business clusters a table belongs to, with field-level relationships |
| `get_column_profile` | `table`, `column?`, `database?` | Profile column data — distribution, stats, date ranges, text samples. Filters NULL and empty strings for text columns |

All tools return `{ content: [{ type: "text", text: string }] }` via the `textResult()` helper.

## Key Patterns & Conventions

- All internal imports use `.js` extension (ESM requirement): `import { foo } from "./bar.js"`
- No comments in code unless strictly necessary
- `textResult()` helper wraps all tool output as MCP text content
- Table/column names are backtick-escaped to prevent SQL injection: `` `${name.replace(/`/g, "``")}` ``
- Console output goes to `stderr` (`console.error`) to keep `stdout` clean for MCP JSON-RPC
- Driver methods are `async` even for synchronous SQLite operations (interface conformance)
- MySQL uses `withConnection()` pattern for connection pool management
- Analysis modules (`src/analysis/`) use existing `driver.query()` — no direct DB access, no driver interface changes needed

## Adding a New Tool

1. Add the tool registration in `src/server.ts` inside `registerTools()`
2. Define Zod input schema inline
3. Call driver methods or add new methods to the `DatabaseDriver` interface
4. If adding a new driver method, implement it in both `MySQLDriver` and `SQLiteDriver`
5. For analysis-only tools, add logic in `src/analysis/` and call `driver.query()` from there
6. Run `./node_modules/.bin/tsc --noEmit` to typecheck

## Adding a New Driver

1. Create `src/drivers/<name>.ts` implementing `DatabaseDriver` interface from `base.ts`
2. Add connection schema in `src/config.ts` (new Zod literal type in discriminated union)
3. Add `case` in `src/index.ts` switch statement
4. Add dependency to `package.json` if needed

## Security Notes

- `config.json` and `clusters.json` are gitignored — never commit database credentials
- Passwords are in config file, not in code
- MySQL session is set to READ ONLY at the database level
- SQL validation runs before every user-initiated query (including profiler queries)
- `multipleStatements: false` is set at the MySQL driver level as an additional guard

## MCP Integration

The server communicates via **stdio** (stdin/stdout) using JSON-RPC as defined by the MCP specification. To integrate with an MCP client:

```json
{
  "type": "local",
  "command": ["node", "/absolute/path/to/sql2text/dist/index.js"],
  "environment": {
    "SQL2TEXT_CONFIG": "/absolute/path/to/config.json"
  }
}
```
