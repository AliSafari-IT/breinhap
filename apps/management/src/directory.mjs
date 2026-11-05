import { digest } from "./store.mjs";

/**
 * Workspace, group and learner permissions (breinhap#25).
 *
 * A principal is the signed-in adult as the request resolved them just now: their ASafariM subject and
 * their CURRENT active Breinhap membership role (read from the store on every request, never from the
 * client). Every read and write here is scoped to this directory's workspace and checked against:
 *
 *   allow = active membership role
 *           AND the capability the action needs
 *           AND the workspace
 *           AND an explicit, unrevoked link to the learner or group, where the action concerns one
 *
 * - Only an administrator manages learner profiles, groups, links and capability grants.
 * - Nobody grants a link or a capability to themself (also refused by the database).
 * - Which links count depends on the adult's role now: a parent is linked to learners, a teacher to
 *   groups, a tutor to either. A link that no longer fits the adult's role grants nothing.
 * - Review and publish are never implied by a role: an administrator grants them to a named adult.
 * - Every change, and every refusal of a change, is audited with hashed ids only.
 */

export const ROLES = Object.freeze([
	"breinhap.admin",
	"breinhap.parent",
	"breinhap.tutor",
	"breinhap.teacher",
]);

/** What each adult role may be linked to. */
export const LINK_TARGETS = Object.freeze({
	"breinhap.parent": Object.freeze(["learner"]),
	"breinhap.tutor": Object.freeze(["learner", "group"]),
	"breinhap.teacher": Object.freeze(["group"]),
});

/** Capabilities a role carries by itself. Authoring and assigning stay within the adult's links. */
export const ROLE_CAPABILITIES = Object.freeze({
	"breinhap.admin": Object.freeze([
		"directory.manage",
		"links.manage",
		"capabilities.manage",
		"learners.read_all",
	]),
	"breinhap.parent": Object.freeze(["content.author", "content.assign"]),
	"breinhap.tutor": Object.freeze(["content.author", "content.assign"]),
	"breinhap.teacher": Object.freeze(["content.author", "content.assign"]),
});

/** Capabilities only an explicit grant gives. */
export const GRANTABLE = Object.freeze(["content.review", "content.publish"]);

