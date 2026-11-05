// breinhap#26 against a real Postgres: validation at the boundary, stable ids, the owner-only draft
// with optimistic concurrency, immutable revisions, server-managed review metadata, and the existing
// Android sample packs going through the same path.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import pg from "pg";

import { ContentError, ContentStore, validate } from "../src/content.mjs";
import { migrate } from "../src/db.mjs";
import { Directory } from "../src/directory.mjs";
import { render, TARGET } from "../scripts/vendor-content.mjs";

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

async function store() {
	const directory = await new Directory({
		pool,
		workspace: `w-${randomBytes(4).toString("hex")}`,
	}).ready();
	return new ContentStore({ directory });
}

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

test("the vendored schema is exactly the shared packages/content schema", async (t) => {
	const fresh = await render();
	if (!fresh) return t.skip("TypeScript not installed here; the workspace CI checks this");
	assert.equal(
		await readFile(TARGET, "utf8"),
		fresh,
		"run: node apps/management/scripts/vendor-content.mjs",
	);
});

test("the existing Android sample learning objects validate and store unchanged (apart from review)", async (t) => {
	let ts;
	try {
		ts = createRequire(import.meta.url)("typescript");
	} catch {
		return t.skip("TypeScript not installed here; the workspace CI checks this");
	}
	const content = await store();
	const author = adult();
	for (const file of ["biologie-prikkel-reactie", "wiskunde-samengestelde-intrest"]) {
		const source = await readFile(
			new URL(`../../../packages/content/src/samples/${file}.ts`, import.meta.url),
			"utf8",
		);
		const js = ts.transpileModule(source, {
			compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
		}).outputText;
		const sample = Object.values(
			await import(`data:text/javascript,${encodeURIComponent(js)}`),
		)[0];
		const { id } = await content.create(author, sample);
		const saved = await content.get(author, id);
		assert.equal(saved.content.id, sample.id);
		assert.deepEqual(saved.content.review, { status: "draft" });
		assert.deepEqual(
			saved.content.missions.map((m) => m.id),
			sample.missions.map((m) => m.id),
		);
	}
});

test("malformed input is refused at the boundary with paths, and nothing is stored", async () => {
	const content = await store();
	const author = adult();
	const broken = object();
	broken.missions[0].practice[0].answerIndex = 9;
	const error = await content.create(author, broken).catch((e) => e);
	assert.equal(error.code, "invalid");
	assert.ok(error.issues.some((i) => i.path.endsWith("answerIndex")));
	for (const bad of [null, [], "x", { ...object(), id: "Not Kebab" }, { ...object(), missions: [] }])
		assert.equal(await code(content.create(author, bad)), "invalid");
	assert.equal(await code(content.create(author, { ...object(), schemaVersion: 2 })), "unsupported_version");
	assert.equal(
		await code(content.create(author, object(), [{ kind: "website", title: "x", url: "javascript:alert(1)" }])),
		"invalid",
	);
	const huge = object();
	huge.title = "x".repeat(MAX());
	assert.equal(await code(content.create(author, huge)), "invalid");
	assert.deepEqual(await content.list(author), []);
});
const MAX = () => 210_000;

test("an author's review flag is never trusted: content is always stored as a draft", async () => {
	const content = await store();
	const author = adult();
	const claimed = { ...object(), review: { status: "reviewed", reviewedBy: "me", reviewedAt: "2026-11-05" } };
	const { id } = await content.create(author, claimed);
	assert.deepEqual((await content.get(author, id)).content.review, { status: "draft" });
	// and the database refuses a non-draft review in a draft or a revision
	await assert.rejects(
		pool.query(
			"UPDATE learning_object_drafts SET content = jsonb_set(content, '{review,status}', '\"reviewed\"') WHERE learning_object_id = $1",
			[id],
		),
		/check/,
	);
});

test("stable ids: unique per workspace, missions too, and an object's id never changes", async () => {
	const content = await store();
	const a = adult();
	const b = adult("tutor");
	const first = object("shared-id", "shared-mission");
	await content.create(a, first);
	assert.equal(await code(content.create(b, object("shared-id", "other-mission"))), "exists");
	assert.equal(await code(content.create(b, object("other-id", "shared-mission"))), "mission_exists");
	const twice = object("twice");
	twice.missions.push({ ...twice.missions[0] });
	assert.equal(await code(content.create(a, twice)), "invalid");
	assert.equal(await code(content.update(a, "shared-id", 1, { ...first, id: "renamed" })), "id_changed");
	await assert.rejects(
		pool.query("UPDATE learning_objects SET id = 'x' WHERE id = 'shared-id'"),
		/keeps its id|violates/,
	);
	// another workspace may use the same ids
	assert.equal(await code((await store()).create(adult(), object("shared-id", "shared-mission"))), "ok");
});

