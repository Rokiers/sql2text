import type { ConnectionConfig, AppConfig } from "../config.js";

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  key: string;
  default: string | null;
  extra: string;
  comment: string;
}

export interface TableInfo {
  name: string;
  database: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  rowCount: number;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  type: string;
}

export interface ForeignKeyInfo {
  name: string;
  column: string;
  refTable: string;
  refColumn: string;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionTimeMs: number;
}

export interface DatabaseDriver {
  readonly name: string;
  readonly type: string;

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  listDatabases(): Promise<string[]>;
  listTables(database?: string): Promise<string[]>;
  describeTable(table: string, database?: string): Promise<TableInfo>;
  query(sql: string, limit: number, timeout: number): Promise<QueryResult>;
  explainQuery(sql: string): Promise<QueryResult>;
  getIndexes(table: string, database?: string): Promise<IndexInfo[]>;
  getForeignKeys(table: string, database?: string): Promise<ForeignKeyInfo[]>;
}
