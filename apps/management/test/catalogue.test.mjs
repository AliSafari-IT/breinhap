// breinhap#35 against a real Postgres: the public mission catalogue on breinhap.com. Only an
// administrator can list an object, only an active reviewed publication is ever shown, withdrawal takes it
// out at once, and the anonymous player stores nothing and sets no cookie.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";

import { ContentError, ContentStore } from "../src/content.mjs";
import { migrate } from "../src/db.mjs";
import { Directory } from "../src/directory.mjs";
import { createLearnerHandler } from "../src/learner-server.mjs";
import { PublishingStore } from "../src/publishing.mjs";

let admin;
let pool;
const database = `breinhap_test_${randomBytes(6).toString("hex")}`;

before(async () => {
	if (!process.env.POSTGRES_TEST_URL)
		throw new Error("Use pnpm --filter @breinhap/management test, or set POSTGRES_TEST_URL for this suite");
	admin = new pg.Client({ connectionString: process.env.POSTGRES_TEST_URL });
	await admin.connect();
	await admin.query(`CREATE DATABASE ${database}`);
	const url = new URL(process.env.POSTGRES_TEST_URL);
	url.pathname = `/${database}`;
	pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
	pool.on("error", () => {});
	await migrate(pool);
});
after(async () => {
	await pool?.end();
	await admin?.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
	await admin?.end();
});

const code = async (promise) => {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ContentError || error?.code === "forbidden") return error.code;
		throw error;
	}
	return "ok";
};

let n = 0;
const adult = (role = "teacher") => ({ sub: `test:${role}-${n++}`, role: `breinhap.${role}` });
const boss = () => adult("admin");
const sources = [{ kind: "own", title: "Eigen werk" }];

function object({ id = `lo-${n++}`, subject = "biologie", grade = 3, title = "Prikkel en reactie" } = {}) {
	return {
		schemaVersion: 1,
		id,
		subject,
		title,
		grade,
		curriculum: { leerdoel: "De leerlingen leggen prikkel en reactie uit." },
		review: { status: "draft" },
		missions: [
			{
				id: `${id}-m1`,
				title: "Wat is een prikkel?",
				minutes: 3,
				warmup: { text: "Denk aan iets dat je laat schrikken." },
				learn: [{ text: "Een prikkel is een verandering die een organisme waarneemt.", example: "Een fel licht." }],
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
						items: ["prikkel", "receptor", "reactie"],
						explanation: "Eerst de prikkel, dan de receptor, dan de reactie.",
					},
				],
				commonMistakes: [{ mistake: "Een prikkel is een reactie.", why: "De reactie komt pas na de prikkel." }],
			},
		],
	};
}

/** A workspace with an author, an independent reviewer and an explicit publisher. */
async function setup() {
	const directory = await new Directory({ pool, workspace: `w-${randomBytes(4).toString("hex")}` }).ready();
	const content = new ContentStore({ directory });
	const publishing = new PublishingStore({ content });
	const author = adult();
	const reviewer = adult();
	const publisher = adult();
	const admin = boss();
	await directory.grantCapability(boss(), reviewer, "content.review");
	await directory.grantCapability(boss(), publisher, "content.publish");
	/** Creates, reviews and publishes one object; returns its id. */
	const published = async (fields) => {
		const { id } = await content.create(author, object(fields), sources);
		await content.snapshot(author, id, 1);
		await content.submit(author, id, 1);
		await content.review(reviewer, id, 1, "approved");
		await publishing.publish(publisher, id, 1);
		return id;
	};
	return { directory, content, publishing, author, reviewer, publisher, admin, published };
}

test("only an administrator lists, and only an active publication can be listed", async () => {
	const w = await setup();
	const id = await w.published();
	// authors, reviewers and even explicit publishers do not decide what is public
	for (const who of [w.author, w.reviewer, w.publisher, adult("parent")])
		assert.equal(await code(w.publishing.list(who, id)), "forbidden");
	assert.equal(await code(w.publishing.listingCandidates(w.publisher)), "forbidden");
	assert.deepEqual(await w.publishing.publicCatalog(), []);

	// an object that was never published, and an unknown one
	const { id: draft } = await w.content.create(w.author, object(), sources);
	assert.equal(await code(w.publishing.list(w.admin, draft)), "not_published");
	assert.equal(await code(w.publishing.list(w.admin, "bestaat-niet")), "not_found");
	assert.equal(await code(w.publishing.publicObject(draft)), "not_found");

	await w.publishing.list(w.admin, id);
	assert.equal(await code(w.publishing.list(w.admin, id)), "already_listed");
	const rows = await w.publishing.publicCatalog();
	assert.deepEqual(rows, [{ id, title: "Prikkel en reactie", subject: "biologie", grade: 3, missions: 1, minutes: 3 }]);
	assert.equal((await w.publishing.candidates(w.publisher))[0].listed, true);
	const queue = await w.publishing.listingCandidates(w.admin);
	assert.deepEqual(queue.map((r) => [r.id, r.listed]), [[id, true]]);
	assert.equal("ownerSub" in queue[0] || "sources" in queue[0], false);

	const audit = await pool.query("SELECT action, result FROM audit_events WHERE workspace_id = $1 AND action LIKE 'content.%list'", [w.directory.workspace]);
	assert.ok(audit.rows.some((r) => r.action === "content.list" && r.result === "denied"));
	assert.ok(audit.rows.some((r) => r.action === "content.list" && r.result === "done"));
});

