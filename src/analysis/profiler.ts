import type { DatabaseDriver, ColumnInfo } from "../drivers/base.js";

interface ColumnProfile {
  name: string;
  type: string;
  comment: string;
  totalRows: number;
  nullCount: number;
  emptyCount: number;
  distribution?: { value: string; count: number }[];
  numericStats?: { min: number; max: number; avg: number };
  dateRange?: { min: string; max: string };
  lengthStats?: { avgLength: number; minLength: number; maxLength: number };
  samples?: string[];
}

function esc(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

function isNumeric(type: string): boolean {
  return /int|float|double|decimal|real|number|numeric/i.test(type);
}

function isDate(type: string): boolean {
  return /date|time|timestamp/i.test(type);
}

function isLongText(type: string): boolean {
  return (
    /text|blob|clob|longtext|mediumtext|tinytext/i.test(type) &&
    !/varchar/i.test(type)
  );
}

const PROFILE_TIMEOUT = 15000;

async function profileColumn(
  driver: DatabaseDriver,
  table: string,
  col: ColumnInfo,
  totalRows: number
): Promise<ColumnProfile> {
  const t = esc(table);
  const c = esc(col.name);
  const isStr = !isNumeric(col.type) && !isDate(col.type);

  const profile: ColumnProfile = {
    name: col.name,
    type: col.type,
    comment: col.comment,
    totalRows,
    nullCount: 0,
    emptyCount: 0,
  };

  const countSql = isStr
    ? `SELECT SUM(CASE WHEN ${c} IS NULL THEN 1 ELSE 0 END) as null_count, SUM(CASE WHEN ${c} = '' THEN 1 ELSE 0 END) as empty_count FROM ${t}`
    : `SELECT SUM(CASE WHEN ${c} IS NULL THEN 1 ELSE 0 END) as null_count, 0 as empty_count FROM ${t}`;

  try {
    const r = await driver.query(countSql, 1, PROFILE_TIMEOUT);
    if (r.rows.length > 0) {
      profile.nullCount = Number(r.rows[0].null_count || 0);
      profile.emptyCount = Number(r.rows[0].empty_count || 0);
    }
  } catch {
    /* continue */
  }

  if (isNumeric(col.type)) {
    await profileNumeric(driver, t, c, profile);
  } else if (isDate(col.type)) {
    await profileDate(driver, t, c, profile);
  } else if (isLongText(col.type)) {
    await profileLongText(driver, t, c, profile);
  } else {
    await profileShortString(driver, t, c, profile);
  }

  return profile;
}

async function profileNumeric(
  driver: DatabaseDriver,
  t: string,
  c: string,
  profile: ColumnProfile
): Promise<void> {
  try {
    const distSql = `SELECT ${c} as val, COUNT(*) as cnt FROM ${t} WHERE ${c} IS NOT NULL GROUP BY ${c} ORDER BY cnt DESC`;
    const result = await driver.query(distSql, 20, PROFILE_TIMEOUT);
    profile.distribution = result.rows.map((r) => ({
      value: String(r.val),
      count: Number(r.cnt),
    }));
    if (result.rowCount >= 20) {
      const statsSql = `SELECT MIN(${c}) as min_val, MAX(${c}) as max_val, AVG(${c}) as avg_val FROM ${t} WHERE ${c} IS NOT NULL`;
      const stats = await driver.query(statsSql, 1, PROFILE_TIMEOUT);
      if (stats.rows.length > 0) {
        profile.numericStats = {
          min: Number(stats.rows[0].min_val),
          max: Number(stats.rows[0].max_val),
          avg: Number(Number(stats.rows[0].avg_val).toFixed(2)),
        };
      }
    }
  } catch {
    /* continue */
  }
}

async function profileDate(
  driver: DatabaseDriver,
  t: string,
  c: string,
  profile: ColumnProfile
): Promise<void> {
  try {
    const sql = `SELECT MIN(${c}) as min_date, MAX(${c}) as max_date FROM ${t} WHERE ${c} IS NOT NULL`;
    const result = await driver.query(sql, 1, PROFILE_TIMEOUT);
    if (result.rows.length > 0) {
      profile.dateRange = {
        min: String(result.rows[0].min_date || ""),
        max: String(result.rows[0].max_date || ""),
      };
    }
  } catch {
    /* continue */
  }
}

async function profileLongText(
  driver: DatabaseDriver,
  t: string,
  c: string,
  profile: ColumnProfile
): Promise<void> {
  const lenFn = driver.type === "mysql" ? "CHAR_LENGTH" : "LENGTH";
  const substrExpr =
    driver.type === "mysql" ? `LEFT(${c}, 100)` : `SUBSTR(${c}, 1, 100)`;

  try {
    const lenSql = `SELECT AVG(${lenFn}(${c})) as avg_len, MIN(${lenFn}(${c})) as min_len, MAX(${lenFn}(${c})) as max_len FROM ${t} WHERE ${c} IS NOT NULL AND ${c} != ''`;
    const result = await driver.query(lenSql, 1, PROFILE_TIMEOUT);
    if (result.rows.length > 0) {
      profile.lengthStats = {
        avgLength: Number(Number(result.rows[0].avg_len || 0).toFixed(0)),
        minLength: Number(result.rows[0].min_len || 0),
        maxLength: Number(result.rows[0].max_len || 0),
      };
    }
  } catch {
    /* continue */
  }

  try {
    const sampleSql = `SELECT ${substrExpr} as sample FROM ${t} WHERE ${c} IS NOT NULL AND ${c} != ''`;
    const result = await driver.query(sampleSql, 3, PROFILE_TIMEOUT);
    profile.samples = result.rows.map((r) => String(r.sample || ""));
  } catch {
    /* continue */
  }
}

async function profileShortString(
  driver: DatabaseDriver,
  t: string,
  c: string,
  profile: ColumnProfile
): Promise<void> {
  try {
    const distSql = `SELECT ${c} as val, COUNT(*) as cnt FROM ${t} WHERE ${c} IS NOT NULL AND ${c} != '' GROUP BY ${c} ORDER BY cnt DESC`;
    const result = await driver.query(distSql, 30, PROFILE_TIMEOUT);
    profile.distribution = result.rows.map((r) => ({
      value: String(r.val),
      count: Number(r.cnt),
    }));
  } catch {
    /* continue */
  }
}

async function profileTable(
  driver: DatabaseDriver,
  table: string,
  columnName?: string
): Promise<ColumnProfile[]> {
  const info = await driver.describeTable(table);
  const columns = columnName
    ? info.columns.filter((c) => c.name === columnName)
    : info.columns;

  if (columns.length === 0 && columnName) {
    throw new Error(`Column '${columnName}' not found in table '${table}'`);
  }

  const profiles: ColumnProfile[] = [];
  for (const col of columns) {
    profiles.push(await profileColumn(driver, table, col, info.rowCount));
  }
  return profiles;
}

export { profileTable };
export type { ColumnProfile };
