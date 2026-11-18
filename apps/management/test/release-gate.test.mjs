// breinhap#37: the release gate for the student (breinhap.com/p) and management (management.breinhap.com)
// applications, against a real Redis and a real Postgres over the real HTTP server. One workspace serves
// both: adults sign in with the OIDC flow (fake provider), students with the e-mailed code (fake
// ASafariM headless). The suite covers
//   1. the permission matrix: the management and student routes (each page, and each kind of form
//      post) × every kind of caller, on both Hosts, plus direct access with other Hosts and targets;
//   2. revoked roles and scoped relationships ending access on the next request;
//   3. the whole life of homework: rejected and clean uploads, a failed and a retried extraction, an
//      import, review, publishing, assigning, a link code, the student's mission, done / not done, and
//      a withdrawn publication;
//   4. backup and restore of the new tables (learner_accounts, learner_link_codes, assignment_progress)
//      with pg_dump / pg_restore, and the restored database serving the same student on a new server;
//   5. a real browser, keyboard only and JavaScript off, at 320, 390 and 1280 px.
// What only operators or the owner can do (DNS, TLS, the live Caddy reload, legal, the pilot) is not
// tested here; the release checklist in the pull request lists it.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import pg from "pg";
import { chromium } from "playwright";

import { migrate } from "../src/db.mjs";
import { AssignmentStore } from "../src/assignments.mjs";
import { ContentStore } from "../src/content.mjs";
import { Directory } from "../src/directory.mjs";
import { ExtractFailed } from "../src/extract/limits.mjs";
import { ExtractionStore } from "../src/extract/store.mjs";
import { createIdentity, ORIGIN } from "../src/identity.mjs";
import { TEMPLATE } from "../src/imports/routes.mjs";
import { LearnerAccounts } from "../src/learner-accounts.mjs";
import { toValues } from "../src/library.mjs";
import { ProgressStore } from "../src/progress.mjs";
import { PublishingStore } from "../src/publishing.mjs";
import { createManagementServer } from "../src/server.mjs";
import { MemoryStorage } from "../src/uploads/s3.mjs";
import { UploadStore } from "../src/uploads/store.mjs";
import { textPdf } from "./extract-fixtures.mjs";
import { makeStore, member } from "./helpers.mjs";
import { multipart, pdf } from "./upload-fixtures.mjs";

const PUBLIC = "https://breinhap.com";
const DAY = 86_400_000;
const adminPrincipal = { sub: "admin", role: "breinhap.admin" };

let admin;
let pool;
const pools = [];
const servers = [];
const databases = [];
const base = `breinhap_gate_${randomBytes(5).toString("hex")}`;
/** A fresh database on the test server; `migrated` runs the migrations, as the server does on start. */
async function database(name, { migrated = true } = {}) {
	await admin.query(`CREATE DATABASE ${name}`);
	databases.push(name);
	const url = new URL(process.env.POSTGRES_TEST_URL);
	url.pathname = `/${name}`;
	const p = new pg.Pool({ connectionString: url.toString(), max: 6 });
	p.on("error", () => {}); // idle connections end when the test database is dropped
	pools.push(p);
	if (migrated) await migrate(p);
	return { pool: p, url: url.toString(), name };
}
before(async () => {
	if (!process.env.POSTGRES_TEST_URL)
		throw new Error("Use pnpm --filter @breinhap/management test, or set POSTGRES_TEST_URL for this suite");
	admin = new pg.Client({ connectionString: process.env.POSTGRES_TEST_URL });
	await admin.connect();
	({ pool } = await database(base));
});
after(async () => {
	await Promise.all(
		servers.map((s) => {
			const closed = new Promise((resolve) => s.close(resolve));
			s.closeAllConnections();
			return closed;
		}),
	);
	await Promise.all(pools.map((p) => p.end()));
	for (const name of databases) await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
	await admin?.end();
});

class FakeScanner {
	async scan() {
		return { result: "clean" };
	}
}

