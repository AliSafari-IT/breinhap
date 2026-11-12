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
import { ScannerUnavailable } from "../src/uploads/clamav.mjs";
import { MemoryStorage } from "../src/uploads/s3.mjs";
import { UploadStore } from "../src/uploads/store.mjs";
import { docx, multipart, pdf, png } from "./upload-fixtures.mjs";
import { objectNamed, packOf } from "./import-fixtures.mjs";
import { TEMPLATE } from "../src/imports/routes.mjs";
import { ExtractFailed } from "../src/extract/limits.mjs";
import { ExtractionStore, MAX_ATTEMPTS } from "../src/extract/store.mjs";
import { docxOf, para, textPdf } from "./extract-fixtures.mjs";

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

// ── breinhap#29: uploads ───────────────────────────────────────────────────────────────────────────

class FakeScanner {
	constructor() {
		this.mode = "clean";
		this.scanned = 0;
	}
	async scan() {
		this.scanned += 1;
		if (this.mode === "down") throw new ScannerUnavailable("connection");
		return this.mode === "infected" ? { result: "infected", signature: "Eicar-Test-Signature" } : { result: "clean" };
	}
}

async function uploadStack(quota, extra = {}) {
	const storage = new MemoryStorage();
	const scanner = new FakeScanner();
	const clock = { now: Date.now() };
	const s = await stack({
		uploadsOf: (directory) =>
			new UploadStore({ directory, storage, scanner, linkSecret: "s".repeat(40), now: () => clock.now, ...(quota ? { quota } : {}) }),
		...extra,
	});
	const send = (who, file, { name = "les.pdf", type = "application/pdf", csrf = who.csrf, origin, bron = "own", licentie = "own_work" } = {}) =>
		s.call("/bibliotheek/bestanden", {
			who,
			method: "POST",
			origin,
			raw: multipart([
				{ name: "csrf", value: csrf },
				{ name: "bestand", filename: name, type, value: file },
				{ name: "bron", value: bron },
				{ name: "licentie", value: licentie },
				{ name: "notitie", value: "Biologie voor jou 3" },
			]),
		});
	const rows = async () =>
		(await pool.query("SELECT id, status, reason, file_name, storage_key, deleted_at FROM uploads WHERE workspace_id = $1 ORDER BY created_at", [s.workspace])).rows;
	return { ...s, storage, scanner, clock, send, rows };
}
const linkIn = (body) => /href="(\/bibliotheek\/bestanden\/[0-9a-f-]{36}\/download\?[^"]+)"/.exec(body)?.[1]?.replaceAll("&amp;", "&");

test("uploads: a clean file is stored under a generated key, listed, and downloads safely for its uploader only", async () => {
	const s = await uploadStack();
	const teacher = await s.login("teacher");
	const page = await s.call("/bibliotheek/bestanden", { who: teacher });
	assert.equal(page.status, 200);
	assert.match(page.body, /enctype="multipart\/form-data"/);
	assert.match((await s.call("/bibliotheek", { who: teacher })).body, /href="\/bibliotheek\/bestanden"/);

	const res = await s.send(teacher, pdf(), { name: "../Les <1>.pdf" });
	assert.equal(res.status, 303);
	assert.equal(res.headers.location, "/bibliotheek/bestanden?opgeladen=clean");
	const [row] = await s.rows();
	assert.equal(row.status, "clean");
	assert.equal(row.file_name, "Les 1.pdf");
	assert.match(row.storage_key, /^uploads\/[0-9a-f-]{36}$/);
	assert.deepEqual([...s.storage.objects.keys()], [row.storage_key]);

	const list = await s.call("/bibliotheek/bestanden?opgeladen=clean", { who: teacher });
	assert.match(list.body, /Opgeladen en gecontroleerd/);
	assert.match(list.body, /Les 1\.pdf/);
	const link = linkIn(list.body);
	assert.ok(link, "a download link for the clean file");
	const download = await s.call(link, { who: teacher });
	assert.equal(download.status, 200);
	assert.ok(download.bytes.equals(pdf()));
	assert.equal(download.headers["content-type"], "application/pdf");
	assert.equal(download.headers["content-disposition"], "attachment; filename=\"Les 1.pdf\"; filename*=UTF-8''Les%201.pdf");
	assert.equal(download.headers["content-security-policy"], "sandbox; default-src 'none'");
	assert.equal(download.headers["x-content-type-options"], "nosniff");
	assert.equal(download.headers["cache-control"], "private, no-store");

	// the link is bound to its account, its time and its signature
	const parent = await s.login("parent");
	assert.equal((await s.call(link, { who: parent })).status, 404);
	assert.doesNotMatch((await s.call("/bibliotheek/bestanden", { who: parent })).body, /Les 1\.pdf/);
	assert.equal((await s.call(link.replace(/handtekening=[^&]+/, "handtekening=AAAA"), { who: teacher })).status, 404);
	assert.equal((await s.call(link.replace(/verloopt=\d+/, (m) => `verloopt=${Number(m.split("=")[1]) + 60}`), { who: teacher })).status, 404);
	assert.equal((await s.call(link)).status, 303); // signed out: to the login
	s.clock.now += 6 * 60 * 1000;
	const expired = await s.call(link, { who: teacher });
	assert.equal(expired.status, 410);
	assert.match(expired.body, /verlopen/);
});

test("uploads: refused files store nothing; the uploader sees why", async () => {
	const s = await uploadStack();
	const teacher = await s.login("teacher");
	const cases = [
		[Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200)]), { name: "les.pdf" }, /Programma's kunnen niet/],
		[docx([["word/vbaProject.bin", "x"]]), { name: "werkblad.docx", type: "" }, /macro's/],
		[png({ after: Buffer.from("PK\u0003\u0004") }), { name: "a.png", type: "image/png" }, /ook nog een ander bestand/],
		[pdf("1 0 obj<</S/JavaScript>>endobj\n"), {}, /scripts, bijlagen of acties/],
	];
	for (const [file, options, message] of cases) {
		const res = await s.send(teacher, file, options);
		assert.equal(res.status, 422);
		assert.match(res.body, message);
	}
	assert.equal((await s.send(teacher, pdf(), { bron: "made-up" })).status, 422);
	assert.equal((await s.rows()).length, 0);
	assert.equal(s.storage.objects.size, 0);
	assert.equal(s.scanner.scanned, 0);
});

test("uploads: scanner down keeps the file in quarantine, never served; a later rescan releases it", async () => {
	const s = await uploadStack();
	const teacher = await s.login("teacher");
	s.scanner.mode = "down";
	const res = await s.send(teacher, png(), { name: "schema.png", type: "image/png" });
	assert.equal(res.headers.location, "/bibliotheek/bestanden?opgeladen=quarantined");
	const [row] = await s.rows();
	assert.equal(row.status, "quarantined");
	const list = await s.call("/bibliotheek/bestanden?opgeladen=quarantined", { who: teacher });
	assert.match(list.body, /quarantaine/);
	assert.match(list.body, /Wordt gecontroleerd/);
	assert.equal(linkIn(list.body), undefined);
	// a forged link to a quarantined file gets nothing either
	const forged = `/bibliotheek/bestanden/${row.id}/download?verloopt=${Math.floor(s.clock.now / 1000) + 60}&handtekening=${s.uploads.sign("teacher", row.id, Math.floor(s.clock.now / 1000) + 60)}`;
	assert.equal((await s.call(forged, { who: teacher })).status, 404);
	await assert.rejects(s.uploads.link({ sub: "teacher", role: "breinhap.teacher" }, row.id), /not_ready/);

	// still down: the rescan leaves it where it is
	await s.uploads.scanPending({ minAgeSeconds: 0 });
	assert.equal((await s.rows())[0].status, "quarantined");
	s.scanner.mode = "clean";
	await s.uploads.scanPending({ minAgeSeconds: 0 });
	assert.equal((await s.rows())[0].status, "clean");
	assert.ok(linkIn((await s.call("/bibliotheek/bestanden", { who: teacher })).body));
});

test("uploads: infected files are deleted at once; quarantine that never clears is cleaned up", async () => {
	const s = await uploadStack();
	const teacher = await s.login("teacher");
	s.scanner.mode = "infected";
	const res = await s.send(teacher, pdf());
	assert.equal(res.headers.location, "/bibliotheek/bestanden?opgeladen=rejected");
	assert.deepEqual((await s.rows()).map((r) => [r.status, r.reason]), [["rejected", "infected"]]);
	assert.equal(s.storage.objects.size, 0);
	assert.match((await s.call("/bibliotheek/bestanden", { who: teacher })).body, /schadelijke inhoud/);

	s.scanner.mode = "down";
	await s.send(teacher, pdf(), { name: "later.pdf" });
	assert.equal(s.storage.objects.size, 1);
	await pool.query("UPDATE uploads SET created_at = now() - interval '8 days' WHERE workspace_id = $1 AND status = 'quarantined'", [s.workspace]);
	await s.uploads.scanPending({ minAgeSeconds: 0 });
	assert.deepEqual((await s.rows()).map((r) => r.reason).sort(), ["infected", "scan_timeout"]);
	assert.equal(s.storage.objects.size, 0);
	// a clean file never goes back, a deleted one never comes back (the database refuses)
	await assert.rejects(pool.query("UPDATE uploads SET status = 'clean' WHERE workspace_id = $1 AND reason = 'infected'", [s.workspace]), /rejected upload can only be deleted/);
});

