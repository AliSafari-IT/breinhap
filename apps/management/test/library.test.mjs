// breinhap#27: the content library and mission editor. Unit tests for the form ⇄ learning-object
// mapping, then the real HTTP server (identity adapter with a fake OIDC provider, Redis, Postgres):
// create, field errors that keep the typed text, conflicts that never overwrite, duplicate, archive,
// snapshot, filters, and who may do any of it.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import pg from "pg";

import { validate } from "../src/content.mjs";
import { migrate } from "../src/db.mjs";
import { Directory } from "../src/directory.mjs";
import { createIdentity, ORIGIN } from "../src/identity.mjs";
import { fieldOf, fromForm, labelOf, toValues } from "../src/library.mjs";
import { createManagementServer } from "../src/server.mjs";
import { makeStore, member } from "./helpers.mjs";

/** The fields of a complete, valid learning object with one mission, as the editor posts them. */
const validFields = (id = "prikkel-reactie") => ({
	id,
	title: "Prikkel en reactie",
	subject: "biologie",
	grade: "3",
	"curriculum.leerdoel": "De leerlingen leggen prikkel en reactie uit.",
	"curriculum.references": "LPD 12\n\nLPD 13",
	"missions.0.title": "Wat is een prikkel?",
	"missions.0.id": "",
	"missions.0.minutes": "3",
	"missions.0.warmup.text": "Denk aan iets dat je laat schrikken.",
	"missions.0.learn.0.text": "Een prikkel is een verandering die je waarneemt.",
	"missions.0.learn.1.text": "",
	"missions.0.learn.2.text": "Een receptor neemt de prikkel waar.",
	"missions.0.practice.0.kind": "choice",
	"missions.0.practice.0.prompt": "Wat is een prikkel?",
	"missions.0.practice.0.options.0": "",
	"missions.0.practice.0.options.1": "Een verandering",
	"missions.0.practice.0.options.2": "Een spier",
	"missions.0.practice.0.answerIndex": "1",
	"missions.0.practice.0.explanation": "Een prikkel is een verandering in de omgeving.",
	"missions.0.practice.1.kind": "choice",
	"missions.0.check.0.kind": "order",
	"missions.0.check.0.prompt": "Zet in volgorde.",
	"missions.0.check.0.items.0": "prikkel",
	"missions.0.check.0.items.1": "receptor",
	"missions.0.check.0.items.2": "reactie",
	"missions.0.check.0.explanation": "Eerst de prikkel, dan de receptor, dan de reactie.",
	"missions.1.title": "",
	"sources.0.kind": "book",
	"sources.0.title": "Biologie voor jou 3",
});
const formOf = (fields) => new URLSearchParams(fields);

test("the form becomes a valid learning object: empty slots left out, the answer key follows the options", () => {
	const { object, sources, paths } = fromForm(formOf(validFields()));
	const { object: parsed } = validate(object, sources);
	const mission = parsed.missions[0];
	assert.equal(parsed.missions.length, 1);
	assert.equal(mission.id, "prikkel-reactie-m1");
	assert.deepEqual(mission.learn.map((c) => c.text).length, 2);
	assert.deepEqual(mission.practice[0].options, ["Een verandering", "Een spier"]);
	assert.equal(mission.practice[0].answerIndex, 0);
	assert.deepEqual(mission.check[0].items, ["prikkel", "receptor", "reactie"]);
	assert.deepEqual(parsed.curriculum.references, ["LPD 12", "LPD 13"]);
	assert.deepEqual(sources, [{ kind: "book", title: "Biologie voor jou 3" }]);
	// errors on the compact object point back at the form slot the person filled in
	assert.equal(paths.get("missions.0.learn.1"), "missions.0.learn.2");
	assert.equal(fieldOf("missions.0.learn.1.text", paths), "missions.0.learn.2.text");
	assert.equal(fieldOf("title", paths), "title");
	assert.equal(labelOf("missions.0.practice.1.options.2"), "Missie 1 · Oefenvraag 2 · Optie 3");
});

test("a stored object fills the form slot for slot, and comes back identical", () => {
	const { object, sources } = fromForm(formOf(validFields()));
	const { object: once } = validate(object, sources);
	const again = fromForm(formOf(toValues(once, sources)), once.id);
	assert.deepEqual(validate(again.object, again.sources).object, once);
});

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
	await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
	await pool?.end();
	await admin?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
	await admin?.end();
});

const internal = (cookie) =>
	Object.assign(Readable.from([""]), { method: "GET", headers: { cookie, origin: ORIGIN } });

