import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createIdentity, discoverProvider, ORIGIN } from "../src/identity.mjs";
import {
	createPlatform,
	managementAccess,
	manifest,
	signRequest,
} from "../src/platform.mjs";
import { makeStore, member } from "./helpers.mjs";

const roles = (role) => ({
	appId: "breinhap",
	subject: "person",
	state: "active",
	roles: [role],
	permissions: [
		role === "breinhap.student"
			? "breinhap.student.access"
			: "breinhap.management.access",
	],
});
const request = (cookie = "", { method = "GET", body = "", origin } = {}) =>
	Object.assign(Readable.from([body]), {
		method,
		headers: { cookie, ...(origin ? { origin } : {}) },
	});
const cookieHeader = (response) =>
	(Array.isArray(response.headers["Set-Cookie"])
		? response.headers["Set-Cookie"]
		: [response.headers["Set-Cookie"]]
	)
		.map((value) => value.split(";")[0])
		.join("; ");

async function setup({ maxEntries, shared } = {}) {
	let time = 1000;
	let current = roles("breinhap.teacher");
	let unavailable = false;
	let exchanged = 0;
	let lastFlow;
	const store = shared ?? (await makeStore(() => time));
	if (!shared) await member(store, "person");
	const identity = createIdentity({
		store,
		now: () => time,
		maxEntries,
		grants: async () => current,
		provider: {
			authorizationUrl: async (flow) => {
				lastFlow = flow;
				return `https://id.asafarim.site/auth?state=${flow.state}`;
			},
			exchange: async (_url, flow) => {
				exchanged++;
				assert.deepEqual(flow.state, lastFlow.state);
				return {
					sub: "person",
					sid: "browser",
					authTime: Math.floor(time / 1000),
					issuedAt: Math.floor(time / 1000),
					accessToken: "private-token",
					expiresIn: 3600,
				};
			},
			userInfo: async () => {
				if (unavailable) throw new Error("revoked");
				return { sub: "person" };
			},
			logoutUrl: () => "https://id.asafarim.site/session/end",
		},
	});
	async function start() {
		const response = await identity.handle(
			request(),
			new URL(`${ORIGIN}/auth/start`),
		);
		const cookie = cookieHeader(response);
		const state = new URL(response.headers.Location).searchParams.get("state");
		return { response, cookie, state, flow: lastFlow };
	}
	async function login() {
		const flow = await start();
		const response = await identity.handle(
			request(flow.cookie),
			new URL(`${ORIGIN}/auth/callback?state=${flow.state}&code=valid`),
		);
		return {
			...flow,
			response,
			session: cookieHeader(response).split("; ")[0],
		};
	}
	return {
		identity,
		start,
		login,
		setGrants: (value) => {
			current = value;
		},
		expire: () => {
			time += 12 * 3600_000 + 1;
		},
		revokeIdentity: () => {
			unavailable = true;
		},
		exchanges: () => exchanged,
	};
}

test("every role is explicit; student-only, unknown and inactive grants deny management", () => {
	for (const role of ["admin", "parent", "tutor", "teacher"]) {
		assert.equal(
			managementAccess(roles(`breinhap.${role}`), "person").access,
			"management",
		);
	}
	for (const grants of [
		roles("breinhap.student"),
		roles("admin"),
		{ ...roles("breinhap.admin"), state: "inactive" },
		{ ...roles("breinhap.admin"), permissions: [] },
	]) {
		assert.equal(managementAccess(grants, "person").access, "denied");
	}
	assert.equal(
		managementAccess(
			{
				...roles("breinhap.teacher"),
				roles: ["breinhap.student", "breinhap.teacher"],
			},
			"person",
		).access,
		"management",
	);
	assert.throws(() =>
		managementAccess(
			{ ...roles("breinhap.admin"), subject: "other" },
			"person",
		),
	);
	assert.throws(() =>
		managementAccess({ ...roles("breinhap.admin"), appId: "other" }, "person"),
	);
	assert.throws(() =>
		managementAccess({ roles: ["breinhap.admin"] }, "person"),
	);
});

test("flow binds state, nonce and PKCE to a secure host-only cookie; callback cannot replay", async () => {
	const context = await setup();
	const flow = await context.start();
	assert.match(
		flow.response.headers["Set-Cookie"][0],
		/; Path=\/; Secure; HttpOnly; SameSite=Lax;/,
	);
	assert.doesNotMatch(flow.response.headers["Set-Cookie"][0], /Domain=/);
	assert.match(flow.flow.nonce, /^[A-Za-z0-9_-]{43}$/);
	assert.match(flow.flow.verifier, /^[A-Za-z0-9_-]{43}$/);
	const url = new URL(`${ORIGIN}/auth/callback?state=${flow.state}&code=valid`);
	const success = await context.identity.handle(request(flow.cookie), url);
	assert.equal(success.status, 303);
	assert.equal(success.headers.Location, "/");
	assert.doesNotMatch(JSON.stringify(success), /private-token|person/);
	assert.equal(
		(await context.identity.handle(request(flow.cookie), url)).status,
		400,
	);
	assert.equal(context.exchanges(), 1);
});

