import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

/**
 * The management database (breinhap#25): workspaces, learner profiles, groups, adult links, capability
 * grants and their audit trail. Sessions and memberships stay in Redis. Migrations are plain SQL files
 * in ./migrations, applied in name order, once, under an advisory lock so two replicas starting
 * together never apply one twice.
 */

const MIGRATIONS = new URL("./migrations/", import.meta.url);
/** A fixed key for pg_advisory_lock: "breinhap-management-migrate". */
const LOCK = 742_118_25;

export async function migrate(pool) {
	const client = await pool.connect();
	try {
		await client.query("SELECT pg_advisory_lock($1)", [LOCK]);
		await client.query(
			"CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
		);
		const done = new Set(
			(await client.query("SELECT name FROM schema_migrations")).rows.map(
				(row) => row.name,
			),
		);
		const files = (await readdir(MIGRATIONS))
			.filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
			.sort();
		for (const name of files) {
			if (done.has(name)) continue;
			const sql = await readFile(new URL(name, MIGRATIONS), "utf8");
			await client.query("BEGIN");
			try {
				await client.query(sql);
				await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
					name,
				]);
				await client.query("COMMIT");
			} catch (error) {
				await client.query("ROLLBACK");
				throw error;
			}
		}
	} finally {
		await client.query("SELECT pg_advisory_unlock($1)", [LOCK]).catch(() => {});
		client.release();
	}
}

/** A small pool with short timeouts: a slow database must give "unavailable", not hang a request. */
export async function connectDatabase(url) {
	const pool = new pg.Pool({
		connectionString: url,
		max: 5,
		connectionTimeoutMillis: 5_000,
		idleTimeoutMillis: 30_000,
		statement_timeout: 5_000,
		query_timeout: 6_000,
		application_name: "breinhap-management",
	});
	pool.on("error", () => console.error("Management database unavailable"));
	await migrate(pool);
	return pool;
}
