import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { after, test } from "node:test";
import { manifest } from "../src/platform.mjs";
import { createIdentity } from "../src/identity.mjs";
import { createManagementServer } from "../src/server.mjs";
import { makeStore, member } from "./helpers.mjs";

const servers = [];
after(async () => {
	await Promise.all(
		servers.map((server) => new Promise((resolve) => server.close(resolve))),
	);
});
async function client(options) {
	const server = createManagementServer(options);
	servers.push(server);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (path, { headers = {}, method = "GET", body } = {}) =>
		new Promise((resolve, reject) => {
			const req = http.request(
				{
					hostname: "127.0.0.1",
					port: server.address().port,
					path,
					method,
					headers: { Host: "management.breinhap.com", ...headers },
				},
				(res) => {
					let body = "";
					res.setEncoding("utf8");
					res.on("data", (chunk) => {
						body += chunk;
					});
					res.on("end", () =>
						resolve({ status: res.statusCode, headers: res.headers, body }),
					);
				},
			);
			req.on("error", reject);
			req.end(body);
		});
}

test("production default never accepts client identity or role assertions", async () => {
	const get = await client();
	for (const path of ["/", "/bibliotheek", "/api/content", "/?role=admin"]) {
		const res = await get(path, {
			headers: {
				Cookie: "role=admin; session=forged",
				Authorization: "Bearer forged",
				"X-User-Role": "admin",
				"X-Forwarded-User": "admin",
			},
		});
		assert.equal(res.status, 303);
		assert.equal(res.headers.location, "/login");
		assert.doesNotMatch(res.body, /Beheernavigatie|inhoudsbibliotheek/);
		assert.equal(res.headers["cache-control"], "no-store");
	}
	const signIn = await get("/aanmelden");
	assert.equal(signIn.status, 503);
	assert.match(signIn.body, /nog niet aanmelden/);
	assert.doesNotMatch(signIn.body, /<form|Beheernavigatie/);
});

test("real Host and request target determine isolation, never forwarded headers", async () => {
	let checked = 0;
	const get = await client({
		resolveAccess: async () => {
			checked++;
			return "management";
		},
	});
	for (const host of [
		"breinhap.com",
		"www.breinhap.com",
		"breinhap.asafarim.site",
		"management.breinhap.com.attacker.test",
		"Management.breinhap.com",
		"management.breinhap.com:443",
	]) {
		const res = await get("/bibliotheek", {
			headers: { Host: host, "X-Forwarded-Host": "management.breinhap.com" },
		});
		assert.equal(res.status, 421);
	}
	for (const path of [
		"https://management.breinhap.com/bibliotheek",
		"//management.breinhap.com/bibliotheek",
		"/\\attacker.test/healthz",
	]) {
		assert.equal((await get(path)).status, 421);
	}
	assert.equal(checked, 0);
});

test("student, unknown and unavailable identity cannot access the shell", async () => {
	for (const access of ["student", "admin", undefined, "", "forged"]) {
		const get = await client({ resolveAccess: async () => access });
		const res = await get("/bibliotheek");
		assert.equal(res.status, 403);
		assert.match(res.body, /Geen toegang/);
		assert.doesNotMatch(res.body, /Beheernavigatie|Je beheerwerkplek/);
	}
	const get = await client({
		resolveAccess: async () => {
			throw new Error("private detail");
		},
	});
	const res = await get("/");
	assert.equal(res.status, 503);
	assert.doesNotMatch(res.body, /private detail/);
});

test("trusted resolver can render accessible shell and deep links only", async () => {
	const get = await client({ resolveAccess: async () => "management" });
	const res = await get("/bibliotheek");
	assert.equal(res.status, 200);
	assert.match(res.body, /lang="nl"/);
	assert.match(res.body, /href="#inhoud"/);
	assert.match(res.body, /aria-label="Beheernavigatie"/);
	assert.match(res.body, /href="\/bibliotheek" aria-current="page"/);
	assert.match(res.body, /nog geen inhoudsbibliotheek/);
	const missing = await get("/unknown");
	assert.equal(missing.status, 404);
	assert.doesNotMatch(missing.body, /aria-current/);
	assert.equal((await get("/", { method: "HEAD" })).body, "");
});