test("uploads: quota, delete, and who may upload", async () => {
	const s = await uploadStack({ bytes: 1_000_000, files: 2 });
	const teacher = await s.login("teacher");
	assert.equal((await s.send(teacher, pdf())).status, 303);
	assert.equal((await s.send(teacher, pdf(), { name: "b.pdf" })).status, 303);
	const full = await s.send(teacher, pdf(), { name: "c.pdf" });
	assert.equal(full.status, 409);
	assert.match(full.body, /opslag van deze werkplek is vol/);
	assert.match((await s.call("/bibliotheek/bestanden", { who: teacher })).body, /2 van 2 bestanden/);

	const [first] = await s.rows();
	const parent = await s.login("parent");
	assert.equal((await s.call(`/bibliotheek/bestanden/${first.id}/verwijderen`, { who: parent, method: "POST", form: {} })).status, 404);
	assert.equal((await s.call(`/bibliotheek/bestanden/${first.id}/verwijderen`, { who: teacher, method: "POST", form: { csrf: "forged" } })).status, 403);
	const removed = await s.call(`/bibliotheek/bestanden/${first.id}/verwijderen`, { who: teacher, method: "POST", form: {} });
	assert.equal(removed.headers.location, "/bibliotheek/bestanden?verwijderd=1");
	const after = (await s.rows())[0];
	assert.equal(after.status, "deleted");
	assert.equal(after.file_name, null);
	assert.ok(after.deleted_at);
	assert.ok(!s.storage.objects.has(first.storage_key));
	assert.equal((await s.send(teacher, pdf(), { name: "c.pdf" })).status, 303, "a deleted file frees its quota");

	// forms need the session's CSRF token and the management origin
	assert.equal((await s.send(teacher, pdf(), { csrf: "forged" })).status, 403);
	assert.equal((await s.send(teacher, pdf(), { origin: "https://evil.example" })).status, 403);
	// administrators manage people, not content; a signed-out visitor goes to the login
	const boss = await s.login("admin");
	assert.equal((await s.send(boss, pdf())).status, 403);
	assert.equal((await s.call("/bibliotheek/bestanden")).status, 303);
});

// ── breinhap#30: imports ───────────────────────────────────────────────────────────────────────────

const importFile = (s, who, name, text, { csrf = who.csrf, origin } = {}) =>
	s.call("/bibliotheek/importeren", {
		who,
		method: "POST",
		origin,
		raw: multipart([
			{ name: "csrf", value: csrf },
			{ name: "bestand", filename: name, type: name.endsWith(".json") ? "application/json" : "text/csv", value: Buffer.from(text) },
		]),
	});
const confirmOf = (body) => /action="(\/bibliotheek\/importeren\/[0-9a-f-]{36}\/bevestigen)"/.exec(body)?.[1];
const objectsIn = async (workspace) =>
	(await pool.query("SELECT lo.id, lo.owner_sub AS owner, d.version, d.content FROM learning_objects lo JOIN learning_object_drafts d ON d.workspace_id = lo.workspace_id AND d.learning_object_id = lo.id WHERE lo.workspace_id = $1 ORDER BY lo.id", [workspace])).rows;

test("imports: a dry run shows exactly what would happen and writes nothing; confirming once creates drafts", async () => {
	const s = await stack();
	const teacher = await s.login("teacher");
	const form = await s.call("/bibliotheek/importeren", { who: teacher });
	assert.equal(form.status, 200);
	assert.match(form.body, /href="\/bibliotheek\/importeren\/sjabloon.csv"/);
	const template = await s.call("/bibliotheek/importeren/sjabloon.csv", { who: teacher });
	assert.equal(template.headers["content-type"], "text/csv; charset=utf-8");
	assert.match(template.headers["content-disposition"], /attachment/);

	const preview = await importFile(s, teacher, "les.csv", TEMPLATE);
	assert.equal(preview.status, 200);
	assert.match(preview.body, /Er is nog niets opgeslagen/);
	assert.match(preview.body, /prikkel-reactie<\/code><\/td><td>Prikkel en reactie<\/td><td>1<\/td><td><span class="state ok">Nieuw/);
	assert.deepEqual(await objectsIn(s.workspace), [], "a dry run writes nothing to the library");

	const confirm = confirmOf(preview.body);
	const done = await s.call(confirm, { who: teacher, method: "POST", form: {} });
	assert.equal(done.status, 303);
	const result = await s.call(done.headers.location, { who: teacher });
	assert.match(result.body, /Import afgerond: 1 leerobject opgeslagen als concept/);
	assert.match(result.body, /href="\/bibliotheek\/prikkel-reactie"/);
	const [object] = await objectsIn(s.workspace);
	assert.equal(object.owner, "teacher");
	assert.equal(object.content.review.status, "draft");

	// confirming again, or uploading the same file again, never makes a second copy
	assert.equal((await s.call(confirm, { who: teacher, method: "POST", form: {} })).status, 303);
	const again = await importFile(s, teacher, "les.csv", TEMPLATE);
	assert.match(again.body, /Overslaan<\/span> <small>\(staat er al precies zo in\)/);
	assert.equal(confirmOf(again.body), undefined, "nothing to confirm");
	assert.equal((await objectsIn(s.workspace)).length, 1);

	// a changed file updates the importer's own draft, as a new version
	const changed = await importFile(s, teacher, "les.csv", TEMPLATE.replace("Prikkel en reactie", "Prikkel, receptor, reactie"));
	assert.match(changed.body, /Bijwerken \(jouw concept\)/);
	await s.call(confirmOf(changed.body), { who: teacher, method: "POST", form: {} });
	const [updated] = await objectsIn(s.workspace);
	assert.equal(updated.version, 2);
	assert.equal(updated.content.title, "Prikkel, receptor, reactie");
});

