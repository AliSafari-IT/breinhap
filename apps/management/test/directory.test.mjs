// breinhap#25 against a real Postgres: scoped reads, admin-only changes, role-bound links, no self
// grants, workspace isolation, revocation and the audit trail.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";

import { migrate } from "../src/db.mjs";
import { Directory, DirectoryError } from "../src/directory.mjs";

let admin;
let pool;
const database = `breinhap_test_${randomBytes(6).toString("hex")}`;

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
	pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
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
		if (error instanceof DirectoryError) return error.code;
		throw error;
	}
	return "ok";
};

let n = 0;
const sub = (name) => `test:${name}-${n++}`;
const as = (role, name = role) => ({ sub: sub(name), role: `breinhap.${role}` });

async function workspace() {
	return new Directory({
		pool,
		workspace: `w-${randomBytes(4).toString("hex")}`,
	}).ready();
}

/** A workspace with one administrator, two learners and one group holding the second learner. */
async function setup() {
	const dir = await workspace();
	const boss = as("admin");
	const ann = await dir.createLearner(boss, { displayName: "Ann", schoolYear: 3 });
	const bo = await dir.createLearner(boss, { displayName: "Bo", schoolYear: 3 });
	const klas = await dir.createGroup(boss, { name: "3B" });
	await dir.addToGroup(boss, { groupId: klas, learnerId: bo });
	return { dir, boss, ann, bo, klas };
}

const names = (rows) => rows.map((row) => row.displayName);

test("an adult without links sees no learner, no group, no count", async () => {
	const { dir } = await setup();
	for (const role of ["parent", "tutor", "teacher"]) {
		const adult = as(role);
		assert.deepEqual(await dir.learners(adult), [], role);
		assert.deepEqual(await dir.groups(adult), [], role);
		assert.equal(await dir.countLearners(adult), 0, role);
	}
});

test("a parent sees exactly the learners linked to them, and nothing else by id or by search", async () => {
	const { dir, boss, ann, bo } = await setup();
	const parent = as("parent");
	await dir.link(boss, parent, { learnerId: ann });
	assert.deepEqual(names(await dir.learners(parent)), ["Ann"]);
	assert.deepEqual(names(await dir.learners(parent, { search: "o" })), []);
	assert.equal((await dir.learner(parent, ann)).displayName, "Ann");
	// an unlinked learner looks exactly like one that does not exist
	assert.equal(await code(dir.learner(parent, bo)), "not_found");
	assert.equal(await code(dir.learner(parent, randomBytesUuid())), "not_found");
});

test("a teacher sees a linked group's learners, a tutor both kinds, each only as their role allows", async () => {
	const { dir, boss, ann, klas } = await setup();
	const teacher = as("teacher");
	const tutor = as("tutor");
	await dir.link(boss, teacher, { groupId: klas });
	await dir.link(boss, tutor, { learnerId: ann });
	await dir.link(boss, tutor, { groupId: klas });
	assert.deepEqual(names(await dir.learners(teacher)), ["Bo"]);
	assert.deepEqual(
		(await dir.groups(teacher)).map((g) => [g.name, g.size]),
		[["3B", 1]],
	);
	assert.deepEqual(names(await dir.learners(tutor)), ["Ann", "Bo"]);
	// role-bound: a parent cannot be linked to a group, a teacher not to one learner
	assert.equal(await code(dir.link(boss, as("parent"), { groupId: klas })), "role_mismatch");
	assert.equal(await code(dir.link(boss, as("teacher"), { learnerId: ann })), "role_mismatch");
});

test("a link that no longer fits the adult's current role grants nothing", async () => {
	const { dir, boss, klas } = await setup();
	const tutor = as("tutor");
	await dir.link(boss, tutor, { groupId: klas });
	// the same person, now a parent (their membership changed): group links no longer count
	assert.deepEqual(await dir.learners({ ...tutor, role: "breinhap.parent" }), []);
	assert.deepEqual(await dir.groups({ ...tutor, role: "breinhap.parent" }), []);
});

test("only an administrator manages learners, groups, links and capabilities, and refusals are audited", async () => {
	const { dir, boss, ann, klas } = await setup();
	const teacher = as("teacher");
	await dir.link(boss, teacher, { groupId: klas });
	const attempts = [
		() => dir.createLearner(teacher, { displayName: "X", schoolYear: 3 }),
		() => dir.createGroup(teacher, { name: "X" }),
		() => dir.addToGroup(teacher, { groupId: klas, learnerId: ann }),
		() => dir.archiveLearner(teacher, ann),
		() => dir.link(teacher, as("parent"), { learnerId: ann }),
		() => dir.link(teacher, teacher, { learnerId: ann }),
		() => dir.grantCapability(teacher, as("tutor"), "content.publish"),
		() => dir.overview(teacher),
		() => dir.revokeAdult(teacher, boss.sub),
	];
	for (const attempt of attempts) assert.equal(await code(attempt()), "forbidden");
	const { rows } = await pool.query(
		"SELECT count(*)::int AS n FROM audit_events WHERE workspace_id = $1 AND result = 'denied'",
		[dir.workspace],
	);
	assert.equal(rows[0].n, attempts.length);
	// and not even a student or an unknown principal reads anything
	assert.equal(await code(dir.learners({ sub: "test:s", role: "breinhap.student" })), "forbidden");
	assert.equal(await code(dir.learners(null)), "forbidden");
});

test("nobody grants a link or a capability to themself, and the database refuses it too", async () => {
	const { dir, boss, ann } = await setup();
	assert.equal(await code(dir.link(boss, boss, { learnerId: ann })), "self");
	assert.equal(await code(dir.grantCapability(boss, boss, "content.publish")), "self");
	await assert.rejects(
		pool.query(
			"INSERT INTO adult_links (workspace_id, adult_sub, learner_id, granted_by) VALUES ($1, $2, $3, $2)",
			[dir.workspace, boss.sub, ann],
		),
		/check/,
	);
});

