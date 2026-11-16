// breinhap#135 against a real Redis and a real Postgres, over the real HTTP server: a student signs in
// on breinhap.com/p with the e-mail code ASafariM sends (app-sdk/headless, faked here like in the
// adults' suite), types the link code once and lands on /p/mijn. The student session is its own
// cookie and its own store entries: it opens nothing on management, and a management session opens
// nothing here. The second part drives a real Chromium without JavaScript at 320, 390 and 1280 px.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import pg from "pg";
import { chromium } from "playwright";

import { migrate } from "../src/db.mjs";
import { Directory } from "../src/directory.mjs";
import { createIdentity, ORIGIN } from "../src/identity.mjs";
import { LearnerAccounts } from "../src/learner-accounts.mjs";
import { createManagementServer } from "../src/server.mjs";
import { STUDENT_ABSOLUTE_MS, STUDENT_IDLE_MS, STUDENT_SHARED_ABSOLUTE_MS, STUDENT_SHARED_IDLE_MS } from "../src/store.mjs";
import { makeStore, member } from "./helpers.mjs";

const PUBLIC = "https://breinhap.com";
const STUDENT = "__Secure-bh-student";
const DAY = 86_400_000;
const adminPrincipal = { sub: "admin", role: "breinhap.admin" };

let admin;
let pool;
const servers = [];
const database = `breinhap_student_${randomBytes(6).toString("hex")}`;
before(async () => {
	if (!process.env.POSTGRES_TEST_URL)
		throw new Error("Use pnpm --filter @breinhap/management test, or set POSTGRES_TEST_URL for this suite");
	admin = new pg.Client({ connectionString: process.env.POSTGRES_TEST_URL });
	await admin.connect();
	await admin.query(`CREATE DATABASE ${database}`);
	const url = new URL(process.env.POSTGRES_TEST_URL);
	url.pathname = `/${database}`;
	pool = new pg.Pool({ connectionString: url.toString(), max: 6 });
	pool.on("error", () => {}); // idle connections end when the test database is dropped
	await migrate(pool);
});
after(async () => {
	await Promise.all(
		servers.map((s) => {
			const closed = new Promise((resolve) => s.close(resolve));
			s.closeAllConnections();
			return closed;
		}),
	);
	await pool?.end();
	await admin?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
	await admin?.end();
});

/** ASafariM's headless API as Breinhap sees it: a code per challenge, an account per address. */
function fakeHeadless() {
	const accounts = new Map([["admin@example.test", "admin"], ["juf@example.test", "teacher"]]);
	const codes = new Map();
	const revoked = new Set();
	const sent = [];
	return {
		sent,
		revoke: (sub) => revoked.add(sub),
		subOf: (email) => accounts.get(email),
		async startEmail({ email, locale, intent }) {
			const challenge = `challenge-${sent.length}-${"x".repeat(12)}`;
			codes.set(challenge, { email, code: String(100000 + sent.length) });
			sent.push({ email, locale, intent });
			return { ok: true, challenge, expiresIn: 300 };
		},
		async verifyEmail({ challenge, email, code }) {
			const c = codes.get(challenge);
			if (!c || c.email !== email) return { ok: false, error: "expired" };
			if (c.code !== code) return { ok: false, error: "wrong_code" };
			codes.delete(challenge);
			if (!accounts.has(email)) accounts.set(email, `sub-${accounts.size}`);
			const sub = accounts.get(email);
			if (revoked.has(sub)) return { ok: false, error: "revoked" };
			return { ok: true, sub, email, connected: false };
		},
		async principal(sub) {
			return { active: !revoked.has(sub) };
		},
		codeFor: (email) => [...codes.values()].reverse().find((c) => c.email === email)?.code,
	};
}

/** One workspace: identity on Redis, the directory on Postgres, the server on a local port. */
async function world({ adultGrants = [] } = {}) {
	const clock = { time: Date.now() };
	const now = () => clock.time;
	const store = await makeStore(now);
	await member(store, "admin", "breinhap.admin");
	await member(store, "teacher", "breinhap.teacher");
	const headless = fakeHeadless();
	const grants = async (subject) => ({
		appId: "breinhap",
		subject,
		state: subject === "admin" || adultGrants.includes(subject) ? "active" : "inactive",
		roles: subject === "admin" ? ["breinhap.admin"] : adultGrants.includes(subject) ? ["breinhap.tutor"] : [],
		permissions: subject === "admin" ? ["breinhap.management.access", "breinhap.memberships.manage"] : [],
	});
	const identity = createIdentity({ store, grants, headless, now, version: "9.9.9", provider: {} });
	const directory = await new Directory({ pool, workspace: store.workspace }).ready();
	const learnerAccounts = new LearnerAccounts({
		directory,
		membership: (sub) => store.membership(sub),
		budget: (kind, limit, seconds, requester) => store.budget(kind, limit, seconds, requester),
	});
	const server = createManagementServer({ identity, directory, learnerAccounts });
	servers.push(server);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const learner = async (displayName = "Lina") => directory.createLearner(adminPrincipal, { displayName, schoolYear: 3 });
	const linkCode = async (learnerId) => (await learnerAccounts.createCode(adminPrincipal, learnerId)).code;
	return { clock, store, headless, identity, directory, learnerAccounts, server, port: server.address().port, learner, linkCode };
}

