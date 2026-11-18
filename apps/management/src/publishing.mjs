import { randomUUID } from "node:crypto";

import { ContentError, reviewReadiness } from "./content.mjs";
import { PracticeError, contentHash } from "./practice/model.mjs";
import { studentPayload } from "./vendor/content-mission.mjs";
import { ContentPack, LearningObject, SCHEMA_VERSION } from "./vendor/content-schema.mjs";

/**
 * Publishing immutable, reviewed content (breinhap#33).
 *
 * A publication is built from exactly one immutable revision that an independent reviewer approved.
 * It stores a versioned, schema-valid delivery pack: the same clean projection a student receives
 * (`studentPayload`), so sources, reviewer notes, uploader details and internal identifiers never
 * enter the artifact. Publication rows are immutable apart from one lifecycle transition:
 * `active` → `superseded` (a newer release) or `active` → `withdrawn`. Restoring an older release
 * publishes that approved revision again as a new row, so the history and its hashes stay intact.
 *
 * `lockForPractice` is the production side of the accepted M6 adapter boundary. It locks active
 * publication rows shared until the caller's transaction commits; withdrawal takes the conflicting
 * exclusive lock, so a withdrawn publication cannot become newly eligible afterwards.
 */

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[A-Za-z0-9_-]{43}$/;

const fail = (code, issues = []) => {
	throw new ContentError(code, issues);
};

const issuesOf = (error) =>
	error.issues.slice(0, 40).map((issue) => ({
		path: issue.path.join("."),
		message: issue.message,
		code: issue.code,
	}));

/** The clean, schema-valid delivery pack for one object revision. */
export function publicationPack(object, version) {
	const clean = studentPayload(object);
	const pack = {
		schemaVersion: SCHEMA_VERSION,
		id: object.id,
		version,
		objects: [clean],
	};
	// The shared pack schema requires authoring review metadata. Validate the delivery projection
	// with a draft marker (which is stripped again), so every field is checked without storing it.
	const checked = ContentPack.safeParse({
		...pack,
		objects: [{ ...clean, review: { status: "draft" } }],
	});
	if (!checked.success) fail("invalid", issuesOf(checked.error));
	if ("review" in clean || "sources" in clean)
		fail("invalid", [{ path: "objects.0", message: "delivery packs carry no review or sources" }]);
	return pack;
}

function packHash(pack) {
	try {
		return contentHash(pack);
	} catch {
		fail("invalid", [{ path: "", message: "the pack cannot be hashed" }]);
	}
}

export class PublishingStore {
	constructor({ content }) {
		this.content = content;
		this.directory = content.directory;
		this.pool = content.pool;
		this.workspace = content.workspace;
	}

	async publisher(principal, action) {
		await this.directory.require(principal, "content.publish", action);
	}

