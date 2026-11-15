// breinhap#134 against a real Postgres: a learner profile gets an account through a one-time link
// code. Only an administrator or a covering adult creates a code; the code is stored as a hash only,
// works once within 14 days, and a new code revokes the previous one. Wrong, used, expired and
// revoked codes answer the same refusal; redeeming is rate limited per account and per address; an
// active adult member cannot link their own account as a learner. Unlinking keeps the history, and
// the database refuses to erase or rewrite any of it.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";

import { migrate } from "../src/db.mjs";
import { Directory, DirectoryError } from "../src/directory.mjs";
import {
	LearnerAccountError,
	LearnerAccounts,
	displayCode,
	normalizeCode,
} from "../src/learner-accounts.mjs";

let admin;
let pool;
const database = `breinhap_learner_accounts_${randomBytes(6).toString("hex")}`;
let now = Date.UTC(2026, 10, 12, 12);
const DAY = 86_400_000;

before(async () => {
	if (!process.env.POSTGRES_TEST_URL)
		throw new Error(
			"Use pnpm --filter @breinhap/management test, or set POSTGRES_TEST_URL for this suite",
		);
	admin = new pg.Client({ connectionString: process.env.POSTGRES_TEST_URL });
	await admin.connect();
	await admin.query(`CREATE DATABASE ${database}`);
	const url = new URL(process.env.POSTGRES_TEST_URL);
	url.pathname = `/${database}`;
	pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
	pool.on("error", () => {}); // idle connections end when the test database is dropped
	await migrate(pool);
	await migrate(pool); // a second run (another replica) applies nothing twice
});
after(async () => {
	await pool?.end();
	await admin?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
	await admin?.end();
});

const code = async (promise) => {
	try {
		await promise;
	} catch (error) {
		if (error instanceof LearnerAccountError) return error.code;
		if (error instanceof DirectoryError) return error.code;
		throw error;
	}
	return "ok";
};

let n = 0;
const sub = (name) => `test:${name}-${n++}`;
const as = (role, name = role) => ({ sub: sub(name), role: `breinhap.${role}` });
const adminPrincipal = as("admin");

/** An in-memory stand-in for the Redis fixed-window counter: every call is one attempt. */
const fakeBudget = () => {
	const counts = new Map();
	return (kind, limit, seconds, requester) => {
		const key = `${kind}:${requester}`;
		const next = (counts.get(key) ?? 0) + 1;
		counts.set(key, next);
		return next;
	};
};

function service(directory, { membership, budget = fakeBudget() } = {}) {
	return new LearnerAccounts({
		directory,
		membership,
		budget,
		clock: () => now,
	});
}

/** A workspace with two learners and one group holding the second. */
async function setup() {
	const directory = await new Directory({
		pool,
		workspace: `w-${randomBytes(4).toString("hex")}`,
	}).ready();
	const learnerA = await directory.createLearner(adminPrincipal, {
		displayName: "Lina",
		schoolYear: 3,
	});
	const learnerB = await directory.createLearner(adminPrincipal, {
		displayName: "Bram",
		schoolYear: 3,
	});
	const group = await directory.createGroup(adminPrincipal, { name: "3B" });
	await directory.addToGroup(adminPrincipal, { groupId: group, learnerId: learnerB });
	return { directory, learnerA, learnerB, group };
}

test("a created code is ten characters from the unambiguous alphabet, shown grouped, stored as a hash only", async () => {
	const { directory, learnerA } = await setup();
	const accounts = service(directory);
	assert.equal(normalizeCode("k7m2-p9qx-4t"), "K7M2P9QX4T");
	const created = await accounts.createCode(adminPrincipal, learnerA);
	assert.match(created.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);
	assert.equal(created.expiresAt.getTime(), now + 14 * DAY);
	assert.equal(
		displayCode(created.code),
		`${created.code.slice(0, 4)}-${created.code.slice(4, 8)}-${created.code.slice(8)}`,
	);
	const { rows } = await pool.query(
		"SELECT * FROM learner_link_codes WHERE workspace_id = $1",
		[directory.workspace],
	);
	assert.equal(rows.length, 1);
	const row = rows[0];
	assert.equal(row.code_hash.length, 32);
	assert.equal(
		row.code_hash.toString("hex"),
		createHash("sha256").update(created.code, "utf8").digest("hex"),
	);
	assert.equal(row.created_by, adminPrincipal.sub);
	assert.equal(row.used_at, null);
	assert.equal(row.revoked_at, null);
	// the plaintext code reaches no column of the row
	for (const value of Object.values(row))
		if (typeof value === "string") assert.ok(!value.includes(created.code));
});

