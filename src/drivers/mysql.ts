import mysql2 from "mysql2/promise";
import type {
  DatabaseDriver,
  ColumnInfo,
  TableInfo,
  IndexInfo,
  ForeignKeyInfo,
  QueryResult,
} from "./base.js";
import type { ConnectionConfig, MySQLConnectionConfig } from "../config.js";
import { validateSql } from "../guards/readonly.js";

export class MySQLDriver implements DatabaseDriver {
  readonly name: string;
  readonly type = "mysql";

  private pool: mysql2.Pool | null = null;
  private config: MySQLConnectionConfig;

  constructor(config: MySQLConnectionConfig) {
    this.config = config;
    this.name = config.name;
  }

  async connect(): Promise<void> {
    const baseConfig: mysql2.PoolOptions = {
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      database: this.config.database,
      waitForConnections: true,
      connectionLimit: 3,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      // Read-only optimizations
      multipleStatements: false,
    };

    this.pool = mysql2.createPool(baseConfig);

    // Verify connection
    const conn = await this.pool.getConnection();

    // Enforce read-only at session level
    await conn.query("SET SESSION TRANSACTION READ ONLY");
    conn.release();
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async listDatabases(): Promise<string[]> {
    return this.withConnection(async (conn) => {
      const [rows] = await conn.query("SHOW DATABASES");
      return (rows as Record<string, string>[]).map(
        (r) => r.Database || r.database || Object.values(r)[0]
      );
    });
  }

  async listTables(database?: string): Promise<string[]> {
    return this.withConnection(async (conn) => {
      if (database) {
        await conn.query(`USE \`${database}\``);
      }
      const [rows] = await conn.query("SHOW TABLES");
      return (rows as Record<string, string>[]).map(
        (r) =>
          r[`Tables_in_${database || this.config.database}`] ||
          Object.values(r)[0]
      );
    });
  }

  async describeTable(table: string, database?: string): Promise<TableInfo> {
    return this.withConnection(async (conn) => {
      const db = database || this.config.database;
      if (database) {
        await conn.query(`USE \`${database}\``);
      }

      // Get columns
      const [colRows] = await conn.query("SHOW FULL COLUMNS FROM `" + table.replace(/`/g, "``") + "`");
      const columns: ColumnInfo[] = (colRows as Record<string, string>[]).map(
        (r) => ({
          name: r.Field,
          type: r.Type,
          nullable: r.Null === "YES",
          key: r.Key || "",
          default: r.Default,
          extra: r.Extra || "",
          comment: r.Comment || "",
        })
      );

      // Get create statement for additional info
      const [createRows] = await conn.query(
        "SHOW CREATE TABLE `" + table.replace(/`/g, "``") + "`"
      );
      const createSQL =
        createRows && (createRows as Record<string, string>[]).length > 0
          ? ((createRows as Record<string, string>[])[0]["Create Table"] || "")
          : "";

      // Get indexes
      const indexes = await this.getIndexes(table);

      // Get foreign keys
      const foreignKeys = await this.getForeignKeys(table);

      // Get row count
      const [countRows] = await conn.query(
        "SELECT COUNT(*) as cnt FROM `" + table.replace(/`/g, "``") + "`"
      );
      const rowCount = Number(
        (countRows as Record<string, number>[])[0]?.cnt || 0
      );

      return {
        name: table,
        database: db,
        columns,
        indexes,
        foreignKeys,
        rowCount,
      };
    });
  }

  async query(
    sql: string,
    limit: number,
    timeout: number
  ): Promise<QueryResult> {
    const validation = validateSql(sql);
    if (!validation.valid) {
      throw new Error(`Query rejected: ${validation.reason}`);
    }

    return this.withConnection(async (conn) => {
      // Add LIMIT if not present and it's a SELECT
      let finalSql = sql.trim();
      if (
        /^\s*SELECT/i.test(finalSql) &&
        !/LIMIT\s+\d+/i.test(finalSql)
      ) {
        finalSql = finalSql.replace(/;?\s*$/, "");
        finalSql += ` LIMIT ${limit}`;
      }

      const start = Date.now();
      const [rows, fields] = await conn.query({
        sql: finalSql,
        timeout,
      });

      const rowData = rows as Record<string, unknown>[];
      const columns = fields
        ? (fields as mysql2.FieldPacket[]).map((f: { name: string }) => f.name)
        : rowData.length > 0
          ? Object.keys(rowData[0])
          : [];

      return {
        columns,
        rows: rowData,
        rowCount: rowData.length,
        executionTimeMs: Date.now() - start,
      };
    });
  }

  async explainQuery(sql: string): Promise<QueryResult> {
    const validation = validateSql(sql);
    if (!validation.valid) {
      throw new Error(`Cannot EXPLAIN this query: ${validation.reason}`);
    }

    return this.withConnection(async (conn) => {
      const start = Date.now();
      const explainSql = "EXPLAIN " + sql.trim();
      const [rows] = await conn.query(explainSql);
      const rowData = rows as Record<string, unknown>[];

      return {
        columns: rowData.length > 0 ? Object.keys(rowData[0]) : [],
        rows: rowData,
        rowCount: rowData.length,
        executionTimeMs: Date.now() - start,
      };
    });
  }

  async getIndexes(
    table: string,
    _database?: string
  ): Promise<IndexInfo[]> {
    return this.withConnection(async (conn) => {
      const [rows] = await conn.query(
        "SHOW INDEX FROM `" + table.replace(/`/g, "``") + "`"
      );
      const data = rows as Record<string, string>[];

      // Group by index name
      const indexMap = new Map<string, IndexInfo>();
      for (const row of data) {
        const name = row.Key_name;
        if (!indexMap.has(name)) {
          indexMap.set(name, {
            name,
            columns: [],
            unique: row.Non_unique === "0",
            type: row.Index_type || "BTREE",
          });
        }
        const idx = indexMap.get(name)!;
        const colIndex = Number(row.Seq_in_index) - 1;
        idx.columns[colIndex] = row.Column_name;
      }

      return [...indexMap.values()];
    });
  }

  async getForeignKeys(
    table: string,
    _database?: string
  ): Promise<ForeignKeyInfo[]> {
    return this.withConnection(async (conn) => {
      try {
        // Get from information_schema
        const [rows] = await conn.query(
          `SELECT
            CONSTRAINT_NAME as name,
            COLUMN_NAME as \`column\`,
            REFERENCED_TABLE_NAME as refTable,
            REFERENCED_COLUMN_NAME as refColumn
          FROM information_schema.KEY_COLUMN_USAGE
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = ?
            AND REFERENCED_TABLE_NAME IS NOT NULL`,
          [table]
        );
        return (rows as ForeignKeyInfo[]);
      } catch {
        // Fallback: parse from CREATE TABLE
        return [];
      }
    });
  }

  private async withConnection<T>(
    fn: (conn: mysql2.PoolConnection) => Promise<T>
  ): Promise<T> {
    if (!this.pool) {
      throw new Error("MySQL driver not connected");
    }

    const conn = await this.pool.getConnection();
    try {
      return await fn(conn);
    } finally {
      conn.release();
    }
  }
}