	/**
	 * Publishes one approved immutable revision as the object's current release. The previous active
	 * publication is superseded in the same transaction. Errors: `not_found`, `not_approved`,
	 * `self_approved`, `not_ready`, `unsupported_version`, `invalid`, `already_published`, `conflict`.
	 */
	async publish(principal, objectId, revision, action = "content.publish") {
		await this.publisher(principal, action);
		if (typeof objectId !== "string" || !ID.test(objectId) || !Number.isInteger(revision) || revision < 1)
			fail("not_found");
		return this.directory.transaction(async (db) => {
			// Serialize releases per object; this also gives withdrawal and restore a stable lock order.
			const object = await db.query(
				"SELECT owner_sub, archived_at FROM learning_objects WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
				[this.workspace, objectId],
			);
			if (!object.rowCount || object.rows[0].archived_at) fail("not_found");

			const { rows } = await db.query(
				`SELECT r.schema_version AS "schemaVersion", r.content, r.sources,
				   r.content_hash AS "revisionHash",
				   v.decision, v.reviewer_sub AS "reviewer", v.decided_at AS "decidedAt"
				 FROM learning_object_revisions r
				 LEFT JOIN revision_reviews v
				   ON v.workspace_id = r.workspace_id
				  AND v.learning_object_id = r.learning_object_id
				  AND v.revision = r.revision
				 WHERE r.workspace_id = $1 AND r.learning_object_id = $2 AND r.revision = $3`,
				[this.workspace, objectId, revision],
			);
			const stored = rows[0] ?? fail("not_found");
			if (stored.decision !== "approved") fail("not_approved");
			if (stored.reviewer === object.rows[0].owner_sub) fail("self_approved");
			if (stored.schemaVersion !== SCHEMA_VERSION) fail("unsupported_version");
			const issues = reviewReadiness(stored.content, stored.sources);
			if (issues.length) fail("not_ready", issues);
			const parsed = LearningObject.safeParse(stored.content);
			if (!parsed.success) fail("invalid", issuesOf(parsed.error));

			const active = await db.query(
				"SELECT id, revision FROM content_publications WHERE workspace_id = $1 AND learning_object_id = $2 AND state = 'active' FOR UPDATE",
				[this.workspace, objectId],
			);
			if (active.rows[0]?.revision === revision) fail("already_published");
			const next = await db.query(
				"SELECT coalesce(max(pack_version), 0)::int + 1 AS version FROM content_publications WHERE workspace_id = $1 AND learning_object_id = $2",
				[this.workspace, objectId],
			);
			const version = next.rows[0].version;
			const pack = publicationPack(parsed.data, version);
			const hash = packHash(pack);
			const id = randomUUID();

			if (active.rowCount)
				await db.query(
					`UPDATE content_publications
					 SET state = 'superseded', state_changed_at = now(), state_changed_by = $3
					 WHERE workspace_id = $1 AND id = $2`,
					[this.workspace, active.rows[0].id, principal.sub],
				);
			try {
				await db.query(
					`INSERT INTO content_publications
					   (workspace_id, id, learning_object_id, revision, revision_hash, schema_version,
					    pack, pack_version, pack_hash, state, published_by)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10)`,
					[
						this.workspace,
						id,
						objectId,
						revision,
						stored.revisionHash,
						stored.schemaVersion,
						pack,
						version,
						hash,
						principal.sub,
					],
				);
			} catch (error) {
				if (error.code === "23505") fail("conflict");
				throw error;
			}
			await this.directory.audit(principal.sub, action, `${objectId}:${revision}`, "done", db);
			return { id, objectId, revision, version, hash };
		});
	}

	/** Publishes an older approved revision again; the current release is superseded atomically. */
	async restore(principal, objectId, revision) {
		return this.publish(principal, objectId, revision, "content.publish.restore");
	}

	/** Withdraws the object's current release. The row and its bytes stay for history; new access stops. */
	async withdraw(principal, objectId) {
		await this.publisher(principal, "content.withdraw");
		if (typeof objectId !== "string" || !ID.test(objectId)) fail("not_found");
		return this.directory.transaction(async (db) => {
			const object = await db.query(
				"SELECT id FROM learning_objects WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
				[this.workspace, objectId],
			);
			if (!object.rowCount) fail("not_found");
			const active = await db.query(
				"SELECT id, revision FROM content_publications WHERE workspace_id = $1 AND learning_object_id = $2 AND state = 'active' FOR UPDATE",
				[this.workspace, objectId],
			);
			if (!active.rowCount) fail("not_published");
			await db.query(
				`UPDATE content_publications
				 SET state = 'withdrawn', state_changed_at = now(), state_changed_by = $3
				 WHERE workspace_id = $1 AND id = $2`,
				[this.workspace, active.rows[0].id, principal.sub],
			);
			// breinhap#35: a withdrawn object also leaves the public catalogue; publishing it again
			// later does not silently make it public again (a newer release, by contrast, keeps it).
			await db.query(
				`UPDATE public_listings SET unlisted_at = now(), unlisted_by = $3
				 WHERE workspace_id = $1 AND learning_object_id = $2 AND unlisted_at IS NULL`,
				[this.workspace, objectId, principal.sub],
			);
			await this.directory.audit(principal.sub, "content.withdraw", objectId, "done", db);
			return { id: active.rows[0].id, objectId, revision: active.rows[0].revision };
		});
	}

