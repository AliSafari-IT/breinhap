// breinhap#83: the owner's anonymous attempt results. Owner-only reading and deletion, answers only
// after submission, frozen-version consistency, deletion that keeps quota consumed, and retention
// that hides and then erases due rows.
import assert from "node:assert/strict";
import { test } from "node:test";

import { PracticeStore } from "../src/practice/store.mjs";
import { browser, count, finish, getPool, hiddenOf, linked, post, step, packFields, draftVersion } from "./pack-fixtures.mjs";

const pool = { query: (...args) => getPool().query(...args) };
const results = (w, path = "", who = w.teacher) => w.s.call(`/bibliotheek/packs/${w.id}/resultaten${path}`, { who });
const attemptId = async (w) => (await pool.query("SELECT id FROM practice_attempts WHERE pack_id=$1 ORDER BY started_at DESC LIMIT 1", [w.id])).rows[0].id;

test("the owner sees counts, score, duration and per-question answers against the frozen version", async () => {
	const w = await linked();
	const b = browser(w);
	await b.begin(w.secret);
	// one wrong, one right: the first choice answer wrong, the order right
	let wrongOnce = true;
	for (let i = 0; i < 40; i++) {
		const run = await b.get("/p/run");
		if (run.status === 303) break;
		const h = hiddenOf(run.body);
		if (run.body.includes('action="/p/submit"')) {
			await b.post("/p/submit", h);
			break;
		}
		if (h.kind === "advance") {
			await b.post("/p/answer", h);
			continue;
		}
		const form = { ...h };
		if (run.body.includes('name="chosen"')) {
			form.chosen = wrongOnce ? "1" : "0";
			wrongOnce = false;
		} else ["prikkel", "receptor", "reactie"].forEach((item, n) => (form[`plaats${n}`] = item));
		await b.post("/p/answer", form);
	}
	const list = await results(w);
	assert.equal(list.status, 200);
	assert.match(list.body, /1 poging gestart, 1 ingeleverd/);
	assert.match(list.body, /1 van 2/);
	assert.match(list.body, /Ingeleverd/);
	assert.match(list.body, /30 dagen/);
	assert.doesNotMatch(list.body, /Een verandering|receptor/); // the list never carries answers
	const id = await attemptId(w);
	const detail = await results(w, `/${id}`);
	assert.equal(detail.status, 200);
	assert.match(detail.body, /Antwoord van de leerling: Een spier/);
	assert.match(detail.body, /Juist antwoord: Een verandering/);
	assert.match(detail.body, /prikkel → receptor → reactie/);
	assert.match(detail.body, /Een prikkel is een verandering\./);
	assert.match(detail.body, /score 1 van 2/);
	assert.match(detail.headers["cache-control"], /no-store/);

	// the owner's later edits to the pack or its sources change nothing in the stored result
	await w.s.call(`/bibliotheek/packs/${w.id}`, post({ ...packFields({ titel: "Andere titel" }), expectedVersion: String(await draftVersion(w.id)) }, w.teacher));
	const again = await results(w, `/${id}`);
	assert.equal(again.body.match(/<li class="review-item">/g).length, 2);
	assert.match(again.body, /versie 1/);
	// the revoked link keeps its history until the owner deletes it
	const link = (await pool.query("SELECT id FROM practice_share_links WHERE pack_id=$1", [w.id])).rows[0].id;
	await w.s.call(`/bibliotheek/packs/${w.id}/links/${link}/intrekken`, post({}, w.teacher));
	assert.match((await results(w)).body, /1 poging gestart/);
	assert.equal((await b.get("/p/run")).status, 410);
});