test("forged, missing, duplicated, mismatched and expired callback state never exchanges tokens", async () => {
	for (const mode of [
		"forged",
		"missing",
		"duplicate",
		"expired",
		"no-cookie",
	]) {
		const context = await setup();
		const flow = await context.start();
		if (mode === "expired") context.expire();
		const state =
			mode === "missing"
				? ""
				: mode === "duplicate"
					? `state=${flow.state}&state=${flow.state}`
					: `state=${mode === "forged" ? "forged" : flow.state}`;
		const response = await context.identity.handle(
			request(mode === "no-cookie" ? "" : flow.cookie),
			new URL(`${ORIGIN}/auth/callback?${state}&code=valid`),
		);
		assert.equal(response.status, 400, mode);
		assert.equal(context.exchanges(), 0);
	}
});

test("existing sessions lose privileges immediately on role revocation, identity rejection and expiry", async () => {
	const context = await setup();
	const { session } = await context.login();
	assert.equal(await context.identity.access(request(session)), "management");
	context.setGrants(roles("breinhap.student"));
	assert.equal(await context.identity.access(request(session)), "denied");
	context.setGrants(roles("breinhap.teacher"));
	assert.equal(await context.identity.access(request(session)), "management");
	context.revokeIdentity();
	await assert.rejects(context.identity.access(request(session)));
	context.expire();
	assert.equal(await context.identity.access(request(session)), "anonymous");
	assert.equal(
		await context.identity.access(
			request("__Host-breinhap-session=forged; role=admin"),
		),
		"anonymous",
	);
});

test("logout GET returns 405; same-origin POST and session CSRF destroy the session", async () => {
	const context = await setup();
	const { session } = await context.login();
	const authenticated = request(session);
	await context.identity.access(authenticated);
	const url = new URL(`${ORIGIN}/afmelden`);
	const body = `csrf=${authenticated.managementSession.csrf}`;
	assert.equal(
		(await context.identity.handle(request(session), url)).status,
		405,
	);
	assert.equal(
		(
			await context.identity.handle(
				request(session, {
					method: "POST",
					body,
					origin: "https://attacker.test",
				}),
				url,
			)
		).status,
		403,
	);
	assert.equal(
		(
			await context.identity.handle(
				request(session, {
					method: "POST",
					body: "csrf=forged",
					origin: ORIGIN,
				}),
				url,
			)
		).status,
		403,
	);
	assert.equal(await context.identity.access(request(session)), "management");
	const result = await context.identity.handle(
		request(session, { method: "POST", body, origin: ORIGIN }),
		url,
	);
	assert.equal(result.status, 303);
	assert.match(result.headers["Set-Cookie"][0], /Max-Age=0/);
	assert.equal(await context.identity.access(request(session)), "anonymous");
});

test("a new application instance uses the shared session; login starts are rate limited", async () => {
	const first = await setup({ maxEntries: 1 });
	const { session } = await first.login();
	assert.equal(
		await (await setup({ shared: first.identity.store })).identity.access(
			request(session),
		),
		"management",
	);
	await first.start();
	for (let i = 0; i < 28; i++) await first.start();
	const result = await first.identity.handle(
		request(),
		new URL(`${ORIGIN}/auth/start`),
	);
	assert.equal(result.status, 429);
});

test("registry request signing matches the shared OS ed25519-v1 protocol", async () => {
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const credential = `osk1.breinhap.012345abcdef.${privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url")}`;
	const path = "/registry/v1/apps/breinhap/subjects/person";
	const headers = signRequest(credential, path);
	const canonical = `v1\n${headers["x-asafarim-timestamp"]}\n${headers["x-asafarim-nonce"]}\nGET\n${path}\n${createHash("sha256").update("").digest("hex")}`;
	assert.ok(
		verify(
			null,
			Buffer.from(canonical),
			publicKey,
			Buffer.from(headers["x-asafarim-signature"].slice(3), "base64url"),
		),
	);
	assert.throws(() =>
		signRequest(credential.replace("breinhap", "other"), path),
	);
	const calls = [];
	const platform = createPlatform({
		url: "http://core-api:4020",
		credential,
		fetcher: async (url, options) => {
			calls.push({ url, options });
			return new Response(JSON.stringify(roles("breinhap.teacher")), {
				status: 200,
			});
		},
	});
	await platform.register();
	await platform.grants("person");
	assert.equal(calls[0].options.method, "POST");
	assert.equal(calls[1].options.cache, "no-store");
	assert.equal(calls[1].options.redirect, "error");
	assert.equal(manifest.roles.length, 5);
	assert.deepEqual(
		manifest.roles.find((role) => role.key === "breinhap.student").grants,
		["breinhap.student.access"],
	);
});

