// breinhap#signup: Breinhap's own sign-in and registration pages. ASafariM sends the e-mail code
// (app-sdk/headless, faked here); Breinhap shows every screen in nl, fr, en or de, completes a
// registration with the profile form, and the administrator approves it by name.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createIdentity, ORIGIN } from "../src/identity.mjs";
import { createHandler } from "../src/server.mjs";
import { makeStore, member } from "./helpers.mjs";

/** ASafariM's headless API as Breinhap sees it: codes per address, accounts per address. */
function fakeHeadless() {
	const accounts = new Map([["admin@example.test", "admin"]]);
	const codes = new Map();
	const revoked = new Set();
	const sent = [];
	return {
		sent,
		revoke: (sub) => revoked.add(sub),
		down: false,
		async startEmail({ email, locale, intent }) {
			if (this.down) return { ok: false, error: "unavailable" };
			const challenge = `challenge-${sent.length}-${"x".repeat(12)}`;
			codes.set(challenge, { email, code: String(100000 + sent.length) });
			sent.push({ email, locale, intent, challenge });
			return { ok: true, challenge, expiresIn: 300 };
		},
		async verifyEmail({ challenge, email, code }) {
			const c = codes.get(challenge);
			if (!c || c.email !== email) return { ok: false, error: "expired" };
			if (c.code !== code) return { ok: false, error: "wrong_code" };
			codes.delete(challenge);
			if (!accounts.has(email)) accounts.set(email, `sub-${accounts.size}`);
			const sub = accounts.get(email);
			if (revoked.has(sub)) return { ok: false, error: "revoked" };
			return { ok: true, sub, email, connected: false };
		},
		async principal(sub) {
			return { active: !revoked.has(sub) };
		},
		codeFor: (email) => [...codes.values()].reverse().find((c) => c.email === email)?.code,
	};
}

const grants = async (subject) => ({
	appId: "breinhap",
	subject,
	state: subject === "admin" ? "active" : "inactive",
	roles: subject === "admin" ? ["breinhap.admin"] : [],
	permissions: subject === "admin" ? ["breinhap.management.access", "breinhap.memberships.manage"] : [],
});

async function setup() {
	const store = await makeStore();
	await member(store, "admin", "breinhap.admin");
	const headless = fakeHeadless();
	const identity = createIdentity({ store, grants, headless, version: "9.9.9", provider: {} });
	const handler = createHandler({ identity });
	const jar = new Map();
	const call = (path, { method = "GET", body = "", origin = ORIGIN, lang } = {}) =>
		new Promise((resolve, reject) => {
			const req = Object.assign(Readable.from([body]), {
				method,
				url: path,
				headers: {
					host: "management.breinhap.com",
					cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
					origin,
					...(lang ? { "accept-language": lang } : {}),
				},
			});
			const res = {
				writeHead(status, headers) {
					this.status = status;
					this.headers = headers;
				},
				end(text) {
					for (const c of [this.headers?.["Set-Cookie"] ?? []].flat()) {
						const [pair] = c.split(";");
						const [k, v] = pair.split("=");
						if (/Max-Age=0/.test(c)) jar.delete(k);
						else jar.set(k, v);
					}
					resolve({ status: this.status, headers: this.headers, body: text ? String(text) : "" });
				},
			};
			handler(req, res).catch(reject);
		});
	const csrf = (body) => /name="csrf" value="([^"]+)"/.exec(body)?.[1];
	return { store, headless, call, jar, csrf };
}

test("registering: e-mail, code, profile, then the administrator approves by name", async () => {
	const { store, headless, call, csrf } = await setup();
	const page = await call("/register");
	assert.equal(page.status, 200);
	assert.match(page.body, /<h1 id="auth-title">Account aanmaken<\/h1>/);
	assert.match(page.body, /name="email" type="email" autocomplete="email"/);
	assert.doesNotMatch(page.body, /id\.asafarim\.site/, "no redirect to another site");

	const started = await call("/register", { method: "POST", body: "email=Kim%40Example.test" });
	assert.equal(started.status, 303);
	assert.equal(started.headers.Location, "/login/code");
	assert.deepEqual(headless.sent.at(-1), { email: "kim@example.test", locale: "nl", intent: "register", challenge: headless.sent.at(-1).challenge });
	const codeForm = await call("/login/code");
	assert.match(codeForm.body, /k•••@example\.test/);
	assert.match(codeForm.body, /autocomplete="one-time-code"/);
	const token = csrf(codeForm.body);

	const wrong = await call("/login/code", { method: "POST", body: `csrf=${token}&code=000000` });
	assert.equal(wrong.status, 400);
	assert.match(wrong.body, /Die code klopt niet/);
	const ok = await call("/login/code", { method: "POST", body: `csrf=${token}&code=${headless.codeFor("kim@example.test")}` });
	assert.equal(ok.status, 303);
	assert.equal(ok.headers.Location, "/");

	// signed in, no membership yet: the profile form completes the registration
	assert.equal((await call("/")).headers.Location, "/registreren");
	const form = await call("/registreren");
	assert.match(form.body, /<h1 id="auth-title">Je gegevens<\/h1>/);
	const body = new URLSearchParams({ csrf: csrf(form.body), firstName: "Kim", lastName: "Peeters", role: "breinhap.teacher", organisation: "Sint-Jozefcollege", note: "Klas 3B", consent: "1" });
	assert.equal((await call("/registreren", { method: "POST", body: body.toString() })).status, 303);
	const waiting = await call("/registreren");
	assert.match(waiting.body, /Aanvraag verstuurd/);
	assert.match(waiting.body, /kim@example\.test/);
	assert.equal((await store.roleRequests())[0].profile.email, "kim@example.test", "the e-mail comes from the verified account, not the form");
});

