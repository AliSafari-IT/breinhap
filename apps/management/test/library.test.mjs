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

async function stack({ withDirectory = true, uploadsOf } = {}) {
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
	const uploads = uploadsOf && directory ? uploadsOf(directory) : undefined;
	const server = createManagementServer({ identity, directory, uploads });
	servers.push(server);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const call = (path, { who, method = "GET", form, origin = ORIGIN, raw } = {}) =>
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
						Cookie: who?.cookie ?? "",
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
	return { login, call, workspace: store.workspace, uploads };
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

async function uploadStack(quota) {
	const storage = new MemoryStorage();
	const scanner = new FakeScanner();
	const clock = { now: Date.now() };
	const s = await stack({
		uploadsOf: (directory) =>
			new UploadStore({ directory, storage, scanner, linkSecret: "s".repeat(40), now: () => clock.now, ...(quota ? { quota } : {}) }),
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
