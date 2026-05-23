import initSqlJs from "sql.js";
import fs from "node:fs";
import type {
  DatabaseDriver,
  ColumnInfo,
  TableInfo,
  IndexInfo,
  ForeignKeyInfo,
  QueryResult,
} from "./base.js";
import type { ConnectionConfig, SQLiteConnectionConfig } from "../config.js";
import { validateSql } from "../guards/readonly.js";

type SqlJsDatabase = ReturnType<
  Awaited<ReturnType<typeof initSqlJs>>["Database"]["prototype"]
>;

export class SQLiteDriver implements DatabaseDriver {
  readonly name: string;
  readonly type = "sqlite";

  private db: SqlJsDatabase | null = null;
  private config: SQLiteConnectionConfig;

  constructor(config: SQLiteConnectionConfig) {
    this.config = config;
    this.name = config.name;
  }

  async connect(): Promise<void> {
    if (!fs.existsSync(this.config.path)) {
      throw new Error(`SQLite database file not found: ${this.config.path}`);
    }

    const buffer = fs.readFileSync(this.config.path);
    const SQL = await initSqlJs();
    this.db = new SQL.Database(buffer);
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async listDatabases(): Promise<string[]> {
    return [this.config.path];
  }

  async listTables(): Promise<string[]> {
    this.ensureConnected();
    const result = this.db!.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );
    if (!result[0]) return [];
    return result[0].values.map(
      (row: unknown[]) => String(row[0] as string | number)
    );
  }

  async describeTable(
    table: string,
    database?: string
  ): Promise<TableInfo> {
    this.ensureConnected();

    const colResult = this.db!.exec(
      `PRAGMA table_info('${table.replace(/'/g, "''")}')`
    );
    const colRows = colResult[0]?.values || [];

    const columns: ColumnInfo[] = colRows.map((r: unknown[]) => ({
      name: String(r[1]),
      type: String(r[2] ?? ""),
      nullable: r[3] === 0,
      key: Number(r[5]) > 0 ? "PRI" : "",
      default: r[4] !== null ? String(r[4]) : null,
      extra: Number(r[5]) > 0 ? "auto_increment" : "",
      comment: "",
    }));

    const indexes = await this.getIndexes(table);
    const foreignKeys = await this.getForeignKeys(table);

    const countResult = this.db!.exec(
      `SELECT COUNT(*) as cnt FROM "${table.replace(/"/g, '""')}"`
    );
    const rowCount = Number(countResult[0]?.values[0]?.[0] || 0);

    return {
      name: table,
      database: database || this.config.path,
      columns,
      indexes,
      foreignKeys,
      rowCount,
    };
  }

  async query(
    sql: string,
    limit: number,
    _timeout: number
  ): Promise<QueryResult> {
    const validation = validateSql(sql);
    if (!validation.valid) {
      throw new Error(`Query rejected: ${validation.reason}`);
    }

    this.ensureConnected();

    let finalSql = sql.trim();
    if (
      /^\s*SELECT/i.test(finalSql) &&
      !/LIMIT\s+\d+/i.test(finalSql)
    ) {
      finalSql = finalSql.replace(/;?\s*$/, "");
      finalSql += ` LIMIT ${limit}`;
    }

    const start = Date.now();
    const result = this.db!.exec(finalSql);

    if (!result[0]) {
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        executionTimeMs: Date.now() - start,
      };
    }

    const { columns, values } = result[0];
    const rows = values.map((row: unknown[]) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((col: string, i: number) => {
        obj[col] = row[i];
      });
      return obj;
    });

    return {
      columns,
      rows,
      rowCount: rows.length,
      executionTimeMs: Date.now() - start,
    };
  }

  async explainQuery(sql: string): Promise<QueryResult> {
    const validation = validateSql(sql);
    if (!validation.valid) {
      throw new Error(`Cannot EXPLAIN this query: ${validation.reason}`);
    }

    this.ensureConnected();

    const start = Date.now();
    const stmts = this.db!.exec("EXPLAIN QUERY PLAN " + sql.trim());

    if (!stmts[0]) {
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        executionTimeMs: Date.now() - start,
      };
    }

    const { columns, values } = stmts[0];
    const rows = values.map((row: unknown[]) => {
      const obj: Record<string, unknown> = {};
      columns.forEach((col: string, i: number) => {
        obj[col] = row[i];
      });
      return obj;
    });

    return {
      columns,
      rows,
      rowCount: rows.length,
      executionTimeMs: Date.now() - start,
    };
  }

  async getIndexes(table: string): Promise<IndexInfo[]> {
    this.ensureConnected();

    const idxResult = this.db!.exec(
      `PRAGMA index_list('${table.replace(/'/g, "''")}')`
    );
    const idxRows = idxResult[0]?.values || [];

    const indexes: IndexInfo[] = [];
    for (const row of idxRows) {
      const idxName = String(row[1]);
      const infoResult = this.db!.exec(
        `PRAGMA index_info('${idxName.replace(/'/g, "''")}')`
      );
      const infoRows = infoResult[0]?.values || [];

      indexes.push({
        name: idxName,
        columns: infoRows.map((r: unknown[]) => String(r[2])),
        unique: Number(row[2]) === 1,
        type: "BTREE",
      });
    }

    return indexes;
  }

  async getForeignKeys(table: string): Promise<ForeignKeyInfo[]> {
    this.ensureConnected();

    const fkResult = this.db!.exec(
      `PRAGMA foreign_key_list('${table.replace(/'/g, "''")}')`
    );
    const fkRows = fkResult[0]?.values || [];

    return fkRows.map((r: unknown[]) => ({
      name: `fk_${table}_${String(r[3])}`,
      column: String(r[3]),
      refTable: String(r[2]),
      refColumn: String(r[4]),
    }));
  }

  private ensureConnected(): void {
    if (!this.db) {
      throw new Error("SQLite driver not connected");
    }
  }
}
