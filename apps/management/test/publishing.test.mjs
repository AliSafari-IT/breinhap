// breinhap#33 against a real Postgres: publishing builds an immutable, versioned delivery pack from
// exactly one independently approved revision. The database guards the same rules, so a future code
// path cannot publish an unapproved or self-approved revision, let a draft reach students, rewrite a
// published pack or erase history. The practice adapter is the only student-facing read.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";

import { ContentError, ContentStore } from "../src/content.mjs";
import { migrate } from "../src/db.mjs";
import { Directory } from "../src/directory.mjs";
import { PracticeError, contentHash } from "../src/practice/model.mjs";
import { publicationPack, PublishingStore } from "../src/publishing.mjs";
import { studentPayload } from "../src/vendor/content-mission.mjs";
import { parity } from "./import-fixtures.mjs";

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
	const content = new ContentStore({ directory });
	return { directory, content, publishing: new PublishingStore({ content }) };
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
						items: ["prikkel", "reactie", "receptor"],
						explanation: "Eerst de prikkel, dan de receptor, dan de reactie.",
					},
				],
			},
		],
	};
}

/** Creates an object, snapshots `revision` and offers it for review. */
async function submitted(content, author, { draft = object(), revision = 1, src = sources } = {}) {
	const { id } = await content.create(author, draft, src);
	if (revision > 1) {
		await content.update(author, id, 1, { ...draft, title: `${draft.title} ${revision}` }, src);
	}
	await content.snapshot(author, id, revision);
	await content.submit(author, id, revision);
	return id;
}

/** A submitted revision plus an independent approval and an explicit publisher grant. */
async function approved({ directory, content, author, reviewer, publisher, draft, src = sources }) {
	await directory.grantCapability(boss(), reviewer, "content.review");
	await directory.grantCapability(boss(), publisher, "content.publish");
	const id = await submitted(content, author, { draft, src });
	await content.review(reviewer, id, 1, "approved");
	return id;
}

const refOf = async (content, owner, id, publication) => ({
	objectId: id,
	revision: publication.revision,
	publicationId: publication.id,
	revisionHash: (await content.revision(owner, id, publication.revision)).hash,
	publicationHash: publication.hash,
});

test("publishing needs an explicit grant: roles and administration never imply it", async () => {
	const { directory, content, publishing } = await setup();
	const author = adult();
	const reviewer = adult();
	const publisher = adult();
	const id = await approved({ directory, content, author, reviewer, publisher });

	assert.equal(await code(publishing.publish(adult(), id, 1)), "forbidden");
	assert.equal(await code(publishing.publish(boss(), id, 1)), "forbidden");
	assert.equal(await code(publishing.candidates(adult())), "forbidden");
	assert.equal(await code(publishing.withdraw(adult(), id)), "forbidden");

	const publication = await publishing.publish(publisher, id, 1);
	assert.match(publication.id, /^[0-9a-f-]{36}$/);
	assert.match(publication.hash, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(publication.revision, 1);
	assert.equal(publication.version, 1);

	const rows = await publishing.candidates(publisher);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].id, id);
	assert.equal(rows[0].state, "active");
	assert.equal(rows[0].version, 1);
	// the queue never carries sources, reviewer notes or uploader identity
	assert.equal("sources" in rows[0], false);
	assert.equal("reviewer" in rows[0], false);
	assert.equal("ownerSub" in rows[0], false);
});

test("the published pack is the clean delivery projection: versioned, hashed and free of review data", async () => {
	const { directory, content, publishing } = await setup();
	const author = adult();
	const reviewer = adult();
	const publisher = adult();
	const draft = object();
	const id = await approved({ directory, content, author, reviewer, publisher, draft });

	const publication = await publishing.publish(publisher, id, 1);
	const revision = await content.revision(author, id, 1);
	const pack = await publishing.publishedPack(id);

	assert.equal(pack.schemaVersion, 1);
	assert.equal(pack.id, id);
	assert.equal(pack.version, 1);
	assert.equal(pack.objects.length, 1);
	assert.deepEqual(pack.objects[0], studentPayload(revision.content));
	assert.equal("review" in pack.objects[0], false);
	assert.equal("sources" in pack.objects[0], false);
	assert.equal(JSON.stringify(pack).includes(author.sub), false);
	assert.equal(JSON.stringify(pack).includes(reviewer.sub), false);
	assert.equal(JSON.stringify(pack).includes("reviewedBy"), false);
	assert.equal(publication.hash, contentHash(pack));

	const { rows } = await pool.query(
		"SELECT revision_hash, pack_hash FROM content_publications WHERE workspace_id = $1 AND id = $2",
		[directory.workspace, publication.id],
	);
	assert.equal(rows[0].revision_hash, revision.hash);
	assert.equal(rows[0].pack_hash, publication.hash);
});

