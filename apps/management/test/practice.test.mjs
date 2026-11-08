import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { before, after, test } from "node:test";
import pg from "pg";
import { migrate } from "../src/db.mjs";
import { Directory } from "../src/directory.mjs";
import { ContentStore } from "../src/content.mjs";
import { PracticeStore } from "../src/practice/store.mjs";
import { PracticeLearner } from "../src/practice/learner.mjs";
import {
	DAY,
	PracticeError,
	canonical,
	contentHash,
	token,
	tokenHash,
	derived,
	bytes,
	validateDraft,
} from "../src/practice/model.mjs";
let admin, pool;
const database = `breinhap_practice_${randomBytes(6).toString("hex")}`;
before(async () => {
	if (!process.env.POSTGRES_TEST_URL)
		throw Error("Use management test runner or isolated POSTGRES_TEST_URL");
	admin = new pg.Client({ connectionString: process.env.POSTGRES_TEST_URL });
	await admin.connect();
	await admin.query(`CREATE DATABASE ${database}`);
	const url = new URL(process.env.POSTGRES_TEST_URL);
	url.pathname = `/${database}`;
	pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
	pool.on("error", () => {});
	await migrate(pool);
	// Test-only authority: no production publication workflow is introduced.
	await pool.query(
		"CREATE TABLE test_practice_publication(workspace_id text,object_id text,active boolean NOT NULL,PRIMARY KEY(workspace_id,object_id))",
	);
});
after(async () => {
	await pool?.end();
	await admin?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
	await admin?.end();
});
const rejects = (promise, code) =>
	assert.rejects(promise, (e) => {
		assert.equal(e.code, code);
		return true;
	});
const object = (id) => ({
	schemaVersion: 1,
	id,
	subject: "biologie",
	title: "Prikkel",
	grade: 3,
	curriculum: { leerdoel: "Leg prikkels uit." },
	review: { status: "draft" },
	missions: [
		{
			id: `${id}-m1`,
			title: "Prikkel",
			minutes: 3,
			warmup: { text: "Denk even na." },
			learn: [{ text: "Een prikkel is een verandering." }],
			practice: [
				{
					kind: "choice",
					prompt: "Een prikkel?",
					options: ["Verandering", "Spier"],
					answerIndex: 0,
					explanation: "Een verandering.",
				},
			],
			check: [
				{
					kind: "order",
					prompt: "Zet in volgorde.",
					items: ["prikkel", "reactie"],
					explanation: "Eerst prikkel.",
				},
			],
		},
	],
});
async function fixture(mode = "practice", closed = false) {
	const directory = await new Directory({
		pool,
		workspace: `practice-${randomBytes(6).toString("hex")}`,
	}).ready();
	const owner = {
			sub: "synthetic-owner",
			role: "breinhap.teacher",
			membershipVersion: "v1",
		},
		content = new ContentStore({ directory }),
		obj = object("test-source");
	await content.create(owner, obj);
	await content.snapshot(owner, obj.id, 1);
	const rev = await content.revision(owner, obj.id, 1);
	await pool.query("INSERT INTO test_practice_publication VALUES($1,$2,true)", [
		directory.workspace,
		obj.id,
	]);
	let verdict = "eligible",
		now = Date.UTC(2026, 10, 8, 12),
		hook;
	const approved = {
		...rev.content,
		review: {
			status: "reviewed",
			reviewedBy: "independent-reviewer",
			reviewedAt: "2026-11-08",
		},
	};
	const publication = {
		async lockForPractice(db, { workspaceId, ownerSub, refs }) {
			if (hook) await hook();
			const result = [];
			for (const ref of refs) {
				const row = (
					await db.query(
						"SELECT active FROM test_practice_publication WHERE workspace_id=$1 AND object_id=$2 FOR SHARE",
						[workspaceId, ref.objectId],
					)
				).rows[0];
				if (!row?.active) throw new PracticeError("gone");
				if (
					ownerSub !== owner.sub ||
					ref.publicationId !== "publication-1" ||
					ref.revisionHash !== rev.hash ||
					ref.publicationHash !== contentHash({ publication: 1 })
				) {
					const e = Error("unavailable");
					e.code = "unavailable";
					throw e;
				}
				result.push({ ...ref, object: approved });
			}
			return result;
		},
	};
	const eligibility = {
		async checkForPractice({ workspaceId, ownerSub, membershipVersion }) {
			return workspaceId === directory.workspace &&
				ownerSub === owner.sub &&
				membershipVersion === "v1"
				? verdict
				: "denied";
		},
	};
	const store = new PracticeStore({
			directory,
			clock: () => now,
			...(closed
				? {}
				: { publishedContent: publication, ownerEligibility: eligibility }),
		}),
		learner = new PracticeLearner(store);
	const ref = {
		objectId: obj.id,
		revision: 1,
		missionId: obj.missions[0].id,
		publicationId: "publication-1",
		revisionHash: rev.hash,
		publicationHash: contentHash({ publication: 1 }),
	};
	const draft = {
			title: "Oefenpakket",
			subject: "biologie",
			grade: 3,
			language: "nl",
			mode,
			missionRefs: [ref],
			assessmentRefs: [],
		},
		pack = await store.create(owner, draft);
	return {
		directory,
		owner,
		store,
		learner,
		draft,
		pack,
		ref,
		rev,
		approved,
		publication,
		eligibility,
		advanceTime: (ms) => {
			now += ms;
		},
		verdict: (v) => {
			verdict = v;
		},
		hook: (f) => {
			hook = f;
		},
	};
}
async function shared(mode = "practice") {
	const f = await fixture(mode),
		frozen = await f.store.freeze(f.owner, f.pack.id, 1),
		link = await f.store.mint(f.owner, f.pack.id, frozen.version, {
			nonce: token(),
		});
	return { ...f, frozen, link };
}
async function flow(f) {
	const b = await f.learner.bootstrap();
	await f.learner.resolve(b.seed, { csrf: b.csrf, token: f.link.token });
	return b;
}
async function started(mode = "practice") {
	const f = await shared(mode),
		b = await flow(f),
		a = await f.learner.start(b.seed, {
			csrf: b.csrf,
			startNonce: b.startNonce,
		});
	return { ...f, b, a };
}
async function save(f, kind, answer, extra = {}) {
	const v = await f.learner.read(f.a.credential),
		input = {
			csrf: v.csrf,
			expectedVersion: v.version,
			nonce: token(),
			pageKey: v.currentPageKey,
			kind,
			...(answer ? { answer } : {}),
			...extra,
		};
	return { input, result: await f.learner.save(f.a.credential, input) };
}
async function questions(f) {
	await save(f, "advance");
	await save(f, "advance");
}
async function complete(f) {
	await questions(f);
	await save(f, "answer", { kind: "choice", chosen: 0 });
	await save(f, "advance");
	await save(f, "answer", {
		kind: "order",
		placed: ["prikkel", "reactie"],
		checked: true,
	});
	await save(f, "advance");
	const v = await f.learner.read(f.a.credential),
		input = { csrf: v.csrf, expectedVersion: v.version, nonce: token() };
	return { input, result: await f.learner.submit(f.a.credential, input) };
}

