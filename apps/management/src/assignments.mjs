import { randomUUID } from "node:crypto";
import { z } from "zod";

import { LINK_TARGETS } from "./directory.mjs";

/**
 * Assigning active, reviewed publications to linked learners and groups (breinhap#34).
 *
 * An adult may assign only a publication that is currently active (so it came from an independently
 * approved revision, breinhap#33) and only to a learner or group their CURRENT role and links allow
 * (breinhap#25). Assigning does not grant publishing or review, and an administrator has no
 * `content.assign` capability.
 *
 * The learner-facing method is deliberately capability-free: the future student service passes a
 * verified learner id, and this store applies the publication state, window, group membership and
 * current adult relationship at read time. Its result contains no learner names, group names or
 * membership lists, so one learner cannot learn anything about another.
 */

const DAY = 86400_000;
const MAX_WINDOW = 366 * DAY;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADULT_ROLES = Object.freeze([
	"breinhap.parent",
	"breinhap.tutor",
	"breinhap.teacher",
]);
const KIND = Object.freeze(["learner", "group"]);

export class AssignmentError extends Error {
	constructor(code) {
		super(`assignment.${code}`);
		this.code = code;
	}
}
const fail = (code) => {
	throw new AssignmentError(code);
};

const date = (value) => {
	if (value === undefined || value === null || value === "") return null;
	const parsed = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(parsed.getTime())) fail("invalid");
	return parsed;
};

/**
 * A bounded window: the start defaults to "now", the end is optional, and nothing may reach more than
 * one school year past the moment the assignment was created (`anchor`). The database repeats the
 * same bound, so an update can never stretch an old assignment past it either.
 */
const windowOf = (input, anchor, now) => {
	const notBefore = date(input.notBefore) ?? now;
	const availableUntil = date(input.availableUntil);
	if (availableUntil && availableUntil <= notBefore) fail("invalid");
	if (+notBefore > +anchor + MAX_WINDOW) fail("invalid");
	if (availableUntil && +availableUntil > +anchor + MAX_WINDOW) fail("invalid");
	return { notBefore, availableUntil };
};

const assignmentInput = z
	.object({
		publicationId: z.string().max(64),
		audienceKind: z.enum(KIND),
		audienceId: z.string().max(64),
		notBefore: z.union([z.string().max(64), z.date(), z.null()]).optional(),
		availableUntil: z.union([z.string().max(64), z.date(), z.null()]).optional(),
	})
	.strict();
const changeInput = z
	.object({
		notBefore: z.union([z.string().max(64), z.date(), z.null()]).optional(),
		availableUntil: z.union([z.string().max(64), z.date(), z.null()]).optional(),
	})
	.strict();

export class AssignmentStore {
	constructor({ directory, membership, clock }) {
		this.directory = directory;
		this.pool = directory.pool;
		this.workspace = directory.workspace;
		// `membership(sub)` is the trusted adult-membership reader (Redis). It is needed for the
		// learner read boundary, where there is no request principal to ask.
		this.membership = membership;
		this.clock = clock;
	}
	async time(db = this.pool) {
		return this.clock
			? new Date(this.clock())
			: (await db.query("SELECT clock_timestamp() AS t")).rows[0].t;
	}
	async tx(work) {
		const db = await this.pool.connect();
		try {
			await db.query("BEGIN");
			const result = await work(db);
			await db.query("COMMIT");
			return result;
		} catch (error) {
			await db.query("ROLLBACK");
			throw error;
		} finally {
			db.release();
		}
	}
	async audit(db, actor, action, target) {
		await this.directory.audit(actor, `assignment.${action}`, target, "done", db);
	}

