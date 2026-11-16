import { createHash, randomBytes, randomUUID } from "node:crypto";

import { DirectoryError, ROLES } from "./directory.mjs";
import { digest } from "./store.mjs";

/**
 * The link between a learner profile and a student's ASafariM account, made with a one-time
 * link code (breinhap#134).
 *
 * A learner profile has no account; an adult creates a code and hands it to the student, who
 * redeems it from their own signed-in session (breinhap#135). The rules, enforced here and
 * repeated by the database (migration 011):
 *
 * - Only an administrator, or an adult whose CURRENT role and unrevoked link cover that learner
 *   (the same visibility as assigning, breinhap#25/#34), may create a code — never for an account
 *   of their own: an active adult member cannot redeem.
 * - A code is 10 characters from an alphabet without look-alikes, shown once, stored only as a
 *   SHA-256 hash, valid 14 days, single use. A new code revokes the previous one.
 * - Redeeming is rate limited per account and per address; wrong, used, expired and revoked codes
 *   all answer the same refusal (`code`), so nobody learns which of the four happened.
 * - One active link per learner profile and per account subject per workspace; unlinking keeps the
 *   history row. The student's e-mail address never reaches this database — only the subject.
 * - Every change and refusal is audited with hashed ids only.
 */

const DAY = 86400_000;
/** How long a code may wait to be redeemed. */
const CODE_TTL = 14 * DAY;
/** The alphabet: no I, O, 0 or 1, so a student can copy the code by eye. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;
const CODE = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);
const SUBJECT = /^[A-Za-z0-9:._@-]{1,400}$/;
/** Redeem budget: per account and per address, over the same 15 minutes. */
const REDEEM_ACCOUNT_LIMIT = 10;
const REDEEM_ADDRESS_LIMIT = 30;
const REDEEM_WINDOW = 900;

export class LearnerAccountError extends Error {
	constructor(code) {
		super(`learnerAccount.${code}`);
		this.code = code;
	}
}
const fail = (code) => {
	throw new LearnerAccountError(code);
};

/** A new link code: `CODE_LENGTH` characters, uniformly drawn from the look-alike-free alphabet. */
export const linkCode = () => {
	const bytes = randomBytes(CODE_LENGTH);
	let code = "";
	for (let i = 0; i < CODE_LENGTH; i += 1) code += ALPHABET[bytes[i] & 31];
	return code;
};

/** The hash a code is stored and looked up by. The plaintext code never reaches the database. */
export const codeHash = (code) => createHash("sha256").update(code, "utf8").digest();

/** The code as the student types it: dashes and spaces fall away, letters are upper case. */
export const normalizeCode = (value) =>
	String(value ?? "")
		.toUpperCase()
		.replace(/[\s-]/g, "");

/** The code as the adult reads it out: grouped, so the student can copy it in one glance. */
export const displayCode = (code) => (CODE.test(code) ? `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}` : code);

const isAdult = (principal) =>
	Boolean(principal) &&
	typeof principal.sub === "string" &&
	SUBJECT.test(principal.sub) &&
	ROLES.includes(principal.role);