	/**
	 * Approved revisions a publisher may release, newest first per object. It carries no sources,
	 * reviewer comment or uploader identity; only the state needed to choose a release.
	 */
	async candidates(principal) {
		await this.publisher(principal, "content.publish.queue");
		const { rows } = await this.pool.query(
			`SELECT lo.id, lo.title, lo.subject, lo.grade,
			   r.revision, r.content_hash AS "revisionHash", v.decided_at AS "decidedAt",
			   p.id AS "publicationId", p.pack_version AS "version", p.state,
			   p.published_at AS "publishedAt",
			   EXISTS (SELECT 1 FROM public_listings l
			           WHERE l.workspace_id = lo.workspace_id AND l.learning_object_id = lo.id
			             AND l.unlisted_at IS NULL) AS "listed"
			 FROM learning_objects lo
			 JOIN learning_object_revisions r
			   ON r.workspace_id = lo.workspace_id AND r.learning_object_id = lo.id
			 JOIN revision_reviews v
			   ON v.workspace_id = r.workspace_id AND v.learning_object_id = r.learning_object_id
			  AND v.revision = r.revision AND v.decision = 'approved'
			  AND v.reviewer_sub <> lo.owner_sub
			 LEFT JOIN LATERAL (
			   SELECT p.id, p.pack_version, p.state, p.published_at
			   FROM content_publications p
			   WHERE p.workspace_id = lo.workspace_id AND p.learning_object_id = lo.id
			     AND p.revision = r.revision
			   ORDER BY p.published_at DESC, p.pack_version DESC LIMIT 1
			 ) p ON TRUE
			 WHERE lo.workspace_id = $1 AND lo.archived_at IS NULL
			 ORDER BY lo.title, lo.id, r.revision DESC`,
			[this.workspace],
		);
		return rows;
	}

	/** breinhap#35: only an administrator decides what is public on breinhap.com. */
	async administrator(principal, action) {
		await this.directory.require(principal, "directory.manage", action);
	}

	/**
	 * breinhap#35: puts an object's current release in the public catalogue on breinhap.com. Only an
	 * administrator can, and only while the object has an active publication. Errors: `not_found`,
	 * `not_published`, `already_listed`.
	 */
	async list(principal, objectId) {
		await this.administrator(principal, "content.list");
		if (typeof objectId !== "string" || !ID.test(objectId)) fail("not_found");
		return this.directory.transaction(async (db) => {
			// The same lock order as publish/withdraw: the object row first.
			const object = await db.query(
				"SELECT archived_at FROM learning_objects WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
				[this.workspace, objectId],
			);
			if (!object.rowCount || object.rows[0].archived_at) fail("not_found");
			const active = await db.query(
				"SELECT 1 FROM content_publications WHERE workspace_id = $1 AND learning_object_id = $2 AND state = 'active'",
				[this.workspace, objectId],
			);
			if (!active.rowCount) fail("not_published");
			const id = randomUUID();
			try {
				await db.query(
					"INSERT INTO public_listings (workspace_id, id, learning_object_id, listed_by) VALUES ($1, $2, $3, $4)",
					[this.workspace, id, objectId, principal.sub],
				);
			} catch (error) {
				if (error.code === "23505") fail("already_listed");
				throw error;
			}
			await this.directory.audit(principal.sub, "content.list", objectId, "done", db);
			return { id, objectId };
		});
	}