/** The school years a learner profile may have (secondary school, 1st to 6th). */
export const SCHOOL_YEARS = Object.freeze([1, 2, 3, 4, 5, 6]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUBJECT = /^[A-Za-z0-9:._@-]{1,400}$/;

/** A refusal with a stable code; the caller shows a message, never a stack trace. */
export class DirectoryError extends Error {
	constructor(code) {
		super(`directory.${code}`);
		this.code = code;
	}
}
const fail = (code) => {
	throw new DirectoryError(code);
};

/** A display name: printable text without control characters or markup, 1 to `max` characters. */
function cleanName(value, max) {
	const text = String(value ?? "")
		.normalize("NFC")
		.replace(/\s+/g, " ")
		.trim();
	if (text.length < 1 || text.length > max || /[\p{Cc}<>]/u.test(text))
		fail("invalid");
	return text;
}

const isAdult = (principal) =>
	Boolean(principal) &&
	typeof principal.sub === "string" &&
	SUBJECT.test(principal.sub) &&
	ROLES.includes(principal.role);

export class Directory {
	constructor({ pool, workspace }) {
		if (!/^[a-z][a-z0-9-]{0,40}$/.test(workspace ?? ""))
			throw new Error("Invalid workspace");
		this.pool = pool;
		this.workspace = workspace;
	}

	async ready() {
		await this.pool.query(
			"INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT (id) DO NOTHING",
			[this.workspace],
		);
		return this;
	}

	async audit(actor, action, target, result = "done", db = this.pool) {
		await db.query(
			"INSERT INTO audit_events (workspace_id, actor, action, target, result) VALUES ($1, $2, $3, $4, $5)",
			[
				this.workspace,
				digest(actor ?? "anonymous"),
				action,
				digest(String(target ?? "none")),
				result,
			],
		);
	}

	/** The role's capabilities plus the active explicit grants. Empty for anything that is not an adult. */
	async capabilities(principal) {
		if (!isAdult(principal)) return new Set();
		const caps = new Set(ROLE_CAPABILITIES[principal.role] ?? []);
		if (principal.role !== "breinhap.admin") {
			const { rows } = await this.pool.query(
				"SELECT capability FROM capability_grants WHERE workspace_id = $1 AND adult_sub = $2 AND revoked_at IS NULL",
				[this.workspace, principal.sub],
			);
			for (const row of rows) caps.add(row.capability);
		}
		return caps;
	}

	async can(principal, capability) {
		return (await this.capabilities(principal)).has(capability);
	}

	/** Refuses (and audits) an action the principal's capabilities do not cover. */
	async require(principal, capability, action) {
		if (await this.can(principal, capability)) return;
		await this.audit(principal?.sub, action, capability, "denied");
		fail("forbidden");
	}

	// ── scoped reads ───────────────────────────────────────────────────────────────────────────────

	/**
	 * The SQL condition "this learner is visible to the principal". An administrator sees every
	 * learner of the workspace; any other adult only learners linked to them directly or through a
	 * linked group, and only through the kinds of link their role allows now.
	 */
	visibility(principal, alias, params) {
		if (principal.role === "breinhap.admin") return "TRUE";
		const targets = LINK_TARGETS[principal.role] ?? [];
		params.push(principal.sub);
		const sub = `$${params.length}`;
		const parts = [];
		if (targets.includes("learner"))
			parts.push(
				`EXISTS (SELECT 1 FROM adult_links a WHERE a.workspace_id = ${alias}.workspace_id AND a.adult_sub = ${sub} AND a.revoked_at IS NULL AND a.learner_id = ${alias}.id)`,
			);
		if (targets.includes("group"))
			parts.push(
				`EXISTS (SELECT 1 FROM adult_links a JOIN groups g ON g.id = a.group_id AND g.archived_at IS NULL JOIN group_learners gl ON gl.group_id = g.id WHERE a.workspace_id = ${alias}.workspace_id AND a.adult_sub = ${sub} AND a.revoked_at IS NULL AND gl.learner_id = ${alias}.id)`,
			);
		return parts.length ? `(${parts.join(" OR ")})` : "FALSE";
	}

	/** Learners the principal may see, optionally filtered by name; the count is of that same scope. */
	async learners(principal, { search } = {}) {
		if (!isAdult(principal)) fail("forbidden");
		const params = [this.workspace];
		const scope = this.visibility(principal, "l", params);
		let filter = "";
		if (search) {
			const term = cleanName(search, 40).replace(/[\\%_]/g, (c) => `\\${c}`);
			params.push(`%${term}%`);
			filter = ` AND l.display_name ILIKE $${params.length}`;
		}
		const { rows } = await this.pool.query(
			`SELECT l.id, l.display_name AS "displayName", l.school_year AS "schoolYear"
			 FROM learners l
			 WHERE l.workspace_id = $1 AND l.archived_at IS NULL AND ${scope}${filter}
			 ORDER BY l.display_name, l.id`,
			params,
		);
		return rows;
	}

	async countLearners(principal) {
		return (await this.learners(principal)).length;
	}

	/** One learner, or `not_found` when it does not exist OR the principal may not see it (no leak). */
	async learner(principal, id) {
		if (!isAdult(principal)) fail("forbidden");
		if (!UUID.test(id ?? "")) fail("not_found");
		const params = [this.workspace, id];
		const scope = this.visibility(principal, "l", params);
		const { rows } = await this.pool.query(
			`SELECT l.id, l.display_name AS "displayName", l.school_year AS "schoolYear"
			 FROM learners l WHERE l.workspace_id = $1 AND l.id = $2 AND l.archived_at IS NULL AND ${scope}`,
			params,
		);
		return rows[0] ?? fail("not_found");
	}

	/** Groups the principal may see: all for an administrator, else the ones linked to them (if their role allows groups). */
	async groups(principal) {
		if (!isAdult(principal)) fail("forbidden");
		const params = [this.workspace];
		let scope = "TRUE";
		if (principal.role !== "breinhap.admin") {
			if (!(LINK_TARGETS[principal.role] ?? []).includes("group")) return [];
			params.push(principal.sub);
			scope = `EXISTS (SELECT 1 FROM adult_links a WHERE a.workspace_id = g.workspace_id AND a.adult_sub = $2 AND a.revoked_at IS NULL AND a.group_id = g.id)`;
		}
		const { rows } = await this.pool.query(
			`SELECT g.id, g.name,
			   (SELECT count(*)::int FROM group_learners gl JOIN learners l ON l.id = gl.learner_id AND l.archived_at IS NULL WHERE gl.group_id = g.id) AS "size"
			 FROM groups g WHERE g.workspace_id = $1 AND g.archived_at IS NULL AND ${scope}
			 ORDER BY g.name, g.id`,
			params,
		);
		return rows;
	}

	// ── administration (administrator only) ───────────────────────────────────────────────────────

	async createLearner(principal, { displayName, schoolYear }) {
		await this.require(principal, "directory.manage", "learner.create");
		const name = cleanName(displayName, 40);
		const year = Number(schoolYear);
		if (!SCHOOL_YEARS.includes(year)) fail("invalid");
		const { rows } = await this.pool.query(
			"INSERT INTO learners (workspace_id, display_name, school_year, created_by) VALUES ($1, $2, $3, $4) RETURNING id",
			[this.workspace, name, year, principal.sub],
		);
		await this.audit(principal.sub, "learner.create", rows[0].id);
		return rows[0].id;
	}

	async archiveLearner(principal, id) {
		await this.require(principal, "directory.manage", "learner.archive");
		return this.transaction(async (db) => {
			const done = await db.query(
				"UPDATE learners SET archived_at = now() WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL RETURNING id",
				[this.workspace, this.uuid(id)],
			);
			if (!done.rowCount) fail("not_found");
			// the learner's own links end with it; group membership stays for the history
			await db.query(
				"UPDATE adult_links SET revoked_at = now(), revoked_by = $3 WHERE workspace_id = $1 AND learner_id = $2 AND revoked_at IS NULL",
				[this.workspace, id, principal.sub],
			);
			await this.audit(principal.sub, "learner.archive", id, "done", db);
		});
	}

	async createGroup(principal, { name }) {
		await this.require(principal, "directory.manage", "group.create");
		const clean = cleanName(name, 60);
		const { rows } = await this.pool.query(
			"INSERT INTO groups (workspace_id, name, created_by) VALUES ($1, $2, $3) RETURNING id",
			[this.workspace, clean, principal.sub],
		);
		await this.audit(principal.sub, "group.create", rows[0].id);
		return rows[0].id;
	}

	async archiveGroup(principal, id) {
		await this.require(principal, "directory.manage", "group.archive");
		return this.transaction(async (db) => {
			const done = await db.query(
				"UPDATE groups SET archived_at = now() WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL RETURNING id",
				[this.workspace, this.uuid(id)],
			);
			if (!done.rowCount) fail("not_found");
			await db.query(
				"UPDATE adult_links SET revoked_at = now(), revoked_by = $3 WHERE workspace_id = $1 AND group_id = $2 AND revoked_at IS NULL",
				[this.workspace, id, principal.sub],
			);
			await this.audit(principal.sub, "group.archive", id, "done", db);
		});
	}

	async addToGroup(principal, { groupId, learnerId }) {
		await this.require(principal, "directory.manage", "group.add_learner");
		const group = await this.active("groups", groupId);
		const learner = await this.active("learners", learnerId);
		const done = await this.pool.query(
			"INSERT INTO group_learners (group_id, learner_id, added_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
			[group, learner, principal.sub],
		);
		await this.audit(principal.sub, "group.add_learner", `${group}:${learner}`);
		return done.rowCount === 1;
	}

	async removeFromGroup(principal, { groupId, learnerId }) {
		await this.require(principal, "directory.manage", "group.remove_learner");
		const done = await this.pool.query(
			"DELETE FROM group_learners gl USING groups g WHERE gl.group_id = g.id AND g.workspace_id = $1 AND gl.group_id = $2 AND gl.learner_id = $3",
			[this.workspace, this.uuid(groupId), this.uuid(learnerId)],
		);
		if (!done.rowCount) fail("not_found");
		await this.audit(principal.sub, "group.remove_learner", `${groupId}:${learnerId}`);
	}

	/**
	 * Links an adult to a learner or a group. `adult` is the adult's CURRENT membership as the caller
	 * read it from the store (`{ sub, role }`), or null when they have none: then nothing is granted.
	 * Refused: linking yourself (`self`), a non-member or administrator (`not_member`), a target the
	 * adult's role does not allow (`role_mismatch`), an unknown or archived target (`not_found`).
	 */
	async link(principal, adult, { learnerId, groupId }) {
		await this.require(principal, "links.manage", "link.grant");
		const kind = learnerId ? "learner" : groupId ? "group" : fail("invalid");
		if (learnerId && groupId) fail("invalid");
		if (adult?.sub === principal.sub) {
			await this.audit(principal.sub, "link.grant", principal.sub, "refused");
			fail("self");
		}
		if (!adult || !SUBJECT.test(adult.sub) || !LINK_TARGETS[adult.role]) {
			await this.audit(principal.sub, "link.grant", adult?.sub, "refused");
			fail("not_member");
		}
		if (!LINK_TARGETS[adult.role].includes(kind)) {
			await this.audit(principal.sub, "link.grant", adult.sub, "refused");
			fail("role_mismatch");
		}
		const target = await this.active(kind === "learner" ? "learners" : "groups", learnerId ?? groupId);
		try {
			const { rows } = await this.pool.query(
				`INSERT INTO adult_links (workspace_id, adult_sub, ${kind}_id, granted_by) VALUES ($1, $2, $3, $4) RETURNING id`,
				[this.workspace, adult.sub, target, principal.sub],
			);
			await this.audit(principal.sub, "link.grant", `${adult.sub}:${target}`);
			return rows[0].id;
		} catch (error) {
			if (error.code === "23505") fail("exists");
			throw error;
		}
	}

	async unlink(principal, linkId) {
		await this.require(principal, "links.manage", "link.revoke");
		const done = await this.pool.query(
			"UPDATE adult_links SET revoked_at = now(), revoked_by = $3 WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL",
			[this.workspace, this.uuid(linkId), principal.sub],
		);
		if (!done.rowCount) fail("not_found");
		await this.audit(principal.sub, "link.revoke", linkId);
	}

	/** Grants review or publish to an adult member (never yourself, never an administrator by grant). */
	async grantCapability(principal, adult, capability) {
		await this.require(principal, "capabilities.manage", "capability.grant");
		if (!GRANTABLE.includes(capability)) fail("invalid");
		if (adult?.sub === principal.sub) {
			await this.audit(principal.sub, "capability.grant", principal.sub, "refused");
			fail("self");
		}
		if (!adult || !SUBJECT.test(adult.sub) || !LINK_TARGETS[adult.role]) {
			await this.audit(principal.sub, "capability.grant", adult?.sub, "refused");
			fail("not_member");
		}
		try {
			const { rows } = await this.pool.query(
				"INSERT INTO capability_grants (workspace_id, adult_sub, capability, granted_by) VALUES ($1, $2, $3, $4) RETURNING id",
				[this.workspace, adult.sub, capability, principal.sub],
			);
			await this.audit(principal.sub, "capability.grant", `${adult.sub}:${capability}`);
			return rows[0].id;
		} catch (error) {
			if (error.code === "23505") fail("exists");
			throw error;
		}
	}

	async revokeCapability(principal, grantId) {
		await this.require(principal, "capabilities.manage", "capability.revoke");
		const done = await this.pool.query(
			"UPDATE capability_grants SET revoked_at = now(), revoked_by = $3 WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL",
			[this.workspace, this.uuid(grantId), principal.sub],
		);
		if (!done.rowCount) fail("not_found");
		await this.audit(principal.sub, "capability.revoke", grantId);
	}

	/** An adult lost their membership: every link and capability grant of theirs ends now. */
	async revokeAdult(principal, adultSub) {
		await this.require(principal, "links.manage", "adult.revoke");
		if (!SUBJECT.test(adultSub ?? "")) fail("invalid");
		await this.transaction(async (db) => {
			await db.query(
				"UPDATE adult_links SET revoked_at = now(), revoked_by = $3 WHERE workspace_id = $1 AND adult_sub = $2 AND revoked_at IS NULL",
				[this.workspace, adultSub, principal.sub],
			);
			await db.query(
				"UPDATE capability_grants SET revoked_at = now(), revoked_by = $3 WHERE workspace_id = $1 AND adult_sub = $2 AND revoked_at IS NULL",
				[this.workspace, adultSub, principal.sub],
			);
			await this.audit(principal.sub, "adult.revoke", adultSub, "done", db);
		});
	}

	/** Everything the administration page shows: learners, groups with members, active links and grants. */
	async overview(principal) {
		await this.require(principal, "directory.manage", "directory.read");
		const [learners, groups, members, links, grants] = await Promise.all([
			this.learners(principal),
			this.groups(principal),
			this.pool.query(
				"SELECT gl.group_id AS \"groupId\", gl.learner_id AS \"learnerId\" FROM group_learners gl JOIN groups g ON g.id = gl.group_id WHERE g.workspace_id = $1 AND g.archived_at IS NULL",
				[this.workspace],
			),
			this.pool.query(
				`SELECT a.id, a.adult_sub AS "adultSub", a.learner_id AS "learnerId", a.group_id AS "groupId", a.granted_at AS "grantedAt"
				 FROM adult_links a WHERE a.workspace_id = $1 AND a.revoked_at IS NULL ORDER BY a.granted_at, a.id`,
				[this.workspace],
			),
			this.pool.query(
				`SELECT id, adult_sub AS "adultSub", capability, granted_at AS "grantedAt"
				 FROM capability_grants WHERE workspace_id = $1 AND revoked_at IS NULL ORDER BY granted_at, id`,
				[this.workspace],
			),
		]);
		return {
			learners,
			groups,
			memberships: members.rows,
			links: links.rows,
			grants: grants.rows,
		};
	}

	// ── helpers ───────────────────────────────────────────────────────────────────────────────────

	uuid(id) {
		return UUID.test(id ?? "") ? id : fail("not_found");
	}

	/** The id of an active (not archived) learner or group of this workspace, else `not_found`. */
	async active(table, id) {
		const { rows } = await this.pool.query(
			`SELECT id FROM ${table === "groups" ? "groups" : "learners"} WHERE workspace_id = $1 AND id = $2 AND archived_at IS NULL`,
			[this.workspace, this.uuid(id)],
		);
		return rows[0]?.id ?? fail("not_found");
	}

	async transaction(work) {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const result = await work(client);
			await client.query("COMMIT");
			return result;
		} catch (error) {
			await client.query("ROLLBACK").catch(() => {});
			throw error;
		} finally {
			client.release();
		}
	}
}