	/** Active publications an assigner may choose. It carries no sources or reviewer identity. */
	async publications(p) {
		await this.directory.require(p, "content.assign", "assignment.read");
		return (
			await this.pool.query(
				`SELECT p.id AS "publicationId", p.learning_object_id AS "objectId", p.revision,
				   p.pack_version AS "version", p.pack_hash AS "publicationHash",
				   p.published_at AS "publishedAt", lo.title, lo.subject, lo.grade
				 FROM content_publications p
				 JOIN learning_objects lo
				   ON lo.workspace_id = p.workspace_id AND lo.id = p.learning_object_id
				 WHERE p.workspace_id = $1 AND p.state = 'active' AND lo.archived_at IS NULL
				 ORDER BY lo.title, lo.id`,
				[this.workspace],
			)
		).rows;
	}

	async targetVisible(p, kind, id) {
		// The role's link kind is the scope, even when a teacher can *see* the learners of a linked
		// group: a teacher assigns to groups, a parent to learners, a tutor to either.
		if (!(LINK_TARGETS[p.role] ?? []).includes(kind)) fail("not_found");
		if (kind === "learner") {
			await this.directory.learner(p, id);
			return;
		}
		const groups = await this.directory.groups(p);
		if (!groups.some((group) => group.id === id)) fail("not_found");
	}

	async adultCanRead(adultSub, kind, id) {
		if (!this.membership) fail("unavailable");
		const member = await this.membership(adultSub);
		if (
			member?.active !== true ||
			!ADULT_ROLES.includes(member.role) ||
			!(LINK_TARGETS[member.role] ?? []).includes(kind)
		)
			return false;
		const column = kind === "learner" ? "learner_id" : "group_id";
		const { rowCount } = await this.pool.query(
			`SELECT 1 FROM adult_links
			 WHERE workspace_id = $1 AND adult_sub = $2 AND ${column} = $3 AND revoked_at IS NULL`,
			[this.workspace, adultSub, id],
		);
		return rowCount > 0;
	}

	stateOf(row, now) {
		if (row.revokedAt) return "revoked";
		if (row.publicationState !== "active") return row.publicationState;
		if (row.notBefore > now) return "scheduled";
		if (row.availableUntil && row.availableUntil <= now) return "expired";
		return "active";
	}

	/**
	 * The assigner's own assignments, including revoked history, for targets they may still read.
	 * Another adult's assignments and assignments to a target that is no longer linked are omitted.
	 */
	async list(p) {
		await this.directory.require(p, "content.assign", "assignment.read");
		const now = await this.time();
		const rows = (
			await this.pool.query(
				`SELECT a.id, a.publication_id AS "publicationId", a.learner_id AS "learnerId",
				   a.group_id AS "groupId", a.assigned_at AS "assignedAt",
				   a.not_before AS "notBefore", a.available_until AS "availableUntil",
				   a.revoked_at AS "revokedAt", a.version,
				   p.state AS "publicationState", p.pack_version AS "publicationVersion",
				   p.revision, lo.title, lo.subject, lo.grade,
				   l.display_name AS "learnerName", g.name AS "groupName"
				 FROM content_assignments a
				 JOIN content_publications p
				   ON p.workspace_id = a.workspace_id AND p.id = a.publication_id
				 JOIN learning_objects lo
				   ON lo.workspace_id = p.workspace_id AND lo.id = p.learning_object_id
				 LEFT JOIN learners l
				   ON l.workspace_id = a.workspace_id AND l.id = a.learner_id
				 LEFT JOIN groups g
				   ON g.workspace_id = a.workspace_id AND g.id = a.group_id
				 WHERE a.workspace_id = $1 AND a.assigned_by = $2
				 ORDER BY a.assigned_at DESC, a.id`,
				[this.workspace, p.sub],
			)
		).rows;
		const visible = [];
		for (const row of rows) {
			const kind = row.learnerId ? "learner" : "group";
			const target = row.learnerId ?? row.groupId;
			if (!(await this.adultCanRead(p.sub, kind, target))) continue;
			visible.push({ ...row, kind, state: this.stateOf(row, now) });
		}
		return visible;
	}