/** A browser as the server sees it: a cookie jar, the public Host and Origin unless told otherwise. */
function browser(w, { lang } = {}) {
	const jar = new Map();
	const raw = new Map(); // the full Set-Cookie line per name, to check its attributes
	const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
	const request = (method, path, { form, body, origin = PUBLIC, host = "breinhap.com", cookie, type = "application/x-www-form-urlencoded", headers = {} } = {}) =>
		new Promise((resolve, reject) => {
			const payload = body ?? (form ? new URLSearchParams(form).toString() : undefined);
			const req = http.request(
				{
					hostname: "127.0.0.1",
					port: w.port,
					path,
					method,
					headers: {
						Host: host,
						Cookie: cookie ?? cookieHeader(),
						...(lang ? { "Accept-Language": lang } : {}),
						...(method === "POST" && origin ? { Origin: origin } : {}),
						...(payload !== undefined ? { "Content-Type": type, "Content-Length": Buffer.byteLength(payload) } : {}),
						...headers,
					},
				},
				(res) => {
					const parts = [];
					res.on("data", (chunk) => parts.push(chunk));
					res.on("end", () => {
						for (const line of res.headers["set-cookie"] ?? []) {
							const [pair] = line.split(";");
							const name = pair.slice(0, pair.indexOf("="));
							raw.set(name, line);
							if (/Max-Age=0/.test(line)) jar.delete(name);
							else jar.set(name, pair.slice(name.length + 1));
						}
						resolve({ status: res.statusCode, headers: res.headers, location: res.headers.location, body: Buffer.concat(parts).toString("utf8") });
					});
				},
			);
			req.on("error", reject);
			req.end(payload);
		});
	const csrf = (html) => /name="csrf" value="([^"]+)"/.exec(html)?.[1];
	const get = (path, options) => request("GET", path, options);
	const post = (path, form, options) => request("POST", path, { form, ...options });
	/** E-mail address, then the e-mailed code: a signed-in student (or the page that refused). */
	async function signIn(email, { shared = false } = {}) {
		const start = await get("/p/aanmelden");
		assert.equal(start.status, 200);
		const sent = await post("/p/aanmelden", { csrf: csrf(start.body), email, ...(shared ? { gedeeld: "1" } : {}) });
		assert.equal(sent.status, 303, sent.body);
		assert.equal(sent.location, "/p/aanmelden/code");
		const page = await get("/p/aanmelden/code");
		return post("/p/aanmelden/code", { csrf: csrf(page.body), code: w.headless.codeFor(email) });
	}
	return { jar, raw, get, post, request, csrf, signIn, cookieHeader };
}

const sessionKey = (w, id) => w.store.keyFor("student-session", id);

test("a new student signs in with only an e-mail address, types the link code and lands on /p/mijn; the next visit goes straight there", async () => {
	const w = await world();
	const learnerId = await w.learner();
	const code = await w.linkCode(learnerId);
	const b = browser(w);

	const start = await b.get("/p/aanmelden");
	assert.equal(start.status, 200);
	assert.match(start.body, /<h1>Leerling aanmelden<\/h1>/);
	// owner decision 2026-11-15: one line, right before the e-mail field; nothing checks age
	assert.match(start.body, /Voor leerlingen van 13 jaar of ouder\.<\/p><div class="field"><label for="email">Je e-mailadres<\/label>/);
	assert.doesNotMatch(start.body, /name="(age|leeftijd|geboortedatum|birth)/i);
	assert.match(start.body, /Ik zit op een gedeelde computer/);
	assert.match(start.body, /href="https:\/\/management\.breinhap\.com\/login"/);
	assert.doesNotMatch(start.body, /<script|style=|<style/, "no script, no inline style");
	assert.match(start.headers["content-security-policy"], /script-src 'self'; style-src 'self'/);

	const sent = await b.post("/p/aanmelden", { csrf: b.csrf(start.body), email: " Lina@School.Example " });
	assert.equal(sent.status, 303);
	assert.equal(sent.location, "/p/aanmelden/code");
	// the same headless sign-in the adults use, in the student's language
	assert.deepEqual(w.headless.sent.at(-1), { email: "lina@school.example", locale: "nl", intent: "signin" });
	const codePage = await b.get("/p/aanmelden/code");
	assert.match(codePage.body, /l•••@school\.example/);
	assert.doesNotMatch(codePage.body, /lina@school\.example/);
	assert.match(codePage.body, /autocomplete="one-time-code"/);

	const signedIn = await b.post("/p/aanmelden/code", { csrf: b.csrf(codePage.body), code: w.headless.codeFor("lina@school.example") });
	assert.equal(signedIn.status, 303);
	assert.equal(signedIn.location, "/p/koppelen", "an account without a learner profile goes to the link step");
	// the student cookie, and nothing of management's
	assert.match(b.raw.get(STUDENT), /^__Secure-bh-student=[A-Za-z0-9_-]{43}; Path=\/p; Secure; HttpOnly; SameSite=Lax; Max-Age=7776000$/);
	assert.ok(![...b.raw.keys()].some((name) => name.startsWith("__Host-") || name.includes("breinhap-session")), "no management cookie on this Host");
	assert.deepEqual([...b.jar.keys()], [STUDENT], "the sign-in cookies are gone once the session exists");

	const link = await b.get("/p/koppelen");
	assert.equal(link.status, 200);
	assert.match(link.body, /<h1>Typ je koppelcode<\/h1>/);
	assert.match(link.body, /Vraag de code aan je leerkracht, begeleider of ouder/);
	// typed the way the adult's page shows it: grouped, any case
	const typed = `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`.toLowerCase();
	const linked = await b.post("/p/koppelen", { csrf: b.csrf(link.body), code: typed });
	assert.equal(linked.status, 303);
	assert.equal(linked.location, "/p/mijn");
	const mine = await b.get("/p/mijn");
	assert.equal(mine.status, 200);
	assert.match(mine.body, /<h1>Mijn opdrachten<\/h1>/);
	assert.match(mine.body, /<form method="post" action="\/p\/afmelden">/);

	// the next visit: still signed in, so every way in goes straight to /p/mijn
	for (const path of ["/p/aanmelden", "/p/aanmelden/code", "/p/koppelen"]) {
		const again = await b.get(path);
		assert.equal(again.status, 303, path);
		assert.equal(again.location, "/p/mijn", path);
	}

	// what is stored: the ASafariM subject, never the e-mail address
	const sub = w.headless.subOf("lina@school.example");
	const { rows } = await pool.query("SELECT * FROM learner_accounts WHERE workspace_id = $1", [w.directory.workspace]);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].account_sub, sub);
	assert.equal(rows[0].learner_id, learnerId);
	for (const table of ["learner_accounts", "learner_link_codes", "audit_events"]) {
		const dump = JSON.stringify((await pool.query(`SELECT * FROM ${table}`)).rows);
		assert.ok(!/school\.example/i.test(dump), `${table} holds no e-mail address`);
	}
	const session = await w.store.getStudentSession(b.jar.get(STUDENT), false);
	assert.deepEqual(Object.keys(session).sort(), ["authTime", "csrf", "expires", "issuedAt", "kind", "shared", "sid", "sub"]);
	assert.equal(session.sub, sub);
	assert.ok(!JSON.stringify(session).includes("school.example"), "the session holds no e-mail address");
});

