import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createIdentity, ORIGIN } from "../src/identity.mjs";
import { makeStore, member } from "./helpers.mjs";

const request = (cookie, method = "GET", body = "") =>
	Object.assign(Readable.from([body]), {
		method,
		headers: { cookie, origin: ORIGIN },
	});
async function pilot() {
	let time = Date.now();
	let next = "admin";
	let authAge = 0;
	let refreshCount = 0;
	let refreshHook = async () => {};
	let coreDown = false;
	const store = await makeStore(() => time);
	const rows = new Map([
		["admin", "breinhap.admin"],
		["recipient", "breinhap.parent"],
		["other", "breinhap.parent"],
	]);
	const grants = async (sub) => {
		if (coreDown) throw new Error("core unavailable");
		return {
			appId: "breinhap",
			subject: sub,
			state: "active",
			roles: [rows.get(sub) ?? "breinhap.student"],
			permissions: rows.has(sub)
				? [
						"breinhap.management.access",
						...(sub === "admin" ? ["breinhap.memberships.manage"] : []),
					]
				: ["breinhap.student.access"],
		};
	};
	const provider = {
		authorizationUrl: async (flow) =>
			`https://id.asafarim.site/auth?state=${flow.state}`,
		exchange: async () => ({
			sub: next,
			sid: `sid-${next}`,
			issuedAt: Math.floor(time / 1000),
			authTime: Math.floor(time / 1000) - authAge,
			accessToken: "access",
			refreshToken: "refresh-one",
			expiresIn: 3600,
		}),
		userInfo: async (_token, sub) => ({ sub }),
		refresh: async () => {
			refreshCount++;
			await refreshHook();
			return {
				accessToken: "renewed",
				refreshToken: "refresh-two",
				expiresIn: 3600,
			};
		},
		logoutUrl: () => {
			throw new Error("provider unavailable");
		},
	};
	await member(store, "admin", "breinhap.admin");
	const identity = createIdentity({ provider, store, grants, now: () => time });
	async function login(sub, age = 0) {
		next = sub;
		authAge = age;
		const started = await identity.handle(
			request(""),
			new URL(`${ORIGIN}/auth/start`),
		);
		const flow = started.headers["Set-Cookie"][0].split(";")[0];
		const state = new URL(started.headers.Location).searchParams.get("state");
		const done = await identity.handle(
			request(flow),
			new URL(`${ORIGIN}/auth/callback?state=${state}&code=valid`),
		);
		assert.equal(done.status, 303);
		return done.headers["Set-Cookie"][0].split(";")[0];
	}
	return {
		store,
		identity,
		login,
		rows,
		grants,
		provider,
		time: () => time,
		advance: (ms) => {
			time += ms;
		},
		setRefresh: (fn) => {
			refreshHook = fn;
		},
		refreshCount: () => refreshCount,
		coreDown: () => {
			coreDown = true;
		},
	};
}

test("current core grants AND workspace membership are required; bootstrap is explicit", async () => {
	const p = await pilot();
	const cookie = await p.login("recipient");
	assert.equal(await p.identity.access(request(cookie)), "denied");
	await member(p.store, "recipient", "breinhap.parent");
	assert.equal(await p.identity.access(request(cookie)), "management");
	p.rows.delete("recipient");
	assert.equal(await p.identity.access(request(cookie)), "denied");
	p.rows.set("recipient", "breinhap.parent");
	await p.store.revokeMember("recipient");
	assert.equal(await p.identity.access(request(cookie)), "denied");
	assert.equal(await p.store.membership("recipient"), null);
});

test("privileged actions require a current administrator membership and fresh verified auth_time", async () => {
	const p = await pilot();
	const stale = await p.login("admin", 301);
	assert.equal(
		(await p.identity.privileged(request(stale))).response.status,
		428,
	);
	const current = await p.login("admin");
	assert.equal(
		(await p.identity.privileged(request(current))).value.admin,
		true,
	);
	p.rows.delete("admin");
	assert.equal(
		(await p.identity.privileged(request(current))).response.status,
		403,
	);
});

