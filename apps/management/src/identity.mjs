import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import * as oidc from "openid-client";
import { managementAccess, roleLabels } from "./platform.mjs";
import { ABSOLUTE_MS, SELF_SERVICE_ROLES } from "./store.mjs";

export const ORIGIN = "https://management.breinhap.com";
export const SITE_ORIGIN = "https://breinhap.com";
const SESSION = "__Host-breinhap-session";
const FLOW = "__Host-breinhap-login";
const INVITE = "__Host-breinhap-invitation";
const random = () => randomBytes(32).toString("base64url");
const cookie = (name, value, age) =>
	`${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${age}`;
const redirect = (location, cookies = []) => ({
	status: 303,
	headers: { Location: location, "Set-Cookie": cookies },
	body: "",
});
const message = (status, body) => ({ status, body });
const stepUp = () =>
	message(
		428,
		'Bevestig eerst opnieuw je identiteit. <a href="/auth/start?fresh=1">Opnieuw aanmelden</a>',
	);
export const readCookie = (req, name) => {
	const matches = (req.headers.cookie ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part.startsWith(`${name}=`));
	const value = matches.length === 1 ? matches[0].slice(name.length + 1) : "";
	return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
};
export async function readForm(req, limit = 4096) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const bytes = Buffer.from(chunk);
		size += bytes.length;
		if (size > limit)
			throw Object.assign(new Error("Request too large"), { status: 413 });
		chunks.push(bytes);
	}
	return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}
const csrfValid = (req, form, session) =>
	req.method === "POST" &&
	req.headers.origin === ORIGIN &&
	form.getAll("csrf").length === 1 &&
	form.get("csrf") === session.csrf;
export function isFresh(session, now = Date.now()) {
	return (
		Number.isFinite(session.authTime) &&
		session.authTime <= now / 1000 + 5 &&
		now / 1000 - session.authTime <= 300
	);
}