export class LearnerAccounts {
	constructor({ directory, membership, budget, clock }) {
		this.directory = directory;
		this.pool = directory.pool;
		this.workspace = directory.workspace;
		// `membership(sub)` is the trusted adult-membership reader (Redis); it keeps an active adult
		// from linking their own account as a learner.
		this.membership = membership;
		// `budget(kind, limit, seconds, requester)` is the Redis fixed-window counter, with hashed
		// requesters: raw subjects and addresses never reach it.
		this.budget = budget;
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
	async audit(db, actor, action, target, result = "done") {
		await this.directory.audit(actor, action, target, result, db);
	}

	/**
	 * The learner a code would be created for, through the directory's visibility: an administrator
	 * reaches every active learner of the workspace, any other adult only the learners their current
	 * role and links cover. Unknown, archived and out-of-scope learners all refuse `not_found`.
	 */
	async coveredLearner(principal, learnerId) {
		try {
			return await this.directory.learner(principal, learnerId);
		} catch (error) {
			if (error instanceof DirectoryError) {
				await this.audit(this.pool, principal.sub, "linkcode.create", learnerId ?? "unknown", "refused");
			}
			throw error;
		}
	}

	/**
	 * Creates a link code for one learner: shown once to the adult, stored as a hash only, valid
	 * 14 days. A waiting code of the same learner is revoked. Refused (`linked`) when the learner
	 * already has an active account link.
	 */
	async createCode(principal, learnerId) {
		if (!isAdult(principal)) fail("forbidden");
		const learner = await this.coveredLearner(principal, learnerId);
		const { rows: linked } = await this.pool.query(
			"SELECT 1 FROM learner_accounts WHERE workspace_id = $1 AND learner_id = $2 AND unlinked_at IS NULL",
			[this.workspace, learner.id],
		);
		if (linked.length) {
			await this.audit(this.pool, principal.sub, "linkcode.create", learner.id, "refused");
			fail("linked");
		}
		const plain = linkCode();
		const now = await this.time();
		const expiresAt = new Date(+now + CODE_TTL);
		await this.tx(async (db) => {
			// one waiting code per learner: creating a code ends the previous one
			await db.query(
				"UPDATE learner_link_codes SET revoked_at = $3 WHERE workspace_id = $1 AND learner_id = $2 AND used_at IS NULL AND revoked_at IS NULL",
				[this.workspace, learner.id, now],
			);
			await db.query(
				"INSERT INTO learner_link_codes (workspace_id, id, learner_id, code_hash, created_by, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
				[this.workspace, randomUUID(), learner.id, codeHash(plain), principal.sub, now, expiresAt],
			);
			await this.audit(db, principal.sub, "linkcode.create", learner.id);
		});
		return { code: plain, learnerId: learner.id, learnerName: learner.displayName, expiresAt };
	}

	/** Ends a code that is still waiting, without making a new one. */
	async revokeCode(principal, learnerId) {
		if (!isAdult(principal)) fail("forbidden");
		const learner = await this.coveredLearner(principal, learnerId);
		const done = await this.pool.query(
			"UPDATE learner_link_codes SET revoked_at = $3 WHERE workspace_id = $1 AND learner_id = $2 AND used_at IS NULL AND revoked_at IS NULL",
			[this.workspace, learner.id, await this.time()],
		);
		if (!done.rowCount) fail("not_found");
		await this.audit(this.pool, principal.sub, "linkcode.revoke", learner.id);
	}

	/**
	 * Redeems a code as the signed-in subject (the student's own session, breinhap#135). Wrong,
	 * used, expired and revoked codes, a learner or account already linked, and every other
	 * impossible redemption all refuse with the same `code` error. Rate limited per account and
	 * per address (`requester` arrives already hashed). Refusals are audited after the transaction:
	 * an audit written into an aborted transaction would vanish with it.
	 */
	async redeem(subject, value, { requester } = {}) {
		if (!SUBJECT.test(subject ?? "")) fail("code");
		const plain = normalizeCode(value);
		if (this.budget) {
			// The identity store's budget answers true while the window has room; a plain counter answers
			// the attempt number. Both are understood (breinhap#135: with the store's boolean, the former
			// `count > limit` comparison never refused anything).
			const spent = (answer, limit) => (typeof answer === "number" ? answer > limit : answer !== true);
			if (spent(await this.budget("linkcode-redeem-account", REDEEM_ACCOUNT_LIMIT, REDEEM_WINDOW, digest(subject)), REDEEM_ACCOUNT_LIMIT))
				fail("rate");
			if (
				requester &&
				spent(await this.budget("linkcode-redeem-address", REDEEM_ADDRESS_LIMIT, REDEEM_WINDOW, requester), REDEEM_ADDRESS_LIMIT)
			)
				fail("rate");
		}
		// nobody links their own account as a learner: only a student redeems
		const member = this.membership ? await this.membership(subject) : undefined;
		if (member?.active === true && ROLES.includes(member.role)) {
			await this.audit(this.pool, subject, "linkcode.redeem", plain, "refused");
			fail("adult");
		}
		if (!CODE.test(plain)) fail("code");
		const hash = codeHash(plain);
		const now = await this.time();
		// set while the transaction runs, audited after it ended
		let refused;
		let learnerId;
		try {
			learnerId = await this.tx(async (db) => {
				const { rows } = await db.query(
					"SELECT id, learner_id AS \"learnerId\", expires_at AS \"expiresAt\" FROM learner_link_codes WHERE workspace_id = $1 AND code_hash = $2",
					[this.workspace, hash],
				);
				const waiting = rows[0];
				// the same answer for a wrong, expired, revoked or already-spent code
				if (!waiting || waiting.expiresAt <= now) {
					refused = plain;
					return null;
				}
				const used = await db.query(
					"UPDATE learner_link_codes SET used_at = $3, used_by = $2 WHERE workspace_id = $1 AND id = $4 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $3",
					[this.workspace, subject, now, waiting.id],
				);
				if (!used.rowCount) {
					refused = plain;
					return null;
				}
				try {
					await db.query(
						"INSERT INTO learner_accounts (workspace_id, id, learner_id, account_sub, linked_by_code, linked_at) VALUES ($1, $2, $3, $4, true, $5)",
						[this.workspace, randomUUID(), waiting.learnerId, subject, now],
					);
				} catch (error) {
					// the learner or the account is already linked (unique active row): nothing to learn,
					// and the transaction ends so the code stays waiting for the right student
					if (error.code === "23505") {
						refused = plain;
						throw new LearnerAccountError("code");
					}
					throw error;
				}
				return waiting.learnerId;
			});
		} catch (error) {
			// the refusal was thrown to end the transaction; it is audited below, once
			if (!(refused !== undefined && error instanceof LearnerAccountError && error.code === "code"))
				throw error;
		}
		if (refused !== undefined) {
			await this.audit(this.pool, subject, "linkcode.redeem", refused, "refused");
			fail("code");
		}
		await this.audit(this.pool, subject, "linkcode.redeem", learnerId);
		return learnerId;
	}

	/**
	 * The learner profile this account is linked to right now (breinhap#135), or null: no link, an
	 * ended link, or an archived profile. Read on every student request, so ending a link ends the
	 * student's access on their next request.
	 */
	async linkedLearner(subject) {
		if (!SUBJECT.test(subject ?? "")) return null;
		const { rows } = await this.pool.query(
			`SELECT la.learner_id AS "learnerId"
			 FROM learner_accounts la
			 JOIN learners l ON l.workspace_id = la.workspace_id AND l.id = la.learner_id
			 WHERE la.workspace_id = $1 AND la.account_sub = $2 AND la.unlinked_at IS NULL AND l.archived_at IS NULL`,
			[this.workspace, subject],
		);
		return rows[0]?.learnerId ?? null;
	}

	/** When this account's current link began (breinhap#36, the student's own data page), or null. */
	async linkedSince(subject) {
		if (!SUBJECT.test(subject ?? "")) return null;
		const { rows } = await this.pool.query(
			`SELECT la.linked_at AS "linkedAt"
			 FROM learner_accounts la
			 JOIN learners l ON l.workspace_id = la.workspace_id AND l.id = la.learner_id
			 WHERE la.workspace_id = $1 AND la.account_sub = $2 AND la.unlinked_at IS NULL AND l.archived_at IS NULL`,
			[this.workspace, subject],
		);
		return rows[0]?.linkedAt ?? null;
	}

	/**
	 * The student ends their own link from /p/mijn/gegevens (breinhap#36). The history row stays; the
	 * progress stored for the learner profile is deleted at once. Returns whether a link ended.
	 */
	async unlinkSelf(subject) {
		if (!SUBJECT.test(subject ?? "")) return false;
		const ended = await this.tx(async (db) => {
			const done = await db.query(
				`UPDATE learner_accounts SET unlinked_at = $3
				 WHERE workspace_id = $1 AND account_sub = $2 AND unlinked_at IS NULL
				 RETURNING learner_id AS "learnerId"`,
				[this.workspace, subject, await this.time(db)],
			);
			const learnerId = done.rows[0]?.learnerId;
			if (!learnerId) return null;
			await db.query("DELETE FROM assignment_progress WHERE workspace_id = $1 AND learner_id = $2", [this.workspace, learnerId]);
			await this.audit(db, subject, "learner.unlink_self", learnerId);
			return learnerId;
		});
		return Boolean(ended);
	}

	/**
	 * An administrator ends a learner's account link (the student can end it from their own page
	 * later, breinhap#135). The history row stays; a waiting code of the learner ends with it.
	 */
	async unlink(principal, learnerId) {
		await this.directory.require(principal, "links.manage", "learner.unlink");
		await this.tx(async (db) => {
			const done = await db.query(
				"UPDATE learner_accounts SET unlinked_at = $3 WHERE workspace_id = $1 AND learner_id = $2 AND unlinked_at IS NULL",
				[this.workspace, this.directory.uuid(learnerId), await this.time(db)],
			);
			if (!done.rowCount) fail("not_found");
			await db.query(
				"UPDATE learner_link_codes SET revoked_at = $3 WHERE workspace_id = $1 AND learner_id = $2 AND used_at IS NULL AND revoked_at IS NULL",
				[this.workspace, learnerId, await this.time(db)],
			);
			// breinhap#36: the student's stored progress ends with the link, at once
			await db.query("DELETE FROM assignment_progress WHERE workspace_id = $1 AND learner_id = $2", [
				this.workspace,
				this.directory.uuid(learnerId),
			]);
			await this.audit(db, principal.sub, "learner.unlink", learnerId);
		});
	}

	/**
	 * The link state of every learner the principal may see: not linked, a waiting code until a
	 * date, or linked since a date. No names beyond the directory's own visibility, and never the
	 * account subject — the pages only show the state.
	 */
	async states(principal) {
		if (!isAdult(principal)) fail("forbidden");
		const params = [this.workspace];
		const scope = this.directory.visibility(principal, "l", params);
		const { rows } = await this.pool.query(
			`SELECT l.id AS "learnerId",
			   la.linked_at AS "linkedAt",
			   c.expires_at AS "codeExpiresAt"
			 FROM learners l
			 LEFT JOIN learner_accounts la
			   ON la.workspace_id = l.workspace_id AND la.learner_id = l.id AND la.unlinked_at IS NULL
			 LEFT JOIN learner_link_codes c
			   ON c.workspace_id = l.workspace_id AND c.learner_id = l.id
			  AND c.used_at IS NULL AND c.revoked_at IS NULL
			 WHERE l.workspace_id = $1 AND l.archived_at IS NULL AND ${scope}
			 ORDER BY l.display_name, l.id`,
			params,
		);
		return rows;
	}
}
