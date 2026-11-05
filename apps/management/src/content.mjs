import { createHash } from "node:crypto";
import { z } from "zod";

import { DirectoryError } from "./directory.mjs";
import { LearningObject, SCHEMA_VERSION } from "./vendor/content-schema.mjs";

/**
 * Learning objects in the management workspace (breinhap#26).
 *
 * - **Validation at the boundary:** every save is parsed with the shared `LearningObject` schema
 *   (packages/content, vendored), at the schema version this service knows. An object for another
 *   version is refused, not guessed at.
 * - **Stable ids:** a learning object's id and its missions' ids are the schema's kebab-case ids. They
 *   are unique per workspace and an object's id never changes.
 * - **Drafts and revisions:** each object has one mutable draft, saved with optimistic concurrency
 *   (`expectedVersion`), and immutable revisions snapshotted from it. Review decisions are
 *   server-managed metadata (`revision_reviews`, breinhap#32). An author's `review` field is never
 *   trusted: content is stored as a draft.
 * - **Ownership:** the adult who creates an object owns it, and only an adult with `content.author`
 *   creates. Only the owner reads or changes a draft; review access comes with breinhap#32. Nothing
 *   here is reachable by a student; no student read path exists before publishing (breinhap#33).
 * - **Sources:** where the material came from stays server-side, beside the content, never in it.
 */