test("no code, token or e-mail address is ever put in a URL", async () => {
	const w = await world();
	const code = await w.linkCode(await w.learner());
	const b = browser(w);
	const locations = [];
	const start = await b.get("/p/aanmelden");
	locations.push((await b.post("/p/aanmelden", { csrf: b.csrf(start.body), email: "noor@school.example" })).location);
	const page = await b.get("/p/aanmelden/code");
	const emailCode = w.headless.codeFor("noor@school.example");
	locations.push((await b.post("/p/aanmelden/code", { csrf: b.csrf(page.body), code: emailCode })).location);
	const link = await b.get("/p/koppelen");
	locations.push((await b.post("/p/koppelen", { csrf: b.csrf(link.body), code })).location);
	assert.deepEqual(locations, ["/p/aanmelden/code", "/p/koppelen", "/p/mijn"]);
	// a query string on these pages is dropped, never echoed
	const stripped = await b.get("/p/mijn?code=ABC&email=noor@school.example");
	assert.equal(stripped.status, 303);
	assert.equal(stripped.location, "/p/mijn");
});

test("a wrong e-mail code says so calmly and the student can try again", async () => {
	const w = await world();
	const b = browser(w);
	const start = await b.get("/p/aanmelden");
	await b.post("/p/aanmelden", { csrf: b.csrf(start.body), email: "sam@school.example" });
	const page = await b.get("/p/aanmelden/code");
	const token = b.csrf(page.body);
	const wrong = await b.post("/p/aanmelden/code", { csrf: token, code: "000000" });
	assert.equal(wrong.status, 400);
	assert.match(wrong.body, /role="alert">Die code klopt nog niet\./);
	assert.ok(!b.jar.has(STUDENT), "no session after a wrong code");
	const malformed = await b.post("/p/aanmelden/code", { csrf: token, code: "12ab" });
	assert.equal(malformed.status, 400);
	assert.match(malformed.body, /Die code klopt nog niet\./);
	// spaces between the digits are fine
	const right = w.headless.codeFor("sam@school.example");
	const ok = await b.post("/p/aanmelden/code", { csrf: token, code: `${right.slice(0, 3)} ${right.slice(3)}` });
	assert.equal(ok.status, 303);
	assert.equal(ok.location, "/p/koppelen");
	// the flow is single use: the same form again starts nothing
	const replay = await b.request("POST", "/p/aanmelden/code", { form: { csrf: token, code: right }, cookie: "" });
	assert.equal(replay.status, 303);
	assert.equal(replay.location, "/p/aanmelden");
	// an address that cannot be one
	const fresh = browser(w);
	const again = await fresh.get("/p/aanmelden");
	const bad = await fresh.post("/p/aanmelden", { csrf: fresh.csrf(again.body), email: "geen adres" });
	assert.equal(bad.status, 400);
	assert.match(bad.body, /Dat e-mailadres klopt nog niet\./);
	// without a sign-in in progress the code page sends the student back to the start
	assert.equal((await browser(w).get("/p/aanmelden/code")).location, "/p/aanmelden");
});

test("an account without a learner profile sees only the link-code step; every failing code gets the same answer", async () => {
	const w = await world();
	const learnerId = await w.learner();
	const b = browser(w);
	assert.equal((await b.signIn("mila@school.example")).location, "/p/koppelen");
	const mine = await b.get("/p/mijn");
	assert.equal(mine.status, 303);
	assert.equal(mine.location, "/p/koppelen");
	const link = await b.get("/p/koppelen");
	assert.match(link.body, /Vraag de code aan je leerkracht, begeleider of ouder/);
	assert.doesNotMatch(link.body, /Mijn opdrachten|\/p\/mijn/);
	const token = b.csrf(link.body);

	const used = await w.linkCode(learnerId);
	const other = browser(w);
	await other.signIn("first@school.example");
	assert.equal((await other.post("/p/koppelen", { csrf: other.csrf((await other.get("/p/koppelen")).body), code: used })).location, "/p/mijn");
	const revokedLearner = await w.learner("Bram");
	const revoked = await w.linkCode(revokedLearner);
	await w.learnerAccounts.revokeCode(adminPrincipal, revokedLearner);

	const answers = [];
	for (const code of ["ABCDEFGHJK", used, revoked, "", "te-kort", "x".repeat(24)]) {
		const res = await b.post("/p/koppelen", { csrf: token, code });
		assert.equal(res.status, 400, code);
		answers.push(res.body);
	}
	assert.equal(new Set(answers).size, 1, "wrong, used, revoked and malformed codes answer alike");
	assert.match(answers[0], /role="alert">Deze koppelcode werkt niet\./);
	assert.equal((await b.get("/p/mijn")).location, "/p/koppelen", "still not linked");
});