test("an adult whose current role and link cover the learner creates a code; without it they learn nothing", async () => {
	const { directory, learnerA, learnerB, group } = await setup();
	const accounts = service(directory);
	const parent = as("parent");
	const teacher = as("teacher");
	await directory.link(adminPrincipal, parent, { learnerId: learnerA });
	await directory.link(adminPrincipal, teacher, { groupId: group });
	const fromParent = await accounts.createCode(parent, learnerA);
	assert.match(fromParent.code, /^[A-HJ-NP-Z2-9]{10}$/);
	// a teacher reaches the learner through their group
	const fromTeacher = await accounts.createCode(teacher, learnerB);
	assert.match(fromTeacher.code, /^[A-HJ-NP-Z2-9]{10}$/);
	// no link, no code — and the refusal is audited
	const outsider = as("tutor");
	assert.equal(await code(accounts.createCode(outsider, learnerA)), "not_found");
	assert.equal(await code(accounts.createCode(outsider, learnerB)), "not_found");
	const refused = await pool.query(
		"SELECT count(*)::int AS n FROM audit_events WHERE workspace_id = $1 AND action = 'linkcode.create' AND result = 'refused'",
		[directory.workspace],
	);
	assert.equal(refused.rows[0].n, 2);
});

test("an unknown or archived learner refuses a code", async () => {
	const { directory } = await setup();
	const accounts = service(directory);
	assert.equal(await code(accounts.createCode(adminPrincipal, "not-a-uuid")), "not_found");
	assert.equal(
		await code(accounts.createCode(adminPrincipal, "00000000-0000-0000-0000-000000000000")),
		"not_found",
	);
	const gone = await directory.createLearner(adminPrincipal, {
		displayName: "Vertrokken",
		schoolYear: 4,
	});
	await directory.archiveLearner(adminPrincipal, gone);
	assert.equal(await code(accounts.createCode(adminPrincipal, gone)), "not_found");
});

test("a new code revokes the waiting one; revoked and used codes answer like wrong codes", async () => {
	const { directory, learnerA } = await setup();
	const accounts = service(directory);
	const first = await accounts.createCode(adminPrincipal, learnerA);
	const second = await accounts.createCode(adminPrincipal, learnerA);
	assert.notEqual(first.code, second.code);
	const student = sub("student");
	assert.equal(await code(accounts.redeem(student, first.code)), "code");
	await accounts.redeem(student, second.code);
	// the first code is revoked history, the second is used; nothing is left waiting
	const rows = await pool.query(
		"SELECT revoked_at, used_at FROM learner_link_codes WHERE workspace_id = $1 AND learner_id = $2 ORDER BY created_at",
		[directory.workspace, learnerA],
	);
	assert.deepEqual(
		rows.rows.map((r) => [Boolean(r.revoked_at), Boolean(r.used_at)]),
		[
			[true, false],
			[false, true],
		],
	);
});

test("redeeming links exactly that account to exactly that learner, once", async () => {
	const { directory, learnerA } = await setup();
	const accounts = service(directory);
	const created = await accounts.createCode(adminPrincipal, learnerA);
	const student = sub("student");
	// dashes and spaces fall away; the code itself stays the same
	const learnerId = await accounts.redeem(
		student,
		`${created.code.slice(0, 5)}-${created.code.slice(5)}`.toLowerCase(),
	);
	assert.equal(learnerId, learnerA);
	const rows = await pool.query(
		"SELECT account_sub, linked_by_code, unlinked_at FROM learner_accounts WHERE workspace_id = $1 AND learner_id = $2",
		[directory.workspace, learnerA],
	);
	assert.deepEqual(rows.rows, [{ account_sub: student, linked_by_code: true, unlinked_at: null }]);
	// a second redemption, even by someone else, does nothing
	assert.equal(await code(accounts.redeem(sub("student"), created.code)), "code");
	const again = await pool.query(
		"SELECT count(*)::int AS n FROM learner_accounts WHERE workspace_id = $1",
		[directory.workspace],
	);
	assert.equal(again.rows[0].n, 1);
});