test("only an approved revision can be published; unapproved, self-approved and not-ready revisions are refused", async () => {
	const { directory, content, publishing } = await setup();
	const author = adult();
	const reviewer = adult();
	const publisher = adult();
	await directory.grantCapability(boss(), publisher, "content.publish");
	await directory.grantCapability(boss(), reviewer, "content.review");

	// recorded but never submitted or approved
	const plain = object();
	const { id: unapproved } = await content.create(author, plain, sources);
	await content.snapshot(author, unapproved, 1);
	assert.equal(await code(publishing.publish(publisher, unapproved, 1)), "not_approved");

	// changes requested is a decision, not an approval
	const changed = await submitted(content, author);
	await content.review(reviewer, changed, 1, "changes_requested", "Voeg een bron toe.");
	assert.equal(await code(publishing.publish(publisher, changed, 1)), "not_approved");

	// the database refuses a self-approval outright, so a revision can never carry one
	const own = await submitted(content, author);
	await assert.rejects(
		pool.query(
			"INSERT INTO revision_reviews (workspace_id, learning_object_id, revision, decision, reviewer_sub) VALUES ($1, $2, 1, 'approved', $3)",
			[directory.workspace, own, author.sub],
		),
		/own content/,
	);

	// an approval that skipped readiness cannot be published: both guards run again
	const noSource = object();
	const { id } = await content.create(author, noSource, []);
	await content.snapshot(author, id, 1);
	await pool.query(
		"INSERT INTO revision_submissions (workspace_id, learning_object_id, revision, submitted_by) VALUES ($1, $2, 1, $3)",
		[directory.workspace, id, author.sub],
	);
	await pool.query(
		"INSERT INTO revision_reviews (workspace_id, learning_object_id, revision, decision, reviewer_sub) VALUES ($1, $2, 1, 'approved', $3)",
		[directory.workspace, id, reviewer.sub],
	);
	const notReady = await publishing.publish(publisher, id, 1).catch((error) => error);
	assert.equal(notReady.code, "not_ready");
	assert.deepEqual(
		notReady.issues.map((issue) => issue.code),
		["source_missing"],
	);
});

test("a failed publication rolls back: the current release stays active and no new row appears", async () => {
	const { directory, content, publishing } = await setup();
	const author = adult();
	const reviewer = adult();
	const publisher = adult();
	const draft = object();
	const id = await approved({ directory, content, author, reviewer, publisher, draft });
	const first = await publishing.publish(publisher, id, 1);

	// a second approved revision, made current in the draft
	await content.update(author, id, 1, { ...draft, title: "Tweede versie" }, sources);
	await content.snapshot(author, id, 2);
	await content.submit(author, id, 2);
	await content.review(reviewer, id, 2, "approved");

	// simulate a storage failure after the old release was superseded
	await pool.query(
		"CREATE FUNCTION test_fail_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.pack_version = 2 THEN RAISE EXCEPTION 'simulated publication failure'; END IF; RETURN NEW; END; $$",
	);
	await pool.query(
		"CREATE TRIGGER test_fail_publication BEFORE INSERT ON content_publications FOR EACH ROW EXECUTE FUNCTION test_fail_publication()",
	);
	try {
		await assert.rejects(publishing.publish(publisher, id, 2), /simulated publication failure/);
	} finally {
		await pool.query("DROP TRIGGER test_fail_publication ON content_publications");
		await pool.query("DROP FUNCTION test_fail_publication()");
	}

	const { rows } = await pool.query(
		"SELECT id, revision, pack_version, state FROM content_publications WHERE workspace_id = $1 AND learning_object_id = $2 ORDER BY pack_version",
		[directory.workspace, id],
	);
	assert.deepEqual(
		rows.map((row) => [row.revision, row.pack_version, row.state]),
		[[1, 1, "active"]],
	);
	assert.equal(rows[0].id, first.id);
	assert.equal((await publishing.publishedPack(id)).objects[0].title, draft.title);
});