test("an adult account gets no student session and is pointed to management.breinhap.com", async () => {
	const w = await world({ adultGrants: ["sub-3"] });
	// a member of the workspace
	const teacher = browser(w);
	const refused = await teacher.signIn("juf@example.test");
	assert.equal(refused.status, 403);
	assert.match(refused.body, /<h1>Deze pagina is voor leerlingen<\/h1>/);
	assert.ok(refused.body.includes("Je werkplek staat op management.breinhap.com."), "the page says where the workspace is");
	assert.match(refused.body, /href="https:\/\/management\.breinhap\.com\/login"/);
	assert.ok(!teacher.jar.has(STUDENT));
	assert.equal((await teacher.get("/p/mijn")).location, "/p/aanmelden");
	assert.equal((await teacher.get("/p/koppelen")).location, "/p/aanmelden");

	// someone who asked for an adult role and waits for approval
	const waiting = browser(w);
	const first = await waiting.signIn("papa@example.test");
	assert.equal(first.location, "/p/koppelen", "not an adult yet");
	const sub = w.headless.subOf("papa@example.test");
	await w.store.requestRole(sub, "breinhap.parent", { firstName: "Jan", lastName: "Peeters" });
	const asked = browser(w);
	assert.equal((await asked.signIn("papa@example.test")).status, 403);
	assert.ok(!asked.jar.has(STUDENT));

	// the earlier session of that account ends when the membership becomes active
	assert.equal((await waiting.get("/p/koppelen")).status, 200);
	await member(w.store, sub, "breinhap.parent");
	const ended = await waiting.get("/p/koppelen");
	assert.equal(ended.status, 303);
	assert.equal(ended.location, "/p/aanmelden");
	assert.equal(await w.store.getStudentSession(waiting.raw.get(STUDENT).split(";")[0].split("=")[1], false), null);

	// an account ASafariM knows with an adult role (third new address: sub-3)
	const known = browser(w);
	assert.equal(w.headless.subOf("tutor@example.test"), undefined);
	const res = await known.signIn("tutor@example.test");
	assert.equal(w.headless.subOf("tutor@example.test"), "sub-3");
	assert.equal(res.status, 403);
	assert.match(res.body, /Deze pagina is voor leerlingen/);
});

test("sign-out ends the session at once", async () => {
	const w = await world();
	const code = await w.linkCode(await w.learner());
	const b = browser(w);
	await b.signIn("eva@school.example");
	await b.post("/p/koppelen", { csrf: b.csrf((await b.get("/p/koppelen")).body), code });
	const mine = await b.get("/p/mijn");
	assert.equal(mine.status, 200);
	const stolen = b.cookieHeader();
	const id = b.jar.get(STUDENT);

	// GET never signs out
	const viaGet = await b.get("/p/afmelden");
	assert.equal(viaGet.status, 405);
	assert.equal(viaGet.headers.allow, "POST");
	// nor does a POST without the session's token
	assert.equal((await b.post("/p/afmelden", { csrf: "x".repeat(43) })).status, 403);
	assert.equal((await b.get("/p/mijn")).status, 200);

	const out = await b.post("/p/afmelden", { csrf: b.csrf(mine.body) });
	assert.equal(out.status, 303);
	assert.equal(out.location, "/p/aanmelden");
	assert.match(b.raw.get(STUDENT), /^__Secure-bh-student=; Path=\/p; Secure; HttpOnly; SameSite=Lax; Max-Age=0$/);
	assert.equal(await w.store.client.exists(sessionKey(w, id)), 0, "the store entry is gone");
	// the old cookie, kept by someone else, opens nothing
	const replay = await b.get("/p/mijn", { cookie: stolen });
	assert.equal(replay.status, 303);
	assert.equal(replay.location, "/p/aanmelden");
	// signing out twice is calm
	assert.equal((await b.post("/p/afmelden", {})).status, 303);
	// the link itself stays: signing in again goes straight to /p/mijn
	assert.equal((await b.signIn("eva@school.example")).location, "/p/mijn");
});

test("the session lasts 14 days idle and 90 days at most; on a shared computer it ends with the browser", async () => {
	const w = await world();
	const b = browser(w);
	await b.signIn("tess@school.example");
	const id = b.jar.get(STUDENT);
	const ttl = await w.store.client.pTTL(sessionKey(w, id));
	assert.ok(ttl > STUDENT_IDLE_MS - 60_000 && ttl <= STUDENT_IDLE_MS, `idle entry of 14 days, got ${ttl}`);
	const session = await w.store.getStudentSession(id, false);
	assert.equal(session.expires, w.clock.time + STUDENT_ABSOLUTE_MS);
	assert.equal(session.shared, false);

	// activity renews the idle time, never past the absolute end
	w.clock.time += 80 * DAY;
	assert.equal((await b.get("/p/koppelen")).status, 200);
	const late = await w.store.client.pTTL(sessionKey(w, id));
	assert.ok(late > 10 * DAY - 60_000 && late <= 10 * DAY, `capped at the 10 days left, got ${late}`);
	w.clock.time += 10 * DAY + 1000;
	const expired = await b.get("/p/koppelen");
	assert.equal(expired.status, 303);
	assert.equal(expired.location, "/p/aanmelden");
	assert.equal(await w.store.client.exists(sessionKey(w, id)), 0);
	assert.ok(!b.jar.has(STUDENT), "the dead cookie is cleared");

	// an idle entry that Redis let go is simply signed out
	const idle = browser(w);
	await idle.signIn("tess@school.example");
	await w.store.client.del(sessionKey(w, idle.jar.get(STUDENT)));
	assert.equal((await idle.get("/p/mijn")).location, "/p/aanmelden");

	// 'Ik zit op een gedeelde computer': a cookie without Max-Age, a short entry
	const shared = browser(w);
	assert.equal((await shared.signIn("tess@school.example", { shared: true })).status, 303);
	assert.match(shared.raw.get(STUDENT), /^__Secure-bh-student=[A-Za-z0-9_-]{43}; Path=\/p; Secure; HttpOnly; SameSite=Lax$/);
	const sharedId = shared.jar.get(STUDENT);
	const sharedTtl = await w.store.client.pTTL(sessionKey(w, sharedId));
	assert.ok(sharedTtl > STUDENT_SHARED_IDLE_MS - 60_000 && sharedTtl <= STUDENT_SHARED_IDLE_MS, `2 hours idle, got ${sharedTtl}`);
	assert.equal((await w.store.getStudentSession(sharedId, false)).expires, w.clock.time + STUDENT_SHARED_ABSOLUTE_MS);
	w.clock.time += STUDENT_SHARED_ABSOLUTE_MS + 1000;
	assert.equal((await shared.get("/p/koppelen")).location, "/p/aanmelden");
});

test("an account that ASafariM revoked loses its student session", async () => {
	const w = await world();
	const b = browser(w);
	await b.signIn("rik@school.example");
	assert.equal((await b.get("/p/koppelen")).status, 200);
	w.headless.revoke(w.headless.subOf("rik@school.example"));
	w.clock.time += 61_000; // the account check is cached for a minute, as for adults
	assert.equal((await b.get("/p/koppelen")).location, "/p/aanmelden");
	const again = await b.signIn("rik@school.example");
	assert.equal(again.status, 403);
	assert.match(again.body, /Dit account kan Breinhap niet gebruiken\./);
});