/** ASafariM's headless API as Breinhap sees it: a code per challenge, an account per address. */
function fakeHeadless() {
	const accounts = new Map();
	const codes = new Map();
	const revoked = new Set();
	let sent = 0;
	return {
		revoke: (sub) => revoked.add(sub),
		subOf: (email) => accounts.get(email),
		async startEmail({ email }) {
			const challenge = `challenge-${++sent}-${"x".repeat(12)}`;
			codes.set(challenge, { email, code: String(100000 + sent) });
			return { ok: true, challenge, expiresIn: 300 };
		},
		async verifyEmail({ challenge, email, code }) {
			const c = codes.get(challenge);
			if (!c || c.email !== email) return { ok: false, error: "expired" };
			if (c.code !== code) return { ok: false, error: "wrong_code" };
			codes.delete(challenge);
			if (!accounts.has(email)) accounts.set(email, `sub-${email.split("@")[0]}`);
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

/** The adults of the pilot workspace, by subject: their membership role (the student has none). */
const ADULTS = { admin: "breinhap.admin", teacher: "breinhap.teacher", parent: "breinhap.parent", tutor: "breinhap.tutor", revoked: "breinhap.teacher" };

/**
 * One workspace, as the server builds it: identity on Redis (adult OIDC sessions and student
 * sessions side by side), the directory and content on Postgres, uploads in memory with a scanner,
 * extractions run on demand. `db` picks the database (the restore test starts a second server on
 * the restored copy with the same Redis workspace).
 */
async function gate({ db = pool, store: existing, headless = fakeHeadless(), extractRun } = {}) {
	const clock = { time: Date.now() };
	const now = () => clock.time;
	const store = existing ?? (await makeStore(now));
	if (!existing) for (const [sub, role] of Object.entries(ADULTS)) await member(store, sub, role);
	let next = "admin";
	// the platform's grants: adults have management access, an account without a role is a student
	const grants = async (subject) => {
		const role = ADULTS[subject];
		return {
			appId: "breinhap",
			subject,
			state: role ? "active" : "inactive",
			roles: role ? [role] : subject === "pupil" ? ["breinhap.student"] : [],
			permissions: role
				? ["breinhap.management.access", ...(subject === "admin" ? ["breinhap.memberships.manage"] : [])]
				: subject === "pupil"
					? ["breinhap.student.access"]
					: [],
		};
	};
	const provider = {
		authorizationUrl: async (flow) => `https://id.asafarim.site/auth?state=${flow.state}`,
		exchange: async () => ({
			sub: next,
			sid: `sid-${next}-${randomBytes(4).toString("hex")}`,
			issuedAt: Math.floor(clock.time / 1000),
			authTime: Math.floor(clock.time / 1000),
			accessToken: "access",
			refreshToken: "refresh",
			expiresIn: 3600,
		}),
		userInfo: async (_token, sub) => ({ sub }),
		refresh: async () => ({ accessToken: "a", refreshToken: "r", expiresIn: 3600 }),
		logoutUrl: () => `${ORIGIN}/login`,
	};
	const identity = createIdentity({ provider, store, grants, headless, now, version: "9.9.9" });
	const directory = await new Directory({ pool: db, workspace: store.workspace }).ready();
	const membership = (sub) => store.membership(sub);
	const learnerAccounts = new LearnerAccounts({
		directory,
		membership,
		budget: (kind, limit, seconds, requester) => store.budget(kind, limit, seconds, requester),
	});
	const assignments = new AssignmentStore({ directory, membership, clock: now });
	const content = new ContentStore({ directory });
	const publishing = new PublishingStore({ content });
	const progress = new ProgressStore({ directory, clock: now });
	const storage = new MemoryStorage();
	const uploads = new UploadStore({ directory, storage, scanner: new FakeScanner(), linkSecret: "s".repeat(40), now });
	const extractions = new ExtractionStore({ uploads, leaseSeconds: 1, ...(extractRun ? { run: extractRun } : {}) });
	const server = createManagementServer({ identity, directory, content, publishing, assignments, learnerAccounts, progress, uploads, extractions });
	servers.push(server);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;

	const internal = (cookie) => Object.assign(Readable.from([""]), { method: "GET", headers: { cookie, origin: ORIGIN } });
	/** An adult (or a student account) through the management OIDC flow: its cookie and CSRF token. */
	async function login(sub) {
		next = sub;
		const started = await identity.handle(internal(""), new URL(`${ORIGIN}/auth/start`));
		const flow = started.headers["Set-Cookie"][0].split(";")[0];
		const state = new URL(started.headers.Location).searchParams.get("state");
		const done = await identity.handle(internal(flow), new URL(`${ORIGIN}/auth/callback?state=${state}&code=valid`));
		const cookie = done.headers["Set-Cookie"][0].split(";")[0];
		const probe = internal(cookie);
		await identity.current(probe);
		return { sub, cookie, csrf: probe.managementSession?.csrf ?? "" };
	}
	/** One request as it reaches the container: any Host, any cookie, a form or a raw body. */
	const call = (path, { host = "management.breinhap.com", method = "GET", cookie = "", form, raw, origin, headers = {} } = {}) =>
		new Promise((resolve, reject) => {
			const body = raw ? raw.body : form ? new URLSearchParams(form).toString() : undefined;
			const req = http.request(
				{
					hostname: "127.0.0.1",
					port,
					path,
					method,
					headers: {
						Host: host,
						...(cookie ? { Cookie: cookie } : {}),
						...(method === "POST" ? { Origin: origin ?? (host === "breinhap.com" ? PUBLIC : ORIGIN) } : {}),
						...(body !== undefined ? { "Content-Type": raw?.contentType ?? "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) } : {}),
						...headers,
					},
				},
				(res) => {
					const chunks = [];
					res.on("data", (c) => chunks.push(c));
					res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, location: res.headers.location, body: Buffer.concat(chunks).toString("utf8") }));
				},
			);
			req.on("error", reject);
			req.end(body);
		});
	/** An adult's browser on management: its own cookie and CSRF token on every form. */
	const adult = (who) => ({
		...who,
		get: (path, options = {}) => call(path, { cookie: who.cookie, ...options }),
		post: (path, form = {}, options = {}) => call(path, { method: "POST", cookie: who.cookie, form: { csrf: who.csrf, ...form }, ...options }),
	});
	/** A student's browser on breinhap.com/p: a cookie jar, sign-in with the e-mailed code. */
	function student() {
		const jar = new Map();
		const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
		const request = async (method, path, form, options = {}) => {
			const res = await call(path, { host: "breinhap.com", method, cookie: cookie(), form, ...options });
			for (const line of [res.headers["set-cookie"] ?? []].flat()) {
				const [pair] = line.split(";");
				const name = pair.slice(0, pair.indexOf("="));
				if (/Max-Age=0/.test(line)) jar.delete(name);
				else jar.set(name, pair.slice(name.length + 1));
			}
			return res;
		};
		const get = (path, options) => request("GET", path, undefined, options);
		const post = (path, form, options) => request("POST", path, form, options);
		const b = {
			jar,
			cookie,
			get,
			post,
			async signIn(email) {
				const start = await get("/p/aanmelden");
				const sent = await post("/p/aanmelden", { csrf: csrfOf(start.body), email });
				assert.equal(sent.status, 303, sent.body);
				const page = await get("/p/aanmelden/code");
				const done = await post("/p/aanmelden/code", { csrf: csrfOf(page.body), code: headless.codeFor(email) });
				assert.equal(done.status, 303, done.body);
				return done;
			},
			async link(code) {
				const page = await get("/p/koppelen");
				const linked = await post("/p/koppelen", { csrf: csrfOf(page.body), code });
				assert.equal(linked.status, 303, linked.body);
				assert.equal(linked.location, "/p/mijn");
			},
		};
		return b;
	}
	return { clock, store, headless, identity, directory, learnerAccounts, assignments, content, publishing, progress, storage, uploads, extractions, server, call, login, adult, student };
}

const csrfOf = (html) => /name="csrf" value="([^"]+)"/.exec(html)?.[1];
const iso = (ms) => new Date(ms).toISOString();

const DRAFT = {
	schemaVersion: 1,
	id: "x",
	subject: "biologie",
	title: "Prikkel en reactie",
	grade: 3,
	curriculum: { leerdoel: "De leerlingen leggen prikkel en reactie uit." },
	review: { status: "draft" },
	missions: [
		{
			id: "x-m1",
			title: "Wat is een prikkel?",
			minutes: 3,
			warmup: { text: "Denk aan iets dat je laat schrikken." },
			learn: [{ text: "Een prikkel is een verandering die een organisme waarneemt." }],
			practice: [
				{ kind: "choice", prompt: "Wat is een prikkel?", options: ["Een verandering", "Een spier"], answerIndex: 0, explanation: "Een prikkel is een verandering in de omgeving." },
			],
			check: [{ kind: "order", prompt: "Zet in volgorde.", items: ["prikkel", "reactie", "receptor"], explanation: "Eerst de prikkel, dan de receptor, dan de reactie." }],
		},
	],
};

/** A published, independently approved object with one mission, prepared through the stores. */
async function publication(g, id = `lo-${randomBytes(3).toString("hex")}`) {
	const author = { sub: "teacher", role: "breinhap.teacher" };
	const reviewer = { sub: "parent", role: "breinhap.parent" };
	const grant = (who, capability) => g.directory.grantCapability(adminPrincipal, who, capability).catch((error) => {
		if (error.code !== "exists") throw error;
	});
	await grant(reviewer, "content.review");
	await grant(author, "content.publish");
	const draft = {
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
					{ kind: "choice", prompt: "Wat is een prikkel?", options: ["Een verandering", "Een spier"], answerIndex: 0, explanation: "Een prikkel is een verandering in de omgeving." },
				],
				check: [{ kind: "order", prompt: "Zet in volgorde.", items: ["prikkel", "reactie", "receptor"], explanation: "Eerst de prikkel, dan de receptor, dan de reactie." }],
			},
		],
	};
	await g.content.create(author, draft, [{ kind: "own", title: "Eigen werk" }]);
	await g.content.snapshot(author, id, 1);
	await g.content.submit(author, id, 1);
	await g.content.review(reviewer, id, 1, "approved");
	const published = await g.publishing.publish(author, id, 1);
	return { ...published, objectId: id };
}

/** How a response treats its caller, in one word: what the matrix records. */
function outcome(res) {
	if (res.status === 303 || res.status === 302) {
		const to = res.location ?? "";
		if (/^\/login|^\/auth\/start/.test(to)) return "login";
		if (/^\/registreren/.test(to)) return "register";
		if (/^\/p\/aanmelden/.test(to)) return "student-login";
		if (/^\/p\/koppelen/.test(to)) return "link-first";
		return "ok";
	}
	if (res.status === 403) return "denied";
	if (res.status === 404) return "missing";
	if (res.status === 405) return "method";
	if (res.status === 421) return "misdirected";
	if (res.status >= 500) return `error-${res.status}`;
	return "ok"; // 200, 400, 409, 410, 422: the caller reached the route; the route then judged the input
}