async function stack({ withDirectory = true } = {}) {
	let next = "teacher";
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
	const server = createManagementServer({ identity, directory });
	servers.push(server);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const call = (path, { who, method = "GET", form, origin = ORIGIN } = {}) =>
		new Promise((resolve, reject) => {
			const body = form ? new URLSearchParams({ ...form, csrf: form.csrf ?? who?.csrf ?? "" }).toString() : undefined;
			const req = http.request(
				{
					hostname: "127.0.0.1",
					port: server.address().port,
					path,
					method,
					headers: {
						Host: "management.breinhap.com",
						Cookie: who?.cookie ?? "",
						...(body ? { "Content-Type": "application/x-www-form-urlencoded", Origin: origin } : {}),
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
	return { login, call, workspace: store.workspace };
}

test("an author creates, finds, edits and snapshots a learning object; the library shows its state", async () => {
	const s = await stack();
	const teacher = await s.login("teacher");
	const created = await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: validFields() });
	assert.equal(created.status, 303);
	assert.equal(created.headers.location, "/bibliotheek/prikkel-reactie?opgeslagen=1");

	const edit = await s.call(created.headers.location, { who: teacher });
	assert.equal(edit.status, 200);
	assert.match(edit.body, /Opgeslagen \(versie 1\)/);
	assert.match(edit.body, /value="Een verandering"/);
	assert.match(edit.body, /Nog geen vastgelegde revisies/);

	const library = await s.call("/bibliotheek?vak=biologie&jaar=3&q=prikkel", { who: teacher });
	assert.match(library.body, /Prikkel en reactie/);
	assert.match(library.body, /Concept/);
	assert.doesNotMatch((await s.call("/bibliotheek?vak=wiskunde", { who: teacher })).body, /Prikkel en reactie/);

	const saved = await s.call("/bibliotheek/prikkel-reactie", {
		who: teacher,
		method: "POST",
		form: { ...validFields(), title: "Prikkel, receptor, reactie", expectedVersion: "1" },
	});
	assert.equal(saved.status, 303);
	const snap = await s.call("/bibliotheek/prikkel-reactie/vastleggen", { who: teacher, method: "POST", form: { expectedVersion: "2" } });
	assert.equal(snap.status, 303);
	assert.match((await s.call("/bibliotheek", { who: teacher })).body, /Revisie 1 vastgelegd/);
	assert.match((await s.call("/bibliotheek/prikkel-reactie", { who: teacher })).body, /Revisie 1 · .* · nog niet nagekeken/);
});

test("a refused save keeps every typed word and puts each error on its field", async () => {
	const s = await stack();
	const teacher = await s.login("teacher");
	const typed = {
		...validFields(),
		title: "Mijn titel met <b>tekens</b>",
		"missions.0.practice.0.answerIndex": "0", // option slot 1 is empty: no right answer
		"missions.0.learn.0.text": "",
		"missions.0.learn.2.text": "",
	};
	const res = await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: typed });
	assert.equal(res.status, 422);
	assert.match(res.body, /value="Mijn titel met &lt;b&gt;tekens&lt;\/b&gt;"/);
	assert.match(res.body, /value="Een verandering"/);
	assert.match(res.body, /id="fouten"/);
	assert.match(res.body, /Kies welke ingevulde optie het juiste antwoord is/);
	assert.match(res.body, /href="#f-missions-0-practice-0-answerIndex"/);
	assert.match(res.body, /Vul er minstens 1 in/);
	assert.match((await s.call("/bibliotheek", { who: teacher })).body, /Geen leerobjecten gevonden/);
	// a code that is not kebab-case
	const badId = await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: { ...validFields(), id: "Mijn Code" } });
	assert.equal(badId.status, 422);
	assert.match(badId.body, /aria-invalid="true"/);
	assert.match(badId.body, /kleine letters, cijfers en streepjes/);
});

test("a save over a newer version is a conflict: nothing is overwritten and the typed text stays", async () => {
	const s = await stack();
	const teacher = await s.login("teacher");
	await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: validFields() });
	const first = await s.call("/bibliotheek/prikkel-reactie", { who: teacher, method: "POST", form: { ...validFields(), title: "Tab A", expectedVersion: "1" } });
	assert.equal(first.status, 303);
	const second = await s.call("/bibliotheek/prikkel-reactie", { who: teacher, method: "POST", form: { ...validFields(), title: "Tab B", expectedVersion: "1" } });
	assert.equal(second.status, 409);
	assert.match(second.body, /Je wijzigingen zijn niet opgeslagen/);
	assert.match(second.body, /value="Tab B"/);
	assert.match(second.body, /name="expectedVersion" value="2"/);
	assert.match((await s.call("/bibliotheek", { who: teacher })).body, /Tab A/);
	// a second, explicit Save over the newest version is accepted
	const explicit = await s.call("/bibliotheek/prikkel-reactie", { who: teacher, method: "POST", form: { ...validFields(), title: "Tab B", expectedVersion: "2" } });
	assert.equal(explicit.status, 303);
});

