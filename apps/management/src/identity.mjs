import { createHash, randomBytes } from "node:crypto";
import * as oidc from "openid-client";
import { managementAccess } from "./platform.mjs";

export const ORIGIN = "https://management.breinhap.com";
const SESSION = "__Host-breinhap-session";
const FLOW = "__Host-breinhap-login";
const random = () => randomBytes(32).toString("base64url");
const hash = (value) => createHash("sha256").update(value).digest("base64url");
const cookie = (name, value, age) =>
	`${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const redirect = (location, cookies = []) => ({
	status: 303,
	headers: { Location: location, "Set-Cookie": cookies },
	body: "",
});

function readCookie(req, name) {
	const values = (req.headers.cookie ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${name}=`));
	if (values.length !== 1) return null;
	const value = values[0].slice(name.length + 1);
	return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

// Opaque cookie references only. Tokens/PKCE secrets never leave the server; restart signs everyone out.
export function createIdentity({
	provider,
	grants,
	now = Date.now,
	maxEntries = 1000,
}) {
	const flows = new Map();
	const sessions = new Map();
	function prune(store) {
		for (const [key, value] of store)
			if (value.expires <= now()) store.delete(key);
	}
	function session(req) {
		prune(sessions);
		const token = readCookie(req, SESSION);
		return token ? sessions.get(hash(token)) : undefined;
	}
	async function access(req) {
		const saved = session(req);
		if (!saved) return "anonymous";
		// Live userinfo invalidates revoked identity grants; registry reads are uncached for local role revocation.
		const profile = await provider.userInfo(saved.accessToken, saved.sub);
		if (profile.sub !== saved.sub) throw new Error("Identity subject mismatch");
		const current = managementAccess(await grants(saved.sub), saved.sub);
		if (saved.expires <= now()) return "anonymous";
		req.managementSession = { csrf: saved.csrf, roles: current.roles };
		return current.access;
	}
	async function handle(req, url) {
		if (!["/auth/start", "/auth/callback", "/afmelden"].includes(url.pathname))
			return null;
		if (url.pathname === "/afmelden") {
			const saved = session(req);
			if (req.method !== "POST" || req.headers.origin !== ORIGIN || !saved)
				return { status: 403, body: "Afmelden geweigerd." };
			let body = "";
			for await (const chunk of req) {
				body += chunk;
				if (body.length > 1024)
					return { status: 413, body: "Aanvraag te groot." };
			}
			if (new URLSearchParams(body).get("csrf") !== saved.csrf)
				return { status: 403, body: "Afmelden geweigerd." };
			sessions.delete(hash(readCookie(req, SESSION)));
			return redirect(provider.logoutUrl(), [
				cookie(SESSION, "", 0),
				cookie(FLOW, "", 0),
			]);
		}
		if (req.method !== "GET")
			return {
				status: 405,
				body: "Method not allowed",
				headers: { Allow: "GET" },
			};
		if (url.pathname === "/auth/start") {
			prune(flows);
			if (flows.size >= maxEntries)
				return {
					status: 503,
					body: "Aanmelden is tijdelijk niet beschikbaar.",
				};
			const flow = random();
			const state = random();
			const nonce = random();
			const verifier = oidc.randomPKCECodeVerifier();
			const location = await provider.authorizationUrl({
				state,
				nonce,
				verifier,
			});
			flows.set(hash(flow), {
				state,
				nonce,
				verifier,
				expires: now() + 600_000,
			});
			return redirect(location, [cookie(FLOW, flow, 600)]);
		}
		prune(flows);
		const flowToken = readCookie(req, FLOW);
		const key = flowToken ? hash(flowToken) : null;
		const flow = flows.get(key);
		flows.delete(key); // One use, including failed exchanges and concurrent callback replays.
		if (
			!flow ||
			url.searchParams.getAll("state").length !== 1 ||
			url.searchParams.get("state") !== flow.state
		) {
			return {
				status: 400,
				body: "Aanmelden mislukt. Probeer opnieuw.",
				headers: { "Set-Cookie": cookie(FLOW, "", 0) },
			};
		}
		let token;
		try {
			token = await provider.exchange(url, flow);
		} catch {
			return {
				status: 400,
				body: "Aanmelden mislukt. Probeer opnieuw.",
				headers: { "Set-Cookie": cookie(FLOW, "", 0) },
			};
		}
		if (
			!token ||
			typeof token.sub !== "string" ||
			!token.sub ||
			token.sub.length > 400 ||
			typeof token.accessToken !== "string" ||
			!Number.isFinite(token.expiresIn) ||
			token.expiresIn <= 0
		)
			throw new Error("Invalid token response");
		prune(sessions);
		if (sessions.size >= maxEntries)
			return { status: 503, body: "Aanmelden is tijdelijk niet beschikbaar." };
		// Rotate on successful login. A supplied pre-login session identifier cannot survive authentication.
		const previous = readCookie(req, SESSION);
		if (previous) sessions.delete(hash(previous));
		const value = random();
		const age = Math.floor(Math.min(token.expiresIn, 3600));
		sessions.set(hash(value), {
			sub: token.sub,
			accessToken: token.accessToken,
			csrf: random(),
			expires: now() + age * 1000,
		});
		return redirect("/", [cookie(SESSION, value, age), cookie(FLOW, "", 0)]);
	}
	return { access, handle };
}

export async function discoverProvider({ issuer, clientId, fetcher = fetch }) {
	if (issuer !== "https://id.asafarim.site" || clientId !== "breinhap")
		throw new Error("Unexpected identity configuration");
	const config = await oidc.discovery(
		new URL(issuer),
		clientId,
		{ id_token_signed_response_alg: "ES256" },
		oidc.None(),
		{ timeout: 5, [oidc.customFetch]: fetcher },
	);
	oidc.enableNonRepudiationChecks(config);
	return {
		authorizationUrl: async ({ state, nonce, verifier }) =>
			oidc.buildAuthorizationUrl(config, {
				redirect_uri: `${ORIGIN}/auth/callback`,
				scope: "openid",
				state,
				nonce,
				code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
				code_challenge_method: "S256",
			}).href,
		exchange: async (url, flow) => {
			const tokens = await oidc.authorizationCodeGrant(config, url, {
				pkceCodeVerifier: flow.verifier,
				expectedState: flow.state,
				expectedNonce: flow.nonce,
				idTokenExpected: true,
			});
			return {
				sub: tokens.claims()?.sub,
				accessToken: tokens.access_token,
				expiresIn: tokens.expires_in,
			};
		},
		userInfo: (token, subject) => oidc.fetchUserInfo(config, token, subject),
		logoutUrl: () =>
			oidc.buildEndSessionUrl(config, {
				client_id: clientId,
				post_logout_redirect_uri: `${ORIGIN}/aanmelden`,
			}).href,
	};
}
