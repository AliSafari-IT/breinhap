// breinhap#84: hardening of the public learner path. Headers on every response, no third-party
// requests, budgets that slow guessing without a permanent lockout, fail-closed budgets, cookie
// hygiene, no secret in logs, and the retention pass.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createLearnerHandler } from "../src/learner-server.mjs";
import { scheduleSweep, sweep } from "../src/practice/maintenance.mjs";
import { PracticeStore } from "../src/practice/store.mjs";
import { browser, count, finish, getPool, hiddenOf, linked } from "./pack-fixtures.mjs";

const pool = { query: (...args) => getPool().query(...args) };

test("every learner response carries the privacy headers, and no page asks a third party for anything", async () => {
	const w = await linked();
	const b = browser(w);
	const responses = [];
	const note = (res) => (responses.push(res), res);
	note(await b.get("/p/"));
	note(await b.get("/p"));
	note(await b.get("/p/start")); // no flow yet: a redirect
	note(await b.get("/p/nothing"));
	note(await b.get("/bibliotheek"));
	note(await b.get("/p/assets/learner.css"));
	note(await b.get("/p/assets/bootstrap.js"));
	note(await b.get("/p/assets/theme.css"));
	note(await b.get("/p/?token=abc"));
	note(await b.post("/p/answer", {}, { origin: "https://evil.example" }));
	note(await w.s.call("/p/run", { method: "DELETE", headers: { Host: "breinhap.com" } }));
	note(await w.s.call("/p/resolve", { method: "POST", raw: { body: "x=1" }, origin: "https://breinhap.com", headers: { Host: "breinhap.com", "Content-Type": "text/plain" } }));
	await b.open("A".repeat(43)).then(note); // unknown code: a generic 404
	note(await b.open(w.secret));
	note(await b.get("/p/start"));
	const started = note(await b.post("/p/start", hiddenOf((await b.get("/p/start")).body)));
	note(started);
	for (let i = 0; i < 4; i++) note(await b.get("/p/run"));
	await finish(b, true);
	note(await b.get("/p/done"));
	const link = (await pool.query("SELECT id FROM practice_share_links WHERE pack_id=$1", [w.id])).rows[0].id;
	await w.s.call(`/bibliotheek/packs/${w.id}/links/${link}/intrekken`, { method: "POST", raw: { body: `csrf=${encodeURIComponent((await w.s.login("teacher")).csrf)}` } });
	note(await browser(w).open(w.secret));
	assert.ok(responses.length > 20);
	for (const res of responses) {
		const h = res.headers;
		assert.match(h["x-content-type-options"], /nosniff/);
		assert.equal(h["referrer-policy"], "same-origin");
		assert.match(h["x-robots-tag"], /noindex/);
		assert.match(h["content-security-policy"], /default-src 'none'/);
		assert.doesNotMatch(h["content-security-policy"], /unsafe-inline|unsafe-eval|https?:|\*/);
		assert.match(h["x-frame-options"], /DENY/);
		if (!(res.headers["content-type"] ?? "").includes("css") && !(res.headers["content-type"] ?? "").includes("javascript")) assert.match(h["cache-control"], /no-store/);
		// a learner page links to nothing outside this origin and loads nothing from elsewhere
		assert.doesNotMatch(res.body, /(?:src|href|action)="https?:\/\//);
		assert.doesNotMatch(res.body, /<script(?![^>]*\bsrc="\/p\/assets\/)/);
		assert.doesNotMatch(res.body, /\sstyle=|\son[a-z]+=/);
	}
});

test("guessing is slowed per client and per code, and a valid code from another client still works", async () => {
	const w = await linked();
	const guesses = [];
	const bad = () => Array.from({ length: 22 }, (_, i) => `${String(i).padStart(2, "0")}${"B".repeat(41)}`.slice(0, 43).replace(/.$/, "A"));
	const attacker = browser(w);
	const boot = await attacker.get("/p/", { headers: { "x-breinhap-client-address": "203.0.113.5" } });
	const csrf = hiddenOf(boot.body).csrf;
	for (const code of bad()) guesses.push((await attacker.post("/p/resolve", { csrf, token: code }, { headers: { "x-breinhap-client-address": "203.0.113.5" } })).status);
	assert.ok(guesses.slice(0, 15).every((s) => s === 404), guesses.join());
	assert.ok(guesses.includes(429), `expected a refusal after the budget: ${guesses.join()}`);
	const refused = await attacker.post("/p/resolve", { csrf, token: w.secret }, { headers: { "x-breinhap-client-address": "203.0.113.5" } });
	assert.equal(refused.status, 429);
	assert.equal(refused.headers["retry-after"], "60");
	assert.doesNotMatch(refused.body, /Prikkels/);
	// no permanent lockout: the legitimate learner, from another address, is not affected
	const learner = browser(w);
	const open = await learner.get("/p/", { headers: { "x-breinhap-client-address": "198.51.100.7" } });
	const ok = await learner.post("/p/resolve", { csrf: hiddenOf(open.body).csrf, token: w.secret }, { headers: { "x-breinhap-client-address": "198.51.100.7" } });
	assert.equal(ok.status, 303);
	// ordinary use never trips a budget
	const normal = browser(w);
	for (let i = 0; i < 10; i++) assert.equal((await normal.get("/p/", { headers: { "x-breinhap-client-address": "198.51.100.9" } })).status, 200);
});

test("an outage of the budget store fails closed and consumes nothing", async () => {
	const learner = {
		bootstrap: async () => assert.fail("must not run"),
		resolve: async () => assert.fail("must not run"),
		start: async () => assert.fail("must not run"),
	};
	const call = async (budget, path = "/p/", method = "GET") => {
		const handler = createLearnerHandler({ learner, budget });
		let status;
		let body = "";
		const req = { method, url: path, headers: { host: "breinhap.com", origin: "https://breinhap.com", "content-type": "application/x-www-form-urlencoded" }, socket: { remoteAddress: "127.0.0.1" } };
		const res = { writeHead: (s) => (status = s), end: (b) => (body = String(b ?? "")) };
		await handler(req, res);
		return { status, body };
	};
	assert.equal((await call(async () => { throw new Error("redis down"); })).status, 503);
	assert.equal((await call(undefined)).status, 503);
	assert.equal((await call(async () => false)).status, 429);
});

test("cookies are strict: duplicates and forged flow values are refused, and nothing is logged", async () => {
	const w = await linked();
	const logs = [];
	const originals = ["log", "error", "warn", "info", "debug"].map((k) => [k, console[k]]);
	for (const [k] of originals) console[k] = (...args) => logs.push(args.join(" "));
	let flow;
	let credential;
	try {
		const b = browser(w);
		await b.begin(w.secret);
		flow = b.jar.get("__Secure-bh-flow");
		credential = b.jar.get("__Secure-bh-attempt");
		// two attempt cookies are never guessed between
		const dup = await w.s.call("/p/run", { cookie: `__Secure-bh-attempt=${credential}; __Secure-bh-attempt=${credential}`, headers: { Host: "breinhap.com" } });
		assert.equal(dup.status, 303);
		assert.equal(dup.headers.location, "/p/");
		// a flow value the server never issued gets nothing, creates nothing, and looks like any bad code
		const forged = "F".repeat(42) + "A";
		const fixation = await w.s.call("/p/resolve", { method: "POST", raw: { body: `csrf=${"A".repeat(43)}&token=${w.secret}` }, origin: "https://breinhap.com", cookie: `__Secure-bh-flow=${forged}`, headers: { Host: "breinhap.com" } });
		assert.equal(fixation.status, 404);
		const unknown = await browser(w).open("B".repeat(42) + "A");
		assert.equal(unknown.body, fixation.body);
		await finish(b, true);
	} finally {
		for (const [k, fn] of originals) console[k] = fn;
	}
	for (const secret of [w.secret, flow, credential]) assert.ok(!logs.join("\n").includes(secret));
});

test("the retention pass works off a backlog in bounded rounds and is idempotent", async () => {
	const counts = [
		{ flows: 500, attempts: 100, links: 0, versions: 0 },
		{ flows: 3, attempts: 2, links: 1, versions: 0 },
		{ flows: 0, attempts: 0, links: 0, versions: 0 },
	];
	let calls = 0;
	const total = await sweep({ retain: async () => counts[Math.min(calls++, 2)] });
	assert.deepEqual(total, { flows: 503, attempts: 102, links: 1, versions: 0, rounds: 2 });
	// never an unbounded loop
	let endless = 0;
	const capped = await sweep({ retain: async () => (endless++, { flows: 500, attempts: 100, links: 100, versions: 100 }) }, { rounds: 3 });
	assert.equal(capped.rounds, 3);
	// counts only, and a failure is logged without detail and retried
	const out = [];
	const errors = [];
	let tick = 0;
	const stop = scheduleSweep({ retain: async () => { if (tick++ === 0) throw new Error("secret detail"); return { flows: 1, attempts: 0, links: 0, versions: 0 }; } }, { log: (m) => out.push(m), errorLog: (m) => errors.push(m), firstMs: 5, everyMs: 20 });
	await new Promise((resolve) => setTimeout(resolve, 120));
	stop();
	assert.ok(errors.length >= 1 && !errors.join().includes("secret detail"));
	assert.ok(out.length >= 1 && out.every((line) => /^{"event":"practice.retention","flows":\d+,"attempts":0,"links":0,"versions":0,"rounds":\d+}$/.test(line)));
});

test("retention erases due attempts for real, keeps quota consumed, and a second run changes nothing", async () => {
	const w = await linked();
	const b = browser(w);
	await b.begin(w.secret);
	await finish(b, true);
	await pool.query("ALTER TABLE practice_attempts DISABLE TRIGGER practice_attempt_identity");
	await pool.query("UPDATE practice_attempts SET started_at = started_at - interval '31 days', delete_after = delete_after - interval '31 days' WHERE pack_id=$1", [w.id]);
	await pool.query("ALTER TABLE practice_attempts ENABLE TRIGGER practice_attempt_identity");
	const store = new PracticeStore({ directory: w.s.directory });
	const first = await sweep(store);
	assert.ok(first.attempts >= 1);
	assert.equal(await count("practice_attempts", w.id), 0);
	assert.equal((await pool.query("SELECT attempts_started FROM practice_share_links WHERE pack_id=$1", [w.id])).rows[0].attempts_started, 1);
	const second = await sweep(store);
	assert.equal(second.attempts, 0);
	// the credential of an erased attempt does not work and starting again stays impossible
	assert.ok([303, 404, 410].includes((await b.get("/p/run")).status));
	const again = browser(w);
	await again.open(w.secret);
	assert.equal((await again.post("/p/start", hiddenOf((await again.get("/p/start")).body))).status, 410);
});
