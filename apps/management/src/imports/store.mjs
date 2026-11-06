import { createHash, randomUUID } from "node:crypto";

import { ContentError, validate } from "../content.mjs";
import { DirectoryError } from "../directory.mjs";
import { duplicates, fromCsv, fromPack, ImportRefused, MAX_IMPORT_BYTES } from "./parse.mjs";

/**
 * breinhap#30: plan → preview → confirm.
 *
 * `plan` parses and validates the file and decides, per learning object, what confirming would do:
 * create it, update the importer's own draft, or skip it (identical already, someone else's code,
 * archived, or a mission code in use). The plan is stored; nothing reaches the library.
 *
 * `confirm` runs each pending item once, through the same ContentStore the editor uses (same
 * permission checks, same validation, always a draft). It holds a lock on the import while it runs,
 * so two confirms never run together; an interrupted one resumes, and an item whose write already
 * happened (the object exists, owned by the importer, with exactly the planned content) counts as done.
 * Nothing is ever created twice.
 */

export const PLAN_MINUTES = 60;

export class ImportError extends DirectoryError {}
const fail = (code) => {
	throw new ImportError(code);
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** JSON with sorted keys: equal objects compare equal however the database ordered them. */
export function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.filter((k) => value[k] !== undefined)
			.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}
const same = (a, b) => canonical(a) === canonical(b);

export class ImportStore {
	constructor({ content }) {
		this.content = content;
		this.directory = content.directory;
		this.pool = content.pool;
		this.workspace = content.workspace;
	}

	async author(principal, action) {
		await this.directory.require(principal, "content.author", action);
	}

	/** Reads the file and stores its plan. Returns `{ id, items, errors, notes }`. */
	async plan(principal, { name, bytes }) {
		await this.author(principal, "import.plan");
		if (!bytes?.length) throw new ImportRefused("empty");
		if (bytes.length > MAX_IMPORT_BYTES) throw new ImportRefused("too_large");
		const lower = String(name ?? "").toLowerCase();
		const format = lower.endsWith(".json") ? "pack" : lower.endsWith(".csv") ? "csv" : null;
		if (!format) throw new ImportRefused("type_not_allowed");
		let text;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new ImportRefused("encoding");
		}
		const parsed = format === "pack" ? fromPack(text) : fromCsv(text);
		const objects = duplicates(parsed.objects, parsed.errors);