test("imports: partial failures, review claims, markup and someone else's codes", async () => {
	const s = await stack();
	const teacher = await s.login("teacher");
	const parent = await s.login("parent");
	await s.call("/bibliotheek/nieuw", { who: parent, method: "POST", form: validFields("van-de-ouder") });
	const pack = packOf(
		objectNamed("goed", { title: "<script>alert(1)</script>" }),
		{ ...objectNamed("fout"), grade: 9 },
		objectNamed("van-de-ouder"),
	);
	const preview = await importFile(s, teacher, "pakket.json", pack);
	assert.equal(preview.status, 200);
	assert.match(preview.body, /1 fout: deze leerobjecten worden niet geïmporteerd/);
	assert.match(preview.body, /<code>objects\.1\.grade<\/code> \(fout\): Hoogstens 6\./);
	assert.match(preview.body, /nagekeken.*genegeerd/);
	assert.match(preview.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.doesNotMatch(preview.body, /<script>alert/);
	assert.match(preview.body, /van-de-ouder<\/code>.*Overslaan<\/span> <small>\(deze code is al in gebruik in deze werkplek\)/s);
	assert.match(preview.body, /1 leerobject importeren als concept/);
	await s.call(confirmOf(preview.body), { who: teacher, method: "POST", form: {} });
	const objects = await objectsIn(s.workspace);
	assert.deepEqual(objects.map((o) => [o.id, o.owner]), [["goed", "teacher"], ["van-de-ouder", "parent"]]);
	assert.equal(objects[0].content.review.status, "draft", "the file's 'reviewed' is never trusted");
	assert.equal(objects[0].content.title, "<script>alert(1)</script>", "stored as plain text");
	// unsupported files are explained, not guessed at
	assert.equal((await importFile(s, teacher, "pakket.json", JSON.stringify({ schemaVersion: 7, objects: [] }))).body.includes("Schemaversie 7 wordt niet ondersteund"), true);
	assert.equal((await importFile(s, teacher, "les.xlsx", "x")).status, 422);
});

test("imports: a draft edited after the preview is never overwritten; stale and foreign plans do nothing", async () => {
	const s = await stack();
	const teacher = await s.login("teacher");
	await s.call(confirmOf((await importFile(s, teacher, "les.csv", TEMPLATE)).body), { who: teacher, method: "POST", form: {} });
	const preview = await importFile(s, teacher, "les.csv", TEMPLATE.replace("Prikkel en reactie", "Nieuwe titel"));
	// meanwhile, the editor saves version 2
	const [current] = await objectsIn(s.workspace);
	await pool.query("UPDATE learning_object_drafts SET version = version + 1, content = jsonb_set(content, '{title}', '\"In de editor\"') WHERE workspace_id = $1", [s.workspace]);
	const done = await s.call(confirmOf(preview.body), { who: teacher, method: "POST", form: {} });
	assert.match((await s.call(done.headers.location, { who: teacher })).body, /Niet gedaan: het is intussen gewijzigd/);
	assert.equal((await objectsIn(s.workspace))[0].content.title, "In de editor");
	assert.equal(current.version, 1);

	// a plan nobody confirmed within the hour expires
	const old = await importFile(s, teacher, "pakket.json", packOf(objectNamed("later")));
	await pool.query("UPDATE imports SET created_at = now() - interval '2 hours' WHERE workspace_id = $1 AND status = 'planned'", [s.workspace]);
	assert.equal((await s.call(confirmOf(old.body), { who: teacher, method: "POST", form: {} })).status, 410);

	// someone else's import, or one from another workspace, does not exist for you
	const mine = await importFile(s, teacher, "pakket.json", packOf(objectNamed("nog-een")));
	const parent = await s.login("parent");
	assert.equal((await s.call(confirmOf(mine.body), { who: parent, method: "POST", form: {} })).status, 404);
	const elsewhere = await stack();
	const stranger = await elsewhere.login("teacher");
	assert.equal((await elsewhere.call(confirmOf(mine.body), { who: stranger, method: "POST", form: {} })).status, 404);
	assert.equal((await elsewhere.call(confirmOf(mine.body).replace("/bevestigen", ""), { who: stranger })).status, 404);
	// the same code in another workspace is simply another object
	const theirs = await importFile(elsewhere, stranger, "les.csv", TEMPLATE);
	assert.match(theirs.body, /Nieuw/);
});

test("imports: two confirms at once still create one object; forms and roles are checked", async () => {
	const s = await stack();
	const teacher = await s.login("teacher");
	const preview = await importFile(s, teacher, "pakket.json", packOf(objectNamed("een"), objectNamed("twee")));
	const url = confirmOf(preview.body);
	const results = await Promise.all([1, 2, 3].map(() => s.call(url, { who: teacher, method: "POST", form: {} })));
	assert.ok(results.every((r) => [303, 409].includes(r.status)), results.map((r) => r.status).join());
	assert.deepEqual((await objectsIn(s.workspace)).map((o) => o.id), ["een", "twee"]);
	const { rows } = await pool.query("SELECT result FROM import_items WHERE workspace_id = $1 ORDER BY position", [s.workspace]);
	assert.deepEqual(rows.map((r) => r.result), ["done", "done"]);

	assert.equal((await importFile(s, teacher, "les.csv", TEMPLATE, { csrf: "forged" })).status, 403);
	assert.equal((await importFile(s, teacher, "les.csv", TEMPLATE, { origin: "https://evil.example" })).status, 403);
	assert.equal((await s.call(url, { who: teacher, method: "POST", form: { csrf: "forged" } })).status, 403);
	const boss = await s.login("admin");
	assert.equal((await s.call("/bibliotheek/importeren", { who: boss })).status, 403);
	assert.equal((await importFile(s, boss, "les.csv", TEMPLATE)).status, 403);
	assert.equal((await s.call("/bibliotheek/importeren")).status, 303);
});

// ── breinhap#31: text extraction from PDF and DOCX ─────────────────────────────────────────────────

/** An upload stack with extraction. `run` replaces the parser (the real one when absent). */
// Extraction behavior fixtures explicitly choose English; the workspace now defaults to Dutch.
async function extractStack({ run, leaseSeconds = 1, locale = "en" } = {}) {
	const s = await uploadStack(undefined, {
		locale,
		extractionsOf: (uploads) => new ExtractionStore({ uploads, leaseSeconds, ...(run ? { run } : {}) }),
	});
	const upload = async (who, bytes, name = "les.pdf", type = name.endsWith(".pdf") ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document") => {
		assert.equal((await s.send(who, bytes, { name, type })).status, 303);
		const { rows } = await pool.query("SELECT id FROM uploads WHERE workspace_id = $1 AND uploader_sub = $2 ORDER BY created_at DESC LIMIT 1", [s.workspace, who.sub ?? "teacher"]);
		return rows[0].id;
	};
	const start = async (who, uploadId) => {
		const res = await s.call("/bibliotheek/uittreksels", { who, method: "POST", form: { bestand: uploadId } });
		assert.equal(res.status, 303, res.body);
		return { location: res.headers.location, id: /uittreksels\/([0-9a-f-]{36})/.exec(res.headers.location)?.[1] };
	};
	const job = async (id) => (await pool.query("SELECT * FROM extractions WHERE workspace_id = $1 AND id = $2", [s.workspace, id])).rows[0];
	const settled = () => s.extractions.kick();
	return { ...s, upload, start, job, settled };
}
const LESSON = textPdf([
	[{ text: "Prikkel en reactie", size: 20 }, "Ik leg uit wat een prikkel en een reactie zijn.", "", "", "Een prikkel is een verandering die je waarneemt."],
	["Wat is een prikkel?", "", "", "Een spier", "", "", "Een verandering"],
]);

test("extraction: a clean PDF is read in the background; the author maps it, and only their save makes a draft", async () => {
	const s = await extractStack();
	const teacher = await s.login("teacher");
	const uploadId = await s.upload(teacher, LESSON);
	const files = await s.call("/bibliotheek/bestanden", { who: teacher });
	assert.match(files.body, /action="\/bibliotheek\/uittreksels"/);
	assert.match(files.body, /Extract text/);

	const { id, location } = await s.start(teacher, uploadId);
	assert.match(location, /notice=started/);
	await s.settled();
	const row = await s.job(id);
	assert.equal(row.status, "done");
	assert.equal(row.progress, 100);
	assert.equal(row.lease_owner, null);
	assert.deepEqual(row.blocks.map((b) => [b.text, b.ref.page]), [
		["Prikkel en reactie", 1],
		["Ik leg uit wat een prikkel en een reactie zijn.", 1],
		["Een prikkel is een verandering die je waarneemt.", 1],
		["Wat is een prikkel?", 2],
		["Een spier", 2],
		["Een verandering", 2],
	]);
	// starting again is the same job, not a second one
	assert.equal((await s.start(teacher, uploadId)).id, id);
	assert.equal((await pool.query("SELECT count(*)::int AS n FROM extractions WHERE workspace_id = $1", [s.workspace])).rows[0].n, 1);
	assert.match((await s.call("/bibliotheek/bestanden", { who: teacher })).body, new RegExp(`href="/bibliotheek/uittreksels/${id}\\?lang=en"`));

	const page = await s.call(`/bibliotheek/uittreksels/${id}`, { who: teacher });
	assert.equal(page.status, 200);
	assert.match(page.body, /<div lang="en" class="extraction">/);
	assert.match(page.body, /Piece 1<\/strong> · Heading · page 1/);
	assert.match(page.body, /name="r\.5"/);
	assert.match(page.body, /choose the correct answers yourself and save it as a draft/);
	assert.match((await s.call("/bibliotheek/uittreksels", { who: teacher })).body, /Breinhap never fills in correct answers and never marks anything as reviewed/);
	assert.equal((await objectsIn(s.workspace)).length, 0, "reading a file makes no draft");

	const mapped = await s.call(`/bibliotheek/uittreksels/${id}/overnemen`, {
		who: teacher,
		method: "POST",
		form: { "r.0": "title", "r.1": "goal", "r.2": "learn", "r.3": "practice", "r.4": "option", "r.5": "option" },
	});
	assert.equal(mapped.status, 200);
	assert.match(mapped.body, /Nothing is saved yet/);
	assert.match(mapped.body, /name="uittreksel" value="[0-9a-f-]{36}"/);
	assert.match(mapped.body, /name="missions.0.practice.0.options.1" type="text" value="Een verandering"/);
	assert.doesNotMatch(mapped.body, /name="missions\.0\.practice\.0\.answerIndex" value="\d" checked/, "no answer is chosen for the author");
	assert.match(mapped.body, /value="Biologie voor jou 3 · les\.pdf, p\. 1–2"/);
	assert.equal((await objectsIn(s.workspace)).length, 0, "mapping saves nothing");
	assert.equal((await s.call(`/bibliotheek/uittreksels/${id}/overnemen`, { who: teacher, method: "POST", form: {} })).headers.location, `/bibliotheek/uittreksels/${id}?error=nothing_chosen&lang=en`);

	// the author completes the mission (their answer, their minutes) and saves it as a draft
	const fields = {
		uittreksel: id,
		id: "prikkel-uit-pdf",
		title: "Prikkel en reactie",
		subject: "biologie",
		grade: "3",
		"curriculum.leerdoel": "Ik leg uit wat een prikkel en een reactie zijn.",
		"missions.0.title": "Prikkel en reactie",
		"missions.0.minutes": "3",
		"missions.0.warmup.text": "Denk aan iets dat je laat schrikken.",
		"missions.0.learn.0.text": "Een prikkel is een verandering die je waarneemt.",
		"missions.0.practice.0.kind": "choice",
		"missions.0.practice.0.prompt": "Wat is een prikkel?",
		"missions.0.practice.0.options.0": "Een spier",
		"missions.0.practice.0.options.1": "Een verandering",
		"missions.0.practice.0.answerIndex": "1",
		"missions.0.practice.0.explanation": "Een prikkel is een verandering.",
		"missions.0.check.0.kind": "order",
		"missions.0.check.0.prompt": "Zet in volgorde.",
		"missions.0.check.0.items.0": "prikkel",
		"missions.0.check.0.items.1": "reactie",
		"missions.0.check.0.explanation": "Eerst de prikkel.",
		"sources.0.kind": "school_material",
		"sources.0.title": "les.pdf, p. 1–2",
	};
	const incomplete = await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: { ...fields, "missions.0.practice.0.answerIndex": "" } });
	assert.equal(incomplete.status, 422);
	assert.match(incomplete.body, /name="uittreksel" value="/, "the link survives a failed save");
	assert.match(incomplete.body, /Practice question 1/, "the English extraction flow keeps its locale in editor validation; no answer means no draft");
	const saved = await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: fields });
	assert.equal(saved.status, 303);
	const [object] = await objectsIn(s.workspace);
	assert.equal(object.content.review.status, "draft");
	const { rows: sources } = await pool.query("SELECT sources FROM learning_object_drafts WHERE workspace_id = $1", [s.workspace]);
	assert.deepEqual(sources[0].sources, [{ kind: "school_material", title: "les.pdf, p. 1–2" }]);
	assert.match((await s.call(`/bibliotheek/uittreksels/${id}`, { who: teacher })).body, /href="\/bibliotheek\/prikkel-uit-pdf">Prikkel en reactie/);
	// saving the same form again cannot make a second draft
	assert.equal((await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: fields })).status, 422);
	assert.equal((await objectsIn(s.workspace)).length, 1);
	assert.equal((await pool.query("SELECT count(*)::int AS n FROM extraction_drafts WHERE workspace_id = $1", [s.workspace])).rows[0].n, 1);
});

