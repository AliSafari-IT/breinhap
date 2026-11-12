// breinhap#32 against a real Postgres: a revision is offered for review by its owner, then decided on
// by an independently authorized reviewer. Submissions and decisions are server metadata; the
// database guards them too, so a future code path cannot skip the workflow.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";

import { ContentError, ContentStore, reviewReadiness } from "../src/content.mjs";
import { migrate } from "../src/db.mjs";
import { Directory } from "../src/directory.mjs";

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
	pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
	pool.on("error", () => {}); // idle connections end when the test database is dropped
	await migrate(pool);
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
		if (error instanceof ContentError || error?.code === "forbidden") return error.code;
		throw error;
	}
	return "ok";
};

let n = 0;
const adult = (role = "teacher") => ({ sub: `test:${role}-${n++}`, role: `breinhap.${role}` });
const boss = () => adult("admin");

async function setup() {
	const directory = await new Directory({
		pool,
		workspace: `w-${randomBytes(4).toString("hex")}`,
	}).ready();
	return { directory, content: new ContentStore({ directory }) };
}

const sources = [{ kind: "own", title: "Eigen werk" }];

/** A small valid learning object; `id` and mission ids are made unique per call unless given. */
function object(id = `lo-${n++}`, missionId = `${id}-m1`) {
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
				id: missionId,
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
						items: ["prikkel", "receptor", "reactie"],
						explanation: "Eerst de prikkel, dan de receptor, dan de reactie.",
					},
				],
			},
		],
	};
}

/** Creates an object, snapshots it and offers revision 1 for review. */
async function submitted(content, author, src = sources) {
	const draft = object();
	const { id } = await content.create(author, draft, src);
	await content.snapshot(author, id, 1);
	await content.submit(author, id, 1);
	return id;
}

test("readiness: at least one source, https website links, explanations and answer keys", () => {
	const ok = object();
	assert.deepEqual(reviewReadiness(ok, sources), []);
	assert.deepEqual(
		reviewReadiness(ok, []).map((issue) => issue.code),
		["source_missing"],
	);
	assert.deepEqual(
		reviewReadiness(ok, [{ kind: "website", title: "Zonder link" }]).map((issue) => issue.code),
		["source_permission"],
	);
	const noExplanation = object();
	delete noExplanation.missions[0].practice[0].explanation;
	assert.ok(reviewReadiness(noExplanation, sources).length > 0);
	const badKey = object();
	badKey.missions[0].practice[0].answerIndex = 9;
	assert.ok(
		reviewReadiness(badKey, sources).some((issue) => issue.path.endsWith("answerIndex")),
	);
});

test("submission: only the owner, only the latest revision, only while it matches the draft, once", async () => {
	const { content } = await setup();
	const author = adult();
	const other = adult();
	const draft = object();
	const { id } = await content.create(author, draft, sources);
	await content.snapshot(author, id, 1);

	assert.equal(await code(content.submit(other, id, 1)), "not_found");
	assert.equal(await code(content.submit(author, id, 1)), "ok");
	assert.equal(await code(content.submit(author, id, 1)), "already_submitted");

	// a newer revision makes the old one not the latest
	await content.update(author, id, 1, { ...draft, title: "Gewijzigd" }, sources);
	await content.snapshot(author, id, 2);
	assert.equal(await code(content.submit(author, id, 1)), "not_latest");
	assert.equal(await code(content.submit(author, id, 2)), "ok");
	assert.equal(await code(content.submit(author, id, 99)), "not_latest");
});