test("an unsubmitted attempt shows its status only, in practice and in test mode", async () => {
	for (const modus of ["practice", "test"]) {
		const w = await linked(modus === "test" ? { modus } : {});
		const b = browser(w);
		await b.begin(w.secret);
		// answer the first question of the pack without submitting
		for (let i = 0; i < 6; i++) {
			const run = await b.get("/p/run");
			const h = hiddenOf(run.body);
			if (run.body.includes('name="chosen"')) {
				await b.post("/p/answer", { ...h, chosen: "0" });
				break;
			}
			await b.post("/p/answer", h);
		}
		const list = await results(w);
		assert.match(list.body, /Bezig/);
		assert.match(list.body, /1 poging gestart, 0 ingeleverd/);
		assert.doesNotMatch(list.body, /Een verandering/);
		const detail = await results(w, `/${await attemptId(w)}`);
		assert.match(detail.body, /nog niet ingeleverd/);
		assert.doesNotMatch(detail.body, /Een verandering|Klopt\.|Juist antwoord|score/);
	}
});

test("only the owner reads or deletes results: other adults, admins, anonymous and guessed ids learn nothing", async () => {
	const w = await linked();
	const b = browser(w);
	await b.begin(w.secret);
	await finish(b, true);
	const id = await attemptId(w);
	const tutor = await w.s.login("tutor");
	const admin = await w.s.login("admin");
	const probes = [
		["GET", ""],
		["GET", `/${id}`],
		["POST", "/verwijderen"],
		["POST", `/${id}/verwijderen`],
	];
	for (const [method, suffix] of probes) {
		const path = `/bibliotheek/packs/${w.id}/resultaten${suffix}`;
		const req = (who) => (method === "GET" ? { who } : post({ bevestig: "1" }, who));
		assert.equal((await w.s.call(path, req(tutor))).status, 404, `tutor ${method} ${suffix}`);
		assert.equal((await w.s.call(path, req(admin))).status, 403, `admin ${method} ${suffix}`);
		const anonymous = await w.s.call(path, { method });
		assert.equal(anonymous.status, 303);
	}
	assert.equal((await results(w, "/00000000-0000-4000-8000-000000000000")).status, 404);
	assert.equal((await results(w, "/not-a-uuid")).status, 404);
	assert.equal(await count("practice_attempts", w.id), 1);
	// a share link alone retrieves no result: the public Host has no such route
	for (const path of [`/p/resultaten`, `/p/${id}`]) assert.equal((await browser(w).get(path)).status, 404);
	// no implicit grant: another owner's pack list does not even mention this pack
	assert.doesNotMatch((await w.s.call("/bibliotheek/packs", { who: tutor })).body, new RegExp(w.id));
});

test("deleting needs confirmation, CSRF and the owner; it keeps the quota consumed and ends learner access", async () => {
	const w = await linked();
	const b = browser(w);
	await b.begin(w.secret);
	const id = await attemptId(w);
	const unconfirmed = await w.s.call(`/bibliotheek/packs/${w.id}/resultaten/${id}/verwijderen`, post({}, w.teacher));
	assert.equal(unconfirmed.status, 422);
	assert.equal(await count("practice_attempts", w.id), 1);
	const forged = await w.s.call(`/bibliotheek/packs/${w.id}/resultaten/${id}/verwijderen`, post({ bevestig: "1", csrf: "forged" }, w.teacher));
	assert.equal(forged.status, 403);
	const wrongOrigin = await w.s.call(`/bibliotheek/packs/${w.id}/resultaten/${id}/verwijderen`, { ...post({ bevestig: "1" }, w.teacher), origin: "https://evil.example" });
	assert.equal(wrongOrigin.status, 403);
	assert.equal(await count("practice_attempts", w.id), 1);

	const removed = await w.s.call(`/bibliotheek/packs/${w.id}/resultaten/${id}/verwijderen`, post({ bevestig: "1" }, w.teacher));
	assert.equal(removed.status, 303);
	assert.equal(removed.headers.location, `/bibliotheek/packs/${w.id}/resultaten?verwijderd=1`);
	assert.equal(await count("practice_attempts", w.id), 0);
	// the learner's credential is dead and cannot restore anything
	const gone = await b.get("/p/run");
	assert.ok([303, 404, 410].includes(gone.status));
	const save = await b.post("/p/answer", { csrf: "x".repeat(43), expectedVersion: "1", nonce: "y".repeat(43), pageKey: "m:0:0", kind: "advance" });
	assert.ok([404, 410].includes(save.status), String(save.status));
	assert.equal(await count("practice_attempts", w.id), 0);
	assert.equal((await pool.query("SELECT count(*)::int AS n FROM practice_answers a WHERE a.attempt_id=$1", [id])).rows[0].n, 0);
	// quota stays consumed: a fresh browser still cannot start another attempt
	assert.equal((await pool.query("SELECT attempts_started FROM practice_share_links WHERE pack_id=$1", [w.id])).rows[0].attempts_started, 1);
	const other = browser(w);
	await other.open(w.secret);
	const start = await other.get("/p/start");
	assert.equal((await other.post("/p/start", hiddenOf(start.body))).status, 410);
	assert.equal(await count("practice_attempts", w.id), 0);
	assert.equal((await w.s.call(`/bibliotheek/packs/${w.id}/resultaten/${id}/verwijderen`, post({ bevestig: "1" }, w.teacher))).status, 404);
});