test("extraction: DOCX too; images, files still in quarantine and other people's files are refused", async () => {
	const s = await extractStack();
	const teacher = await s.login("teacher");
	const docId = await s.upload(teacher, docxOf(para("Prikkel", "Heading1") + para("Een prikkel is een verandering.") + para("&lt;script&gt;alert(1)&lt;/script&gt;")), "les.docx");
	const { id } = await s.start(teacher, docId);
	await s.settled();
	assert.deepEqual((await s.job(id)).blocks.map((b) => [b.type, b.ref.paragraph]), [["heading", 1], ["paragraph", 2], ["paragraph", 3]]);
	const shown = (await s.call(`/bibliotheek/uittreksels/${id}`, { who: teacher })).body;
	assert.match(shown, /paragraph 2/);
	assert.match(shown, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.doesNotMatch(shown, /<script\b[^>]*>alert/i, "extracted text is always escaped");

	await s.send(teacher, png(), { name: "schema.png", type: "image/png" });
	const image = (await pool.query("SELECT id FROM uploads WHERE workspace_id = $1 AND kind = 'png'", [s.workspace])).rows[0].id;
	assert.doesNotMatch((await s.call("/bibliotheek/bestanden", { who: teacher })).body, new RegExp(`name="bestand" value="${image}"`));
	const refusedImage = await s.call("/bibliotheek/uittreksels", { who: teacher, method: "POST", form: { bestand: image } });
	assert.equal(refusedImage.headers.location, "/bibliotheek/uittreksels?error=unsupported&lang=en");
	assert.match((await s.call(refusedImage.headers.location, { who: teacher })).body, /only be read from PDF and Word/);

	s.scanner.mode = "down";
	const waiting = await s.upload(teacher, LESSON);
	const notReady = await s.call("/bibliotheek/uittreksels", { who: teacher, method: "POST", form: { bestand: waiting } });
	assert.match(notReady.headers.location, /error=not_ready/);

	const parent = await s.login("parent");
	assert.equal((await s.call("/bibliotheek/uittreksels", { who: parent, method: "POST", form: { bestand: docId } })).status, 404);
	assert.equal((await s.call(`/bibliotheek/uittreksels/${id}`, { who: parent })).status, 404);
	for (const action of ["stoppen", "opnieuw", "verwijderen", "overnemen"])
		assert.equal((await s.call(`/bibliotheek/uittreksels/${id}/${action}`, { who: parent, method: "POST", form: { "r.0": "title" } })).status, 404, action);
	assert.doesNotMatch((await s.call("/bibliotheek/uittreksels", { who: parent })).body, /les\.docx/);
	const boss = await s.login("admin");
	assert.equal((await s.call("/bibliotheek/uittreksels", { who: boss })).status, 403);
	assert.equal((await s.call(`/bibliotheek/uittreksels/${id}`, { who: boss })).status, 403);
	assert.equal((await s.call("/bibliotheek/uittreksels")).status, 303);
	assert.equal((await s.call(`/bibliotheek/uittreksels/${id}/verwijderen`, { who: teacher, method: "POST", form: { csrf: "forged" } })).status, 403);
	assert.equal((await s.call(`/bibliotheek/uittreksels/${id}/verwijderen`, { who: teacher, method: "POST", form: {}, origin: "https://evil.example" })).status, 403);
	assert.ok(await s.job(id), "a refused request changed nothing");
});

test("extraction: a corrupt file fails with a useful report; a retry is the same job and never duplicates drafts", async () => {
	let mode = "corrupt";
	const s = await extractStack({
		run: async ({ kind, bytes }) => {
			if (mode === "corrupt") throw new ExtractFailed("corrupt");
			const { runParser } = await import("../src/extract/sandbox.mjs");
			return runParser({ kind, bytes });
		},
	});
	const teacher = await s.login("teacher");
	const { id } = await s.start(teacher, await s.upload(teacher, LESSON));
	await s.settled();
	assert.deepEqual([(await s.job(id)).status, (await s.job(id)).error], ["failed", "corrupt"]);
	const failed = await s.call(`/bibliotheek/uittreksels/${id}`, { who: teacher });
	assert.match(failed.body, /Did not work/);
	assert.match(failed.body, /The file is damaged or not a valid PDF or Word file/);
	assert.match(failed.body, /action="\/bibliotheek\/uittreksels\/[0-9a-f-]{36}\/opnieuw"/);

	mode = "ok";
	assert.match((await s.call(`/bibliotheek/uittreksels/${id}/opnieuw`, { who: teacher, method: "POST", form: {} })).headers.location, /notice=retried/);
	await s.settled();
	assert.equal((await s.job(id)).status, "done");
	await pool.query(
		"INSERT INTO learning_objects (workspace_id, id, owner_sub, subject, grade, title) VALUES ($1, 'uit-pdf', 'teacher', 'biologie', 3, 'Uit pdf')",
		[s.workspace],
	);
	await s.extractions.linkDraft({ sub: "teacher", role: "breinhap.teacher" }, id, "uit-pdf");
	// a done job is not retried; a failed one again runs the same job, and the saved draft is untouched
	assert.match((await s.call(`/bibliotheek/uittreksels/${id}/opnieuw`, { who: teacher, method: "POST", form: {} })).headers.location, /error=not_retryable/);
	await pool.query("UPDATE extractions SET status = 'failed', error = 'timeout', blocks = NULL WHERE workspace_id = $1 AND id = $2", [s.workspace, id]);
	await s.call(`/bibliotheek/uittreksels/${id}/opnieuw`, { who: teacher, method: "POST", form: {} });
	await s.settled();
	assert.equal((await s.job(id)).status, "done");
	assert.equal((await pool.query("SELECT count(*)::int AS n FROM extractions WHERE workspace_id = $1", [s.workspace])).rows[0].n, 1);
	assert.equal((await pool.query("SELECT count(*)::int AS n FROM learning_objects WHERE workspace_id = $1", [s.workspace])).rows[0].n, 1);
	assert.equal((await pool.query("SELECT count(*)::int AS n FROM extraction_drafts WHERE workspace_id = $1", [s.workspace])).rows[0].n, 1);
});

test("extraction: storage down goes back to the queue after a pause, then succeeds; it is not retried forever", async () => {
	const s = await extractStack();
	const teacher = await s.login("teacher");
	const uploadId = await s.upload(teacher, LESSON);
	const storage = s.uploads.storage;
	const get = storage.get.bind(storage);
	storage.get = async () => {
		throw new Error("storage down");
	};
	const { id } = await s.start(teacher, uploadId);
	await s.settled();
	let row = await s.job(id);
	assert.deepEqual([row.status, row.attempts, row.error], ["queued", 1, null]);
	assert.ok(new Date(row.lease_until) > new Date(), "it waits before the next attempt");
	assert.equal(await s.extractions.runOnce(), false, "not picked up again at once");
	const pauseOver = () => pool.query("UPDATE extractions SET lease_until = now() - interval '1 second' WHERE workspace_id = $1 AND id = $2", [s.workspace, id]);
	await pauseOver();
	await s.extractions.kick();
	await pauseOver();
	await s.extractions.kick();
	row = await s.job(id);
	assert.deepEqual([row.status, row.error], ["failed", "storage_unavailable"]);
	assert.match((await s.call(`/bibliotheek/uittreksels/${id}`, { who: teacher })).body, /could not be fetched from storage/);
	storage.get = get;
	await s.call(`/bibliotheek/uittreksels/${id}/opnieuw`, { who: teacher, method: "POST", form: {} });
	await s.settled();
	assert.equal((await s.job(id)).status, "done");
});

test("extraction: cancelling a queued job is immediate, a running one stops its parser", async () => {
	let started;
	const running = new Promise((resolve) => (started = resolve));
	const s = await extractStack({
		run: ({ signal }) =>
			new Promise((_, reject) => {
				started();
				signal.addEventListener("abort", () => reject(new ExtractFailed("cancelled")));
			}),
	});
	const teacher = await s.login("teacher");
	const { id } = await s.start(teacher, await s.upload(teacher, LESSON));
	await running;
	assert.equal((await s.job(id)).status, "running");
	const page = await s.call(`/bibliotheek/uittreksels/${id}`, { who: teacher });
	assert.match(page.body, /<progress max="100" value="0"/);
	assert.match(page.body, /Reading/);
	const stop = await s.call(`/bibliotheek/uittreksels/${id}/stoppen`, { who: teacher, method: "POST", form: {} });
	assert.match(stop.headers.location, /notice=stopping/);
	assert.match((await s.call(stop.headers.location, { who: teacher })).body, /Stopping/);
	await s.settled();
	const row = await s.job(id);
	assert.deepEqual([row.status, row.cancel_requested, row.lease_owner, row.blocks], ["cancelled", false, null, null]);

	// queued (no worker free): cancelled at once
	await pool.query("UPDATE extractions SET status = 'queued', finished_at = NULL WHERE workspace_id = $1 AND id = $2", [s.workspace, id]);
	const busy = s.extractions.busy;
	s.extractions.busy = Promise.resolve(); // this process is "busy": nothing picks the job up
	assert.match((await s.call(`/bibliotheek/uittreksels/${id}/stoppen`, { who: teacher, method: "POST", form: {} })).headers.location, /notice=cancelled/);
	s.extractions.busy = busy;
	assert.equal((await s.job(id)).status, "cancelled");
	assert.match((await s.call(`/bibliotheek/uittreksels/${id}`, { who: teacher })).body, /Try again/);
});

test("extraction: after a worker restart the job is picked up again; a late answer from the old worker is dropped", async () => {
	const s = await extractStack();
	const teacher = await s.login("teacher");
	const { id } = await s.start(teacher, await s.upload(teacher, LESSON));
	await s.settled();
	// what a worker that died mid-parse leaves behind: running, its lease lapsing, nobody renewing it
	const crashed = () =>
		pool.query(
			`UPDATE extractions SET status = 'running', lease_owner = 'old-worker', lease_until = now() - interval '1 second', attempts = $3,
			   blocks = NULL, progress = 40 WHERE workspace_id = $1 AND id = $2`,
			[s.workspace, id, 1],
		);
	await crashed();
	// before the lease lapses nobody takes it; after, the next worker does
	await pool.query("UPDATE extractions SET lease_until = now() + interval '1 hour' WHERE workspace_id = $1 AND id = $2", [s.workspace, id]);
	assert.equal(await s.extractions.runOnce(), false);
	await crashed();
	const restarted = new ExtractionStore({ uploads: s.uploads, owner: "new-worker", leaseSeconds: 1 });
	assert.equal(await restarted.runOnce(), true);
	const row = await s.job(id);
	assert.deepEqual([row.status, row.attempts, row.lease_owner], ["done", 2, null]);
	assert.equal(row.blocks.length, 6);
	// the old worker comes back with an answer: it no longer holds the lease, so nothing changes
	const old = new ExtractionStore({ uploads: s.uploads, owner: "old-worker" });
	await old.settle({ id }, { status: "done", result: { blocks: [{ type: "paragraph", text: "oud", ref: { page: 1 } }], warnings: [], units: 1 } });
	assert.equal((await s.job(id)).blocks.length, 6);
	// a cancel that lands after the last heartbeat still wins over a finished parse
	await pool.query("UPDATE extractions SET status = 'running', lease_owner = 'old-worker', lease_until = now() + interval '1 minute', cancel_requested = true, blocks = NULL WHERE workspace_id = $1 AND id = $2", [s.workspace, id]);
	await old.settle({ id }, { status: "done", result: { blocks: [{ type: "paragraph", text: "laat", ref: { page: 1 } }], warnings: [], units: 1 } });
	assert.deepEqual([(await s.job(id)).status, (await s.job(id)).blocks], ["cancelled", null]);
	// a job that keeps losing its worker is not tried forever
	await pool.query(
		"UPDATE extractions SET status = 'running', lease_owner = 'old-worker', lease_until = now() - interval '1 second', attempts = $3, blocks = NULL WHERE workspace_id = $1 AND id = $2",
		[s.workspace, id, MAX_ATTEMPTS],
	);
	await restarted.runOnce();
	assert.deepEqual([(await s.job(id)).status, (await s.job(id)).error], ["failed", "interrupted"]);
	assert.match((await s.call(`/bibliotheek/uittreksels/${id}`, { who: teacher })).body, /interrupted several times/);
});

test("extraction: deleting the file or the text cleans up; drafts saved from it stay; old and orphaned jobs are removed", async () => {
	const s = await extractStack();
	const teacher = await s.login("teacher");
	const first = await s.upload(teacher, LESSON);
	const { id } = await s.start(teacher, first);
	await s.settled();
	await pool.query("INSERT INTO learning_objects (workspace_id, id, owner_sub, subject, grade, title) VALUES ($1, 'bewaard', 'teacher', 'biologie', 3, 'Bewaard')", [s.workspace]);
	await s.extractions.linkDraft({ sub: "teacher", role: "breinhap.teacher" }, id, "bewaard");
	assert.equal((await s.call(`/bibliotheek/bestanden/${first}/verwijderen`, { who: teacher, method: "POST", form: {} })).status, 303);
	assert.equal(await s.job(id), undefined, "the extracted text went with the file");
	assert.equal((await pool.query("SELECT count(*)::int AS n FROM extraction_drafts WHERE workspace_id = $1", [s.workspace])).rows[0].n, 0);
	assert.equal((await pool.query("SELECT count(*)::int AS n FROM learning_objects WHERE workspace_id = $1", [s.workspace])).rows[0].n, 1);

	const second = await s.start(teacher, await s.upload(teacher, LESSON));
	await s.settled();
	const removed = await s.call(`/bibliotheek/uittreksels/${second.id}/verwijderen`, { who: teacher, method: "POST", form: {} });
	assert.equal(removed.headers.location, "/bibliotheek/uittreksels?notice=deleted&lang=en");
	assert.match((await s.call(removed.headers.location, { who: teacher })).body, /The extracted text is deleted/);
	assert.equal(await s.job(second.id), undefined);
	assert.ok((await pool.query("SELECT 1 FROM uploads WHERE workspace_id = $1 AND status = 'clean'", [s.workspace])).rows.length, "the file stays");

	const third = await s.start(teacher, await s.upload(teacher, LESSON));
	const fourth = await s.start(teacher, await s.upload(teacher, LESSON));
	await s.settled();
	await pool.query("UPDATE extractions SET updated_at = now() - interval '31 days' WHERE workspace_id = $1 AND id = $2", [s.workspace, third.id]);
	await pool.query("ALTER TABLE uploads DISABLE TRIGGER uploads_transition");
	await pool.query("UPDATE uploads SET status = 'rejected', reason = 'missing' WHERE workspace_id = $1 AND id = (SELECT upload_id FROM extractions WHERE workspace_id = $1 AND id = $2)", [s.workspace, fourth.id]);
	await pool.query("ALTER TABLE uploads ENABLE TRIGGER uploads_transition");
	assert.equal(await s.extractions.cleanup(), 2);
	assert.equal(await s.job(third.id), undefined);
	assert.equal(await s.job(fourth.id), undefined);
});

test("extraction: the screens follow ?lang=, the ASafariM locale cookie and the browser, in en, nl, fr and de", async () => {
	const s = await extractStack({ locale: "" });
	const teacher = await s.login("teacher");
	const list = (opts) => s.call("/bibliotheek/uittreksels", { who: teacher, ...opts });
	assert.match((await list()).body, /<div lang="nl" class="extraction">[\s\S]*Je hebt nog geen tekst/);
	assert.match((await list({ headers: { "Accept-Language": "nl-BE,nl;q=0.9" } })).body, /lang="nl" class="extraction">[\s\S]*Je hebt nog geen tekst/);
	assert.match((await list({ cookie: "asafarim-locale=fr-BE" })).body, /lang="fr" class="extraction">[\s\S]*Vous n'avez encore extrait/);
	assert.match((await s.call("/bibliotheek/uittreksels?lang=de", { who: teacher, cookie: "asafarim-locale=fr" })).body, /lang="de" class="extraction">[\s\S]*Sie haben noch keinen Text/);
	// notices and errors of the redirects, in the language the form was sent in
	const { id } = await s.start(teacher, await s.upload(teacher, LESSON));
	await s.settled();
	for (const [lang, text] of [["nl", "Stuk 1"], ["fr", "Passage 1"], ["de", "Abschnitt 1"]])
		assert.match((await s.call(`/bibliotheek/uittreksels/${id}?lang=${lang}&notice=started`, { who: teacher })).body, new RegExp(`${text}[\\s\\S]*`));
	const back = await s.call(`/bibliotheek/uittreksels/${id}/overnemen`, { who: teacher, method: "POST", form: { lang: "fr" } });
	assert.equal(back.headers.location, `/bibliotheek/uittreksels/${id}?error=nothing_chosen&lang=fr`);
	assert.match((await s.call(back.headers.location, { who: teacher })).body, /Choisissez au moins un passage/);
	assert.doesNotMatch((await s.call(`/bibliotheek/uittreksels/${id}?error=<script>`, { who: teacher })).body, /<script>/i);
	// only the four languages: anything else (also an object key like toString) falls back
	const odd = await s.call(`/bibliotheek/uittreksels/${id}/overnemen`, { who: teacher, method: "POST", form: { lang: "toString", "r.0": "title", "r.4": "option" } });
	assert.equal(odd.status, 200);
	assert.match(odd.body, /Stuk 5: een antwoordoptie heeft een vraag erboven nodig/);
});

// breinhap#86: exercise the real identity/Redis/Postgres routes in each workspace locale.
test("workspace locales cover library/edit/preview/import/files/learners/admin and preserve data and permissions", async () => {
	const copy = {
		nl: { library: "Bibliotheek", students: "Leerlingen", admin: "Toegang beheren", save: "Opslaan", atMost: "Hoogstens 6.", new: "Nieuw leerobject" },
		fr: { library: "Bibliothèque", students: "Élèves", admin: "Gestion des accès", save: "Enregistrer", atMost: "Au maximum 6.", new: "Nouvel objet pédagogique" },
		en: { library: "Library", students: "Students", admin: "Access management", save: "Save", atMost: "At most 6.", new: "New learning object" },
		de: { library: "Bibliothek", students: "Schüler", admin: "Zugangsverwaltung", save: "Speichern", atMost: "Höchstens 6.", new: "Neues Lernobjekt" },
	};
	for (const [lang, words] of Object.entries(copy)) {
		const s = await stack({ locale: lang });
		const teacher = await s.login("teacher");
		for (const [path, heading] of [["/bibliotheek", words.library], ["/leerlingen", words.students], ["/bibliotheek/nieuw", words.new]]) {
			const page = await s.call(path, { who: teacher });
			assert.equal(page.status, 200, `${lang} ${path}`);
			assert.ok(page.body.includes(`<html lang="${lang}"`));
			assert.ok(page.body.includes(`<h1>${heading}</h1>`));
			assert.doesNotMatch(page.body, /<script>|<style|\sstyle="/i);
			assert.equal(page.headers["cache-control"], "no-store");
			assert.equal(page.headers["content-language"], lang);
		}
		const fields = { ...validFields(), title: "Opslaan", "missions.0.warmup.text": "Overzicht" };
		assert.equal((await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: fields })).status, 303);
		const draft = await s.call("/bibliotheek/prikkel-reactie", { who: teacher });
		assert.match(draft.body, /value="Opslaan"/);
		assert.ok(draft.body.includes(`<button type="submit">${words.save}</button>`));
		const preview = await s.call("/bibliotheek/prikkel-reactie/voorbeeld", { who: teacher });
		assert.equal(preview.status, 200);
		assert.match(preview.body, /<p>Overzicht<\/p>/, "authored Dutch content is unchanged");
		const bad = await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: { ...fields, id: "invalid-year", grade: "9" } });
		assert.equal(bad.status, 422);
		assert.ok(bad.body.includes(words.atMost));
		const invalidImport = await importFile(s, teacher, "bad.csv", TEMPLATE.replace("biologie;3;", "biologie;9;"));
		assert.equal(invalidImport.status, 200);
		assert.ok(invalidImport.body.includes(words.atMost), `${lang}: stored import bounds`);
		const filePage = await s.call("/bibliotheek/bestanden", { who: teacher });
		assert.equal(filePage.status, 200);
		assert.ok(filePage.body.includes(`<html lang="${lang}"`));
		assert.equal((await s.call("/beheer", { who: teacher })).status, 403);
		const boss = await s.login("admin");
		for (const path of ["/beheer", "/beheer/leerlingen"]) {
			const page = await s.call(path, { who: boss });
			assert.equal(page.status, 200);
			assert.ok(page.body.includes(words.admin));
			assert.ok(page.body.includes(`<html lang="${lang}"`));
		}
		const forged = await s.call("/beheer/goedkeuren", { who: boss, method: "POST", form: { csrf: "forged" } });
		assert.equal(forged.status, 403, `${lang}: CSRF remains required`);
	}
});

