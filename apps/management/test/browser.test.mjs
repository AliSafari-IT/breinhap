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
	const submitted = [];
	try {
		browser = await chromium.launch({ headless: true });
		const context = await browser.newContext();
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
		await browser?.close();
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	}
});