test("duplicate and archive: the copy gets new ids, archiving hides but deletes nothing", async () => {
	const s = await stack();
	const teacher = await s.login("teacher");
	await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: validFields() });
	await s.call("/bibliotheek/prikkel-reactie/vastleggen", { who: teacher, method: "POST", form: { expectedVersion: "1" } });
	const copy = await s.call("/bibliotheek/prikkel-reactie/dupliceren", { who: teacher, method: "POST", form: { newId: "prikkel-reactie-kopie" } });
	assert.equal(copy.status, 303);
	assert.match((await s.call("/bibliotheek/prikkel-reactie-kopie", { who: teacher })).body, /value="prikkel-reactie-kopie-m1"/);
	assert.equal(
		(await s.call("/bibliotheek/prikkel-reactie/dupliceren", { who: teacher, method: "POST", form: { newId: "prikkel-reactie-kopie" } })).status,
		409,
	);
	const archived = await s.call("/bibliotheek/prikkel-reactie/archiveren", { who: teacher, method: "POST", form: {} });
	assert.equal(archived.headers.location, "/bibliotheek?gearchiveerd=1");
	assert.doesNotMatch((await s.call("/bibliotheek", { who: teacher })).body, /href="\/bibliotheek\/prikkel-reactie"/);
	const { rows } = await pool.query(
		"SELECT count(*)::int AS n FROM learning_object_revisions WHERE workspace_id = $1 AND learning_object_id = 'prikkel-reactie'",
		[s.workspace],
	);
	assert.equal(rows[0].n, 1);
});

test("scope: another author, an administrator, a student and a signed-out visitor get nothing", async () => {
	const s = await stack();
	const teacher = await s.login("teacher");
	await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: validFields() });
	const parent = await s.login("parent");
	assert.equal((await s.call("/bibliotheek/prikkel-reactie", { who: parent })).status, 404);
	assert.equal(
		(await s.call("/bibliotheek/prikkel-reactie", { who: parent, method: "POST", form: { ...validFields(), expectedVersion: "1" } })).status,
		404,
	);
	assert.equal((await s.call("/bibliotheek/prikkel-reactie/archiveren", { who: parent, method: "POST", form: {} })).status, 404);
	assert.doesNotMatch((await s.call("/bibliotheek?q=prikkel", { who: parent })).body, /Prikkel en reactie/);
	const boss = await s.login("admin");
	assert.equal((await s.call("/bibliotheek/nieuw", { who: boss })).status, 403);
	assert.equal((await s.call("/bibliotheek/nieuw", { who: boss, method: "POST", form: validFields("x") })).status, 403);
	const student = await s.login("student");
	assert.notEqual((await s.call("/bibliotheek", { who: student })).status, 200);
	const anonymous = await s.call("/bibliotheek");
	assert.equal(anonymous.status, 303);
	assert.equal(anonymous.headers.location, "/login");
});

test("forms need the session's CSRF token and the management origin; GET never changes anything", async () => {
	const s = await stack();
	const teacher = await s.login("teacher");
	assert.equal((await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: { ...validFields(), csrf: "forged" } })).status, 403);
	assert.equal((await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: validFields(), origin: "https://evil.example" })).status, 403);
	assert.equal((await s.call("/bibliotheek/prikkel-reactie/archiveren", { who: teacher })).status, 405);
	assert.match((await s.call("/bibliotheek", { who: teacher })).body, /Geen leerobjecten gevonden/);
});

test("without the database the library says it is not set up, and refuses saves", async () => {
	const s = await stack({ withDirectory: false });
	const teacher = await s.login("teacher");
	const res = await s.call("/bibliotheek", { who: teacher });
	assert.equal(res.status, 200);
	assert.match(res.body, /nog niet ingericht/);
	assert.equal((await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: validFields() })).status, 503);
});

