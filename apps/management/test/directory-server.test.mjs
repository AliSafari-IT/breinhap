// breinhap#25 through the real HTTP server: the identity adapter (with a fake OIDC provider), the
// Redis store and the Postgres directory. Who may open and change "Leerlingen en groepen", what an
// adult's "Leerlingen" page shows, and that revoking a membership ends the adult's links.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import pg from "pg";

import { migrate } from "../src/db.mjs";
import { Directory } from "../src/directory.mjs";
import { createIdentity, ORIGIN } from "../src/identity.mjs";
import { createManagementServer } from "../src/server.mjs";
import { makeStore, member } from "./helpers.mjs";

let admin;
let pool;
const servers = [];
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
	await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
	await pool?.end();
	await admin?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
	await admin?.end();
});

const internal = (cookie) =>
	Object.assign(Readable.from([""]), { method: "GET", headers: { cookie, origin: ORIGIN } });

/** A workspace with an administrator, a teacher and a parent, all signed in; and the HTTP client. */
async function stack({ withDirectory = true } = {}) {
	let next = "admin";
	let authAge = 0;
	const time = Date.now();
	const store = await makeStore(() => time);
	const rows = new Map([
		["admin", "breinhap.admin"],
		["teacher", "breinhap.teacher"],
		["parent", "breinhap.parent"],
	]);
	const grants = async (sub) => ({
		appId: "breinhap",
		subject: sub,
		state: "active",
		roles: [rows.get(sub) ?? "breinhap.student"],
		permissions: rows.has(sub)
			? ["breinhap.management.access", ...(sub === "admin" ? ["breinhap.memberships.manage"] : [])]
			: ["breinhap.student.access"],
	});
	const provider = {
		authorizationUrl: async (flow) => `https://id.asafarim.site/auth?state=${flow.state}`,
		exchange: async () => ({
			sub: next,
			sid: `sid-${next}-${randomBytes(4).toString("hex")}`,
			issuedAt: Math.floor(time / 1000),
			authTime: Math.floor(time / 1000) - authAge,
			accessToken: "access",
			refreshToken: "refresh",
			expiresIn: 3600,
		}),
		userInfo: async (_token, sub) => ({ sub }),
		refresh: async () => ({ accessToken: "a", refreshToken: "r", expiresIn: 3600 }),
		logoutUrl: () => `${ORIGIN}/login`,
	};
	await member(store, "admin", "breinhap.admin");
	await member(store, "teacher", "breinhap.teacher");
	await member(store, "parent", "breinhap.parent");
	const identity = createIdentity({ provider, store, grants, now: () => time });
	const directory = withDirectory
		? await new Directory({ pool, workspace: store.workspace }).ready()
		: undefined;
	async function login(sub, age = 0) {
		next = sub;
		authAge = age;
		const started = await identity.handle(internal(""), new URL(`${ORIGIN}/auth/start`));
		const flow = started.headers["Set-Cookie"][0].split(";")[0];
		const state = new URL(started.headers.Location).searchParams.get("state");
		const done = await identity.handle(
			internal(flow),
			new URL(`${ORIGIN}/auth/callback?state=${state}&code=valid`),
		);
		const cookie = done.headers["Set-Cookie"][0].split(";")[0];
		const probe = internal(cookie);
		await identity.current(probe);
		return { cookie, csrf: probe.managementSession.csrf };
	}
	const server = createManagementServer({ identity, directory });
	servers.push(server);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const call = (path, { cookie = "", method = "GET", form } = {}) =>
		new Promise((resolve, reject) => {
			const body = form ? new URLSearchParams(form).toString() : undefined;
			const req = http.request(
				{
					hostname: "127.0.0.1",
					port: server.address().port,
					path,
					method,
					headers: {
						Host: "management.breinhap.com",
						Cookie: cookie,
						...(body
							? { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN }
							: {}),
					},
				},
				(res) => {
					let text = "";
					res.setEncoding("utf8");
					res.on("data", (chunk) => {
						text += chunk;
					});
					res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
				},
			);
			req.on("error", reject);
			req.end(body);
		});
	return { store, directory, login, call };
}

test("administrators manage learners, groups and links; the linked teacher then sees only that group", async () => {
	const s = await stack();
	const boss = await s.login("admin");
	const post = (path, form) =>
		s.call(path, { cookie: boss.cookie, method: "POST", form: { ...form, csrf: boss.csrf } });

	assert.equal((await post("/beheer/leerlingen/nieuw", { displayName: "Ann", schoolYear: "3" })).status, 303);
	assert.equal((await post("/beheer/leerlingen/nieuw", { displayName: "Bo", schoolYear: "3" })).status, 303);
	assert.equal((await post("/beheer/groepen/nieuw", { name: "3B" })).status, 303);
	const view = await s.directory.overview({ sub: "admin", role: "breinhap.admin" });
	const ann = view.learners.find((l) => l.displayName === "Ann").id;
	const klas = view.groups[0].id;
	assert.equal((await post("/beheer/groepen/toevoegen", { group: klas, learner: ann })).status, 303);
	assert.equal((await post("/beheer/koppelingen/nieuw", { subject: "teacher", target: `group:${klas}` })).status, 303);

	const page = await s.call("/beheer/leerlingen", { cookie: boss.cookie });
	assert.equal(page.status, 200);
	assert.match(page.body, /Leerlingen en groepen/);
	assert.match(page.body, /3B/);

	const teacher = await s.login("teacher");
	const mine = await s.call("/leerlingen", { cookie: teacher.cookie });
	assert.equal(mine.status, 200);
	assert.match(mine.body, /Ann/);
	assert.doesNotMatch(mine.body, /Bo\b/);

	const parent = await s.login("parent");
	const none = await s.call("/leerlingen", { cookie: parent.cookie });
	assert.equal(none.status, 200);
	assert.doesNotMatch(none.body, /Ann|Bo\b/);
	assert.match(none.body, /nog geen leerlingen aan jou gekoppeld/);
});