test("canonical vectors, strict tokens and purpose separation", () => {
	assert.equal(canonical({ b: [2, 3], a: 1 }), '{"a":1,"b":[2,3]}');
	assert.equal(
		contentHash({ b: [2, 3], a: 1 }),
		"770AQBkPsIcYMeYGxYH4pm23nY4ruDZ0WnAFEwaVYHA",
	);
	assert.equal(canonical({ "\u{10000}": 1, "\ue000": 2 }), '{"":2,"𐀀":1}');
	for (const v of [undefined, NaN, 1.1, Infinity, { a: undefined }])
		assert.throws(() => canonical(v));
	const seed = token();
	assert.equal(bytes(seed).length, 32);
	assert.notEqual(derived(seed, "csrf"), derived(seed, "attempt"));
	assert.notEqual(derived(seed, "start", 16), derived(seed, "attempt"));
	assert.throws(() => bytes(`${seed}=`));
	assert.throws(() =>
		bytes(Buffer.alloc(32).toString("base64url").slice(0, -1) + "B"),
	);
});
test("draft bounds, duplicate refs and optimistic edits", async () => {
	const f = await fixture();
	assert.equal(
		validateDraft({
			...f.draft,
			missionRefs: [{ ...f.ref, missionId: "a".repeat(83) }],
		}).missionRefs[0].missionId.length,
		83,
	);
	for (const patch of [
		{ title: "<script>" },
		{ title: "x".repeat(121) },
		{ instructions: "x\ny" },
		{ grade: 7 },
		{ mode: "exam" },
		{ score: 9 },
		{ missionRefs: [f.ref, f.ref] },
		{ missionRefs: [f.ref, { ...f.ref, revision: 2, missionId: "another" }] },
		{
			assessmentRefs: [
				{ ...f.ref, objectId: "foreign", stage: "check", questionIndex: 0 },
			],
		},
	])
		assert.throws(() => validateDraft({ ...f.draft, ...patch }));
	const calls = await Promise.allSettled([
		f.store.update(f.owner, f.pack.id, 1, { ...f.draft, title: "A" }),
		f.store.update(f.owner, f.pack.id, 1, { ...f.draft, title: "B" }),
	]);
	assert.equal(calls.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(calls.find((r) => r.status === "rejected").reason.code, "stale");
	assert.equal((await f.store.duplicate(f.owner, f.pack.id)).version, 1);
});
test("actor/workspace boundary, owner cap and default closed adapters", async () => {
	const f = await fixture("practice", true);
	for (const actor of [
		null,
		{ sub: "student", role: "breinhap.student" },
		{ sub: "admin", role: "breinhap.admin" },
	]) {
		await rejects(f.store.get(actor, f.pack.id), "forbidden");
		await rejects(f.store.create(actor, f.draft), "forbidden");
		await rejects(f.store.results(actor, f.pack.id), "forbidden");
	}
	const other = { sub: "other", role: "breinhap.parent" };
	for (const op of [
		() => f.store.get(other, f.pack.id),
		() => f.store.update(other, f.pack.id, 1, f.draft),
		() => f.store.freeze(other, f.pack.id, 1),
		() => f.store.deleteAttempts(other, f.pack.id),
		() => f.store.results(other, f.pack.id),
	])
		await rejects(op(), "not_found");
	assert.deepEqual(await f.store.list(other), []);
	const foreign = await fixture();
	await rejects(foreign.store.get(foreign.owner, f.pack.id), "not_found");
	await rejects(f.store.freeze(f.owner, f.pack.id, 1), "unavailable");
	await pool.query(
		"INSERT INTO practice_packs(workspace_id,id,owner_sub,draft,created_at,updated_at) SELECT $1,gen_random_uuid(),$2,$3::jsonb,now(),now() FROM generate_series(1,99)",
		[f.directory.workspace, f.owner.sub, JSON.stringify(f.draft)],
	);
	await rejects(f.store.create(f.owner, f.draft), "limit");
});
test("independent review gate; clean immutable snapshots detached from draft", async () => {
	const f = await fixture();
	f.approved.review.reviewedBy = f.owner.sub;
	await rejects(f.store.freeze(f.owner, f.pack.id, 1), "unavailable");
	f.approved.review.reviewedBy = "independent-reviewer";
	const frozen = await f.store.freeze(f.owner, f.pack.id, 1),
		e = (
			await pool.query(
				"SELECT envelope FROM practice_pack_versions WHERE pack_id=$1",
				[f.pack.id],
			)
		).rows[0].envelope;
	assert.equal(contentHash(e), frozen.hash);
	assert.ok(!JSON.stringify(e).includes("reviewedBy"));
	assert.ok(!JSON.stringify(e).includes('"sources"'));
	await f.store.update(f.owner, f.pack.id, 1, { ...f.draft, title: "Edited" });
	assert.equal((await f.store.frozen(pool, f.pack.id, 1)).title, "Oefenpakket");
	await assert.rejects(
		pool.query(
			"UPDATE practice_pack_versions SET content_hash=$2 WHERE pack_id=$1",
			[f.pack.id, contentHash({})],
		),
		/immutable/,
	);
	await assert.rejects(
		pool.query("DELETE FROM practice_pack_sources WHERE pack_id=$1", [
			f.pack.id,
		]),
		/immutable/,
	);
	await assert.rejects(
		pool.query("DELETE FROM practice_pack_versions WHERE pack_id=$1", [
			f.pack.id,
		]),
		/immutable/,
	);
	f.approved.schemaVersion = 2;
	await rejects(f.store.freeze(f.owner, f.pack.id, 2), "unsupported_version");
});
test("mint secret once, rotate/revoke and database link constraints", async () => {
	const f = await shared(),
		nonce = token(),
		rotated = await f.store.mint(f.owner, f.pack.id, 1, {
			nonce,
			rotate: true,
		});
	assert.ok(rotated.token);
	const retry = await f.store.mint(f.owner, f.pack.id, 1, {
		nonce,
		rotate: true,
	});
	assert.equal(retry.id, rotated.id);
	assert.ok(!("token" in retry));
	const b = await f.learner.bootstrap();
	await rejects(
		f.learner.resolve(b.seed, { csrf: b.csrf, token: f.link.token }),
		"gone",
	);
	await rejects(
		f.store.mint(f.owner, f.pack.id, 1, {
			nonce: token(),
		}),
		"exists",
	);
	await assert.rejects(
		pool.query(
			"UPDATE practice_share_links SET attempts_started=2 WHERE id=$1",
			[rotated.id],
		),
		/check/,
	);
	await assert.rejects(
		pool.query(
			"UPDATE practice_share_links SET active_slot=true,revoked_at=NULL WHERE id=$1",
			[f.link.id],
		),
		/immutable/,
	);
	await assert.rejects(
		pool.query(
			"INSERT INTO practice_share_links SELECT workspace_id,gen_random_uuid(),pack_id,pack_version,$2,owner_membership_version,not_before,expires_at,NULL,1,0,true,created_by,created_at,NULL,$2 FROM practice_share_links WHERE id=$1",
			[rotated.id, tokenHash(token())],
		),
		/unique/,
	);
});
test("resolve creates no attempt; racing Start and lost-response retry consume once", async () => {
	const f = await shared(),
		b1 = await flow(f),
		b2 = await flow(f),
		meta = await f.learner.resolve(b1.seed, {
			csrf: b1.csrf,
			token: f.link.token,
		});
	assert.ok(!("missions" in meta));
	assert.ok(!("answerIndex" in meta));
	assert.equal(
		(
			await pool.query(
				"SELECT count(*)::int AS n FROM practice_attempts WHERE pack_id=$1",
				[f.pack.id],
			)
		).rows[0].n,
		0,
	);
	const starts = await Promise.allSettled(
		[b1, b2].map((b) =>
			f.learner.start(b.seed, { csrf: b.csrf, startNonce: b.startNonce }),
		),
	);
	assert.equal(starts.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(
		starts.find((r) => r.status === "rejected").reason.code,
		"exhausted",
	);
	const i = starts.findIndex((r) => r.status === "fulfilled"),
		b = [b1, b2][i],
		a = starts[i].value,
		retries = await Promise.all(
			[1, 2].map(() =>
				f.learner.start(b.seed, { csrf: b.csrf, startNonce: b.startNonce }),
			),
		);
	assert.deepEqual(retries, [a, a]);
	assert.equal(
		(
			await pool.query(
				"SELECT attempts_started FROM practice_share_links WHERE id=$1",
				[f.link.id],
			)
		).rows[0].attempts_started,
		1,
	);
	await rejects(f.learner.read(f.link.token), "not_found");
});
test("practice finalization, racing saves, nonce replay and deterministic server score", async () => {
	const f = await started();
	await rejects(
		f.learner.submit(f.a.credential, {
			csrf: derived(f.a.credential, "answer-csrf"),
			expectedVersion: 1,
			nonce: token(),
		}),
		"unfinished",
	);
	await questions(f);
	const v = await f.learner.read(f.a.credential),
		o = {
			csrf: v.csrf,
			expectedVersion: v.version,
			nonce: token(),
			pageKey: v.currentPageKey,
			kind: "answer",
			answer: { kind: "choice", chosen: 0 },
		};
	const results = await Promise.allSettled([
		f.learner.save(f.a.credential, o),
		f.learner.save(f.a.credential, {
			...o,
			nonce: token(),
			answer: { kind: "choice", chosen: 1 },
		}),
	]);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(
		results.find((r) => r.status === "rejected").reason.code,
		"stale",
	);
	if (results[0].status === "fulfilled") {
		assert.deepEqual(await f.learner.save(f.a.credential, o), results[0].value);
		await rejects(
			f.learner.save(f.a.credential, {
				...o,
				answer: { kind: "choice", chosen: 1 },
			}),
			"conflict",
		);
	}
	const read = await f.learner.read(f.a.credential);
	assert.ok(read.page.feedback);
	assert.ok(!("score" in read));
	await rejects(
		f.learner.save(f.a.credential, {
			...o,
			nonce: token(),
			expectedVersion: read.version,
		}),
		"conflict",
	);
	await assert.rejects(
		pool.query("UPDATE practice_answers SET answer='{}' WHERE attempt_id=$1", [
			f.a.id,
		]),
		/finalized/,
	);
	await save(f, "advance");
	await save(f, "answer", {
		kind: "order",
		placed: ["prikkel", "reactie"],
		checked: true,
	});
	await save(f, "advance");
	const end = await f.learner.read(f.a.credential),
		s = { csrf: end.csrf, expectedVersion: end.version, nonce: token() };
	await rejects(
		f.learner.submit(f.a.credential, { ...s, score: 2 }),
		"invalid",
	);
	const submitted = await f.learner.submit(f.a.credential, s);
	assert.ok(submitted.score === 1 || submitted.score === 2);
	assert.deepEqual(await f.learner.submit(f.a.credential, s), submitted);
	await rejects(
		f.learner.save(f.a.credential, {
			...o,
			expectedVersion: submitted.version,
			nonce: token(),
		}),
		"conflict",
	);
	assert.equal(
		(await f.store.results(f.owner, f.pack.id))[0].score,
		submitted.score,
	);
});
test("test-mode projections hide feedback and support visited edits until immutable submit", async () => {
	const f = await started("test");
	await questions(f);
	const q = await save(f, "answer", { kind: "choice", chosen: 1 });
	await save(f, "advance");
	const order = await f.learner.read(f.a.credential);
	assert.ok(!JSON.stringify(order).includes("explanation"));
	assert.ok(!JSON.stringify(order).includes("answerIndex"));
	assert.ok(!("score" in order));
	assert.ok(
		!(await f.learner.read(f.a.credential, q.input.pageKey)).page.feedback,
	);
	assert.ok(!(await f.store.results(f.owner, f.pack.id))[0].answers);
	await f.learner.save(f.a.credential, {
		...q.input,
		nonce: token(),
		expectedVersion: order.version,
		answer: { kind: "choice", chosen: 0 },
	});
	await save(f, "answer", {
		kind: "order",
		placed: ["prikkel", "reactie"],
		checked: true,
	});
	await save(f, "advance");
	const end = await f.learner.read(f.a.credential),
		input = { csrf: end.csrf, expectedVersion: end.version, nonce: token() },
		races = await Promise.all([
			f.learner.submit(f.a.credential, input),
			f.learner.submit(f.a.credential, input),
		]);
	assert.deepEqual(races, [
		{ version: end.version + 1, score: 2 },
		{ version: end.version + 1, score: 2 },
	]);
	assert.ok(
		(await f.learner.read(f.a.credential, q.input.pageKey)).page.feedback,
	);
	await assert.rejects(
		pool.query("UPDATE practice_attempts SET server_score=0 WHERE id=$1", [
			f.a.id,
		]),
		/immutable/,
	);
	await assert.rejects(
		pool.query(
			"INSERT INTO practice_answers SELECT workspace_id,attempt_id,'fake',answer,finalized,server_correct,saved_at,last_nonce_hash,last_payload_hash FROM practice_answers WHERE attempt_id=$1 LIMIT 1",
			[f.a.id],
		),
		/finalized/,
	);
});
test("no plaintext credentials in tables/audit; composite workspace/version boundaries", async () => {
	const f = await started(),
		other = await shared();
	await assert.rejects(
		pool.query("UPDATE practice_attempts SET pack_version=99 WHERE id=$1", [
			f.a.id,
		]),
		/immutable/,
	);
	await assert.rejects(
		pool.query(
			"INSERT INTO practice_answers(workspace_id,attempt_id,page_key,answer,finalized,server_correct,saved_at,last_nonce_hash,last_payload_hash) VALUES($1,$2,'x','{}',false,NULL,now(),$3,$3)",
			[other.directory.workspace, f.a.id, tokenHash(token())],
		),
		/foreign key/,
	);
	for (const table of [
		"practice_packs",
		"practice_pack_versions",
		"practice_pack_sources",
		"practice_share_links",
		"practice_link_sessions",
		"practice_attempts",
		"practice_answers",
		"audit_events",
	]) {
		const dump = JSON.stringify(
			(
				await pool.query(`SELECT * FROM ${table} WHERE workspace_id=$1`, [
					f.directory.workspace,
				])
			).rows,
		);
		for (const secret of [
			f.link.token,
			f.b.seed,
			f.b.csrf,
			f.b.startNonce,
			f.a.credential,
		]) {
			assert.ok(!dump.includes(secret));
			assert.ok(
				!dump.includes(Buffer.from(secret, "base64url").toString("hex")),
			);
		}
	}
	await rejects(
		f.learner.resolve(f.b.seed, { csrf: token(), token: f.link.token }),
		"not_found",
	);
});
test("eligibility outage preserves quota; denial commits permanent revocation", async () => {
	const f = await shared(),
		b = await flow(f);
	f.verdict("unavailable");
	await rejects(
		f.learner.start(b.seed, { csrf: b.csrf, startNonce: b.startNonce }),
		"unavailable",
	);
	let row = (
		await pool.query("SELECT * FROM practice_share_links WHERE id=$1", [
			f.link.id,
		])
	).rows[0];
	assert.equal(row.revoked_at, null);
	assert.equal(row.attempts_started, 0);
	f.verdict("denied");
	await rejects(
		f.learner.start(b.seed, { csrf: b.csrf, startNonce: b.startNonce }),
		"gone",
	);
	row = (
		await pool.query("SELECT * FROM practice_share_links WHERE id=$1", [
			f.link.id,
		])
	).rows[0];
	assert.ok(row.revoked_at);
	assert.equal(row.attempts_started, 0);
	f.verdict("eligible");
	await rejects(
		f.learner.resolve(b.seed, { csrf: b.csrf, token: f.link.token }),
		"gone",
	);
});
test("five-minute flow, not-before, link and idle expiry", async () => {
	const f = await shared(),
		b = await flow(f);
	f.advanceTime(300_000);
	await rejects(
		f.learner.start(b.seed, { csrf: b.csrf, startNonce: b.startNonce }),
		"not_found",
	);
	const nf = await flow(f),
		a = await f.learner.start(nf.seed, {
			csrf: nf.csrf,
			startNonce: nf.startNonce,
		});
	f.advanceTime(DAY);
	await rejects(f.learner.read(a.credential), "gone");
	const future = await f.store.mint(f.owner, f.pack.id, 1, {
			nonce: token(),
			rotate: true,
			notBefore: new Date(Date.UTC(2026, 10, 10, 12)),
		}),
		fb = await f.learner.bootstrap();
	await rejects(
		f.learner.resolve(fb.seed, { csrf: fb.csrf, token: future.token }),
		"gone",
	);
	f.advanceTime(8 * DAY);
	const expired = await f.learner.bootstrap();
	await rejects(
		f.learner.resolve(expired.seed, {
			csrf: expired.csrf,
			token: future.token,
		}),
		"gone",
	);
});
test("withdrawal serializes through source lock; owner historical results survive", async () => {
	const f = await started();
	await complete(f);
	const db = await pool.connect();
	await db.query("BEGIN");
	await db.query(
		"UPDATE test_practice_publication SET active=false WHERE workspace_id=$1",
		[f.directory.workspace],
	);
	let entered;
	const ready = new Promise((r) => {
		entered = r;
	});
	f.hook(async () => entered());
	const pending = f.learner.read(f.a.credential);
	await ready;
	await db.query("COMMIT");
	db.release();
	await rejects(pending, "gone");
	assert.equal((await f.store.results(f.owner, f.pack.id))[0].score, 2);
	await rejects(
		f.learner.start(f.b.seed, { csrf: f.b.csrf, startNonce: f.b.startNonce }),
		"gone",
	);
});
test("delete/save and revoke/save races never resurrect access or quota", async () => {
	const f = await started(),
		v = await f.learner.read(f.a.credential),
		input = {
			csrf: v.csrf,
			expectedVersion: v.version,
			nonce: token(),
			pageKey: v.currentPageKey,
			kind: "advance",
		},
		race = await Promise.allSettled([
			f.learner.save(f.a.credential, input),
			f.store.deleteAttempts(f.owner, f.pack.id, f.a.id),
		]);
	assert.equal(race[1].status, "fulfilled");
	await rejects(f.learner.read(f.a.credential), "not_found");
	assert.equal(
		(
			await pool.query(
				"SELECT attempts_started FROM practice_share_links WHERE id=$1",
				[f.link.id],
			)
		).rows[0].attempts_started,
		1,
	);
	await rejects(
		f.learner.start(f.b.seed, { csrf: f.b.csrf, startNonce: f.b.startNonce }),
		"not_found",
	);
	const g = await started(),
		gv = await g.learner.read(g.a.credential);
	await Promise.allSettled([
		g.learner.save(g.a.credential, {
			...input,
			csrf: gv.csrf,
			expectedVersion: gv.version,
		}),
		g.store.revoke(g.owner, g.pack.id, g.link.id),
	]);
	await rejects(g.learner.read(g.a.credential), "gone");
});
test("Done invalidates attempt/recovery; fixed retention is bounded, repeatable and preserves sources", async () => {
	const f = await started("test"),
		input = { csrf: derived(f.a.credential, "answer-csrf"), nonce: token() };
	assert.deepEqual(await f.learner.finish(f.a.credential, input), {
		closed: true,
	});
	assert.deepEqual(await f.learner.finish(f.a.credential, input), {
		closed: true,
	});
	await rejects(f.learner.read(f.a.credential), "not_found");
	await rejects(
		f.learner.start(f.b.seed, { csrf: f.b.csrf, startNonce: f.b.startNonce }),
		"not_found",
	);
	const result = (await f.store.results(f.owner, f.pack.id))[0];
	assert.equal(result.score, null);
	assert.equal(result.completedAt, null);
	assert.equal(result.state, "closed");
	f.advanceTime(30 * DAY);
	assert.equal((await f.store.retain()).attempts, 1);
	assert.equal((await f.store.retain()).attempts, 0);
	assert.equal(
		(
			await pool.query(
				"SELECT attempts_started FROM practice_share_links WHERE id=$1",
				[f.link.id],
			)
		).rows[0].attempts_started,
		1,
	);
	await f.store.archive(f.owner, f.pack.id);
	f.advanceTime(31 * DAY);
	const purge = await f.store.retain();
	assert.equal(purge.links, 1);
	assert.equal(purge.versions, 1);
	assert.equal(
		(
			await pool.query(
				"SELECT count(*)::int AS n FROM learning_object_revisions WHERE workspace_id=$1",
				[f.directory.workspace],
			)
		).rows[0].n,
		1,
	);
});

async function waitingOn(table) {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const waiting = (
			await pool.query(
				"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1) AS yes",
				[`%SELECT * FROM ${table}%`],
			)
		).rows[0].yes;
		if (waiting) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw Error("Expected database lock wait");
}

test("waiting for a flow lock cannot bypass the five-minute deadline", async () => {
	const f = await shared(),
		b = await flow(f),
		db = await pool.connect();
	await db.query("BEGIN");
	await db.query(
		"SELECT session_hash FROM practice_link_sessions WHERE session_hash=$1 FOR UPDATE",
		[tokenHash(b.seed)],
	);
	const pending = f.learner.start(b.seed, {
		csrf: b.csrf,
		startNonce: b.startNonce,
	});
	try {
		await waitingOn("practice_link_sessions");
		f.advanceTime(300_000);
	} finally {
		await db.query("COMMIT");
		db.release();
	}
	await rejects(pending, "not_found");
	assert.equal(
		(
			await pool.query(
				"SELECT attempts_started FROM practice_share_links WHERE id=$1",
				[f.link.id],
			)
		).rows[0].attempts_started,
		0,
	);
});

test("simultaneous Done is generic even after revoke/outage and removes recovery", async () => {
	const f = await started();
	await complete(f);
	await f.store.revoke(f.owner, f.pack.id, f.link.id);
	f.verdict("unavailable");
	const input = {
		csrf: derived(f.a.credential, "answer-csrf"),
		nonce: token(),
	};
	assert.deepEqual(
		await Promise.all([
			f.learner.finish(f.a.credential, input),
			f.learner.finish(f.a.credential, input),
		]),
		[{ closed: true }, { closed: true }],
	);
	assert.equal(
		(
			await pool.query(
				"SELECT count(*)::int AS n FROM practice_link_sessions WHERE consumed_attempt_id=$1",
				[f.a.id],
			)
		).rows[0].n,
		0,
	);
	assert.equal(
		(
			await pool.query(
				"SELECT server_score FROM practice_attempts WHERE id=$1",
				[f.a.id],
			)
		).rows[0].server_score,
		2,
	);
});

test("retention uses fixed start deadline, deletes finalized answers and retains consumed quota", async () => {
	const f = await started();
	await complete(f);
	f.advanceTime(29 * DAY);
	assert.equal((await f.store.retain()).attempts, 0);
	f.advanceTime(DAY);
	assert.equal((await f.store.retain()).attempts, 1);
	assert.equal(
		(
			await pool.query(
				"SELECT count(*)::int AS n FROM practice_answers WHERE attempt_id=$1",
				[f.a.id],
			)
		).rows[0].n,
		0,
	);
	assert.equal(
		(
			await pool.query(
				"SELECT attempts_started FROM practice_share_links WHERE id=$1",
				[f.link.id],
			)
		).rows[0].attempts_started,
		1,
	);
	assert.equal((await f.store.retain()).attempts, 0);
});

test("additional assessment appearance scores separately; source metadata stays private", async () => {
	const f = await fixture();
	await f.store.update(f.owner, f.pack.id, 1, {
		...f.draft,
		assessmentRefs: [{ ...f.ref, stage: "practice", questionIndex: 0 }],
	});
	const frozen = await f.store.freeze(f.owner, f.pack.id, 2),
		link = await f.store.mint(f.owner, f.pack.id, frozen.version, {
			nonce: token(),
		});
	f.link = link;
	const b = await flow(f);
	f.a = await f.learner.start(b.seed, {
		csrf: b.csrf,
		startNonce: b.startNonce,
	});
	await questions(f);
	await save(f, "answer", { kind: "choice", chosen: 0 });
	await save(f, "advance");
	await save(f, "answer", {
		kind: "order",
		placed: ["prikkel", "reactie"],
		checked: true,
	});
	await save(f, "advance");
	const v = await f.learner.read(f.a.credential);
	assert.equal(v.currentPageKey, "a:0");
	assert.equal(v.questionCount, 3);
	assert.ok(!JSON.stringify(v).includes("revisionHash"));
	await save(f, "answer", { kind: "choice", chosen: 1 });
	await save(f, "advance");
	const end = await f.learner.read(f.a.credential);
	assert.equal(
		(
			await f.learner.submit(f.a.credential, {
				csrf: end.csrf,
				expectedVersion: end.version,
				nonce: token(),
			})
		).score,
		2,
	);
});

test("direct SQL rejects duplicate attempts, short hashes and foreign link/version bindings", async () => {
	const f = await started(),
		g = await shared();
	const clone = (changes) =>
		pool.query(
			"INSERT INTO practice_attempts SELECT (jsonb_populate_record(NULL::practice_attempts,to_jsonb(a)||$2::jsonb)).* FROM practice_attempts a WHERE id=$1",
			[
				f.a.id,
				JSON.stringify({
					id: crypto.randomUUID(),
					resume_hash: "\\x" + tokenHash(token()).toString("hex"),
					...changes,
				}),
			],
		);
	await assert.rejects(clone({}), /unique/);
	await assert.rejects(clone({ link_id: g.link.id }), /foreign key/);
	await assert.rejects(
		pool.query(
			"UPDATE practice_link_sessions SET csrf_hash=$2 WHERE session_hash=$1",
			[tokenHash(f.b.seed), tokenHash(token())],
		),
		/immutable/,
	);
	await assert.rejects(
		pool.query(
			"INSERT INTO practice_link_sessions(session_hash,workspace_id,csrf_hash,state,created_at,expires_at) VALUES($1,$2,$3,'unresolved',now(),now()+interval '1 minute')",
			[Buffer.alloc(31), f.directory.workspace, tokenHash(token())],
		),
		/check/,
	);
});

test("test edit versus final submit serializes once; old mutation cannot replay", async () => {
	const f = await started("test");
	await questions(f);
	const first = await save(f, "answer", { kind: "choice", chosen: 0 });
	await save(f, "advance");
	await rejects(f.learner.save(f.a.credential, first.input), "stale");
	await save(f, "answer", {
		kind: "order",
		placed: ["prikkel", "reactie"],
		checked: true,
	});
	await save(f, "advance");
	const end = await f.learner.read(f.a.credential),
		edit = {
			...first.input,
			expectedVersion: end.version,
			nonce: token(),
			answer: { kind: "choice", chosen: 1 },
		},
		submit = { csrf: end.csrf, expectedVersion: end.version, nonce: token() };
	const race = await Promise.allSettled([
		f.learner.save(f.a.credential, edit),
		f.learner.submit(f.a.credential, submit),
	]);
	assert.equal(race.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(race.find((r) => r.status === "rejected").reason.code, "stale");
	if (race[0].status === "fulfilled")
		assert.equal(
			(
				await f.learner.submit(f.a.credential, {
					...submit,
					expectedVersion: end.version + 1,
					nonce: token(),
				})
			).score,
			1,
		);
	else assert.equal(race[1].value.score, 2);
});

test("flow cap and 500-row cleanup batches do not grow per-token state without bound", async () => {
	const f = await fixture();
	await pool.query(
		"INSERT INTO practice_link_sessions(session_hash,workspace_id,csrf_hash,state,created_at,expires_at) SELECT sha256(($1||i)::bytea),$1,sha256(('csrf'||$1||i)::bytea),'unresolved',$2::timestamptz,$2::timestamptz+interval '5 minutes' FROM generate_series(1,500) i",
		[f.directory.workspace, new Date(Date.UTC(2026, 10, 8, 12))],
	);
	await rejects(f.learner.bootstrap(), "limit");
	f.advanceTime(300_000);
	await f.learner.bootstrap();
	assert.equal((await f.store.retain()).flows, 500);
	assert.equal((await f.store.retain()).flows, 0);
});

test("two cleanup workers remove at most 100 attempts each without quota changes", async () => {
	const f = await started();
	await pool.query(
		`WITH links AS (
 INSERT INTO practice_share_links SELECT workspace_id,gen_random_uuid(),pack_id,pack_version,sha256(($1||i)::bytea),owner_membership_version,not_before,expires_at,created_at,1,1,false,created_by,created_at,NULL,last_mint_nonce_hash FROM practice_share_links CROSS JOIN generate_series(1,100) i WHERE id=$2 RETURNING *)
 INSERT INTO practice_attempts(workspace_id,id,link_id,pack_id,pack_version,resume_hash,state,current_page_key,started_at,last_active_at,delete_after,question_count)
 SELECT workspace_id,gen_random_uuid(),id,pack_id,pack_version,sha256(id::text::bytea),'active','m:0:0',created_at,created_at,created_at+interval '720 hours',2 FROM links`,
		[f.directory.workspace, f.link.id],
	);
	f.advanceTime(30 * DAY);
	const counts = await Promise.all([f.store.retain(), f.store.retain()]);
	assert.equal(
		counts.reduce((n, c) => n + c.attempts, 0),
		101,
	);
	assert.ok(counts.every((c) => c.attempts <= 100));
	assert.equal((await f.store.retain()).attempts, 0);
	assert.equal(
		counts.reduce((n, c) => n + c.links, 0),
		100,
	);
	assert.equal(
		(
			await pool.query(
				"SELECT count(*)::int AS n FROM practice_share_links WHERE workspace_id=$1 AND attempts_started=1",
				[f.directory.workspace],
			)
		).rows[0].n,
		1,
	);
});

test("test partial order is recoverable but cannot advance or submit unfinished", async () => {
	const f = await started("test");
	await questions(f);
	await save(f, "answer", { kind: "choice", chosen: 0 });
	await save(f, "advance");
	await save(f, "answer", {
		kind: "order",
		placed: ["prikkel"],
		checked: false,
	});
	const v = await f.learner.read(f.a.credential);
	assert.deepEqual(v.page.answer, {
		kind: "order",
		placed: ["prikkel"],
		checked: false,
	});
	assert.ok(!v.page.feedback);
	await rejects(
		f.learner.save(f.a.credential, {
			csrf: v.csrf,
			nonce: token(),
			expectedVersion: v.version,
			pageKey: v.currentPageKey,
			kind: "advance",
		}),
		"unfinished",
	);
	await rejects(
		f.learner.submit(f.a.credential, {
			csrf: v.csrf,
			nonce: token(),
			expectedVersion: v.version,
		}),
		"unfinished",
	);
});

test("trusted membership version and upstream error sanitization cannot be overridden in mint", async () => {
	const f = await shared();
	await rejects(
		f.store.mint(f.owner, f.pack.id, 1, {
			nonce: token(),
			membershipVersion: "forged",
			rotate: true,
		}),
		"invalid",
	);
	const changed = { ...f.owner, membershipVersion: "v2" };
	await rejects(
		f.store.mint(changed, f.pack.id, 1, { nonce: token(), rotate: true }),
		"gone",
	);
	const sentinel = token();
	f.eligibility.checkForPractice = async () => {
		throw Error(sentinel);
	};
	const b = await f.learner.bootstrap(),
		error = await f.learner
			.resolve(b.seed, { csrf: b.csrf, token: f.link.token })
			.catch((e) => e);
	assert.equal(error.code, "unavailable");
	assert.ok(!String(error).includes(sentinel));
});