test("workspace language query persists across GET filters, failed POSTs and redirects", async () => {
	const s = await stack();
	const who = await s.login("teacher");
	const selected = await s.call("/bibliotheek?lang=fr&q=Opslaan&jaar=3", { who });
	assert.ok(selected.headers["set-cookie"].some((cookie) => cookie.startsWith("breinhap-lang=fr;")));
	assert.match(selected.body, /name="lang" value="fr"/);
	assert.match(selected.body, /q=Opslaan&amp;jaar=3&amp;lang=en/);
	const cookie = "breinhap-lang=fr";
	const refused = await s.call("/bibliotheek/nieuw", { who, cookie, method: "POST", form: { ...validFields(), csrf: "forged" } });
	assert.equal(refused.status, 403);
	assert.match(refused.body, /Demande refusée/);
	assert.equal((await s.call("/bibliotheek/nieuw", { who, cookie, method: "POST", form: validFields() })).status, 303);
	const after = await s.call("/bibliotheek/prikkel-reactie", { who, cookie });
	assert.match(after.body, /<html lang="fr"/);
	assert.match(after.body, />Enregistrer<\/button>/);
});

test("review (breinhap#32): a granted reviewer sees the queue, decides a submitted revision, and the author sees the outcome", async () => {
	const s = await stack();
	const teacher = await s.login("teacher");
	const reviewer = await s.login("parent");
	const admin = { sub: "admin", role: "breinhap.admin" };
	const parent = { sub: "parent", role: "breinhap.parent" };
	await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: validFields() });
	await s.call("/bibliotheek/prikkel-reactie/vastleggen", { who: teacher, method: "POST", form: { expectedVersion: "1" } });

	// without the explicit grant there is no queue, no link, and no detail
	const refused = await s.call("/bibliotheek/nakijken", { who: teacher });
	assert.equal(refused.status, 403);
	assert.match(refused.body, /Alleen aangewezen nakijkers kunnen inhoud nakijken/);
	assert.doesNotMatch((await s.call("/bibliotheek", { who: teacher })).body, /href="\/bibliotheek\/nakijken"/);

	// the author offers the immutable revision; the library says so
	const offered = await s.call("/bibliotheek/prikkel-reactie/aanbieden", { who: teacher, method: "POST", form: { revision: "1" } });
	assert.equal(offered.status, 303);
	assert.equal(offered.headers.location, "/bibliotheek/prikkel-reactie?aangeboden=1");
	assert.match((await s.call("/bibliotheek/prikkel-reactie?aangeboden=1", { who: teacher })).body, /Revisie 1 ter nakijking aangeboden/);
	assert.match((await s.call("/bibliotheek", { who: teacher })).body, /Revisie 1 ter nakijking/);

	// a granted reviewer sees the queue, the revision with its sources, explanations and answer key
	await s.directory.grantCapability(admin, parent, "content.review");
	const library = await s.call("/bibliotheek", { who: reviewer });
	assert.match(library.body, /href="\/bibliotheek\/nakijken"/);
	assert.match(library.body, /Inhoud nakijken \(1\)/);
	const queue = await s.call("/bibliotheek/nakijken", { who: reviewer });
	assert.equal(queue.status, 200);
	assert.match(queue.body, /Prikkel en reactie/);
	assert.match(queue.body, /href="\/bibliotheek\/nakijken\/prikkel-reactie\/1"/);
	const detail = await s.call("/bibliotheek/nakijken/prikkel-reactie/1", { who: reviewer });
	assert.equal(detail.status, 200);
	assert.match(detail.body, /Goedkeuren/);
	assert.match(detail.body, /Aanpassingen vragen/);
	assert.match(detail.body, /Biologie voor jou 3/);
	assert.match(detail.body, /Een prikkel is een verandering in de omgeving/);

	const approved = await s.call("/bibliotheek/nakijken/prikkel-reactie/1", { who: reviewer, method: "POST", form: { decision: "approved" } });
	assert.equal(approved.status, 303);
	assert.equal(approved.headers.location, "/bibliotheek/nakijken?beoordeeld=approved");
	assert.match((await s.call("/bibliotheek/nakijken?beoordeeld=approved", { who: reviewer })).body, /Goedgekeurd\./);
	assert.doesNotMatch((await s.call("/bibliotheek/nakijken", { who: reviewer })).body, /Prikkel en reactie/);
	assert.equal((await s.call("/bibliotheek/nakijken/prikkel-reactie/1", { who: reviewer })).status, 404);

	const editor = await s.call("/bibliotheek/prikkel-reactie", { who: teacher });
	assert.match(editor.body, /goedgekeurd/);
	assert.match(editor.body, /Goedgekeurd door parent\./);
});

