// Shared fixtures for the practice-pack suites (breinhap#80-#82). Authoring practice packs from the content library, over the real HTTP server
// (identity adapter with a fake OIDC provider, Redis, Postgres). The literal /bibliotheek/packs route
// is reserved before the object-id matcher; ownership, role, CSRF and optimistic concurrency hold;
// the server derives revision/publication data (no form field can make a draft shareable); preview
// writes nothing.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import pg from "pg";

import { ContentStore } from "../src/content.mjs";
import { migrate } from "../src/db.mjs";
import { Directory } from "../src/directory.mjs";
import { createIdentity, ORIGIN } from "../src/identity.mjs";
import { PublishingStore } from "../src/publishing.mjs";
import { createManagementServer } from "../src/server.mjs";
import { makeStore, member } from "./helpers.mjs";

// ── over HTTP ───────────────────────────────────────────────────────────────────────────────────

let admin;
let pool;
export const getPool = () => pool;
const servers = [];
const database = `breinhap_test_${randomBytes(6).toString("hex")}`;
before(async () => {
	if (!process.env.POSTGRES_TEST_URL)
		throw new Error("Use pnpm --filter @breinhap/management test, or set POSTGRES_TEST_URL for this suite");
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
	// the server allows a slow upload up to two minutes; tests must not wait for idle keep-alive sockets
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

export const internal = (cookie) =>
	Object.assign(Readable.from([""]), { method: "GET", headers: { cookie, origin: ORIGIN } });

export async function stack({ withDirectory = true, uploadsOf, extractionsOf, locale = "" } = {}) {
	let next = "teacher";
	const time = Date.now();
	const store = await makeStore(() => time);
	const rows = new Map([
		["admin", "breinhap.admin"],
		["teacher", "breinhap.teacher"],
		["tutor", "breinhap.tutor"],
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
			authTime: Math.floor(time / 1000),
			accessToken: "access",
			refreshToken: "refresh",
			expiresIn: 3600,
		}),
		userInfo: async (_token, sub) => ({ sub }),
		refresh: async () => ({ accessToken: "a", refreshToken: "r", expiresIn: 3600 }),
		logoutUrl: () => `${ORIGIN}/login`,
	};
	for (const [sub, role] of rows) await member(store, sub, role);
	const identity = createIdentity({ provider, store, grants, now: () => time });
	const directory = withDirectory ? await new Directory({ pool, workspace: store.workspace }).ready() : undefined;
	async function login(sub) {
		next = sub;
		const started = await identity.handle(internal(""), new URL(`${ORIGIN}/auth/start`));
		const flow = started.headers["Set-Cookie"][0].split(";")[0];
		const state = new URL(started.headers.Location).searchParams.get("state");
		const done = await identity.handle(internal(flow), new URL(`${ORIGIN}/auth/callback?state=${state}&code=valid`));
		const cookie = done.headers["Set-Cookie"][0].split(";")[0];
		const probe = internal(cookie);
		await identity.current(probe);
		return { cookie, csrf: probe.managementSession.csrf };
	}
	const uploads = uploadsOf && directory ? uploadsOf(directory) : undefined;
	const extractions = extractionsOf && uploads ? extractionsOf(uploads) : undefined;
	const server = createManagementServer({ identity, directory, uploads, extractions });
	servers.push(server);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const call = (path, { who, method = "GET", form, origin = ORIGIN, raw, cookie = "", headers = {} } = {}) =>
		new Promise((resolve, reject) => {
			const body = raw ? raw.body : form ? new URLSearchParams({ ...form, csrf: form.csrf ?? who?.csrf ?? "" }).toString() : undefined;
			const req = http.request(
				{
					hostname: "127.0.0.1",
					port: server.address().port,
					path,
					method,
					headers: {
						Host: "management.breinhap.com",
						Cookie: [who?.cookie, cookie].filter(Boolean).join("; "),
						...(locale ? { "Accept-Language": locale } : {}),
						...headers,
						...(body ? { "Content-Type": raw?.contentType ?? "application/x-www-form-urlencoded", Origin: origin } : {}),
					},
				},
				(res) => {
					const chunks = [];
					res.on("data", (chunk) => chunks.push(chunk));
					res.on("end", () => {
						const bytes = Buffer.concat(chunks);
						resolve({ status: res.statusCode, headers: res.headers, body: bytes.toString("utf8"), bytes });
					});
				},
			);
			req.on("error", reject);
			req.end(body);
		});
	return { login, call, workspace: store.workspace, directory, uploads, extractions };
}

// ── fixtures ────────────────────────────────────────────────────────────────────────────────────
export const people = {
	teacher: { sub: "teacher", role: "breinhap.teacher" },
	tutor: { sub: "tutor", role: "breinhap.tutor" },
	parent: { sub: "parent", role: "breinhap.parent" },
	admin: { sub: "admin", role: "breinhap.admin" },
};
export const sources = [{ kind: "own", title: "Eigen werk" }];
export const object = (id, title = "Prikkel en reactie") => ({
	schemaVersion: 1,
	id,
	subject: "biologie",
	title,
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
				{ kind: "choice", prompt: "Wat is een prikkel?", options: ["Een verandering", "Een spier"], answerIndex: 0, explanation: "Een prikkel is een verandering." },
			],
			check: [
				{ kind: "order", prompt: "Zet in volgorde.", items: ["prikkel", "receptor", "reactie"], explanation: "Eerst de prikkel." },
			],
		},
	],
});
/** A body with repeated keys (the question checkboxes), CSRF included. */
export const post = (fields, who) => {
	const body = new URLSearchParams();
	for (const [key, value] of Object.entries({ ...fields, csrf: fields.csrf ?? who.csrf }))
		for (const v of [].concat(value)) body.append(key, v);
	return { who, method: "POST", raw: { body: body.toString() } };
};
export const packFields = (extra = {}) => ({
	titel: "Prikkels oefenen",
	beschrijving: "Een korte oefening.",
	instructies: "Lees rustig en kies.",
	vak: "biologie",
	jaar: "3",
	taal: "nl",
	modus: "practice",
	verloopDagen: "7",
	missie1: "lo-a|lo-a-m1",
	...extra,
});
export async function world() {
	const s = await stack();
	const content = new ContentStore({ directory: s.directory });
	const teacher = await s.login("teacher");
	for (const id of ["lo-a", "lo-b"]) {
		await content.create(people.teacher, object(id, id === "lo-a" ? "Prikkel en reactie" : "Tweede object"), sources);
		await content.snapshot(people.teacher, id, 1);
	}
	await content.create(people.tutor, object("lo-t", "Van een ander"), sources);
	await content.snapshot(people.tutor, "lo-t", 1);
	const counts = async () =>
		Object.fromEntries(
			await Promise.all(
				["practice_pack_versions", "practice_share_links", "practice_link_sessions", "practice_attempts", "practice_answers"].map(async (t) => [
					t,
					(await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n,
				]),
			),
		);
	const create = async (extra = {}) => {
		const res = await s.call("/bibliotheek/packs/nieuw", post(packFields(extra), teacher));
		assert.equal(res.status, 303, res.body);
		return /packs\/([0-9a-f-]{36})/.exec(res.headers.location)[1];
	};
	return { s, content, teacher, counts, create };
}
export const row = async (id) => (await pool.query("SELECT draft, draft_version AS v, archived_at AS archived FROM practice_packs WHERE id=$1", [id])).rows[0];


// ── breinhap#81: freeze a version, mint, rotate and revoke the single link ───────────────────────

export const URL_TOKEN = /https:\/\/breinhap\.com\/p\/#([A-Za-z0-9_-]{43})/;
/** An independently approved and published object `lo-a`, and a pack on it. */
export async function shareable() {
	const w = await world();
	const publishing = new PublishingStore({ content: w.content });
	const reviewer = people.parent;
	const publisher = { sub: "publisher", role: "breinhap.teacher" };
	await w.s.directory.grantCapability(people.admin, reviewer, "content.review");
	await w.s.directory.grantCapability(people.admin, publisher, "content.publish");
	await w.content.submit(people.teacher, "lo-a", 1);
	await w.content.review(reviewer, "lo-a", 1, "approved");
	await publishing.publish(publisher, "lo-a", 1);
	const id = await w.create();
	// the reference must be re-saved after publication so that it carries the publication
	const saved = await w.s.call(`/bibliotheek/packs/${id}`, post({ ...packFields(), expectedVersion: "1" }, w.teacher));
	assert.equal(saved.status, 303);
	return { ...w, id, publishing, publisher };
}
export const draftVersion = async (id) => (await row(id)).v;
export const mint = (w, fields = {}, who = w.teacher) =>
	w.s.call(`/bibliotheek/packs/${w.id}/links/nieuw`, post({ version: "1", nonce: randomBytes(12).toString("base64url"), expiryDays: "7", ...fields }, who));
export const tokenOf = (res) => URL_TOKEN.exec(res.body)?.[1];
export const everywhere = async (needle) => {
	const tables = (await pool.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema='public'")).rows;
	const hits = [];
	for (const { t } of tables) {
		const found = (await pool.query(`SELECT count(*)::int AS n FROM "${t}" x WHERE x::text LIKE $1`, [`%${needle}%`])).rows[0].n;
		if (found) hits.push(t);
	}
	return hits;
};


// ── the public learner, as a browser with its own cookie jar (breinhap#82/#83) ───────────────────
export const unescapeHtml = (v) => v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
export const hiddenOf = (html) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((m) => [m[1], unescapeHtml(m[2])]));

/** A browser: its own cookie jar and nothing else. */
export function browser(w) {
	const jar = new Map();
	const api = {
		jar,
		cookieHeader: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
		async get(path, { headers = {}, host = "breinhap.com" } = {}) {
			const res = await w.s.call(path, { cookie: api.cookieHeader(), headers: { ...headers, Host: host } });
			api.store(res);
			return res;
		},
		async post(path, fields, { origin = "https://breinhap.com", host = "breinhap.com", cookie, headers = {} } = {}) {
			const body = new URLSearchParams(fields).toString();
			const res = await w.s.call(path, { method: "POST", raw: { body }, origin, cookie: cookie ?? api.cookieHeader(), headers: { ...headers, Host: host } });
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
export async function step(b, right = true, seen = []) {
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
export async function finish(b, right = true, seen = []) {
	for (let i = 0; i < 40; i++) if ((await step(b, right, seen)).done) return;
	assert.fail("the pack never ended");
}

/** A published object, a frozen version and a live link (token). */
export async function linked(extra = {}) {
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
export const count = async (table, id) => (await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${table === "practice_share_links" ? "pack_id" : "pack_id"}=$1`, [id])).rows[0].n;