test("the public object is the clean pack: no review, sources, owner or revision", async () => {
	const w = await setup();
	const id = await w.published();
	await w.publishing.list(w.admin, id);
	const shown = await w.publishing.publicObject(id);
	assert.equal(shown.id, id);
	for (const key of ["review", "sources", "owner", "ownerSub", "revision", "reviewer"]) assert.equal(key in shown, false, key);
	assert.doesNotMatch(JSON.stringify(shown), /test:teacher|Eigen werk/);
});

test("filters, withdrawal, a newer release and unlisting change what the public sees at once", async () => {
	const w = await setup();
	const bio = await w.published({ subject: "biologie", grade: 3, title: "B" });
	const math = await w.published({ subject: "wiskunde", grade: 4, title: "A" });
	for (const id of [bio, math]) await w.publishing.list(w.admin, id);
	assert.deepEqual((await w.publishing.publicCatalog()).map((r) => r.id), [bio, math]); // by year, then title
	assert.deepEqual((await w.publishing.publicCatalog({ subject: "wiskunde" })).map((r) => r.id), [math]);
	assert.deepEqual((await w.publishing.publicCatalog({ grade: 3 })).map((r) => r.id), [bio]);
	assert.deepEqual(await w.publishing.publicCatalog({ subject: "wiskunde", grade: 3 }), []);

	// a newer reviewed release stays public and replaces what is shown
	await w.content.update(w.author, bio, 1, { ...object({ id: bio, title: "B nieuw" }) }, sources);
	await w.content.snapshot(w.author, bio, 2);
	await w.content.submit(w.author, bio, 2);
	await w.content.review(w.reviewer, bio, 2, "approved");
	await w.publishing.publish(w.publisher, bio, 2);
	assert.equal((await w.publishing.publicObject(bio)).title, "B nieuw");

	// withdrawal removes it and also ends the listing: publishing again does not make it public again
	await w.publishing.withdraw(w.publisher, bio);
	assert.equal(await code(w.publishing.publicObject(bio)), "not_found");
	await w.publishing.restore(w.publisher, bio, 2);
	assert.equal(await code(w.publishing.publicObject(bio)), "not_found");
	assert.deepEqual((await w.publishing.publicCatalog()).map((r) => r.id), [math]);

	await w.publishing.unlist(w.admin, math);
	assert.equal(await code(w.publishing.unlist(w.admin, math)), "not_listed");
	assert.equal(await code(w.publishing.unlist(adult(), math)), "forbidden");
	assert.deepEqual(await w.publishing.publicCatalog(), []);
});

test("the database refuses listings that skip the service: no publication, no rewrite, no deletes", async () => {
	const w = await setup();
	const id = await w.published();
	const { id: draft } = await w.content.create(w.author, object(), sources);
	const insert = (object, by) =>
		pool.query("INSERT INTO public_listings (workspace_id, id, learning_object_id, listed_by) VALUES ($1, gen_random_uuid(), $2, $3)", [w.directory.workspace, object, by]);
	await assert.rejects(insert(draft, w.publisher.sub), /only published content/);
	await w.publishing.list(w.admin, id);
	await assert.rejects(pool.query("DELETE FROM public_listings WHERE workspace_id = $1", [w.directory.workspace]), /history/);
	await assert.rejects(
		pool.query("UPDATE public_listings SET listed_by = 'someone' WHERE workspace_id = $1", [w.directory.workspace]),
		/keeps its identity/,
	);
	await w.publishing.unlist(w.admin, id);
	await assert.rejects(
		pool.query("UPDATE public_listings SET unlisted_at = now() WHERE workspace_id = $1", [w.directory.workspace]),
		/only be unlisted, once/,
	);
});

