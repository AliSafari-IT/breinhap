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
import { connectDatabase } from "./db.mjs";
import { Directory } from "./directory.mjs";
import {
	adminDirectoryAction,
	adminDirectoryPage,
	DIRECTORY_ERRORS,
	learnersPage,
} from "./directory-pages.mjs";
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
	["/leerlingen", ["Leerlingen", ""]],
]);
const DIRECTORY_PATHS = /^\/beheer\/(leerlingen|groepen|koppelingen|rechten)(\/|$)/;
const esc = (value) =>
	String(value).replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			],
	);
const roleChoices = [
	["breinhap.parent", "Ouder", "Je volgt je kind op."],
	["breinhap.tutor", "Begeleider", "Je begeleidt leerlingen buiten de klas."],
	["breinhap.teacher", "Leerkracht", "Je geeft les aan leerlingen."],
];
const roleName = Object.fromEntries(roleChoices);
const style = await readFile(new URL("./styles.css", import.meta.url));
const theme = await readFile(
	new URL("../../site/src/theme.css", import.meta.url),
);

function page(title, content, active, session) {
	const account = session
		? `<aside aria-label="Account"><p>Je rollen: ${session.roles.length ? session.roles.join(", ") : "nog geen"}</p><form method="post" action="/afmelden"><input type="hidden" name="csrf" value="${session.csrf}"><button type="submit">Afmelden</button></form></aside>`
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
	// breinhap#25: the workspace directory (Postgres); absent, its pages say they are not available yet
	directory,
} = {}) {
	const directoryUnavailable = (session) =>
		page(
			"Nog niet beschikbaar",
			"Leerlingen en groepen zijn nog niet ingericht op deze server. Probeer later opnieuw.",
			undefined,
			session,
		);
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
				"Referrer-Policy": "same-origin",
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
		if (identity && url.pathname === "/registreren") {
			if (!["GET", "HEAD", "POST"].includes(req.method))
				return send(405, "Method not allowed", "text/plain; charset=utf-8", {
					Allow: "GET, POST",
				});
			const result = await identity.roleRequest(req);
			const session = req.managementSession;
			if (result.anonymous)
				return send(303, "", undefined, { Location: "/register" });
			if (result.allowed) return send(303, "", undefined, { Location: "/" });
			if (result.student)
				return send(
					403,
					page(
						"Geen toegang",
						'Dit account is een leerlingaccount. Leerlingen gebruiken <a href="https://breinhap.com/">Breinhap voor leerlingen</a>.',
						undefined,
						session,
					),
				);
			if (result.refused)
				return send(
					403,
					page(
						"Aanvraag geweigerd",
						"Laad de pagina opnieuw en probeer nog eens.",
					),
				);
			if (result.invalid)
				return send(
					400,
					page(
						"Kies een rol",
						'Kies ouder, begeleider of leerkracht. <a href="/registreren">Terug</a>',
						undefined,
						session,
					),
				);
			if (result.busy)
				return send(
					429,
					page(
						"Probeer later opnieuw",
						"Er zijn nu te veel aanvragen. Probeer later opnieuw.",
						undefined,
						session,
					),
				);
			if (req.method === "POST")
				return send(303, "", undefined, { Location: "/registreren" });
			if (result.pending)
				return send(
					200,
					page(
						"Aanvraag verstuurd",
						`Je hebt gevraagd om toegang als <strong>${esc(roleName[result.pending.role] ?? "volwassene")}</strong>. Een beheerder van Breinhap bekijkt je aanvraag. Zodra die is goedgekeurd, kom je hier meteen in je werkplek.`,
						undefined,
						session,
					),
				);
			return send(
				200,
				page(
					"Kies je rol",
					`Je bent aangemeld. Wie ben je? Een beheerder van Breinhap keurt je rol goed; daarna kun je aan de slag.</p><form method="post" action="/registreren"><fieldset><legend>Ik ben</legend>${roleChoices
						.map(
							([key, label, hint], index) =>
								`<label><input type="radio" name="role" value="${key}" required${index === 0 ? " checked" : ""}> ${label} <small>${hint}</small></label>`,
						)
						.join(
							"",
						)}</fieldset><input type="hidden" name="csrf" value="${session.csrf}"><button type="submit">Aanvraag versturen</button></form><p>Ben je leerling? Je hebt hier geen account nodig: gebruik <a href="https://breinhap.com/">Breinhap voor leerlingen</a>.`,
					undefined,
					session,
				),
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
			const adminPrincipal = { sub: value.saved.sub, role: "breinhap.admin" };
			if (req.method === "GET" && url.pathname === "/beheer/leerlingen") {
				if (!directory) return send(503, directoryUnavailable(req.managementSession));
				return send(
					200,
					page(
						"Leerlingen en groepen",
						adminDirectoryPage(await directory.overview(adminPrincipal), value.saved.csrf),
						null,
						req.managementSession,
					),
				);
			}
			if (req.method === "GET" && url.pathname === "/beheer") {
				const requests = await identity.store.roleRequests();
				const pending = requests.length
					? `<h2>Aanvragen</h2><ul class="requests">${requests
							.map(
								(request) =>
									`<li><p>Accountcode <code>${esc(request.subject)}</code> vraagt toegang als <strong>${esc(roleName[request.role] ?? request.role)}</strong>.</p><form method="post" action="/beheer/goedkeuren"><input type="hidden" name="request" value="${esc(request.id)}"><input type="hidden" name="csrf" value="${value.saved.csrf}"><button>Goedkeuren</button></form><form method="post" action="/beheer/weigeren"><input type="hidden" name="request" value="${esc(request.id)}"><input type="hidden" name="csrf" value="${value.saved.csrf}"><button>Weigeren</button></form></li>`,
							)
							.join("")}</ul><p>`
					: "<h2>Aanvragen</h2><p>Er zijn geen open aanvragen.</p><p>";
				return send(
					200,
					page(
						"Toegang beheren",
						'Nieuwe volwassenen registreren zich zelf en kiezen een rol. Keur hun aanvraag hieronder goed. Leerlingen, groepen en koppelingen beheer je bij <a href="/beheer/leerlingen">Leerlingen en groepen</a>.</p>' +
							pending +
							'Je kunt ook een bestaand account rechtstreeks uitnodigen. Alleen bestaande actieve ASafariM-accounts met de juiste Breinhap-rol kunnen worden uitgenodigd.</p><form method="post" action="/beheer/uitnodigen"><label>ASafariM-accountcode <input name="subject" required maxlength="400"></label><label>Rol <select name="role"><option value="breinhap.parent">Ouder</option><option value="breinhap.tutor">Begeleider</option><option value="breinhap.teacher">Leerkracht</option></select></label><input type="hidden" name="csrf" value="' +
							value.saved.csrf +
							'"><button>Uitnodiging maken</button></form><form method="post" action="/beheer/intrekken"><label>Accountcode om toegang in te trekken <input name="subject" required maxlength="400"></label><input type="hidden" name="csrf" value="' +
							value.saved.csrf +
							'"><button>Toegang intrekken</button></form><p>',
						null,
						req.managementSession,
					),
				);
			}
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
			if (DIRECTORY_PATHS.test(url.pathname)) {
				if (!directory) return send(503, directoryUnavailable(req.managementSession));
				const result = await adminDirectoryAction(url.pathname, form, {
					directory,
					principal: adminPrincipal,
					store: identity.store,
				});
				if (!result) return send(404, "Niet gevonden");
				if (result.ok) return send(303, "", undefined, { Location: "/beheer/leerlingen" });
				return send(
					result.error === "invalid" ? 400 : 409,
					page(
						"Niet gewijzigd",
						`${DIRECTORY_ERRORS[result.error] ?? DIRECTORY_ERRORS.forbidden} <a href="/beheer/leerlingen">Terug</a>`,
						null,
						req.managementSession,
					),
				);
			}
			if (["/beheer/goedkeuren", "/beheer/weigeren"].includes(url.pathname)) {
				const id = form.get("request");
				if (
					form.getAll("request").length !== 1 ||
					!/^[A-Za-z0-9_-]{43}$/.test(id ?? "")
				)
					return send(400, "Ongeldige aanvraag.");
				const approve = url.pathname === "/beheer/goedkeuren";
				const done = approve
					? await identity.store.approveRequest(
							id,
							value.saved.sub,
							value.membership.version,
						)
					: await identity.store.rejectRequest(id);
				await identity.audit(
					approve ? "role.approved" : "role.rejected",
					value.saved.sub,
					id,
				);
				return send(
					done ? 303 : 409,
					done
						? ""
						: page(
								"Aanvraag niet verwerkt",
								'Deze aanvraag bestaat niet meer of je beheertoegang is gewijzigd. <a href="/beheer">Terug</a>',
								null,
								req.managementSession,
							),
					undefined,
					done ? { Location: "/beheer" } : {},
				);
			}
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
				// the adult's links and extra rights end with their membership (breinhap#25)
				if (directory) await directory.revokeAdult(adminPrincipal, subject);
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
					)) &&
					(!directory ||
						(await directory.pool.query("SELECT 1").then(
							() => true,
							() => false,
						)))
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
					url.pathname === "/register"
						? page(
								"Registreren bij Breinhap",
								'Voor ouders, begeleiders en leerkrachten. Zo werkt het:</p><ol><li>Maak een account aan of meld je aan. Breinhap gebruikt daarvoor het beveiligde ASafariM-account.</li><li>Kies of je ouder, begeleider of leerkracht bent.</li><li>Een beheerder van Breinhap keurt je rol goed. Daarna kun je aan de slag.</li></ol><p><a class="action" href="/auth/start">Registreren</a></p><p>Heb je al een account? <a href="/login">Aanmelden</a>. Ben je leerling? Je hebt geen account nodig: gebruik <a href="https://breinhap.com/">Breinhap voor leerlingen</a>.',
							)
						: page(
								"Aanmelden bij Breinhap beheer",
								'Voor ouders, begeleiders en leerkrachten. Je meldt je aan met je ASafariM-account.</p><p><a class="action" href="/auth/start">Aanmelden met ASafariM</a></p><p>Nog geen account? <a href="/register">Registreren</a>',
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
		if (access !== "management" && req.managementSession?.canRequest)
			return send(303, "", undefined, { Location: "/registreren" });
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
		if (url.pathname === "/leerlingen") {
			if (!directory) return send(503, directoryUnavailable(req.managementSession));
			const principal = await identity?.principal(req);
			if (!principal)
				return send(403, page("Geen toegang", "Je hebt geen toegang tot deze pagina."));
			const [learners, groups] = await Promise.all([
				directory.learners(principal),
				directory.groups(principal),
			]);
			return send(
				200,
				page("Leerlingen", learnersPage(learners, groups), url.pathname, req.managementSession),
			);
		}
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
	// breinhap#25: optional until the operator installs the database; without it those pages say so
	let directory;
	if (identity && process.env.DATABASE_URL) {
		try {
			const pool = await connectDatabase(process.env.DATABASE_URL);
			directory = await new Directory({
				pool,
				workspace: process.env.BREINHAP_WORKSPACE_ID ?? "pilot",
			}).ready();
			console.log("Management directory ready");
		} catch {
			console.error("Management directory unavailable; learner pages stay closed");
			directory = undefined;
		}
	}
	createManagementServer({ identity, directory }).listen(8080, "0.0.0.0");
}