test("review refusals: not ready, stale draft, self-review, forged CSRF, and a non-owner cannot offer", async () => {
	const s = await stack();
	const teacher = await s.login("teacher");
	const reviewer = await s.login("parent");
	const admin = { sub: "admin", role: "breinhap.admin" };
	const parent = { sub: "parent", role: "breinhap.parent" };
	const self = { sub: "teacher", role: "breinhap.teacher" };
	await s.directory.grantCapability(admin, parent, "content.review");

	// not ready: a website source without its https link
	const website = {
		...validFields("website-zonder-link"),
		"sources.0.kind": "website",
		"sources.0.title": "Zonder link",
		"sources.0.url": "",
	};
	await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: website });
	await s.call("/bibliotheek/website-zonder-link/vastleggen", { who: teacher, method: "POST", form: { expectedVersion: "1" } });
	const notReady = await s.call("/bibliotheek/website-zonder-link/aanbieden", { who: teacher, method: "POST", form: { revision: "1" } });
	assert.equal(notReady.status, 409);
	assert.match(notReady.body, /nog niet klaar om na te kijken/);
	assert.match(notReady.body, /https-link/);

	// stale draft: the revision no longer matches the editable draft
	await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: validFields("stale-draft") });
	await s.call("/bibliotheek/stale-draft/vastleggen", { who: teacher, method: "POST", form: { expectedVersion: "1" } });
	await s.call("/bibliotheek/stale-draft", { who: teacher, method: "POST", form: { ...validFields("stale-draft"), title: "Nieuwer", expectedVersion: "1" } });
	const stale = await s.call("/bibliotheek/stale-draft/aanbieden", { who: teacher, method: "POST", form: { revision: "1" } });
	assert.equal(stale.status, 409);
	assert.match(stale.body, /Je concept heeft wijzigingen die nog niet in een revisie staan/);

	// someone else's revision is not found, exactly like an unknown object
	assert.equal((await s.call("/bibliotheek/stale-draft/aanbieden", { who: reviewer, method: "POST", form: { revision: "1" } })).status, 404);

	// a fresh revision can be offered, but not read or decided without the grant
	await s.call("/bibliotheek/stale-draft/vastleggen", { who: teacher, method: "POST", form: { expectedVersion: "2" } });
	await s.call("/bibliotheek/stale-draft/aanbieden", { who: teacher, method: "POST", form: { revision: "2" } });
	assert.equal((await s.call("/bibliotheek/nakijken/stale-draft/2", { who: teacher })).status, 403);
	assert.equal(
		(await s.call("/bibliotheek/nakijken/stale-draft/2", { who: reviewer, method: "POST", form: { decision: "approved", csrf: "forged" } })).status,
		403,
	);

	// an owner with the grant still never sees or decides their own content
	await s.directory.grantCapability(admin, self, "content.review");
	assert.doesNotMatch((await s.call("/bibliotheek/nakijken", { who: teacher })).body, /href="\/bibliotheek\/nakijken\/stale-draft\/2"/);
	assert.equal((await s.call("/bibliotheek/nakijken/stale-draft/2", { who: teacher })).status, 404);
	const own = await s.call("/bibliotheek/nakijken/stale-draft/2", { who: teacher, method: "POST", form: { decision: "approved" } });
	assert.equal(own.status, 409);
	assert.match(own.body, /Je kunt je eigen inhoud niet nakijken/);

	// changes requested needs a note; with one, the author sees the decision and the comment
	const noNote = await s.call("/bibliotheek/nakijken/stale-draft/2", { who: reviewer, method: "POST", form: { decision: "changes_requested" } });
	assert.equal(noNote.status, 422);
	assert.match(noNote.body, /opmerking voor de auteur/);
	const changed = await s.call("/bibliotheek/nakijken/stale-draft/2", {
		who: reviewer,
		method: "POST",
		form: { decision: "changes_requested", comment: "Korter graag." },
	});
	assert.equal(changed.status, 303);
	const editor = await s.call("/bibliotheek/stale-draft", { who: teacher });
	assert.match(editor.body, /Aanpassingen gevraagd door parent\./);
	assert.match(editor.body, /Korter graag\./);
	// a decided revision is never decided twice
	const twice = await s.call("/bibliotheek/nakijken/stale-draft/2", { who: reviewer, method: "POST", form: { decision: "approved" } });
	assert.equal(twice.status, 409);
	assert.match(twice.body, /Deze revisie is al nagekeken/);
});