test("every POST needs the exact Origin and its CSRF token; forms are bounded and duplicate-free", async () => {
	const w = await world();
	const code = await w.linkCode(await w.learner());
	const anon = browser(w);
	const start = await anon.get("/p/aanmelden");
	const formToken = anon.csrf(start.body);
	// the e-mail step
	for (const origin of ["https://management.breinhap.com", "https://evil.example", "http://breinhap.com", "null", ""]) {
		const res = await anon.post("/p/aanmelden", { csrf: formToken, email: "a@school.example" }, { origin });
		assert.equal(res.status, 403, `Origin ${origin || "(none)"}`);
	}
	const noToken = await anon.post("/p/aanmelden", { email: "a@school.example" });
	assert.equal(noToken.status, 403);
	assert.match(noToken.body, /Deze pagina stond te lang open\./);
	// a token made for another browser's form cookie does not fit
	const elsewhere = browser(w);
	const foreign = elsewhere.csrf((await elsewhere.get("/p/aanmelden")).body);
	assert.notEqual(foreign, formToken);
	assert.equal((await anon.post("/p/aanmelden", { csrf: foreign, email: "a@school.example" })).status, 403);
	// and without the form cookie no token fits
	assert.equal((await anon.request("POST", "/p/aanmelden", { form: { csrf: formToken, email: "a@school.example" }, cookie: "" })).status, 403);
	assert.equal(w.headless.sent.length, 0, "no refused request sent an e-mail");

	// the code step
	assert.equal((await anon.post("/p/aanmelden", { csrf: anon.csrf((await anon.get("/p/aanmelden")).body), email: "a@school.example" })).status, 303);
	const codeToken = anon.csrf((await anon.get("/p/aanmelden/code")).body);
	const emailCode = w.headless.codeFor("a@school.example");
	assert.equal((await anon.post("/p/aanmelden/code", { csrf: codeToken, code: emailCode }, { origin: "https://evil.example" })).status, 403);
	assert.equal((await anon.post("/p/aanmelden/code", { csrf: formToken, code: emailCode })).status, 403);
	assert.equal((await anon.post("/p/aanmelden/code", { code: emailCode })).status, 403);
	assert.ok(!anon.jar.has(STUDENT));
	assert.equal((await anon.post("/p/aanmelden/code", { csrf: codeToken, code: emailCode })).status, 303);

	// the link step and sign-out, signed in
	const sessionToken = anon.csrf((await anon.get("/p/koppelen")).body);
	assert.notEqual(sessionToken, codeToken);
	for (const path of ["/p/koppelen", "/p/afmelden"]) {
		assert.equal((await anon.post(path, { csrf: sessionToken, code }, { origin: "https://management.breinhap.com" })).status, 403, path);
		assert.equal((await anon.post(path, { csrf: codeToken, code })).status, 403, path);
		assert.equal((await anon.post(path, { code })).status, 403, path);
		// duplicate fields, a JSON body and an oversized body are refused outright
		assert.equal((await anon.request("POST", path, { body: `csrf=${sessionToken}&csrf=${sessionToken}&code=${code}` })).status, 400, path);
		assert.equal((await anon.request("POST", path, { body: JSON.stringify({ csrf: sessionToken }), type: "application/json" })).status, 400, path);
		assert.equal((await anon.request("POST", path, { body: `csrf=${sessionToken}&code=${"A".repeat(20_000)}` })).status, 400, path);
	}
	assert.equal((await anon.get("/p/koppelen")).status, 200, "still signed in, still unlinked");
	assert.equal((await pool.query("SELECT count(*)::int AS n FROM learner_accounts WHERE workspace_id = $1", [w.directory.workspace])).rows[0].n, 0);
	// other methods
	for (const path of ["/p/aanmelden", "/p/koppelen", "/p/mijn", "/p/afmelden"])
		assert.equal((await anon.request("DELETE", path)).status, 405, path);
	assert.equal((await anon.request("POST", "/p/mijn", { form: { csrf: sessionToken } })).status, 405);
});

test("the Host boundary: the student routes answer 404 on the management Host, and neither session counts for the other", async () => {
	const w = await world();
	const code = await w.linkCode(await w.learner());
	const b = browser(w);
	await b.signIn("zoë@school.example");
	await b.post("/p/koppelen", { csrf: b.csrf((await b.get("/p/koppelen")).body), code });
	const mine = await b.get("/p/mijn");
	assert.equal(mine.status, 200);
	const token = b.csrf(mine.body);
	const id = b.jar.get(STUDENT);

	// on management.breinhap.com these routes do not exist, with or without a student session
	for (const path of ["/p/aanmelden", "/p/aanmelden/code", "/p/koppelen", "/p/mijn", "/p/afmelden"]) {
		for (const options of [{}, { cookie: "" }]) {
			const res = await b.get(path, { host: "management.breinhap.com", ...options });
			assert.equal(res.status, 404, `GET ${path}`);
			assert.doesNotMatch(res.body, /Mijn opdrachten|koppelcode|Leerling aanmelden/);
			const posted = await b.post(path, { csrf: token, code }, { host: "management.breinhap.com", origin: ORIGIN, ...options });
			assert.equal(posted.status, 404, `POST ${path}`);
		}
	}
	assert.equal(await w.store.client.exists(sessionKey(w, id)), 1, "nothing on the management Host signed the student out");
	// an unknown Host is misdirected
	assert.equal((await b.get("/p/mijn", { host: "evil.example" })).status, 421);

	// a student session opens no management route or API, also when its id is offered as management's cookie
	for (const cookie of [b.cookieHeader(), `__Host-breinhap-session=${id}`, `${b.cookieHeader()}; __Host-breinhap-session=${id}`]) {
		for (const path of ["/", "/bibliotheek", "/leerlingen", "/beheer", "/beheer/leerlingen", "/instellingen", "/registreren"]) {
			const res = await b.get(path, { host: "management.breinhap.com", cookie });
			assert.equal(res.status, 303, `${path} ${res.status}`);
			assert.match(res.location, /^\/(login|register)/, path);
		}
		const state = await b.get("/auth/session", { host: "management.breinhap.com", cookie });
		assert.deepEqual(JSON.parse(state.body), { active: false, access: false });
		const made = await b.post("/leerlingen/koppelcode", { csrf: token, learner: "x" }, { host: "management.breinhap.com", origin: ORIGIN, cookie });
		assert.equal(made.status, 303);
		assert.match(made.location, /^\/login/);
	}

	// a management session is not a student session: neither under its own cookie nor offered as the student's
	const adultId = randomBytes(32).toString("base64url");
	const now = w.clock.time;
	assert.ok(await w.store.saveSession(adultId, { method: "headless", sub: "admin", sid: "s", email: "admin@example.test", csrf: randomBytes(32).toString("base64url"), issuedAt: Math.floor(now / 1000), authTime: Math.floor(now / 1000), accessToken: "headless", expires: now + 3_600_000, tokenExpires: now + 3_600_000 }));
	assert.equal((await b.get("/", { host: "management.breinhap.com", cookie: `__Host-breinhap-session=${adultId}` })).status, 200, "a real management session");
	for (const cookie of [`__Host-breinhap-session=${adultId}`, `${STUDENT}=${adultId}`]) {
		for (const path of ["/p/mijn", "/p/koppelen"]) {
			const res = await b.get(path, { cookie });
			assert.equal(res.status, 303, path);
			assert.equal(res.location, "/p/aanmelden", path);
		}
		const start = await b.get("/p/aanmelden", { cookie });
		assert.equal(start.status, 200, "an adult's cookie shows the sign-in form like anyone's");
		assert.ok(![start.headers["set-cookie"] ?? []].flat().some((line) => line.includes("breinhap-session")), "the management cookie is neither set nor cleared here");
	}
	assert.ok(await w.store.getSession(adultId, false), "the management session was not touched");
	// and the store keeps the two apart
	assert.equal(await w.store.getSession(id, false), null);
	assert.equal(await w.store.getStudentSession(adultId, false), null);
});

