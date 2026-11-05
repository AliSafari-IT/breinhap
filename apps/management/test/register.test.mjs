import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createIdentity, ORIGIN } from "../src/identity.mjs";
import { createPlatform } from "../src/platform.mjs";
import { createHandler } from "../src/server.mjs";
import { MAX_PENDING_REQUESTS } from "../src/store.mjs";
import { makeStore, member } from "./helpers.mjs";

// ASafariM roles per subject; a subject that is not listed is a brand-new ASafariM account.
const known = new Map([
	["admin", "breinhap.admin"],
	["child", "breinhap.student"],
]);
const grants = async (subject) => {
	const role = known.get(subject);
	return {
		appId: "breinhap",
		subject,
		state: role ? "active" : "inactive",
		roles: role ? [role] : [],
		permissions:
			role === "breinhap.admin"
				? ["breinhap.management.access", "breinhap.memberships.manage"]
				: role
					? ["breinhap.student.access"]
					: [],
	};
};

async function setup() {
	const store = await makeStore();
	await member(store, "admin", "breinhap.admin");
	let next;
	const identity = createIdentity({
		store,
		grants,
		provider: {
			authorizationUrl: async (flow) =>
				`https://id.asafarim.site/auth?state=${flow.state}`,
			exchange: async () => ({
				sub: next,
				sid: `sid-${next}`,
				issuedAt: Math.floor(Date.now() / 1000),
				authTime: Math.floor(Date.now() / 1000),
				accessToken: "access",
				expiresIn: 3600,
			}),
			userInfo: async (_token, sub) => ({ sub }),
		},
	});
	const handler = createHandler({ identity });
	const call = (
		path,
		{ cookie = "", method = "GET", body = "", origin = ORIGIN } = {},
	) =>
		new Promise((resolve, reject) => {
			const req = Object.assign(Readable.from([body]), {
				method,
				url: path,
				headers: { host: "management.breinhap.com", cookie, origin },
			});
			const res = {
				writeHead(status, headers) {
					this.status = status;
					this.headers = headers;
				},
				end(text) {
					resolve({
						status: this.status,
						headers: this.headers,
						body: text ? String(text) : "",
					});
				},
			};
			handler(req, res).catch(reject);
		});
	async function login(subject) {
		next = subject;
		const start = await call("/auth/start");
		const flow = start.headers["Set-Cookie"][0].split(";")[0];
		const state = new URL(start.headers.Location).searchParams.get("state");
		const done = await call(`/auth/callback?state=${state}&code=x`, {
			cookie: flow,
		});
		assert.equal(done.status, 303);
		return done.headers["Set-Cookie"][0].split(";")[0];
	}
	const csrf = (body) => /name="csrf" value="([^"]+)"/.exec(body)[1];
	return { store, identity, call, login, csrf };
}

test("the register page explains one simple path and needs no invitation", async () => {
	const { call } = await setup();
	const page = await call("/register");
	assert.equal(page.status, 200);
	assert.match(page.body, /Registreren bij Breinhap/);
	assert.match(page.body, /ouder, begeleider of leerkracht/);
	assert.match(page.body, /href="\/auth\/start">Registreren</);
	assert.doesNotMatch(page.body, /uitnodig/i);
	const anonymous = await call("/registreren");
	assert.equal(anonymous.status, 303);
	assert.equal(anonymous.headers.Location, "/register");
});

test("a new account chooses a role, waits for approval, and then gets in", async () => {
	const { store, call, login, csrf } = await setup();
	const cookie = await login("newcomer");
	const home = await call("/", { cookie });
	assert.equal(home.status, 303);
	assert.equal(home.headers.Location, "/registreren");
	const form = await call("/registreren", { cookie });
	assert.equal(form.status, 200);
	assert.match(form.body, /Kies je rol/);
	for (const role of ["breinhap.parent", "breinhap.tutor", "breinhap.teacher"])
		assert.match(form.body, new RegExp(`value="${role}"`));
	assert.doesNotMatch(form.body, /breinhap\.admin|breinhap\.student/);
	const token = csrf(form.body);
	// Self-service can never claim the administrator or student role, and CSRF is required.
	for (const role of ["breinhap.admin", "breinhap.student", "teacher"])
		assert.equal(
			(
				await call("/registreren", {
					cookie,
					method: "POST",
					body: `role=${role}&csrf=${token}`,
				})
			).status,
			400,
		);
	assert.equal(
		(
			await call("/registreren", {
				cookie,
				method: "POST",
				body: "role=breinhap.teacher&csrf=forged",
			})
		).status,
		403,
	);
	assert.equal(
		(
			await call("/registreren", {
				cookie,
				method: "POST",
				body: `role=breinhap.teacher&csrf=${token}`,
				origin: "https://evil.example",
			})
		).status,
		403,
	);
	const sent = await call("/registreren", {
		cookie,
		method: "POST",
		body: `role=breinhap.teacher&csrf=${token}`,
	});
	assert.equal(sent.status, 303);
	const waiting = await call("/registreren", { cookie });
	assert.match(waiting.body, /Aanvraag verstuurd/);
	assert.match(waiting.body, /Leerkracht/);
	assert.equal((await call("/bibliotheek", { cookie })).status, 303);
	// A second request does not replace the first.
	await call("/registreren", {
		cookie,
		method: "POST",
		body: `role=breinhap.parent&csrf=${token}`,
	});
	assert.equal((await store.roleRequest("newcomer")).role, "breinhap.teacher");

	const admin = await login("admin");
	const manage = await call("/beheer", { cookie: admin });
	assert.equal(manage.status, 200);
	assert.match(
		manage.body,
		/<code>newcomer<\/code> vraagt toegang als <strong>Leerkracht/,
	);
	const id = /name="request" value="([^"]+)"/.exec(manage.body)[1];
	const approved = await call("/beheer/goedkeuren", {
		cookie: admin,
		method: "POST",
		body: `request=${id}&csrf=${csrf(manage.body)}`,
	});
	assert.equal(approved.status, 303);
	assert.equal(approved.headers.Location, "/beheer");
	const inside = await call("/bibliotheek", { cookie });
	assert.equal(inside.status, 200);
	assert.match(inside.body, /Je rollen: Leerkracht/);
	assert.equal((await call("/registreren", { cookie })).headers.Location, "/");
	assert.deepEqual(await store.roleRequests(), []);
	// Revoking takes access away again.
	await store.revokeMember("newcomer");
	assert.equal((await call("/bibliotheek", { cookie })).status, 303);
});

