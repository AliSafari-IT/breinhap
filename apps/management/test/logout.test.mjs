import assert from "node:assert/strict";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { discoverProvider } from "../src/identity.mjs";

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
		if (mode === "valid" || mode === "sub-only")
			assert.equal((await provider.validateLogout(token)).jti, `jti-${mode}`);
		else await assert.rejects(provider.validateLogout(token), undefined, mode);
	}
});
