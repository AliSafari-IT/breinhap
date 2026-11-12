// breinhap#85: the walking skeleton end to end. Part one is the whole life of a link over HTTP:
// author → preview (no writes) → independent review and publication → freeze and mint → a clean
// learner → the owner's server-verified result → revoke → delete → the old link and cookie fail.
// Part two drives a real Chromium over HTTPS on the exact public Host: the fragment bootstrap, the
// no-JS code field, keyboard operation, 320/390/1280 widths and no request outside the origin.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium } from "playwright";

import { browser, count, finish, getPool, hiddenOf, linked, packFields, post, draftVersion, mint, tokenOf, shareable } from "./pack-fixtures.mjs";

const pool = { query: (...args) => getPool().query(...args) };

test("the whole life of a practice link, from authoring to deletion", async () => {
	const w = await shareable();
	// preview writes nothing
	const tables = ["practice_pack_versions", "practice_share_links", "practice_link_sessions", "practice_attempts", "practice_answers"];
	const snapshot = async () => (await Promise.all(tables.map(async (t) => (await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n))).join();
	const before = await snapshot();
	assert.equal((await w.s.call(`/bibliotheek/packs/${w.id}/voorbeeld`, { who: w.teacher })).status, 200);
	assert.equal(await snapshot(), before);
	// freeze and mint
	assert.equal((await w.s.call(`/bibliotheek/packs/${w.id}/vastleggen`, post({ expectedVersion: String(await draftVersion(w.id)) }, w.teacher))).status, 303);
	const secret = tokenOf(await mint(w));
	assert.ok(secret);
	// a link-preview bot only reads the public page: nothing starts
	const bot = browser(w);
	assert.equal((await bot.get("/p/")).status, 200);
	assert.equal(await count("practice_attempts", w.id), 0);
	// the learner, in a clean browser
	const learner = browser(w);
	await learner.begin(secret);
	// two tabs on the same page: the second, stale submit is refused and changes nothing
	const tabA = await learner.get("/p/run");
	const tabB = await learner.get("/p/run");
	const a = hiddenOf(tabA.body);
	const b = hiddenOf(tabB.body);
	assert.equal(a.expectedVersion, b.expectedVersion);
	assert.equal((await learner.post("/p/answer", a)).status, 303);
	// the very same request again (a lost response) is a safe replay
	assert.equal((await learner.post("/p/answer", a)).status, 303);
	const second = await learner.post("/p/answer", { ...b, nonce: Buffer.alloc(32, 7).toString("base64url") });
	assert.equal(second.status, 409);
	await finish(learner, true);
	const attempt = (await pool.query("SELECT state, server_score, question_count, version FROM practice_attempts WHERE pack_id=$1", [w.id])).rows[0];
	assert.deepEqual([attempt.state, attempt.server_score, attempt.question_count], ["submitted", 2, 2]);
	// the owner sees the server-verified result
	const results = await w.s.call(`/bibliotheek/packs/${w.id}/resultaten`, { who: w.teacher });
	assert.match(results.body, /2 van 2/);
	// the forwarded link cannot reach that result or start a second attempt
	const forwarded = browser(w);
	await forwarded.open(secret);
	assert.equal((await forwarded.post("/p/start", hiddenOf((await forwarded.get("/p/start")).body))).status, 410);
	assert.equal((await forwarded.get("/p/done")).status, 303);
	// revoke: the old link and the learner's cookie fail at once
	const link = (await pool.query("SELECT id FROM practice_share_links WHERE pack_id=$1", [w.id])).rows[0].id;
	assert.equal((await w.s.call(`/bibliotheek/packs/${w.id}/links/${link}/intrekken`, post({}, w.teacher))).status, 303);
	assert.equal((await browser(w).open(secret)).status, 410);
	assert.equal((await learner.get("/p/done")).status, 410);
	// the owner still sees history, then deletes it; deletion does not give the attempt back
	assert.match((await w.s.call(`/bibliotheek/packs/${w.id}/resultaten`, { who: w.teacher })).body, /1 poging gestart/);
	assert.equal((await w.s.call(`/bibliotheek/packs/${w.id}/resultaten/verwijderen`, post({ bevestig: "1" }, w.teacher))).status, 303);
	assert.equal(await count("practice_attempts", w.id), 0);
	assert.equal((await pool.query("SELECT attempts_started FROM practice_share_links WHERE pack_id=$1", [w.id])).rows[0].attempts_started, 1);
	// withdrawing the source ends any other link on it
	const x = await linked();
	const c = browser(x);
	await c.begin(x.secret);
	await x.publishing.withdraw(x.publisher, "lo-a");
	assert.equal((await c.get("/p/run")).status, 410);
});

test("the platform manifest exposes no learner or blanket public path", async () => {
	const manifest = JSON.parse(await readFile(new URL("../platform.app.json", import.meta.url), "utf8"));
	for (const path of manifest.auth.publicPaths) {
		assert.ok(!path.startsWith("/p"), path);
		assert.notEqual(path, "/");
		assert.ok(!path.includes("*"), path);
	}
	assert.equal(manifest.domains.primary, "management.breinhap.com");
	assert.ok(!JSON.stringify(manifest.domains).includes('"breinhap.com"'));
});

// ── part two: a real browser over HTTPS ─────────────────────────────────────────────────────────

/** An HTTPS front on the plain test server, answering as management and public Host alike. */
async function https(w, dir) {
	execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=breinhap.com", "-addext", "subjectAltName=DNS:breinhap.com,DNS:management.breinhap.com", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
	const requests = [];
	const server = createServer({ key: await readFile(join(dir, "key.pem")), cert: await readFile(join(dir, "cert.pem")) }, (req, res) => {
		requests.push({ host: req.headers.host, line: `${req.method} ${req.url}` });
		const upstream = http.request({ hostname: "127.0.0.1", port: w.s.port, path: req.url, method: req.method, headers: req.headers }, (back) => {
			res.writeHead(back.statusCode, back.headers);
			back.pipe(res);
		});
		upstream.on("error", () => { res.writeHead(502); res.end(); });
		req.pipe(upstream);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, requests, endpoint: `127.0.0.1:${server.address().port}` };
}
const launch = (endpoint) =>
	chromium.launch({
		headless: true,
		...(process.env.BREINHAP_TEST_CHROMIUM ? { executablePath: process.env.BREINHAP_TEST_CHROMIUM } : {}),
		args: ["--no-proxy-server", `--host-resolver-rules=MAP breinhap.com:443 ${endpoint}, MAP management.breinhap.com:443 ${endpoint}`],
	});
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test("browser: the fragment bootstrap, keyboard play, three widths and no outside request", async () => {
	const dir = await mkdtemp(join(tmpdir(), "breinhap-pack-browser-"));
	let chrome;
	let front;
	try {
		for (const [width, height] of [[320, 640], [390, 800], [1280, 800]]) {
			// one world, one HTTPS front and one browser per width: the front serves that world's links
			const fresh = await linked();
			front = await https(fresh, dir);
			chrome = await launch(front.endpoint);
			const context = await chrome.newContext({ ignoreHTTPSErrors: true, locale: "nl-BE", viewport: { width, height } });
			const page = await context.newPage();
			const seen = [];
			page.on("request", (request) => seen.push(request.url()));
			await page.goto(`https://breinhap.com/p/#${fresh.secret}`);
			await page.waitForURL("https://breinhap.com/p/start");
			// the code is gone from the address bar and the history, and was never in a request line
			assert.equal(new URL(page.url()).hash, "");
			assert.ok(seen.every((u) => !u.includes(fresh.secret)), "the code must not be in any URL");
			assert.ok(await noOverflow(page), `overflow at ${width}`);
			assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "Prikkels oefenen");
			assert.ok((await page.getByRole("main").count()) === 1);
			await page.getByRole("button", { name: "Starten" }).click();
			await page.waitForURL("https://breinhap.com/p/run");
			for (let i = 0; i < 12; i++) {
				if (await page.getByRole("button", { name: "Inleveren" }).count()) break;
				assert.ok(await noOverflow(page), `overflow at ${width}, page ${i}`);
				if (await page.getByRole("radio").count()) {
					// keyboard only: focus the first option, press Space, move to the button, press Enter
					await page.getByRole("radio").first().focus();
					await page.keyboard.press("Space");
					// Tab until the check button has focus; the options and button are all reachable by keyboard
					for (let tabs = 0; tabs < 8 && (await page.evaluate(() => document.activeElement?.textContent?.trim())) !== "Controleer"; tabs++) await page.keyboard.press("Tab");
					assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Controleer");
					await page.keyboard.press("Enter");
					await page.getByRole("status").waitFor();
					assert.match(await page.getByRole("status").innerText(), /Klopt\./);
				} else if (await page.locator("select").count()) {
					const order = ["prikkel", "receptor", "reactie"];
					for (let n = 0; n < order.length; n++) await page.locator(`select[name="plaats${n}"]`).selectOption(order[n]);
					await page.getByRole("button", { name: "Controleer" }).click();
					await page.getByRole("status").waitFor();
				}
				await page.getByRole("button", { name: "Verder" }).click();
			}
			await page.getByRole("button", { name: "Inleveren" }).click();
			await page.waitForURL("https://breinhap.com/p/done");
			assert.match(await page.locator(".score").innerText(), /Je had 2 van de 2 vragen juist\./);
			assert.ok(await noOverflow(page), `overflow on the result at ${width}`);
			await page.getByRole("button", { name: "Klaar" }).click();
			const names = (await context.cookies()).map((c) => c.name);
			assert.deepEqual(names.filter((n) => n.startsWith("__Secure-bh-")), []);
			assert.ok(!names.some((n) => n.includes("breinhap-session")), "no management cookie in a learner browser");
			// every request stayed on the public origin and on /p
			assert.ok(seen.every((u) => new URL(u).origin === "https://breinhap.com" && new URL(u).pathname.startsWith("/p")), seen.join("\n"));
			assert.ok(front.requests.every((r) => r.host === "breinhap.com"), "the browser only ever asked for the public Host");
			await context.close();
			await chrome.close();
			await new Promise((resolve) => front.server.close(resolve));
			chrome = undefined;
			front = undefined;
		}
	} finally {
		await chrome?.close();
		await new Promise((resolve) => (front ? front.server.close(resolve) : resolve()));
		await rm(dir, { recursive: true, force: true });
	}
});

test("browser: without JavaScript the code is typed by hand, and the learner chrome follows the pack language", async () => {
	const dir = await mkdtemp(join(tmpdir(), "breinhap-pack-nojs-"));
	let chrome;
	let front;
	try {
		const w = await linked({ taal: "fr" });
		front = await https(w, dir);
		chrome = await launch(front.endpoint);
		const context = await chrome.newContext({ ignoreHTTPSErrors: true, locale: "nl-BE", javaScriptEnabled: false });
		const page = await context.newPage();
		await page.goto("https://breinhap.com/p/");
		await page.getByLabel("Code uit de link").fill(w.secret);
		await page.getByRole("button", { name: "Openen" }).click();
		await page.waitForURL("https://breinhap.com/p/start");
		assert.equal(await page.locator("html").getAttribute("lang"), "fr-BE");
		await page.getByRole("button", { name: "Commencer" }).click();
		await page.waitForURL("https://breinhap.com/p/run");
		assert.match(await page.getByRole("main").innerText(), /Échauffement|Étape 1/);
		// a wrong code is the same quiet dead end for everyone
		const other = await context.newPage();
		await other.goto("https://breinhap.com/p/");
		await other.getByLabel("Code uit de link").fill("C".repeat(43));
		await other.getByRole("button", { name: "Openen" }).click();
		assert.match(await other.getByRole("heading", { level: 1 }).innerText(), /Ce lien ne fonctionne pas|Deze link werkt niet/);
		await context.close();
	} finally {
		await chrome?.close();
		await new Promise((resolve) => (front ? front.server.close(resolve) : resolve()));
		await rm(dir, { recursive: true, force: true });
	}
});
