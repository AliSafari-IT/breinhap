// breinhap#82: the no-login learner player on the public Host. A clean "browser" (a cookie jar) runs
// the whole flow with no identity call; scanners and replays never consume quota; test mode shows no
// correctness before submission; every state is re-checked on every operation; the management Host
// never serves /p and the public Host serves nothing else.
import assert from "node:assert/strict";
import { test } from "node:test";

import { PublishingStore } from "../src/publishing.mjs";
import { scoreSentence } from "../src/vendor/content-mission.mjs";
import { URL_TOKEN, draftVersion, getPool, mint, packFields, people, post, shareable, tokenOf } from "./pack-fixtures.mjs";

const pool = { query: (...args) => getPool().query(...args) };
const PUBLIC = { Host: "breinhap.com" };
const unescapeHtml = (v) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const hiddenOf = (html) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], unescapeHtml(m[2])]));

/** A browser: its own cookie jar and nothing else. */
function browser(w) {
	const jar = new Map();
	const api = {
		jar,
		cookieHeader: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
		async get(path, { headers = {}, host = "breinhap.com" } = {}) {
			const res = await w.s.call(path, { cookie: api.cookieHeader(), headers: { ...headers, Host: host } });
			api.store(res);
			return res;
		},
		async post(path, fields, { origin = "https://breinhap.com", host = "breinhap.com", cookie } = {}) {
			const body = new URLSearchParams(fields).toString();
			const res = await w.s.call(path, { method: "POST", raw: { body }, origin, cookie: cookie ?? api.cookieHeader(), headers: { Host: host } });
			api.store(res);
			return res;
		},
		store(res) {
			for (const c of [].concat(res.headers["set-cookie"] ?? [])) {
				const [pair, ...attrs] = c.split(";");
				const [k, ...v] = pair.split("=");
				if (attrs.some((a) => a.trim().toLowerCase() === "max-age=0")) jar.delete(k);
				else jar.set(k, v.join("="));
			}
		},
		/** Opens the link the way the bootstrap script does: the code goes in a POST body. */
		async open(secret) {
			const boot = await api.get("/p/");
			assert.equal(boot.status, 200);
			const resolved = await api.post("/p/resolve", { csrf: hiddenOf(boot.body).csrf, token: secret });
			return resolved;
		},
		async begin(secret) {
			const resolved = await api.open(secret);
			assert.equal(resolved.status, 303, resolved.body);
			const start = await api.get("/p/start");
			assert.equal(start.status, 200);
			const started = await api.post("/p/start", hiddenOf(start.body));
			assert.equal(started.status, 303);
			return started;
		},
	};
	return api;
}

/** Answers the current page. `right` decides the verdict of the choice and order questions. */
async function step(b, right = true, seen = []) {
	const run = await b.get("/p/run");
	if (run.status === 303) return { done: true, run };
	assert.equal(run.status, 200, run.body);
	seen.push(run.body);
	const h = hiddenOf(run.body);
	if (run.body.includes('action="/p/submit"')) {
		const submitted = await b.post("/p/submit", h);
		assert.equal(submitted.status, 303);
		return { done: true, run: submitted };
	}
	if (h.kind === "advance") {
		assert.equal((await b.post("/p/answer", h)).status, 303);
		return {};
	}
	const form = { ...h };
	if (run.body.includes('name="chosen"')) form.chosen = right ? "0" : "1";
	else {
		const order = right ? ["prikkel", "receptor", "reactie"] : ["reactie", "receptor", "prikkel"];
		order.forEach((item, i) => (form[`plaats${i}`] = item));
	}
	assert.equal((await b.post("/p/answer", form)).status, 303);
	// practice shows the verdict now; test shows a plain "continue"
	const after = await b.get("/p/run");
	seen.push(after.body);
	const next = hiddenOf(after.body);
	if (next.kind === "advance") assert.equal((await b.post("/p/answer", next)).status, 303);
	return {};
}
async function finish(b, right = true, seen = []) {
	for (let i = 0; i < 40; i++) if ((await step(b, right, seen)).done) return;
	assert.fail("the pack never ended");
}