/**
 * The fixture every matrix row runs against: Lina in Klas 3A, the teacher linked to the group, the
 * parent and the tutor linked to Lina, Noor in nobody's scope, one published object assigned to the
 * group, the teacher's own draft, and the callers, each signed in its own way.
 */
async function matrixWorld() {
	const g = await gate();
	const lina = await g.directory.createLearner(adminPrincipal, { displayName: "Lina", schoolYear: 3 });
	const noor = await g.directory.createLearner(adminPrincipal, { displayName: "Noor", schoolYear: 3 });
	const group = await g.directory.createGroup(adminPrincipal, { name: "Klas 3A" });
	await g.directory.addToGroup(adminPrincipal, { groupId: group, learnerId: lina });
	const teacherLink = await g.directory.link(adminPrincipal, { sub: "teacher", role: "breinhap.teacher" }, { groupId: group });
	await g.directory.link(adminPrincipal, { sub: "parent", role: "breinhap.parent" }, { learnerId: lina });
	await g.directory.link(adminPrincipal, { sub: "tutor", role: "breinhap.tutor" }, { learnerId: lina });
	await g.directory.link(adminPrincipal, { sub: "revoked", role: "breinhap.teacher" }, { groupId: group });
	const pub = await publication(g);
	const assignment = await g.assignments.assign({ sub: "teacher", role: "breinhap.teacher" }, { publicationId: pub.id, audienceKind: "group", audienceId: group });
	await g.content.create({ sub: "teacher", role: "breinhap.teacher" }, { ...structuredClone(DRAFT), id: "eigen-concept" }, [{ kind: "own", title: "Eigen werk" }]);

	const callers = { anonymous: g.adult({ cookie: "", csrf: "" }) };
	for (const sub of Object.keys(ADULTS)) callers[sub] = g.adult(await g.login(sub));
	await g.store.revokeMember("revoked");
	callers.pupil = g.adult(await g.login("pupil")); // a student account on the management sign-in
	callers.outsider = g.adult(await g.login("outsider")); // signed in to ASafariM, no Breinhap role

	// students on breinhap.com: Lina linked, Noor linked to the learner outside every adult's scope, one not linked yet
	const linaBrowser = g.student();
	await linaBrowser.signIn("lina@school.example");
	await linaBrowser.link((await g.learnerAccounts.createCode(adminPrincipal, lina)).code);
	const noorBrowser = g.student();
	await noorBrowser.signIn("noor@school.example");
	await noorBrowser.link((await g.learnerAccounts.createCode(adminPrincipal, noor)).code);
	const newBrowser = g.student();
	await newBrowser.signIn("nieuw@school.example");
	// the student session cookie, sent by hand to management: a direct API call, never a browser
	callers.studentCookie = g.adult({ cookie: linaBrowser.cookie(), csrf: "" });
	return { g, lina, noor, group, teacherLink, pub, assignment, callers, students: { anonymous: g.student(), unlinked: newBrowser, lina: linaBrowser, noor: noorBrowser } };
}

const NOBODY = "00000000-0000-4000-8000-000000000000";
// Columns of the management matrix, in order. `revoked` is a teacher whose membership an administrator
// revoked after sign-in; `pupil` is a student account on the management sign-in; `outsider` has an
// ASafariM account and no Breinhap role; `studentCookie` is the breinhap.com student session sent to
// management by hand.
const ADULT_COLUMNS = ["anonymous", "admin", "teacher", "parent", "tutor", "revoked", "pupil", "outsider", "studentCookie"];
// Outcomes: ok = the route served the caller (it may still judge the input: 400/409/422), login /
// register = sent to sign in or to request access, denied = 403, missing = 404 (unknown here or not in
// scope), method = 405. Every cell is a decision; a change in any cell fails this test.
const MANAGEMENT_MATRIX = [
	// route                                                 anon     admin     teacher   parent    tutor     revoked    pupil     outsider   studentCookie
	["GET /",                                               "login",  "ok",     "ok",     "ok",     "ok",     "register", "denied", "register", "login"],
	["GET /leerlingen",                                     "login",  "ok",     "ok",     "ok",     "ok",     "register", "denied", "register", "login"],
	// the read-aloud voice of the account (breinhap#125): any signed-in account, nothing of the workspace
	["GET /instellingen",                                   "login",  "ok",     "ok",     "ok",     "ok",     "ok",       "ok",     "ok",       "login"],
	["GET /registreren",                                    "ok",     "ok",     "ok",     "ok",     "ok",     "ok",       "denied", "ok",       "ok"],
	["GET /beheer",                                         "login",  "ok",     "denied", "denied", "denied", "denied",   "denied", "denied",   "login"],
	["GET /beheer/leerlingen",                              "login",  "ok",     "denied", "denied", "denied", "denied",   "denied", "denied",   "login"],
	// the library is for authors: an administrator manages people, not content
	["GET /bibliotheek",                                    "login",  "denied", "ok",     "ok",     "ok",     "register", "denied", "register", "login"],
	["GET /bibliotheek/nieuw",                              "login",  "denied", "ok",     "ok",     "ok",     "register", "denied", "register", "login"],
	["GET /bibliotheek/eigen-concept",                      "login",  "denied", "ok",     "missing","missing","register", "denied", "register", "login"],
	["GET /bibliotheek/eigen-concept/voorbeeld",            "login",  "denied", "ok",     "missing","missing","register", "denied", "register", "login"],
	["GET /bibliotheek/bestanden",                          "login",  "denied", "ok",     "ok",     "ok",     "register", "denied", "register", "login"],
	["GET /bibliotheek/importeren",                         "login",  "denied", "ok",     "ok",     "ok",     "register", "denied", "register", "login"],
	["GET /bibliotheek/uittreksels",                        "login",  "denied", "ok",     "ok",     "ok",     "register", "denied", "register", "login"],
	// review and publishing need the explicit grant: the parent reviews, the teacher publishes
	["GET /bibliotheek/nakijken",                           "login",  "denied", "denied", "ok",     "denied", "register", "denied", "register", "login"],
	["GET /bibliotheek/publicaties",                        "login",  "denied", "ok",     "denied", "denied", "register", "denied", "register", "login"],
	["GET /bibliotheek/openbaar",                           "login",  "ok",     "denied", "denied", "denied", "register", "denied", "register", "login"],
	// assigners get the form, the administrator the counts-only overview (breinhap#137)
	["GET /bibliotheek/toewijzen",                          "login",  "ok",     "ok",     "ok",     "ok",     "register", "denied", "register", "login"],
	["GET /bibliotheek/toewijzen/{assignment}",             "login",  "method", "method", "method", "method", "register", "denied", "register", "login"],
	["GET /bibliotheek/packs",                              "login",  "denied", "ok",     "ok",     "ok",     "register", "denied", "register", "login"],
	["GET /healthz",                                        "ok",     "ok",     "ok",     "ok",     "ok",     "ok",       "ok",     "ok",       "ok"],
	["GET /readyz",                                         "ok",     "ok",     "ok",     "ok",     "ok",     "ok",       "ok",     "ok",       "ok"],
	["GET /.well-known/asafarim-app.json",                  "ok",     "ok",     "ok",     "ok",     "ok",     "ok",       "ok",     "ok",       "ok"],
	// the student paths do not exist on the management Host, whoever asks
	["GET /p/mijn",                                         "missing","missing","missing","missing","missing","missing",  "missing","missing",  "missing"],
	["GET /p/mijn/gegevens",                                "missing","missing","missing","missing","missing","missing",  "missing","missing",  "missing"],
	["POST /bibliotheek/nieuw",                             "login",  "denied", "ok",     "ok",     "ok",     "register", "denied", "register", "login"],
	["POST /bibliotheek/eigen-concept/vastleggen",          "login",  "denied", "ok",     "missing","missing","register", "denied", "register", "login"],
	["POST /bibliotheek/nakijken/bestaat-niet/1",           "login",  "denied", "denied", "missing","denied", "register", "denied", "register", "login"],
	["POST /bibliotheek/publicaties/bestaat-niet/intrekken","login",  "denied", "missing","denied", "denied", "register", "denied", "register", "login"],
	["POST /bibliotheek/toewijzen",                         "login",  "denied", "ok",     "ok",     "ok",     "register", "denied", "register", "login"],
	["POST /bibliotheek/toewijzen/{nobody}/intrekken",      "login",  "denied", "missing","missing","missing","register", "denied", "register", "login"],
	["POST /bibliotheek/openbaar/{nobody}/toevoegen",       "login",  "missing","denied", "denied", "denied", "register", "denied", "register", "login"],
	["POST /beheer/leerlingen/nieuw",                       "login",  "ok",     "denied", "denied", "denied", "denied",   "denied", "denied",   "login"],
	["POST /beheer/uitnodigen",                             "login",  "ok",     "denied", "denied", "denied", "denied",   "denied", "denied",   "login"],
	["POST /beheer/rechten/toekennen",                      "login",  "ok",     "denied", "denied", "denied", "denied",   "denied", "denied",   "login"],
	["POST /beheer/leerlingen/koppelcode",                  "login",  "missing","denied", "denied", "denied", "denied",   "denied", "denied",   "login"],
	// a linked adult makes link codes for their own learners only: an unknown learner is not found
	["POST /leerlingen/koppelcode",                         "login",  "missing","missing","missing","missing","denied",   "denied", "denied",   "login"],
];
const FORMS = {
	"/bibliotheek/eigen-concept/vastleggen": { expectedVersion: "9" },
	"/bibliotheek/nakijken/bestaat-niet/1": { decision: "approved" },
	"/bibliotheek/publicaties/bestaat-niet/intrekken": { revision: "1" },
	"/beheer/leerlingen/koppelcode": { learner: NOBODY },
	"/leerlingen/koppelcode": { learner: NOBODY },
};

