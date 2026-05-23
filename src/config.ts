import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const MySQLConnectionSchema = z.object({
  name: z.string(),
  type: z.literal("mysql"),
  host: z.string(),
  port: z.number().default(3306),
  user: z.string(),
  password: z.string(),
  database: z.string(),
});

const SQLiteConnectionSchema = z.object({
  name: z.string(),
  type: z.literal("sqlite"),
  path: z.string(),
});

const ConnectionSchema = z.discriminatedUnion("type", [
  MySQLConnectionSchema,
  SQLiteConnectionSchema,
]);

const SettingsSchema = z.object({
  defaultLimit: z.number().default(100),
  queryTimeoutMs: z.number().default(30000),
  logQueries: z.boolean().default(false),
});

const AppConfigSchema = z.object({
  connections: z.array(ConnectionSchema),
  settings: SettingsSchema.default({
    defaultLimit: 100,
    queryTimeoutMs: 30000,
    logQueries: false,
  }),
});

export type MySQLConnectionConfig = z.infer<typeof MySQLConnectionSchema>;
export type SQLiteConnectionConfig = z.infer<typeof SQLiteConnectionSchema>;
export type ConnectionConfig = z.infer<typeof ConnectionSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
export type AppSettings = z.infer<typeof SettingsSchema>;

export function loadConfig(): AppConfig {
  const configPath = findConfigFile();
  if (!configPath) {
    throw new Error(
      "Configuration file not found. Set SQL2TEXT_CONFIG env var or place config.json in the current directory.\n" +
        "Supported paths: config.json, config.yaml (in working directory) or via SQL2TEXT_CONFIG"
    );
  }

  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return AppConfigSchema.parse(parsed);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const issues = err.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(`Invalid config file at ${configPath}:\n${issues}`);
    }
    throw new Error(
      `Failed to load config from ${configPath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

function findConfigFile(): string | null {
  // Priority: env var > local config.json
  const envPath = process.env.SQL2TEXT_CONFIG;
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  const cwdConfig = path.resolve(process.cwd(), "config.json");
  if (fs.existsSync(cwdConfig)) {
    return cwdConfig;
  }

  // Check alongside executable
  const localConfig = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../config.json"
  );
  if (fs.existsSync(localConfig)) {
    return localConfig;
  }

  return null;
}
