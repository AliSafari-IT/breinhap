import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

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

function page(title, content, active) {
	const nav =
		active === undefined
			? ""
			: `<nav aria-label="Beheernavigatie">${[...routes].map(([path, [label]]) => `<a href="${path}"${active === path ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</nav>`;
	return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — Breinhap beheer</title><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/styles.css"></head><body><a class="skip" href="#inhoud">Naar inhoud</a><header>Breinhap beheer</header>${nav}<main id="inhoud" tabindex="-1"><h1>${title}</h1><p>${content}</p><p><a href="https://breinhap.com/">Naar Breinhap voor leerlingen</a></p></main></body></html>`;
}

// Identity is deliberately unconfigured until #24 supplies a server-side session resolver.
// Never derive access from cookies, query parameters, forwarded headers or caller-supplied roles.
export function createHandler({
	resolveAccess = async () => "anonymous",
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
					"default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
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
		if (!["GET", "HEAD"].includes(req.method))
			return send(405, "Method not allowed", "text/plain; charset=utf-8", {
				Allow: "GET, HEAD",
			});
		const url = new URL(req.url, origin);
		if (url.origin !== origin)
			return send(421, "Misdirected request", "text/plain; charset=utf-8");
		if (url.pathname === "/healthz")
			return send(200, "ok\n", "text/plain; charset=utf-8");
		if (url.pathname === "/styles.css")
			return send(200, style, "text/css; charset=utf-8");
		if (url.pathname === "/theme.css")
			return send(200, theme, "text/css; charset=utf-8");
		if (url.pathname === "/aanmelden") {
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
					"Dit is de beheeromgeving voor bevoegde begeleiders. Ga naar Breinhap voor leerlingen.",
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
		return send(200, page(route[0], route[1], url.pathname));
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
	createManagementServer().listen(8080, "0.0.0.0");
}
