// breinhap#137 against a real Postgres: the adult who assigned homework sees, per learner it reaches
// now, only not started / started / finished with the day, and an administrator only counts. Scope
// follows the adult's current role and link, current group membership and the assigner; answers,
// pages and times of day never leave the service.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";

import { AssignmentStore } from "../src/assignments.mjs";
import { ContentStore } from "../src/content.mjs";
import { migrate } from "../src/db.mjs";
import { Directory } from "../src/directory.mjs";
import { ProgressStore } from "../src/progress.mjs";
import { PublishingStore } from "../src/publishing.mjs";

let admin;
let pool;
const database = `breinhap_status_${randomBytes(6).toString("hex")}`;
let now = Date.UTC(2026, 10, 12, 12);

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
	pool.on("error", () => {});
	await migrate(pool);
});
after(async () => {
	await pool?.end();
	await admin?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
	await admin?.end();
});

const rejects = (promise, code) =>
	assert.rejects(promise, (error) => {
		assert.equal(error.code, code);
		return true;
	});
const adminPrincipal = () => ({ sub: "test:admin", role: "breinhap.admin" });
let n = 0;
const adult = (role = "teacher") => ({
	sub: `test:${role}-${n++}`,
	role: `breinhap.${role}`,
});

const sources = [{ kind: "own", title: "Eigen werk" }];
function object(id = `lo-${n++}`) {
	return {
		schemaVersion: 1,
		id,
		subject: "biologie",
		title: "Prikkel en reactie",
		grade: 3,
		curriculum: { leerdoel: "De leerlingen leggen prikkel en reactie uit." },
		review: { status: "draft" },
		missions: [
			{
				id: `${id}-m1`,
				title: "Wat is een prikkel?",
				minutes: 3,
				warmup: { text: "Denk aan iets dat je laat schrikken." },
				learn: [{ text: "Een prikkel is een verandering die een organisme waarneemt." }],
				practice: [
					{
						kind: "choice",
						prompt: "Wat is een prikkel?",
						options: ["Een verandering", "Een spier"],
						answerIndex: 0,
						explanation: "Een prikkel is een verandering in de omgeving.",
					},
				],
				check: [
					{
						kind: "order",
						prompt: "Zet in volgorde.",
						items: ["prikkel", "reactie", "receptor"],
						explanation: "Eerst de prikkel, dan de receptor, dan de reactie.",
					},
				],
			},
		],
	};
}
/** Two missions, so started and finished differ. */
function twoMissions() {
	const draft = object();
	draft.missions.push({ ...structuredClone(draft.missions[0]), id: `${draft.id}-m2`, title: "Wat is een reactie?" });
	return draft;
}

async function setup() {
	now = Date.UTC(2026, 10, 12, 12);
	const directory = await new Directory({
		pool,
		workspace: `w-${randomBytes(4).toString("hex")}`,
	}).ready();
	const content = new ContentStore({ directory });
	const publishing = new PublishingStore({ content });
	const members = new Map();
	const assignments = new AssignmentStore({
		directory,
		clock: () => now,
		membership: async (sub) => members.get(sub) ?? null,
	});
	const setMember = (principal, active = true) =>
		members.set(principal.sub, {
			role: principal.role,
			active,
			version: randomBytes(8).toString("hex"),
		});
	const boss = adminPrincipal();
	/** A published, independently approved object. Returns its publication row. */
	async function publication(author = adult("teacher")) {
		const reviewer = adult("parent");
		const publisher = adult("teacher");
		await directory.grantCapability(boss, reviewer, "content.review");
		await directory.grantCapability(boss, publisher, "content.publish");
		const draft = twoMissions();
		await content.create(author, draft, sources);
		await content.snapshot(author, draft.id, 1);
		await content.submit(author, draft.id, 1);
		await content.review(reviewer, draft.id, 1, "approved");
		const published = await publishing.publish(publisher, draft.id, 1);
		return { ...published, objectId: draft.id, author, reviewer, publisher };
	}
	async function learner(name = "Leerling Een", schoolYear = 3) {
		return directory.createLearner(boss, { displayName: name, schoolYear });
	}
	async function group(name = "Klas 3A") {
		return directory.createGroup(boss, { name });
	}
	async function link(adultPrincipal, target) {
		return directory.link(boss, adultPrincipal, target);
	}
	const progress = new ProgressStore({ directory, clock: () => now });
	return {
		progress,
		directory,
		content,
		publishing,
		assignments,
		members,
		setMember,
		boss,
		publication,
		learner,
		group,
		link,
		advance: (ms) => {
			now += ms;
		},
	};
}

