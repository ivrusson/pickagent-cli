import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";

/*
 * Read-only helpers for Cursor/VS Code SQLite state DBs.
 * Prefer node:sqlite (Node 22+); fall back to the sqlite3 CLI.
 * Callers must only request non-secret keys / aggregate queries.
 */

async function readable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Escape a string for a single-quoted SQL literal. */
function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function viaNodeSqliteValue(
  dbPath: string,
  key: string,
): Promise<string | null | undefined> {
  try {
    const mod = await import("node:sqlite");
    const db = new mod.DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT value FROM ItemTable WHERE key = ?")
        .get(key) as { value?: unknown } | undefined;
      if (!row || row.value == null) return null;
      return typeof row.value === "string" ? row.value : String(row.value);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function viaSqliteCliValue(
  dbPath: string,
  key: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const sql = `SELECT value FROM ItemTable WHERE key = ${sqlQuote(key)};`;
    const child = spawn("sqlite3", ["-readonly", dbPath, sql], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const value = out.replace(/\n$/, "");
      resolve(value.length ? value : null);
    });
  });
}

export async function readSqliteItemValue(
  dbPath: string,
  key: string,
): Promise<string | null> {
  if (!(await readable(dbPath))) return null;
  const fromNode = await viaNodeSqliteValue(dbPath, key);
  if (fromNode !== undefined) return fromNode;
  return viaSqliteCliValue(dbPath, key);
}

/** Run a read-only SQL query; each row is stringified column values. */
export async function querySqliteStrings(
  dbPath: string,
  sql: string,
): Promise<string[][] | null> {
  if (!(await readable(dbPath))) return null;
  try {
    const mod = await import("node:sqlite");
    const db = new mod.DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare(sql).all() as Record<string, unknown>[];
      return rows.map((row) =>
        Object.values(row).map((v) => (v == null ? "" : String(v))),
      );
    } finally {
      db.close();
    }
  } catch {
    // fall through to CLI
  }
  return new Promise((resolve) => {
    const child = spawn(
      "sqlite3",
      ["-readonly", "-separator", "\t", dbPath, sql],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const lines = out.split("\n").filter((l) => l.length > 0);
      resolve(lines.map((line) => line.split("\t")));
    });
  });
}