export function createIdentity({
	provider,
	grants,
	store,
	now = Date.now,
	audit = store ? store.audit.bind(store) : async () => {},
}) {
	if (!store) throw new Error("A shared identity store is required");
	async function session(req, touch = true) {
		const id = readCookie(req, SESSION);
		let saved = id ? await store.getSession(id, touch) : null;
		if (!saved) return null;
		if (saved.tokenExpires <= now() + 10_000) {
			if (!saved.refreshToken) {
				await store.destroySession(id);
				return null;
			}
			let lock = await store.acquireRefresh(id);
			if (!lock) {
				for (let attempt = 0; attempt < 50; attempt++) {
					await new Promise((resolve) => setTimeout(resolve, 100));
					saved = await store.getSession(id, false);
					if (!saved) return null;
					if (saved.tokenExpires > now() + 10_000) return { id, saved };
				}
				saved = await store.getSession(id, false);
				if (!saved) return null;
				if (saved.tokenExpires > now() + 10_000) return { id, saved };
				lock = await store.acquireRefresh(id);
				if (!lock) throw new Error("Refresh busy");
			}
			let renewing = null;
			let leaseLost = false;
			const renewal = setInterval(
				() => {
					if (renewing) return;
					renewing = store
						.renewRefresh(id, lock)
						.then(
							(ok) => {
								if (!ok) leaseLost = true;
							},
							() => {
								leaseLost = true;
							},
						)
						.finally(() => {
							renewing = null;
						});
				},
				Math.max(10, Math.floor(store.refreshLeaseMs / 3)),
			);
			renewal.unref();
			try {
				saved = await store.getSession(id, false);
				if (!saved) return null;
				if (saved.tokenExpires <= now() + 10_000) {
					let tokens;
					try {
						tokens = await provider.refresh(saved.refreshToken, saved.sub);
					} catch (error) {
						if (error.status === 400 || error.status === 401) {
							await store.destroySession(id);
							return null;
						}
						throw error;
					}
					if (
						typeof tokens.accessToken !== "string" ||
						!Number.isFinite(tokens.expiresIn) ||
						tokens.expiresIn <= 0
					)
						throw new Error("Invalid refreshed token");
					saved = {
						...saved,
						accessToken: tokens.accessToken,
						refreshToken: tokens.refreshToken ?? saved.refreshToken,
						tokenExpires: now() + tokens.expiresIn * 1000,
					};
					await renewing;
					if (leaseLost) throw new Error("Refresh ownership lost");
					if (!(await store.saveSession(id, saved, lock))) return null;
				}
			} finally {
				clearInterval(renewal);
				await renewing;
				await store.releaseRefresh(id, lock);
			}
		}
		return { id, saved };
	}
	async function current(req, touch = true) {
		const value = await session(req, touch);
		if (!value) return null;
		try {
			const profile = await provider.userInfo(
				value.saved.accessToken,
				value.saved.sub,
			);
			if (profile.sub !== value.saved.sub)
				throw new Error("Identity subject mismatch");
		} catch (error) {
			if (error.status === 401) {
				await store.destroySession(value.id);
				return null;
			}
			throw error;
		}
		const grant = managementAccess(
			await grants(value.saved.sub),
			value.saved.sub,
		);
		const membership = await store.membership(value.saved.sub);
		// ASafariM proves who someone is; the Breinhap membership says which adult role they have. A
		// self-chosen role becomes a membership only after a Breinhap administrator approves it. The
		// administrator role itself still needs the matching ASafariM grant, and an account that ASafariM
		// knows only as a student never gets adult access.
		const studentOnly = grant.roleKeys.length > 0 && !grant.adult;
		const allowed =
			membership?.active === true &&
			Object.hasOwn(roleLabels, membership.role) &&
			(membership.role === "breinhap.admin"
				? grant.access === "management" &&
					grant.roleKeys.includes("breinhap.admin")
				: SELF_SERVICE_ROLES.includes(membership.role) && !studentOnly);
		// Check again after network calls: logout/expiry may have happened during validation.
		if (!(await store.getSession(value.id, false))) return null;
		req.managementSession = {
			csrf: value.saved.csrf,
			roles: allowed ? [roleLabels[membership.role]] : [],
			fresh: isFresh(value.saved, now()),
			admin:
				allowed &&
				membership.role === "breinhap.admin" &&
				grant.permissions.includes("breinhap.memberships.manage"),
		};
		req.managementSession.canRequest = !allowed && !studentOnly;
		return {
			...value,
			grant,
			membership,
			allowed,
			studentOnly,
			admin: req.managementSession.admin,
		};
	}
	async function access(req) {
		const value = await current(req, true);
		if (!value) return "anonymous";
		if (!value.allowed) await audit("management.denied", value.saved.sub);
		return value.allowed ? "management" : "denied";
	}
	async function handle(req, url) {
		const path = url.pathname;
		if (
			![
				"/auth/start",
				"/auth/callback",
				"/auth/backchannel-logout",
				"/auth/session",
				"/auth/invite-link",
				"/afmelden",
			].includes(path)
		)
			return null;
		if (path === "/auth/backchannel-logout") {
			if (req.method !== "POST")
				return {
					...message(405, "Method not allowed"),
					headers: { Allow: "POST" },
				};
			let claims;
			try {
				const form = await readForm(req, 16384);
				if (form.getAll("logout_token").length !== 1)
					return message(400, "Invalid logout token");
				claims = await provider.validateLogout(form.get("logout_token"));
			} catch {
				return message(400, "Invalid logout token");
			}
			if (!(await store.budget("logout", 120, 60, claims.sid ?? claims.sub)))
				return message(429, "Probeer later opnieuw.");
			await store.logout(claims);
			return message(200, "ok");
		}
		if (path === "/auth/invite-link") {
			if (req.method !== "POST" || req.headers.origin !== ORIGIN)
				return message(403, "Aanvraag geweigerd.");
			const token = (await readForm(req)).get("token");
			if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? ""))
				return message(400, "Ongeldige uitnodiging.");
			return redirect("/uitnodiging/bevestigen", [
				cookie(INVITE, token, 86400),
			]);
		}
		if (path === "/auth/session") {
			if (req.method !== "GET") return message(405, "Method not allowed");
			const value = await current(req, false);
			// breinhap.com is same-site, so the SameSite=Lax host-only cookie is sent with its credentialed
			// fetch; only that origin may read whether someone is signed in, to show it in its navbar.
			const site = req.headers.origin === SITE_ORIGIN;
			return {
				status: value?.allowed ? 200 : value ? 403 : 401,
				body: JSON.stringify({ active: value?.allowed === true }),
				type: "application/json; charset=utf-8",
				headers: {
					Vary: "Origin",
					...(site
						? {
								"Access-Control-Allow-Origin": SITE_ORIGIN,
								"Access-Control-Allow-Credentials": "true",
							}
						: {}),
				},
			};
		}
		if (path === "/afmelden") {
			// Local logout does not depend on the provider or permission service being reachable.
			const id = readCookie(req, SESSION);
			const saved = id ? await store.getSession(id, false) : null;
			if (req.method !== "POST" || req.headers.origin !== ORIGIN)
				return message(403, "Afmelden geweigerd.");
			if (!saved)
				return redirect("/login?logged-out=1", [
					cookie(SESSION, "", 0),
					cookie(FLOW, "", 0),
					cookie(INVITE, "", 0),
				]);
			if (!csrfValid(req, await readForm(req), saved))
				return message(403, "Afmelden geweigerd.");
			await store.destroySession(id);
			let location = "/login?logged-out=1";
			try {
				location = provider.logoutUrl();
			} catch {
				/* Local session has already ended. */
			}
			return redirect(location, [
				cookie(SESSION, "", 0),
				cookie(FLOW, "", 0),
				cookie(INVITE, "", 0),
			]);
		}
		if (req.method !== "GET")
			return {
				...message(405, "Method not allowed"),
				headers: { Allow: "GET" },
			};
		if (path === "/auth/start") {
			// Caddy overwrites this header with its transport peer, only for rate limiting.
			const forwarded = req.headers["x-breinhap-client-address"];
			const requester =
				typeof forwarded === "string" && isIP(forwarded)
					? forwarded
					: (req.socket?.remoteAddress ?? "direct");
			if (
				!(await store.budget("start", 30, 60, requester)) ||
				!(await store.budget("start-global", 3000))
			)
				return message(429, "Te veel aanmeldpogingen. Probeer later opnieuw.");
			const flow = random();
			const invite = readCookie(req, INVITE);
			const fresh = url.searchParams.get("fresh") === "1" || Boolean(invite);
			const state = {
				state: random(),
				nonce: random(),
				verifier: oidc.randomPKCECodeVerifier(),
				fresh,
				invite,
				expires: now() + 600_000,
			};
			const location = await provider.authorizationUrl(state);
			await store.putFlow(flow, state);
			return redirect(location, [cookie(FLOW, flow, 600)]);
		}
		const token = readCookie(req, FLOW);
		const flow = token ? await store.takeFlow(token) : null;
		if (
			!flow ||
			flow.expires <= now() ||
			url.searchParams.getAll("state").length !== 1 ||
			url.searchParams.get("state") !== flow.state
		)
			return {
				...message(400, "Aanmelden mislukt. Probeer opnieuw."),
				headers: { "Set-Cookie": cookie(FLOW, "", 0) },
			};
		let identity;
		try {
			identity = await provider.exchange(url, flow);
		} catch {
			return {
				...message(400, "Aanmelden mislukt. Probeer opnieuw."),
				headers: { "Set-Cookie": cookie(FLOW, "", 0) },
			};
		}
		const time = now();
		if (
			typeof identity.sub !== "string" ||
			!identity.sub ||
			identity.sub.length > 400 ||
			typeof identity.sid !== "string" ||
			!identity.sid ||
			identity.sid.length > 400 ||
			typeof identity.accessToken !== "string" ||
			!Number.isFinite(identity.expiresIn) ||
			identity.expiresIn <= 0 ||
			!Number.isFinite(identity.authTime) ||
			identity.authTime > time / 1000 + 5 ||
			time - identity.authTime * 1000 >= ABSOLUTE_MS ||
			!Number.isFinite(identity.issuedAt) ||
			identity.issuedAt > time / 1000 + 5
		)
			return message(400, "Ongeldige aanmelding. Probeer opnieuw.");
		if (flow.fresh && !isFresh(identity, time))
			return message(400, "Nieuwe identiteitsbevestiging ontbreekt.");
		const previous = readCookie(req, SESSION);
		if (previous) await store.destroySession(previous);
		const id = random();
		const saved = {
			...identity,
			csrf: random(),
			expires: identity.authTime * 1000 + ABSOLUTE_MS,
			tokenExpires: time + identity.expiresIn * 1000,
		};
		if (!(await store.saveSession(id, saved)))
			return message(400, "Deze aanmelding is beëindigd. Probeer opnieuw.");
		return redirect(flow.invite ? "/uitnodiging/bevestigen" : "/", [
			cookie(SESSION, id, Math.floor((saved.expires - time) / 1000)),
			cookie(FLOW, "", 0),
		]);
	}
	async function privileged(req) {
		const value = await current(req);
		if (!value?.admin) {
			await audit("management.denied", value?.saved.sub);
			return { response: message(403, "Geen beheertoegang.") };
		}
		if (!isFresh(value.saved, now())) return { response: stepUp() };
		return { value };
	}
	// Signed in but no access yet: show, or file, a request for one self-service role.
	async function roleRequest(req) {
		const value = await current(req);
		if (!value) return { anonymous: true };
		if (value.allowed) return { allowed: true };
		if (value.studentOnly) return { student: true };
		if (req.method !== "POST")
			return { pending: await store.roleRequest(value.saved.sub) };
		const form = await readForm(req);
		if (!csrfValid(req, form, value.saved)) return { refused: true };
		const role = form.get("role");
		if (form.getAll("role").length !== 1 || !SELF_SERVICE_ROLES.includes(role))
			return { invalid: true };
		if (!(await store.budget("request", 10, 3600, value.saved.sub)))
			return { busy: true };
		const result = await store.requestRole(value.saved.sub, role);
		if (result === "full") return { busy: true };
		if (result === "created")
			await audit("role.requested", value.saved.sub, role);
		return { pending: await store.roleRequest(value.saved.sub) };
	}
	async function acceptInvitation(req) {
		const value = await current(req);
		if (!value) return redirect("/auth/start?fresh=1");
		if (!isFresh(value.saved, now())) return stepUp();
		const token = readCookie(req, INVITE);
		const invitation = token ? await store.invitation(token) : null;
		if (!invitation?.data || invitation.data.subject !== value.saved.sub)
			return message(
				403,
				"Deze uitnodiging is niet voor dit account of is verlopen.",
			);
		const data = invitation.data;
		if (
			!value.grant.roleKeys.includes(data.role) ||
			value.grant.access !== "management"
		)
			return message(403, "De vereiste ASafariM-toegang ontbreekt.");
		const inviter = await store.membership(data.inviter);
		const inviterGrants = managementAccess(
			await grants(data.inviter),
			data.inviter,
		);
		if (
			!inviter?.active ||
			inviter.role !== "breinhap.admin" ||
			inviter.version !== data.inviterVersion ||
			inviterGrants.access !== "management" ||
			!inviterGrants.permissions.includes("breinhap.memberships.manage")
		)
			return message(403, "Deze uitnodiging is ingetrokken.");
		if (req.method === "GET")
			return {
				status: 200,
				body: `<h1>Uitnodiging accepteren</h1><p>Je krijgt toegang tot de Breinhap-beheerwerkplek.</p><form method="post" action="/uitnodiging/bevestigen"><input type="hidden" name="csrf" value="${value.saved.csrf}"><button>Uitnodiging accepteren</button></form>`,
			};
		if (!csrfValid(req, await readForm(req), value.saved))
			return message(403, "Aanvraag geweigerd.");
		if (!(await store.accept(token, invitation, inviter, value.saved.sub)))
			return message(409, "De uitnodiging is al gebruikt of gewijzigd.");
		await audit("invitation.accepted", value.saved.sub, data.inviter);
		return redirect("/", [cookie(INVITE, "", 0)]);
	}
	return {
		access,
		current,
		handle,
		privileged,
		acceptInvitation,
		roleRequest,
		grants,
		store,
		audit,
		ready: () => store.ready(),
		readInvitation: (req) => readCookie(req, INVITE),
	};
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
	const keys = createRemoteJWKSet(new URL(config.serverMetadata().jwks_uri), {
		[customFetch]: fetcher,
		timeoutDuration: 5000,
	});
	const convert = (tokens) => {
		const claims = tokens.claims();
		return {
			sub: claims?.sub,
			sid: claims?.sid,
			authTime: claims?.auth_time,
			issuedAt: claims?.iat,
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token,
			expiresIn: tokens.expires_in,
		};
	};
	return {
		authorizationUrl: async ({ state, nonce, verifier, fresh }) =>
			oidc.buildAuthorizationUrl(config, {
				redirect_uri: `${ORIGIN}/auth/callback`,
				scope: "openid offline_access",
				prompt: fresh ? "login consent" : "consent",
				max_age: fresh ? "300" : "43200",
				state,
				nonce,
				code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
				code_challenge_method: "S256",
			}).href,
		exchange: async (url, flow) =>
			convert(
				await oidc.authorizationCodeGrant(config, url, {
					pkceCodeVerifier: flow.verifier,
					expectedState: flow.state,
					expectedNonce: flow.nonce,
					idTokenExpected: true,
					maxAge: flow.fresh ? 300 : 43200,
				}),
			),
		refresh: async (token, subject) => {
			const result = await oidc.refreshTokenGrant(config, token);
			if (result.claims() && result.claims().sub !== subject)
				throw new Error("Refresh subject mismatch");
			return {
				accessToken: result.access_token,
				refreshToken: result.refresh_token,
				expiresIn: result.expires_in,
			};
		},
		userInfo: (token, subject) => oidc.fetchUserInfo(config, token, subject),
		validateLogout: async (token) => {
			const { payload } = await jwtVerify(token, keys, {
				issuer,
				audience: clientId,
				algorithms: ["ES256"],
				maxTokenAge: "2m",
				clockTolerance: 5,
				requiredClaims: ["iat", "jti", "events"],
			});
			const event =
				payload.events?.["http://schemas.openid.net/event/backchannel-logout"];
			if (
				!event ||
				typeof event !== "object" ||
				Array.isArray(event) ||
				"nonce" in payload ||
				typeof payload.jti !== "string" ||
				!payload.jti ||
				payload.jti.length > 400 ||
				(!payload.sid && !payload.sub) ||
				(payload.sid !== undefined &&
					(typeof payload.sid !== "string" ||
						!payload.sid ||
						payload.sid.length > 400)) ||
				(payload.sub !== undefined &&
					(typeof payload.sub !== "string" ||
						!payload.sub ||
						payload.sub.length > 400))
			)
				throw new Error("Invalid logout claims");
			return payload;
		},
		logoutUrl: () =>
			oidc.buildEndSessionUrl(config, {
				client_id: clientId,
				post_logout_redirect_uri: `${ORIGIN}/login`,
			}).href,
	};
}