const DAY = 86400_000;
const hashOf = async (publicationId) =>
	(await pool.query("SELECT pack_hash FROM content_publications WHERE id = $1", [publicationId])).rows[0].pack_hash;
const missionsOf = (publication) => [`${publication.objectId}-m1`, `${publication.objectId}-m2`];
/** The student's own player path: begin a mission, then save it as finished. */
async function play(f, learnerId, assignmentId, publication, mission, { finish = false } = {}) {
	const hash = await hashOf(publication.id);
	const row = await f.progress.begin(learnerId, assignmentId, mission, hash);
	if (finish)
		await f.progress.save(learnerId, assignmentId, mission, row.version, {
			publicationHash: hash,
			page: 3,
			answers: "0c1;3o2.0.1",
			finished: true,
		});
}
const statusOf = async (f, principal, assignmentId) =>
	(await f.assignments.listWithStatus(principal)).find((row) => row.id === assignmentId)?.learners;
const byName = (learners) => Object.fromEntries(learners.map(({ displayName, ...rest }) => [displayName, rest]));

test("the assigner sees not started, started and finished with the day, and nothing else", async () => {
	const f = await setup();
	const teacher = adult("teacher");
	f.setMember(teacher);
	const group = await f.group();
	await f.link(teacher, { groupId: group });
	const lina = await f.learner("Lina");
	const noor = await f.learner("Noor");
	const sam = await f.learner("Sam");
	for (const learnerId of [lina, noor, sam]) await f.directory.addToGroup(f.boss, { groupId: group, learnerId });
	const publication = await f.publication();
	const { id } = await f.assignments.assign(teacher, { publicationId: publication.id, audienceKind: "group", audienceId: group });
	const [m1, m2] = missionsOf(publication);

	// Lina starts on day 1 (late in the evening) and finishes both missions on day 3
	f.advance(10 * 3600_000 + 59 * 60_000); // 2026-11-12 22:59 UTC
	await play(f, lina, id, publication, m1, { finish: true });
	f.advance(2 * DAY);
	await play(f, lina, id, publication, m2, { finish: true });
	// Noor finishes one of two missions: still started
	await play(f, noor, id, publication, m1, { finish: true });

	const learners = await statusOf(f, teacher, id);
	assert.deepEqual(byName(learners), {
		Lina: { learnerId: lina, state: "finished", startedOn: "2026-11-12", finishedOn: "2026-11-14" },
		Noor: { learnerId: noor, state: "started", startedOn: "2026-11-14", finishedOn: null },
		Sam: { learnerId: sam, state: "not_started", startedOn: null, finishedOn: null },
	});
	// exactly these keys: no answers, page, version, score or time of day leave the service
	for (const learner of learners)
		assert.deepEqual(Object.keys(learner).sort(), ["displayName", "finishedOn", "learnerId", "startedOn", "state"]);
	const text = JSON.stringify(await f.assignments.listWithStatus(teacher));
	assert.ok(!text.includes("0c1;3o2"), "answers never leave");
	assert.ok(!/T\d\d:\d\d/.test(JSON.stringify(learners)), "no time of day");
});

test("progress on another publication or an unknown mission does not count", async () => {
	const f = await setup();
	const parent = adult("parent");
	f.setMember(parent);
	const learner = await f.learner("Lina");
	await f.link(parent, { learnerId: learner });
	const publication = await f.publication();
	const { id } = await f.assignments.assign(parent, { publicationId: publication.id, audienceKind: "learner", audienceId: learner });
	await f.progress.begin(learner, id, missionsOf(publication)[0], "A".repeat(43));
	await f.progress.begin(learner, id, "not-a-mission", await hashOf(publication.id));
	assert.deepEqual(byName(await statusOf(f, parent, id)).Lina.state, "not_started");
});