const STUDENT_COLUMNS = ["anonymous", "unlinked", "lina", "noor", "adultCookie"];
// On breinhap.com: a signed-out visitor goes to sign in, a student without a link to the link-code step,
// a linked student sees only their own learner's homework, and a management cookie counts for nothing.
// The management pages do not exist here.
const STUDENT_MATRIX = [
	// route                                   anon             unlinked       lina       noor       adultCookie
	["GET /p/aanmelden",                      "ok",            "link-first",  "ok",      "ok",      "ok"],
	["GET /p/koppelen",                       "student-login", "ok",          "ok",      "ok",      "student-login"],
	["GET /p/mijn",                           "student-login", "link-first",  "ok",      "ok",      "student-login"],
	["GET /p/mijn/{assignment}",              "student-login", "link-first",  "ok",      "missing", "student-login"],
	["GET /p/mijn/{nobody}",                  "student-login", "link-first",  "missing", "missing", "student-login"],
	["GET /p/mijn/gegevens",                  "student-login", "link-first",  "ok",      "ok",      "student-login"],
	["GET /p/mijn/gegevens/download",         "student-login", "link-first",  "ok",      "ok",      "student-login"],
	["GET /p/session",                        "ok",            "ok",          "ok",      "ok",      "ok"],
	["GET /",                                 "missing",       "missing",     "missing", "missing", "missing"],
	["GET /bibliotheek",                      "missing",       "missing",     "missing", "missing", "missing"],
	["GET /bibliotheek/toewijzen",            "missing",       "missing",     "missing", "missing", "missing"],
	["GET /beheer",                           "missing",       "missing",     "missing", "missing", "missing"],
	["GET /instellingen",                     "missing",       "missing",     "missing", "missing", "missing"],
	["POST /p/mijn/gegevens/wissen",          "student-login", "link-first",  "ok",      "ok",      "student-login"],
	["POST /p/mijn/{assignment}",             "student-login", "link-first",  "ok",      "missing", "student-login"],
	["POST /p/koppelen",                      "student-login", "ok",          "ok",      "ok",      "student-login"],
];
const STUDENT_FORMS = { "/p/mijn/{assignment}": { missie: "0", doe: "start" }, "/p/koppelen": { code: "ABCD-EFGH" } };

test("the permission matrix on management.breinhap.com: each page and form × every kind of caller", async () => {
	const w = await matrixWorld();
	const fill = (path) => path.replace("{assignment}", w.assignment.id).replace("{nobody}", NOBODY);
	const actual = [];
	for (const [route] of MANAGEMENT_MATRIX) {
		const [method, template] = route.split(" ");
		const path = fill(template);
		const row = [route];
		for (const column of ADULT_COLUMNS) {
			const caller = w.callers[column];
			const res = method === "GET" ? await caller.get(path) : await caller.post(path, FORMS[template] ?? {});
			assert.ok(res.status < 500, `${route} as ${column}: ${res.status}`);
			row.push(outcome(res));
		}
		actual.push(row);
	}
	assert.deepEqual(actual, MANAGEMENT_MATRIX);

	// only the assigner sees the assignment's learners
	const page = await w.callers.teacher.get("/bibliotheek/toewijzen");
	assert.match(page.body, /Lina/);
	for (const column of ["parent", "tutor"]) assert.doesNotMatch((await w.callers[column].get("/bibliotheek/toewijzen")).body, /Klas 3A/);
	assert.doesNotMatch((await w.callers.admin.get("/bibliotheek/toewijzen")).body, /Lina|Noor/, "the administrator sees counts, never names");
});

test("the permission matrix on breinhap.com: a student reaches only their own learner's homework", async () => {
	const w = await matrixWorld();
	const fill = (path) => path.replace("{assignment}", w.assignment.id).replace("{nobody}", NOBODY);
	const actual = [];
	for (const [route] of STUDENT_MATRIX) {
		const [method, template] = route.split(" ");
		const path = fill(template);
		const row = [route];
		for (const column of STUDENT_COLUMNS) {
			let res;
			if (column === "adultCookie") {
				const t = w.callers.teacher;
				res = await w.g.call(path, { host: "breinhap.com", method, cookie: t.cookie, form: method === "POST" ? { csrf: t.csrf, ...(STUDENT_FORMS[template] ?? {}) } : undefined });
			} else {
				const b = w.students[column];
				if (method === "GET") res = await b.get(path);
				else {
					const token = csrfOf((await b.get("/p/mijn/gegevens")).body) ?? csrfOf((await b.get("/p/koppelen")).body) ?? "";
					res = await b.post(path, { csrf: token, ...(STUDENT_FORMS[template] ?? {}) });
				}
			}
			assert.ok(res.status < 500, `${route} as ${column}: ${res.status}`);
			row.push(outcome(res));
		}
		actual.push(row);
	}
	assert.deepEqual(actual, STUDENT_MATRIX);

	// nothing of another learner or of an adult is on Lina's pages
	const lina = w.students.lina;
	for (const path of ["/p/mijn", `/p/mijn/${w.assignment.id}`, "/p/mijn/gegevens", "/p/mijn/gegevens/download"]) {
		const { body } = await lina.get(path);
		assert.doesNotMatch(body, /Noor|Klas 3A|teacher|parent|tutor|management\.breinhap\.com\/bibliotheek/, path);
	}
	// the student bundle carries no management code: its assets are the learner's own
	for (const asset of ["/p/assets/learner.css", "/p/assets/bootstrap.js", "/p/assets/narration.js"]) {
		const res = await lina.get(asset);
		assert.equal(res.status, 200, asset);
		assert.doesNotMatch(res.body, /bibliotheek|beheer|toewijzen|nakijken|publicaties/, asset);
	}
	assert.equal((await lina.get("/editor.js")).status, 404);
	assert.equal((await lina.get("/styles.css")).status, 404);
});

