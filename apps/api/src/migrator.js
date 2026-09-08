import fs from "node:fs";
import path from "node:path";
import pg from "pg";

export async function runMigrations(db, migrationsDir) {
  const searchDirs = [
    migrationsDir,
    path.resolve(process.cwd(), "migrations"),
    path.resolve(process.cwd(), "../../infra/postgres/migrations"),
    path.resolve(process.cwd(), "../infra/postgres/migrations"),
    path.resolve(process.cwd(), "infra/postgres/migrations"),
    "/app/migrations",
  ].filter(Boolean);

  let dir = null;
  for (const d of searchDirs) {
    if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
      dir = d;
      break;
    }
  }

  if (!dir) {
    console.warn("Migration runner: no migrations directory found, skipping file migrations");
    return [];
  }

  // Ensure schema_migrations table exists
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await db.query("SELECT version FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.version));

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const newlyApplied = [];
  for (const file of files) {
    if (!applied.has(file)) {
      const filePath = path.join(dir, file);
      const sql = fs.readFileSync(filePath, "utf-8");
      console.info(`[Migrations] Applying ${file}...`);

      const client = typeof db.connect === "function" ? await db.connect() : db;
      const isPool = typeof db.connect === "function";

      try {
        if (isPool) await client.query("BEGIN");
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [file]);
        if (isPool) await client.query("COMMIT");
        newlyApplied.push(file);
        console.info(`[Migrations] Successfully applied ${file}`);
      } catch (err) {
        if (isPool) {
          try {
            await client.query("ROLLBACK");
          } catch {}
        }
        console.error(`[Migrations] Failed to apply ${file}:`, err.message);
        throw err;
      } finally {
        if (isPool && typeof client.release === "function") {
          client.release();
        }
      }
    }
  }

  return newlyApplied;
}

export async function runCli() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL environment variable is required for migrations CLI");
    process.exit(1);
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const applied = await runMigrations(pool);
    console.info(`[Migrations] Completed. Newly applied migrations: ${applied.length}`);
  } catch (err) {
    console.error("[Migrations] CLI error:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}