	/** Assigns one active publication to one linked learner or group. */
	async assign(p, input) {
		await this.directory.require(p, "content.assign", "assignment.create");
		const parsed = assignmentInput.safeParse(input);
		if (!parsed.success) fail("invalid");
		const { publicationId, audienceKind, audienceId } = parsed.data;
		if (!UUID.test(publicationId) || !UUID.test(audienceId)) fail("invalid");
		await this.targetVisible(p, audienceKind, audienceId);
		return this.tx(async (db) => {
			const now = await this.time(db);
			const publication = await db.query(
				`SELECT p.id FROM content_publications p
				 JOIN learning_objects lo
				   ON lo.workspace_id = p.workspace_id AND lo.id = p.learning_object_id
				 WHERE p.workspace_id = $1 AND p.id = $2 AND p.state = 'active'
				   AND lo.archived_at IS NULL
				 FOR SHARE OF p`,
				[this.workspace, publicationId],
			);
			if (!publication.rowCount) fail("not_found");
			const { notBefore, availableUntil } = windowOf(parsed.data, now, now);
			const id = randomUUID();
			try {
				await db.query(
					`INSERT INTO content_assignments
					   (workspace_id, id, publication_id, learner_id, group_id, assigned_by,
					    assigned_at, not_before, available_until, updated_at)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $7)`,
					[
						this.workspace,
						id,
						publicationId,
						audienceKind === "learner" ? audienceId : null,
						audienceKind === "group" ? audienceId : null,
						p.sub,
						now,
						notBefore,
						availableUntil,
					],
				);
			} catch (error) {
				if (error.code === "23505") fail("exists");
				throw error;
			}
			await this.audit(
				db,
				p.sub,
				"create",
				`${publicationId}:${audienceKind}:${audienceId}`,
			);
			return { id, version: 1 };
		});
	}

	/** Changes the availability window; the target and publication never change. */
	async update(p, id, expectedVersion, input) {
		await this.directory.require(p, "content.assign", "assignment.update");
		if (!UUID.test(id ?? "") || !Number.isInteger(expectedVersion) || expectedVersion < 1)
			fail("not_found");
		const parsed = changeInput.safeParse(input);
		if (!parsed.success) fail("invalid");
		return this.tx(async (db) => {
			const row = (
				await db.query(
					`SELECT * FROM content_assignments
					 WHERE workspace_id = $1 AND id = $2 AND assigned_by = $3 AND revoked_at IS NULL
					 FOR UPDATE`,
					[this.workspace, id, p.sub],
				)
			).rows[0];
			if (!row) fail("not_found");
			if (row.version !== expectedVersion) fail("stale");
			// A known id is not authority: the target must still be in the adult's current scope.
			const kind = row.learner_id ? "learner" : "group";
			await this.targetVisible(p, kind, row.learner_id ?? row.group_id);
			const now = await this.time(db);
			const { notBefore, availableUntil } = windowOf(
				{
					notBefore:
						parsed.data.notBefore === undefined
							? row.not_before
							: parsed.data.notBefore,
					availableUntil:
						parsed.data.availableUntil === undefined
							? row.available_until
							: parsed.data.availableUntil,
				},
				row.assigned_at,
				now,
			);
			await db.query(
				`UPDATE content_assignments
				 SET not_before = $4, available_until = $5, updated_at = $6, version = version + 1
				 WHERE workspace_id = $1 AND id = $2 AND assigned_by = $3`,
				[this.workspace, id, p.sub, notBefore, availableUntil, now],
			);
			await this.audit(db, p.sub, "update", id);
			return { id, version: expectedVersion + 1 };
		});
	}

	/** Explicit removal. The row and its audit stay; learner access ends immediately. */
	async revoke(p, id) {
		await this.directory.require(p, "content.assign", "assignment.revoke");
		if (!UUID.test(id ?? "")) fail("not_found");
		return this.tx(async (db) => {
			const now = await this.time(db);
			const done = await db.query(
				`UPDATE content_assignments
				 SET revoked_at = $4, revoked_by = $3, updated_at = $4, version = version + 1
				 WHERE workspace_id = $1 AND id = $2 AND assigned_by = $3 AND revoked_at IS NULL
				 RETURNING id`,
				[this.workspace, id, p.sub, now],
			);
			if (!done.rowCount) fail("not_found");
			await this.audit(db, p.sub, "revoke", id);
			return { id };
		});
	}

