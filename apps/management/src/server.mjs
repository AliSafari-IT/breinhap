import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createIdentity, discoverProvider } from "./identity.mjs";
import { createPlatform, manifest } from "./platform.mjs";

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
	return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — Breinhap beheer</title><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/styles.css"></head><body><a class="skip" href="#inhoud">Naar inhoud</a><header>Breinhap beheer</header>${nav}<main id="inhoud" tabindex="-1"><h1>${title}</h1><p>${content}</p>${account}<p><a href="https://breinhap.com/">Naar Breinhap voor leerlingen</a></p></main><footer>Breinhap beheer · ${manifest.version}</footer></body></html>`;
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
					"default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'self' https://id.asafarim.site; frame-ancestors 'none'",
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
						undefined,
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
		if (!["GET", "HEAD"].includes(req.method))
			return send(405, "Method not allowed", "text/plain; charset=utf-8", {
				Allow: "GET, HEAD",
			});
		if (url.pathname === "/readyz")
			return send(
				identity ? 200 : 503,
				identity ? "ready\n" : "identity unavailable\n",
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
		if (url.pathname === "/aanmelden") {
			if (identity)
				return send(
					200,
					page(
						"Aanmelden bij Breinhap beheer",
						'Gebruik je ASafariM-account. Beheertoegang wordt door een beheerder toegekend.</p><p><a class="action" href="/auth/start">Aanmelden met ASafariM</a>',
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
			return send(303, "", undefined, { Location: "/aanmelden" });
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
		handler(req, res).catch(() => {
			if (!res.headersSent) res.writeHead(500, { "Cache-Control": "no-store" });
			res.end();
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
			identity = createIdentity({ provider, grants: platform.grants });
			console.log("Management identity ready");
		} catch {
			console.error("Management identity unavailable; access remains closed");
		}
	}
	createManagementServer({ identity }).listen(8080, "0.0.0.0");
}