	/** Takes an object out of the public catalogue. The listing row stays as history. */
	async unlist(principal, objectId) {
		await this.administrator(principal, "content.unlist");
		if (typeof objectId !== "string" || !ID.test(objectId)) fail("not_found");
		return this.directory.transaction(async (db) => {
			const object = await db.query(
				"SELECT 1 FROM learning_objects WHERE workspace_id = $1 AND id = $2 FOR UPDATE",
				[this.workspace, objectId],
			);
			if (!object.rowCount) fail("not_found");
			const { rowCount } = await db.query(
				`UPDATE public_listings SET unlisted_at = now(), unlisted_by = $3
				 WHERE workspace_id = $1 AND learning_object_id = $2 AND unlisted_at IS NULL`,
				[this.workspace, objectId, principal.sub],
			);
			if (!rowCount) fail("not_listed");
			await this.directory.audit(principal.sub, "content.unlist", objectId, "done", db);
			return { objectId };
		});
	}

	/**
	 * The administrator's view: every object with an active publication and whether it is public.
	 * Titles and years only; no owner, reviewer, source or revision content.
	 */
	async listingCandidates(principal) {
		await this.administrator(principal, "content.list.queue");
		const { rows } = await this.pool.query(
			`SELECT lo.id, lo.title, lo.subject, lo.grade, p.pack_version AS "version",
			   p.published_at AS "publishedAt", l.listed_at AS "listedAt"
			 FROM content_publications p
			 JOIN learning_objects lo ON lo.workspace_id = p.workspace_id AND lo.id = p.learning_object_id
			 LEFT JOIN public_listings l
			   ON l.workspace_id = p.workspace_id AND l.learning_object_id = p.learning_object_id
			  AND l.unlisted_at IS NULL
			 WHERE p.workspace_id = $1 AND p.state = 'active' AND lo.archived_at IS NULL
			 ORDER BY lo.title, lo.id`,
			[this.workspace],
		);
		return rows.map((row) => ({ ...row, listed: row.listedAt !== null }));
	}

	/**
	 * The public catalogue (no principal: the anonymous breinhap.com player reads it). Only objects
	 * that are listed, not archived and have an active publication appear, with what a student needs
	 * to choose: never an owner, reviewer, revision, source or internal identifier.
	 */
	async publicCatalog({ subject, grade } = {}) {
		const params = [this.workspace];
		let filter = "";
		if (typeof subject === "string" && subject) {
			params.push(subject);
			filter += ` AND p.pack -> 'objects' -> 0 ->> 'subject' = $${params.length}`;
		}
		if (Number.isInteger(grade)) {
			params.push(grade);
			filter += ` AND (p.pack -> 'objects' -> 0 ->> 'grade')::int = $${params.length}`;
		}
		const { rows } = await this.pool.query(
			`SELECT p.pack
			 FROM public_listings l
			 JOIN learning_objects lo ON lo.workspace_id = l.workspace_id AND lo.id = l.learning_object_id
			 JOIN content_publications p
			   ON p.workspace_id = l.workspace_id AND p.learning_object_id = l.learning_object_id
			  AND p.state = 'active'
			 WHERE l.workspace_id = $1 AND l.unlisted_at IS NULL AND lo.archived_at IS NULL${filter}
			 ORDER BY (p.pack -> 'objects' -> 0 ->> 'grade')::int, p.pack -> 'objects' -> 0 ->> 'title', l.learning_object_id
			 LIMIT 200`,
			params,
		);
		return rows.map(({ pack }) => {
			const object = pack.objects[0];
			return {
				id: object.id,
				title: object.title,
				subject: object.subject,
				grade: object.grade,
				missions: object.missions.length,
				minutes: object.missions.reduce((sum, m) => sum + m.minutes, 0),
			};
		});
	}

