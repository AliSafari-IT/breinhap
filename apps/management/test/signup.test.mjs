// breinhap#signup: Breinhap's own sign-in and registration pages. ASafariM sends the e-mail code
// (app-sdk/headless, faked here); Breinhap shows every screen in nl, fr, en or de, completes a
// registration with the profile form, and the administrator approves it by name.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createIdentity, ORIGIN, safeNext, TERMS_VERSION } from "../src/identity.mjs";
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

async function setup(now = Date.now, resolveGrants = grants) {
	const store = await makeStore(now);
	await member(store, "admin", "breinhap.admin");
	const headless = fakeHeadless();
	const identity = createIdentity({ store, grants: resolveGrants, headless, now, version: "9.9.9", provider: {} });
	const handler = createHandler({ identity });
	const jar = new Map();
	const call = (path, { method = "GET", body = "", origin = ORIGIN, lang, headers = {} } = {}) =>
		new Promise((resolve, reject) => {
			const req = Object.assign(Readable.from([body]), {
				method,
				url: path,
				headers: {
					host: "management.breinhap.com",
					cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
					origin,
					...(lang ? { "accept-language": lang } : {}),
					...headers,
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
	return { store, headless, identity, call, jar, csrf };
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
	assert.match(form.body, /<h1 id="auth-title">Maak je registratie af<\/h1>/);
	const body = new URLSearchParams({ csrf: csrf(form.body), firstName: "Kim", lastName: "Peeters", role: "breinhap.teacher", organisation: "Sint-Jozefcollege", note: "Klas 3B", consent: "1" });
	assert.equal((await call("/registreren", { method: "POST", body: body.toString() })).status, 303);
	const waiting = await call("/registreren");
	assert.match(waiting.body, /Je aanvraag is in behandeling/);
	assert.match(waiting.body, /kim@example\.test/);
	const consent = (await store.roleRequests())[0].consent;
	assert.equal(consent.version, TERMS_VERSION);
	assert.ok(Math.abs(consent.at - Date.now()) < 5000);
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

async function signIn(ctx, email, fields = {}) {
	const started = await ctx.call("/login", { method: "POST", body: new URLSearchParams({ email, ...fields }).toString() });
	assert.equal(started.status, 303);
	const page = await ctx.call("/login/code");
	return ctx.call("/login/code", { method: "POST", body: new URLSearchParams({ csrf: ctx.csrf(page.body), code: ctx.headless.codeFor(email) }).toString() });
}

test("headless step-up: stale admin reads lists, gets 428 on changes, confirms and approves with the same session", async () => {
	let time = Date.now();
	const ctx = await setup(() => time);
	const { store, call, csrf, jar, identity } = ctx;
	await signIn(ctx, "admin@example.test");
	const id = jar.get("__Host-breinhap-session");
	const before = await store.getSession(id, false);
	await store.requestRole("newcomer", "breinhap.parent");
	const [request] = await store.roleRequests();
	time += 301_000;
	const list = await call("/beheer");
	assert.equal(list.status, 200);
	assert.match(list.body, /Bevestig opnieuw je identiteit om wijzigingen te maken/);
	const body = new URLSearchParams({ csrf: csrf(list.body), request: request.id }).toString();
	const stale = await call("/beheer/goedkeuren", { method: "POST", body });
	assert.equal(stale.status, 428);
	assert.match(stale.body, /href="\/login\?opnieuw=1&next=%2Fbeheer"/);
	assert.equal((await call("/login")).status, 303);
	assert.equal((await call("/login?switch=1")).status, 200);
	for (const mode of ["opnieuw", "fresh"]) {
		const login = await call(`/login?${mode}=1&next=/beheer`);
		assert.equal(login.status, 200);
		assert.match(login.body, /value="admin@example.test"/);
		assert.match(login.body, /name="stepUp" value="1"/);
		assert.match(login.body, /name="next" value="\/beheer"/);
		assert.match(login.body, /opnieuw=1&amp;next=%2Fbeheer&amp;lang=fr/);
	}
	const done = await signIn(ctx, "admin@example.test", { stepUp: "1", next: "/beheer" });
	assert.equal(done.headers.Location, "/beheer");
	assert.equal(jar.get("__Host-breinhap-session"), id);
	const after = await store.getSession(id, false);
	assert.deepEqual(after, { ...before, authTime: Math.floor(time / 1000) });
	const req = { headers: { cookie: `__Host-breinhap-session=${id}` } };
	await identity.current(req);
	assert.equal(req.managementSession.fresh, true);
	assert.equal((await call("/beheer/goedkeuren", { method: "POST", body })).status, 303);
	assert.equal((await store.membership("newcomer")).active, true);

	const switched = await signIn(ctx, "other@example.test", { stepUp: "1", next: "/beheer" });
	assert.equal(switched.status, 303);
	assert.notEqual(jar.get("__Host-breinhap-session"), id);
	assert.equal(await store.getSession(id), null);
});

test("step-up destinations are local and allowlisted", () => {
	for (const path of ["/", "/beheer", "/beheer/leerlingen", "/bibliotheek/nieuw", "/bibliotheek?map=1", "/uitnodiging/bevestigen"])
		assert.equal(safeNext(path), path);
	for (const path of [undefined, 1, "https://evil.test", "//evil.test", "/\\evil.test", "/beheer/\\evil", "/beheer/../login", "/beheer\n", "/beheer\u007f", "/beheer\u0085", "/afmelden", "/beheer" + "x".repeat(201)])
		assert.equal(safeNext(path), "/");
});

test("resend permits three attempts per flow and stops before calling ASafariM again", async () => {
	const { call, headless, csrf } = await setup();
	await call("/login", { method: "POST", body: "email=a%40example.test" });
	const form = await call("/login/code");
	for (let i = 0; i < 3; i++) assert.equal((await call("/login/opnieuw", { method: "POST", body: `csrf=${csrf(form.body)}` })).headers.Location, "/login/code");
	assert.equal((await call("/login/opnieuw", { method: "POST", body: `csrf=${csrf(form.body)}` })).headers.Location, "/login/code?fout=rate_limited");
	assert.equal(headless.sent.length, 4);
});

test("verification stops after five guesses, invalidates the flow and clears its cookie", async () => {
	const { call, headless, csrf, jar } = await setup();
	let attempts = 0;
	headless.verifyEmail = async () => { attempts++; return { ok: false, error: "wrong_code" }; };
	await call("/login", { method: "POST", body: "email=a%40example.test" });
	const form = await call("/login/code");
	const post = () => call("/login/code", { method: "POST", body: `csrf=${csrf(form.body)}&code=000000` });
	for (let i = 0; i < 5; i++) assert.equal((await post()).status, 400);
	assert.equal((await post()).status, 429);
	assert.equal(attempts, 5);
	assert.equal(jar.has("__Host-breinhap-login"), false);
	assert.equal((await call("/login/code")).headers.Location, "/login?verlopen=1");
});

test("invalid headless subjects and e-mail addresses consume the flow without creating a session", async () => {
	for (const invalid of [{ sub: "" }, { sub: "x".repeat(401) }, { sub: ".." }, { sub: "bad/subject" }, { email: "bad" }, { email: "" }, { email: "x".repeat(255) }]) {
		const { call, headless, csrf, jar } = await setup();
		headless.verifyEmail = async () => ({ ok: true, sub: "person", email: "a@example.test", ...invalid });
		await call("/login", { method: "POST", body: "email=a%40example.test" });
		const form = await call("/login/code");
		assert.equal((await call("/login/code", { method: "POST", body: `csrf=${csrf(form.body)}&code=123456` })).status, 400);
		assert.equal(jar.has("__Host-breinhap-session"), false);
		assert.equal(jar.has("__Host-breinhap-login"), false);
	}
});

test("duplicate code fields are rejected without verification; oversized forms retain status 413", async () => {
	const { call, headless, csrf } = await setup();
	let verified = false;
	headless.verifyEmail = async () => { verified = true; };
	assert.equal((await call("/login", { method: "POST", body: "email=" + "a".repeat(5000) })).status, 413);
	await call("/login", { method: "POST", body: "email=a%40example.test" });
	const form = await call("/login/code");
	assert.equal((await call("/login/code", { method: "POST", body: `csrf=${csrf(form.body)}&code=123456&code=654321` })).status, 400);
	assert.equal(verified, false);
});

test("a failed flow insert never sets a login cookie", async () => {
	const { call, store, jar } = await setup();
	store.putFlow = async () => false;
	assert.equal((await call("/login", { method: "POST", body: "email=a%40example.test" })).status, 503);
	assert.equal(jar.has("__Host-breinhap-login"), false);
	assert.equal((await call("/auth/start")).status, 503);
});

test("session JSON distinguishes signed-in without access from anonymous; logout GET advertises POST", async () => {
	const ctx = await setup();
	let response = await ctx.call("/auth/session");
	assert.equal(response.status, 200);
	assert.deepEqual(JSON.parse(response.body), { active: false, access: false });
	await signIn(ctx, "a@example.test");
	response = await ctx.call("/auth/session");
	assert.equal(response.status, 200);
	assert.deepEqual(JSON.parse(response.body), { active: true, access: false });
	response = await ctx.call("/afmelden");
	assert.equal(response.status, 405);
	assert.equal(response.headers.Allow, "POST");
});

test("static assets revalidate from memory while auth HTML stays no-store", async () => {
	const { call } = await setup();
	for (const path of ["/styles.css", "/theme.css", "/theme.js", "/session.js", "/editor.js", "/locale-selector.js", "/locale-selector.css"]) {
		const response = await call(path);
		assert.equal(response.status, 200);
		assert.equal(response.headers["Cache-Control"], "public, max-age=0, must-revalidate");
		assert.ok(response.headers.ETag);
		assert.equal((await call(path, { headers: { "if-none-match": response.headers.ETag } })).status, 304);
	}
	assert.equal((await call("/login")).headers["Cache-Control"], "no-store");
});


test("backchannel abuse is rejected before JWT verification", async () => {
	// Keep all 121 requests in one bucket, even at a wall-clock minute boundary.
	const store = await makeStore(() => 1_800_000_000_000);
	let verified = 0;
	const identity = createIdentity({ store, grants, provider: { validateLogout: async () => { verified++; throw new Error("invalid"); } } });
	const call = (ip) => identity.handle(Object.assign(Readable.from(["logout_token=invalid"]), {
		method: "POST", headers: { "x-breinhap-client-address": ip },
	}), new URL(`${ORIGIN}/auth/backchannel-logout`));
	for (let i = 0; i < 120; i++) assert.equal((await call("192.0.2.1")).status, 400);
	assert.equal((await call("192.0.2.1")).status, 429);
	assert.equal(verified, 120);
	assert.equal((await call("192.0.2.2")).status, 400);
});

test("concurrent successful code submissions can establish only one session", async () => {
	const { call, headless, store, csrf } = await setup();
	let release;
	const ready = new Promise((resolve) => { release = resolve; });
	let arrived = 0;
	headless.verifyEmail = async () => {
		if (++arrived === 2) release();
		await ready;
		return { ok: true, sub: "person", email: "a@example.test" };
	};
	let saved = 0;
	const save = store.saveSession.bind(store);
	store.saveSession = (...args) => { saved++; return save(...args); };
	await call("/login", { method: "POST", body: "email=a%40example.test" });
	const form = await call("/login/code");
	const post = () => call("/login/code", { method: "POST", body: `csrf=${csrf(form.body)}&code=123456` });
	const responses = await Promise.all([post(), post()]);
	assert.deepEqual(responses.map((r) => r.status).sort(), [303, 400]);
	assert.equal(saved, 1);
});

test("stale headless invitation recipients reauthenticate and return to acceptance", async () => {
	let time = Date.now();
	const ctx = await setup(() => time, async (subject) => subject === "admin" ? grants(subject) : ({ appId: "breinhap", subject, state: "active", roles: ["breinhap.parent"], permissions: ["breinhap.management.access"] }));
	const { store, call, jar, csrf } = ctx;
	await signIn(ctx, "invitee@example.test");
	const token = "i".repeat(43);
	await store.invite(token, { subject: "sub-1", role: "breinhap.parent", inviter: "admin", inviterVersion: (await store.membership("admin")).version });
	await call("/auth/invite-link", { method: "POST", body: `token=${token}` });
	time += 301_000;
	const stale = await call("/uitnodiging/bevestigen");
	assert.equal(stale.status, 428);
	assert.match(stale.body, /next=%2Fuitnodiging%2Fbevestigen/);
	const id = jar.get("__Host-breinhap-session");
	const done = await signIn(ctx, "invitee@example.test", { stepUp: "1", next: "/uitnodiging/bevestigen" });
	assert.equal(done.headers.Location, "/uitnodiging/bevestigen");
	assert.equal(jar.get("__Host-breinhap-session"), id);
	const page = await call("/uitnodiging/bevestigen");
	assert.equal(page.status, 200);
	assert.equal((await call("/uitnodiging/bevestigen", { method: "POST", body: `csrf=${csrf(page.body)}` })).status, 303);
	assert.equal((await store.membership("sub-1")).role, "breinhap.parent");
});

test("pending identity, check feedback, edit, decision mail and approval destination", async () => {
	const ctx = await setup();
	const { call, csrf, store } = ctx;
	await signIn(ctx, "kim@example.test");
	const form = await call("/registreren");
	assert.match(form.body, /Aangemeld als <strong>kim@example.test<\/strong>/);
	assert.match(form.body, /id="p-email" type="email" value="kim@example.test" readonly/);
	assert.doesNotMatch(form.body, /name="email"/);
	const fields = { csrf: csrf(form.body), firstName: "Kim", lastName: "Peeters", role: "breinhap.parent", consent: "1" };
	await call("/registreren", { method: "POST", body: new URLSearchParams(fields).toString() });
	const [before] = await store.roleRequests();
	const pending = await call("/registreren");
	for (const pattern of [/Meestal binnen één werkdag/, /Aangevraagd op/, /href="\/registreren\?gecontroleerd=1"/, /href="\/registreren\?aanpassen=1"/, /action="\/registreren\/intrekken"/]) assert.match(pending.body, pattern);
	assert.doesNotMatch(pending.body, /Laatst gecontroleerd/);
	assert.match((await call("/registreren?gecontroleerd=1")).body, /role="status">Nog niet goedgekeurd\. Laatst gecontroleerd om \d{2}:\d{2}\./);
	const edit = await call("/registreren?aanpassen=1");
	assert.match(edit.body, /name="editing" value="1"/);
	assert.match(edit.body, /value="Peeters"/);
	await call("/registreren", { method: "POST", body: new URLSearchParams({ ...fields, editing: "1", lastName: "Nieuw", email: "forged@example.test" }).toString() });
	const [after] = await store.roleRequests();
	assert.equal(after.at, before.at);
	assert.equal(after.profile.lastName, "Nieuw");
	assert.equal(after.profile.email, "kim@example.test");
	assert.equal(after.id, before.id);
	for (const lang of ["nl", "fr", "en", "de"]) {
		const localized = await call(`/registreren?gecontroleerd=1&lang=${lang}`);
		assert.equal(localized.status, 200);
		assert.doesNotMatch(localized.body, /undefined|<style|style=|<script(?! src)/);
	}
	await signIn(ctx, "admin@example.test");
	const admin = await call("/beheer");
	await call("/beheer/goedkeuren", { method: "POST", body: `csrf=${csrf(admin.body)}&request=${after.id}` });
	const feedback = await call("/beheer?lang=nl");
	assert.match(feedback.body, /Breng de aanvrager per e-mail op de hoogte/);
	assert.match(feedback.body, /mailto:kim%40example.test\?subject=Je%20Breinhap-aanvraag%20is%20goedgekeurd&amp;body=/);
	await signIn(ctx, "kim@example.test");
	assert.equal((await call("/registreren?gecontroleerd=1")).headers.Location, "/");
});

test("rejection is visible, admin can notify, and the requester can apply again", async () => {
	const ctx = await setup();
	const { call, csrf, store } = ctx;
	await signIn(ctx, "kim@example.test");
	const form = await call("/registreren");
	const fields = { csrf: csrf(form.body), firstName: "Kim", lastName: "Peeters", role: "breinhap.parent", consent: "1" };
	await call("/registreren", { method: "POST", body: new URLSearchParams(fields).toString() });
	const [request] = await store.roleRequests();
	await signIn(ctx, "admin@example.test");
	const admin = await call("/beheer");
	await call("/beheer/weigeren", { method: "POST", body: `csrf=${csrf(admin.body)}&request=${request.id}` });
	assert.match((await call("/beheer")).body, /mailto:kim%40example.test\?subject=Je%20Breinhap-aanvraag%20is%20niet%20goedgekeurd/);
	await signIn(ctx, "kim@example.test");
	const rejected = await call("/registreren");
	assert.match(rejected.body, /Je aanvraag is niet goedgekeurd/);
	assert.match(rejected.body, /href="\/registreren\?opnieuw=1"/);
	assert.doesNotMatch(rejected.body, /name="firstName"/);
	const retry = await call("/registreren?opnieuw=1");
	assert.match(retry.body, /Maak je registratie af/);
	await call("/registreren", { method: "POST", body: new URLSearchParams({ ...fields, csrf: csrf(retry.body) }).toString() });
	assert.match((await call("/registreren")).body, /Je aanvraag is in behandeling/);
	assert.equal(await store.rejectedRequest(request.subject), null);
});

test("withdrawal requires caller CSRF/origin and rejects another subject's target", async () => {
	const ctx = await setup();
	const { call, csrf, store } = ctx;
	await signIn(ctx, "kim@example.test");
	const form = await call("/registreren");
	const token = csrf(form.body);
	await call("/registreren", { method: "POST", body: new URLSearchParams({ csrf: token, firstName: "Kim", lastName: "Peeters", role: "breinhap.parent", consent: "1" }).toString() });
	await store.requestRole("victim", "breinhap.parent");
	const post = (body, origin = ORIGIN) => call("/registreren/intrekken", { method: "POST", body, origin });
	assert.equal((await call("/registreren/intrekken")).status, 405);
	assert.equal((await post("csrf=forged")).status, 403);
	assert.equal((await post(`csrf=${token}`, "https://evil.test")).status, 403);
	for (const target of ["subject=victim", "request=" + (await store.roleRequests()).find((r) => r.subject === "victim").id])
		assert.equal((await post(`csrf=${token}&${target}`)).status, 403);
	assert.equal((await store.roleRequests()).length, 2);
	const withdrawn = await post(`csrf=${token}`);
	assert.equal(withdrawn.headers.Location, "/registreren?ingetrokken=1");
	const remaining = await store.roleRequests();
	assert.equal(remaining.length, 1);
	assert.equal(remaining[0].subject, "victim");
	assert.match((await call(withdrawn.headers.Location)).body, /role="status">Je aanvraag is ingetrokken/);
});
