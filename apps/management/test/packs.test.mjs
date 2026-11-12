// breinhap#80: authoring practice packs from the content library, over the real HTTP server
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

const internal = (cookie) =>
	Object.assign(Readable.from([""]), { method: "GET", headers: { cookie, origin: ORIGIN } });

async function stack({ withDirectory = true, uploadsOf, extractionsOf, locale = "" } = {}) {
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
const people = {
	teacher: { sub: "teacher", role: "breinhap.teacher" },
	tutor: { sub: "tutor", role: "breinhap.tutor" },
	parent: { sub: "parent", role: "breinhap.parent" },
	admin: { sub: "admin", role: "breinhap.admin" },
};
const sources = [{ kind: "own", title: "Eigen werk" }];
const object = (id, title = "Prikkel en reactie") => ({
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
const post = (fields, who) => {
	const body = new URLSearchParams();
	for (const [key, value] of Object.entries({ ...fields, csrf: fields.csrf ?? who.csrf }))
		for (const v of [].concat(value)) body.append(key, v);
	return { who, method: "POST", raw: { body: body.toString() } };
};
const packFields = (extra = {}) => ({
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
async function world() {
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
const row = async (id) => (await pool.query("SELECT draft, draft_version AS v, archived_at AS archived FROM practice_packs WHERE id=$1", [id])).rows[0];

// ── tests ───────────────────────────────────────────────────────────────────────────────────────
test("/bibliotheek/packs is its own route, not a learning-object id", async () => {
	const { s, teacher } = await world();
	const list = await s.call("/bibliotheek/packs", { who: teacher });
	assert.equal(list.status, 200);
	assert.match(list.body, /Nieuw oefenpakket/);
	assert.doesNotMatch(list.body, /bestaat niet of is niet van jou/);
	assert.equal((await s.call("/bibliotheek/packs/nieuw", { who: teacher })).status, 200);
	assert.equal((await s.call("/bibliotheek/packs/geen-uuid", { who: teacher })).status, 404);
	assert.equal((await s.call("/bibliotheek/packs/00000000-0000-4000-8000-000000000000", { who: teacher })).status, 404);
	assert.match((await s.call("/bibliotheek", { who: teacher })).body, /href="\/bibliotheek\/packs"/);
});

test("only the owning author authors: admins and anonymous are refused, other owners get 404", async () => {
	const { s, teacher, create } = await world();
	const id = await create();
	const admin = await s.login("admin");
	assert.equal((await s.call("/bibliotheek/packs", { who: admin })).status, 403);
	assert.equal((await s.call("/bibliotheek/packs/nieuw", post(packFields(), admin))).status, 403);
	assert.equal((await s.call(`/bibliotheek/packs/${id}`, { who: admin })).status, 403);
	assert.equal((await s.call(`/bibliotheek/packs/${id}/voorbeeld`, { who: admin })).status, 403);
	const anonymous = await s.call("/bibliotheek/packs");
	assert.equal(anonymous.status, 303);
	assert.match(anonymous.headers.location, /\/login/);
	const tutor = await s.login("tutor");
	assert.doesNotMatch((await s.call("/bibliotheek/packs", { who: tutor })).body, /Prikkels oefenen/);
	for (const path of [`/bibliotheek/packs/${id}`, `/bibliotheek/packs/${id}/voorbeeld`])
		assert.equal((await s.call(path, { who: tutor })).status, 404);
	for (const action of ["dupliceren", "archiveren"])
		assert.equal((await s.call(`/bibliotheek/packs/${id}/${action}`, post({}, tutor))).status, 404);
	assert.equal((await s.call(`/bibliotheek/packs/${id}`, post({ ...packFields(), expectedVersion: "1" }, tutor))).status, 404);
	assert.equal((await row(id)).v, 1);
	assert.equal((await s.call("/bibliotheek/packs", { who: teacher })).status, 200);
});

test("a pack is created from the author's own missions; the server derives references and ignores review fields", async () => {
	const { s, teacher, create } = await world();
	const form = await s.call("/bibliotheek/packs/nieuw", { who: teacher });
	assert.match(form.body, /Prikkel en reactie \(revisie 1\)/);
	assert.doesNotMatch(form.body, /Van een ander/);
	const id = await create({
		reviewed: "true",
		publicationId: "11111111-1111-4111-8111-111111111111",
		publicationHash: "x".repeat(43),
		"review.status": "reviewed",
	});
	const stored = (await row(id)).draft;
	assert.equal(stored.missionRefs[0].revision, 1);
	assert.match(stored.missionRefs[0].revisionHash, /^[A-Za-z0-9_-]{43}$/);
	assert.equal(stored.missionRefs[0].publicationId, undefined);
	assert.equal(stored.review, undefined);
	const page = await s.call(`/bibliotheek/packs/${id}`, { who: teacher });
	assert.equal(page.status, 200);
	assert.match(page.body, /Opgeslagen|value="Prikkels oefenen"/);
	assert.match(page.body, /Delen is uitgeschakeld/);
	assert.match(page.body, /Vastgelegd, nog niet aangeboden/);
	assert.match(page.body, /value="lo-a\|lo-a-m1"\s+selected|selected>Wat is een prikkel/);
});

test("invalid input keeps what was typed, names the field, and stores nothing", async () => {
	const { s, teacher } = await world();
	const count = async () => (await pool.query("SELECT count(*)::int AS n FROM practice_packs WHERE workspace_id=$1", [s.workspace])).rows[0].n;
	const before = await count();
	const bad = await s.call("/bibliotheek/packs/nieuw", post(packFields({ titel: "<b>Mijn titel</b>", missie1: "", beschrijving: "Bewaard & getypt" }), teacher));
	assert.equal(bad.status, 422);
	assert.match(bad.body, /Kies minstens één missie/);
	assert.match(bad.body, /&lt;b&gt;Mijn titel&lt;\/b&gt;/);
	assert.doesNotMatch(bad.body, /<b>Mijn titel/);
	assert.match(bad.body, /Bewaard &amp; getypt/);
	assert.match(bad.body, /role="alert"/);
	// a missing title, a foreign object, a missing mission and a bad language
	const noTitle = await s.call("/bibliotheek/packs/nieuw", post(packFields({ titel: "" }), teacher));
	assert.equal(noTitle.status, 422);
	assert.match(noTitle.body, /id="fout-titel"/);
	const foreign = await s.call("/bibliotheek/packs/nieuw", post(packFields({ missie1: "lo-t|lo-t-m1" }), teacher));
	assert.equal(foreign.status, 422);
	assert.match(foreign.body, /niet van jou/);
	const gone = await s.call("/bibliotheek/packs/nieuw", post(packFields({ missie1: "lo-a|lo-a-m9" }), teacher));
	assert.match(gone.body, /deze missie niet/);
	const language = await s.call("/bibliotheek/packs/nieuw", post(packFields({ taal: "xx" }), teacher));
	assert.equal(language.status, 422);
	// the same mission twice is refused
	const twice = await s.call("/bibliotheek/packs/nieuw", post(packFields({ missie2: "lo-a|lo-a-m1" }), teacher));
	assert.equal(twice.status, 422);
	assert.equal(await count(), before);
});

test("questions come only from the chosen objects, at most six, and an unknown one is refused", async () => {
	const { s, teacher, create } = await world();
	const id = await create({ missie2: "lo-b|lo-b-m1", vraag: ["lo-a|lo-a-m1|practice|0", "lo-b|lo-b-m1|check|0"] });
	assert.deepEqual((await row(id)).draft.assessmentRefs.map((r) => `${r.objectId}:${r.stage}:${r.questionIndex}`), ["lo-a:practice:0", "lo-b:check:0"]);
	const page = await s.call(`/bibliotheek/packs/${id}`, { who: teacher });
	assert.match(page.body, /Extra vragen/);
	for (const vraag of ["lo-a|lo-a-m1|practice|3", "lo-t|lo-t-m1|check|0", "lo-a|lo-a-m1|oops|0"]) {
		const res = await s.call("/bibliotheek/packs/nieuw", post(packFields({ vraag }), teacher));
		assert.equal(res.status, 422, vraag);
	}
	// a question from an object that is not among the chosen missions is refused by the model
	const stray = await s.call("/bibliotheek/packs/nieuw", post(packFields({ vraag: "lo-b|lo-b-m1|check|0" }), teacher));
	assert.equal(stray.status, 422);
});

test("concurrent edits never overwrite silently: a stale save is refused with the typed values kept", async () => {
	const { s, teacher, create } = await world();
	const id = await create();
	const first = await s.call(`/bibliotheek/packs/${id}`, post({ ...packFields({ titel: "Eerste wijziging" }), expectedVersion: "1" }, teacher));
	assert.equal(first.status, 303);
	const stale = await s.call(`/bibliotheek/packs/${id}`, post({ ...packFields({ titel: "Tweede, verouderde wijziging" }), expectedVersion: "1" }, teacher));
	assert.equal(stale.status, 409);
	assert.match(stale.body, /Je wijzigingen zijn niet opgeslagen/);
	assert.match(stale.body, /Tweede, verouderde wijziging/);
	assert.match(stale.body, /name="expectedVersion" value="2"/);
	const stored = await row(id);
	assert.equal(stored.draft.title, "Eerste wijziging");
	assert.equal(stored.v, 2);
	// the explicit second save, on the newest version, is the owner's choice
	assert.equal((await s.call(`/bibliotheek/packs/${id}`, post({ ...packFields({ titel: "Bewust overschreven" }), expectedVersion: "2" }, teacher))).status, 303);
	assert.equal((await row(id)).draft.title, "Bewust overschreven");
	// a missing or garbage version is stale, never a free overwrite
	assert.equal((await s.call(`/bibliotheek/packs/${id}`, post(packFields(), teacher))).status, 409);
});

test("every POST needs the session's CSRF token and the management origin", async () => {
	const { s, teacher, create } = await world();
	const id = await create();
	for (const path of ["/bibliotheek/packs/nieuw", `/bibliotheek/packs/${id}`, `/bibliotheek/packs/${id}/dupliceren`, `/bibliotheek/packs/${id}/archiveren`]) {
		const noToken = await s.call(path, post({ ...packFields(), expectedVersion: "2", csrf: "wrong" }, teacher));
		assert.equal(noToken.status, 403, path);
		const foreignOrigin = await s.call(path, { ...post({ ...packFields(), expectedVersion: "2" }, teacher), origin: "https://evil.example" });
		assert.equal(foreignOrigin.status, 403, path);
	}
	assert.equal((await row(id)).archived, null);
	assert.equal((await pool.query("SELECT count(*)::int AS n FROM practice_packs WHERE workspace_id=$1", [s.workspace])).rows[0].n, 1);
	assert.equal((await s.call(`/bibliotheek/packs/${id}`, { who: teacher, method: "DELETE" })).status, 405);
});

test("preview shows the mission read-only and writes no link, session, attempt, answer or progress", async () => {
	const { s, teacher, counts, create } = await world();
	const id = await create({ vraag: "lo-a|lo-a-m1|check|0" });
	const before = { counts: await counts(), pack: await row(id) };
	const page = await s.call(`/bibliotheek/packs/${id}/voorbeeld`, { who: teacher });
	assert.equal(page.status, 200);
	assert.match(page.body, /Voorbeeld van het oefenpakket/);
	assert.match(page.body, /Terug naar het oefenpakket/);
	assert.match(page.headers["cache-control"], /no-store/);
	assert.match(page.headers["x-robots-tag"], /noindex/);
	assert.equal(page.headers["set-cookie"], undefined);
	const second = await s.call(`/bibliotheek/packs/${id}/voorbeeld?missie=1&stap=3`, { who: teacher });
	assert.equal(second.status, 200);
	assert.match(second.body, /Zet in volgorde|Wat is een prikkel/);
	assert.deepEqual(await counts(), before.counts);
	assert.deepEqual(await row(id), before.pack);
	assert.equal((await s.call(`/bibliotheek/packs/${id}/voorbeeld`, post({}, teacher))).status, 405);
});

test("duplicate makes a new identity without links, attempts or publication authority; archive hides the pack", async () => {
	const { s, teacher, counts, create } = await world();
	const id = await create();
	const before = await counts();
	const dup = await s.call(`/bibliotheek/packs/${id}/dupliceren`, post({}, teacher));
	assert.equal(dup.status, 303);
	const copy = /packs\/([0-9a-f-]{36})/.exec(dup.headers.location)[1];
	assert.notEqual(copy, id);
	assert.equal((await row(copy)).draft.title, "Prikkels oefenen");
	assert.deepEqual(await counts(), before);
	assert.match((await s.call(dup.headers.location, { who: teacher })).body, /Dit is een kopie/);
	const archived = await s.call(`/bibliotheek/packs/${id}/archiveren`, post({}, teacher));
	assert.equal(archived.status, 303);
	assert.equal(archived.headers.location, "/bibliotheek/packs?gearchiveerd=1");
	assert.notEqual((await row(id)).archived, null);
	assert.equal((await s.call(`/bibliotheek/packs/${id}`, { who: teacher })).status, 404);
	const list = await s.call("/bibliotheek/packs", { who: teacher });
	assert.ok(list.body.includes(copy) && !list.body.includes(id));
	// filters only narrow the owner's own list
	assert.match((await s.call("/bibliotheek/packs?q=prikkels&vak=biologie&jaar=3", { who: teacher })).body, /Prikkels oefenen/);
	assert.doesNotMatch((await s.call("/bibliotheek/packs?vak=wiskunde", { who: teacher })).body, /Prikkels oefenen/);
});

test("sharing stays blocked until the exact revision is independently approved and published", async () => {
	const { s, content, teacher, create } = await world();
	const id = await create();
	const directory = s.directory;
	const publishing = new PublishingStore({ content });
	const reviewer = people.parent;
	const publisher = { sub: "publisher", role: "breinhap.teacher" };
	await directory.grantCapability(people.admin, reviewer, "content.review");
	await directory.grantCapability(people.admin, publisher, "content.publish");
	const blocked = (await s.call(`/bibliotheek/packs/${id}`, { who: teacher })).body;
	assert.match(blocked, /Delen is uitgeschakeld/);
	await content.submit(people.teacher, "lo-a", 1);
	assert.match((await s.call(`/bibliotheek/packs/${id}`, { who: teacher })).body, /Ter nakijking/);
	await content.review(reviewer, "lo-a", 1, "approved");
	const approved = (await s.call(`/bibliotheek/packs/${id}`, { who: teacher })).body;
	assert.match(approved, /Goedgekeurd, nog niet gepubliceerd/);
	assert.match(approved, /Delen is uitgeschakeld/);
	const publication = await publishing.publish(publisher, "lo-a", 1);
	// the saved reference predates the publication, so it is not yet the exact published one
	assert.match((await s.call(`/bibliotheek/packs/${id}`, { who: teacher })).body, /Delen is uitgeschakeld/);
	const saved = await s.call(`/bibliotheek/packs/${id}`, post({ ...packFields(), expectedVersion: "1" }, teacher));
	assert.equal(saved.status, 303);
	const ref = (await row(id)).draft.missionRefs[0];
	assert.equal(ref.publicationId, publication.id);
	const ready = (await s.call(`/bibliotheek/packs/${id}`, { who: teacher })).body;
	assert.match(ready, /Alle bronnen zijn gepubliceerd/);
	assert.doesNotMatch(ready, /Delen is uitgeschakeld/);
});