test("preview (breinhap#28): the owner sees the draft or a revision as a student would; nothing is stored or published", async () => {
	const s = await stack();
	const teacher = await s.login("teacher");
	await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: validFields() });
	const count = async () =>
		(
			await pool.query(
				`SELECT (SELECT count(*) FROM learning_object_revisions WHERE workspace_id = $1)::int AS revisions,
				        (SELECT max(version) FROM learning_object_drafts WHERE workspace_id = $1)::int AS version,
				        (SELECT count(*) FROM revision_reviews WHERE workspace_id = $1)::int AS reviews`,
				[s.workspace],
			)
		).rows[0];
	const before = await count();

	assert.match((await s.call("/bibliotheek/prikkel-reactie", { who: teacher })).body, /href="\/bibliotheek\/prikkel-reactie\/voorbeeld"/);
	const first = await s.call("/bibliotheek/prikkel-reactie/voorbeeld", { who: teacher });
	assert.equal(first.status, 200);
	assert.equal(first.headers["cache-control"], "no-store");
	assert.match(first.body, /Voorbeeld van het concept \(versie 1\)/);
	assert.match(first.body, /<li aria-current="step">Opwarmen<\/li>/);
	assert.match(first.body, /Denk aan iets dat je laat schrikken\./);
	// the author's sources never reach the student view
	assert.doesNotMatch(first.body, /Biologie voor jou 3/);
	// warm-up, two learn cards, then the practice question at page 3
	const answered = await s.call("/bibliotheek/prikkel-reactie/voorbeeld?stap=3&kies=0", { who: teacher });
	assert.match(answered.body, /Klopt\./);
	assert.match(answered.body, /Een prikkel is een verandering in de omgeving\./);
	const done = await s.call("/bibliotheek/prikkel-reactie/voorbeeld?stap=5&a=3c0;4o0.1.2", { who: teacher });
	assert.match(done.body, /Missie klaar\./);
	assert.match(done.body, /Je had 2 van de 2 vragen juist\./);

	await s.call("/bibliotheek/prikkel-reactie/vastleggen", { who: teacher, method: "POST", form: { expectedVersion: "1" } });
	await s.call("/bibliotheek/prikkel-reactie", { who: teacher, method: "POST", form: { ...validFields(), title: "Nieuwe titel", expectedVersion: "1" } });
	const revision = await s.call("/bibliotheek/prikkel-reactie/voorbeeld?revisie=1", { who: teacher });
	assert.equal(revision.status, 200);
	assert.match(revision.body, /Voorbeeld van revisie 1/);
	assert.match((await s.call("/bibliotheek/prikkel-reactie", { who: teacher })).body, /voorbeeld\?revisie=1/);
	assert.equal((await s.call("/bibliotheek/prikkel-reactie/voorbeeld?revisie=9", { who: teacher })).status, 404);
	assert.equal((await s.call("/bibliotheek/prikkel-reactie/voorbeeld?revisie=abc", { who: teacher })).status, 404);

	// read-only: walking the preview changed nothing; it has no POST at all
	const afterwards = await count();
	assert.deepEqual(afterwards, { revisions: before.revisions + 1, version: before.version + 1, reviews: before.reviews });
	assert.equal((await s.call("/bibliotheek/prikkel-reactie/voorbeeld", { who: teacher, method: "POST", form: {} })).status, 405);

	// scope: another author, an administrator and a signed-out visitor see nothing
	const parent = await s.login("parent");
	assert.equal((await s.call("/bibliotheek/prikkel-reactie/voorbeeld", { who: parent })).status, 404);
	assert.equal((await s.call("/bibliotheek/prikkel-reactie/voorbeeld?revisie=1", { who: parent })).status, 404);
	const boss = await s.login("admin");
	assert.equal((await s.call("/bibliotheek/prikkel-reactie/voorbeeld", { who: boss })).status, 403);
	assert.equal((await s.call("/bibliotheek/prikkel-reactie/voorbeeld")).status, 303);

	// content of a schema version this service does not know is refused clearly, never guessed at
	await pool.query(
		`UPDATE learning_object_drafts SET content = jsonb_set(content, '{schemaVersion}', '2')
		 WHERE workspace_id = $1 AND learning_object_id = 'prikkel-reactie'`,
		[s.workspace],
	);
	const unknown = await s.call("/bibliotheek/prikkel-reactie/voorbeeld", { who: teacher });
	assert.equal(unknown.status, 422);
	assert.match(unknown.body, /schemaversie die deze preview niet kent/);
	await pool.query(
		`UPDATE learning_object_drafts SET content = jsonb_set(content, '{missions}', '[]')
		 WHERE workspace_id = $1 AND learning_object_id = 'prikkel-reactie'`,
		[s.workspace],
	);
	await pool.query(
		`UPDATE learning_object_drafts SET content = jsonb_set(content, '{schemaVersion}', '1')
		 WHERE workspace_id = $1 AND learning_object_id = 'prikkel-reactie'`,
		[s.workspace],
	);
	const invalid = await s.call("/bibliotheek/prikkel-reactie/voorbeeld", { who: teacher });
	assert.equal(invalid.status, 422);
	assert.match(invalid.body, /nog niet geldig/);
});