test("a newer release supersedes the current one; restoring an older approved revision publishes it again", async () => {
	const { directory, content, publishing } = await setup();
	const author = adult();
	const reviewer = adult();
	const publisher = adult();
	const draft = object();
	const id = await approved({ directory, content, author, reviewer, publisher, draft });
	const first = await publishing.publish(publisher, id, 1);

	await content.update(author, id, 1, { ...draft, title: "Tweede versie" }, sources);
	await content.snapshot(author, id, 2);
	await content.submit(author, id, 2);
	await content.review(reviewer, id, 2, "approved");
	const second = await publishing.publish(publisher, id, 2);
	assert.equal(second.version, 2);
	assert.notEqual(second.hash, first.hash);
	assert.equal(await code(publishing.publish(publisher, id, 2)), "already_published");

	const afterSecond = await content.get(author, id);
	assert.deepEqual(
		afterSecond.publications.map((p) => [p.revision, p.version, p.state]),
		[
			[2, 2, "active"],
			[1, 1, "superseded"],
		],
	);
	assert.equal(afterSecond.activePublication.version, 2);
	assert.equal(afterSecond.latestPublication.version, 2);

	// restoring revision 1 is a new release, not a rewrite of the superseded row
	const restored = await publishing.restore(publisher, id, 1);
	assert.equal(restored.version, 3);
	assert.notEqual(restored.id, first.id);
	assert.notEqual(restored.hash, first.hash); // the pack version is part of the artifact
	const restoredRef = await refOf(content, author, id, restored);
	const firstRef = await refOf(content, author, id, first);
	assert.equal(restoredRef.revisionHash, firstRef.revisionHash); // the approved revision is unchanged

	const afterRestore = await content.get(author, id);
	assert.deepEqual(
		afterRestore.publications.map((p) => [p.revision, p.version, p.state]),
		[
			[1, 3, "active"],
			[2, 2, "superseded"],
			[1, 1, "superseded"],
		],
	);
	assert.equal(afterRestore.activePublication.revision, 1);
	assert.equal(afterRestore.activePublication.version, 3);
	assert.equal(afterRestore.activePublication.state, "active");
});

test("withdrawal stops new access at once, keeps the bytes, and can be followed by a new release", async () => {
	const { directory, content, publishing } = await setup();
	const author = adult();
	const reviewer = adult();
	const publisher = adult();
	const id = await approved({ directory, content, author, reviewer, publisher });
	const publication = await publishing.publish(publisher, id, 1);
	const ref = await refOf(content, author, id, publication);

	await directory.transaction(async (tx) => {
		const [entry] = await publishing.lockForPractice(tx, {
			workspaceId: directory.workspace,
			ownerSub: author.sub,
			refs: [ref],
		});
		assert.equal(entry.object.review.status, "reviewed");
	});

	const withdrawn = await publishing.withdraw(publisher, id);
	assert.equal(withdrawn.id, publication.id);
	assert.equal(await code(publishing.withdraw(publisher, id)), "not_published");
	assert.equal(await code(publishing.publishedPack(id)), "not_published");

	// the row and its pack are still there for history and audit
	const { rows } = await pool.query(
		"SELECT state, pack_hash, pack FROM content_publications WHERE workspace_id = $1 AND id = $2",
		[directory.workspace, publication.id],
	);
	assert.equal(rows[0].state, "withdrawn");
	assert.equal(rows[0].pack_hash, publication.hash);
	assert.ok(rows[0].pack);

	// the withdrawn publication is not eligible for a learner, even with exact hashes
	await directory.transaction(async (tx) => {
		await assert.rejects(
			publishing.lockForPractice(tx, {
				workspaceId: directory.workspace,
				ownerSub: author.sub,
				refs: [ref],
			}),
			(error) => error instanceof PracticeError && error.code === "gone",
		);
	});

	// publishing the approved revision again restores access as a new active row
	const again = await publishing.restore(publisher, id, 1);
	assert.equal(again.version, 2);
	await directory.transaction(async (tx) => {
		const [entry] = await publishing.lockForPractice(tx, {
			workspaceId: directory.workspace,
			ownerSub: author.sub,
			refs: [{ ...ref, publicationId: again.id, publicationHash: again.hash }],
		});
		assert.equal(entry.object.id, id);
	});
});