test("publishing (breinhap#33): an explicitly granted publisher releases an approved revision, withdraws it and restores it", async () => {
	const s = await stack();
	const teacher = await s.login("teacher");
	const reviewer = await s.login("parent");
	const admin = { sub: "admin", role: "breinhap.admin" };
	const parent = { sub: "parent", role: "breinhap.parent" };
	const author = { sub: "teacher", role: "breinhap.teacher" };

	await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: validFields() });
	await s.call("/bibliotheek/prikkel-reactie/vastleggen", { who: teacher, method: "POST", form: { expectedVersion: "1" } });
	await s.call("/bibliotheek/prikkel-reactie/aanbieden", { who: teacher, method: "POST", form: { revision: "1" } });
	await s.directory.grantCapability(admin, parent, "content.review");
	await s.call("/bibliotheek/nakijken/prikkel-reactie/1", { who: reviewer, method: "POST", form: { decision: "approved" } });

	// the grant is explicit: an author or administrator without it has no page and no action
	assert.doesNotMatch((await s.call("/bibliotheek", { who: teacher })).body, /href="\/bibliotheek\/publicaties"/);
	const refused = await s.call("/bibliotheek/publicaties", { who: teacher });
	assert.equal(refused.status, 403);
	assert.match(refused.body, /Alleen aangewezen uitgevers kunnen inhoud publiceren/);
	assert.equal(
		(await s.call("/bibliotheek/publicaties/prikkel-reactie/publiceren", { who: teacher, method: "POST", form: { revision: "1" } })).status,
		403,
	);
	assert.equal((await s.call("/bibliotheek/publicaties", { who: await s.login("admin") })).status, 403);

	await s.directory.grantCapability(admin, author, "content.publish");
	const library = await s.call("/bibliotheek", { who: teacher });
	assert.match(library.body, /href="\/bibliotheek\/publicaties"/);
	assert.match(library.body, /Publicaties beheren/);

	const page = await s.call("/bibliotheek/publicaties", { who: teacher });
	assert.equal(page.status, 200);
	assert.match(page.body, /Goedgekeurde revisies/);
	assert.match(page.body, /Prikkel en reactie/);
	assert.match(page.body, /href="\/bibliotheek\/prikkel-reactie"/);
	assert.match(page.body, />Publiceren<\/button>/);
	assert.doesNotMatch(page.body, /Biologie voor jou 3/); // no sources on the publisher page

	// CSRF is required for every publication mutation
	const forged = await s.call("/bibliotheek/publicaties/prikkel-reactie/publiceren", {
		who: teacher,
		method: "POST",
		form: { revision: "1", csrf: "forged" },
	});
	assert.equal(forged.status, 403);
	assert.match(forged.body, /Aanvraag geweigerd|Laad de pagina opnieuw/);

	const published = await s.call("/bibliotheek/publicaties/prikkel-reactie/publiceren", {
		who: teacher,
		method: "POST",
		form: { revision: "1" },
	});
	assert.equal(published.status, 303);
	assert.equal(published.headers.location, "/bibliotheek/publicaties?gepubliceerd=1");
	const afterPublish = await s.call(published.headers.location, { who: teacher });
	assert.match(afterPublish.body, /Revisie 1 is gepubliceerd\./);
	assert.match(afterPublish.body, /Gepubliceerd \(packversie 1\)/);
	assert.match(afterPublish.body, />Intrekken<\/button>/);
	assert.doesNotMatch(afterPublish.body, />Publiceren<\/button>/);

	const editor = await s.call("/bibliotheek/prikkel-reactie", { who: teacher });
	assert.match(editor.body, /Gepubliceerd: revisie 1 \(packversie 1\)\./);
	assert.match(editor.body, /gepubliceerd \(packversie 1\)/);
	assert.match(editor.body, />Intrekken<\/button>/);
	assert.match((await s.call("/bibliotheek", { who: teacher })).body, /Gepubliceerd · revisie 1/);

	// the same revision is not published twice
	const twice = await s.call("/bibliotheek/publicaties/prikkel-reactie/publiceren", {
		who: teacher,
		method: "POST",
		form: { revision: "1" },
	});
	assert.equal(twice.status, 409);
	assert.match(twice.body, /Deze revisie is al gepubliceerd/);

	// a revision that is not approved is refused, and so is an unknown one
	await s.call("/bibliotheek/prikkel-reactie", {
		who: teacher,
		method: "POST",
		form: { ...validFields(), title: "Nieuwe titel", expectedVersion: "1" },
	});
	await s.call("/bibliotheek/prikkel-reactie/vastleggen", { who: teacher, method: "POST", form: { expectedVersion: "2" } });
	const unapproved = await s.call("/bibliotheek/publicaties/prikkel-reactie/publiceren", {
		who: teacher,
		method: "POST",
		form: { revision: "2" },
	});
	assert.equal(unapproved.status, 409);
	assert.match(unapproved.body, /Deze revisie is nog niet goedgekeurd/);
	const missing = await s.call("/bibliotheek/publicaties/onbekend/publiceren", {
		who: teacher,
		method: "POST",
		form: { revision: "1" },
	});
	assert.equal(missing.status, 404);

	// withdrawal stops access, leaves the history and offers a new release
	const withdrawn = await s.call("/bibliotheek/publicaties/prikkel-reactie/intrekken", { who: teacher, method: "POST", form: {} });
	assert.equal(withdrawn.status, 303, withdrawn.body);
	assert.equal(withdrawn.headers.location, "/bibliotheek/publicaties?ingetrokken=1");
	const afterWithdraw = await s.call(withdrawn.headers.location, { who: teacher });
	assert.match(afterWithdraw.body, /De publicatie is ingetrokken\./);
	assert.match(afterWithdraw.body, /Ingetrokken/);
	assert.match(afterWithdraw.body, /Opnieuw publiceren/);
	assert.match((await s.call("/bibliotheek", { who: teacher })).body, /Publicatie ingetrokken · revisie 1/);
	const withdrawnEditor = await s.call("/bibliotheek/prikkel-reactie", { who: teacher });
	assert.match(withdrawnEditor.body, /Nog geen actieve publicatie\./);
	assert.match(withdrawnEditor.body, /publicatie ingetrokken/);
	assert.equal((await s.call("/bibliotheek/publicaties/prikkel-reactie/intrekken", { who: teacher, method: "POST", form: {} })).status, 409);

	// restoring the approved revision publishes it as a new release
	const restored = await s.call("/bibliotheek/publicaties/prikkel-reactie/herstellen", {
		who: teacher,
		method: "POST",
		form: { revision: "1" },
	});
	assert.equal(restored.status, 303);
	assert.equal(restored.headers.location, "/bibliotheek/publicaties?hersteld=1");
	const afterRestore = await s.call(restored.headers.location, { who: teacher });
	assert.match(afterRestore.body, /Revisie 1 is opnieuw gepubliceerd\./);
	assert.match(afterRestore.body, /Gepubliceerd \(packversie 2\)/);

	// a non-publisher can never act, even with a valid form and CSRF
	const denied = await s.call("/bibliotheek/publicaties/prikkel-reactie/intrekken", { who: reviewer, method: "POST", form: {} });
	assert.equal(denied.status, 403);
	assert.match(denied.body, /Alleen aangewezen uitgevers kunnen inhoud publiceren/);
});