/** Where material came from. Kept with the draft and revisions, never in a student payload. */
export const Sources = z
	.array(
		z.object({
			kind: z.enum(["own", "book", "website", "school_material"]),
			title: z.string().trim().min(1).max(200),
			url: z
				.string()
				.max(500)
				.regex(/^https:\/\/[^\s<>"']+$/, "https link")
				.optional(),
		}),
	)
	.max(10)
	.default([]);

/** A draft larger than this is not a learning object (a few kilobytes is typical). */
export const MAX_CONTENT_BYTES = 200_000;

export class ContentError extends DirectoryError {
	constructor(code, issues = []) {
		super(code);
		this.issues = issues;
	}
}
const fail = (code, issues) => {
	throw new ContentError(code, issues);
};

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The issues of a refused object: paths and messages only, at most 20. */
const issuesOf = (error) =>
	error.issues.slice(0, 40).map((issue) => ({
		path: issue.path.join("."),
		message: issue.message,
		code: issue.code,
		origin: issue.origin,
		minimum: issue.minimum === undefined ? undefined : Number(issue.minimum),
		maximum: issue.maximum === undefined ? undefined : Number(issue.maximum),
	}));

/**
 * Parses an object as the server stores it: the shared schema at this service's version, with the
 * review forced to "draft" (the server, not the author, records reviews). Returns `{ object, sources }`.
 */
export function validate(input, sources) {
	if (!input || typeof input !== "object" || Array.isArray(input)) fail("invalid", [{ path: "", message: "not an object" }]);
	if (input.schemaVersion !== SCHEMA_VERSION)
		fail("unsupported_version", [
			{ path: "schemaVersion", message: `this service understands version ${SCHEMA_VERSION}` },
		]);
	if (Buffer.byteLength(JSON.stringify(input)) > MAX_CONTENT_BYTES)
		fail("invalid", [{ path: "", message: "too large" }]);
	const parsed = LearningObject.safeParse({ ...input, review: { status: "draft" } });
	if (!parsed.success) fail("invalid", issuesOf(parsed.error));
	// a content pack refuses duplicate mission ids, so one object must not hold two
	const ids = missionIds(parsed.data);
	const twice = ids.find((id, i) => ids.indexOf(id) !== i);
	if (twice) fail("invalid", [{ path: "missions", message: `duplicate mission id: ${twice}` }]);
	const src = Sources.safeParse(sources ?? []);
	if (!src.success)
		fail("invalid", issuesOf(src.error).map((i) => ({ ...i, path: `sources.${i.path}` })));
	return { object: parsed.data, sources: src.data };
}

const hashOf = (object) =>
	createHash("sha256").update(JSON.stringify(object)).digest("base64url");

const missionIds = (object) => object.missions.map((mission) => mission.id);

export class ContentStore {
	constructor({ directory }) {
		this.directory = directory;
		this.pool = directory.pool;
		this.workspace = directory.workspace;
	}

	async author(principal, action) {
		await this.directory.require(principal, "content.author", action);
	}

	/** The owner's row, locked when `tx` is given; `not_found` for anyone else (no leak). */
	async owned(db, principal, id, lock = false) {
		if (typeof id !== "string" || !ID.test(id)) fail("not_found");
		const { rows } = await db.query(
			`SELECT lo.id, d.version, d.content, d.sources, d.updated_at AS "updatedAt"
			 FROM learning_objects lo JOIN learning_object_drafts d
			   ON d.workspace_id = lo.workspace_id AND d.learning_object_id = lo.id
			 WHERE lo.workspace_id = $1 AND lo.id = $2 AND lo.owner_sub = $3 AND lo.archived_at IS NULL${lock ? " FOR UPDATE OF d" : ""}`,
			[this.workspace, id, principal.sub],
		);
		return rows[0] ?? fail("not_found");
	}

	/** Creates a learning object with its first draft. Errors: `exists`, `mission_exists`, `invalid`. */
	async create(principal, input, sources) {
		await this.author(principal, "content.create");
		const { object, sources: src } = validate(input, sources);
		try {
			await this.directory.transaction(async (db) => {
				await db.query(
					"INSERT INTO learning_objects (workspace_id, id, owner_sub, subject, grade, title) VALUES ($1, $2, $3, $4, $5, $6)",
					[this.workspace, object.id, principal.sub, object.subject, object.grade, object.title],
				);
				await db.query(
					"INSERT INTO learning_object_drafts (workspace_id, learning_object_id, schema_version, content, sources, updated_by) VALUES ($1, $2, $3, $4, $5, $6)",
					[this.workspace, object.id, SCHEMA_VERSION, object, JSON.stringify(src), principal.sub],
				);
				await this.setMissions(db, object);
				await this.directory.audit(principal.sub, "content.create", object.id, "done", db);
			});
		} catch (error) {
			if (error.code === "23505")
				fail(error.constraint === "learning_objects_pkey" ? "exists" : "mission_exists");
			throw error;
		}
		return { id: object.id, version: 1 };
	}

	async setMissions(db, object) {
		await db.query(
			"DELETE FROM learning_object_missions WHERE workspace_id = $1 AND learning_object_id = $2",
			[this.workspace, object.id],
		);
		const ids = missionIds(object);
		if (new Set(ids).size !== ids.length) fail("mission_exists");
		for (const id of ids)
			await db.query(
				"INSERT INTO learning_object_missions (workspace_id, mission_id, learning_object_id) VALUES ($1, $2, $3)",
				[this.workspace, id, object.id],
			);
	}

	/**
	 * Saves the draft over version `expectedVersion`. Errors: `stale` (someone saved in between),
	 * `id_changed` (the stable id never changes), `mission_exists`, `invalid`, `not_found`.
	 */
	async update(principal, id, expectedVersion, input, sources) {
		await this.author(principal, "content.update");
		const { object, sources: src } = validate(input, sources);
		if (object.id !== id) fail("id_changed");
		try {
			return await this.directory.transaction(async (db) => {
				const draft = await this.owned(db, principal, id, true);
				if (draft.version !== expectedVersion) fail("stale");
				await db.query(
					`UPDATE learning_object_drafts SET content = $3, sources = $4, schema_version = $5, version = version + 1,
					   updated_by = $6, updated_at = now() WHERE workspace_id = $1 AND learning_object_id = $2`,
					[this.workspace, id, object, JSON.stringify(src), SCHEMA_VERSION, principal.sub],
				);
				await db.query(
					"UPDATE learning_objects SET subject = $3, grade = $4, title = $5 WHERE workspace_id = $1 AND id = $2",
					[this.workspace, id, object.subject, object.grade, object.title],
				);
				await this.setMissions(db, object);
				await this.directory.audit(principal.sub, "content.update", id, "done", db);
				return { id, version: expectedVersion + 1 };
			});
		} catch (error) {
			if (error.code === "23505") fail("mission_exists");
			throw error;
		}
	}

	/** The owner's draft, with its sources and its revisions (newest first). */
	async get(principal, id) {
		await this.author(principal, "content.read");
		const draft = await this.owned(this.pool, principal, id);
		const { rows } = await this.pool.query(
			`SELECT r.revision, r.created_at AS "createdAt", r.content_hash AS "hash", v.decision
			 FROM learning_object_revisions r LEFT JOIN revision_reviews v
			   ON v.workspace_id = r.workspace_id AND v.learning_object_id = r.learning_object_id AND v.revision = r.revision
			 WHERE r.workspace_id = $1 AND r.learning_object_id = $2 ORDER BY r.revision DESC`,
			[this.workspace, id],
		);
		return {
			id,
			version: draft.version,
			content: draft.content,
			sources: draft.sources,
			updatedAt: draft.updatedAt,
			revisions: rows.map((row) => ({ ...row, decision: row.decision ?? null })),
		};
	}

	/** The owner's learning objects, optionally by subject or year; newest change first. */
	async list(principal, { subject, grade, q } = {}) {
		await this.author(principal, "content.list");
		const params = [this.workspace, principal.sub];
		let filter = "";
		if (subject !== undefined) {
			params.push(String(subject));
			filter += ` AND lo.subject = $${params.length}`;
		}
		if (grade !== undefined) {
			params.push(Number(grade));
			filter += ` AND lo.grade = $${params.length}`;
		}
		if (q) {
			params.push(`%${String(q).slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
			filter += ` AND lo.title ILIKE $${params.length}`;
		}
		const { rows } = await this.pool.query(
			`SELECT lo.id, lo.subject, lo.grade, lo.title, d.version, d.updated_at AS "updatedAt",
			   latest.revision AS "latestRevision", latest.decision AS "latestDecision"
			 FROM learning_objects lo JOIN learning_object_drafts d ON d.workspace_id = lo.workspace_id AND d.learning_object_id = lo.id
			 LEFT JOIN LATERAL (
			   SELECT r.revision, v.decision FROM learning_object_revisions r
			   LEFT JOIN revision_reviews v ON v.workspace_id = r.workspace_id AND v.learning_object_id = r.learning_object_id AND v.revision = r.revision
			   WHERE r.workspace_id = lo.workspace_id AND r.learning_object_id = lo.id ORDER BY r.revision DESC LIMIT 1
			 ) latest ON TRUE
			 WHERE lo.workspace_id = $1 AND lo.owner_sub = $2 AND lo.archived_at IS NULL${filter}
			 ORDER BY d.updated_at DESC, lo.id`,
			params,
		);
		return rows;
	}

	/**
	 * Freezes the draft at `expectedVersion` as the next immutable revision (what review and publishing
	 * work on, breinhap#32/#33). The draft stays editable; the revision never changes.
	 */
	async snapshot(principal, id, expectedVersion) {
		await this.author(principal, "content.snapshot");
		return this.directory.transaction(async (db) => {
			const draft = await this.owned(db, principal, id, true);
			if (draft.version !== expectedVersion) fail("stale");
			// revalidate: the draft was stored by an older schema version or code, it must still be valid
			const { object, sources } = validate(draft.content, draft.sources);
			const { rows } = await db.query(
				`INSERT INTO learning_object_revisions (workspace_id, learning_object_id, revision, schema_version, content, sources, content_hash, created_by)
				 SELECT $1, $2, coalesce(max(revision), 0) + 1, $3, $4, $5, $6, $7
				 FROM learning_object_revisions WHERE workspace_id = $1 AND learning_object_id = $2
				 RETURNING revision`,
				[this.workspace, id, SCHEMA_VERSION, object, JSON.stringify(sources), hashOf(object), principal.sub],
			);
			await this.directory.audit(principal.sub, "content.snapshot", `${id}:${rows[0].revision}`, "done", db);
			return { id, revision: rows[0].revision };
		});
	}

	/** One revision of the owner's object: its content, sources and hash. */
	async revision(principal, id, revision) {
		await this.author(principal, "content.read");
		await this.owned(this.pool, principal, id);
		const { rows } = await this.pool.query(
			`SELECT revision, schema_version AS "schemaVersion", content, sources, content_hash AS "hash", created_at AS "createdAt"
			 FROM learning_object_revisions WHERE workspace_id = $1 AND learning_object_id = $2 AND revision = $3`,
			[this.workspace, id, Number.isInteger(revision) ? revision : -1],
		);
		return rows[0] ?? fail("not_found");
	}

	/**
	 * Copies the owner's draft as a new learning object `newId` (owned by the same adult). Its missions
	 * get new ids (`<newId>-m1`, …) so both stay valid in one pack; revisions are not copied.
	 */
	async duplicate(principal, id, newId) {
		await this.author(principal, "content.duplicate");
		const draft = await this.owned(this.pool, principal, id);
		const copy = structuredClone(draft.content);
		copy.id = newId;
		copy.missions = copy.missions.map((mission, i) => ({ ...mission, id: `${newId}-m${i + 1}` }));
		return this.create(principal, copy, draft.sources);
	}

	/** Archives the owner's object: it leaves every list; its id and revisions stay reserved. */
	async archive(principal, id) {
		await this.author(principal, "content.archive");
		await this.directory.transaction(async (db) => {
			await this.owned(db, principal, id, true);
			await db.query(
				"UPDATE learning_objects SET archived_at = now() WHERE workspace_id = $1 AND id = $2",
				[this.workspace, id],
			);
			await this.directory.audit(principal.sub, "content.archive", id, "done", db);
		});
	}
}