/** A published object, a frozen version and a live link (token). */
async function linked(extra = {}) {
	const w = await shareable();
	if (Object.keys(extra).length) {
		const saved = await w.s.call(`/bibliotheek/packs/${w.id}`, post({ ...packFields(extra), expectedVersion: String(await draftVersion(w.id)) }, w.teacher));
		assert.equal(saved.status, 303);
	}
	const frozen = await w.s.call(`/bibliotheek/packs/${w.id}/vastleggen`, post({ expectedVersion: String(await draftVersion(w.id)) }, w.teacher));
	assert.equal(frozen.status, 303);
	const secret = tokenOf(await mint(w));
	assert.ok(secret);
	return { ...w, secret };
}
const count = async (table, id) => (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${table === "practice_share_links" ? "pack_id" : "pack_id"}=$1`, [id])).rows[0].n;

test("a clean browser completes a practice pack with no identity; the verdicts come from the server", async () => {
	const w = await linked({ vraag: "lo-a|lo-a-m1|check|0" });
	const b = browser(w);
	const boot = await b.get("/p/");
	assert.equal(boot.status, 200);
	assert.match(boot.headers["set-cookie"][0], /^__Secure-bh-flow=[\w-]{43}; Path=\/p; Secure; HttpOnly; SameSite=Lax/);
	assert.match(boot.headers["content-security-policy"], /script-src 'self'/);
	assert.doesNotMatch(boot.headers["content-security-policy"], /unsafe-inline/);
	assert.equal(boot.headers["referrer-policy"], "no-referrer");
	assert.match(boot.headers["cache-control"], /no-store/);
	assert.doesNotMatch(boot.body, /bibliotheek|Afmelden|session\.js|editor\.js/);
	const resolved = await b.post("/p/resolve", { csrf: hiddenOf(boot.body).csrf, token: w.secret });
	assert.equal(resolved.status, 303);
	assert.equal(resolved.headers.location, "/p/start");
	// link previews and resolve never consume quota or create an attempt
	assert.equal(await count("practice_attempts", w.id), 0);
	const start = await b.get("/p/start");
	assert.match(start.body, /Prikkels oefenen/);
	assert.match(start.body, /Lees rustig en kies\./);
	assert.match(start.body, /zichtbaar voor de volwassene/);
	assert.doesNotMatch(start.body, /Een verandering|Een prikkel is een verandering|receptor/);
	assert.equal(await count("practice_attempts", w.id), 0);
	const started = await b.post("/p/start", hiddenOf(start.body));
	assert.equal(started.headers.location, "/p/run");
	assert.match(started.headers["set-cookie"][0], /^__Secure-bh-attempt=[\w-]{43}; Path=\/p; Secure; HttpOnly; SameSite=Lax/);
	assert.equal(await count("practice_attempts", w.id), 1);
	assert.equal((await pool.query("SELECT attempts_started FROM practice_share_links WHERE pack_id=$1", [w.id])).rows[0].attempts_started, 1);

	// first page is the warm-up; one choice (wrong on purpose), later the right order
	const seen = [];
	let first = await b.get("/p/run");
	assert.match(first.body, /Opwarmen/);
	assert.match(first.body, /Stap 1 van/);
	await finish(b, true, seen);
	const done = await b.get("/p/done");
	assert.equal(done.status, 200);
	assert.ok(done.body.includes(scoreSentence(3, 3)));
	assert.match(done.body, /Terugblik/);
	const attempt = (await pool.query("SELECT state, server_score, question_count FROM practice_attempts WHERE pack_id=$1", [w.id])).rows[0];
	assert.deepEqual([attempt.state, attempt.server_score, attempt.question_count], ["submitted", 3, 3]);
	// Done clears access: the old credential no longer works anywhere
	const old = b.cookieHeader();
	const finished = await b.post("/p/finish", hiddenOf(done.body));
	assert.equal(finished.status, 200);
	assert.equal(b.jar.size, 0);
	const replay = await b.get("/p/done", { headers: { Cookie: old } });
	assert.ok([303, 404, 410].includes(replay.status));
	assert.equal((await pool.query("SELECT state, resume_hash FROM practice_attempts WHERE pack_id=$1", [w.id])).rows[0].resume_hash, null);
	// no token, answer or score ever travelled in a URL
	for (const call of [boot, resolved, started]) assert.doesNotMatch(String(call.headers.location ?? ""), /[?#]|token|score|chosen/);
});

test("wrong answers are marked by the server and the numbers match the shared mission rules", async () => {
	const w = await linked({ vraag: "lo-a|lo-a-m1|check|0" });
	const b = browser(w);
	await b.begin(w.secret);
	await finish(b, false);
	const done = await b.get("/p/done");
	const row = (await pool.query("SELECT server_score, question_count FROM practice_attempts WHERE pack_id=$1", [w.id])).rows[0];
	assert.equal(row.server_score, 0);
	assert.ok(done.body.includes(scoreSentence(0, row.question_count)));
	assert.match(done.body, /Nog niet\./);
	assert.match(done.body, /De juiste volgorde: prikkel → receptor → reactie/);
});

test("test mode shows no correctness, explanation or score before the final submit", async () => {
	const w = await linked({ modus: "test" });
	const b = browser(w);
	const start = await b.begin(w.secret);
	assert.equal(start.status, 303);
	const seen = [];
	let submitted = false;
	for (let i = 0; i < 40 && !submitted; i++) {
		const result = await step(b, true, seen);
		submitted = Boolean(result.done);
	}
	assert.ok(seen.length > 3);
	for (const body of seen) {
		assert.doesNotMatch(body, /Klopt\.|Nog niet\.|Een prikkel is een verandering\.|Eerst de prikkel\.|answerIndex|De juiste volgorde/);
		assert.doesNotMatch(body, /van de \d+ vragen juist/);
	}
	const done = await b.get("/p/done");
	assert.match(done.body, /Je had 2 van de 2 vragen juist\./);
	assert.match(done.body, /Een prikkel is een verandering\./);
});

test("a bad link is a generic 404; revoked, expired, withdrawn and used links are a generic 410", async () => {
	const w = await linked();
	const b = browser(w);
	for (const bad of ["x", "A".repeat(43), "a".repeat(44), ""]) {
		const res = await browser(w).open(bad);
		assert.equal(res.status, 404, bad);
		assert.match(res.body, /Deze link werkt niet/);
		assert.doesNotMatch(res.body, /Prikkels/);
	}
	// scanners and previews: GET never starts anything, and an unknown cookie goes back to the start
	assert.equal((await b.get("/p/run")).status, 303);
	assert.equal(await count("practice_attempts", w.id), 0);

	// quota: the first browser starts, a forwarded copy of the link cannot reach that attempt
	await b.begin(w.secret);
	const other = browser(w);
	assert.equal((await other.open(w.secret)).status, 303);
	const second = await other.get("/p/start");
	assert.equal(second.status, 200);
	const blocked = await other.post("/p/start", hiddenOf(second.body));
	assert.equal(blocked.status, 410);
	assert.match(blocked.body, /niet meer beschikbaar/);
	assert.doesNotMatch(blocked.body, /Prikkels/);
	assert.equal((await other.get("/p/run")).status, 303);
	assert.equal((await pool.query("SELECT attempts_started FROM practice_share_links WHERE pack_id=$1", [w.id])).rows[0].attempts_started, 1);

	// revocation by the owner stops the running attempt on its very next request
	const link = (await pool.query("SELECT id FROM practice_share_links WHERE pack_id=$1", [w.id])).rows[0].id;
	assert.equal((await w.s.call(`/bibliotheek/packs/${w.id}/links/${link}/intrekken`, post({}, w.teacher))).status, 303);
	const after = await b.get("/p/run");
	assert.equal(after.status, 410);
	assert.equal((await browser(w).open(w.secret)).status, 410);
});

test("withdrawing a source and an expired link both stop the player", async () => {
	const w = await linked();
	const b = browser(w);
	await b.begin(w.secret);
	await w.publishing.withdraw(w.publisher, "lo-a");
	assert.equal((await b.get("/p/run")).status, 410);
	const x = await linked();
	const c = browser(x);
	await c.begin(x.secret);
	await pool.query("ALTER TABLE practice_share_links DISABLE TRIGGER practice_link_identity");
	await pool.query("UPDATE practice_share_links SET expires_at = now() - interval '1 minute', not_before = now() - interval '2 minutes', created_at = now() - interval '3 minutes' WHERE pack_id=$1", [x.id]);
	await pool.query("ALTER TABLE practice_share_links ENABLE TRIGGER practice_link_identity");
	assert.equal((await c.get("/p/run")).status, 410);
});

test("starting twice from the same flow is idempotent and the lost response can be recovered", async () => {
	const w = await linked();
	const b = browser(w);
	await b.open(w.secret);
	const start = await b.get("/p/start");
	const fields = hiddenOf(start.body);
	const one = await b.post("/p/start", fields);
	const credential = b.jar.get("__Secure-bh-attempt");
	b.jar.delete("__Secure-bh-attempt"); // the response was lost
	const two = await b.post("/p/start", fields);
	assert.equal(one.status, 303);
	assert.equal(two.status, 303);
	assert.equal(b.jar.get("__Secure-bh-attempt"), credential);
	assert.equal(await count("practice_attempts", w.id), 1);
});

test("forged answers, scores and foreign pages are rejected; the score is the server's", async () => {
	const w = await linked();
	const b = browser(w);
	await b.begin(w.secret);
	const run = await b.get("/p/run");
	const h = hiddenOf(run.body);
	// a card cannot be answered, a foreign page key is refused, a stale version is refused
	const foreign = await b.post("/p/answer", { ...h, kind: "answer", pageKey: "m:0:99", chosen: "0" });
	assert.ok([303, 400, 409].includes(foreign.status));
	const answers = async () => (await pool.query("SELECT count(*)::int AS n FROM practice_answers a JOIN practice_attempts t ON t.id=a.attempt_id WHERE t.pack_id=$1", [w.id])).rows[0].n;
	assert.equal(await answers(), 0);
	const stale = await b.post("/p/answer", { ...h, expectedVersion: "99" });
	assert.equal(stale.status, 409);
	const noCsrf = await b.post("/p/answer", { ...h, csrf: "x".repeat(43) });
	assert.equal(noCsrf.status, 404);
	const badOrigin = await b.post("/p/answer", h, { origin: "https://management.breinhap.com" });
	assert.equal(badOrigin.status, 403);
	const noOrigin = await w.s.call("/p/answer", { method: "POST", raw: { body: new URLSearchParams(h).toString() }, origin: "", cookie: b.cookieHeader(), headers: { Host: "breinhap.com" } });
	assert.equal(noOrigin.status, 403);
	// the page position did not change, and a "score" field is ignored at the end
	const pos = await b.get("/p/run");
	assert.match(pos.body, /Stap 1 van/);
	await finish(b, true);
	const done = await b.get("/p/done");
	assert.match(done.body, /2 van de 2/);
	const forged = await b.post("/p/submit", { ...hiddenOf(done.body), score: "99", expectedVersion: "1" });
	assert.notEqual(forged.status, 200);
	assert.equal((await pool.query("SELECT server_score FROM practice_attempts WHERE pack_id=$1", [w.id])).rows[0].server_score, 2);
	// duplicate scalar fields are refused outright
	const dup = await w.s.call("/p/answer", { method: "POST", raw: { body: "csrf=a&csrf=b" }, origin: "https://breinhap.com", cookie: b.cookieHeader(), headers: { Host: "breinhap.com" } });
	assert.equal(dup.status, 400);
});

test("the Hosts are separate: /p is never served on management, and the public Host serves nothing else", async () => {
	const w = await linked();
	const b = browser(w);
	for (const path of ["/p/", "/p/start", "/p/run", "/p/assets/learner.css"])
		assert.equal((await b.get(path, { host: "management.breinhap.com" })).status, 404, path);
	for (const path of ["/", "/bibliotheek", "/bibliotheek/packs", "/healthz", "/login", "/beheer", "/p/other", "/p/../bibliotheek"]) {
		const res = await b.get(path);
		assert.ok([404, 421].includes(res.status), `${path} ${res.status}`);
		assert.doesNotMatch(res.body, /Breinhap beheer/);
	}
	assert.equal((await b.get("/p/", { host: "evil.example" })).status, 421);
	// a management session on the public Host is not read: no identity call, the learner is simply anonymous
	const manage = await w.s.call("/p/run", { who: w.teacher, headers: { Host: "breinhap.com" } });
	assert.equal(manage.status, 303);
	assert.equal(manage.headers.location, "/p/");
	assert.equal(manage.headers["set-cookie"], undefined);
	// the method allowlist
	const del = await w.s.call("/p/run", { method: "DELETE", headers: { Host: "breinhap.com" } });
	assert.equal(del.status, 405);
	assert.equal((await w.s.call("/p/resolve", { headers: { Host: "breinhap.com" } })).status, 405);
	assert.equal((await b.post("/p/run", {})).status, 405);
	// query strings never carry anything: they are dropped
	const q = await b.get("/p/?token=abc&score=1");
	assert.equal(q.status, 303);
	assert.equal(q.headers.location, "/p/");
	// assets: only the three first-party files, read-only
	assert.equal((await b.get("/p/assets/learner.css")).status, 200);
	assert.match((await b.get("/p/assets/bootstrap.js")).headers["content-type"], /javascript/);
	assert.equal((await b.get("/p/assets/secret.js")).status, 404);
	assert.equal((await b.post("/p/assets/learner.css", {})).status, 405);
});

test("learner chrome follows the pack language and escapes authored text", async () => {
	for (const [taal, start, label] of [["fr", /Commencer/, "fr-BE"], ["en", /Start/, "en"], ["de", /Starten/, "de-BE"], ["nl", /Starten/, "nl-BE"]]) {
		const w = await linked({ taal });
		const b = browser(w);
		await b.open(w.secret);
		const page = await b.get("/p/start");
		assert.match(page.body, start, taal);
		assert.match(page.body, new RegExp(`<html lang="${label}">`));
		assert.doesNotMatch(page.body, /<script/);
	}
	const w = await linked({ beschrijving: `Vis & "chips" 'x' &lt;b&gt;` });
	const b = browser(w);
	await b.open(w.secret);
	const page = await b.get("/p/start");
	assert.match(page.body, /Vis &amp; &quot;chips&quot; &#39;x&#39; &amp;lt;b&amp;gt;/);
	assert.doesNotMatch(page.body, /<script/);
});

test("the raw link and the flow secrets never reach the database or a later page", async () => {
	const w = await linked();
	const b = browser(w);
	await b.begin(w.secret);
	const flow = b.jar.get("__Secure-bh-flow");
	const credential = b.jar.get("__Secure-bh-attempt");
	await finish(b, true);
	for (const needle of [w.secret, flow, credential]) {
		const tables = (await pool.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema='public'")).rows;
		for (const { t } of tables) {
			const hits = (await pool.query(`SELECT count(*)::int AS n FROM "${t}" x WHERE x::text LIKE $1`, [`%${needle}%`])).rows[0].n;
			assert.equal(hits, 0, `${t} holds a raw secret`);
		}
	}
	const done = await b.get("/p/done");
	for (const needle of [w.secret, flow, credential]) assert.ok(!done.body.includes(needle));
	assert.ok(!URL_TOKEN.test(done.body));
});
