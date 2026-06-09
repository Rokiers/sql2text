# sql2text

MCP Server providing **read-only** database access for AI coding agents (opencode, Claude Desktop, Cursor, etc.) to explore schemas, run queries, and get SQL suggestions. Zero write capability — safe for production databases.

## Features

- **Read-only by design** — SQL whitelist (SELECT/SHOW/DESCRIBE/EXPLAIN only), blacklist for DML/DDL, MySQL session-level READ ONLY, multi-statement injection guard, automatic LIMIT enforcement
- **10 MCP tools** — list databases, list tables, describe table, schema overview, sample data, query execution, EXPLAIN analysis, index/foreign key inspection, and smart query suggestions
- **Multi-driver** — MySQL, SQLite (sql.js, no native compilation needed)
- **Zero-config** — drop `config.json` with connection info, add to opencode config, done

## Quick Start

```bash
git clone <this-repo>
cd sql2text
npm install
npm run build
```

### 1. Configure database connection

```json
{
  "connections": [
    {
      "name": "my-mysql",
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
    "queryTimeoutMs": 30000
  }
}
```

### 2. Add to opencode / Claude Desktop / Cursor

**opencode** — add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "sql2text": {
      "type": "local",
      "command": ["node", "/path/to/sql2text/dist/index.js"],
      "environment": {
        "SQL2TEXT_CONFIG": "/path/to/sql2text/config.json"
      },
      "enabled": true
    }
  }
}
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sql2text": {
      "command": "node",
      "args": ["/path/to/sql2text/dist/index.js"],
      "env": {
        "SQL2TEXT_CONFIG": "/path/to/sql2text/config.json"
      }
    }
  }
}
```

## MCP Tools

| Tool | Description |
|---|---|
| `list_databases` | List all available databases |
| `list_tables` | List all tables in a database |
| `describe_table` | Full table structure — columns, indexes, foreign keys, row count |
| `get_schema_overview` | Complete database schema overview with all tables |
| `get_indexes` | Show indexes for a table |
| `get_foreign_keys` | Show foreign key relationships |
| `sample_data` | Preview first N rows from a table |
| `query` | Execute read-only SQL (SELECT/SHOW/DESCRIBE/EXPLAIN only) |
| `explain_query` | Analyze query execution plan |
| `suggest_query` | Get query suggestions based on table schema |

## Security

- **Whitelist**: SELECT, SHOW, DESCRIBE, EXPLAIN, USE, SET, WITH (CTE)
- **Blacklist**: INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, REPLACE, GRANT, REVOKE, KILL, and more
- **Session guard**: `SET SESSION TRANSACTION READ ONLY` (MySQL), `PRAGMA query_only = ON` (SQLite)
- **Multi-statement injection**: Semicolons inside string literals are ignored, multiple bare statements blocked
- **Auto LIMIT**: Every SELECT auto-appends `LIMIT` (default 100) if not present

## Story

sql2text was born from a practical need: I manage a MySQL database with 227 tables and wanted AI coding agents to help me understand and query it — without any risk of data modification. This MCP server bridges that gap, giving AI assistants structured, safe, read-only access to explore schemas, suggest queries, and help with data analysis.

## Roadmap

- [ ] Multi-connection support (query across multiple databases in one session)
- [ ] ORM code generation (TypeORM, Prisma, Drizzle, Sequelize, SQLAlchemy)
- [ ] PostgreSQL and SQL Server drivers
- [ ] ER diagram text output from foreign key relationships
- [ ] Export schema as Markdown / JSON / SQLAlchemy models

## License

MIT