test("assigning (breinhap#34): a linked adult assigns, changes and revokes; roles, CSRF, Origin and publication state are enforced", async () => {
	const s = await stack();
	const teacher = await s.login("teacher");
	const parent = await s.login("parent");
	const tutor = await s.login("tutor");
	const boss = await s.login("admin");
	const adminP = { sub: "admin", role: "breinhap.admin" };
	const teacherP = { sub: "teacher", role: "breinhap.teacher" };
	const parentP = { sub: "parent", role: "breinhap.parent" };
	const tutorP = { sub: "tutor", role: "breinhap.tutor" };
	const learner = await s.directory.createLearner(adminP, { displayName: "Leerling Een", schoolYear: 3 });
	const group = await s.directory.createGroup(adminP, { name: "Klas 3A" });
	await s.directory.addToGroup(adminP, { groupId: group, learnerId: learner });
	await s.directory.link(adminP, teacherP, { groupId: group });
	await s.directory.link(adminP, parentP, { learnerId: learner });
	await s.directory.link(adminP, tutorP, { learnerId: learner });
	await s.directory.link(adminP, tutorP, { groupId: group });

	// a published, independently approved revision is the only assignable authority
	await s.call("/bibliotheek/nieuw", { who: teacher, method: "POST", form: validFields() });
	await s.call("/bibliotheek/prikkel-reactie/vastleggen", { who: teacher, method: "POST", form: { expectedVersion: "1" } });
	await s.call("/bibliotheek/prikkel-reactie/aanbieden", { who: teacher, method: "POST", form: { revision: "1" } });
	await s.directory.grantCapability(adminP, parentP, "content.review");
	await s.call("/bibliotheek/nakijken/prikkel-reactie/1", { who: parent, method: "POST", form: { decision: "approved" } });
	await s.directory.grantCapability(adminP, teacherP, "content.publish");
	const published = await s.call("/bibliotheek/publicaties/prikkel-reactie/publiceren", { who: teacher, method: "POST", form: { revision: "1" } });
	assert.equal(published.status, 303);
	const publicationId = (
		await pool.query(
			"SELECT id FROM content_publications WHERE workspace_id = $1 AND learning_object_id = 'prikkel-reactie' AND state = 'active'",
			[s.workspace],
		)
	).rows[0].id;

	// the link is on every assigner's library, never on the administrator's
	assert.match((await s.call("/bibliotheek", { who: teacher })).body, /href="\/bibliotheek\/toewijzen"/);
	assert.match((await s.call("/bibliotheek", { who: parent })).body, /href="\/bibliotheek\/toewijzen"/);
	assert.doesNotMatch((await s.call("/bibliotheek", { who: boss })).body, /href="\/bibliotheek\/toewijzen"/);
	assert.equal((await s.call("/bibliotheek/toewijzen", { who: boss })).status, 403);

	// the page lists only the targets the current role may use
	const teacherPage = await s.call("/bibliotheek/toewijzen", { who: teacher });
	assert.equal(teacherPage.status, 200);
	assert.match(teacherPage.body, /Inhoud toewijzen/);
	assert.match(teacherPage.body, /Prikkel en reactie/);
	assert.match(teacherPage.body, /Klas 3A/);
	assert.doesNotMatch(teacherPage.body, /Leerling Een/);
	const parentPage = await s.call("/bibliotheek/toewijzen", { who: parent });
	assert.match(parentPage.body, /Leerling Een/);
	assert.doesNotMatch(parentPage.body, /Klas 3A/);
	const tutorPage = await s.call("/bibliotheek/toewijzen", { who: tutor });
	assert.match(tutorPage.body, /Leerling Een/);
	assert.match(tutorPage.body, /Klas 3A/);

	// CSRF and Origin are required for every change
	assert.equal(
		(await s.call("/bibliotheek/toewijzen", {
			who: teacher,
			method: "POST",
			form: { publicationId, audience: `group:${group}`, csrf: "forged" },
		})).status,
		403,
	);
	assert.equal(
		(await s.call("/bibliotheek/toewijzen", {
			who: teacher,
			method: "POST",
			form: { publicationId, audience: `group:${group}` },
			origin: "https://evil.example",
		})).status,
		403,
	);
	assert.equal(
		(await s.call("/bibliotheek/toewijzen", {
			who: boss,
			method: "POST",
			form: { publicationId, audience: `group:${group}` },
		})).status,
		403,
	);

	// a teacher assigns to a linked group, never to an individual learner
	assert.equal(
		(await s.call("/bibliotheek/toewijzen", {
			who: teacher,
			method: "POST",
			form: { publicationId, audience: `learner:${learner}` },
		})).status,
		404,
	);
	const assigned = await s.call("/bibliotheek/toewijzen", {
		who: teacher,
		method: "POST",
		form: { publicationId, audience: `group:${group}` },
	});
	assert.equal(assigned.status, 303);
	assert.equal(assigned.headers.location, "/bibliotheek/toewijzen?toegewezen=1");
	const afterAssign = await s.call(assigned.headers.location, { who: teacher });
	assert.match(afterAssign.body, /De inhoud is toegewezen\./);
	assert.match(afterAssign.body, /Beschikbaar/);
	assert.match(afterAssign.body, /Klas 3A/);

	// one active assignment per publication and target
	const duplicate = await s.call("/bibliotheek/toewijzen", {
		who: teacher,
		method: "POST",
		form: { publicationId, audience: `group:${group}` },
	});
	assert.equal(duplicate.status, 409);
	assert.match(duplicate.body, /al aan dit doel toegewezen/);

	// the window can change only with the current version
	const row = (
		await pool.query("SELECT id, version FROM content_assignments WHERE workspace_id = $1 AND group_id = $2", [s.workspace, group])
	).rows[0];
	const day = (offset) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
	const changed = await s.call(`/bibliotheek/toewijzen/${row.id}`, {
		who: teacher,
		method: "POST",
		form: { expectedVersion: String(row.version), notBefore: day(1), availableUntil: day(30) },
	});
	assert.equal(changed.status, 303);
	assert.equal(changed.headers.location, "/bibliotheek/toewijzen?gewijzigd=1");
	assert.match((await s.call(changed.headers.location, { who: teacher })).body, /De periode is gewijzigd\./);
	const stale = await s.call(`/bibliotheek/toewijzen/${row.id}`, {
		who: teacher,
		method: "POST",
		form: { expectedVersion: String(row.version), notBefore: day(1), availableUntil: day(30) },
	});
	assert.equal(stale.status, 409);
	assert.match(stale.body, /intussen gewijzigd/);

	// explicit revocation keeps the history
	const revoked = await s.call(`/bibliotheek/toewijzen/${row.id}/intrekken`, { who: teacher, method: "POST", form: {} });
	assert.equal(revoked.status, 303);
	assert.equal(revoked.headers.location, "/bibliotheek/toewijzen?ingetrokken=1");
	const afterRevoke = await s.call(revoked.headers.location, { who: teacher });
	assert.match(afterRevoke.body, /De toewijzing is ingetrokken\./);
	assert.match(afterRevoke.body, /Ingetrokken/);

	// a parent assigns to their linked learner
	const parentAssigned = await s.call("/bibliotheek/toewijzen", {
		who: parent,
		method: "POST",
		form: { publicationId, audience: `learner:${learner}` },
	});
	assert.equal(parentAssigned.status, 303);
	assert.match((await s.call("/bibliotheek/toewijzen", { who: parent })).body, /Leerling Een/);

	// withdrawing the publication ends future access and leaves a clear state
	const withdrawn = await s.call("/bibliotheek/publicaties/prikkel-reactie/intrekken", { who: teacher, method: "POST", form: {} });
	assert.equal(withdrawn.status, 303);
	const withdrawnPage = await s.call("/bibliotheek/toewijzen", { who: parent });
	assert.match(withdrawnPage.body, /Publicatie ingetrokken/);
	assert.match(withdrawnPage.body, /Er is nog geen actieve publicatie om toe te wijzen/);
	const gone = await s.call("/bibliotheek/toewijzen", {
		who: parent,
		method: "POST",
		form: { publicationId, audience: `learner:${learner}` },
	});
	assert.equal(gone.status, 404);
});