test("wrong, expired, revoked and impossible redemptions all answer the same refusal", async () => {
	const { directory, learnerA, learnerB } = await setup();
	const accounts = service(directory);
	const created = await accounts.createCode(adminPrincipal, learnerA);
	const student = sub("student");
	// a wrong code
	assert.equal(await code(accounts.redeem(student, "AAAA-BBBB-CC")), "code");
	// an expired code
	now += 15 * DAY;
	assert.equal(await code(accounts.redeem(student, created.code)), "code");
	now -= 15 * DAY;
	// the account links once: a code for another learner does not link it twice
	const forB = await accounts.createCode(adminPrincipal, learnerB);
	await accounts.redeem(student, forB.code);
	const learnerC = await directory.createLearner(adminPrincipal, {
		displayName: "An",
		schoolYear: 3,
	});
	const forC = await accounts.createCode(adminPrincipal, learnerC);
	assert.equal(await code(accounts.redeem(student, forC.code)), "code");
	// every refused redemption is audited exactly once
	const audits = await pool.query(
		"SELECT count(*)::int AS n FROM audit_events WHERE workspace_id = $1 AND action = 'linkcode.redeem' AND result = 'refused'",
		[directory.workspace],
	);
	assert.equal(audits.rows[0].n, 3);
	// a refused redemption did not consume the code: it still waits for the right student
	const rows = await pool.query(
		"SELECT used_at FROM learner_link_codes WHERE workspace_id = $1 AND learner_id = $2",
		[directory.workspace, learnerC],
	);
	assert.equal(rows.rows[0].used_at, null);
	assert.equal(await accounts.redeem(sub("student"), forC.code), learnerC);
});

test("an active adult member of the workspace cannot link their own account as a learner", async () => {
	const { directory, learnerA } = await setup();
	const parent = as("parent");
	await directory.link(adminPrincipal, parent, { learnerId: learnerA });
	const accounts = service(directory, {
		membership: (subject) =>
			subject === parent.sub ? { active: true, role: "breinhap.parent", version: 1 } : undefined,
	});
	const created = await accounts.createCode(parent, learnerA);
	assert.equal(await code(accounts.redeem(parent.sub, created.code)), "adult");
	const rows = await pool.query(
		"SELECT count(*)::int AS n FROM learner_accounts WHERE workspace_id = $1",
		[directory.workspace],
	);
	assert.equal(rows.rows[0].n, 0);
	// the code still works for a real student
	assert.equal(await accounts.redeem(sub("student"), created.code), learnerA);
});

test("redeeming is rate limited per account and per address", async () => {
	const { directory, learnerA } = await setup();
	const accounts = service(directory);
	// ten attempts from one account are answered; the eleventh is refused before any lookup
	for (let attempt = 0; attempt < 10; attempt += 1)
		assert.equal(await code(accounts.redeem("student:one", `AAAA${attempt}`)), "code");
	assert.equal(await code(accounts.redeem("student:one", "AAAA-BBBB-CC")), "rate");
	// thirty attempts from one address are answered; the thirty-first is refused
	const shared = service(directory);
	for (let attempt = 0; attempt < 30; attempt += 1)
		await code(shared.redeem(`student:two-${attempt}`, "AAAA-BBBB-CC", { requester: "addr" }));
	assert.equal(
		await code(shared.redeem("student:three", "AAAA-BBBB-CC", { requester: "addr" })),
		"rate",
	);
	assert.notEqual(learnerA, undefined);
});

test("two accounts redeeming one code at the same moment: exactly one wins", async () => {
	const { directory, learnerA } = await setup();
	const accounts = service(directory);
	const created = await accounts.createCode(adminPrincipal, learnerA);
	const [one, two] = await Promise.allSettled([
		accounts.redeem(sub("student-a"), created.code),
		accounts.redeem(sub("student-b"), created.code),
	]);
	assert.notEqual(one.status, "pending");
	assert.notEqual(two.status, "pending");
	assert.notEqual(one.status, two.status);
	const linked = await pool.query(
		"SELECT account_sub FROM learner_accounts WHERE workspace_id = $1 AND learner_id = $2",
		[directory.workspace, learnerA],
	);
	assert.equal(linked.rows.length, 1);
});