test("direct access: only the exact Host and an origin-form target reach anything; forwarded headers decide nothing", async () => {
	const w = await matrixWorld();
	const teacher = w.callers.teacher;
	for (const host of ["127.0.0.1", "localhost", "breinhap-management:8080", "management.breinhap.com.evil.example", "MANAGEMENT.BREINHAP.COM", "www.breinhap.com"]) {
		for (const path of ["/bibliotheek", "/beheer", "/p/mijn", "/healthz"]) {
			const res = await w.g.call(path, { host, cookie: teacher.cookie });
			assert.equal(res.status, 421, `${host}${path}`);
		}
	}
	// a forwarded Host never turns a request into the other application
	const spoofed = await w.g.call("/bibliotheek", { host: "breinhap.com", cookie: teacher.cookie, headers: { "X-Forwarded-Host": "management.breinhap.com" } });
	assert.equal(spoofed.status, 404);
	const spoofedStudent = await w.g.call("/p/mijn", { cookie: w.students.lina.cookie(), headers: { "X-Forwarded-Host": "breinhap.com" } });
	assert.equal(spoofedStudent.status, 404);
	// absolute-form and protocol-relative targets are refused on management
	assert.equal((await w.g.call("http://management.breinhap.com/bibliotheek", { cookie: teacher.cookie })).status, 421);
	assert.equal((await w.g.call("//breinhap.com/p/mijn", { cookie: teacher.cookie })).status, 421);
	// a POST from the other application's origin changes nothing on either side
	const crossToManagement = await teacher.post("/bibliotheek/nieuw", {}, { origin: PUBLIC });
	assert.equal(crossToManagement.status, 403);
	const lina = w.students.lina;
	const token = csrfOf((await lina.get("/p/mijn/gegevens")).body);
	const crossToStudent = await lina.post("/p/mijn/gegevens/wissen", { csrf: token, zeker: "1" }, { origin: ORIGIN });
	assert.equal(crossToStudent.status, 403);
});

/** The assignment ids on a student's /p/mijn. */
const listed = async (b) => [...(await b.get("/p/mijn")).body.matchAll(/href="\/p\/mijn\/([0-9a-f-]{36})"/g)].map((m) => m[1]);

test("revoked roles and ended relationships take effect on the next request, on both Hosts", async () => {
	const w = await matrixWorld();
	const { g, callers, students } = w;
	let teacher = callers.teacher;
	const lina = students.lina;
	const assign = async (form) => {
		const res = await teacher.post("/bibliotheek/toewijzen", form);
		assert.equal(res.status, 303, res.body);
		const { rows } = await pool.query("SELECT id FROM content_assignments WHERE workspace_id = $1 AND publication_id = $2", [g.store.workspace, form.publicationId]);
		return rows[0].id;
	};
	const day = (ms) => iso(ms).slice(0, 10);
	// four more assignments for Lina's group, each ended in its own way below
	// (one assignment per publication and audience, so each gets its own publication)
	const revokedOne = await assign({ publicationId: (await publication(g)).id, audience: `group:${w.group}` });
	const closing = await assign({ publicationId: (await publication(g)).id, audience: `group:${w.group}`, availableUntil: day(g.clock.time + DAY) });
	const other = await publication(g);
	const withdrawnOne = await assign({ publicationId: other.id, audience: `group:${w.group}` });
	for (const id of [w.assignment.id, revokedOne, closing, withdrawnOne]) {
		assert.ok((await listed(lina)).includes(id), "assigned");
		assert.equal((await lina.get(`/p/mijn/${id}`)).status, 200);
	}

	// the assigner revokes one: gone from the list, and its page is the same calm 404 as any unknown id
	assert.equal((await teacher.post(`/bibliotheek/toewijzen/${revokedOne}/intrekken`, {})).status, 303);
	assert.ok(!(await listed(lina)).includes(revokedOne));
	assert.equal((await lina.get(`/p/mijn/${revokedOne}`)).status, 404);
	// the publisher withdraws a publication: its assignments are unavailable at once
	assert.equal((await teacher.post(`/bibliotheek/publicaties/${other.objectId}/intrekken`, {})).status, 303);
	assert.ok(!(await listed(lina)).includes(withdrawnOne));
	assert.equal((await lina.get(`/p/mijn/${withdrawnOne}`)).status, 404);
	// the window closes at the end of its last day (the adults sign in again after two days)
	g.clock.time += 2 * DAY;
	assert.ok(!(await listed(lina)).includes(closing));
	assert.equal((await lina.get(`/p/mijn/${closing}`)).status, 404);
	assert.ok((await listed(lina)).includes(w.assignment.id), "the others stay");
	teacher = g.adult(await g.login("teacher"));

	// the administrator ends the teacher's link to the group: the teacher no longer sees Lina, cannot
	// assign to the group, and a group assignment made earlier no longer reaches the teacher's overview
	assert.match((await teacher.get("/bibliotheek/toewijzen")).body, /Lina/);
	const boss = g.adult(await g.login("admin"));
	assert.equal((await boss.post("/beheer/koppelingen/intrekken", { link: w.teacherLink })).status, 303);
	assert.doesNotMatch((await teacher.get("/bibliotheek/toewijzen")).body, /Lina|Klas 3A/);
	assert.notEqual((await teacher.post("/bibliotheek/toewijzen", { publicationId: w.pub.id, audience: `group:${w.group}` })).status, 303);

	// Lina leaves the group: the group's homework leaves her list; the parent's view of her stays
	assert.equal((await boss.post("/beheer/groepen/verwijderen", { group: w.group, learner: w.lina })).status, 303);
	assert.deepEqual(await listed(lina), []);

	// the administrator revokes the teacher's membership: the next request is a request for access
	assert.equal((await boss.post("/beheer/intrekken", { subject: "teacher" })).status, 200);
	assert.equal(outcome(await teacher.get("/bibliotheek")), "register");
	assert.equal(outcome(await teacher.post("/bibliotheek/nieuw", {})), "register");

	// the administrator ends Lina's account link: the next request asks for a link code again
	assert.equal((await boss.post("/beheer/leerlingen/koppeling/verbreken", { learner: w.lina })).status, 303);
	assert.equal(outcome(await lina.get("/p/mijn")), "link-first");
	assert.equal(outcome(await lina.get("/p/mijn/gegevens")), "link-first");

	// ASafariM revokes Noor's account: her student session ends (the status is cached for a short while)
	const noor = students.noor;
	assert.equal((await noor.get("/p/mijn")).status, 200);
	g.headless.revoke(g.headless.subOf("noor@school.example"));
	g.clock.time += 10 * 60_000;
	assert.equal(outcome(await noor.get("/p/mijn")), "student-login");
});