test("a revoked link ends access on the next request", async () => {
	const w = await world();
	const learnerId = await w.learner();
	const b = browser(w);
	await b.signIn("jef@school.example");
	await b.post("/p/koppelen", { csrf: b.csrf((await b.get("/p/koppelen")).body), code: await w.linkCode(learnerId) });
	assert.equal((await b.get("/p/mijn")).status, 200);

	await w.learnerAccounts.unlink(adminPrincipal, learnerId);
	const next = await b.get("/p/mijn");
	assert.equal(next.status, 303);
	assert.equal(next.location, "/p/koppelen", "the very next request no longer opens /p/mijn");
	assert.doesNotMatch(next.body, /Mijn opdrachten/);
	const link = await b.get("/p/koppelen");
	assert.equal(link.status, 200);
	assert.match(link.body, /Typ je koppelcode/);

	// a new code from the adult links again; archiving the learner profile ends access the same way
	await b.post("/p/koppelen", { csrf: b.csrf(link.body), code: await w.linkCode(learnerId) });
	assert.equal((await b.get("/p/mijn")).status, 200);
	await w.directory.archiveLearner(adminPrincipal, learnerId);
	assert.equal((await b.get("/p/mijn")).location, "/p/koppelen");
});

test("rate limits like the adult sign-in: per mailbox, per sign-in attempt and per account for link codes", async () => {
	const w = await world();
	const b = browser(w);
	// five codes per mailbox per quarter of an hour (the adults' "start-email" counter)
	for (let n = 0; n < 5; n++) {
		const page = await b.get("/p/aanmelden");
		assert.equal((await b.post("/p/aanmelden", { csrf: b.csrf(page.body), email: "druk@school.example" })).status, 303, `request ${n + 1}`);
	}
	const page = await b.get("/p/aanmelden");
	const sixth = await b.post("/p/aanmelden", { csrf: b.csrf(page.body), email: "druk@school.example" });
	assert.equal(sixth.status, 429);
	assert.equal(sixth.headers["retry-after"], "60");
	assert.match(sixth.body, /Dat waren veel pogingen\./);
	assert.equal(w.headless.sent.length, 5);
	// the counter is the adults' own: the management sign-in for that mailbox is spent too
	const adult = await b.post("/login", { email: "druk@school.example" }, { host: "management.breinhap.com", origin: ORIGIN, cookie: "" });
	assert.equal(adult.status, 429);

	// five tries per sign-in attempt, then that attempt is over
	const c = browser(w);
	const start = await c.get("/p/aanmelden");
	await c.post("/p/aanmelden", { csrf: c.csrf(start.body), email: "gok@school.example" });
	const token = c.csrf((await c.get("/p/aanmelden/code")).body);
	for (let n = 0; n < 5; n++) assert.equal((await c.post("/p/aanmelden/code", { csrf: token, code: "000000" })).status, 400);
	const spent = await c.post("/p/aanmelden/code", { csrf: token, code: w.headless.codeFor("gok@school.example") });
	assert.equal(spent.status, 429);
	assert.match(spent.body, /Leerling aanmelden/);
	assert.ok(!c.jar.has(STUDENT));
	assert.equal((await c.get("/p/aanmelden/code")).location, "/p/aanmelden");

	// ten link codes per account per quarter of an hour, on the real Redis counter
	const d = browser(w);
	await d.signIn("raad@school.example");
	const linkToken = d.csrf((await d.get("/p/koppelen")).body);
	for (let n = 0; n < 10; n++) assert.equal((await d.post("/p/koppelen", { csrf: linkToken, code: "ABCDEFGHJK" })).status, 400, `guess ${n + 1}`);
	const real = await w.linkCode(await w.learner());
	const blocked = await d.post("/p/koppelen", { csrf: linkToken, code: real });
	assert.equal(blocked.status, 429);
	assert.match(blocked.body, /Dat waren veel pogingen\./);
	assert.equal((await d.get("/p/mijn")).location, "/p/koppelen", "the real code was not spent by the refusal");
});

