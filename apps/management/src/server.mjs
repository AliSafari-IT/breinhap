import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
	createIdentity,
	discoverProvider,
	isFresh,
	ORIGIN,
	readForm,
} from "./identity.mjs";
import { createPlatform, managementAccess, manifest } from "./platform.mjs";
import { connectStore } from "./store.mjs";

const origin = "https://management.breinhap.com";
const routes = new Map([
	[
		"/",
		[
			"Overzicht",
			"Je beheerwerkplek is klaar. De inhoudsbibliotheek volgt later.",
		],
	],
	[
		"/bibliotheek",
		["Bibliotheek", "Er is nog geen inhoudsbibliotheek beschikbaar."],
	],
]);
const style = await readFile(new URL("./styles.css", import.meta.url));
const theme = await readFile(
	new URL("../../site/src/theme.css", import.meta.url),
);

function page(title, content, active, session) {
	const account = session
		? `<aside aria-label="Account"><p>Je rollen: ${session.roles.join(", ")}</p><form method="post" action="/afmelden"><input type="hidden" name="csrf" value="${session.csrf}"><button type="submit">Afmelden</button></form></aside>`
		: "";
	const nav =
		active === undefined
			? ""
			: `<nav aria-label="Beheernavigatie">${[...routes].map(([path, [label]]) => `<a href="${path}"${active === path ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
	return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — Breinhap beheer</title><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/styles.css"><script src="/theme.js"></script><script src="/session.js" defer></script></head><body><a class="skip" href="#inhoud">Naar inhoud</a><header>Breinhap beheer<button type="button" data-theme-toggle aria-label="Donker thema" aria-pressed="false">◐</button></header>${nav}<main id="inhoud" tabindex="-1"><h1>${title}</h1><p>${content}</p>${account}<p><a href="https://breinhap.com/">Naar Breinhap voor leerlingen</a></p></main><footer>Breinhap beheer · ${manifest.version}</footer></body></html>`;
}

// The resolver and identity adapter are server-only; no request header grants a role.
export function createHandler({
	identity,
	resolveAccess = identity?.access ?? (async () => "anonymous"),
} = {}) {
	return async (req, res) => {
		const send = (
			status,
			body,
			type = "text/html; charset=utf-8",
			extra = {},
		) => {
			res.writeHead(status, {
				"Content-Type": type,
				"Cache-Control": "no-store",
				"Content-Security-Policy":
					"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; base-uri 'none'; form-action 'self' https://id.asafarim.site; frame-ancestors 'none'",
				"X-Content-Type-Options": "nosniff",
				"Referrer-Policy": "no-referrer",
				"X-Frame-Options": "DENY",
				"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
				...extra,
			});
			res.end(req.method === "HEAD" ? undefined : body);
		};
		// Match the real request Host, never X-Forwarded-Host; only origin-form targets are accepted.
		if (
			req.headers.host !== "management.breinhap.com" ||
			!req.url?.startsWith("/") ||
			req.url.startsWith("//")
		) {
			return send(421, "Misdirected request", "text/plain; charset=utf-8");
		}
		const url = new URL(req.url, origin);
		if (url.origin !== origin)
			return send(421, "Misdirected request", "text/plain; charset=utf-8");
		if (identity) {
			try {
				const response = await identity.handle(req, url);
				if (response)
					return send(
						response.status,
						response.body,
						response.type,
						response.headers,
					);
			} catch {
				return send(
					503,
					page(
						"Tijdelijk niet beschikbaar",
						"Aanmelden is tijdelijk niet beschikbaar. Probeer later opnieuw.",
					),
				);
			}
		}

		if (identity && url.pathname === "/uitnodiging/bevestigen") {
			const result = await identity.acceptInvitation(req);
			return send(
				result.status,
				result.status !== 303
					? page(
							"Uitnodiging accepteren",
							result.body.replace(/<h1>.*?<\/h1>/, ""),
							undefined,
							req.managementSession,
						)
					: result.body,
				undefined,
				result.headers,
			);
		}
		if (identity && url.pathname.startsWith("/beheer")) {
			const check = await identity.privileged(req);
			if (check.response)
				return send(
					check.response.status,
					page("Bevestig je toegang", check.response.body),
				);
			const { value } = check;
			if (req.method === "GET" && url.pathname === "/beheer")
				return send(
					200,
					page(
						"Toegang beheren",
						'Alleen bestaande actieve ASafariM-accounts met de juiste Breinhap-rol kunnen worden uitgenodigd.</p><form method="post" action="/beheer/uitnodigen"><label>ASafariM-accountcode <input name="subject" required maxlength="400"></label><label>Rol <select name="role"><option value="breinhap.parent">Ouder</option><option value="breinhap.tutor">Begeleider</option><option value="breinhap.teacher">Leerkracht</option></select></label><input type="hidden" name="csrf" value="' +
							value.saved.csrf +
							'"><button>Uitnodiging maken</button></form><form method="post" action="/beheer/intrekken"><label>Accountcode om toegang in te trekken <input name="subject" required maxlength="400"></label><input type="hidden" name="csrf" value="' +
							value.saved.csrf +
							'"><button>Toegang intrekken</button></form><p>',
						null,
						req.managementSession,
					),
				);
			if (req.method !== "POST")
				return send(405, "Method not allowed", "text/plain; charset=utf-8", {
					Allow: "GET, POST",
				});
			const form = await readForm(req);
			if (
				req.headers.origin !== ORIGIN ||
				form.getAll("csrf").length !== 1 ||
				form.get("csrf") !== value.saved.csrf ||
				!isFresh(value.saved)
			)
				return send(403, "Aanvraag geweigerd.");
			const subject = form.get("subject");
			if (
				form.getAll("subject").length !== 1 ||
				!/^[A-Za-z0-9:._@-]{1,400}$/.test(subject ?? "") ||
				subject === value.saved.sub
			)
				return send(
					400,
					"Ongeldige accountcode; je eigen toegang kan hier niet worden gewijzigd.",
				);
			if (url.pathname === "/beheer/intrekken") {
				await identity.audit("membership.revoke", value.saved.sub, subject);
				await identity.store.revokeMember(subject);
				return send(
					200,
					page(
						"Toegang ingetrokken",
						"Deze accountcode heeft geen toegang meer tot deze werkplek.",
						null,
						req.managementSession,
					),
				);
			}
			if (url.pathname !== "/beheer/uitnodigen")
				return send(404, "Niet gevonden");
			const role = form.get("role");
			if (
				form.getAll("role").length !== 1 ||
				!["breinhap.parent", "breinhap.tutor", "breinhap.teacher"].includes(
					role,
				)
			)
				return send(400, "Ongeldige rol.");
			const target = managementAccess(await identity.grants(subject), subject);
			if (
				target.access !== "management" ||
				!target.roleKeys.includes(role) ||
				(await identity.store.membership(subject))
			)
				return send(
					409,
					page(
						"Uitnodiging niet gemaakt",
						"Dit account moet actief zijn, de gekozen ASafariM-rol hebben en nog geen lid van deze werkplek zijn.",
					),
				);
			if (!isFresh(value.saved)) return send(428, "Meld je opnieuw aan.");
			const token = randomBytes(32).toString("base64url");
			await identity.audit("invitation.create", value.saved.sub, subject);
			const created = await identity.store.invite(token, {
				subject,
				role,
				inviter: value.saved.sub,
				inviterVersion: value.membership.version,
			});
			if (!created)
				return send(409, "Je beheertoegang is gewijzigd. Probeer opnieuw.");
			return send(
				200,
				page(
					"Uitnodiging gemaakt",
					'Deze link is één dag geldig en werkt alleen voor het bedoelde account. Deel de link zelf met de ontvanger.</p><label>Uitnodigingslink <input readonly value="https://management.breinhap.com/uitnodiging#' +
						token +
						'"></label><p>',
					null,
					req.managementSession,
				),
			);
		}
		if (!["GET", "HEAD"].includes(req.method))
			return send(405, "Method not allowed", "text/plain; charset=utf-8", {
				Allow: "GET, HEAD",
			});
		if (url.pathname === "/readyz")
			return send(
				identity &&
					(await identity.ready().then(
						() => true,
						() => false,
					))
					? 200
					: 503,
				"readiness\n",
				"text/plain; charset=utf-8",
			);
		if (url.pathname === "/healthz")
			return send(200, "ok\n", "text/plain; charset=utf-8");
		if (url.pathname === "/.well-known/asafarim-app.json")
			return send(
				200,
				JSON.stringify(manifest),
				"application/json; charset=utf-8",
			);
		if (url.pathname === "/styles.css")
			return send(200, style, "text/css; charset=utf-8");
		if (url.pathname === "/theme.css")
			return send(200, theme, "text/css; charset=utf-8");
		if (url.pathname === "/theme.js")
			return send(
				200,
				await readFile(new URL("../../site/public/theme.js", import.meta.url)),
				"text/javascript; charset=utf-8",
			);
		if (url.pathname === "/session.js")
			return send(
				200,
				await readFile(new URL("./session.js", import.meta.url)),
				"text/javascript; charset=utf-8",
			);
		if (url.pathname === "/uitnodiging" && req.method === "GET")
			return send(
				200,
				page(
					"Uitnodiging openen",
					"Je uitnodiging wordt geopend. Gebruik de volledige link die je begeleider heeft gedeeld.",
				),
			);
		if (["/login", "/register", "/aanmelden"].includes(url.pathname)) {
			if (identity)
				return send(
					200,
					page(
						url.pathname === "/register"
							? "Toegang tot Breinhap beheer"
							: "Aanmelden bij Breinhap beheer",
						'Deze proefversie is voor uitgenodigde volwassenen met een actief ASafariM-account. Je begeleider kent toegang toe. Nieuw bij ASafariM? Een platformbeheerder moet je verbindingsaanvraag eerst goedkeuren; daarmee krijg je nog geen Breinhap-toegang.</p><p><a class="action" href="/auth/start">Aanmelden met ASafariM</a>',
					),
				);

			return send(
				503,
				page(
					"Aanmelden binnenkort beschikbaar",
					"De beveiligde aanmelding wordt nog ingericht. Je kunt hier nog niet aanmelden of inhoud beheren.",
				),
				undefined,
				{ "Retry-After": "3600" },
			);
		}
		let access;
		try {
			access = await resolveAccess(req);
		} catch {
			return send(
				503,
				page(
					"Tijdelijk niet beschikbaar",
					"Je toegang kan nu niet worden gecontroleerd. Probeer later opnieuw.",
				),
			);
		}
		if (access === "anonymous")
			return send(303, "", undefined, { Location: "/login" });
		if (access !== "management")
			return send(
				403,
				page(
					"Geen toegang",
					"Dit is de beheeromgeving voor bevoegde begeleiders. Vraag een beheerder om toegang of ga naar Breinhap voor leerlingen.",
					undefined,
					req.managementSession,
				),
			);
		if (req.managementSession?.admin && url.pathname === "/")
			return send(
				200,
				page(
					"Overzicht",
					'Je beheerwerkplek is klaar. <a href="/beheer">Toegang beheren</a>',
					url.pathname,
					req.managementSession,
				),
			);
		const route = routes.get(url.pathname);
		if (!route)
			return send(
				404,
				page(
					"Pagina niet gevonden",
					'Ga terug naar het <a href="/">overzicht</a>.',
					null,
				),
			);
		return send(
			200,
			page(route[0], route[1], url.pathname, req.managementSession),
		);
	};
}

export function createManagementServer(options) {
	const handler = createHandler(options);
	const server = createServer((req, res) => {
		handler(req, res).catch((error) => {
			if (!res.headersSent)
				res.writeHead(error.status === 413 ? 413 : 503, {
					"Cache-Control": "no-store",
					"Content-Type": "text/html; charset=utf-8",
					"X-Content-Type-Options": "nosniff",
					"X-Frame-Options": "DENY",
					"Content-Security-Policy":
						"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
				});
			res.end(
				page(
					"Tijdelijk niet beschikbaar",
					"Je toegang kan nu niet worden gecontroleerd. Probeer later opnieuw.",
				),
			);
		});
	});
	server.requestTimeout = 10_000;
	server.headersTimeout = 10_000;
	server.maxHeadersCount = 50;
	return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	let identity;
	if (process.env.ASAFARIM_REGISTRY_CREDENTIAL && process.env.CORE_API_URL) {
		const platform = createPlatform({
			url: process.env.CORE_API_URL,
			credential: process.env.ASAFARIM_REGISTRY_CREDENTIAL,
		});
		try {
			await platform.register();
			const provider = await discoverProvider({
				issuer: "https://id.asafarim.site",
				clientId: "breinhap",
			});
			const store = await connectStore({
				url: process.env.REDIS_URL,
				secret: process.env.SESSION_ENCRYPTION_KEY,
				workspace: process.env.BREINHAP_WORKSPACE_ID ?? "pilot",
			});
			identity = createIdentity({ provider, grants: platform.grants, store });
			console.log("Management identity ready");
		} catch {
			console.error("Management identity unavailable; access remains closed");
		}
	}
	createManagementServer({ identity }).listen(8080, "0.0.0.0");
}