test("submission refuses a revision the draft has moved past, and one that is not ready", async () => {
	const { content } = await setup();
	const author = adult();

	// the revision was snapshotted from version 1, but the draft is now version 2
	const stale = object();
	const first = await content.create(author, stale, sources);
	await content.snapshot(author, first.id, 1);
	await content.update(author, first.id, 1, { ...stale, title: "Nieuwer" }, sources);
	assert.equal(await code(content.submit(author, first.id, 1)), "stale_draft");

	// no source at all
	const noSource = object();
	const second = await content.create(author, noSource, []);
	await content.snapshot(author, second.id, 1);
	const error = await content.submit(author, second.id, 1).catch((e) => e);
	assert.equal(error.code, "not_ready");
	assert.deepEqual(
		error.issues.map((issue) => issue.code),
		["source_missing"],
	);

	// a website source without its https link
	const website = object();
	const third = await content.create(author, website, [{ kind: "website", title: "Zonder link" }]);
	await content.snapshot(author, third.id, 1);
	const refused = await content.submit(author, third.id, 1).catch((e) => e);
	assert.equal(refused.code, "not_ready");
	assert.deepEqual(
		refused.issues.map((issue) => issue.code),
		["source_permission"],
	);
});

test("review needs an explicit grant, an independent reviewer, a submission and one decision", async () => {
	const { content, directory } = await setup();
	const admin = boss();
	const author = adult();
	const reviewer = adult();
	const id = await submitted(content, author);

	// no grant, no queue, no detail and no decision
	assert.equal(await code(content.reviewQueue(reviewer)), "forbidden");
	assert.equal(await code(content.reviewRevision(reviewer, id, 1)), "forbidden");
	assert.equal(await code(content.review(reviewer, id, 1, "approved")), "forbidden");

	await directory.grantCapability(admin, reviewer, "content.review");
	// the owner may review other content, never their own
	await directory.grantCapability(admin, author, "content.review");
	assert.equal(await code(content.review(author, id, 1, "approved")), "self_review");

	// asking for changes needs a note for the author
	assert.equal(await code(content.review(reviewer, id, 1, "changes_requested")), "comment_required");

	assert.equal(await code(content.review(reviewer, id, 1, "approved")), "ok");
	assert.equal(await code(content.review(reviewer, id, 1, "approved")), "already_reviewed");

	const saved = await content.get(author, id);
	assert.equal(saved.revisions[0].decision, "approved");
	assert.equal(saved.revisions[0].reviewer, reviewer.sub);
	assert.equal(saved.revisions[0].comment, "");
});

test("changes requested stores the reviewer's comment beside the decision", async () => {
	const { content, directory } = await setup();
	const admin = boss();
	const author = adult();
	const reviewer = adult();
	await directory.grantCapability(admin, reviewer, "content.review");
	const id = await submitted(content, author);

	assert.equal(
		await code(content.review(reviewer, id, 1, "changes_requested", "  Voeg een bron toe.  ")),
		"ok",
	);
	const saved = await content.get(author, id);
	assert.equal(saved.revisions[0].decision, "changes_requested");
	assert.equal(saved.revisions[0].comment, "Voeg een bron toe.");
});

test("a revision must be submitted before it can be read for review or decided", async () => {
	const { content, directory } = await setup();
	const admin = boss();
	const author = adult();
	const reviewer = adult();
	await directory.grantCapability(admin, reviewer, "content.review");
	const draft = object();
	const { id } = await content.create(author, draft, sources);
	await content.snapshot(author, id, 1);

	assert.equal(await code(content.reviewRevision(reviewer, id, 1)), "not_found");
	assert.equal(await code(content.review(reviewer, id, 1, "approved")), "not_found");
});

test("the queue never shows the reviewer's own content or a decided revision; revocation ends access", async () => {
	const { content, directory } = await setup();
	const admin = boss();
	const author = adult();
	const reviewer = adult();
	const grant = await directory.grantCapability(admin, reviewer, "content.review");

	const own = await submitted(content, reviewer);
	const other = await submitted(content, author);
	assert.deepEqual(
		(await content.reviewQueue(reviewer)).map((row) => row.id),
		[other],
	);
	assert.equal(await code(content.reviewRevision(reviewer, own, 1)), "not_found");

	await content.review(reviewer, other, 1, "approved");
	assert.deepEqual(await content.reviewQueue(reviewer), []);

	await directory.revokeCapability(admin, grant);
	assert.equal(await code(content.reviewQueue(reviewer)), "forbidden");
	assert.equal(await code(content.reviewRevision(reviewer, other, 1)), "forbidden");
});