	/**
	 * The whole public catalogue as clean delivery objects, for the Android app's download
	 * (GET /p/missies.json). The same rows as `publicCatalog` without filters: listed, active,
	 * unarchived, current schema. Each object carries the day its release was published, which
	 * is the day it passed review; never an owner, reviewer, revision, source or internal id.
	 */
	async publicObjects() {
		const { rows } = await this.pool.query(
			`SELECT p.pack, p.published_at AS "publishedAt"
			 FROM public_listings l
			 JOIN learning_objects lo ON lo.workspace_id = l.workspace_id AND lo.id = l.learning_object_id
			 JOIN content_publications p
			   ON p.workspace_id = l.workspace_id AND p.learning_object_id = l.learning_object_id
			  AND p.state = 'active'
			 WHERE l.workspace_id = $1 AND l.unlisted_at IS NULL AND lo.archived_at IS NULL
			 ORDER BY (p.pack -> 'objects' -> 0 ->> 'grade')::int, p.pack -> 'objects' -> 0 ->> 'title', l.learning_object_id
			 LIMIT 200`,
			[this.workspace],
		);
		return rows
			.map(({ pack, publishedAt }) => ({ object: pack?.objects?.[0], publishedAt }))
			.filter(({ object }) => object?.schemaVersion === SCHEMA_VERSION)
			.map(({ object, publishedAt }) => ({ publishedAt: new Date(publishedAt).toISOString().slice(0, 10), object }));
	}

	/**
	 * One publicly listed object's clean delivery payload. Anything not listed, archived, withdrawn,
	 * only superseded or unknown is the same `not_found`, so a direct id reveals nothing.
	 */
	async publicObject(objectId) {
		if (typeof objectId !== "string" || !ID.test(objectId)) fail("not_found");
		const { rows } = await this.pool.query(
			`SELECT p.pack
			 FROM public_listings l
			 JOIN learning_objects lo ON lo.workspace_id = l.workspace_id AND lo.id = l.learning_object_id
			 JOIN content_publications p
			   ON p.workspace_id = l.workspace_id AND p.learning_object_id = l.learning_object_id
			  AND p.state = 'active'
			 WHERE l.workspace_id = $1 AND l.learning_object_id = $2 AND l.unlisted_at IS NULL
			   AND lo.archived_at IS NULL`,
			[this.workspace, objectId],
		);
		const object = rows[0]?.pack?.objects?.[0];
		if (!object || object.schemaVersion !== SCHEMA_VERSION) fail("not_found");
		return object;
	}

	/** The current delivery pack of one object. Internal only: no route may call this yet (#34/#81). */
	async publishedPack(objectId) {
		if (typeof objectId !== "string" || !ID.test(objectId)) fail("not_found");
		const { rows } = await this.pool.query(
			`SELECT pack FROM content_publications
			 WHERE workspace_id = $1 AND learning_object_id = $2 AND state = 'active'`,
			[this.workspace, objectId],
		);
		return rows[0]?.pack ?? fail("not_published");
	}

