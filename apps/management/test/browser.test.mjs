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
		const nav = page.getByRole("navigation", { name: "Beheernavigatie" });
		assert.equal(await page.locator("header").getByRole("navigation", { name: "Beheernavigatie" }).count(), 1);
		assert.equal(await nav.getByRole("link", { name: "Overzicht", exact: true }).getAttribute("aria-current"), "page");
		assert.equal(await nav.getByRole("link", { name: "Toegang beheren", exact: true }).count(), 1);
		assert.equal(await page.locator("footer").getByRole("link", { name: "Privacy", exact: true }).count(), 1);
		assert.equal(await page.locator("main form[action='/afmelden']").count(), 0);
		for (const dark of [false, true]) {
			await page.evaluate((dark) => {
				document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
			}, dark);
			for (const width of [1280, 390, 320]) {
				await page.setViewportSize({ width, height: 900 });
				await page.locator(".management-account summary").click();
				assert.equal(await page.getByRole("button", { name: "Afmelden", exact: true }).isVisible(), true);
				assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `no overflow at ${width}px`);
				await page.locator(".management-account summary").click();
				if (process.env.MANAGEMENT_SHELL_SCREENSHOT_DIR && (width === 1280 || width === 390))
					await page.screenshot({ path: `${process.env.MANAGEMENT_SHELL_SCREENSHOT_DIR}/management-${width}-${dark ? "dark" : "light"}.png`, fullPage: true });
			}
		}


		// breinhap#86: the real selector, preference cookie, translated DOM hooks and responsive shell.
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.locator("[data-locale-selector] button").first().click();
		await page.getByRole("option").first().click();
		await page.getByText("Français", { exact: true }).click();
		await page.waitForURL((url) => url.searchParams.get("lang") === "fr");
		assert.equal(await page.locator("html").getAttribute("lang"), "fr");
		await page.goto(ORIGIN);
		assert.equal(await page.locator("html").getAttribute("lang"), "fr", "the chosen locale survives navigation");
		const copy = {
			nl: ["Overzicht", "Toegang beheren", "Afmelden"],
			fr: ["Aperçu", "Gestion des accès", "Se déconnecter"],
			en: ["Overview", "Access management", "Sign out"],
			de: ["Übersicht", "Zugangsverwaltung", "Abmelden"],
		};
		for (const [lang, labels] of Object.entries(copy)) {
			await page.goto(`${ORIGIN}/?lang=${lang}`);
			assert.equal(await page.locator("html").getAttribute("lang"), lang);
			assert.equal(await page.locator(".management-nav").getByRole("link", { name: labels[0], exact: true }).getAttribute("aria-current"), "page");
			assert.equal(await page.locator(".management-nav").getByRole("link", { name: labels[1], exact: true }).count(), 1);
			for (const dark of [false, true]) {
				await page.evaluate((dark) => document.documentElement.setAttribute("data-theme", dark ? "dark" : "light"), dark);
				for (const width of [1280, 390, 320]) {
					await page.setViewportSize({ width, height: 900 });
					await page.locator(".management-account summary").click();
					assert.ok(await page.getByRole("button", { name: labels[2], exact: true }).isVisible());
					assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${lang}: no overflow at ${width}px`);
					await page.locator(".management-account summary").click();
					if (process.env.MANAGEMENT_LOCALE_SCREENSHOT_DIR && width !== 320)
						await page.screenshot({ path: `${process.env.MANAGEMENT_LOCALE_SCREENSHOT_DIR}/${lang}-${width}-${dark ? "dark" : "light"}.png`, fullPage: true });
				}
			}
		}
		await page.goto(`${ORIGIN}/?lang=fr`);
		const unavailable = (route) => route.fulfill({ status: 503, body: "" });
		await context.route(`${ORIGIN}/auth/session`, unavailable);
		await page.evaluate(() => dispatchEvent(new Event("focus")));
		await page.getByText("Votre accès ne peut pas être vérifié actuellement. Rechargez la page pour réessayer.", { exact: true }).waitFor();
		await context.unroute(`${ORIGIN}/auth/session`, unavailable);
		await page.goto(`${ORIGIN}/?lang=nl`);

		// Wait for the redirect request, not its page load: Playwright does not route a request that
		// follows a fulfilled redirect, so loading it would reach the live management.breinhap.com.
		const loggedOut = page.waitForRequest(`${ORIGIN}/login?logged-out=1`);
		await page.locator(".management-account summary").click();
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
test("browser: adult registration, approval, logout and central SSO web launch", async () => {
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
		let centralVisits = 0;
		const store = await makeStore(() => time);
		await member(store, "admin", "breinhap.admin");
		const identity = createIdentity({
			store, now: () => time,
			// Test provider: real cross-domain HTTPS redirects/cookies, simulated authorization and token exchange.
			provider: {
				authorizationUrl: async (flow) => `https://id.asafarim.site/authorize?state=${flow.state}`,
				exchange: async () => ({ sub: "sso-adult", sid: "sso-browser", email: "central@example.test", issuedAt: Math.floor(time / 1000), authTime: Math.floor(time / 1000), accessToken: "sso-test-token", expiresIn: 3600 }),
				userInfo: async () => ({ sub: "sso-adult" }),
			},
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
			if (req.headers.host === "id.asafarim.site") {
				centralVisits++;
				if (req.headers.cookie !== "__Host-central-test=existing-session") {
					res.writeHead(401); res.end("Central session missing"); return;
				}
				const state = new URL(req.url, "https://id.asafarim.site").searchParams.get("state");
				res.writeHead(303, { Location: `${ORIGIN}/auth/callback?state=${encodeURIComponent(state)}&code=sso-test-code` });
				res.end(); return;
			}
			if (req.headers.host === "breinhap.com") {
				res.writeHead(200, { "Content-Type": req.url === "/account.js" ? "text/javascript" : "text/html", "Cache-Control": "no-store" });
				res.end(req.url === "/account.js" ? navbarScript : '<!doctype html><html lang="nl"><title>Navbar test</title><script src="/account.js"></script><div class="nav-actions"><a data-account="login" href="https://management.breinhap.com/login">Aanmelden</a><a data-account="register" href="https://management.breinhap.com/register">Registreren</a><details data-account="menu" hidden><summary><span data-account="initials" aria-hidden="true"></span><span>Account</span></summary><a href="https://management.breinhap.com/" data-account="manage" hidden>Breinhap beheer</a><a href="https://management.breinhap.com/" data-account="profile" hidden>Mijn account</a></details></div></html>');
				return;
			}
			handler(req, res).catch(() => { res.writeHead(500); res.end(); });
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const endpoint = `127.0.0.1:${server.address().port}`;
		browser = await chromium.launch({ headless: true, args: ["--no-proxy-server", `--host-resolver-rules=MAP management.breinhap.com:443 ${endpoint}, MAP breinhap.com:443 ${endpoint}, MAP id.asafarim.site:443 ${endpoint}`] });
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
		await adult.getByRole("heading", { name: "Je aanvraag is in behandeling" }).waitFor();
		await adult.getByRole("link", { name: "Opnieuw controleren", exact: true }).click();
		await adult.getByRole("status").filter({ hasText: "Nog niet goedgekeurd" }).waitFor();
		await adult.getByRole("link", { name: "Gegevens aanpassen", exact: true }).click();
		assert.equal(await adult.getByLabel("Bevestigd e-mailadres", { exact: true }).inputValue(), "adult@example.test");
		assert.equal(await adult.locator('[name="lastName"]').inputValue(), "Ouder");
		await adult.locator('[name="lastName"]').fill("Bijgewerkt");
		await adult.locator('form[action="/registreren"] button[type="submit"]').click();
		await adult.getByText("Test Bijgewerkt", { exact: true }).waitFor();
		await adult.getByRole("button", { name: "Aanvraag intrekken", exact: true }).click();
		await adult.getByRole("status").filter({ hasText: "Je aanvraag is ingetrokken" }).waitFor();
		await adult.locator('[name="firstName"]').fill("Test");
		await adult.locator('[name="lastName"]').fill("Ouder");
		await adult.locator('[name="role"][value="breinhap.parent"]').check();
		await adult.locator('[name="consent"]').check();
		await adult.locator('form[action="/registreren"] button[type="submit"]').click();
		await adult.getByRole("heading", { name: "Je aanvraag is in behandeling" }).waitFor();
		await adult.goto("https://breinhap.com/");
		// breinhap#24 (S4): signed in but not (yet) approved: the account menu without the management entry
		await adult.locator('[data-account="menu"]').waitFor();
		assert.equal(await adult.locator('[data-account="initials"]').textContent(), "A");
		assert.equal(await adult.locator('[data-account="register"]').isVisible(), false);
		assert.equal(await adult.locator('[data-account="login"]').isVisible(), false);
		assert.equal(await adult.locator("html").getAttribute("data-account-state"), "signed-in");
		await adult.getByText("Account", { exact: true }).click();
		await adult.getByRole("link", { name: "Mijn account", exact: true }).waitFor();
		assert.equal(await adult.getByRole("link", { name: "Breinhap beheer", exact: true }).count(), 0);

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
		assert.equal(await adult.getByRole("navigation", { name: "Beheernavigatie" }).getByRole("link", { name: "Toegang beheren", exact: true }).count(), 0);
		// approved: the same navbar now offers management, decided by management's grant check
		const site = await adultContext.newPage();
		await site.clock.install();
		await site.goto("https://breinhap.com/");
		await site.locator('[data-account="menu"]').waitFor();
		await site.getByText("Account", { exact: true }).click();
		await site.getByRole("link", { name: "Breinhap beheer", exact: true }).waitFor();
		assert.equal(await site.getByRole("link", { name: "Mijn account", exact: true }).count(), 0);
		assert.equal(await site.locator("html").getAttribute("data-account-state"), "management");
		await adult.locator(".management-account summary").click();
		await adult.getByRole("button", { name: "Afmelden", exact: true }).click();
		await adult.waitForURL(`${ORIGIN}/login?logged-out=1`);
		// the page that stayed open learns of the logout within 60 seconds
		await site.clock.runFor(60_000);
		await site.locator('[data-account="login"]').waitFor();
		assert.equal(await site.locator('[data-account="menu"]').isVisible(), false);
		assert.equal(await site.locator("html").getAttribute("data-account-state"), "signed-out");
		await site.close();
		assert.ok(!(await adultContext.cookies(ORIGIN)).some((c) => c.name === "__Host-breinhap-session"));
		await adult.goto("https://breinhap.com/");
		await adult.waitForLoadState("networkidle");
		assert.equal(await adult.locator('[data-account="login"]').textContent(), "Aanmelden");
		assert.equal(await adult.locator('[data-account="register"]').isVisible(), true);

		// This browser has only the central session, with no Breinhap cookie or membership.
		const centralContext = await browser.newContext({ ignoreHTTPSErrors: true });
		await centralContext.addCookies([{ name: "__Host-central-test", value: "existing-session", url: "https://id.asafarim.site", secure: true, httpOnly: true, sameSite: "Lax" }]);
		const central = await centralContext.newPage();
		await central.goto(`${ORIGIN}/auth/start?web=1&lang=en`);
		await central.waitForURL("https://breinhap.com/en/");
		await central.locator('[data-account="menu"]').waitFor();
		assert.equal(await central.locator('[data-account="register"]').isVisible(), false);
		assert.equal(centralVisits, 1, "the existing central session is reused without another email code");
		assert.ok((await centralContext.cookies(ORIGIN)).some((c) => c.name === "__Host-breinhap-session" && c.httpOnly && c.secure));
		assert.equal(await store.membership("sso-adult"), null);
		await central.goto(`${ORIGIN}/bibliotheek`);
		await central.waitForURL(`${ORIGIN}/registreren`);
		await central.getByRole("heading", { name: "Finish your registration", exact: true }).waitFor();
		assert.equal(await central.locator("#p-email").inputValue(), "central@example.test");
		await centralContext.close();
	} finally {
		await browser?.close();
		server?.closeAllConnections();
		if (server?.listening) await new Promise((resolve) => server.close(resolve));
		await rm(temporary, { recursive: true, force: true });
	}
});