/** The isolated public handler, called the way the HTTP server calls it. */
function browser(publishing, { budget = async () => true } = {}) {
	const handler = createLearnerHandler({ learner: undefined, catalog: publishing, budget });
	return async (path, { method = "GET", form, origin = "https://breinhap.com", host = "breinhap.com" } = {}) => {
		const body = form ? new URLSearchParams(form).toString() : "";
		const req = {
			method,
			url: path,
			headers: {
				host,
				...(origin ? { origin } : {}),
				...(form ? { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) } : {}),
				"accept-language": "nl-BE",
			},
			socket: { remoteAddress: "127.0.0.1" },
			async *[Symbol.asyncIterator]() {
				if (body) yield Buffer.from(body);
			},
		};
		let status;
		let headers = {};
		let text = "";
		const res = {
			writeHead: (s, h = {}) => {
				status = s;
				headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
			},
			end: (b) => (text = String(b ?? "")),
		};
		await handler(req, res);
		return { status, headers, body: text };
	};
}
const hidden = (html) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(([, k, v]) => [k, v.replace(/&(amp|quot|lt|gt|#39);/g, (_, e) => ({ amp: "&", quot: '"', lt: "<", gt: ">", "#39": "'" })[e])]));

test("breinhap.com/p/missies: browse, filter and play a listed mission without a login or a cookie", async () => {
	const w = await setup();
	const id = await w.published({ subject: "biologie", grade: 3 });
	const hiddenId = await w.published({ subject: "biologie", grade: 3, title: "Niet openbaar" });
	await w.publishing.list(w.admin, id);
	const get = browser(w.publishing);
	const seen = [];
	const call = async (...args) => {
		const res = await get(...args);
		seen.push(res);
		return res;
	};

	let res = await call("/p/missies");
	assert.equal(res.status, 200);
	assert.match(res.body, new RegExp(`href="/p/missies/${id}">Prikkel en reactie</a>`));
	assert.doesNotMatch(res.body, /Niet openbaar/);
	assert.match(res.body, /<form method="get" action="\/p\/missies"/);
	// filters: only the two known ones survive, anything else is dropped by a redirect
	res = await call("/p/missies?vak=wiskunde");
	assert.equal(res.status, 200);
	assert.match(res.body, /Voor deze keuze is er nog geen missie\./);
	res = await call("/p/missies?vak=biologie&jaar=3&token=secret");
	assert.equal(res.status, 303);
	assert.equal(res.headers.location, "/p/missies?vak=biologie&jaar=3");
	assert.equal((await call("/p/missies/")).status, 303);

	// an unlisted, unknown or malformed id all look the same
	for (const path of [`/p/missies/${hiddenId}`, "/p/missies/bestaat-niet"]) {
		res = await call(path);
		assert.equal(res.status, 404, path);
		assert.match(res.body, /Deze missie is er niet/);
	}
	assert.equal((await call("/p/missies/../bibliotheek")).status, 404);
	assert.equal((await call(`/p/missies/${id}`, { method: "DELETE" })).status, 405);
	assert.equal((await call("/p/missies", { method: "POST", form: {} })).status, 405);

	res = await call(`/p/missies/${id}`);
	assert.equal(res.status, 200);
	assert.match(res.body, /De leerlingen leggen prikkel en reactie uit\./);
	assert.match(res.body, /Je antwoorden blijven alleen op dit scherm/);

	// a run: every step is a POST from the exact public origin, the state stays in the form
	const step = (form, origin) => call(`/p/missies/${id}`, { method: "POST", form, origin });
	assert.equal((await step({ missie: "0", stap: "0", a: "" }, "https://evil.example")).status, 403);
	assert.equal((await step({ missie: "0", stap: "0", a: "" }, null)).status, 403);
	assert.equal((await step({ missie: "9", stap: "0", a: "" })).status, 404);

	res = await step({ missie: "0", stap: "0", a: "" });
	assert.equal(res.status, 200);
	assert.match(res.body, /aria-current="step">Opwarmen/);
	assert.match(res.body, /Denk aan iets dat je laat schrikken\./);
	res = await step(hidden(res.body)); // → learn card
	assert.match(res.body, /aria-current="step">Leren/);
	assert.match(res.body, /Voorbeeld: Een fel licht\./);
	res = await step(hidden(res.body)); // → practice question
	assert.match(res.body, /aria-current="step">Doen/);
	// skipping ahead past an unanswered question is not possible
	const skip = await step({ ...hidden(res.body), stap: "9" });
	assert.match(skip.body, /Wat is een prikkel\?/);
	// no answer chosen: a calm error, nothing recorded
	res = await step({ ...hidden(res.body), kies: "7" });
	assert.match(res.body, /role="alert">Kies een antwoord\./);
	res = await step({ ...hidden(res.body), kies: "1" });
	assert.match(res.body, /<strong>Nog niet\.<\/strong>/);
	assert.match(res.body, /Een prikkel is een verandering in de omgeving\./);
	res = await step(hidden(res.body)); // → order question (check)
	assert.match(res.body, /aria-current="step">Check/);
	const order = { ...hidden(res.body), plaats0: "0", plaats1: "1", plaats2: "2" };
	res = await step({ ...hidden(res.body), plaats0: "0", plaats1: "0", plaats2: "2" });
	assert.match(res.body, /Zet elk stukje op precies één plaats\./);
	res = await step(order);
	assert.match(res.body, /<strong>Klopt\.<\/strong>/);
	res = await step(hidden(res.body));
	assert.match(res.body, /Missie klaar/);
	assert.match(res.body, /Je had 1 van de 2 vragen juist\./);
	assert.match(res.body, /Veelgemaakte fout/);

	// a forged answer string is ignored rather than trusted
	res = await step({ missie: "0", stap: "4", a: "2c0;4o0.1.2;99c3;x".repeat(3) });
	assert.match(res.body, /Wat is een prikkel\?/);

	// withdrawal reaches a run in progress on its next step
	await w.publishing.withdraw(w.publisher, id);
	assert.equal((await step({ missie: "0", stap: "0", a: "" })).status, 404);
	assert.equal((await call(`/p/missies/${id}`)).status, 404);

	for (const r of seen) {
		assert.equal(r.headers["set-cookie"], undefined, "no cookie");
		assert.equal(r.headers["cache-control"], "no-store");
		assert.match(r.headers["content-security-policy"], /script-src 'self'/);
		assert.match(r.headers["x-robots-tag"] ?? "", /noindex/);
	}
});

test("the catalogue is rate limited, fails closed without its store, and stays on the public Host", async () => {
	const w = await setup();
	assert.equal((await browser(w.publishing, { budget: async () => false })("/p/missies")).status, 429);
	assert.equal((await browser(w.publishing, { budget: async () => { throw new Error("redis down"); } })("/p/missies")).status, 503);
	assert.equal((await browser(undefined)("/p/missies")).status, 404);
	// without a practice store the link player itself is absent, not broken
	assert.equal((await browser(w.publishing)("/p/")).status, 404);
	assert.equal((await browser(w.publishing)("/p/missies", { host: "management.breinhap.com" })).status, 421);
});

test("breinhap.com/p/missies.json: the Android app downloads exactly the listed, clean objects", async () => {
	const w = await setup();
	const id = await w.published({ subject: "wiskunde", grade: 3, title: "Ontbinden" });
	await w.published({ subject: "wiskunde", grade: 3, title: "Niet openbaar" });
	await w.publishing.list(w.admin, id);
	const get = browser(w.publishing);

	let res = await get("/p/missies.json");
	assert.equal(res.status, 200);
	assert.match(res.headers["content-type"], /^application\/json/);
	assert.equal(res.headers["set-cookie"], undefined);
	assert.equal(res.headers["cache-control"], "no-store");
	const body = JSON.parse(res.body);
	assert.equal(body.schemaVersion, 1);
	assert.equal(body.objects.length, 1);
	const [{ object, publishedAt }] = body.objects;
	assert.match(publishedAt, /^\d{4}-\d{2}-\d{2}$/);
	assert.equal(object.id, id);
	assert.equal(object.title, "Ontbinden");
	assert.equal(object.missions[0].id, `${id}-m1`);
	for (const key of ["review", "sources", "owner", "ownerSub", "revision"]) assert.equal(key in object, false, key);

	assert.equal((await get("/p/missies.json?vak=wiskunde")).status, 400);
	assert.equal((await get("/p/missies.json", { method: "POST", form: {} })).status, 405);
	assert.equal((await get("/p/missies.json", { host: "management.breinhap.com" })).status, 421);
	assert.equal((await browser(undefined)("/p/missies.json")).status, 404);
	assert.equal((await browser(w.publishing, { budget: async () => false })("/p/missies.json")).status, 429);

	// withdrawal empties the download at once
	await w.publishing.withdraw(w.publisher, id);
	assert.deepEqual(JSON.parse((await get("/p/missies.json")).body).objects, []);
});