test("the pages speak nl, fr, en and de", async () => {
	const w = await world();
	const expected = {
		nl: ["nl-BE", "Leerling aanmelden", "Voor leerlingen van 13 jaar of ouder.", "Typ je koppelcode"],
		fr: ["fr-BE", "Connexion élève", "Pour les élèves de 13 ans ou plus.", "Saisissez votre code de liaison"],
		en: ["en", "Student sign-in", "For students aged 13 or older.", "Type your link code"],
		de: ["de-BE", "Anmeldung für Schülerinnen und Schüler", "Für Schülerinnen und Schüler ab 13 Jahren.", "Gib deinen Verbindungscode ein"],
	};
	for (const [lang, [htmlLang, title, age, linkTitle]] of Object.entries(expected)) {
		const b = browser(w, { lang: `${lang}-BE,${lang};q=0.9` });
		const start = await b.get("/p/aanmelden");
		assert.match(start.body, new RegExp(`<html lang="${htmlLang}">`));
		assert.ok(start.body.includes(`<h1>${title}</h1>`), lang);
		assert.ok(start.body.includes(age), lang);
		assert.equal((await b.signIn(`${lang}@school.example`)).location, "/p/koppelen");
		assert.equal(w.headless.sent.at(-1).locale, lang, "the e-mail is asked for in the page's language");
		assert.ok((await b.get("/p/koppelen")).body.includes(`<h1>${linkTitle}</h1>`), lang);
	}
});

test("management /registreren has one line for students, with the link to breinhap.com/p/aanmelden", async () => {
	const w = await world();
	const jar = new Map();
	const call = (method, path, form) =>
		new Promise((resolve, reject) => {
			const payload = form ? new URLSearchParams(form).toString() : undefined;
			const req = http.request(
				{ hostname: "127.0.0.1", port: w.port, path, method, headers: { Host: "management.breinhap.com", Origin: ORIGIN, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), ...(payload ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(payload) } : {}) } },
				(res) => {
					const parts = [];
					res.on("data", (chunk) => parts.push(chunk));
					res.on("end", () => {
						for (const line of res.headers["set-cookie"] ?? []) {
							const [pair] = line.split(";");
							const [k, v] = pair.split("=");
							if (/Max-Age=0/.test(line)) jar.delete(k);
							else jar.set(k, v);
						}
						resolve({ status: res.statusCode, body: Buffer.concat(parts).toString("utf8") });
					});
				},
			);
			req.on("error", reject);
			req.end(payload);
		});
	await call("POST", "/register", { email: "nieuw@example.test" });
	const form = await call("GET", "/login/code");
	await call("POST", "/login/code", { csrf: /name="csrf" value="([^"]+)"/.exec(form.body)[1], code: w.headless.codeFor("nieuw@example.test") });
	const lines = { nl: "Ben je leerling?", fr: "Vous êtes élève ?", en: "Are you a student?", de: "Sind Sie Schüler?" };
	for (const [lang, line] of Object.entries(lines)) {
		const page = await call("GET", `/registreren?lang=${lang}`);
		assert.equal(page.status, 200, lang);
		assert.ok(page.body.includes(`<strong>${line}</strong>`), lang);
		assert.equal(page.body.split('href="https://breinhap.com/p/aanmelden"').length, 2, `one link in ${lang}`);
		// the form itself stays adult-only
		assert.deepEqual([...page.body.matchAll(/name="role" value="([^"]+)"/g)].map((m) => m[1]), ["breinhap.parent", "breinhap.tutor", "breinhap.teacher"]);
	}
});

// ── a real browser, without JavaScript ──────────────────────────────────────────────────────────