test("only the owner reads or changes a draft; others, administrators and students get nothing", async () => {
	const content = await store();
	const owner = adult("parent");
	const { id } = await content.create(owner, object());
	const other = adult("teacher");
	assert.equal(await code(content.get(other, id)), "not_found");
	assert.equal(await code(content.update(other, id, 1, object(id, `${id}-m1`))), "not_found");
	assert.equal(await code(content.snapshot(other, id, 1)), "not_found");
	assert.equal(await code(content.archive(other, id)), "not_found");
	assert.deepEqual(await content.list(other), []);
	// administrators manage people, not content; students and strangers have no capability at all
	for (const nobody of [adult("admin"), { sub: "test:s", role: "breinhap.student" }, null]) {
		assert.equal(await code(content.get(nobody, id)), "forbidden");
		assert.equal(await code(content.create(nobody, object())), "forbidden");
		assert.equal(await code(content.list(nobody)), "forbidden");
	}
});

test("optimistic concurrency: a save over an old version is refused and changes nothing", async () => {
	const content = await store();
	const author = adult();
	const draft = object();
	const { id } = await content.create(author, draft);
	const v2 = await content.update(author, id, 1, { ...draft, title: "Nieuwe titel" });
	assert.equal(v2.version, 2);
	assert.equal(await code(content.update(author, id, 1, { ...draft, title: "Oud" })), "stale");
	assert.equal((await content.get(author, id)).content.title, "Nieuwe titel");
	// two saves racing on the same version: exactly one wins
	const results = await Promise.allSettled([
		content.update(author, id, 2, { ...draft, title: "A" }),
		content.update(author, id, 2, { ...draft, title: "B" }),
	]);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(results.find((r) => r.status === "rejected").reason.code, "stale");
	assert.deepEqual(
		(await content.list(author)).map((row) => [row.id, row.version]),
		[[id, 3]],
	);
});

test("revisions are numbered snapshots that never change, while the draft stays editable", async () => {
	const content = await store();
	const author = adult();
	const draft = object();
	const { id } = await content.create(author, draft, [{ kind: "book", title: "Biologie voor jou 3" }]);
	assert.deepEqual(await content.snapshot(author, id, 1), { id, revision: 1 });
	await content.update(author, id, 1, { ...draft, title: "Versie twee" });
	assert.equal(await code(content.snapshot(author, id, 1)), "stale");
	assert.deepEqual(await content.snapshot(author, id, 2), { id, revision: 2 });
	const first = await content.revision(author, id, 1);
	assert.equal(first.content.title, "Prikkel en reactie");
	assert.deepEqual(first.sources, [{ kind: "book", title: "Biologie voor jou 3" }]);
	assert.match(first.hash, /^[A-Za-z0-9_-]{43}$/);
	const view = await content.get(author, id);
	assert.deepEqual(view.revisions.map((r) => [r.revision, r.decision]), [[2, null], [1, null]]);
	await assert.rejects(
		pool.query("UPDATE learning_object_revisions SET content = '{}' WHERE learning_object_id = $1", [id]),
		/immutable/,
	);
	await assert.rejects(
		pool.query("DELETE FROM learning_object_revisions WHERE learning_object_id = $1", [id]),
		/immutable/,
	);
});

test("archiving hides an object but keeps its ids reserved", async () => {
	const content = await store();
	const author = adult();
	const { id } = await content.create(author, object("kept", "kept-m1"));
	await content.archive(author, id);
	assert.deepEqual(await content.list(author), []);
	assert.equal(await code(content.get(author, id)), "not_found");
	assert.equal(await code(content.create(author, object("kept", "new-m1"))), "exists");
	assert.equal(await code(content.create(author, object("new", "kept-m1"))), "mission_exists");
});

test("validate() alone: the schema's defaults are applied and the review is the server's", () => {
	const { object: parsed, sources } = validate({ ...object(), review: { status: "reviewed" } });
	assert.deepEqual(parsed.review, { status: "draft" });
	assert.deepEqual(parsed.curriculum.references, []);
	assert.deepEqual(parsed.missions[0].commonMistakes, []);
	assert.deepEqual(sources, []);
});