test("only an administrator can approve, and a rejected request grants nothing", async () => {
	const { store, call, login, csrf } = await setup();
	const cookie = await login("newcomer");
	const form = await call("/registreren", { cookie });
	await call("/registreren", {
		cookie,
		method: "POST",
		body: `role=breinhap.parent&csrf=${csrf(form.body)}`,
	});
	const [request] = await store.roleRequests();
	assert.equal(
		(
			await call("/beheer/goedkeuren", {
				cookie,
				method: "POST",
				body: `request=${request.id}&csrf=${csrf(form.body)}`,
			})
		).status,
		403,
	);
	const admin = await login("admin");
	const manage = await call("/beheer", { cookie: admin });
	const rejected = await call("/beheer/weigeren", {
		cookie: admin,
		method: "POST",
		body: `request=${request.id}&csrf=${csrf(manage.body)}`,
	});
	assert.equal(rejected.status, 303);
	assert.equal(await store.membership("newcomer"), null);
	assert.equal(await store.roleRequest("newcomer"), null);
	// A stale approval for a removed request does nothing.
	assert.equal(
		(
			await call("/beheer/goedkeuren", {
				cookie: admin,
				method: "POST",
				body: `request=${request.id}&csrf=${csrf(manage.body)}`,
			})
		).status,
		409,
	);
	assert.equal(await store.membership("newcomer"), null);
});

test("an ASafariM student account cannot ask for an adult role", async () => {
	const { store, call, login } = await setup();
	const cookie = await login("child");
	const page = await call("/registreren", { cookie });
	assert.equal(page.status, 403);
	assert.match(page.body, /leerlingaccount/);
	assert.doesNotMatch(page.body, /name="role"/);
	assert.equal((await call("/", { cookie })).status, 403);
	// Even an approved adult membership does not open management for a student account.
	await member(store, "child", "breinhap.parent");
	assert.equal((await call("/", { cookie })).status, 403);
});

test("the administrator role still needs the ASafariM administrator grant", async () => {
	const { store, call, login } = await setup();
	const cookie = await login("newcomer");
	await member(store, "newcomer", "breinhap.admin");
	assert.notEqual((await call("/beheer", { cookie })).status, 200);
	assert.equal((await call("/", { cookie })).status, 303);
});

test("the open request list is bounded", async () => {
	const store = await makeStore();
	for (let i = 0; i < MAX_PENDING_REQUESTS; i++)
		assert.equal(
			await store.requestRole(`p${i}`, "breinhap.parent"),
			"created",
		);
	assert.equal(await store.requestRole("late", "breinhap.parent"), "full");
	assert.equal(await store.requestRole("p1", "breinhap.parent"), "exists");
	await assert.rejects(store.requestRole("x", "breinhap.admin"));
});

test("a registry 404 means a new account without grants, not an outage", async () => {
	const credential = `osk1.breinhap.0123456789ab.${(await import("node:crypto"))
		.generateKeyPairSync("ed25519")
		.privateKey.export({ format: "der", type: "pkcs8" })
		.toString("base64url")}`;
	const status = { value: 404 };
	const platform = createPlatform({
		url: "http://core-api:4020",
		credential,
		fetcher: async () => new Response("{}", { status: status.value }),
	});
	assert.deepEqual(await platform.grants("newcomer"), {
		appId: "breinhap",
		subject: "newcomer",
		state: "inactive",
		roles: [],
		permissions: [],
	});
	status.value = 500;
	await assert.rejects(platform.grants("newcomer"));
});