/** An HTTPS front on the plain test server, answering as the public and the management Host alike. */
async function https(w, dir) {
	execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=breinhap.com", "-addext", "subjectAltName=DNS:breinhap.com,DNS:management.breinhap.com", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
	const requests = [];
	const server = createServer({ key: await readFile(join(dir, "key.pem")), cert: await readFile(join(dir, "cert.pem")) }, (req, res) => {
		requests.push({ host: req.headers.host, line: `${req.method} ${req.url}` });
		const upstream = http.request({ hostname: "127.0.0.1", port: w.port, path: req.url, method: req.method, headers: req.headers }, (back) => {
			res.writeHead(back.statusCode, back.headers);
			back.pipe(res);
		});
		upstream.on("error", () => {
			res.writeHead(502);
			res.end();
		});
		req.pipe(upstream);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, requests, endpoint: `127.0.0.1:${server.address().port}` };
}
const launch = (endpoint) =>
	chromium.launch({
		headless: true,
		...(process.env.BREINHAP_TEST_CHROMIUM ? { executablePath: process.env.BREINHAP_TEST_CHROMIUM } : {}),
		args: ["--no-proxy-server", `--host-resolver-rules=MAP breinhap.com:443 ${endpoint}, MAP management.breinhap.com:443 ${endpoint}`],
	});
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("browser, JavaScript off: sign in, link, land on /p/mijn and sign out at 320, 390 and 1280 px, with no outside request", async () => {
	const dir = await mkdtemp(join(tmpdir(), "breinhap-student-browser-"));
	const w = await world();
	let chrome;
	let front;
	try {
		front = await https(w, dir);
		chrome = await launch(front.endpoint);
		for (const [width, height] of [[320, 640], [390, 800], [1280, 800]]) {
			const email = `leerling${width}@school.example`;
			const linkCode = await w.linkCode(await w.learner(`Leerling ${width}`));
			const context = await chrome.newContext({ ignoreHTTPSErrors: true, locale: "nl-BE", viewport: { width, height }, javaScriptEnabled: false, reducedMotion: "reduce" });
			const page = await context.newPage();
			const seen = [];
			page.on("request", (request) => seen.push(request.url()));
			const fits = async (where) => {
				// JavaScript is off in the page; the measurement runs through the DevTools protocol
				const metrics = await (await context.newCDPSession(page)).send("Page.getLayoutMetrics");
				assert.ok(metrics.cssContentSize.width <= width, `overflow on ${where} at ${width}px: ${metrics.cssContentSize.width}`);
			};

			await page.goto(`${PUBLIC}/p/mijn`);
			await page.waitForURL(`${PUBLIC}/p/aanmelden`);
			assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "Leerling aanmelden");
			assert.equal(await page.getByRole("main").count(), 1);
			assert.ok(await page.getByText("Voor leerlingen van 13 jaar of ouder.").isVisible());
			await fits("the sign-in page");
			// the field's label, and the keyboard alone: type, Enter
			await page.getByLabel("Je e-mailadres").fill(email);
			await page.keyboard.press("Enter");
			await page.waitForURL(`${PUBLIC}/p/aanmelden/code`);
			await fits("the code page");
			// a wrong code first: the message appears, nothing is lost
			await page.getByLabel("Code uit de e-mail").fill("000000");
			await page.getByRole("button", { name: "Aanmelden" }).click();
			await page.getByRole("alert").waitFor();
			assert.match(await page.getByRole("alert").innerText(), /Die code klopt nog niet\./);
			await fits("the code page with a message");
			await page.getByLabel("Code uit de e-mail").fill(w.headless.codeFor(email));
			await page.getByRole("button", { name: "Aanmelden" }).click();
			await page.waitForURL(`${PUBLIC}/p/koppelen`);
			assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "Typ je koppelcode");
			await fits("the link page");
			await page.getByLabel("Koppelcode").fill("ABCD-EFGH-JK");
			await page.getByRole("button", { name: "Koppelen" }).click();
			await page.getByRole("alert").waitFor();
			await fits("the link page with a message");
			await page.getByLabel("Koppelcode").fill(`${linkCode.slice(0, 4)}-${linkCode.slice(4, 8)}-${linkCode.slice(8)}`);
			await page.getByRole("button", { name: "Koppelen" }).click();
			await page.waitForURL(`${PUBLIC}/p/mijn`);
			assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "Mijn opdrachten");
			await fits("/p/mijn");

			// the cookie as the browser keeps it
			const cookies = await context.cookies();
			const session = cookies.find((c) => c.name === STUDENT);
			assert.deepEqual({ path: session.path, httpOnly: session.httpOnly, secure: session.secure, sameSite: session.sameSite, domain: session.domain }, { path: "/p", httpOnly: true, secure: true, sameSite: "Lax", domain: "breinhap.com" });
			assert.deepEqual(cookies.map((c) => c.name), [STUDENT]);
			assert.deepEqual(await context.cookies(ORIGIN), [], "nothing for the management site");

			// the next visit goes straight to /p/mijn
			await page.goto(`${PUBLIC}/p/aanmelden`);
			await page.waitForURL(`${PUBLIC}/p/mijn`);
			await page.getByRole("button", { name: "Afmelden" }).click();
			await page.waitForURL(`${PUBLIC}/p/aanmelden`);
			assert.ok(!(await context.cookies()).some((c) => c.name === STUDENT));
			await page.goto(`${PUBLIC}/p/mijn`);
			await page.waitForURL(`${PUBLIC}/p/aanmelden`);

			// every request stayed on the public origin; no code or address in any URL
			// (the shared learner layout names the site's favicon, which the browser may ask this origin for)
			assert.ok(seen.every((u) => new URL(u).origin === PUBLIC && (new URL(u).pathname.startsWith("/p/") || /^\/favicon\.(ico|svg)$/.test(new URL(u).pathname))), seen.join("\n"));
			assert.ok(seen.every((u) => !u.includes(linkCode) && !u.includes("school.example") && !new URL(u).search), seen.join("\n"));
			await context.close();
		}
		assert.ok(front.requests.every((r) => r.host === "breinhap.com"), "the browser only ever asked for the public Host");
	} finally {
		await chrome?.close();
		await new Promise((resolve) => (front ? front.server.close(resolve) : resolve()));
		await rm(dir, { recursive: true, force: true });
	}
});

test("browser, JavaScript off: the shared-computer choice gives a cookie that ends with the browser, and an adult is pointed to management", async () => {
	const dir = await mkdtemp(join(tmpdir(), "breinhap-student-shared-"));
	const w = await world();
	let chrome;
	let front;
	try {
		front = await https(w, dir);
		chrome = await launch(front.endpoint);
		const context = await chrome.newContext({ ignoreHTTPSErrors: true, locale: "fr-BE", viewport: { width: 390, height: 800 }, javaScriptEnabled: false });
		const page = await context.newPage();
		await page.goto(`${PUBLIC}/p/aanmelden`);
		assert.equal(await page.locator("html").getAttribute("lang"), "fr-BE");
		await page.getByLabel("Votre adresse e-mail").fill("eleve@school.example");
		await page.getByLabel(/Je suis sur un ordinateur partagé/).check();
		await page.getByRole("button", { name: "Envoyez-moi un code" }).click();
		await page.waitForURL(`${PUBLIC}/p/aanmelden/code`);
		await page.getByLabel("Code reçu par e-mail").fill(w.headless.codeFor("eleve@school.example"));
		await page.getByRole("button", { name: "Se connecter" }).click();
		await page.waitForURL(`${PUBLIC}/p/koppelen`);
		const session = (await context.cookies()).find((c) => c.name === STUDENT);
		assert.equal(session.expires, -1, "a session cookie: gone when the browser closes");
		await page.getByRole("button", { name: "Se déconnecter" }).click();
		await page.waitForURL(`${PUBLIC}/p/aanmelden`);

		// an adult: no session, a link to management
		await page.getByLabel("Votre adresse e-mail").fill("juf@example.test");
		await page.getByRole("button", { name: "Envoyez-moi un code" }).click();
		await page.waitForURL(`${PUBLIC}/p/aanmelden/code`);
		await page.getByLabel("Code reçu par e-mail").fill(w.headless.codeFor("juf@example.test"));
		await page.getByRole("button", { name: "Se connecter" }).click();
		await page.getByRole("heading", { level: 1, name: "Cette page est pour les élèves" }).waitFor();
		assert.equal(await page.getByRole("link", { name: "Aller à la gestion Breinhap" }).getAttribute("href"), "https://management.breinhap.com/login");
		assert.ok(!(await context.cookies()).some((c) => c.name === STUDENT));
	} finally {
		await chrome?.close();
		await new Promise((resolve) => (front ? front.server.close(resolve) : resolve()));
		await rm(dir, { recursive: true, force: true });
	}
});