test("only members get links; an administrator cannot be linked; grants cannot be widened by repeating them", async () => {
	const { dir, boss, ann } = await setup();
	assert.equal(await code(dir.link(boss, null, { learnerId: ann })), "not_member");
	assert.equal(await code(dir.link(boss, as("admin"), { learnerId: ann })), "not_member");
	const parent = as("parent");
	await dir.link(boss, parent, { learnerId: ann });
	assert.equal(await code(dir.link(boss, parent, { learnerId: ann })), "exists");
	assert.equal(await code(dir.link(boss, parent, {})), "invalid");
});

test("review and publish come only from an explicit grant, and revoking it takes them away", async () => {
	const { dir, boss } = await setup();
	const teacher = as("teacher");
	assert.equal(await dir.can(teacher, "content.author"), true);
	assert.equal(await dir.can(teacher, "content.review"), false);
	assert.equal(await dir.can(boss, "content.publish"), false);
	const grant = await dir.grantCapability(boss, teacher, "content.review");
	assert.equal(await dir.can(teacher, "content.review"), true);
	assert.equal(await dir.can(teacher, "content.publish"), false);
	assert.equal(await code(dir.grantCapability(boss, teacher, "directory.manage")), "invalid");
	await dir.revokeCapability(boss, grant);
	assert.equal(await dir.can(teacher, "content.review"), false);
});

test("workspaces are isolated: another workspace's administrator sees and touches nothing here", async () => {
	const { dir, boss, ann, klas } = await setup();
	const other = await workspace();
	const otherBoss = as("admin");
	assert.deepEqual(await other.learners(otherBoss), []);
	assert.deepEqual(await other.groups(otherBoss), []);
	assert.equal(await code(other.archiveLearner(otherBoss, ann)), "not_found");
	assert.equal(await code(other.link(otherBoss, as("parent"), { learnerId: ann })), "not_found");
	assert.equal(await code(other.addToGroup(otherBoss, { groupId: klas, learnerId: ann })), "not_found");
	// a link row pointing across workspaces is refused by the database itself
	await assert.rejects(
		pool.query(
			"INSERT INTO adult_links (workspace_id, adult_sub, learner_id, granted_by) VALUES ($1, 'test:x', $2, $3)",
			[other.workspace, ann, otherBoss.sub],
		),
		/another workspace/,
	);
	assert.deepEqual(names(await dir.learners(boss)), ["Ann", "Bo"]);
});

test("revoking an adult, a link, a learner or a group takes access away on the next read", async () => {
	const { dir, boss, ann, bo, klas } = await setup();
	const tutor = as("tutor");
	const link = await dir.link(boss, tutor, { learnerId: ann });
	await dir.link(boss, tutor, { groupId: klas });
	await dir.grantCapability(boss, tutor, "content.review");
	assert.deepEqual(names(await dir.learners(tutor)), ["Ann", "Bo"]);

	await dir.unlink(boss, link);
	assert.deepEqual(names(await dir.learners(tutor)), ["Bo"]);
	await dir.removeFromGroup(boss, { groupId: klas, learnerId: bo });
	assert.deepEqual(names(await dir.learners(tutor)), []);
	await dir.addToGroup(boss, { groupId: klas, learnerId: bo });
	await dir.archiveGroup(boss, klas);
	assert.deepEqual(await dir.groups(tutor), []);
	assert.deepEqual(await dir.learners(tutor), []);

	const parent = as("parent");
	await dir.link(boss, parent, { learnerId: ann });
	await dir.archiveLearner(boss, ann);
	assert.deepEqual(await dir.learners(parent), []);

	const teacher = as("teacher");
	const klas2 = await dir.createGroup(boss, { name: "3C" });
	await dir.link(boss, teacher, { groupId: klas2 });
	await dir.grantCapability(boss, teacher, "content.publish");
	await dir.revokeAdult(boss, teacher.sub);
	assert.deepEqual(await dir.groups(teacher), []);
	assert.equal(await dir.can(teacher, "content.publish"), false);
});

test("learner profiles hold a short name and a school year only; markup and control characters are refused", async () => {
	const { dir, boss } = await setup();
	for (const displayName of ["", "x".repeat(41), "<script>", "Ann\u0000"])
		assert.equal(await code(dir.createLearner(boss, { displayName, schoolYear: 3 })), "invalid");
	for (const schoolYear of [0, 7, "3; DROP", null])
		assert.equal(await code(dir.createLearner(boss, { displayName: "Ann", schoolYear })), "invalid");
	const { rows } = await pool.query(
		"SELECT column_name FROM information_schema.columns WHERE table_name = 'learners' ORDER BY ordinal_position",
	);
	assert.deepEqual(
		rows.map((row) => row.column_name),
		["id", "workspace_id", "display_name", "school_year", "created_by", "created_at", "archived_at"],
	);
});

test("the audit trail holds hashed ids, never names or account ids", async () => {
	const { dir, boss, ann } = await setup();
	const parent = as("parent");
	await dir.link(boss, parent, { learnerId: ann });
	const { rows } = await pool.query(
		"SELECT actor, target, action FROM audit_events WHERE workspace_id = $1",
		[dir.workspace],
	);
	const text = JSON.stringify(rows);
	assert.ok(rows.some((row) => row.action === "link.grant"));
	for (const secret of [boss.sub, parent.sub, ann, "Ann"]) assert.ok(!text.includes(secret), secret);
});

function randomBytesUuid() {
	const hex = randomBytes(16).toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