test("signing in again later: the same account, and an approved member goes straight in", async () => {
	const { store, headless, call, csrf, jar } = await setup();
	const signIn = async (email) => {
		jar.clear();
		await call("/login", { method: "POST", body: `email=${encodeURIComponent(email)}` });
		const form = await call("/login/code");
		return call("/login/code", { method: "POST", body: `csrf=${csrf(form.body)}&code=${headless.codeFor(email)}` });
	};
	await signIn("lee@example.test");
	assert.equal(headless.sent.at(-1).intent, "signin");
	const form = await call("/registreren");
	await call("/registreren", { method: "POST", body: new URLSearchParams({ csrf: csrf(form.body), firstName: "Lee", lastName: "Janssens", role: "breinhap.parent", consent: "1" }).toString() });
	const [request] = await store.roleRequests();
	assert.equal(request.profile.organisation, undefined, "a parent needs no school");

	// the administrator signs in with a code too, and approves
	await signIn("admin@example.test");
	const manage = await call("/beheer");
	assert.equal(manage.status, 200);
	assert.match(manage.body, /<strong>Lee Janssens<\/strong><br><a href="mailto:lee@example\.test">lee@example\.test<\/a>/);
	assert.doesNotMatch(manage.body, /ASafariM-accountcode|Accountcode om toegang/);
	await call("/beheer/goedkeuren", { method: "POST", body: `request=${request.id}&csrf=${csrf(manage.body)}` });

	await signIn("lee@example.test");
	assert.equal((await call("/bibliotheek")).status, 200);
	// revoked at ASafariM: signing in again is refused (an open session ends within a minute, the status cache)
	headless.revoke((await store.members()).find((m) => m.profile.email === "lee@example.test").subject);
	assert.equal((await signIn("lee@example.test")).status, 403);
});

test("every page in the person's language: nl by default, fr/en/de by choice or browser", async () => {
	const { call } = await setup();
	assert.match((await call("/login")).body, /<html lang="nl">.*Aanmelden/s);
	assert.match((await call("/login?lang=fr")).body, /<html lang="fr">.*Se connecter/s);
	assert.match((await call("/login")).body, /<html lang="fr">/, "the choice is remembered");
	const { call: other } = await setup();
	assert.match((await other("/register", { lang: "de-BE,de;q=0.9" })).body, /<html lang="de">.*Konto erstellen/s);
	assert.match((await other("/register?lang=en")).body, /Create an account/);
	for (const lang of ["nl", "fr", "en", "de"]) {
		const page = await other(`/register?lang=${lang}`);
		for (const l of ["nl", "fr", "en", "de"]) assert.match(page.body, l === lang ? new RegExp(`<span aria-current="true" lang="${l}">`) : new RegExp(`href="/register\\?lang=${l}"`));
	}
});

test("the flow is guarded: origin, CSRF, expiry, bad input and an unavailable ASafariM", async () => {
	const { headless, call, csrf, jar } = await setup();
	assert.equal((await call("/login", { method: "POST", body: "email=a%40example.test", origin: "https://evil.example" })).status, 403);
	const bad = await call("/login", { method: "POST", body: "email=geen-adres" });
	assert.equal(bad.status, 400);
	assert.match(bad.body, /Vul een geldig e-mailadres in/);
	assert.match(bad.body, /value="geen-adres"/);
	assert.equal((await call("/login/code")).headers.Location, "/login?verlopen=1");
	headless.down = true;
	const down = await call("/login", { method: "POST", body: "email=a%40example.test" });
	assert.equal(down.status, 503);
	assert.match(down.body, /tijdelijk niet beschikbaar/);
	headless.down = false;
	await call("/login", { method: "POST", body: "email=a%40example.test" });
	const form = await call("/login/code");
	assert.equal((await call("/login/code", { method: "POST", body: `csrf=forged&code=123456` })).status, 403);
	assert.equal((await call("/login/code", { method: "POST", body: `csrf=${csrf(form.body)}&code=12` })).status, 400);
	// a new code replaces the old one
	await call("/login/opnieuw", { method: "POST", body: `csrf=${csrf(form.body)}` });
	assert.equal(headless.sent.length, 2);
	const ok = await call("/login/code", { method: "POST", body: `csrf=${csrf(form.body)}&code=${headless.codeFor("a@example.test")}` });
	assert.equal(ok.status, 303);
	// signing out ends the Breinhap session locally (no ASafariM page)
	const signedIn = await call("/registreren");
	const out = await call("/afmelden", { method: "POST", body: `csrf=${csrf(signedIn.body)}` });
	assert.equal(out.headers.Location, "/login?logged-out=1");
	assert.equal(jar.has("__Host-breinhap-session"), false);
});