		const items = [];
		for (const { object } of objects) items.push({ objectId: object.id, ...(await this.decide(principal, object)), object });
		const id = randomUUID();
		await this.directory.transaction(async (db) => {
			await db.query(
				"INSERT INTO imports (workspace_id, id, importer_sub, format, file_sha256) VALUES ($1, $2, $3, $4, $5)",
				[this.workspace, id, principal.sub, format, createHash("sha256").update(bytes).digest("hex")],
			);
			for (const [position, item] of items.entries())
				await db.query(
					`INSERT INTO import_items (workspace_id, import_id, position, object_id, action, reason, expected_version, content, result)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
					[this.workspace, id, position, item.objectId, item.action, item.reason ?? null, item.expectedVersion ?? null, item.action === "skip" ? null : item.object, item.action === "skip" ? "skipped" : "pending"],
				);
			await this.directory.audit(principal.sub, "import.plan", id, "done", db);
		});
		return { id, format, items: items.map(({ object, ...rest }) => ({ ...rest, title: object.title, missions: object.missions.length })), errors: parsed.errors, notes: parsed.notes };
	}

	/** What confirming would do with one object, judged against the library now. */
	async decide(principal, object) {
		const { rows } = await this.pool.query(
			`SELECT lo.owner_sub AS owner, lo.archived_at IS NOT NULL AS archived, d.version, d.content
			 FROM learning_objects lo JOIN learning_object_drafts d ON d.workspace_id = lo.workspace_id AND d.learning_object_id = lo.id
			 WHERE lo.workspace_id = $1 AND lo.id = $2`,
			[this.workspace, object.id],
		);
		const existing = rows[0];
		const missionIds = object.missions.map((m) => m.id);
		const { rows: taken } = await this.pool.query(
			"SELECT mission_id FROM learning_object_missions WHERE workspace_id = $1 AND mission_id = ANY($2) AND learning_object_id <> $3 LIMIT 1",
			[this.workspace, missionIds, object.id],
		);
		if (existing && existing.owner !== principal.sub) return { action: "skip", reason: "owned_elsewhere" };
		if (existing?.archived) return { action: "skip", reason: "archived" };
		if (taken.length) return { action: "skip", reason: "mission_in_use" };
		if (!existing) return { action: "create" };
		if (same(existing.content, object)) return { action: "skip", reason: "identical" };
		return { action: "update", expectedVersion: existing.version };
	}

	async owned(db, principal, id, lock = false) {
		if (typeof id !== "string" || !UUID.test(id)) fail("not_found");
		const { rows } = await db.query(
			`SELECT id, status, format, created_at AS "createdAt", created_at < now() - make_interval(mins => $4) AS expired
			 FROM imports WHERE workspace_id = $1 AND id = $2 AND importer_sub = $3${lock ? " FOR UPDATE NOWAIT" : ""}`,
			[this.workspace, id, principal.sub, PLAN_MINUTES],
		);
		return rows[0] ?? fail("not_found");
	}

	/** The importer's own import with its items (for the preview and the result). */
	async get(principal, id) {
		await this.author(principal, "import.read");
		const row = await this.owned(this.pool, principal, id);
		const { rows } = await this.pool.query(
			`SELECT position, object_id AS "objectId", action, reason, result, content ->> 'title' AS title,
			   jsonb_array_length(coalesce(content -> 'missions', '[]')) AS missions
			 FROM import_items WHERE workspace_id = $1 AND import_id = $2 ORDER BY position`,
			[this.workspace, id],
		);
		return { ...row, items: rows };
	}

	/**
	 * Runs the plan. Returns the import with its items. Errors: `expired` (an unconfirmed plan older
	 * than PLAN_MINUTES), `busy` (another confirm of the same import is running), `not_found`.
	 */
	async confirm(principal, id) {
		await this.author(principal, "import.confirm");
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			let row;
			try {
				row = await this.owned(client, principal, id, true);
			} catch (error) {
				if (error.code === "55P03") fail("busy"); // lock_not_available: a confirm is running
				throw error;
			}
			if (row.status === "done") {
				await client.query("ROLLBACK");
				return this.get(principal, id);
			}
			if (row.status === "planned" && row.expired) fail("expired");
			await client.query("UPDATE imports SET confirmed_at = coalesce(confirmed_at, now()) WHERE workspace_id = $1 AND id = $2", [this.workspace, id]);
			const { rows: items } = await client.query(
				`SELECT position, object_id AS "objectId", action, expected_version AS "expectedVersion", content
				 FROM import_items WHERE workspace_id = $1 AND import_id = $2 AND result = 'pending' ORDER BY position`,
				[this.workspace, id],
			);
			for (const item of items) {
				const result = await this.apply(principal, item);
				await client.query("UPDATE import_items SET result = $4 WHERE workspace_id = $1 AND import_id = $2 AND position = $3", [this.workspace, id, item.position, result]);
			}
			await client.query("UPDATE imports SET status = 'done', finished_at = now() WHERE workspace_id = $1 AND id = $2", [this.workspace, id]);
			await this.directory.audit(principal.sub, "import.confirm", id, "done", client);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK").catch(() => {});
			throw error;
		} finally {
			client.release();
		}
		return this.get(principal, id);
	}

	/** One item: `done` when the library now holds exactly the planned draft, else `conflict`. */
	async apply(principal, item) {
		const already = async () => {
			try {
				const draft = await this.content.get(principal, item.objectId);
				return same(validate(draft.content, []).object, item.content);
			} catch {
				return false;
			}
		};
		try {
			if (item.action === "create") await this.content.create(principal, item.content, []);
			else await this.content.update(principal, item.objectId, item.expectedVersion, item.content, []);
			return "done";
		} catch (error) {
			if (!(error instanceof ContentError) && !(error instanceof DirectoryError)) throw error;
			if (error.code === "forbidden") throw error;
			// an earlier, interrupted confirm may have written it already
			return (await already()) ? "done" : "conflict";
		}
	}
}