test("the practice adapter returns exact refs in request order with server-confirmed review metadata", async () => {
	const { directory, content, publishing } = await setup();
	const author = adult();
	const reviewer = adult();
	const publisher = adult();
	await directory.grantCapability(boss(), reviewer, "content.review");
	await directory.grantCapability(boss(), publisher, "content.publish");

	const firstDraft = object();
	const secondDraft = object();
	const firstId = await submitted(content, author, { draft: firstDraft });
	const secondId = await submitted(content, author, { draft: secondDraft });
	await content.review(reviewer, firstId, 1, "approved");
	await content.review(reviewer, secondId, 1, "approved");
	const first = await publishing.publish(publisher, firstId, 1);
	const second = await publishing.publish(publisher, secondId, 1);
	const firstRef = await refOf(content, author, firstId, first);
	const secondRef = await refOf(content, author, secondId, second);

	await directory.transaction(async (tx) => {
		const entries = await publishing.lockForPractice(tx, {
			workspaceId: directory.workspace,
			ownerSub: author.sub,
			refs: [secondRef, firstRef],
		});
		assert.deepEqual(
			entries.map((entry) => entry.objectId),
			[secondId, firstId],
		);
		for (const entry of entries) {
			assert.equal(entry.object.review.status, "reviewed");
			assert.equal(entry.object.review.reviewedBy, reviewer.sub);
			assert.match(entry.object.review.reviewedAt, /^\d{4}-\d{2}-\d{2}$/);
			assert.equal("sources" in entry.object, false);
		}
	});

	// exact refs only: another owner, a wrong hash or a wrong object is gone, never guessed
	for (const broken of [
		{ ...firstRef, revisionHash: contentHash({}) },
		{ ...firstRef, publicationHash: contentHash({}) },
		{ ...firstRef, objectId: secondId },
		{ ...firstRef, publicationId: randomUUID() },
		{ ...firstRef, revision: 99 },
	]) {
		await directory.transaction(async (tx) => {
			await assert.rejects(
				publishing.lockForPractice(tx, {
					workspaceId: directory.workspace,
					ownerSub: author.sub,
					refs: [broken],
				}),
				(error) => error instanceof PracticeError && error.code === "gone",
			);
		});
	}
	await directory.transaction(async (tx) => {
		await assert.rejects(
			publishing.lockForPractice(tx, {
				workspaceId: directory.workspace,
				ownerSub: adult().sub,
				refs: [firstRef],
			}),
			(error) => error instanceof PracticeError && error.code === "gone",
		);
	});
});

