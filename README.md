# sql2text

> MCP Server — read-only database access for AI coding agents. Let your AI assistant explore schemas, suggest queries, and generate code from your database — safely.

## What it does

sql2text is an [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that connects AI models (Claude Code, Reasonix, Cursor, etc.) to your **MySQL** or **SQLite** databases. All access is strictly read-only — the server enforces a SQL allowlist at the query-validation layer, so the model can explore and query but never mutate data.

### Tools exposed to the AI

| Tool | Description |
|---|---|
| `list_databases` | List all databases on the server |
| `list_tables` | List all tables in a database |
| `describe_table` | Full structure: columns, indexes, foreign keys, row count |
| `get_schema_overview` | Complete schema at a glance — all tables, columns, PKs, FKs |
| `query` | Execute read-only SQL (SELECT / SHOW / DESCRIBE / EXPLAIN / WITH) |
| `explain_query` | Run EXPLAIN on a query to see the execution plan |
| `get_table_indexes` | List indexes on a table |
| `get_foreign_keys` | List foreign-key relationships for a table |
| `suggest_queries` | Generate useful starter queries based on table structure |

## Quick start

### 1. Install

```bash
npm install -g sql2text
```

### 2. Configure

Create a `config.json`:

```json
{
  "connections": [
    {
      "name": "my-db",
      "type": "mysql",
      "host": "localhost",
      "port": 3306,
      "user": "readonly_user",
      "password": "your_password",
      "database": "my_database"
    }
  ],
  "settings": {
    "defaultLimit": 100,
    "queryTimeoutMs": 30000,
    "logQueries": false
  }
}
```

For SQLite:

```json
{
  "connections": [
    {
      "name": "my-sqlite",
      "type": "sqlite",
      "path": "./data/local.db"
    }
  ]
}
```

### 3. Register with your AI tool

**Reasonix** (`~/.reasonix/config.json`):

```json
{
  "mcpServers": {
    "sql2text": {
      "command": "sql2text",
      "env": {
        "SQL2TEXT_CONFIG": "/path/to/your/config.json"
      }
    }
  }
}
```

**Claude Code** (`.mcp.json` or `~/.claude/mcp.json`):

```json
{
  "mcpServers": {
    "sql2text": {
      "command": "sql2text",
      "env": {
        "SQL2TEXT_CONFIG": "/path/to/your/config.json"
      }
    }
  }
}
```

### 4. Use it

Start a session with your AI agent and ask things like:

- *"Show me the schema of my database"*
- *"What tables are related to `orders`?"*
- *"Write a query to find the top 10 customers by revenue"*
- *"Suggest indexes that might speed up this query"*

## Security: read-only by design

sql2text enforces read-only access at **two independent layers**:

1. **SQL allowlist** — every query is validated against a whitelist of allowed statement types (`SELECT`, `SHOW`, `DESCRIBE`, `EXPLAIN`, `WITH`). INSERT/UPDATE/DELETE/DROP/ALTER and 30+ other mutation keywords are statically blocked before execution. Multiple-statement injection (semicolons) is also detected and rejected.

2. **Session-level enforcement** (MySQL) — the driver sets `SET SESSION TRANSACTION READ ONLY` on each connection, so even if the agent generated a mutation (it can't — layer 1 blocks it), the database server itself would reject it.

## Database support

| Database | Status | Driver |
|---|---|---|
| MySQL / MariaDB | ✅ Supported | `mysql2` |
| SQLite | ✅ Supported | `sql.js` (in-memory, no native deps) |
| PostgreSQL | 🔜 Planned | — |

## Configuration reference

### `connections` (required)

Array of connection objects. The first connection is used as the active one.

**MySQL connection:**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | ✅ | — | Display name |
| `type` | `"mysql"` | ✅ | — | Connection type |
| `host` | string | ✅ | — | Hostname or IP |
| `port` | number | — | `3306` | Port |
| `user` | string | ✅ | — | Username |
| `password` | string | ✅ | — | Password |
| `database` | string | ✅ | — | Default database |

**SQLite connection:**

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | ✅ | — | Display name |
| `type` | `"sqlite"` | ✅ | — | Connection type |
| `path` | string | ✅ | — | Path to `.db` file |

### `settings` (optional)

| Field | Type | Default | Description |
|---|---|---|---|
| `defaultLimit` | number | `100` | Max rows returned by `query` |
| `queryTimeoutMs` | number | `30000` | Query timeout in ms |
| `logQueries` | boolean | `false` | Log every query to stderr |

### Environment variables

| Variable | Description |
|---|---|
| `SQL2TEXT_CONFIG` | Path to config file (overrides `./config.json`) |

## Architecture

```
src/
├── index.ts          # Entry point — CLI + MCP server bootstrap
├── server.ts         # Tool registration (list_databases, query, etc.)
├── config.ts         # Config loading + Zod validation
├── drivers/
│   ├── base.ts       # DatabaseDriver interface
│   ├── mysql.ts      # MySQL driver (mysql2 connection pool)
│   └── sqlite.ts     # SQLite driver (sql.js in-process)
└── guards/
    └── readonly.ts   # SQL allowlist validation + multi-statement detection
```

## License

MIT