test("delete-all removes every attempt of the pack, and only this pack's", async () => {
	const w = await linked();
	const x = await linked();
	for (const f of [w, x]) {
		const b = browser(f);
		await b.begin(f.secret);
	}
	assert.equal(await count("practice_attempts", x.id), 1);
	const all = await w.s.call(`/bibliotheek/packs/${w.id}/resultaten/verwijderen`, post({ bevestig: "1" }, w.teacher));
	assert.equal(all.status, 303);
	assert.equal(await count("practice_attempts", w.id), 0);
	assert.equal(await count("practice_attempts", x.id), 1);
	assert.match((await results(w)).body, /Er zijn nog geen pogingen/);
});

test("rows past their retention disappear from the list at once and from storage when maintenance runs", async () => {
	const w = await linked();
	const b = browser(w);
	await b.begin(w.secret);
	await finish(b, true);
	const id = await attemptId(w);
	await pool.query("ALTER TABLE practice_attempts DISABLE TRIGGER practice_attempt_identity");
	await pool.query("UPDATE practice_attempts SET started_at = started_at - interval '31 days', delete_after = delete_after - interval '31 days' WHERE id=$1", [id]);
	await pool.query("ALTER TABLE practice_attempts ENABLE TRIGGER practice_attempt_identity");
	const list = await results(w);
	assert.match(list.body, /Er zijn nog geen pogingen/);
	assert.equal((await results(w, `/${id}`)).status, 404);
	const store = new PracticeStore({ directory: w.s.directory, publishedContent: undefined, ownerEligibility: undefined });
	await store.retain();
	await store.retain(); // idempotent
	assert.equal(await count("practice_attempts", w.id), 0);
	assert.equal((await pool.query("SELECT count(*)::int AS n FROM practice_answers WHERE attempt_id=$1", [id])).rows[0].n, 0);
});

test("results can be filtered by link and carry no name, contact or ranking", async () => {
	const w = await linked();
	const b = browser(w);
	await b.begin(w.secret);
	await finish(b, true);
	const first = (await pool.query("SELECT id FROM practice_share_links WHERE pack_id=$1", [w.id])).rows[0].id;
	const rotated = await w.s.call(`/bibliotheek/packs/${w.id}/links/${first}/roteren`, post({ nonce: "rot-1" }, w.teacher));
	const secret = /#([A-Za-z0-9_-]{43})/.exec(rotated.body)[1];
	const c = browser(w);
	await c.begin(secret);
	assert.match((await results(w)).body, /2 pogingen gestart/);
	const filtered = await results(w, `?link=${first}`);
	assert.match(filtered.body, /1 poging gestart/);
	assert.doesNotMatch(filtered.body, /type="email"|naam van|leaderboard|ranking/i);
	assert.match((await results(w, "?link=not-a-uuid")).body, /2 pogingen gestart/);
});
