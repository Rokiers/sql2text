import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const ClusterTableSchema = z.object({
  description: z.string().optional(),
  refs: z.record(z.string(), z.array(z.string())).optional(),
});

const ClusterSchema = z.object({
  description: z.string().optional(),
  tables: z.record(z.string(), ClusterTableSchema),
});

const ClustersConfigSchema = z.record(z.string(), ClusterSchema);

type ClusterTable = z.infer<typeof ClusterTableSchema>;
type Cluster = z.infer<typeof ClusterSchema>;
type ClustersConfig = z.infer<typeof ClustersConfigSchema>;

interface ClusterResult {
  name: string;
  description?: string;
  tables: Record<string, ClusterTable>;
}

class ClusterManager {
  private clusters: ClustersConfig;
  private reverseIndex: Map<string, string[]>;

  constructor(clusters: ClustersConfig) {
    this.clusters = clusters;
    this.reverseIndex = new Map();
    for (const [clusterName, cluster] of Object.entries(this.clusters)) {
      for (const tableName of Object.keys(cluster.tables)) {
        const existing = this.reverseIndex.get(tableName) || [];
        existing.push(clusterName);
        this.reverseIndex.set(tableName, existing);
      }
    }
  }

  getTableCluster(table: string): ClusterResult[] {
    const clusterNames = this.reverseIndex.get(table) || [];
    return clusterNames.map((name) => ({
      name,
      description: this.clusters[name].description,
      tables: this.clusters[name].tables,
    }));
  }

  listClusters(): {
    name: string;
    description?: string;
    tableCount: number;
    tables: string[];
  }[] {
    return Object.entries(this.clusters).map(([name, cluster]) => ({
      name,
      description: cluster.description,
      tableCount: Object.keys(cluster.tables).length,
      tables: Object.keys(cluster.tables),
    }));
  }
}

function loadClusters(configPath?: string): ClusterManager | null {
  const filePath = findClustersFile(configPath);
  if (!filePath) return null;

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const validated = ClustersConfigSchema.parse(parsed);
    console.error(
      `[sql2text] Loaded clusters from ${filePath} (${Object.keys(validated).length} clusters)`
    );
    return new ClusterManager(validated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.error(`[sql2text] Invalid clusters config: ${err.message}`);
    } else {
      console.error(
        `[sql2text] Failed to load clusters: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return null;
  }
}

function findClustersFile(configPath?: string): string | null {
  if (configPath && fs.existsSync(configPath)) return configPath;

  const cwdPath = path.resolve(process.cwd(), "clusters.json");
  if (fs.existsSync(cwdPath)) return cwdPath;

  const localPath = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../clusters.json"
  );
  if (fs.existsSync(localPath)) return localPath;

  return null;
}

export { ClusterManager, loadClusters };
export type { ClusterResult };