test("production discovery cannot be redirected to an untrusted issuer or client", async () => {
	await assert.rejects(
		discoverProvider({ issuer: "http://attacker.test", clientId: "breinhap" }),
	);
	await assert.rejects(
		discoverProvider({ issuer: "https://id.asafarim.site", clientId: "other" }),
	);
});

test("real OIDC client verifies signed ID tokens, audience, nonce and expiration", async () => {
	const { sign } = await import("node:crypto");
	const issuer = "https://id.asafarim.site";
	const { privateKey, publicKey } = generateKeyPairSync("ec", {
		namedCurve: "P-256",
	});
	const jwk = {
		...publicKey.export({ format: "jwk" }),
		kid: "test-key",
		alg: "ES256",
		use: "sig",
	};
	for (const mode of [
		"valid",
		"signature",
		"audience",
		"issuer",
		"nonce",
		"expired",
	]) {
		let nonce;
		const provider = await discoverProvider({
			issuer,
			clientId: "breinhap",
			fetcher: async (input) => {
				const url = String(input);
				if (url.endsWith("/.well-known/openid-configuration"))
					return Response.json({
						issuer,
						authorization_endpoint: `${issuer}/auth`,
						token_endpoint: `${issuer}/token`,
						userinfo_endpoint: `${issuer}/me`,
						jwks_uri: `${issuer}/jwks`,
						end_session_endpoint: `${issuer}/session/end`,
						response_types_supported: ["code"],
						subject_types_supported: ["public"],
						id_token_signing_alg_values_supported: ["ES256"],
						token_endpoint_auth_methods_supported: ["none"],
					});
				if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
				if (url.endsWith("/token")) {
					const time = Math.floor(Date.now() / 1000);
					const claims = {
						auth_time: time,
						sid: "browser",
						iss: mode === "issuer" ? "https://attacker.test" : issuer,
						sub: "person",
						aud: mode === "audience" ? "other" : "breinhap",
						iat: time,
						exp: mode === "expired" ? time - 1000 : time + 3600,
						nonce: mode === "nonce" ? "forged" : nonce,
					};
					const encode = (value) =>
						Buffer.from(JSON.stringify(value)).toString("base64url");
					const message = `${encode({ alg: "ES256", kid: "test-key" })}.${encode(claims)}`;
					const signature =
						mode === "signature"
							? Buffer.alloc(64)
							: sign("sha256", Buffer.from(message), {
									key: privateKey,
									dsaEncoding: "ieee-p1363",
								});
					return Response.json({
						access_token: "private-token",
						token_type: "Bearer",
						expires_in: 3600,
						id_token: `${message}.${signature.toString("base64url")}`,
					});
				}
				throw new Error(`Unexpected endpoint: ${url}`);
			},
		});
		const flow = { state: "state", nonce: "nonce", verifier: "a".repeat(43) };
		const location = new URL(await provider.authorizationUrl(flow));
		nonce = location.searchParams.get("nonce");
		assert.equal(location.searchParams.get("code_challenge_method"), "S256");
		assert.equal(
			location.searchParams.get("redirect_uri"),
			`${ORIGIN}/auth/callback`,
		);
		const promise = provider.exchange(
			new URL(`${ORIGIN}/auth/callback?code=valid&state=state`),
			flow,
		);
		if (mode === "valid") assert.equal((await promise).sub, "person");
		else await assert.rejects(promise, undefined, mode);
	}
});

test("malformed application lifecycle data is unavailable rather than an empty grant", () => {
	for (const state of [undefined, null, {}, "unknown-state"])
		assert.throws(() =>
			managementAccess({ ...roles("breinhap.admin"), state }, "person"),
		);
});

test("registry dot-segment subjects are rejected before any network request", async () => {
	const { createPlatform, validSubject } = await import("../src/platform.mjs");
	const platform = createPlatform({
		url: "http://core.test",
		credential: "unused",
		fetcher: async () => {
			throw Error("network must not run");
		},
	});
	for (const subject of [".", ".."]) {
		assert.equal(validSubject(subject), false);
		assert.throws(() => platform.grants(subject), /Invalid account code/);
	}
	assert.equal(validSubject("person.name"), true);
});

test("stale logout clears local cookies without identity logout and still rejects cross-origin requests", async () => {
	const context = await setup();
	const url = new URL(`${ORIGIN}/afmelden`);
	for (const origin of ["null", "https://attacker.test", undefined]) {
		const req = request("", { method: "POST", origin });
		if (origin === undefined) delete req.headers.origin;
		assert.equal((await context.identity.handle(req, url)).status, 403);
	}
	const result = await context.identity.handle(
		request("", { method: "POST", origin: ORIGIN }),
		url,
	);
	assert.equal(result.status, 303);
	assert.equal(result.headers.Location, "/login?logged-out=1");
	assert.equal(result.headers["Set-Cookie"].length, 3);
	assert.ok(result.headers["Set-Cookie"].every((c) => c.includes("Max-Age=0")));
});
