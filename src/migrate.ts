import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfig } from "./config";
import { openDatabase } from "./db";

export function runMigrations(dbPath: string): void {
  const db = openDatabase(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const files = readdirSync("migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort();

  const appliedStmt = db.query("SELECT name FROM migrations WHERE name = ?1");
  const insertStmt = db.query("INSERT INTO migrations(name) VALUES (?1)");

  for (const file of files) {
    const exists = appliedStmt.get(file) as { name: string } | null;
    if (exists) continue;
    const sql = readFileSync(join("migrations", file), "utf-8");
    db.transaction(() => {
      db.exec(sql);
      insertStmt.run(file);
    })();
  }

  db.close();
}

if (import.meta.main) {
  const cfg = getConfig();
  runMigrations(cfg.dbPath);
  console.log(`Migrations applied on ${cfg.dbPath}`);
}