test("public health and styles are bounded and methods cannot write", async () => {
	const get = await client();
	for (const path of ["/healthz", "/styles.css", "/theme.css"]) {
		const res = await get(path);
		assert.equal(res.status, 200);
		assert.match(
			res.headers["content-security-policy"],
			/frame-ancestors 'none'/,
		);
		assert.equal(
			(await get(path, { headers: { Host: "breinhap.com" } })).status,
			421,
		);
	}
	assert.equal((await get("/healthz")).body, "ok\n");
	for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
		const res = await get("/api/content", { method });
		assert.equal(res.status, 405);
		assert.equal(res.headers.allow, "GET, HEAD");
	}
	assert.equal((await get("/src/server.mjs")).status, 303);
});

test("management image and routing never replace student deployment", async () => {
	const root = new URL("../../../", import.meta.url);
	const compose = await readFile(
		new URL("infra/management/compose.yml", root),
		"utf8",
	);
	assert.match(compose, /BREINHAP_MANAGEMENT_IMAGE/);
	assert.match(compose, /aliases: \[breinhap-management\]/);
	assert.doesNotMatch(compose, /ports:|breinhap-web|BREINHAP_SITE_IMAGE/);
	const caddy = await readFile(
		new URL("infra/management/breinhap-management.caddy", root),
		"utf8",
	);
	assert.match(caddy, /^management\.breinhap\.com \{/);
	assert.match(caddy, /reverse_proxy breinhap-management:8080/);
	const student = await readFile(
		new URL("apps/web/src/build.mjs", root),
		"utf8",
	);
	assert.doesNotMatch(student, /management\/src|resolveAccess|Beheernavigatie/);
});

test("HTTP sign-in and logout compose with the protected management shell", async () => {
	let state;
	const store = await makeStore();
	await member(store, "person", "breinhap.parent");
	const identity = createIdentity({
		store,
		provider: {
			authorizationUrl: async (flow) => {
				state = flow.state;
				return `https://id.asafarim.site/auth?state=${state}`;
			},
			exchange: async () => ({
				sub: "person",
				sid: "browser",
				authTime: Math.floor(Date.now() / 1000),
				issuedAt: Math.floor(Date.now() / 1000),
				accessToken: "secret",
				expiresIn: 3600,
			}),
			userInfo: async () => ({ sub: "person" }),
			logoutUrl: () => "https://id.asafarim.site/session/end",
		},
		grants: async () => ({
			appId: "breinhap",
			subject: "person",
			state: "active",
			roles: ["breinhap.parent"],
			permissions: ["breinhap.management.access"],
		}),
	});
	const get = await client({ identity });
	const signIn = await get("/aanmelden");
	assert.equal(signIn.status, 200);
	assert.match(signIn.body, /Aanmelden met ASafariM/);
	assert.ok(signIn.body.includes(`Breinhap beheer · ${manifest.version}`));
	assert.equal((await get("/readyz")).status, 200);
	const start = await get("/auth/start");
	const flowCookie = start.headers["set-cookie"][0].split(";")[0];
	const callback = await get(`/auth/callback?code=valid&state=${state}`, {
		headers: { Cookie: flowCookie },
	});
	const session = callback.headers["set-cookie"][0].split(";")[0];
	const home = await get("/", { headers: { Cookie: session } });
	assert.equal(home.status, 200);
	assert.match(home.body, /Je rollen: Ouder/);
	assert.doesNotMatch(home.body, /person|secret/);
	const csrf = /name="csrf" value="([^"]+)"/.exec(home.body)[1];
	const logout = await get("/afmelden", {
		method: "POST",
		headers: { Cookie: session, Origin: "https://management.breinhap.com" },
		body: `csrf=${csrf}`,
	});
	assert.equal(logout.status, 303);
	assert.equal((await get("/", { headers: { Cookie: session } })).status, 303);
	assert.equal((await get("/.well-known/asafarim-app.json")).status, 200);
});

test("an administrative dependency outage returns unavailable rather than denied or private error details", async () => {
	const get = await client({
		identity: {
			handle: async () => null,
			privileged: async () => {
				throw new Error("private dependency detail");
			},
		},
	});
	const response = await get("/beheer");
	assert.equal(response.status, 503);
	assert.match(response.body, /Tijdelijk niet beschikbaar/);
	assert.doesNotMatch(response.body, /private dependency detail/);
});

test("management release versions agree and its launcher remains grant-filtered", async () => {
	const pkg = JSON.parse(
		await readFile(new URL("../package.json", import.meta.url), "utf8"),
	);
	const lock = JSON.parse(
		await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
	);
	assert.equal(manifest.version, pkg.version);
	assert.equal(lock.version, pkg.version);
	assert.equal(lock.packages[""].version, pkg.version);
	assert.equal(manifest.ui.launcher.access, "authenticated");
	assert.equal(manifest.ui.launcher.requiresAccountToUse, true);
});