test("the adapter refuses an unsupported schema as unsupported_version, not as gone", async () => {
	const { directory, content, publishing } = await setup();
	const author = adult();
	const publisher = adult();
	await directory.grantCapability(boss(), publisher, "content.publish");

	// A revision stored by a future schema version cannot be published by this code at all.
	const draft = object();
	const { id } = await content.create(author, draft, sources);
	await pool.query(
		`INSERT INTO learning_object_revisions
		   (workspace_id, learning_object_id, revision, schema_version, content, sources, content_hash, source_version, created_by)
		 VALUES ($1, $2, 2, 2, $3, $4, $5, 1, $6)`,
		[directory.workspace, id, draft, JSON.stringify(sources), contentHash(draft), author.sub],
	);
	await pool.query(
		"INSERT INTO revision_submissions (workspace_id, learning_object_id, revision, submitted_by) VALUES ($1, $2, 2, $3)",
		[directory.workspace, id, author.sub],
	);
	await pool.query(
		"INSERT INTO revision_reviews (workspace_id, learning_object_id, revision, decision, reviewer_sub) VALUES ($1, $2, 2, 'approved', $3)",
		[directory.workspace, id, adult().sub],
	);
	assert.equal(await code(publishing.publish(publisher, id, 2)), "unsupported_version");

	// The adapter maps an incompatible stored schema to unsupported_version too.
	const publicationId = randomUUID();
	const revisionHash = contentHash(draft);
	const fakeTx = {
		query: async () => ({
			rowCount: 1,
			rows: [
				{
					id: publicationId,
					objectId: id,
					revision: 2,
					revisionHash,
					publicationHash: contentHash({}),
					schemaVersion: 2,
					state: "active",
					pack: { schemaVersion: 1, id, version: 1, objects: [draft] },
					ownerSub: author.sub,
					archivedAt: null,
					content: draft,
					sources,
					storedRevisionHash: revisionHash,
					decision: "approved",
					reviewer: adult().sub,
					decidedAt: new Date(),
				},
			],
		}),
	};
	await assert.rejects(
		publishing.lockForPractice(fakeTx, {
			workspaceId: directory.workspace,
			ownerSub: author.sub,
			refs: [
				{
					objectId: id,
					revision: 2,
					publicationId,
					revisionHash,
					publicationHash: contentHash({}),
				},
			],
		}),
		(error) => error instanceof PracticeError && error.code === "unsupported_version",
	);
});

test("the database guards publication content, approval, publisher, lifecycle and deletion", async () => {
	const { directory, content, publishing } = await setup();
	const author = adult();
	const reviewer = adult();
	const publisher = adult();
	const ungranted = adult();
	const id = await approved({ directory, content, author, reviewer, publisher });
	const publication = await publishing.publish(publisher, id, 1);
	const revision = await content.revision(author, id, 1);
	const draft = (await content.get(author, id)).content;
	const pack = publicationPack(draft, 2);

	// no approval: a future code path cannot insert a publication itself
	const plain = object();
	const { id: unapproved } = await content.create(author, plain, sources);
	await content.snapshot(author, unapproved, 1);
	const plainRevision = await content.revision(author, unapproved, 1);
	const plainPack = publicationPack(plainRevision.content, 1);
	await assert.rejects(
		pool.query(
			`INSERT INTO content_publications
			   (workspace_id, id, learning_object_id, revision, revision_hash, schema_version, pack, pack_version, pack_hash, published_by)
			 VALUES ($1, $2, $3, 1, $4, 1, $5, 1, $6, $7)`,
			[
				directory.workspace,
				randomUUID(),
				unapproved,
				plainRevision.hash,
				plainPack,
				contentHash(plainPack),
				publisher.sub,
			],
		),
		/independently approved/,
	);

	// no explicit grant: a valid approved revision still cannot be published directly
	await assert.rejects(
		pool.query(
			`INSERT INTO content_publications
			   (workspace_id, id, learning_object_id, revision, revision_hash, schema_version, pack, pack_version, pack_hash, published_by)
			 VALUES ($1, $2, $3, 1, $4, 1, $5, 2, $6, $7)`,
			[directory.workspace, randomUUID(), id, revision.hash, pack, contentHash(pack), ungranted.sub],
		),
		/authorized publisher/,
	);

	// a published pack and its identity never change
	await assert.rejects(
		pool.query(
			"UPDATE content_publications SET pack = jsonb_set(pack, '{objects,0,title}', '\"Gewijzigd\"') WHERE workspace_id = $1 AND id = $2",
			[directory.workspace, publication.id],
		),
		/keeps its content and identity/,
	);
	await assert.rejects(
		pool.query(
			"UPDATE content_publications SET pack_hash = $3 WHERE workspace_id = $1 AND id = $2",
			[directory.workspace, publication.id, contentHash({})],
		),
		/keeps its content and identity/,
	);

	// one transition out of active, by an authorized publisher, recording who and when
	await assert.rejects(
		pool.query(
			"UPDATE content_publications SET state = 'withdrawn', state_changed_at = now() WHERE workspace_id = $1 AND id = $2",
			[directory.workspace, publication.id],
		),
		/lifecycle change records/,
	);
	await assert.rejects(
		pool.query(
			"UPDATE content_publications SET state = 'withdrawn', state_changed_at = now(), state_changed_by = $3 WHERE workspace_id = $1 AND id = $2",
			[directory.workspace, publication.id, ungranted.sub],
		),
		/authorized publisher/,
	);
	await pool.query(
		"UPDATE content_publications SET state = 'superseded', state_changed_at = now(), state_changed_by = $3 WHERE workspace_id = $1 AND id = $2",
		[directory.workspace, publication.id, publisher.sub],
	);
	await assert.rejects(
		pool.query(
			"UPDATE content_publications SET state = 'withdrawn', state_changed_at = now(), state_changed_by = $3 WHERE workspace_id = $1 AND id = $2",
			[directory.workspace, publication.id, publisher.sub],
		),
		/leave active only once/,
	);

	// one active release per object
	await publishing.publish(publisher, id, 1);
	const pack99 = publicationPack(draft, 99);
	await assert.rejects(
		pool.query(
			`INSERT INTO content_publications
			   (workspace_id, id, learning_object_id, revision, revision_hash, schema_version, pack, pack_version, pack_hash, published_by)
			 VALUES ($1, $2, $3, 1, $4, 1, $5, 99, $6, $7)`,
			[directory.workspace, randomUUID(), id, revision.hash, pack99, contentHash(pack99), publisher.sub],
		),
		/duplicate key|unique/,
	);

	// publications are never deleted
	await assert.rejects(
		pool.query("DELETE FROM content_publications WHERE workspace_id = $1 AND id = $2", [
			directory.workspace,
			publication.id,
		]),
		/immutable/,
	);
});