test("an administrator unlinks; the history stays and the learner can be linked again", async () => {
	const { directory, learnerA, learnerB } = await setup();
	const accounts = service(directory);
	const created = await accounts.createCode(adminPrincipal, learnerA);
	const student = sub("student");
	await accounts.redeem(student, created.code);
	assert.equal(await code(accounts.createCode(adminPrincipal, learnerA)), "linked");
	await accounts.unlink(adminPrincipal, learnerA);
	const second = await accounts.createCode(adminPrincipal, learnerA);
	const other = sub("student");
	await accounts.redeem(other, second.code);
	const rows = await pool.query(
		"SELECT account_sub, unlinked_at FROM learner_accounts WHERE workspace_id = $1 AND learner_id = $2 ORDER BY linked_at",
		[directory.workspace, learnerA],
	);
	assert.deepEqual(
		rows.rows.map((r) => [r.account_sub, Boolean(r.unlinked_at)]),
		[
			[student, true],
			[other, false],
		],
	);
	// unknown learner and non-administrator refuse
	assert.equal(await code(accounts.unlink(adminPrincipal, "not-a-uuid")), "not_found");
	const parent = as("parent");
	await directory.link(adminPrincipal, parent, { learnerId: learnerB });
	assert.equal(await code(accounts.unlink(parent, learnerB)), "forbidden");
});

test("link state follows the directory's visibility and never carries the account subject", async () => {
	const { directory, learnerA, learnerB } = await setup();
	const accounts = service(directory);
	const parent = as("parent");
	await directory.link(adminPrincipal, parent, { learnerId: learnerA });
	const created = await accounts.createCode(parent, learnerA);
	await accounts.redeem(sub("student"), created.code);
	await accounts.createCode(adminPrincipal, learnerB);

	const adminStates = await accounts.states(adminPrincipal);
	for (const state of adminStates)
		assert.deepEqual(Object.keys(state).sort(), ["codeExpiresAt", "learnerId", "linkedAt"]);
	const byId = new Map(adminStates.map((s) => [s.learnerId, s]));
	assert.ok(byId.get(learnerA).linkedAt);
	assert.equal(byId.get(learnerA).codeExpiresAt, null);
	assert.ok(byId.get(learnerB).codeExpiresAt);
	// the parent sees only their own learner
	const parentStates = await accounts.states(parent);
	assert.deepEqual(parentStates.map((s) => s.learnerId), [learnerA]);
});

test("nothing crosses the workspace boundary, and the database keeps its history", async () => {
	const { directory, learnerA } = await setup();
	const elsewhere = await new Directory({
		pool,
		workspace: `w-${randomBytes(4).toString("hex")}`,
	}).ready();
	const accounts = service(directory);
	const accountsElsewhere = service(elsewhere);
	const created = await accounts.createCode(adminPrincipal, learnerA);
	// a code of workspace A does not exist in workspace B
	assert.equal(await code(accountsElsewhere.redeem(sub("student"), created.code)), "code");
	// the database itself refuses a link across workspaces
	await assert.rejects(
		pool.query(
			"INSERT INTO learner_accounts (workspace_id, id, learner_id, account_sub) VALUES ($1, gen_random_uuid(), $2, 'someone')",
			[elsewhere.workspace, learnerA],
		),
		/another workspace or is archived/,
	);
	const emptyHash = "\\x" + "0".repeat(64);
	await assert.rejects(
		pool.query(
			`INSERT INTO learner_link_codes (workspace_id, id, learner_id, code_hash, created_by, created_at, expires_at)
			 VALUES ($1, gen_random_uuid(), $2, '${emptyHash}'::bytea, 'someone', now(), now() + interval '14 days')`,
			[elsewhere.workspace, learnerA],
		),
		/another workspace or is archived/,
	);
	// history rows refuse deletion
	await accounts.redeem(sub("student"), created.code);
	await assert.rejects(
		pool.query("DELETE FROM learner_link_codes WHERE workspace_id = $1", [directory.workspace]),
		/keep their history/,
	);
	await assert.rejects(
		pool.query("DELETE FROM learner_accounts WHERE workspace_id = $1", [directory.workspace]),
		/keep their history/,
	);
});
