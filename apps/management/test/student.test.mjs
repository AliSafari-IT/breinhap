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
import { AssignmentStore } from "../src/assignments.mjs";
import { ContentStore } from "../src/content.mjs";
import { Directory } from "../src/directory.mjs";
import { createIdentity, ORIGIN } from "../src/identity.mjs";
import { LearnerAccounts } from "../src/learner-accounts.mjs";
import { createManagementServer } from "../src/server.mjs";
import { PublishingStore } from "../src/publishing.mjs";
import { ProgressStore } from "../src/progress.mjs";
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
async function world({ adultGrants = [], wrapProgress = (store) => store } = {}) {
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
	// breinhap#136: the same assignment boundary the server builds, to prepare homework in tests
	const assignments = new AssignmentStore({ directory, membership: (sub) => store.membership(sub) });
	const content = new ContentStore({ directory });
	const publishing = new PublishingStore({ content });
	// breinhap#36: the saved progress, wrappable so a test can make a write fail
	const progress = wrapProgress(new ProgressStore({ directory }));
	const server = createManagementServer({ identity, directory, learnerAccounts, progress });
	servers.push(server);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const learner = async (displayName = "Lina") => directory.createLearner(adminPrincipal, { displayName, schoolYear: 3 });
	const linkCode = async (learnerId) => (await learnerAccounts.createCode(adminPrincipal, learnerId)).code;
	let n = 0;
	const adult = (role = "teacher") => ({ sub: `test:${role}-${++n}`, role: `breinhap.${role}` });
	const sources = [{ kind: "own", title: "Eigen werk" }];
	/** A published, independently approved object with one mission (a card, a choice, an order). */
	const publication = async () => {
		const author = adult("teacher");
		const reviewer = adult("parent");
		const publisher = adult("teacher");
		await directory.grantCapability(adminPrincipal, reviewer, "content.review");
		await directory.grantCapability(adminPrincipal, publisher, "content.publish");
		const draft = {
			schemaVersion: 1,
			id: `lo-${++n}`,
			subject: "biologie",
			title: "Prikkel en reactie",
			grade: 3,
			curriculum: { leerdoel: "De leerlingen leggen prikkel en reactie uit." },
			review: { status: "draft" },
			missions: [
				{
					id: `m-${n}`,
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
		await content.create(author, draft, sources);
		await content.snapshot(author, draft.id, 1);
		await content.submit(author, draft.id, 1);
		await content.review(reviewer, draft.id, 1, "approved");
		const published = await publishing.publish(publisher, draft.id, 1);
		return { ...published, objectId: draft.id, publisher };
	};
	return { clock, store, headless, identity, directory, learnerAccounts, assignments, publishing, publication, progress, server, port: server.address().port, learner, linkCode };
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

// ── breinhap#136: the assigned homework ─────────────────────────────────────────────────────────

const iso = (ms) => new Date(ms).toISOString();

/** The hidden fields of the player's form on this screen, ready to post as the next step. */
const nextForm = (html) => {
	const grab = (name) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
	return { csrf: grab("csrf"), missie: grab("missie"), stap: grab("stap"), a: grab("a") };
};

/** A linked adult with a student account: signs in on the public Host, gets a membership and a link. */
async function linkedAdult(w, email, { role = "breinhap.parent", target } = {}) {
	const b = browser(w);
	await b.signIn(email);
	const sub = w.headless.subOf(email);
	await member(w.store, sub, role);
	const principal = { sub, role };
	const link = await w.directory.link(adminPrincipal, principal, target);
	return { b, principal, link };
}

test("a student sees the assigned homework on /p/mijn and plays a mission through", async () => {
	const w = await world();
	const learnerId = await w.learner("Lina");
	const publication = await w.publication();
	const { principal } = await linkedAdult(w, "papa@school.example", { target: { learnerId } });
	const assignment = await w.assignments.assign(principal, {
		publicationId: publication.id,
		audienceKind: "learner",
		audienceId: learnerId,
		availableUntil: iso(w.clock.time + 7 * DAY),
	});

	const b = browser(w);
	await b.signIn("lina@school.example");
	await b.post("/p/koppelen", { csrf: b.csrf((await b.get("/p/koppelen")).body), code: await w.linkCode(learnerId) });
	const mine = await b.get("/p/mijn");
	assert.equal(mine.status, 200);
	assert.match(mine.body, /Prikkel en reactie/);
	assert.match(mine.body, /Biologie · Jaar 3/);
	assert.match(mine.body, /1 missie\(s\), samen ongeveer 3 minuten/);
	assert.match(mine.body, /Tot en met /);
	const id = /\/p\/mijn\/([0-9a-f-]{36})/.exec(mine.body)?.[1];
	assert.equal(id, assignment.id, "the list links the assignment by its own id");

	// what it is about: the goal, the adult's role (never a name), one Start per mission
	const detail = await b.get(`/p/mijn/${id}`);
	assert.equal(detail.status, 200);
	assert.match(detail.body, /<h1>Prikkel en reactie<\/h1>/);
	assert.match(detail.body, /De leerlingen leggen prikkel en reactie uit\./);
	assert.match(detail.body, /Van je ouder/);
	assert.match(detail.body, /Wat is een prikkel\?/);
	assert.match(detail.body, /2 vragen, ongeveer 3 minuten/);
	assert.doesNotMatch(detail.body, /papa|Papa/);
	const token = b.csrf(detail.body);

	// the existing player, one card or question per screen: Opwarmen → Leren → Doen → Check
	const warm = await b.post(`/p/mijn/${id}`, { csrf: token, missie: "0", stap: "0", a: "" });
	assert.equal(warm.status, 200);
	assert.match(warm.body, /aria-current="step">Opwarmen<\//);
	assert.match(warm.body, /Denk aan iets dat je laat schrikken\./);
	const learn = await b.post(`/p/mijn/${id}`, nextForm(warm.body));
	assert.match(learn.body, /aria-current="step">Leren<\//);
	const asked = await b.post(`/p/mijn/${id}`, nextForm(learn.body));
	assert.match(asked.body, /aria-current="step">Doen<\//);
	assert.match(asked.body, /name="kies"/);
	const done = await b.post(`/p/mijn/${id}`, { ...nextForm(asked.body), kies: "0" });
	assert.match(done.body, /Klopt\./);
	assert.match(done.body, /Een prikkel is een verandering in de omgeving\./);
	const checked = await b.post(`/p/mijn/${id}`, nextForm(done.body));
	assert.match(checked.body, /aria-current="step">Check<\//);
	assert.match(checked.body, /name="plaats0"/);
	const finished = await b.post(`/p/mijn/${id}`, { ...nextForm(checked.body), plaats0: "0", plaats1: "1", plaats2: "2" });
	assert.match(finished.body, /Klopt\./);
	const wrapped = await b.post(`/p/mijn/${id}`, nextForm(finished.body));
	assert.match(wrapped.body, /Missie klaar/);
	assert.match(wrapped.body, /Je had 2 van de 2 vragen juist\./);

	// the run lives only in the posted form: the same GET still shows the assignment page
	assert.match((await b.get(`/p/mijn/${id}`)).body, /<h1>Prikkel en reactie<\/h1>/);
	// and the student's own list is the only way back
	assert.match(wrapped.body, /href="\/p\/mijn">Terug naar mijn opdrachten<\/a>/);
});

test("the list sorts closing soonest first, and an assignment without a date comes last", async () => {
	const w = await world();
	const learnerId = await w.learner("Lina");
	const first = await w.publication();
	const second = await w.publication();
	const { principal } = await linkedAdult(w, "papa@school.example", { target: { learnerId } });
	const soon = await w.assignments.assign(principal, {
		publicationId: first.id,
		audienceKind: "learner",
		audienceId: learnerId,
		availableUntil: iso(w.clock.time + 2 * DAY),
	});
	const later = await w.assignments.assign(principal, {
		publicationId: second.id,
		audienceKind: "learner",
		audienceId: learnerId,
	});

	const b = browser(w);
	await b.signIn("lina@school.example");
	await b.post("/p/koppelen", { csrf: b.csrf((await b.get("/p/koppelen")).body), code: await w.linkCode(learnerId) });
	const mine = await b.get("/p/mijn");
	const order = [...mine.body.matchAll(/\/p\/mijn\/([0-9a-f-]{36})/g)].map((m) => m[1]);
	assert.deepEqual(order, [soon.id, later.id], "the dated one first, the undated one last");
});

test("honest states: nothing assigned yet, and one calm page for every id the learner cannot see", async () => {
	const w = await world();
	const learnerId = await w.learner("Lina");
	const publication = await w.publication();
	const { principal } = await linkedAdult(w, "papa@school.example", { target: { learnerId } });
	const b = browser(w);
	await b.signIn("lina@school.example");
	await b.post("/p/koppelen", { csrf: b.csrf((await b.get("/p/koppelen")).body), code: await w.linkCode(learnerId) });
	const goneTitle = /Deze opdracht is niet meer beschikbaar/;
	const foreign = "/p/mijn/00000000-0000-1000-8000-000000000000";

	// nothing assigned yet
	assert.match((await b.get("/p/mijn")).body, /Er staat nog geen opdracht voor je klaar\./);
	const unknown = await b.get(foreign);
	assert.equal(unknown.status, 404, "a made-up id is not found");
	assert.match(unknown.body, goneTitle);
	assert.match(unknown.body, /href="\/p\/mijn"/);
	assert.doesNotMatch(unknown.body, /Er ging iets mis|Deze link werkt niet/);

	// a not-yet-open window is invisible, exactly like nothing assigned
	const future = await w.assignments.assign(principal, {
		publicationId: publication.id,
		audienceKind: "learner",
		audienceId: learnerId,
		notBefore: iso(Date.now() + DAY),
	});
	assert.doesNotMatch((await b.get("/p/mijn")).body, /Prikkel en reactie/);
	const held = await b.get(`/p/mijn/${future.id}`);
	assert.equal(held.status, 404);
	assert.match(held.body, goneTitle);

	// the same publication once the window opens
	await w.assignments.update(principal, future.id, 1, { notBefore: null });
	const open = await b.get(`/p/mijn/${future.id}`);
	assert.equal(open.status, 200);
	assert.match((await b.get("/p/mijn")).body, /Prikkel en reactie/);

	// a revoked assignment closes it: the same calm page as every other missing id
	await w.assignments.revoke(principal, future.id);
	const closed = await b.get(`/p/mijn/${future.id}`);
	assert.equal(closed.status, 404, "revoked is the same calm page");
	assert.match(closed.body, goneTitle);
	assert.doesNotMatch((await b.get("/p/mijn")).body, /Prikkel en reactie/);

	// an expiring window: visible now, gone a moment later, same page as every other missing id
	const expiring = await w.assignments.assign(principal, {
		publicationId: publication.id,
		audienceKind: "learner",
		audienceId: learnerId,
		availableUntil: iso(Date.now() + 1500),
	});
	assert.equal((await b.get(`/p/mijn/${expiring.id}`)).status, 200);
	await new Promise((resolve) => setTimeout(resolve, 1700));
	assert.doesNotMatch((await b.get("/p/mijn")).body, /Prikkel en reactie/);
	const after = await b.get(`/p/mijn/${expiring.id}`);
	assert.equal(after.status, 404);
	assert.equal(after.body, unknown.body, "a closed window, a revoked assignment and a wrong id answer alike");

	// the publication itself is withdrawn: the still-assigned homework becomes not available
	const pulled = await w.publication();
	const pulledAssignment = await w.assignments.assign(principal, {
		publicationId: pulled.id,
		audienceKind: "learner",
		audienceId: learnerId,
	});
	await w.publishing.withdraw(pulled.publisher, pulled.objectId);
	const gone = await b.get(`/p/mijn/${pulledAssignment.id}`);
	assert.equal(gone.status, 404);
	assert.match(gone.body, goneTitle);
	assert.doesNotMatch((await b.get("/p/mijn")).body, /Prikkel en reactie/);

	// a visitor without a session sees nothing at all
	const anon = await browser(w).get(`/p/mijn/${pulledAssignment.id}`);
	assert.equal(anon.status, 303);
	assert.equal(anon.location, "/p/aanmelden");
});

test("a group assignment follows the group, and no name — adult, group or learner — ever appears", async () => {
	const w = await world();
	const learnerId = await w.learner("Lina");
	const group = await w.directory.createGroup(adminPrincipal, { name: "Klas 3A" });
	await w.directory.addToGroup(adminPrincipal, { groupId: group, learnerId });
	const publication = await w.publication();
	const { principal, link } = await linkedAdult(w, "juf@school.example", {
		role: "breinhap.teacher",
		target: { groupId: group },
	});
	const assignment = await w.assignments.assign(principal, { publicationId: publication.id, audienceKind: "group", audienceId: group });

	const b = browser(w);
	await b.signIn("lina@school.example");
	await b.post("/p/koppelen", { csrf: b.csrf((await b.get("/p/koppelen")).body), code: await w.linkCode(learnerId) });
	const mine = await b.get("/p/mijn");
	assert.match(mine.body, /Prikkel en reactie/);
	assert.doesNotMatch(mine.body, /Klas 3A|Bram|Lina|juf|Juf/);
	const id = /\/p\/mijn\/([0-9a-f-]{36})/.exec(mine.body)?.[1];
	assert.equal(id, assignment.id);
	const detail = await b.get(`/p/mijn/${id}`);
	assert.match(detail.body, /Van je leerkracht/);
	assert.doesNotMatch(detail.body, /Klas 3A|test:|sub-|@school\.example/);

	// a learner outside the group gets the same calm page as everyone else
	const other = browser(w);
	assert.equal((await other.signIn("bram@school.example")).location, "/p/koppelen");
	assert.equal((await other.get(`/p/mijn/${id}`)).location, "/p/koppelen");

	// the teacher's link to the group is revoked: the homework stops without an error page
	await w.directory.unlink(adminPrincipal, link);
	const ended = await b.get(`/p/mijn/${id}`);
	assert.equal(ended.status, 404);
	assert.match(ended.body, /Deze opdracht is niet meer beschikbaar/);
	assert.match((await b.get("/p/mijn")).body, /Er staat nog geen opdracht voor je klaar\./);
});

test("the assignment steps need the session's CSRF token and the exact Origin", async () => {
	const w = await world();
	const learnerId = await w.learner("Lina");
	const publication = await w.publication();
	const { principal } = await linkedAdult(w, "papa@school.example", { target: { learnerId } });
	const assignment = await w.assignments.assign(principal, {
		publicationId: publication.id,
		audienceKind: "learner",
		audienceId: learnerId,
	});
	const b = browser(w);
	await b.signIn("lina@school.example");
	await b.post("/p/koppelen", { csrf: b.csrf((await b.get("/p/koppelen")).body), code: await w.linkCode(learnerId) });
	const detail = await b.get(`/p/mijn/${assignment.id}`);
	assert.equal(detail.status, 200);
	const token = b.csrf(detail.body);
	const path = `/p/mijn/${assignment.id}`;
	const step = { csrf: token, missie: "0", stap: "0", a: "" };

	for (const origin of ["https://management.breinhap.com", "https://evil.example", "null", ""]) {
		const res = await b.post(path, step, { origin });
		assert.equal(res.status, 403, `Origin ${origin || "(none)"}`);
	}
	assert.equal((await b.post(path, { ...step, csrf: "x".repeat(43) })).status, 403, "another session's token does not fit");
	assert.equal((await b.post(path, { missie: "0", stap: "0", a: "" })).status, 403, "no token, no step");
	assert.equal((await b.request("DELETE", path)).status, 405, "only GET, HEAD and POST");
	// a query string is dropped, never echoed
	const stripped = await b.get(`${path}?missie=1&stap=9`);
	assert.equal(stripped.status, 303);
	assert.equal(stripped.location, path);
	// the form is bounded and duplicate-free like every other POST here
	assert.equal((await b.request("POST", path, { body: `csrf=${token}&csrf=${token}&missie=0` })).status, 400);
	// and with the right token the step runs
	assert.equal((await b.post(path, step)).status, 200);
});

test("the assignment pages speak nl, fr, en and de", async () => {
	const w = await world();
	const publication = await w.publication();
	const { principal } = await linkedAdult(w, "papa@school.example", { target: { learnerId: await w.learner("Eerste") } });
	const expected = {
		nl: ["nl-BE", "Mijn opdrachten", "Van je ouder", "Tot en met", "Deze opdracht is niet meer beschikbaar"],
		fr: ["fr-BE", "Mes devoirs", "De votre parent", "Jusqu’au", "Ce devoir n’est plus disponible"],
		en: ["en", "My assignments", "From your parent", "Until", "This assignment is no longer available"],
		de: ["de-BE", "Meine Aufgaben", "Von deinem Elternteil", "Bis", "Diese Aufgabe ist nicht mehr verfügbar"],
	};
	for (const [lang, [htmlLang, mineTitle, from, due, goneTitle]] of Object.entries(expected)) {
		const learnerId = await w.learner(`Leerling ${lang}`);
		await w.directory.link(adminPrincipal, principal, { learnerId });
		await w.assignments.assign(principal, {
			publicationId: publication.id,
			audienceKind: "learner",
			audienceId: learnerId,
			availableUntil: iso(Date.now() + DAY),
		});
		const b = browser(w, { lang: `${lang}-BE,${lang};q=0.9` });
		await b.signIn(`${lang}@school.example`);
		await b.post("/p/koppelen", { csrf: b.csrf((await b.get("/p/koppelen")).body), code: await w.linkCode(learnerId) });
		const mine = await b.get("/p/mijn");
		assert.match(mine.body, new RegExp(`<html lang="${htmlLang}">`), lang);
		assert.ok(mine.body.includes(`<h1>${mineTitle}</h1>`), lang);
		assert.ok(mine.body.includes(due), `${lang}: the due date line`);
		const id = /\/p\/mijn\/([0-9a-f-]{36})/.exec(mine.body)?.[1];
		const detail = await b.get(`/p/mijn/${id}`);
		assert.ok(detail.body.includes("<h1>Prikkel en reactie</h1>"), lang);
		assert.ok(detail.body.includes(from), `${lang}: the adult's role, never a name`);
		const gone = await b.get("/p/mijn/00000000-0000-1000-8000-000000000000");
		assert.ok(gone.body.includes(goneTitle), `${lang}: the honest not-available page`);
		assert.ok(!gone.body.includes("00000000-0000-1000-8000-000000000000"), `${lang}: the id is not echoed`);
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

// ---------------------------------------------------------------------------------------------
// breinhap#36: saved progress on the server, pause and resume, two tabs, failed writes, a changed
// publication, account switching, the student's own data page and retention.

/** The hidden fields of the form on this page that posts `doe` (or the first step form). */
const formFor = (html, doe) => {
	for (const part of html.split("<form").slice(1)) {
		const fields = Object.fromEntries([...part.split("</form>")[0].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]));
		if (fields.doe === doe) return fields;
	}
	return undefined;
};
const progressRows = async (learnerId) =>
	(await pool.query("SELECT mission_id, page, answers, state, finished_at, version, publication_hash FROM assignment_progress WHERE learner_id = $1 ORDER BY assignment_id", [learnerId])).rows;

/** A student with one assignment from a linked parent, signed in and linked: ready on /p/mijn. */
async function assignedStudent(w, { email = "lina@school.example", name = "Lina" } = {}) {
	const learnerId = await w.learner(name);
	const publication = await w.publication();
	const { principal } = await linkedAdult(w, `ouder-${randomBytes(3).toString("hex")}@school.example`, { target: { learnerId } });
	const assignment = await w.assignments.assign(principal, { publicationId: publication.id, audienceKind: "learner", audienceId: learnerId, availableUntil: iso(Date.now() + 7 * DAY) });
	const b = browser(w);
	await b.signIn(email);
	await b.post("/p/koppelen", { csrf: b.csrf((await b.get("/p/koppelen")).body), code: await w.linkCode(learnerId) });
	return { learnerId, publication, principal, assignment, b, path: `/p/mijn/${assignment.id}` };
}

test("progress: pause, then resume on another device at the same page with the same answers, and Klaar on /p/mijn", async () => {
	const w = await world();
	const { learnerId, b, path } = await assignedStudent(w);
	assert.match((await b.get("/p/mijn")).body, /class="badge">Nieuw</);
	const detail = await b.get(path);
	const start = formFor(detail.body, "start");
	assert.ok(start, "Start is a saved start");

	const warm = await b.post(path, start);
	assert.equal(warm.status, 200);
	assert.match(warm.body, /aria-current="step">Opwarmen<\//);
	assert.doesNotMatch(warm.body, /name="a"/, "the answers do not travel in the form");
	assert.match(warm.body, />Pauzeren<\/button>/);
	assert.deepEqual((await progressRows(learnerId)).map((r) => [r.page, r.answers, r.state]), [[0, "", "started"]]);
	const learn = await b.post(path, formFor(warm.body, "stap"));
	const asked = await b.post(path, formFor(learn.body, "stap"));
	assert.match(asked.body, /name="kies"/);
	const answered = await b.post(path, { ...formFor(asked.body, "stap"), kies: "0" });
	assert.match(answered.body, /Klopt\./);
	assert.deepEqual((await progressRows(learnerId)).map((r) => [r.page, r.answers]), [[2, "2c0"]]);

	// an explicit pause confirms that the answers are on the server
	const paused = await b.post(path, formFor(answered.body, "pauze"));
	assert.equal(paused.status, 200);
	assert.match(paused.body, /<h1>Gepauzeerd<\/h1>/);
	assert.match(paused.body, /Je antwoorden zijn bewaard\. Je kunt later verder, ook op een ander toestel\./);
	assert.match((await b.get("/p/mijn")).body, /class="badge">Bezig</);

	// another device: the same account, a new session, nothing in its browser
	const phone = browser(w);
	await phone.signIn("lina@school.example");
	const there = await phone.get(path);
	assert.match(there.body, /Bezig · stap 3 van 4/);
	const resumed = await phone.post(path, formFor(there.body, "verder"));
	assert.match(resumed.body, /Klopt\./, "the answer given on the first device is there");
	assert.match(resumed.body, /class="chosen">Een verandering/);
	const check = await phone.post(path, formFor(resumed.body, "stap"));
	assert.match(check.body, /aria-current="step">Check<\//);
	const placed = await phone.post(path, { ...formFor(check.body, "stap"), plaats0: "0", plaats1: "1", plaats2: "2" });
	assert.match(placed.body, /Klopt\./);
	const done = await phone.post(path, formFor(placed.body, "stap"));
	assert.match(done.body, /Missie klaar/);
	assert.match(done.body, /Je had 2 van de 2 vragen juist\./, "the score comes from the stored answers");
	const [row] = await progressRows(learnerId);
	assert.equal(row.state, "finished");
	assert.equal(row.page, 4);
	assert.equal(row.answers, "2c0;3o0.1.2");
	assert.ok(row.finished_at);

	// back on the first device: Klaar, and a reload shows the same score
	assert.match((await b.get("/p/mijn")).body, /class="badge">Klaar ✓</);
	const after = await b.get(path);
	assert.match(after.body, /Klaar ✓ op /);
	const again = await b.post(path, { ...formFor(after.body, undefined), csrf: b.csrf(after.body) });
	assert.equal(again.status, 200);
	// "Nog eens" is an unsaved replay: the finished state and its date stay
	const restarted = await b.post(path, { csrf: b.csrf(after.body), missie: "0", doe: "start" });
	assert.match(restarted.body, /aria-current="step">Opwarmen<\//);
	assert.deepEqual((await progressRows(learnerId)).map((r) => [r.state, r.page, r.version]), [["finished", 4, row.version]]);
});

test("progress: two tabs cannot overwrite each other; the older one says so and continues from the stored page", async () => {
	const w = await world();
	const { learnerId, b, path } = await assignedStudent(w);
	const first = await b.post(path, formFor((await b.get(path)).body, "start"));
	const second = await b.post(path, formFor((await b.get(path)).body, "verder"));
	assert.equal(formFor(first.body, "stap").versie, formFor(second.body, "stap").versie);

	assert.equal((await b.post(path, formFor(first.body, "stap"))).status, 200);
	const late = await b.post(path, formFor(second.body, "stap"));
	assert.equal(late.status, 409);
	assert.match(late.body, /Je ging ergens anders verder/);
	assert.match(late.body, /Er is niets overschreven\./);
	assert.equal((await progressRows(learnerId))[0].page, 1, "the older tab wrote nothing");
	const pausedLate = await b.post(path, formFor(second.body, "pauze"));
	assert.equal(pausedLate.status, 409, "a pause from an old page does not pretend to be saved");
	const on = await b.post(path, formFor(late.body, "verder"));
	assert.match(on.body, /aria-current="step">Leren<\//);

	// a restart from the second tab is explicit: the first tab's next step is then stale, not mixed in
	const restarted = await b.post(path, { csrf: formFor(on.body, "stap").csrf, missie: "0", doe: "start" });
	assert.match(restarted.body, /aria-current="step">Opwarmen<\//);
	assert.equal((await b.post(path, formFor(on.body, "stap"))).status, 409);
});

test("progress: a failed write is visible and the same step can be sent again", async () => {
	let failSave = 0;
	let failBegin = 0;
	const w = await world({
		wrapProgress: (store) => {
			const save = store.save.bind(store);
			const begin = store.begin.bind(store);
			store.save = async (...args) => {
				if (failSave-- > 0) throw new Error("database down");
				return save(...args);
			};
			store.begin = async (...args) => {
				if (failBegin-- > 0) throw new Error("database down");
				return begin(...args);
			};
			return store;
		},
	});
	const { learnerId, b, path } = await assignedStudent(w);
	failBegin = 1;
	const notStarted = await b.post(path, formFor((await b.get(path)).body, "start"));
	assert.equal(notStarted.status, 503);
	assert.match(notStarted.body, /<h1>Nog niet bewaard<\/h1>/);
	assert.deepEqual(await progressRows(learnerId), []);
	const warm = await b.post(path, formFor(notStarted.body, "start"));
	assert.equal(warm.status, 200, "the retry form sends the same start again");
	const learn = await b.post(path, formFor(warm.body, "stap"));
	const asked = await b.post(path, formFor(learn.body, "stap"));

	failSave = 1;
	const failed = await b.post(path, { ...formFor(asked.body, "stap"), kies: "0" });
	assert.equal(failed.status, 503);
	assert.match(failed.body, /Je laatste stap kon niet bewaard worden\./);
	assert.match(failed.body, /role="alert"/);
	assert.equal((await progressRows(learnerId))[0].answers, "", "nothing half-written");
	const retry = formFor(failed.body, "stap");
	assert.equal(retry.kies, "0", "the retry carries the same answer");
	const saved = await b.post(path, retry);
	assert.equal(saved.status, 200);
	assert.match(saved.body, /Klopt\./);
	assert.equal((await progressRows(learnerId))[0].answers, "2c0");
});

test("progress: progress made on another publication, or a row that no longer fits, is never continued", async () => {
	const w = await world();
	const { learnerId, b, path, publication } = await assignedStudent(w);
	const warm = await b.post(path, formFor((await b.get(path)).body, "start"));
	await b.post(path, formFor(warm.body, "stap"));
	await pool.query("UPDATE assignment_progress SET publication_hash = $2, version = version + 1 WHERE learner_id = $1", [learnerId, "A".repeat(43)]);

	const detail = await b.get(path);
	assert.match(detail.body, /Deze missie werd aangepast\./);
	assert.equal(formFor(detail.body, "verder"), undefined, "no Verder on another publication's progress");
	const resumed = await b.post(path, { csrf: b.csrf(detail.body), missie: "0", doe: "verder" });
	assert.equal(resumed.status, 409);
	assert.match(resumed.body, /<h1>Deze missie werd aangepast<\/h1>/);
	assert.match((await b.get("/p/mijn")).body, /class="badge">Nieuw</, "it does not count for the current publication");
	const fresh = await b.post(path, formFor(detail.body, "start"));
	assert.match(fresh.body, /aria-current="step">Opwarmen<\//);
	const [row] = await progressRows(learnerId);
	assert.deepEqual([row.page, row.answers, row.state], [0, "", "started"]);
	assert.notEqual(row.publication_hash, "A".repeat(43));

	// answers that do not fit the mission (corrupt or from an older layout) are not silently dropped into it
	await pool.query("UPDATE assignment_progress SET answers = '9c1', page = 1, version = version + 1 WHERE learner_id = $1", [learnerId]);
	assert.equal((await b.post(path, { csrf: b.csrf(detail.body), missie: "0", doe: "verder" })).status, 409);

	// a withdrawn publication: the assignment is not available; the row waits for retention
	await w.publishing.withdraw(publication.publisher, publication.objectId);
	assert.equal((await b.get(path)).status, 404);
	assert.equal((await progressRows(learnerId)).length, 1);
});

test("progress: signing out and switching accounts keeps each student's progress their own", async () => {
	const w = await world();
	const lina = await assignedStudent(w);
	const warm = await lina.b.post(lina.path, formFor((await lina.b.get(lina.path)).body, "start"));
	await lina.b.post(lina.path, formFor(warm.body, "stap"));
	await lina.b.post("/p/afmelden", { csrf: lina.b.csrf((await lina.b.get("/p/mijn")).body) });

	// the same browser, another student
	const tom = await w.learner("Tom");
	await lina.b.signIn("tom@school.example");
	await lina.b.post("/p/koppelen", { csrf: lina.b.csrf((await lina.b.get("/p/koppelen")).body), code: await w.linkCode(tom) });
	assert.equal((await lina.b.get(lina.path)).status, 404, "Lina's assignment is not Tom's");
	const tamper = await lina.b.post(lina.path, { csrf: lina.b.csrf((await lina.b.get("/p/mijn")).body), missie: "0", doe: "verder" });
	assert.equal(tamper.status, 404);
	assert.match((await lina.b.get("/p/mijn/gegevens")).body, /Er is geen voortgang bewaard\./);
	await lina.b.post("/p/afmelden", { csrf: lina.b.csrf((await lina.b.get("/p/mijn")).body) });

	await lina.b.signIn("lina@school.example");
	assert.match((await lina.b.get(lina.path)).body, /Bezig · stap 2 van 4/);
});

test("progress: the student's own data page shows what is stored, downloads it, clears one or all, and ends the link", async () => {
	const w = await world();
	const { learnerId, principal, b, path } = await assignedStudent(w);
	const second = await w.publication();
	const other = await w.assignments.assign(principal, { publicationId: second.id, audienceKind: "learner", audienceId: learnerId });
	const otherPath = `/p/mijn/${other.id}`;
	const warm = await b.post(path, formFor((await b.get(path)).body, "start"));
	const learn = await b.post(path, formFor(warm.body, "stap"));
	const asked = await b.post(path, formFor(learn.body, "stap"));
	await b.post(path, { ...formFor(asked.body, "stap"), kies: "1" });
	await b.post(otherPath, formFor((await b.get(otherPath)).body, "start"));

	const mine = await b.get("/p/mijn");
	assert.match(mine.body, /href="\/p\/mijn\/gegevens">Mijn gegevens<\/a>/);
	const page = await b.get("/p/mijn/gegevens");
	assert.equal(page.status, 200);
	assert.match(page.body, /<h1>Mijn gegevens<\/h1>/);
	assert.match(page.body, /Je e-mailadres bewaart ASafariM, niet Breinhap/);
	assert.match(page.body, /Sinds .* is je account gekoppeld/);
	assert.match(page.body, /Wat is een prikkel\?: Bezig · 1 antwoord\(en\) · begonnen op /);
	assert.match(page.body, /90 dagen nadat een opdracht afloopt of wordt ingetrokken/);
	assert.match(page.body, /ziet je antwoorden en je score niet/);
	assert.match(page.body, /href="https:\/\/breinhap\.asafarim\.site\/account-verwijderen\/"/);
	assert.doesNotMatch(page.body, /lina@school\.example|Lina|ouder-/, "no e-mail address, profile name or adult");
	assert.doesNotMatch(page.body, /<script|style=|<style/);

	const download = await b.get("/p/mijn/gegevens/download");
	assert.equal(download.status, 200);
	assert.match(download.headers["content-type"], /^application\/json/);
	assert.match(download.headers["content-disposition"], /attachment/);
	const data = JSON.parse(download.body);
	assert.equal(data.progress.length, 2);
	assert.deepEqual(data.progress.find((p) => p.assignmentId === (path.split("/").pop())).answers, "2c1");
	assert.doesNotMatch(download.body, /lina@school\.example|"sub"|Lina/);

	// clearing needs the session's token
	assert.equal((await b.post("/p/mijn/gegevens/wissen", { opdracht: other.id })).status, 403);
	assert.equal((await b.post("/p/mijn/gegevens/wissen", { csrf: b.csrf(page.body), opdracht: other.id })).location, "/p/mijn/gegevens");
	assert.equal((await progressRows(learnerId)).length, 1);
	assert.match((await b.get(otherPath)).body, /value="start"/, "that assignment starts fresh");
	const notSure = await b.post("/p/mijn/gegevens/wissen", { csrf: b.csrf(page.body) });
	assert.equal(notSure.status, 400);
	assert.match(notSure.body, /Vink eerst aan dat je het begrijpt\./);
	assert.equal((await progressRows(learnerId)).length, 1);
	await b.post("/p/mijn/gegevens/wissen", { csrf: b.csrf(page.body), zeker: "1" });
	assert.deepEqual(await progressRows(learnerId), []);
	assert.match((await b.get("/p/mijn/gegevens")).body, /Er is geen voortgang bewaard\./);

	// ending the link deletes the progress at once and goes back to the link-code step
	await b.post(path, formFor((await b.get(path)).body, "start"));
	assert.equal((await b.post("/p/mijn/gegevens/ontkoppelen", { csrf: b.csrf(page.body) })).status, 400);
	const unlinked = await b.post("/p/mijn/gegevens/ontkoppelen", { csrf: b.csrf(page.body), zeker: "1" });
	assert.equal(unlinked.location, "/p/koppelen");
	assert.deepEqual(await progressRows(learnerId), []);
	assert.equal((await b.get("/p/mijn")).location, "/p/koppelen");
	assert.equal((await b.get("/p/mijn/gegevens")).location, "/p/koppelen");
	const { rows } = await pool.query("SELECT unlinked_at FROM learner_accounts WHERE learner_id = $1", [learnerId]);
	assert.ok(rows[0].unlinked_at, "the history row stays, marked unlinked");
	// the same learner can be linked again with a new code
	await b.post("/p/koppelen", { csrf: b.csrf((await b.get("/p/koppelen")).body), code: await w.linkCode(learnerId) });
	assert.equal((await b.get("/p/mijn")).status, 200);
});

test("progress retention: 90 days after revocation or the window's end; at once on archive and on an administrator's unlink", async () => {
	const w = await world();
	const lina = await assignedStudent(w);
	await lina.b.post(lina.path, formFor((await lina.b.get(lina.path)).body, "start"));
	await w.assignments.revoke(lina.principal, lina.assignment.id);
	const at = (days) => new ProgressStore({ directory: w.directory, clock: () => Date.now() + days * DAY });
	assert.deepEqual(await at(89).retain(), { progress: 0 });
	assert.equal((await progressRows(lina.learnerId)).length, 1);
	assert.deepEqual(await at(91).retain(), { progress: 1 });
	assert.deepEqual(await progressRows(lina.learnerId), []);

	// a closed window counts from its end
	const tom = await assignedStudent(w, { email: "tom@school.example", name: "Tom" });
	await tom.b.post(tom.path, formFor((await tom.b.get(tom.path)).body, "start"));
	assert.deepEqual(await at(7 + 89).retain(), { progress: 0 });
	assert.deepEqual(await at(7 + 91).retain(), { progress: 1 });

	// an administrator's unlink and archiving the profile delete at once
	const ana = await assignedStudent(w, { email: "ana@school.example", name: "Ana" });
	await ana.b.post(ana.path, formFor((await ana.b.get(ana.path)).body, "start"));
	await w.learnerAccounts.unlink(adminPrincipal, ana.learnerId);
	assert.deepEqual(await progressRows(ana.learnerId), []);
	const bo = await assignedStudent(w, { email: "bo@school.example", name: "Bo" });
	await bo.b.post(bo.path, formFor((await bo.b.get(bo.path)).body, "start"));
	await w.directory.archiveLearner(adminPrincipal, bo.learnerId);
	assert.deepEqual(await progressRows(bo.learnerId), []);
});

test("progress: no adult-facing code reads the stored answers", async () => {
	// only the progress store reads the table; everything else may only delete from it
	const sources = execFileSync("grep", ["-rln", "assignment_progress", new URL("../src", import.meta.url).pathname], { encoding: "utf8" })
		.trim()
		.split("\n")
		.filter((f) => !f.endsWith(".sql"));
	for (const file of sources) {
		if (file.endsWith("/progress.mjs")) continue;
		const text = await readFile(file, "utf8");
		for (const line of text.split("\n").filter((l) => l.includes("assignment_progress")))
			assert.match(line, /DELETE FROM assignment_progress/, `${file}: ${line.trim()}`);
	}
	const users = execFileSync("grep", ["-rlE", "progress\\.(forAssignment|forLearner|begin|save)\\(", new URL("../src", import.meta.url).pathname], { encoding: "utf8" }).trim().split("\n");
	assert.deepEqual(users.map((f) => f.split("/src/")[1]), ["learner/student.mjs"]);
});

test("progress pages speak nl, fr, en and de", async () => {
	const w = await world();
	const expected = {
		nl: ["Gepauzeerd", "Mijn gegevens", "Bezig"],
		fr: ["En pause", "Mes données", "En cours"],
		en: ["Paused", "My data", "In progress"],
		de: ["Pausiert", "Meine Daten", "Begonnen"],
	};
	for (const [lang, [paused, data, busy]] of Object.entries(expected)) {
		const s = await assignedStudent(w, { email: `${lang}@school.example`, name: `Leerling ${lang}` });
		const b = browser(w, { lang: `${lang}-BE,${lang};q=0.9` });
		await b.signIn(`${lang}@school.example`);
		const warm = await b.post(s.path, formFor((await b.get(s.path)).body, "start"));
		assert.ok((await b.post(s.path, formFor(warm.body, "pauze"))).body.includes(`<h1>${paused}</h1>`), lang);
		assert.ok((await b.get("/p/mijn/gegevens")).body.includes(`<h1>${data}</h1>`), lang);
		assert.ok((await b.get("/p/mijn")).body.includes(`class="badge">${busy}<`), lang);
	}
});