test("a learner holding a shared publication lock blocks withdrawal until commit", async () => {
	const { directory, content, publishing } = await setup();
	const author = adult();
	const reviewer = adult();
	const publisher = adult();
	const id = await approved({ directory, content, author, reviewer, publisher });
	const publication = await publishing.publish(publisher, id, 1);
	const ref = await refOf(content, author, id, publication);

	const tx = await pool.connect();
	try {
		await tx.query("BEGIN");
		await publishing.lockForPractice(tx, {
			workspaceId: directory.workspace,
			ownerSub: author.sub,
			refs: [ref],
		});
		let settled = false;
		const withdrawal = publishing.withdraw(publisher, id).finally(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(settled, false, "withdrawal waits for the shared lock");
		await tx.query("COMMIT");
		await withdrawal;
		assert.equal(settled, true);
	} finally {
		await tx.query("ROLLBACK").catch(() => {});
		tx.release();
	}
	const { rows } = await pool.query(
		"SELECT state FROM content_publications WHERE workspace_id = $1 AND id = $2",
		[directory.workspace, publication.id],
	);
	assert.equal(rows[0].state, "withdrawn");
});

test("the Android parity fixture publishes and is delivered unchanged apart from server review metadata", async () => {
	const { directory, content, publishing } = await setup();
	const author = adult();
	const reviewer = adult();
	const publisher = adult();
	await directory.grantCapability(boss(), reviewer, "content.review");
	await directory.grantCapability(boss(), publisher, "content.publish");
	const draft = { ...structuredClone(parity.object), review: { status: "draft" } };
	const { id } = await content.create(author, draft, sources);
	await content.snapshot(author, id, 1);
	await content.submit(author, id, 1);
	await content.review(reviewer, id, 1, "approved");
	const publication = await publishing.publish(publisher, id, 1);
	const ref = await refOf(content, author, id, publication);

	const pack = await publishing.publishedPack(id);
	assert.deepEqual(pack.objects[0], studentPayload(draft));
	assert.equal(pack.objects[0].missions.length, parity.object.missions.length);

	await directory.transaction(async (tx) => {
		const [entry] = await publishing.lockForPractice(tx, {
			workspaceId: directory.workspace,
			ownerSub: author.sub,
			refs: [ref],
		});
		const { review, ...rest } = entry.object;
		const { review: expectedReview, ...expected } = parity.object;
		assert.deepEqual(rest, expected);
		assert.equal(review.status, "reviewed");
		assert.equal(review.reviewedBy, reviewer.sub);
		assert.notEqual(expectedReview.reviewedBy, review.reviewedBy);
	});
});