/** The hidden fields of the player form whose `doe` is the given step (start, verder, stap, pauze). */
const formFor = (html, doe) => {
	for (const part of html.split("<form").slice(1)) {
		const fields = Object.fromEntries([...part.split("</form>")[0].matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], m[2]]));
		if (fields.doe === doe) return fields;
	}
	return undefined;
};
const LESSON = textPdf([
	[{ text: "Prikkel en reactie", size: 20 }, "Ik leg uit wat een prikkel en een reactie zijn.", "", "", "Een prikkel is een verandering die je waarneemt."],
	["Wat is een prikkel?", "", "", "Een spier", "", "", "Een verandering"],
]);

test("end to end: upload and import, review, publish, assign, a link code, the student's mission, done / not done, withdrawal", async () => {
	let extraction = "corrupt";
	const g = await gate({
		extractRun: async ({ kind, bytes }) => {
			if (extraction === "corrupt") throw new ExtractFailed("corrupt");
			const { runParser } = await import("../src/extract/sandbox.mjs");
			return runParser({ kind, bytes });
		},
	});
	const ws = g.store.workspace;
	const count = async (table) => (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`, [ws])).rows[0].n;
	const teacher = g.adult(await g.login("teacher"));
	const parent = g.adult(await g.login("parent"));
	const boss = g.adult(await g.login("admin"));
	const upload = (file, name, type) =>
		teacher.get("/bibliotheek/bestanden", {
			method: "POST",
			raw: multipart([
				{ name: "csrf", value: teacher.csrf },
				{ name: "bestand", filename: name, type, value: file },
				{ name: "bron", value: "own" },
				{ name: "licentie", value: "own_work" },
				{ name: "notitie", value: "Biologie voor jou 3" },
			]),
		});

	// 1. files: a program and a PDF with a script are refused and nothing is stored; a clean PDF is kept
	assert.equal((await upload(Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200)]), "les.pdf", "application/pdf")).status, 422);
	assert.equal((await upload(pdf("1 0 obj<</S/JavaScript>>endobj\n"), "les.pdf", "application/pdf")).status, 422);
	assert.equal(await count("uploads"), 0);
	assert.equal(g.storage.objects.size, 0);
	const kept = await upload(LESSON, "les.pdf", "application/pdf");
	assert.equal(kept.status, 303);
	assert.equal(kept.location, "/bibliotheek/bestanden?opgeladen=clean");
	const [{ id: uploadId }] = (await pool.query("SELECT id FROM uploads WHERE workspace_id = $1", [ws])).rows;

	// 2. a failed extraction job reports why and is retried as the same job; nothing becomes a draft
	const started = await teacher.post("/bibliotheek/uittreksels", { bestand: uploadId });
	assert.equal(started.status, 303);
	const jobId = /uittreksels\/([0-9a-f-]{36})/.exec(started.location)[1];
	await g.extractions.kick();
	const failed = await teacher.get(`/bibliotheek/uittreksels/${jobId}`);
	assert.match(failed.body, /action="\/bibliotheek\/uittreksels\/[0-9a-f-]{36}\/opnieuw"/);
	assert.equal((await pool.query("SELECT status, error FROM extractions WHERE id = $1", [jobId])).rows[0].status, "failed");
	extraction = "ok";
	assert.match((await teacher.post(`/bibliotheek/uittreksels/${jobId}/opnieuw`, {})).location, /notice=retried/);
	await g.extractions.kick();
	assert.equal((await pool.query("SELECT status FROM extractions WHERE id = $1", [jobId])).rows[0].status, "done");
	assert.equal(await count("extractions"), 1);
	assert.equal(await count("learning_objects"), 0, "reading a file makes no draft");

	// 3. an import: a broken file is refused with its reasons and writes nothing; the template imports as a draft
	const importFile = (name, text) =>
		teacher.get("/bibliotheek/importeren", {
			method: "POST",
			raw: multipart([
				{ name: "csrf", value: teacher.csrf },
				{ name: "bestand", filename: name, type: "text/csv", value: Buffer.from(text) },
			]),
		});
	const broken = await importFile("les.csv", "dit;is;geen;sjabloon\r\n1;2;3;4\r\n");
	assert.ok(broken.status < 500 && !/action="\/bibliotheek\/importeren\/[0-9a-f-]{36}\/bevestigen"/.test(broken.body), "nothing to confirm");
	assert.equal(await count("learning_objects"), 0);
	const preview = await importFile("les.csv", TEMPLATE);
	const confirm = /action="(\/bibliotheek\/importeren\/[0-9a-f-]{36}\/bevestigen)"/.exec(preview.body)[1];
	assert.equal((await teacher.post(confirm, {})).status, 303);
	assert.equal(await count("learning_objects"), 1);

	// 4. review: an import has no source yet, so it cannot be offered; the author adds one in the editor,
	// snapshots and offers; without the grant nobody reviews; the author never reviews their own work
	assert.equal((await teacher.post("/bibliotheek/prikkel-reactie/vastleggen", { expectedVersion: "1" })).status, 303);
	const unready = await teacher.post("/bibliotheek/prikkel-reactie/aanbieden", { revision: "1" });
	assert.equal(unready.status, 409);
	assert.match(unready.body, /Voeg minstens één bron toe/);
	const [{ content: imported }] = (await pool.query("SELECT content FROM learning_object_drafts WHERE workspace_id = $1", [ws])).rows;
	const edited = await teacher.post("/bibliotheek/prikkel-reactie", {
		...toValues(imported, [{ kind: "book", title: "Biologie voor jou 3" }]),
		expectedVersion: "1",
	});
	assert.equal(edited.status, 303, edited.body);
	assert.equal((await teacher.post("/bibliotheek/prikkel-reactie/vastleggen", { expectedVersion: "2" })).status, 303);
	const offered = await teacher.post("/bibliotheek/prikkel-reactie/aanbieden", { revision: "2" });
	assert.equal(offered.status, 303, offered.body);
	assert.equal((await parent.get("/bibliotheek/nakijken")).status, 403);
	await g.directory.grantCapability(adminPrincipal, { sub: "parent", role: "breinhap.parent" }, "content.review");
	assert.equal((await teacher.post("/bibliotheek/nakijken/prikkel-reactie/2", { decision: "approved" })).status, 403, "the author never reviews their own work");
	const approved = await parent.post("/bibliotheek/nakijken/prikkel-reactie/2", { decision: "approved" });
	assert.equal(approved.status, 303);

	// 5. publishing needs its own grant; then the immutable revision is the only thing that can be assigned
	assert.equal((await teacher.post("/bibliotheek/publicaties/prikkel-reactie/publiceren", { revision: "2" })).status, 403);
	await g.directory.grantCapability(adminPrincipal, { sub: "teacher", role: "breinhap.teacher" }, "content.publish");
	assert.equal((await teacher.post("/bibliotheek/publicaties/prikkel-reactie/publiceren", { revision: "2" })).status, 303);
	const [{ id: publicationId }] = (await pool.query("SELECT id FROM content_publications WHERE workspace_id = $1 AND state = 'active'", [ws])).rows;

	// 6. the administrator sets up the class and gives the teacher the group
	const lina = await g.directory.createLearner(adminPrincipal, { displayName: "Lina", schoolYear: 3 });
	const sam = await g.directory.createLearner(adminPrincipal, { displayName: "Sam", schoolYear: 3 });
	const group = await g.directory.createGroup(adminPrincipal, { name: "Klas 3A" });
	for (const learnerId of [lina, sam]) await g.directory.addToGroup(adminPrincipal, { groupId: group, learnerId });
	await g.directory.link(adminPrincipal, { sub: "teacher", role: "breinhap.teacher" }, { groupId: group });

	// 7. the teacher assigns it to the group; the overview says nobody started
	assert.equal((await teacher.post("/bibliotheek/toewijzen", { publicationId, audience: `group:${group}` })).status, 303);
	const [{ id: assignmentId }] = (await pool.query("SELECT id FROM content_assignments WHERE workspace_id = $1", [ws])).rows;
	assert.match((await teacher.get("/bibliotheek/toewijzen")).body, /0 van 2 klaar/);

	// 8. the administrator makes Lina's link code; it is shown once
	const made = await boss.post("/beheer/leerlingen/koppelcode", { learner: lina });
	assert.equal(made.status, 200);
	const code = /value="([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{2})"/.exec(made.body)?.[1];
	assert.ok(code);

	// 9. Lina signs in on breinhap.com with her e-mail code, types the link code once and lands on /p/mijn
	const b = g.student();
	await b.signIn("lina@school.example");
	assert.equal(outcome(await b.get("/p/mijn")), "link-first");
	await b.link(code);
	const mine = await b.get("/p/mijn");
	assert.match(mine.body, /Prikkel en reactie/);
	assert.match(mine.body, /class="badge">Nieuw</);
	const path = `/p/mijn/${assignmentId}`;
	assert.match(mine.body, new RegExp(`href="${path}"`));

	// 10. she starts, pauses halfway, and finishes on another device; nothing travels in the form
	const warm = await b.post(path, formFor((await b.get(path)).body, "start"));
	assert.match(warm.body, /aria-current="step">Opwarmen<\//);
	const learn = await b.post(path, formFor(warm.body, "stap"));
	const paused = await b.post(path, formFor(learn.body, "pauze"));
	assert.match(paused.body, /Je antwoorden zijn bewaard/);
	assert.match((await b.get("/p/mijn")).body, /class="badge">Bezig</);
	assert.match((await teacher.get("/bibliotheek/toewijzen")).body, /Lina: <span class="state pending">bezig sinds /);
	const phone = g.student();
	await phone.signIn("lina@school.example");
	let screen = await phone.post(path, formFor((await phone.get(path)).body, "verder"));
	for (let i = 0; i < 6 && !/Missie klaar/.test(screen.body); i++) {
		const form = formFor(screen.body, "stap");
		const choice = /name="kies" value="(\d)"/.exec(screen.body)?.[1];
		const places = /name="plaats0"/.test(screen.body) ? { plaats0: "0", plaats1: "1", plaats2: "2" } : {};
		screen = await phone.post(path, { ...form, ...(choice !== undefined && !/Klopt\.|Nog niet\./.test(screen.body) ? { kies: choice } : {}), ...places });
	}
	assert.match(screen.body, /Missie klaar/);
	assert.match((await b.get("/p/mijn")).body, /class="badge">Klaar ✓</);
	const [row] = (await pool.query("SELECT state, answers FROM assignment_progress WHERE workspace_id = $1 AND learner_id = $2", [ws, lina])).rows;
	assert.equal(row.state, "finished");

	// 11. the teacher sees done / not done with the day, never answers; the administrator sees counts only
	const overview = await teacher.get("/bibliotheek/toewijzen");
	assert.match(overview.body, /1 van 2 klaar/);
	assert.match(overview.body, /Lina: <span class="state ok">klaar op /);
	assert.match(overview.body, /Sam: <span class="state draft">niet begonnen<\/span>/);
	assert.ok(!overview.body.includes(row.answers), "no stored answers on an adult page");
	const counts = await boss.get("/bibliotheek/toewijzen");
	assert.doesNotMatch(counts.body, /Lina|Sam/);

	// 12. the student's own data page shows it; the publisher withdraws it, and it is unavailable at once
	assert.match((await b.get("/p/mijn/gegevens")).body, /Prikkel en reactie/);
	assert.equal((await teacher.post("/bibliotheek/publicaties/prikkel-reactie/intrekken", {})).status, 303);
	assert.doesNotMatch((await b.get("/p/mijn")).body, new RegExp(`href="${path}"`));
	assert.equal((await b.get(path)).status, 404);
});

// ── backup and restore ──────────────────────────────────────────────────────────────────────────

/**
 * pg_dump / pg_restore against a test database: inside the throwaway Postgres container when
 * test/run.mjs started one (same version as the server), otherwise the tools on PATH.
 */
function pgTool(tool, target, args, input) {
	const container = process.env.BREINHAP_TEST_PG_CONTAINER;
	const result = container
		? spawnSync("docker", ["exec", "-i", container, tool, "-U", "postgres", "-d", target.name, ...args], { input, maxBuffer: 64 * 1024 * 1024 })
		: spawnSync(tool, [`--dbname=${target.url}`, ...args], { input, maxBuffer: 64 * 1024 * 1024 });
	if (result.error?.code === "ENOENT")
		throw new Error(`${tool} is needed for the backup check: install the PostgreSQL client tools, or run the suite through test/run.mjs with Docker`);
	assert.equal(result.status, 0, `${tool}: ${result.stderr?.toString()}`);
	return result.stdout;
}
const NEW_TABLES = {
	learner_accounts: "id",
	learner_link_codes: "id",
	assignment_progress: "assignment_id, learner_id, mission_id",
};
const snapshotOf = async (p) => {
	const out = {};
	for (const [table, order] of Object.entries(NEW_TABLES))
		out[table] = (await p.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows;
	return out;
};

test("backup and restore: the new tables survive pg_dump / pg_restore, and the restored database serves the same student", async () => {
	const source = await database(`${base}_src`);
	const g = await gate({ db: source.pool });
	const lina = await g.directory.createLearner(adminPrincipal, { displayName: "Lina", schoolYear: 3 });
	const noor = await g.directory.createLearner(adminPrincipal, { displayName: "Noor", schoolYear: 3 });
	const pub = await publication(g);
	const parentP = { sub: "parent", role: "breinhap.parent" };
	await g.directory.link(adminPrincipal, parentP, { learnerId: lina });
	const assignment = await g.assignments.assign(parentP, { publicationId: pub.id, audienceKind: "learner", audienceId: lina });
	// Lina is linked and has paused halfway; Noor's link code is made and not used yet
	const b = g.student();
	await b.signIn("lina@school.example");
	await b.link((await g.learnerAccounts.createCode(adminPrincipal, lina)).code);
	const path = `/p/mijn/${assignment.id}`;
	const warm = await b.post(path, formFor((await b.get(path)).body, "start"));
	const learn = await b.post(path, formFor(warm.body, "stap"));
	assert.match((await b.post(path, formFor(learn.body, "pauze"))).body, /Je antwoorden zijn bewaard/);
	const noorCode = (await g.learnerAccounts.createCode(adminPrincipal, noor)).code;
	const before = await snapshotOf(source.pool);
	assert.equal(before.learner_accounts.length, 1);
	assert.equal(before.learner_link_codes.length, 2);
	assert.equal(before.assignment_progress.length, 1);
	assert.equal(before.assignment_progress[0].state, "started");

	// the operator's backup: a custom-format dump, which lists the new tables' data
	const dump = pgTool("pg_dump", source, ["--format=custom", "--no-owner", "--no-privileges"]);
	assert.ok(dump.length > 0);
	const restored = await database(`${base}_restored`, { migrated: false });
	const listing = pgTool("pg_restore", restored, ["--list"], dump).toString();
	for (const table of Object.keys(NEW_TABLES)) assert.match(listing, new RegExp(`TABLE DATA public ${table} `), table);
	// the restore into an empty database, then the start-up migration, which must find nothing to do
	pgTool("pg_restore", restored, ["--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction"], dump);
	const migrations = async (p) => (await p.query("SELECT name FROM schema_migrations ORDER BY name")).rows.map((r) => r.name);
	const applied = await migrations(source.pool);
	assert.ok(applied.includes("012_assignment_progress.sql"), applied.join());
	await migrate(restored.pool);
	assert.deepEqual(await migrations(restored.pool), applied);
	// every row and every column of the new tables, exactly
	assert.deepEqual(await snapshotOf(restored.pool), before);

	// a new server on the restored copy (sessions live in Redis and are not part of the backup)
	const r = await gate({ db: restored.pool, store: g.store, headless: g.headless });
	const again = r.student();
	await again.signIn("lina@school.example");
	assert.match((await again.get("/p/mijn")).body, /class="badge">Bezig</, "the link and the progress came back");
	const there = await again.get(path);
	assert.match(there.body, /Bezig · stap 2 van 4/);
	const resumed = await again.post(path, formFor(there.body, "verder"));
	assert.match(resumed.body, /aria-current="step">Leren<\//, "she continues where she paused");
	// the unused link code still works once, on the restored copy only as on the original
	const noorBrowser = r.student();
	await noorBrowser.signIn("noor@school.example");
	await noorBrowser.link(noorCode);
	assert.equal((await noorBrowser.get("/p/mijn")).status, 200);
	// the student's own controls work on restored data: clearing it deletes the restored row
	const data = await again.get("/p/mijn/gegevens");
	assert.match(data.body, /Prikkel en reactie/);
	const cleared = await again.post("/p/mijn/gegevens/wissen", { csrf: csrfOf(data.body), zeker: "1" });
	assert.ok(cleared.status === 303 || cleared.status === 200, `${cleared.status}`);
	assert.equal((await restored.pool.query("SELECT count(*)::int AS n FROM assignment_progress")).rows[0].n, 0);
	assert.equal((await source.pool.query("SELECT count(*)::int AS n FROM assignment_progress")).rows[0].n, 1, "the original is untouched");
});

// ── a real browser: keyboard only, three widths, JavaScript off ─────────────────────────────────

/** An HTTPS front on the plain test server, answering as breinhap.com and management.breinhap.com. */
async function httpsFront(port, dir) {
	execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=breinhap.com", "-addext", "subjectAltName=DNS:breinhap.com,DNS:management.breinhap.com", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
	const requests = [];
	const server = createServer({ key: await readFile(join(dir, "key.pem")), cert: await readFile(join(dir, "cert.pem")) }, (req, res) => {
		requests.push(`${req.headers.host}${req.url}`);
		const upstream = http.request({ hostname: "127.0.0.1", port, path: req.url, method: req.method, headers: req.headers }, (back) => {
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

test("browser, keyboard only at 320, 390 and 1280 px: the student's homework and data page, and the teacher's overview", async () => {
	const dir = await mkdtemp(join(tmpdir(), "breinhap-gate-browser-"));
	const w = await matrixWorld();
	let chrome;
	let front;
	try {
		front = await httpsFront(w.g.server.address().port, dir);
		chrome = await chromium.launch({
			headless: true,
			...(process.env.BREINHAP_TEST_CHROMIUM ? { executablePath: process.env.BREINHAP_TEST_CHROMIUM } : {}),
			args: ["--no-proxy-server", `--host-resolver-rules=MAP breinhap.com:443 ${front.endpoint}, MAP management.breinhap.com:443 ${front.endpoint}`],
		});
		const [adultName, adultValue] = w.callers.teacher.cookie.split("=");
		for (const [width, height] of [[320, 640], [390, 800], [1280, 800]]) {
			// a classmate of Lina's per width, signed in and linked: the group's homework reaches them
			const learnerId = await w.g.directory.createLearner(adminPrincipal, { displayName: `Leerling ${width}`, schoolYear: 3 });
			await w.g.directory.addToGroup(adminPrincipal, { groupId: w.group, learnerId });
			const pupil = w.g.student();
			await pupil.signIn(`leerling${width}@school.example`);
			await pupil.link((await w.g.learnerAccounts.createCode(adminPrincipal, learnerId)).code);
			const context = await chrome.newContext({ ignoreHTTPSErrors: true, locale: "nl-BE", viewport: { width, height }, javaScriptEnabled: false, reducedMotion: "reduce" });
			await context.addCookies([
				{ name: "__Secure-bh-student", value: pupil.jar.get("__Secure-bh-student"), domain: "breinhap.com", path: "/p", secure: true, httpOnly: true, sameSite: "Lax" },
				{ name: adultName, value: adultValue, url: ORIGIN, secure: true, httpOnly: true, sameSite: "Lax" },
			]);
			const page = await context.newPage();
			const fits = async (where) => {
				const metrics = await (await context.newCDPSession(page)).send("Page.getLayoutMetrics");
				assert.ok(metrics.cssContentSize.width <= width, `overflow on ${where} at ${width}px: ${metrics.cssContentSize.width}`);
			};
			/** Tab until the focused element names `name`, then press `key` and wait for the next page. */
			const reach = async (name, key = "Enter") => {
				for (let i = 0; i < 60; i++) {
					await page.keyboard.press("Tab");
					const focused = page.locator(":focus");
					const text = (await focused.count()) ? await focused.innerText().catch(() => "") : "";
					if (typeof name === "string" ? text.includes(name) : name.test(text)) {
						// every link and button here loads a new page (a GET or a form POST to the same URL):
						// wait for it, so the next Tab never lands on the page being left
						await Promise.all([page.waitForEvent("load"), page.keyboard.press(key)]);
						return;
					}
				}
				assert.fail(`"${name}" cannot be reached with Tab at ${width}px`);
			};

			await page.goto(`${PUBLIC}/p/mijn`);
			assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "Mijn opdrachten");
			await fits("/p/mijn");
			await reach("Prikkel en reactie");
			await page.waitForURL(`${PUBLIC}/p/mijn/${w.assignment.id}`);
			await fits("the assignment page");
			await reach("Start");
			await fits("a step");
			await reach(/^Verder$/);
			await fits("the next step");
			await reach("Pauzeren");
			await page.getByRole("heading", { name: "Gepauzeerd" }).waitFor();
			await fits("the pause page");
			await page.goto(`${PUBLIC}/p/mijn/gegevens`);
			assert.equal(await page.getByRole("main").count(), 1);
			await fits("/p/mijn/gegevens");

			// the teacher's overview on management, at the same width
			await page.goto(`${ORIGIN}/bibliotheek/toewijzen`);
			assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "Inhoud toewijzen");
			await fits("/bibliotheek/toewijzen");
			await context.close();
		}
		// every request went to the two Hosts; nothing to a third party
		assert.ok(front.requests.every((r) => /^(breinhap\.com|management\.breinhap\.com)\//.test(r)), front.requests.find((r) => !/^(breinhap\.com|management\.breinhap\.com)\//.test(r)));
	} finally {
		await chrome?.close();
		if (front) await new Promise((resolve) => front.server.close(resolve));
		await rm(dir, { recursive: true, force: true });
	}
});
