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

/**
 * What must be true before a revision may be offered for review or approved (breinhap#32). The shared
 * schema already enforces goals, explanations and answer keys; these checks repeat the essentials
 * because approval is the last server-side gate before publishing (#33), and add the provenance rules
 * the schema cannot express: at least one source, and an https link for a website source.
 */
export function reviewReadiness(object, sources) {
	let parsed;
	try {
		({ object: parsed } = validate(object, sources));
	} catch (error) {
		if (error instanceof ContentError) return error.issues;
		throw error;
	}
	const issues = [];
	const list = Array.isArray(sources) ? sources : [];
	if (list.length === 0)
		issues.push({ path: "sources", code: "source_missing", message: "at least one source is required" });
	list.forEach((source, i) => {
		if (source?.kind === "website" && !source.url)
			issues.push({
				path: `sources.${i}.url`,
				code: "source_permission",
				message: "a website source needs an https link",
			});
	});
	parsed.missions.forEach((mission, mi) => {
		for (const [kind, questions] of [
			["practice", mission.practice],
			["check", mission.check],
		])
			questions.forEach((question, qi) => {
				const at = `missions.${mi}.${kind}.${qi}`;
				if (!question.explanation?.trim())
					issues.push({
						path: `${at}.explanation`,
						code: "explanation_missing",
						message: "an explanation is required",
					});
				if (
					question.kind === "choice" &&
					!(question.answerIndex >= 0 && question.answerIndex < question.options.length)
				)
					issues.push({
						path: `${at}.answerIndex`,
						code: "answer_key_invalid",
						message: "the answer key must point at an option",
					});
				if (
					question.kind === "order" &&
					(question.items.length < 2 || new Set(question.items).size !== question.items.length)
				)
					issues.push({
						path: `${at}.items`,
						code: "answer_key_invalid",
						message: "order items must be unique",
					});
			});
	});
	return issues;
}

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
			`SELECT r.revision, r.source_version AS "sourceVersion", r.created_at AS "createdAt", r.content_hash AS "hash",
			   v.decision, v.reviewer_sub AS "reviewer", v.comment,
			   s.submitted_at AS "submittedAt", s.submitted_by AS "submittedBy"
			 FROM learning_object_revisions r
			 LEFT JOIN revision_reviews v
			   ON v.workspace_id = r.workspace_id AND v.learning_object_id = r.learning_object_id AND v.revision = r.revision
			 LEFT JOIN revision_submissions s
			   ON s.workspace_id = r.workspace_id AND s.learning_object_id = r.learning_object_id AND s.revision = r.revision
			 WHERE r.workspace_id = $1 AND r.learning_object_id = $2 ORDER BY r.revision DESC`,
			[this.workspace, id],
		);
		const revisions = rows.map((row) => ({
			...row,
			decision: row.decision ?? null,
			reviewer: row.reviewer ?? null,
			comment: row.comment ?? "",
			submittedAt: row.submittedAt ?? null,
			submittedBy: row.submittedBy ?? null,
		}));
		const published = await this.pool.query(
			`SELECT id, revision, pack_version AS "version", pack_hash AS "hash", state,
			   published_at AS "publishedAt", state_changed_at AS "stateChangedAt"
			 FROM content_publications
			 WHERE workspace_id = $1 AND learning_object_id = $2
			 ORDER BY published_at DESC, pack_version DESC`,
			[this.workspace, id],
		);
		const publications = published.rows.map((row) => ({
			...row,
			stateChangedAt: row.stateChangedAt ?? null,
		}));
		const latest = revisions[0];
		return {
			id,
			version: draft.version,
			content: draft.content,
			sources: draft.sources,
			updatedAt: draft.updatedAt,
			revisions,
			publications,
			activePublication: publications.find((publication) => publication.state === "active") ?? null,
			latestPublication: publications[0] ?? null,
			draftChanged: Boolean(latest && (latest.sourceVersion == null || latest.sourceVersion !== draft.version)),
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
			   latest.revision AS "latestRevision", latest.decision AS "latestDecision",
			   latest.submitted_at AS "latestSubmittedAt", latest.source_version AS "latestSourceVersion",
			   published.revision AS "publicationRevision", published.pack_version AS "publicationVersion",
			   published.state AS "publicationState"
			 FROM learning_objects lo JOIN learning_object_drafts d ON d.workspace_id = lo.workspace_id AND d.learning_object_id = lo.id
			 LEFT JOIN LATERAL (
			   SELECT r.revision, r.source_version, v.decision, s.submitted_at
			   FROM learning_object_revisions r
			   LEFT JOIN revision_reviews v ON v.workspace_id = r.workspace_id AND v.learning_object_id = r.learning_object_id AND v.revision = r.revision
			   LEFT JOIN revision_submissions s ON s.workspace_id = r.workspace_id AND s.learning_object_id = r.learning_object_id AND s.revision = r.revision
			   WHERE r.workspace_id = lo.workspace_id AND r.learning_object_id = lo.id ORDER BY r.revision DESC LIMIT 1
			 ) latest ON TRUE
			 LEFT JOIN LATERAL (
			   SELECT p.revision, p.pack_version, p.state
			   FROM content_publications p
			   WHERE p.workspace_id = lo.workspace_id AND p.learning_object_id = lo.id
			   ORDER BY p.published_at DESC, p.pack_version DESC LIMIT 1
			 ) published ON TRUE
			 WHERE lo.workspace_id = $1 AND lo.owner_sub = $2 AND lo.archived_at IS NULL${filter}
			 ORDER BY d.updated_at DESC, lo.id`,
			params,
		);
		return rows.map((row) => ({
			...row,
			latestDecision: row.latestDecision ?? null,
			latestSubmittedAt: row.latestSubmittedAt ?? null,
			publicationRevision: row.publicationRevision ?? null,
			publicationVersion: row.publicationVersion ?? null,
			publicationState: row.publicationState ?? null,
			draftChanged: Boolean(
				row.latestRevision &&
					(row.latestSourceVersion == null || row.latestSourceVersion !== row.version),
			),
		}));
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
				`INSERT INTO learning_object_revisions (workspace_id, learning_object_id, revision, schema_version, content, sources, content_hash, source_version, created_by)
				 SELECT $1, $2, coalesce(max(revision), 0) + 1, $3, $4, $5, $6, $7, $8
				 FROM learning_object_revisions WHERE workspace_id = $1 AND learning_object_id = $2
				 RETURNING revision`,
				[this.workspace, id, SCHEMA_VERSION, object, JSON.stringify(sources), hashOf(object), draft.version, principal.sub],
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
			`SELECT revision, schema_version AS "schemaVersion", content, sources, content_hash AS "hash",
			   source_version AS "sourceVersion", created_at AS "createdAt"
			 FROM learning_object_revisions WHERE workspace_id = $1 AND learning_object_id = $2 AND revision = $3`,
			[this.workspace, id, Number.isInteger(revision) ? revision : -1],
		);
		return rows[0] ?? fail("not_found");
	}

	/**
	 * Offers one revision for independent review (breinhap#32). Only its owner may do this, only the
	 * latest revision, only while it still matches the current draft, and only once. Readiness is
	 * checked here so a reviewer never receives content that could not be approved.
	 */
	async submit(principal, id, revision) {
		await this.author(principal, "content.submit");
		if (!Number.isInteger(revision) || revision < 1) fail("invalid");
		return this.directory.transaction(async (db) => {
			const draft = await this.owned(db, principal, id, true);
			const latest = await db.query(
				"SELECT coalesce(max(revision), 0)::int AS revision FROM learning_object_revisions WHERE workspace_id = $1 AND learning_object_id = $2",
				[this.workspace, id],
			);
			if (latest.rows[0].revision !== revision) fail("not_latest");
			const { rows } = await db.query(
				`SELECT r.content, r.sources, r.source_version AS "sourceVersion", v.decision
				 FROM learning_object_revisions r
				 LEFT JOIN revision_reviews v
				   ON v.workspace_id = r.workspace_id AND v.learning_object_id = r.learning_object_id AND v.revision = r.revision
				 WHERE r.workspace_id = $1 AND r.learning_object_id = $2 AND r.revision = $3`,
				[this.workspace, id, revision],
			);
			const stored = rows[0] ?? fail("not_found");
			if (stored.decision) fail("already_reviewed");
			if (stored.sourceVersion == null || stored.sourceVersion !== draft.version) fail("stale_draft");
			const issues = reviewReadiness(stored.content, stored.sources);
			if (issues.length) fail("not_ready", issues);
			try {
				await db.query(
					"INSERT INTO revision_submissions (workspace_id, learning_object_id, revision, submitted_by) VALUES ($1, $2, $3, $4)",
					[this.workspace, id, revision, principal.sub],
				);
			} catch (error) {
				if (error.code === "23505") fail("already_submitted");
				throw error;
			}
			await this.directory.audit(principal.sub, "content.submit", `${id}:${revision}`, "done", db);
			return { id, revision };
		});
	}

	/** Revisions waiting for an independent reviewer, oldest first. Never the reviewer's own content. */
	async reviewQueue(principal) {
		await this.directory.require(principal, "content.review", "content.review.queue");
		const { rows } = await this.pool.query(
			`SELECT s.learning_object_id AS id, s.revision, s.submitted_at AS "submittedAt",
			   s.submitted_by AS "submittedBy", lo.title, lo.subject, lo.grade,
			   r.content_hash AS "hash", r.created_at AS "revisionCreatedAt"
			 FROM revision_submissions s
			 JOIN learning_objects lo
			   ON lo.workspace_id = s.workspace_id AND lo.id = s.learning_object_id AND lo.archived_at IS NULL
			 JOIN learning_object_revisions r
			   ON r.workspace_id = s.workspace_id AND r.learning_object_id = s.learning_object_id AND r.revision = s.revision
			 LEFT JOIN revision_reviews v
			   ON v.workspace_id = s.workspace_id AND v.learning_object_id = s.learning_object_id AND v.revision = s.revision
			 WHERE s.workspace_id = $1 AND v.decision IS NULL AND lo.owner_sub <> $2
			 ORDER BY s.submitted_at, s.learning_object_id, s.revision`,
			[this.workspace, principal.sub],
		);
		return rows;
	}

	/**
	 * One submitted revision for a reviewer, with its sources and readiness issues. A reviewer never
	 * sees their own object here, nor a revision that is already decided or whose object is archived.
	 */
	async reviewRevision(principal, id, revision) {
		await this.directory.require(principal, "content.review", "content.review.read");
		if (typeof id !== "string" || !ID.test(id) || !Number.isInteger(revision) || revision < 1)
			fail("not_found");
		const { rows } = await this.pool.query(
			`SELECT s.learning_object_id AS id, r.revision, r.schema_version AS "schemaVersion", r.content, r.sources,
			   r.content_hash AS "hash", r.created_at AS "createdAt",
			   s.submitted_at AS "submittedAt", s.submitted_by AS "submittedBy",
			   lo.owner_sub AS "owner", lo.title, lo.subject, lo.grade
			 FROM revision_submissions s
			 JOIN learning_objects lo
			   ON lo.workspace_id = s.workspace_id AND lo.id = s.learning_object_id AND lo.archived_at IS NULL
			 JOIN learning_object_revisions r
			   ON r.workspace_id = s.workspace_id AND r.learning_object_id = s.learning_object_id AND r.revision = s.revision
			 LEFT JOIN revision_reviews v
			   ON v.workspace_id = s.workspace_id AND v.learning_object_id = s.learning_object_id AND v.revision = s.revision
			 WHERE s.workspace_id = $1 AND s.learning_object_id = $2 AND s.revision = $3
			   AND v.decision IS NULL AND lo.owner_sub <> $4`,
			[this.workspace, id, revision, principal.sub],
		);
		const row = rows[0] ?? fail("not_found");
		return { ...row, issues: reviewReadiness(row.content, row.sources) };
	}

	/**
	 * Records a reviewer's decision on a submitted revision. Only an adult with the explicit
	 * `content.review` grant may decide, never the owner, and never twice. Approval re-checks
	 * readiness; changes requested must say what to change.
	 */
	async review(principal, id, revision, decision, comment = "") {
		await this.directory.require(principal, "content.review", "content.review.decide");
		if (!["approved", "changes_requested"].includes(decision)) fail("invalid");
		if (typeof id !== "string" || !ID.test(id) || !Number.isInteger(revision) || revision < 1)
			fail("not_found");
		const text = String(comment ?? "").trim();
		if (text.length > 2000) fail("invalid");
		if (decision === "changes_requested" && !text) fail("comment_required");
		try {
			return await this.directory.transaction(async (db) => {
				const submission = await db.query(
					`SELECT s.submitted_by FROM revision_submissions s
					 JOIN learning_objects lo
					   ON lo.workspace_id = s.workspace_id AND lo.id = s.learning_object_id AND lo.archived_at IS NULL
					 WHERE s.workspace_id = $1 AND s.learning_object_id = $2 AND s.revision = $3
					 FOR UPDATE OF s`,
					[this.workspace, id, revision],
				);
				if (!submission.rowCount) fail("not_found");
				const object = await db.query(
					"SELECT owner_sub FROM learning_objects WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL FOR UPDATE",
					[this.workspace, id],
				);
				if (!object.rowCount) fail("not_found");
				if (object.rows[0].owner_sub === principal.sub) fail("self_review");
				const existing = await db.query(
					"SELECT 1 FROM revision_reviews WHERE workspace_id = $1 AND learning_object_id = $2 AND revision = $3 FOR UPDATE",
					[this.workspace, id, revision],
				);
				if (existing.rowCount) fail("already_reviewed");
				const { rows } = await db.query(
					"SELECT content, sources FROM learning_object_revisions WHERE workspace_id = $1 AND learning_object_id = $2 AND revision = $3",
					[this.workspace, id, revision],
				);
				if (!rows[0]) fail("not_found");
				if (decision === "approved") {
					const issues = reviewReadiness(rows[0].content, rows[0].sources);
					if (issues.length) fail("not_ready", issues);
				}
				try {
					await db.query(
						"INSERT INTO revision_reviews (workspace_id, learning_object_id, revision, decision, reviewer_sub, comment) VALUES ($1, $2, $3, $4, $5, $6)",
						[this.workspace, id, revision, decision, principal.sub, text],
					);
				} catch (error) {
					if (error.code === "23505") fail("already_reviewed");
					throw error;
				}
				await this.directory.audit(
					principal.sub,
					decision === "approved" ? "content.review.approve" : "content.review.changes",
					`${id}:${revision}`,
					"done",
					db,
				);
				return { id, revision, decision };
			});
		} catch (error) {
			if (["self_review", "not_ready", "already_reviewed", "comment_required"].includes(error?.code))
				await this.directory
					.audit(principal.sub, "content.review.decide", `${id}:${revision}`, "refused")
					.catch(() => {});
			throw error;
		}
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