test("group membership changes: a learner who left disappears, a new member starts as not started", async () => {
	const f = await setup();
	const teacher = adult("teacher");
	f.setMember(teacher);
	const group = await f.group();
	await f.link(teacher, { groupId: group });
	const lina = await f.learner("Lina");
	const sam = await f.learner("Sam");
	const archived = await f.learner("Weg");
	for (const learnerId of [lina, sam, archived]) await f.directory.addToGroup(f.boss, { groupId: group, learnerId });
	const publication = await f.publication();
	const { id } = await f.assignments.assign(teacher, { publicationId: publication.id, audienceKind: "group", audienceId: group });
	await play(f, lina, id, publication, missionsOf(publication)[0]);

	await f.directory.removeFromGroup(f.boss, { groupId: group, learnerId: lina });
	await f.directory.archiveLearner(f.boss, archived);
	const newcomer = await f.learner("Nieuw");
	await f.directory.addToGroup(f.boss, { groupId: group, learnerId: newcomer });
	assert.deepEqual(Object.keys(byName(await statusOf(f, teacher, id))).sort(), ["Nieuw", "Sam"]);
	assert.equal(byName(await statusOf(f, teacher, id)).Nieuw.state, "not_started");
});

test("a revoked link or a role that no longer fits hides the status; another adult's assignment is never shown", async () => {
	const f = await setup();
	const parent = adult("parent");
	const other = adult("parent");
	f.setMember(parent);
	f.setMember(other);
	const learner = await f.learner("Lina");
	const link = await f.link(parent, { learnerId: learner });
	await f.link(other, { learnerId: learner });
	const publication = await f.publication();
	const { id } = await f.assignments.assign(parent, { publicationId: publication.id, audienceKind: "learner", audienceId: learner });
	await play(f, learner, id, publication, missionsOf(publication)[0], { finish: true });
	assert.equal((await statusOf(f, parent, id)).length, 1);

	// the other parent is linked to the same learner but did not make the assignment
	assert.deepEqual(await f.assignments.listWithStatus(other), []);
	// a teacher (groups only) never sees a learner assignment, even with the same subject
	f.members.set(parent.sub, { role: "breinhap.teacher", active: true, version: "changed" });
	assert.equal(await statusOf(f, { ...parent, role: "breinhap.teacher" }, id), undefined);
	f.setMember(parent);
	// an ended membership hides it
	f.members.set(parent.sub, { role: "breinhap.parent", active: false, version: "ended" });
	assert.equal(await statusOf(f, parent, id), undefined);
	f.setMember(parent);
	assert.equal((await statusOf(f, parent, id)).length, 1);
	// a revoked link hides it at once
	await f.directory.unlink(f.boss, link);
	assert.equal(await statusOf(f, parent, id), undefined);
	assert.deepEqual(await f.assignments.listWithStatus(parent), []);
});

test("without content.assign there is no status, and an administrator sees counts only", async () => {
	const f = await setup();
	const teacher = adult("teacher");
	const parent = adult("parent");
	f.setMember(teacher);
	f.setMember(parent);
	const group = await f.group("Klas 3B");
	await f.link(teacher, { groupId: group });
	const names = ["Lina", "Noor", "Sam"];
	const ids = [];
	for (const name of names) {
		const learnerId = await f.learner(name);
		ids.push(learnerId);
		await f.directory.addToGroup(f.boss, { groupId: group, learnerId });
	}
	await f.link(parent, { learnerId: ids[0] });
	const publication = await f.publication();
	const groupAssignment = await f.assignments.assign(teacher, { publicationId: publication.id, audienceKind: "group", audienceId: group });
	const own = await f.assignments.assign(parent, { publicationId: publication.id, audienceKind: "learner", audienceId: ids[0] });
	for (const mission of missionsOf(publication)) await play(f, ids[0], groupAssignment.id, publication, mission, { finish: true });
	await play(f, ids[1], groupAssignment.id, publication, missionsOf(publication)[0]);
	await play(f, ids[0], own.id, publication, missionsOf(publication)[0]);

	await rejects(f.assignments.listWithStatus(f.boss), "forbidden");
	await rejects(f.assignments.statusCounts(teacher), "forbidden");
	const counts = await f.assignments.statusCounts(f.boss);
	assert.deepEqual(counts, [
		{
			publicationId: publication.id,
			title: "Prikkel en reactie",
			revision: 1,
			publicationState: "active",
			assignments: 2,
			learners: 4,
			notStarted: 1,
			started: 2,
			finished: 1,
		},
	]);
	const text = JSON.stringify(counts);
	for (const name of [...names, "Klas 3B", teacher.sub, parent.sub, ...ids]) assert.ok(!text.includes(name), name);

	// a revoked assignment and one whose assigner lost the link leave the counts
	await f.assignments.revoke(parent, own.id);
	assert.equal((await f.assignments.statusCounts(f.boss))[0].learners, 3);
	f.members.set(teacher.sub, { role: "breinhap.parent", active: true, version: "changed" });
	assert.deepEqual(await f.assignments.statusCounts(f.boss), []);
});