	/**
	 * Production `PublishedContent.lockForPractice(tx, …)` adapter (breinhap#79 contract). Returns the
	 * requested refs in request order with the immutable LearningObject and its server-confirmed
	 * review metadata. Locks every referenced publication shared until `tx` commits.
	 */
	async lockForPractice(tx, { workspaceId, ownerSub, refs } = {}) {
		const gone = () => {
			throw new PracticeError("gone");
		};
		if (!tx || typeof tx.query !== "function" || workspaceId !== this.workspace || typeof ownerSub !== "string")
			throw new PracticeError("unavailable");
		if (!Array.isArray(refs)) gone();
		const exact = refs.map((ref) => {
			if (
				!ref ||
				typeof ref !== "object" ||
				typeof ref.objectId !== "string" ||
				!ID.test(ref.objectId) ||
				!Number.isInteger(ref.revision) ||
				ref.revision < 1 ||
				typeof ref.publicationId !== "string" ||
				!UUID.test(ref.publicationId) ||
				typeof ref.revisionHash !== "string" ||
				!HASH.test(ref.revisionHash) ||
				typeof ref.publicationHash !== "string" ||
				!HASH.test(ref.publicationHash)
			)
				gone();
			return {
				objectId: ref.objectId,
				revision: ref.revision,
				publicationId: ref.publicationId,
				revisionHash: ref.revisionHash,
				publicationHash: ref.publicationHash,
			};
		});
		if (exact.length === 0) return [];

		const ids = [...new Set(exact.map((ref) => ref.publicationId))].sort();
		// Lock the publication rows in sorted order before reading them. Withdrawal takes the
		// conflicting exclusive lock, so a definite withdrawal cannot slip in between the check and
		// the caller's commit.
		for (const id of ids) {
			const locked = await tx.query(
				"SELECT 1 FROM content_publications WHERE workspace_id = $1 AND id = $2 FOR SHARE",
				[this.workspace, id],
			);
			if (!locked.rowCount) gone();
		}
		const { rows } = await tx.query(
			`SELECT p.id, p.learning_object_id AS "objectId", p.revision,
			   p.revision_hash AS "revisionHash", p.pack_hash AS "publicationHash",
			   p.schema_version AS "schemaVersion", p.state, p.pack,
			   lo.owner_sub AS "ownerSub", lo.archived_at AS "archivedAt",
			   r.content, r.sources, r.content_hash AS "storedRevisionHash",
			   v.decision, v.reviewer_sub AS "reviewer", v.decided_at AS "decidedAt"
			 FROM content_publications p
			 JOIN learning_objects lo
			   ON lo.workspace_id = p.workspace_id AND lo.id = p.learning_object_id
			 JOIN learning_object_revisions r
			   ON r.workspace_id = p.workspace_id AND r.learning_object_id = p.learning_object_id
			  AND r.revision = p.revision
			 LEFT JOIN revision_reviews v
			   ON v.workspace_id = p.workspace_id AND v.learning_object_id = p.learning_object_id
			  AND v.revision = p.revision
			 WHERE p.workspace_id = $1 AND p.id = ANY($2::uuid[])
			 ORDER BY p.id`,
			[this.workspace, ids],
		);
		const byId = new Map(rows.map((row) => [row.id, row]));
		const result = [];
		for (const ref of exact) {
			const row = byId.get(ref.publicationId);
			if (
				!row ||
				row.objectId !== ref.objectId ||
				row.revision !== ref.revision ||
				row.revisionHash !== ref.revisionHash ||
				row.storedRevisionHash !== ref.revisionHash ||
				row.publicationHash !== ref.publicationHash ||
				row.state !== "active" ||
				row.archivedAt ||
				row.ownerSub !== ownerSub ||
				row.decision !== "approved" ||
				row.reviewer === row.ownerSub
			)
				gone();
			if (row.schemaVersion !== SCHEMA_VERSION) throw new PracticeError("unsupported_version");
			const parsed = LearningObject.safeParse(row.content);
			if (!parsed.success) gone();
			if (reviewReadiness(parsed.data, row.sources).length) gone();
			// The stored artifact must still be exactly the clean projection of this revision.
			let expectedHash;
			let storedHash;
			try {
				expectedHash = packHash(publicationPack(parsed.data, row.pack?.version));
				storedHash = packHash(row.pack);
				if (storedHash !== row.publicationHash || contentHash(row.pack) !== expectedHash)
					gone();
			} catch {
				gone();
			}
			const reviewedAt = new Date(row.decidedAt).toISOString().slice(0, 10);
			const object = {
				...parsed.data,
				review: {
					status: "reviewed",
					reviewedBy: row.reviewer,
					reviewedAt,
				},
			};
			if (!LearningObject.safeParse(object).success) gone();
			result.push({
				objectId: ref.objectId,
				revision: ref.revision,
				publicationId: ref.publicationId,
				revisionHash: ref.revisionHash,
				publicationHash: ref.publicationHash,
				object,
			});
		}
		return result;
	}
}