test("known-subject invitation rejects another identity and accepts once only with fresh auth and CSRF", async () => {
	const p = await pilot();
	const inviter = await p.store.membership("admin");
	const token = randomBytes(32).toString("base64url");
	await p.store.invite(token, {
		subject: "recipient",
		role: "breinhap.parent",
		inviter: "admin",
		inviterVersion: inviter.version,
	});
	const wrong = `${await p.login("other")}; __Host-breinhap-invitation=${token}`;
	assert.equal((await p.identity.acceptInvitation(request(wrong))).status, 403);
	const stale = `${await p.login("recipient", 301)}; __Host-breinhap-invitation=${token}`;
	assert.equal((await p.identity.acceptInvitation(request(stale))).status, 428);
	const correct = `${await p.login("recipient")}; __Host-breinhap-invitation=${token}`;
	const req = request(correct);
	assert.equal((await p.identity.acceptInvitation(req)).status, 200);
	assert.equal(
		(await p.identity.acceptInvitation(request(correct, "POST", "csrf=forged")))
			.status,
		403,
	);
	const body = `csrf=${req.managementSession.csrf}`;
	assert.equal(
		(await p.identity.acceptInvitation(request(correct, "POST", body))).status,
		303,
	);
	assert.equal(await p.identity.access(request(correct)), "management");
	assert.equal(
		(await p.identity.acceptInvitation(request(correct, "POST", body))).status,
		403,
	);
});

test("revoked inviter authority and expired invitation grant nothing", async () => {
	const p = await pilot();
	const inviter = await p.store.membership("admin");
	const token = randomBytes(32).toString("base64url");
	await p.store.invite(token, {
		subject: "recipient",
		role: "breinhap.parent",
		inviter: "admin",
		inviterVersion: inviter.version,
	});
	const cookie = `${await p.login("recipient")}; __Host-breinhap-invitation=${token}`;
	p.rows.delete("admin");
	assert.equal(
		(await p.identity.acceptInvitation(request(cookie))).status,
		403,
	);
	p.rows.set("admin", "breinhap.admin");
	await p.store.client.del(p.store.keyFor("invite", token));
	assert.equal(
		(await p.identity.acceptInvitation(request(cookie))).status,
		403,
	);
	assert.equal(await p.store.membership("recipient"), null);
});

test("concurrent requests rotate a refresh token only once across application instances", async () => {
	const p = await pilot();
	const cookie = await p.login("admin");
	p.advance(3600_000 - 5000);
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	p.setRefresh(() => gate);
	p.store.refreshLeaseMs = 120;
	const first = p.identity.current(request(cookie));
	while (p.refreshCount() === 0)
		await new Promise((resolve) => setTimeout(resolve, 5));
	const replica = createIdentity({
		provider: p.provider,
		store: p.store,
		grants: p.grants,
		now: p.time,
	});
	const second = replica.current(request(cookie));
	await new Promise((resolve) => setTimeout(resolve, 250));
	assert.equal(await p.store.acquireRefresh(cookie.split("=")[1]), null);
	release();
	assert.ok((await first).allowed);
	assert.ok((await second).allowed);
	assert.equal(p.refreshCount(), 1);
});

test("an in-flight refresh cannot resurrect a back-channel logout", async () => {
	const p = await pilot();
	const cookie = await p.login("admin");
	p.advance(3600_000 - 5000);
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	p.setRefresh(() => gate);
	const pending = p.identity.current(request(cookie));
	while (p.refreshCount() === 0)
		await new Promise((resolve) => setTimeout(resolve, 5));
	await p.store.logout({
		jti: "revocation",
		sid: "sid-admin",
		iat: Math.floor(p.time() / 1000),
	});
	release();
	assert.equal(await pending, null);
	assert.equal(await p.identity.current(request(cookie)), null);
});

test("permission-service outage fails closed and local logout still destroys the session", async () => {
	const p = await pilot();
	const cookie = await p.login("admin");
	const req = request(cookie);
	await p.identity.current(req);
	p.coreDown();
	await assert.rejects(p.identity.access(request(cookie)), /core unavailable/);
	const result = await p.identity.handle(
		request(cookie, "POST", `csrf=${req.managementSession.csrf}`),
		new URL(`${ORIGIN}/afmelden`),
	);
	assert.equal(result.status, 303);
	assert.equal(result.headers.Location, "/login?logged-out=1");
	assert.equal(await p.identity.access(request(cookie)), "anonymous");
});

test("one requester exhausting sign-in attempts does not block another requester", async () => {
	const p = await pilot();
	const start = async (address) => {
		const req = request("");
		req.headers["x-breinhap-client-address"] = address;
		return p.identity.handle(req, new URL(`${ORIGIN}/auth/start`));
	};
	for (let n = 0; n < 30; n++)
		assert.equal((await start("192.0.2.1")).status, 303);
	assert.equal((await start("192.0.2.1")).status, 429);
	assert.equal((await start("192.0.2.2")).status, 303);
});
