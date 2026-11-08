import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { createManagementServer } from "../src/server.mjs";
import { makeStore } from "./helpers.mjs";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createIdentity, discoverProvider } from "../src/identity.mjs";

test("signed back-channel tokens validate issuer/audience/time/event/sid and reject nonce/replay inputs", async () => {
	const issuer = "https://id.asafarim.site";
	const { privateKey, publicKey } = await generateKeyPair("ES256");
	const jwk = {
		...(await exportJWK(publicKey)),
		kid: "logout-key",
		alg: "ES256",
		use: "sig",
	};
	const provider = await discoverProvider({
		issuer,
		clientId: "breinhap",
		fetcher: async (input) =>
			String(input).endsWith("/jwks")
				? Response.json({ keys: [jwk] })
				: Response.json({
						issuer,
						authorization_endpoint: `${issuer}/auth`,
						token_endpoint: `${issuer}/token`,
						jwks_uri: `${issuer}/jwks`,
						end_session_endpoint: `${issuer}/session/end`,
						response_types_supported: ["code"],
						subject_types_supported: ["public"],
						id_token_signing_alg_values_supported: ["ES256"],
						token_endpoint_auth_methods_supported: ["none"],
					}),
	});
	for (const mode of [
		"valid",
		"sub-only",
		"audience",
		"issuer",
		"nonce",
		"old",
		"event",
		"no-subject",
		"signature",
	]) {
		const now = Math.floor(Date.now() / 1000);
		const payload = {
			events:
				mode === "event"
					? {}
					: { "http://schemas.openid.net/event/backchannel-logout": {} },
			...(mode === "no-subject"
				? {}
				: mode === "sub-only"
					? { sub: "person" }
					: { sid: "browser", sub: "person" }),
			...(mode === "nonce" ? { nonce: "forbidden" } : {}),
		};
		const key =
			mode === "signature"
				? (await generateKeyPair("ES256")).privateKey
				: privateKey;
		const token = await new SignJWT(payload)
			.setProtectedHeader({ alg: "ES256", kid: "logout-key" })
			.setIssuer(mode === "issuer" ? "https://other.test" : issuer)
			.setAudience(mode === "audience" ? "other" : "breinhap")
			.setIssuedAt(mode === "old" ? now - 1000 : now)
			.setJti(`jti-${mode}`)
			.setExpirationTime(now + 120)
			.sign(key);
		if (mode === "valid") {
			const store = await makeStore();
			await store.saveSession("logout-victim", {
				sub: "person",
				sid: "browser",
				issuedAt: now - 1,
				expires: Date.now() + 60000,
			});
			const identity = createIdentity({
				provider,
				store,
				grants: async () => {
					throw Error("unused");
				},
			});
			const server = createManagementServer({ identity });
			await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
			try {
				const post = (value) =>
					new Promise((resolve, reject) => {
						const req = http.request(
							{
								hostname: "127.0.0.1",
								port: server.address().port,
								path: "/auth/backchannel-logout",
								method: "POST",
								headers: {
									Host: "management.breinhap.com",
									"Content-Type": "application/x-www-form-urlencoded",
								},
							},
							(res) => {
								res.resume();
								res.on("end", () => resolve(res.statusCode));
							},
						);
						req.on("error", reject);
						req.end(new URLSearchParams({ logout_token: value }).toString());
					});
				// Reject abusive input before JWT validation, including a valid token once the IP is over budget.
				for (let n = 0; n < 120; n++) assert.equal(await post("invalid"), 400);
				assert.equal(await post("invalid"), 429);
				assert.equal(await post(token), 429);
				store.now = () => Date.now() + 61_000;
				assert.equal(await post(token), 200);
				assert.equal(await store.getSession("logout-victim"), null);
			} finally {
				await new Promise((resolve) => server.close(resolve));
			}
		}
		if (mode === "valid" || mode === "sub-only")
			assert.equal((await provider.validateLogout(token)).jti, `jti-${mode}`);
		else await assert.rejects(provider.validateLogout(token), undefined, mode);
	}
});