	/**
	 * The learner read boundary. `learnerId` must already be verified by the caller. It returns only
	 * active publications explicitly assigned to this learner, or to an active group containing them,
	 * by an adult whose current role and link still allow that target. No names or group data leave
	 * this method.
	 */
	async availableForLearner(learnerId, { at } = {}) {
		if (!UUID.test(learnerId ?? "")) fail("not_found");
		if (!this.membership) fail("unavailable");
		const now = at ? date(at) : await this.time();
		if (!now) fail("invalid");
		const rows = (
			await this.pool.query(
				`SELECT a.id AS "assignmentId", a.assigned_by AS "assignedBy",
				   a.learner_id AS "learnerId", a.group_id AS "groupId",
				   a.not_before AS "notBefore", a.available_until AS "availableUntil",
				   p.id AS "publicationId", p.learning_object_id AS "objectId",
				   p.revision, p.pack_version AS "version", p.pack_hash AS "publicationHash",
				   lo.title, lo.subject, lo.grade
				 FROM content_assignments a
				 JOIN content_publications p
				   ON p.workspace_id = a.workspace_id AND p.id = a.publication_id AND p.state = 'active'
				 JOIN learning_objects lo
				   ON lo.workspace_id = p.workspace_id AND lo.id = p.learning_object_id
				  AND lo.archived_at IS NULL
				 WHERE a.workspace_id = $1 AND a.revoked_at IS NULL
				   AND a.not_before <= $2
				   AND (a.available_until IS NULL OR a.available_until > $2)
				   AND EXISTS (SELECT 1 FROM learners l
				                WHERE l.workspace_id = a.workspace_id AND l.id = $3
				                  AND l.archived_at IS NULL)
				   AND (
				     (a.learner_id = $3
				       AND EXISTS (SELECT 1 FROM adult_links al
				                    WHERE al.workspace_id = a.workspace_id AND al.adult_sub = a.assigned_by
				                      AND al.learner_id = $3 AND al.revoked_at IS NULL))
				     OR
				     (a.group_id IS NOT NULL
				       AND EXISTS (SELECT 1 FROM group_learners gl
				                    JOIN groups g ON g.id = gl.group_id
				                      AND g.workspace_id = a.workspace_id AND g.archived_at IS NULL
				                    WHERE gl.group_id = a.group_id AND gl.learner_id = $3)
				       AND EXISTS (SELECT 1 FROM adult_links al
				                    WHERE al.workspace_id = a.workspace_id AND al.adult_sub = a.assigned_by
				                      AND al.group_id = a.group_id AND al.revoked_at IS NULL))
				   )
				 ORDER BY lo.title, p.id, a.not_before`,
				[this.workspace, now, learnerId],
			)
		).rows;
		const byPublication = new Map();
		for (const row of rows) {
			const kind = row.learnerId ? "learner" : "group";
			const target = row.learnerId ?? row.groupId;
			if (!(await this.adultCanRead(row.assignedBy, kind, target))) continue;
			if (!byPublication.has(row.publicationId))
				byPublication.set(row.publicationId, {
					publicationId: row.publicationId,
					objectId: row.objectId,
					revision: row.revision,
					version: row.version,
					publicationHash: row.publicationHash,
					title: row.title,
					subject: row.subject,
					grade: row.grade,
					assignmentId: row.assignmentId,
					notBefore: row.notBefore,
					availableUntil: row.availableUntil,
				});
		}
		return [...byPublication.values()];
	}

	/**
	 * One publication by opaque id, but only when it is in the learner's own available list. An
	 * unassigned, withdrawn or expired id is indistinguishable from an unknown one.
	 */
	async publicationForLearner(learnerId, publicationId, { at } = {}) {
		if (!UUID.test(publicationId ?? "")) fail("not_found");
		const available = await this.availableForLearner(learnerId, { at });
		const found = available.find((row) => row.publicationId === publicationId);
		if (!found) fail("not_found");
		return found;
	}
}
