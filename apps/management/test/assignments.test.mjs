// breinhap#34 against a real Postgres: an adult assigns only an active, independently reviewed
// publication to a learner or group their current role and links allow. The learner-facing boundary
// re-checks the publication state, the window, group membership and the adult's current membership
// and link on every read, and never exposes names or group data. The database keeps the history and
// refuses to erase or rewrite it.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";

import { AssignmentStore } from "../src/assignments.mjs";
import { ContentStore } from "../src/content.mjs";
import { migrate } from "../src/db.mjs";
import { Directory } from "../src/directory.mjs";
import { PublishingStore } from "../src/publishing.mjs";

let admin;
let pool;
const database = `breinhap_assignments_${randomBytes(6).toString("hex")}`;
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
		const draft = object();
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
	return {
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
const iso = (ms) => new Date(ms).toISOString();

test("assigning needs content.assign, an active publication and the role's own link kind", async () => {
	const f = await setup();
	const parent = adult("parent");
	f.setMember(parent);
	const learner = await f.learner();
	const link = await f.link(parent, { learnerId: learner });
	const publication = await f.publication();

	// administrators manage people and access, not assignments
	await rejects(f.assignments.assign(f.boss, {
		publicationId: publication.id,
		audienceKind: "learner",
		audienceId: learner,
	}), "forbidden");

	// an adult without a link cannot even name the learner
	const stranger = adult("parent");
	f.setMember(stranger);
	await rejects(f.assignments.assign(stranger, {
		publicationId: publication.id,
		audienceKind: "learner",
		audienceId: learner,
	}), "not_found");

	// the linked parent assigns, once
	const first = await f.assignments.assign(parent, {
		publicationId: publication.id,
		audienceKind: "learner",
		audienceId: learner,
	});
	assert.match(first.id, /^[0-9a-f-]{36}$/);
	assert.equal(first.version, 1);
	await rejects(f.assignments.assign(parent, {
		publicationId: publication.id,
		audienceKind: "learner",
		audienceId: learner,
	}), "exists");

	// a direct id from another workspace is not found, not a different error
	await rejects(f.assignments.assign(parent, {
		publicationId: publication.id,
		audienceKind: "learner",
		audienceId: randomUUID(),
	}), "not_found");
	await rejects(f.assignments.assign(parent, {
		publicationId: randomUUID(),
		audienceKind: "learner",
		audienceId: learner,
	}), "not_found");

	// a teacher may see the learner through a group but assigns to groups, not to that learner
	const teacher = adult("teacher");
	f.setMember(teacher);
	const group = await f.group();
	await f.link(teacher, { groupId: group });
	await f.directory.addToGroup(f.boss, { groupId: group, learnerId: learner });
	await rejects(f.assignments.assign(teacher, {
		publicationId: publication.id,
		audienceKind: "learner",
		audienceId: learner,
	}), "not_found");

	// the parent cannot assign to a group either
	await rejects(f.assignments.assign(parent, {
		publicationId: publication.id,
		audienceKind: "group",
		audienceId: group,
	}), "not_found");

	// revoking the link ends the ability to assign again
	await f.directory.unlink(f.boss, link);
	await rejects(f.assignments.assign(parent, {
		publicationId: publication.id,
		audienceKind: "learner",
		audienceId: learner,
	}), "not_found");
});

test("parent, tutor and teacher scopes follow the role and its links", async () => {
	const f = await setup();
	const learner = await f.learner();
	const group = await f.group();
	const otherGroup = await f.group("Klas 3B");
	const publication = await f.publication();
	const tutorPublication = await f.publication();

	const parent = adult("parent");
	const tutor = adult("tutor");
	const teacher = adult("teacher");
	for (const principal of [parent, tutor, teacher]) f.setMember(principal);
	await f.link(parent, { learnerId: learner });
	await f.link(tutor, { learnerId: learner });
	await f.link(tutor, { groupId: group });
	await f.link(teacher, { groupId: group });
	await f.link(teacher, { groupId: otherGroup });
	await f.directory.addToGroup(f.boss, { groupId: group, learnerId: learner });

	// parent: learner only
	await f.assignments.assign(parent, {
		publicationId: publication.id,
		audienceKind: "learner",
		audienceId: learner,
	});
	await rejects(f.assignments.assign(parent, {
		publicationId: publication.id,
		audienceKind: "group",
		audienceId: group,
	}), "not_found");

	// tutor: either kind (a second publication because one target has one active assignment)
	await f.assignments.assign(tutor, {
		publicationId: tutorPublication.id,
		audienceKind: "learner",
		audienceId: learner,
	});
	await f.assignments.assign(tutor, {
		publicationId: tutorPublication.id,
		audienceKind: "group",
		audienceId: group,
	});

	// teacher: group only, even though the learner is visible through that group
	await f.assignments.assign(teacher, {
		publicationId: tutorPublication.id,
		audienceKind: "group",
		audienceId: otherGroup,
	});
	await rejects(f.assignments.assign(teacher, {
		publicationId: tutorPublication.id,
		audienceKind: "learner",
		audienceId: learner,
	}), "not_found");

	// every adult sees only their own assignments
	const parentRows = await f.assignments.list(parent);
	assert.equal(parentRows.length, 1);
	assert.equal(parentRows[0].learnerName, "Leerling Een");
	assert.equal("groupName" in parentRows[0], true);
	const teacherRows = await f.assignments.list(teacher);
	assert.equal(teacherRows.length, 1);
	assert.equal(teacherRows[0].groupName, "Klas 3B");
	assert.equal(teacherRows[0].learnerName, null);
	assert.equal((await f.assignments.list(tutor)).length, 2);
});

test("learner discovery returns only explicitly assigned active publications and no names", async () => {
	const f = await setup();
	const parent = adult("parent");
	const other = adult("parent");
	f.setMember(parent);
	f.setMember(other);
	const learner = await f.learner("Leerling Een");
	const otherLearner = await f.learner("Leerling Twee");
	await f.link(parent, { learnerId: learner });
	await f.link(other, { learnerId: otherLearner });
	const own = await f.publication();
	const foreign = await f.publication();

	await f.assignments.assign(parent, {
		publicationId: own.id,
		audienceKind: "learner",
		audienceId: learner,
	});
	await f.assignments.assign(other, {
		publicationId: foreign.id,
		audienceKind: "learner",
		audienceId: otherLearner,
	});

	const available = await f.assignments.availableForLearner(learner);
	assert.equal(available.length, 1);
	assert.equal(available[0].publicationId, own.id);
	assert.equal(available[0].title, "Prikkel en reactie");
	for (const key of [
		"learnerName",
		"groupName",
		"learnerId",
		"groupId",
		"assignedBy",
		"groupMembers",
	])
		assert.equal(key in available[0], false, key);

	// the other learner's publication cannot be reached by direct id
	await rejects(f.assignments.publicationForLearner(learner, foreign.id), "not_found");
	await rejects(f.assignments.publicationForLearner(learner, randomUUID()), "not_found");
	await rejects(f.assignments.publicationForLearner("not-a-uuid", own.id), "not_found");
	assert.equal(
		(await f.assignments.publicationForLearner(learner, own.id)).publicationId,
		own.id,
	);

	// a group assignment reaches its current members and nobody else
	const teacher = adult("teacher");
	f.setMember(teacher);
	const group = await f.group();
	const third = await f.learner("Leerling Drie");
	await f.link(teacher, { groupId: group });
	await f.directory.addToGroup(f.boss, { groupId: group, learnerId: third });
	await f.assignments.assign(teacher, {
		publicationId: own.id,
		audienceKind: "group",
		audienceId: group,
	});
	assert.deepEqual(
		(await f.assignments.availableForLearner(third)).map((row) => row.publicationId),
		[own.id],
	);
	assert.deepEqual(
		(await f.assignments.availableForLearner(learner)).map((row) => row.publicationId),
		[own.id],
	);
	assert.equal((await f.assignments.availableForLearner(otherLearner)).length, 1);
});

test("membership, link and group changes end future access at read time", async () => {
	const f = await setup();
	const parent = adult("parent");
	f.setMember(parent);
	const learner = await f.learner();
	const link = await f.link(parent, { learnerId: learner });
	const publication = await f.publication();
	const assignment = await f.assignments.assign(parent, {
		publicationId: publication.id,
		audienceKind: "learner",
		audienceId: learner,
	});
	assert.equal((await f.assignments.availableForLearner(learner)).length, 1);

	// the adult's current role is re-read: a teacher's learner link no longer counts
	f.members.set(parent.sub, {
		role: "breinhap.teacher",
		active: true,
		version: "changed",
	});
	assert.deepEqual(await f.assignments.availableForLearner(learner), []);
	assert.deepEqual(await f.assignments.list(parent), []);

	// back to parent: the same assignment applies again
	f.setMember(parent);
	assert.equal((await f.assignments.availableForLearner(learner)).length, 1);

	// an ended membership ends access
	f.members.set(parent.sub, { role: "breinhap.parent", active: false, version: "x" });
	assert.deepEqual(await f.assignments.availableForLearner(learner), []);
	f.setMember(parent);

	// revoking the link ends access, and the assignment remains for the adult's history while the
	// target is readable; it is hidden once the link is gone
	await f.directory.unlink(f.boss, link);
	assert.deepEqual(await f.assignments.availableForLearner(learner), []);
	assert.deepEqual(await f.assignments.list(parent), []);
	// a known id and current version are not authority: the target left the adult's scope
	await rejects(
		f.assignments.update(parent, assignment.id, 1, {
			availableUntil: iso(now + 30 * DAY),
		}),
		"not_found",
	);

	// a group assignment follows current group membership only
	const teacher = adult("teacher");
	f.setMember(teacher);
	const group = await f.group();
	const member = await f.learner("Lid");
	const outsider = await f.learner("Buiten");
	await f.link(teacher, { groupId: group });
	await f.directory.addToGroup(f.boss, { groupId: group, learnerId: member });
	await f.assignments.assign(teacher, {
		publicationId: publication.id,
		audienceKind: "group",
		audienceId: group,
	});
	assert.equal((await f.assignments.availableForLearner(member)).length, 1);
	assert.deepEqual(await f.assignments.availableForLearner(outsider), []);
	// archiving a learner ends a group assignment too, even though the membership row stays
	const archived = await f.learner("Gearchiveerd");
	await f.directory.addToGroup(f.boss, { groupId: group, learnerId: archived });
	assert.equal((await f.assignments.availableForLearner(archived)).length, 1);
	await f.directory.archiveLearner(f.boss, archived);
	assert.deepEqual(await f.assignments.availableForLearner(archived), []);
	await f.directory.removeFromGroup(f.boss, { groupId: group, learnerId: member });
	assert.deepEqual(await f.assignments.availableForLearner(member), []);
});

test("windows are bounded and scheduled, expired and revoked states are explicit", async () => {
	const f = await setup();
	const parent = adult("parent");
	f.setMember(parent);
	const learner = await f.learner();
	await f.link(parent, { learnerId: learner });
	const publication = await f.publication();

	// a future start is scheduled: not available yet, but the adult sees it
	const scheduled = await f.assignments.assign(parent, {
		publicationId: publication.id,
		audienceKind: "learner",
		audienceId: learner,
		notBefore: iso(now + DAY),
	});
	assert.deepEqual(await f.assignments.availableForLearner(learner), []);
	let rows = await f.assignments.list(parent);
	assert.equal(rows[0].state, "scheduled");
	f.advance(2 * DAY);
	assert.equal((await f.assignments.availableForLearner(learner)).length, 1);
	rows = await f.assignments.list(parent);
	assert.equal(rows[0].state, "active");

	// an end in the past is expired; the assignment stays in the history
	await f.assignments.update(parent, scheduled.id, 1, {
		availableUntil: iso(now - DAY),
	}).catch((error) => {
		// an end before the current start is invalid; move the start first
		assert.equal(error.code, "invalid");
	});
	await f.assignments.update(parent, scheduled.id, 1, {
		notBefore: iso(now - 2 * DAY),
		availableUntil: iso(now - DAY),
	});
	assert.deepEqual(await f.assignments.availableForLearner(learner), []);
	rows = await f.assignments.list(parent);
	assert.equal(rows[0].state, "expired");

	// a window longer than one school year is refused, before and at the boundary
	await rejects(f.assignments.assign(parent, {
		publicationId: publication.id,
		audienceKind: "learner",
		audienceId: learner,
		notBefore: iso(now + DAY),
		availableUntil: iso(now + 400 * DAY),
	}), "invalid");
	await rejects(f.assignments.update(parent, scheduled.id, 2, {
		availableUntil: iso(now + 400 * DAY),
	}), "invalid");
	await rejects(f.assignments.update(parent, scheduled.id, 2, {
		notBefore: iso(now + 2 * DAY),
		availableUntil: iso(now + DAY),
	}), "invalid");

	// an old version never wins
	await rejects(f.assignments.update(parent, scheduled.id, 1, {
		availableUntil: iso(now + 30 * DAY),
	}), "stale");

	// revoke is explicit and final
	await f.assignments.revoke(parent, scheduled.id);
	assert.deepEqual(await f.assignments.availableForLearner(learner), []);
	rows = await f.assignments.list(parent);
	assert.equal(rows[0].state, "revoked");
	await rejects(f.assignments.revoke(parent, scheduled.id), "not_found");
	await rejects(f.assignments.update(parent, scheduled.id, 3, {
		availableUntil: iso(now + 30 * DAY),
	}), "not_found");

	// another adult cannot change or revoke it, even with the id
	const stranger = adult("parent");
	f.setMember(stranger);
	await rejects(f.assignments.revoke(stranger, scheduled.id), "not_found");
});

test("withdrawal ends learner access; a restored publication is a new assignment target", async () => {
	const f = await setup();
	const parent = adult("parent");
	f.setMember(parent);
	const learner = await f.learner();
	await f.link(parent, { learnerId: learner });
	const publication = await f.publication();
	await f.assignments.assign(parent, {
		publicationId: publication.id,
		audienceKind: "learner",
		audienceId: learner,
	});
	assert.equal((await f.assignments.availableForLearner(learner)).length, 1);

	await f.publishing.withdraw(publication.publisher, publication.objectId);
	assert.deepEqual(await f.assignments.availableForLearner(learner), []);
	const withdrawn = await f.assignments.list(parent);
	assert.equal(withdrawn[0].state, "withdrawn");
	assert.equal(withdrawn[0].publicationState, "withdrawn");

	// the withdrawn publication cannot be assigned again
	await rejects(f.assignments.assign(parent, {
		publicationId: publication.id,
		audienceKind: "learner",
		audienceId: learner,
	}), "not_found");

	// restoring publishes a new row; the old assignment stays history and the new one works
	const restored = await f.publishing.restore(
		publication.publisher,
		publication.objectId,
		1,
	);
	assert.notEqual(restored.id, publication.id);
	await f.assignments.assign(parent, {
		publicationId: restored.id,
		audienceKind: "learner",
		audienceId: learner,
	});
	assert.deepEqual(
		(await f.assignments.availableForLearner(learner)).map((row) => row.publicationId),
		[restored.id],
	);
	assert.equal((await f.assignments.list(parent)).length, 2);
});

test("the database keeps assignment history: no delete, no target change, one active row", async () => {
	const f = await setup();
	const parent = adult("parent");
	f.setMember(parent);
	const learner = await f.learner();
	const otherLearner = await f.learner("Ander");
	await f.link(parent, { learnerId: learner });
	await f.link(parent, { learnerId: otherLearner });
	const publication = await f.publication();
	const assignment = await f.assignments.assign(parent, {
		publicationId: publication.id,
		audienceKind: "learner",
		audienceId: learner,
	});

	await assert.rejects(
		pool.query("DELETE FROM content_assignments WHERE id = $1", [assignment.id]),
		/keep their history/,
	);
	await assert.rejects(
		pool.query("UPDATE content_assignments SET learner_id = $2 WHERE id = $1", [
			assignment.id,
			otherLearner,
		]),
		/keeps its publication, target and assigner/,
	);
	await assert.rejects(
		pool.query("UPDATE content_assignments SET version = version WHERE id = $1", [
			assignment.id,
		]),
		/increments its version/,
	);
	await assert.rejects(
		pool.query(
			`INSERT INTO content_assignments
			 (workspace_id, id, publication_id, learner_id, group_id, assigned_by, not_before)
			 VALUES ($1, $2, $3, $4, $5, 'x', now())`,
			[f.directory.workspace, randomUUID(), publication.id, learner, randomUUID()],
		),
		/check constraint/i,
	);

	// a second active row for the same publication and learner is refused by the unique index
	await assert.rejects(
		f.assignments.assign(parent, {
			publicationId: publication.id,
			audienceKind: "learner",
			audienceId: learner,
		}),
		(error) => error.code === "exists",
	);
});

test("create, window change and revoke are audited", async () => {
	const f = await setup();
	const parent = adult("parent");
	f.setMember(parent);
	const learner = await f.learner();
	await f.link(parent, { learnerId: learner });
	const publication = await f.publication();
	const assignment = await f.assignments.assign(parent, {
		publicationId: publication.id,
		audienceKind: "learner",
		audienceId: learner,
	});
	await f.assignments.update(parent, assignment.id, 1, {
		availableUntil: iso(now + 30 * DAY),
	});
	await f.assignments.revoke(parent, assignment.id);
	const { rows } = await pool.query(
		"SELECT action, result FROM audit_events WHERE workspace_id = $1 AND action LIKE 'assignment.%' ORDER BY action",
		[f.directory.workspace],
	);
	assert.deepEqual(
		rows.map((row) => [row.action, row.result]),
		[
			["assignment.create", "done"],
			["assignment.revoke", "done"],
			["assignment.update", "done"],
		],
	);
});

test("a missing membership adapter closes the learner boundary instead of guessing", async () => {
	const directory = await new Directory({
		pool,
		workspace: `w-${randomBytes(4).toString("hex")}`,
	}).ready();
	const assignments = new AssignmentStore({ directory });
	await rejects(
		assignments.availableForLearner(randomUUID()),
		"unavailable",
	);
	await rejects(
		assignments.publicationForLearner(randomUUID(), randomUUID()),
		"unavailable",
	);
});
