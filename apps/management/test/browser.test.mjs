import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import { chromium } from "playwright";
import { createIdentity, ORIGIN } from "../src/identity.mjs";
import { createManagementServer } from "../src/server.mjs";
import { makeStore, member } from "./helpers.mjs";

test("a real browser can submit the rendered logout form with a valid Origin and CSRF token", async () => {
	const store = await makeStore();
	const id = randomBytes(32).toString("base64url");
	const now = Date.now();
	await member(store, "browser-admin", "breinhap.admin");
	assert.ok(
		await store.saveSession(id, {
			sub: "browser-admin",
			sid: "browser-session",
			csrf: randomBytes(32).toString("base64url"),
			issuedAt: Math.floor(now / 1000),
			authTime: Math.floor(now / 1000),
			expires: now + 3600000,
			accessToken: "browser-test",
			tokenExpires: now + 3600000,
		}),
	);
	const identity = createIdentity({
		store,
		provider: {
			userInfo: async () => ({ sub: "browser-admin" }),
			logoutUrl: () => `${ORIGIN}/login?logged-out=1`,
		},
		grants: async () => ({
			appId: "breinhap",
			subject: "browser-admin",
			state: "active",
			roles: ["breinhap.admin"],
			permissions: [
				"breinhap.management.access",
				"breinhap.memberships.manage",
			],
		}),
	});
	const server = createManagementServer({ identity });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	let browser;
	let context;
	const submitted = [];
	try {
		browser = await chromium.launch({ headless: true });
		context = await browser.newContext();
		await context.addCookies([
			{
				name: "__Host-breinhap-session",
				value: id,
				url: ORIGIN,
				secure: true,
				httpOnly: true,
				sameSite: "Lax",
			},
		]);
		await context.route(`${ORIGIN}/**`, async (route) => {
			const request = route.request();
			const headers = await request.allHeaders();
			const url = new URL(request.url());
			if (request.method() === "POST")
				submitted.push({ path: url.pathname, origin: headers.origin });
			const response = await new Promise((resolve, reject) => {
				const req = http.request(
					{
						hostname: "127.0.0.1",
						port: server.address().port,
						path: url.pathname + url.search,
						method: request.method(),
						headers: {
							...headers,
							host: "management.breinhap.com",
							connection: "close",
						},
					},
					(res) => {
						const parts = [];
						res.on("data", (chunk) => parts.push(chunk));
						res.on("end", () =>
							resolve({
								status: res.statusCode,
								headers: res.headers,
								body: Buffer.concat(parts),
							}),
						);
					},
				);
				req.on("error", reject);
				req.end(request.postDataBuffer() ?? undefined);
			});
			const forwarded = Object.fromEntries(
				Object.entries(response.headers)
					.filter(
						([key]) =>
							!["connection", "content-length", "transfer-encoding"].includes(
								key,
							),
					)
					.map(([key, value]) => [
						key,
						Array.isArray(value) ? value.join("\n") : String(value),
					]),
			);
			await route.fulfill({
				status: response.status,
				headers: forwarded,
				body: response.body,
			});
		});
		const page = await context.newPage();
		page.on("requestfailed", (req) =>
			console.error(
				"Browser request failed",
				new URL(req.url()).pathname,
				req.failure()?.errorText,
			),
		);
		assert.equal((await page.goto(ORIGIN)).status(), 200);
		// Wait for the redirect request, not its page load: Playwright does not route a request that
		// follows a fulfilled redirect, so loading it would reach the live management.breinhap.com.
		const loggedOut = page.waitForRequest(`${ORIGIN}/login?logged-out=1`);
		await page.getByRole("button", { name: "Afmelden", exact: true }).click();
		await loggedOut;
		assert.deepEqual(submitted, [{ path: "/afmelden", origin: ORIGIN }]);
		assert.equal(await store.getSession(id), null);
		assert.ok(
			!(await context.cookies(ORIGIN)).some(
				(cookie) => cookie.name === "__Host-breinhap-session",
			),
		);
	} finally {
		// The redirected /login request can still be inside the route handler when the assertions are
		// done; stop routing first so closing the browser cannot fail that in-flight callback.
		await context?.unrouteAll({ behavior: "ignoreErrors" });
		await browser?.close();
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});

// Real HTTPS and host resolution keep redirects, Secure __Host- cookies, Origin and CORS browser-native.
test("browser: adult registration, approval after headless step-up, navbar and local logout", async () => {
	const { execFileSync } = await import("node:child_process");
	const { mkdtemp, readFile, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { createServer } = await import("node:https");
	const { createHandler } = await import("../src/server.mjs");
	const temporary = await mkdtemp(join(tmpdir(), "breinhap-auth-browser-"));
	let browser;
	let server;
	try {
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=management.breinhap.com", "-keyout", join(temporary, "key.pem"), "-out", join(temporary, "cert.pem")], { stdio: "ignore" });
		let time = Date.now();
		const store = await makeStore(() => time);
		await member(store, "admin", "breinhap.admin");
		const identity = createIdentity({
			store, now: () => time,
			headless: {
				startEmail: async ({ email }) => ({ ok: true, challenge: email }),
				verifyEmail: async ({ email, code }) => code === "123456" ? { ok: true, sub: email === "admin@example.test" ? "admin" : "adult", email } : { ok: false, error: "wrong_code" },
				principal: async () => ({ active: true }),
			},
			grants: async (subject) => ({ appId: "breinhap", subject, state: subject === "admin" ? "active" : "inactive", roles: subject === "admin" ? ["breinhap.admin"] : [], permissions: subject === "admin" ? ["breinhap.management.access", "breinhap.memberships.manage"] : [] }),
		});
		const handler = createHandler({ identity });
		const navbarScript = await readFile(new URL("../../web/src/account.js", import.meta.url));
		server = createServer({ key: await readFile(join(temporary, "key.pem")), cert: await readFile(join(temporary, "cert.pem")) }, (req, res) => {
			if (req.headers.host === "breinhap.com") {
				res.writeHead(200, { "Content-Type": req.url === "/account.js" ? "text/javascript" : "text/html", "Cache-Control": "no-store" });
				res.end(req.url === "/account.js" ? navbarScript : '<!doctype html><html lang="nl"><title>Navbar test</title><a data-account="login" data-signed-in-label="Aangemeld" href="https://management.breinhap.com/login">Aanmelden</a><a data-account="register" href="https://management.breinhap.com/register">Registreren</a><script src="/account.js" defer></script></html>');
				return;
			}
			handler(req, res).catch(() => { res.writeHead(500); res.end(); });
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const endpoint = `127.0.0.1:${server.address().port}`;
		browser = await chromium.launch({ headless: true, args: ["--no-proxy-server", `--host-resolver-rules=MAP management.breinhap.com:443 ${endpoint}, MAP breinhap.com:443 ${endpoint}`] });
		const adultContext = await browser.newContext({ ignoreHTTPSErrors: true });
		const adminContext = await browser.newContext({ ignoreHTTPSErrors: true });
		const adult = await adultContext.newPage();
		const admin = await adminContext.newPage();
		const code = async (page) => {
			await page.waitForURL(`${ORIGIN}/login/code`);
			await page.getByLabel("Code", { exact: true }).fill("123456");
			await page.getByRole("button", { name: "Bevestigen", exact: true }).click();
		};
		const login = async (page, email, path = "/login") => {
			await page.goto(`${ORIGIN}${path}`);
			await page.getByLabel("E-mailadres", { exact: true }).fill(email);
			await page.getByRole("button", { name: /Stuur me een code/ }).click();
			await code(page);
		};
		await login(adult, "adult@example.test", "/register");
		await adult.waitForURL(`${ORIGIN}/registreren`);
		await adult.locator('[name="firstName"]').fill("Test");
		await adult.locator('[name="lastName"]').fill("Ouder");
		await adult.locator('[name="role"][value="breinhap.parent"]').check();
		await adult.locator('[name="consent"]').check();
		await adult.locator('form[action="/registreren"] button[type="submit"]').click();
		await adult.getByRole("heading", { name: "Aanvraag verstuurd" }).waitFor();
		await adult.goto("https://breinhap.com/");
		await adult.getByRole("link", { name: "Aangemeld", exact: true }).waitFor();
		assert.equal(await adult.locator('[data-account="register"]').isVisible(), false);

		await login(admin, "admin@example.test");
		await admin.waitForURL(`${ORIGIN}/`);
		time += 301_000;
		assert.equal((await admin.goto(`${ORIGIN}/beheer`)).status(), 200);
		await admin.getByText("Bevestig opnieuw je identiteit om wijzigingen te maken.", { exact: false }).waitFor();
		const denied = admin.waitForResponse((r) => r.url().endsWith("/beheer/goedkeuren") && r.request().method() === "POST");
		await admin.getByRole("button", { name: "Goedkeuren", exact: true }).click();
		assert.equal((await denied).status(), 428);
		await admin.getByRole("link", { name: "Opnieuw aanmelden", exact: true }).click();
		assert.equal(await admin.getByLabel("E-mailadres", { exact: true }).inputValue(), "admin@example.test");
		await admin.getByRole("button", { name: /Stuur me een code/ }).click();
		await code(admin);
		await admin.waitForURL(`${ORIGIN}/beheer`);
		if (process.env.AUTH_SCREENSHOT_PATH) await admin.screenshot({ path: process.env.AUTH_SCREENSHOT_PATH, fullPage: true });
		await admin.getByRole("button", { name: "Goedkeuren", exact: true }).click();
		await admin.getByText("Er zijn geen open aanvragen.", { exact: true }).waitFor();
		assert.equal((await store.membership("adult")).active, true);
		assert.equal((await adult.goto(`${ORIGIN}/bibliotheek`)).status(), 200);
		await adult.getByRole("button", { name: "Afmelden", exact: true }).click();
		await adult.waitForURL(`${ORIGIN}/login?logged-out=1`);
		assert.ok(!(await adultContext.cookies(ORIGIN)).some((c) => c.name === "__Host-breinhap-session"));
		await adult.goto("https://breinhap.com/");
		await adult.waitForLoadState("networkidle");
		assert.equal(await adult.locator('[data-account="login"]').textContent(), "Aanmelden");
		assert.equal(await adult.locator('[data-account="register"]').isVisible(), true);
	} finally {
		await browser?.close();
		server?.closeAllConnections();
		if (server?.listening) await new Promise((resolve) => server.close(resolve));
		await rm(temporary, { recursive: true, force: true });
	}
});