test("refusals: wrong role for the target, linking yourself, and a non-admin, a stale sign-in or a forged CSRF token change nothing", async () => {
	const s = await stack();
	const boss = await s.login("admin");
	const post = (who, path, form) =>
		s.call(path, { cookie: who.cookie, method: "POST", form: { ...form, csrf: who.csrf } });
	await post(boss, "/beheer/groepen/nieuw", { name: "3B" });
	const [klas] = await s.directory.groups({ sub: "admin", role: "breinhap.admin" });

	const mismatch = await post(boss, "/beheer/koppelingen/nieuw", { subject: "parent", target: `group:${klas.id}` });
	assert.equal(mismatch.status, 409);
	assert.match(mismatch.body, /past niet bij deze koppeling/);
	const self = await post(boss, "/beheer/koppelingen/nieuw", { subject: "admin", target: `group:${klas.id}` });
	assert.equal(self.status, 409);
	assert.match(self.body, /jezelf geen koppeling/);
	const stranger = await post(boss, "/beheer/koppelingen/nieuw", { subject: "nobody", target: `group:${klas.id}` });
	assert.equal(stranger.status, 409);

	const teacher = await s.login("teacher");
	assert.equal((await post(teacher, "/beheer/leerlingen/nieuw", { displayName: "X", schoolYear: "3" })).status, 403);
	assert.equal((await s.call("/beheer/leerlingen", { cookie: teacher.cookie })).status, 403);
	const stale = await s.login("admin", 301);
	const staleList = await s.call("/beheer/leerlingen", { cookie: stale.cookie });
	assert.equal(staleList.status, 200);
	assert.match(staleList.body, /Bevestig opnieuw je identiteit om wijzigingen te maken/);
	assert.equal((await post(stale, "/beheer/leerlingen/nieuw", { displayName: "X", schoolYear: "3" })).status, 428);
	const forged = await s.call("/beheer/leerlingen/nieuw", {
		cookie: boss.cookie,
		method: "POST",
		form: { displayName: "X", schoolYear: "3", csrf: "forged" },
	});
	assert.equal(forged.status, 403);
	assert.deepEqual(await s.directory.learners({ sub: "admin", role: "breinhap.admin" }), []);
	assert.deepEqual(
		(await s.directory.overview({ sub: "admin", role: "breinhap.admin" })).links,
		[],
	);
});

test("revoking a membership ends the adult's links and extra rights", async () => {
	const s = await stack();
	const boss = await s.login("admin");
	const post = (path, form) =>
		s.call(path, { cookie: boss.cookie, method: "POST", form: { ...form, csrf: boss.csrf } });
	await post("/beheer/leerlingen/nieuw", { displayName: "Ann", schoolYear: "3" });
	const [ann] = await s.directory.learners({ sub: "admin", role: "breinhap.admin" });
	await post("/beheer/koppelingen/nieuw", { subject: "parent", target: `learner:${ann.id}` });
	await post("/beheer/rechten/toekennen", { subject: "parent", capability: "content.review" });
	const parent = { sub: "parent", role: "breinhap.parent" };
	assert.equal((await s.directory.learners(parent)).length, 1);
	assert.equal(await s.directory.can(parent, "content.review"), true);

	assert.equal((await post("/beheer/intrekken", { subject: "parent" })).status, 200);
	assert.deepEqual(await s.directory.learners(parent), []);
	assert.equal(await s.directory.can(parent, "content.review"), false);
	assert.equal(await s.store.membership("parent"), null);
});

test("without the database the pages say they are not available, and nothing else changes", async () => {
	const s = await stack({ withDirectory: false });
	const boss = await s.login("admin");
	const admin = await s.call("/beheer/leerlingen", { cookie: boss.cookie });
	assert.equal(admin.status, 200);
	assert.match(admin.body, /nog niet ingericht/);
	const teacher = await s.login("teacher");
	const mine = await s.call("/leerlingen", { cookie: teacher.cookie });
	assert.equal(mine.status, 200);
	assert.match(mine.body, /nog niet ingericht/);
	assert.equal((await s.call("/", { cookie: teacher.cookie })).status, 200);
});

test("students and signed-out visitors never reach the learner and admin management pages", async () => {
	const s = await stack();
	assert.equal((await s.call("/leerlingen")).status, 303);
	assert.equal((await s.call("/beheer")).status, 303);
	assert.equal((await s.call("/beheer/leerlingen")).status, 303);
	const student = await s.login("student");
	const res = await s.call("/leerlingen", { cookie: student.cookie });
	assert.notEqual(res.status, 200);
	assert.doesNotMatch(res.body, /Mijn leerlingen/);
});