test("approval describes one immutable revision; a later draft edit is not approved", async () => {
	const { content, directory } = await setup();
	const admin = boss();
	const author = adult();
	const reviewer = adult();
	await directory.grantCapability(admin, reviewer, "content.review");
	const draft = object();
	const { id } = await content.create(author, draft, sources);
	await content.snapshot(author, id, 1);
	await content.submit(author, id, 1);
	await content.review(reviewer, id, 1, "approved");

	assert.equal((await content.get(author, id)).draftChanged, false);
	await content.update(author, id, 1, { ...draft, title: "Gewijzigd" }, sources);
	const saved = await content.get(author, id);
	assert.equal(saved.draftChanged, true);
	assert.equal(saved.revisions[0].revision, 1);
	assert.equal(saved.revisions[0].decision, "approved");

	// the approved revision is never offered or decided again; the edit needs its own revision
	assert.equal(await code(content.submit(author, id, 1)), "already_reviewed");
	await content.snapshot(author, id, 2);
	assert.equal(await code(content.submit(author, id, 2)), "ok");
	assert.equal((await content.reviewRevision(reviewer, id, 2)).revision, 2);
});

test("two reviewers deciding at once: exactly one decision is recorded", async () => {
	const { content, directory } = await setup();
	const admin = boss();
	const author = adult();
	const first = adult();
	const second = adult();
	await directory.grantCapability(admin, first, "content.review");
	await directory.grantCapability(admin, second, "content.review");
	const id = await submitted(content, author);

	const results = await Promise.allSettled([
		content.review(first, id, 1, "approved"),
		content.review(second, id, 1, "changes_requested", "Korter graag."),
	]);
	const done = results.filter((result) => result.status === "fulfilled");
	const refused = results.filter((result) => result.status === "rejected");
	assert.equal(done.length, 1);
	assert.equal(refused.length, 1);
	assert.equal(refused[0].reason.code, "already_reviewed");
	const { rows } = await pool.query(
		"SELECT count(*)::int AS n FROM revision_reviews WHERE workspace_id = $1 AND learning_object_id = $2 AND revision = 1",
		[directory.workspace, id],
	);
	assert.equal(rows[0].n, 1);
});

test("the database refuses a decision without a submission or by the owner, and submissions are immutable", async () => {
	const { content, directory } = await setup();
	const author = adult();
	const reviewer = adult();
	const draft = object();
	const { id } = await content.create(author, draft, sources);
	await content.snapshot(author, id, 1);

	const insert = (reviewerSub) =>
		pool.query(
			"INSERT INTO revision_reviews (workspace_id, learning_object_id, revision, decision, reviewer_sub) VALUES ($1, $2, 1, 'approved', $3)",
			[directory.workspace, id, reviewerSub],
		);
	await assert.rejects(insert(reviewer.sub), /submitted/);
	// nobody else may offer the owner's revision
	await assert.rejects(
		pool.query(
			"INSERT INTO revision_submissions (workspace_id, learning_object_id, revision, submitted_by) VALUES ($1, $2, 1, $3)",
			[directory.workspace, id, reviewer.sub],
		),
		/owner/,
	);

	await content.submit(author, id, 1);
	await assert.rejects(insert(author.sub), /own content/);
	await assert.rejects(
		pool.query(
			"UPDATE revision_submissions SET submitted_by = 'someone-else' WHERE workspace_id = $1 AND learning_object_id = $2 AND revision = 1",
			[directory.workspace, id],
		),
		/immutable/,
	);
});
