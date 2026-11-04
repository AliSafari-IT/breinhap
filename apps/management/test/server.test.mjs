import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { after, test } from "node:test";
import { createManagementServer } from "../src/server.mjs";

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
	return (path, { headers = {}, method = "GET" } = {}) =>
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
			req.end();
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
		assert.equal(res.headers.location, "/aanmelden");
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
	assert.equal((await get("/unknown")).status, 404);
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
