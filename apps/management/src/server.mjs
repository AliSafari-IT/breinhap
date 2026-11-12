import { tr, ui, uiLocale, formatLocale, withLocale } from "./workspace-i18n.mjs";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
	createIdentity,
	discoverProvider,
	safeNext,
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
import { langCookie, localeOf, T, languageSelector } from "./account/i18n.mjs";
import { header, managementFooter, websiteHome } from "./header.mjs";
import { emailPage, fallbackPage, pendingPage, profilePage, rejectedPage, decisionNotice } from "./account/pages.mjs";
import { ContentStore } from "./content.mjs";
import { createHeadlessAuth } from "./vendor/asafarim-headless.mjs";
import { handleExtractions } from "./extract/routes.mjs";
import { ExtractionStore } from "./extract/store.mjs";
import { handleImports } from "./imports/routes.mjs";
import { ImportStore } from "./imports/store.mjs";
import { handleLibrary } from "./library-routes.mjs";
import { PublishingStore } from "./publishing.mjs";
import { AssignmentStore } from "./assignments.mjs";
import { PracticeStore } from "./practice/store.mjs";
import { PackAuthoring } from "./practice/authoring.mjs";
import { PracticeLearner } from "./practice/learner.mjs";
import { createLearnerHandler, PUBLIC_HOST } from "./learner-server.mjs";
import { createClamav } from "./uploads/clamav.mjs";
import { handleUploads } from "./uploads/routes.mjs";
import { S3Client } from "./uploads/s3.mjs";
import { UploadStore } from "./uploads/store.mjs";
import { createPlatform, managementAccess, manifest } from "./platform.mjs";
import { connectStore } from "./store.mjs";

const origin = "https://management.breinhap.com";
const routes = () => new Map([
	[
		"/",
		[
			tr("Overzicht"),
			ui`Je beheerwerkplek is klaar. Maak en bewerk leerobjecten in de <a href="/bibliotheek">bibliotheek</a>.`,
		],
	],
	[
		"/bibliotheek",
		[tr("Bibliotheek"), tr("Er is nog geen inhoudsbibliotheek beschikbaar.")],
	],
	["/leerlingen", [tr("Leerlingen"), ""]],
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
const roleName = { ...Object.fromEntries(roleChoices), "breinhap.admin": "Beheerder" };
const style = await readFile(new URL("./styles.css", import.meta.url));
const theme = await readFile(
	new URL("../../site/src/theme.css", import.meta.url),
);

const assets = new Map(await Promise.all([
	["/styles.css", "./styles.css", "text/css"],
	["/theme.css", "../../site/src/theme.css", "text/css"],
	["/theme.js", "../../site/public/theme.js", "text/javascript"],
	["/editor.js", "./editor.js", "text/javascript"],
	["/session.js", "./session.js", "text/javascript"],
	["/locale-selector.js", "../../site/public/locale-selector.js", "text/javascript"],
	["/locale-selector.css", "../../site/public/locale-selector.css", "text/css"],
].map(async ([path, file, type]) => {
	const body = path === "/styles.css" ? style : path === "/theme.css" ? theme : await readFile(new URL(file, import.meta.url));
	return [path, { body, type: `${type}; charset=utf-8`, etag: `"${createHash("sha256").update(body).digest("base64url")}"` }];
})));

function documentPage(title, content, active, session, pathname = active, search = "") {
	const account = session
		? ui`<details class="management-account"><summary>Account</summary><div class="account-panel">${session.email ? ui`<p class="account-email">${esc(session.email)}</p>` : ""}<p>Je rollen: ${esc(session.roles.length ? session.roles.map((role) => tr(role)).join(", ") : tr("nog geen"))}</p>${session.admin ? ui`<a href="/beheer/leerlingen">Leerlingen en groepen</a>` : ""}<form method="post" action="/afmelden"><input type="hidden" name="csrf" value="${esc(session.csrf)}"><button type="submit">Afmelden</button></form><a href="/login?switch=1">Wissel van account</a></div></details>`
		: "";
	const links = [...routes()].map(([path, [label]]) => [path, label]);
	if (session?.admin) links.push(["/beheer", tr("Toegang beheren")]);
	const nav = active !== undefined || session?.roles?.length
		? ui`<nav class="management-nav" aria-label="Beheernavigatie">${links.map(([path, label]) => ui`<a href="${esc(path)}"${pathname === path || (path !== "/" && pathname?.startsWith(`${path}/`)) ? ' aria-current="page"' : ""}>${esc(tr(label))}</a>`).join("")}</nav>`
		: "";
	return ui`<!doctype html><html lang="${uiLocale()}" data-saving="${esc(tr("Bezig met opslaan…"))}" data-access-unavailable="${esc(tr("Je toegang kan nu niet worden gecontroleerd. Vernieuw de pagina om opnieuw te proberen."))}" data-connection-lost="${esc(tr("Verbinding verbroken. Vernieuw de pagina om je toegang opnieuw te controleren."))}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} — Breinhap beheer</title><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/locale-selector.css"><script src="/locale-selector.js" defer></script><script src="/theme.js"></script><script src="/session.js" defer></script><script src="/editor.js" defer></script></head><body class="management-body"><a class="skip" href="#inhoud">Naar inhoud</a>${header({ lang: uiLocale(), name: tr("Breinhap beheer"), href: "/", navigation: nav, tools: ui`<a class="web-link" href="${websiteHome(uiLocale())}">Breinhap web</a>${languageSelector(uiLocale(), pathname ?? "/", search)}${account}` })}<main id="inhoud" tabindex="-1" class="management-main"><h1>${esc(title)}</h1><div class="page-content">${content}</div></main>${managementFooter(esc(manifest.version))}</body></html>`;
}

// The resolver and identity adapter are server-only; no request header grants a role.
export function createHandler({
	identity,
	resolveAccess = identity?.access ?? (async () => "anonymous"),
	// breinhap#25: the workspace directory (Postgres); absent, its pages say they are not available yet
	directory,
	// breinhap#27: the content library, on the same database
	content = directory ? new ContentStore({ directory }) : undefined,
	// breinhap#33: publishing immutable reviewed packs, on the same content store
	publishing = content ? new PublishingStore({ content }) : undefined,
	// breinhap#34: assigning active publications to linked learners and groups
	assignments = directory && identity?.store
		? new AssignmentStore({ directory, membership: (sub) => identity.store.membership(sub) })
		: undefined,
	// breinhap#80: the practice storage, shared by pack authoring (#80/#81) and the public learner (#82)
	practiceStore = directory && content
		? new PracticeStore({
				directory,
				publishedContent: publishing,
				// the owner must still be an active parent/tutor/teacher on the membership version the link was minted on
				ownerEligibility: identity?.store
					? {
							checkForPractice: async ({ ownerSub, membershipVersion }) => {
								const member = await identity.store.membership(ownerSub);
								return member?.active &&
									member.version === membershipVersion &&
									["breinhap.parent", "breinhap.tutor", "breinhap.teacher"].includes(member.role)
									? "eligible"
									: "denied";
							},
						}
					: undefined,
			})
		: undefined,
	practice = practiceStore && content ? new PackAuthoring({ practice: practiceStore, content }) : undefined,
	// breinhap#82: the isolated public learner player (breinhap.com/p); only dispatched for that exact Host
	learner = practiceStore ? new PracticeLearner(practiceStore) : undefined,
	// breinhap#30: imports, on the same content store
	imports = content ? new ImportStore({ content }) : undefined,
	// breinhap#29: uploads (private object store + virus scanner); absent, the page says it is not set up
	uploads,
	// breinhap#31: text extraction from uploaded PDF/DOCX files, on the uploads' storage
	extractions,
} = {}) {
	const learnerHandle = learner ? createLearnerHandler({ learner }) : undefined;
	const handle = async (req, res) => {
		const send = (
			status,
			body,
			type = "text/html; charset=utf-8",
			extra = {},
		) => {
			let languageChoice;
			try { languageChoice = new URL(req.url, origin).searchParams.get("lang"); } catch { /* Reject invalid request targets below. */ }
			if (["nl", "fr", "en", "de"].includes(languageChoice) && (type.startsWith("text/html") || status === 303)) {
				const cookies = [extra["Set-Cookie"] ?? []].flat();
				extra = { ...extra, "Set-Cookie": [...cookies.filter((value) => !value.startsWith("breinhap-lang=")), langCookie(extra["Content-Language"] ?? uiLocale(), req.headers.host)] };
			}
			res.writeHead(status, {
				"Content-Type": type,
				...(type.startsWith("text/html") ? { "Content-Language": uiLocale() } : {}),
				"Cache-Control": "no-store",
				"Content-Security-Policy":
					"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self' https://id.asafarim.site; frame-ancestors 'none'",
				"X-Content-Type-Options": "nosniff",
				"Referrer-Policy": "same-origin",
				"X-Frame-Options": "DENY",
				"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
				...extra,
			});
			res.end(req.method === "HEAD" ? undefined : body);
		};
		// breinhap#82: the public learner Host is served by its own handler, before any identity or session
		// code, and nothing else is served on it. Without practice storage the Host stays misdirected (421).
		if (req.headers.host === PUBLIC_HOST && learnerHandle) return learnerHandle(req, res);
		// Match the real request Host, never X-Forwarded-Host; only origin-form targets are accepted.
		if (
			req.headers.host !== "management.breinhap.com" ||
			!req.url?.startsWith("/") ||
			req.url.startsWith("//")
		) {
			return send(421, tr("Misdirected request"), "text/plain; charset=utf-8");
		}
		const url = new URL(req.url, origin);
		// the learner paths exist on the public Host only; the management Host never serves them
		if (url.pathname === "/p" || url.pathname.startsWith("/p/")) return send(404, "Not found", "text/plain; charset=utf-8");
		const page = (title, content, active, session) => documentPage(title, content, active, session, url.pathname, url.search);
		const directoryUnavailable = (session) =>
			page(
				tr("Nog niet beschikbaar"),
				tr("Leerlingen en groepen zijn nog niet ingericht op deze server. Probeer later opnieuw."),
				undefined,
				session,
			);

		if (url.origin !== origin)
			return send(421, tr("Misdirected request"), "text/plain; charset=utf-8");
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
			} catch (error) {
				if (error.status === 413) return send(413, tr("Aanvraag te groot."));
				return send(
					503,
					page(
						tr("Tijdelijk niet beschikbaar"),
						tr("Aanmelden is tijdelijk niet beschikbaar. Probeer later opnieuw."),
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
							tr("Uitnodiging accepteren"),
							result.body.replace(/<h1>.*?<\/h1>/, ""),
							undefined,
							req.managementSession,
						)
					: result.body,
				undefined,
				result.headers,
			);
		}
		if (identity && ["/registreren", "/registreren/intrekken"].includes(url.pathname)) {
			if (url.pathname === "/registreren/intrekken" && req.method !== "POST")
				return send(405, tr("Method not allowed"), "text/plain; charset=utf-8", { Allow: "POST" });
			if (!["GET", "HEAD", "POST"].includes(req.method))
				return send(405, tr("Method not allowed"), "text/plain; charset=utf-8", {
					Allow: "GET, POST",
				});
			// breinhap#signup: the profile form completes a registration (who they are, which role); the
			// administrator then approves it. In the person's language (nl, fr, en, de).
			const lang = localeOf(req, url);
			const result = await identity.roleRequest(req);
			const session = req.managementSession;
			if (result.anonymous)
				return send(303, "", undefined, { Location: "/register" });
			if (result.allowed) return send(303, "", undefined, { Location: "/" });
			if (result.student)
				return send(
					403,
					page(
						tr("Geen toegang"),
						ui`Dit account is een leerlingaccount. Leerlingen gebruiken <a href="https://breinhap.com/">Breinhap voor leerlingen</a>.`,
						undefined,
						session,
					),
				);
			if (result.refused)
				return send(403, page(tr("Aanvraag geweigerd"), tr("Laad de pagina opnieuw en probeer nog eens.")));
			if (result.invalid)
				return send(400, profilePage(lang, { csrf: session.csrf, email: session.email, editing: result.values?.editing, values: result.values ?? {}, errorCode: result.invalid, version: manifest.version }));
			if (result.busy)
				return send(
					429,
					page(
						tr("Probeer later opnieuw"),
						tr("Er zijn nu te veel aanvragen. Probeer later opnieuw."),
						undefined,
						session,
					),
				);
			if (req.method === "POST")
				return send(303, "", undefined, { Location: result.cancelled ? "/registreren?ingetrokken=1" : "/registreren" });
			const langHeader = url.searchParams.has("lang") ? { "Set-Cookie": langCookie(lang, req.headers.host) } : {};
			if (result.pending && url.searchParams.get("aanpassen") !== "1")
				return send(200, pendingPage(lang, { csrf: session.csrf, email: session.email, request: result.pending, checked: url.searchParams.get("gecontroleerd") === "1", version: manifest.version }), undefined, langHeader);
			if (!result.pending && result.rejected && url.searchParams.get("opnieuw") !== "1")
				return send(200, rejectedPage(lang, { csrf: session.csrf, email: session.email, version: manifest.version }), undefined, langHeader);
			return send(200, profilePage(lang, { csrf: session.csrf, email: session.email, editing: !!result.pending, retry: url.searchParams.get("opnieuw") === "1", values: result.pending ? { ...result.pending.profile, role: result.pending.role, consent: !!result.pending.consent } : {}, cancelled: url.searchParams.get("ingetrokken") === "1", version: manifest.version }), undefined, langHeader);
		}
		if (identity && url.pathname.startsWith("/beheer")) {
			// Anonymous visitors use the same sign-in path as every other private route.
			if (!(await identity.current(req, false).catch(() => null)))
				return send(303, "", undefined, { Location: `/login?next=${encodeURIComponent(url.pathname + url.search)}` });
			const check = await (["GET", "HEAD"].includes(req.method) ? identity.administrator(req) : identity.privileged(req, DIRECTORY_PATHS.test(url.pathname) ? "/beheer/leerlingen" : "/beheer"));
			if (check.response)
				return send(
					check.response.status,
					page(tr("Bevestig je toegang"), check.response.body),
				);
			const { value } = check;
			const notice = req.managementSession.fresh ? "" : ui`<p class="notice" role="status">Bevestig opnieuw je identiteit om wijzigingen te maken. <a href="${esc(identity.stepUpLink(url.pathname + url.search))}">Opnieuw aanmelden</a></p>`;
			const adminPrincipal = { sub: value.saved.sub, role: "breinhap.admin" };
			if (req.method === "GET" && url.pathname === "/beheer/leerlingen") {
				if (!directory) return send(200, directoryUnavailable(req.managementSession));
				return send(
					200,
					page(
						tr("Leerlingen en groepen"),
						notice + adminDirectoryPage(await directory.overview(adminPrincipal), value.saved.csrf, await identity.store.members()),
						null,
						req.managementSession,
					),
				);
			}
			if (req.method === "GET" && url.pathname === "/beheer") {
				const csrf = value.saved.csrf;
				const decision = await identity.store.readFlow(`decision:${value.id}`);
				const decisionFeedback = decision?.email ? decisionNotice(localeOf(req, url), decision) : "";
				const hiddenCsrf = ui`<input type="hidden" name="csrf" value="${csrf}">`;
				const requests = await identity.store.roleRequests();
				const members = await identity.store.members();
				const when = (at) => new Date(at).toLocaleDateString(formatLocale(), { timeZone: "Europe/Brussels" });
				const person = (p = {}) =>
					ui`<strong>${esc([p.firstName, p.lastName].filter(Boolean).join(" ") || tr("(naam niet ingevuld)"))}</strong>${p.email ? ui`<br><a href="mailto:${esc(p.email)}">${esc(p.email)}</a>` : ""}`;
				const pending = requests.length
					? ui`<table class="library people"><thead><tr><th scope="col">Wie</th><th scope="col">Vraagt als</th><th scope="col">School of organisatie</th><th scope="col">Toelichting</th><th scope="col">Sinds</th><th scope="col"><span class="visually-hidden">Beslissing</span></th></tr></thead><tbody>${requests
							.map(
								(r) =>
									ui`<tr><td>${person(r.profile)}</td><td>${esc(tr(roleName[r.role] ?? r.role))}</td><td>${esc(r.profile?.organisation ?? "")}</td><td>${esc(r.profile?.note ?? "")}</td><td>${when(r.at)}</td><td class="actions"><form method="post" action="/beheer/goedkeuren"><input type="hidden" name="request" value="${esc(r.id)}">${hiddenCsrf}<button>Goedkeuren</button></form><form method="post" action="/beheer/weigeren"><input type="hidden" name="request" value="${esc(r.id)}">${hiddenCsrf}<button class="secondary">Weigeren</button></form></td></tr>`,
							)
							.join("")}</tbody></table>`
					: ui`<p>Er zijn geen open aanvragen.</p>`;
				const people = members.length
					? ui`<table class="library people"><thead><tr><th scope="col">Wie</th><th scope="col">Rol</th><th scope="col">School of organisatie</th><th scope="col"><span class="visually-hidden">Acties</span></th></tr></thead><tbody>${members
							.map(
								(m) =>
									ui`<tr><td>${person(m.profile)}${m.subject === value.saved.sub ? ui` <small>(jij)</small>` : ""}</td><td>${esc(tr(roleName[m.role] ?? m.role))}</td><td>${esc(m.profile?.organisation ?? "")}</td><td class="actions">${
										m.subject === value.saved.sub || m.role === "breinhap.admin"
											? ""
											: ui`<form method="post" action="/beheer/intrekken"><input type="hidden" name="subject" value="${esc(m.subject)}">${hiddenCsrf}<button class="secondary">Toegang intrekken</button></form>`
									}</td></tr>`,
							)
							.join("")}</tbody></table>`
					: ui`<p>Nog geen leden.</p>`;
				return send(
					200,
					page(
						tr("Toegang beheren"),
						ui`${notice}${decisionFeedback}Nieuwe ouders, begeleiders en leerkrachten maken zelf een account aan op <a href="/register">management.breinhap.com/register</a> en vullen daar hun gegevens en gewenste rol in. Hun aanvraag verschijnt hieronder; keur ze goed of weiger ze. Leerlingen, groepen en koppelingen beheer je bij <a href="/beheer/leerlingen">Leerlingen en groepen</a>.</p><h2>Aanvragen${requests.length ? ` (${requests.length})` : ""}</h2>${pending}<h2>Leden</h2>${people}<p>`,
						null,
						req.managementSession,
					),
				);
			}
			if (req.method !== "POST")
				return send(405, tr("Method not allowed"), "text/plain; charset=utf-8", {
					Allow: "GET, POST",
				});
			const form = await readForm(req);
			if (
				req.headers.origin !== ORIGIN ||
				form.getAll("csrf").length !== 1 ||
				form.get("csrf") !== value.saved.csrf
			)
				return send(403, tr("Aanvraag geweigerd."));
			if (DIRECTORY_PATHS.test(url.pathname)) {
				if (!directory) return send(200, directoryUnavailable(req.managementSession));
				const result = await adminDirectoryAction(url.pathname, form, {
					directory,
					principal: adminPrincipal,
					store: identity.store,
				});
				if (!result) return send(404, tr("Niet gevonden"));
				if (result.ok) return send(303, "", undefined, { Location: "/beheer/leerlingen" });
				return send(
					result.error === "invalid" ? 400 : 409,
					page(
						tr("Niet gewijzigd"),
						ui`${esc(DIRECTORY_ERRORS()[result.error] ?? DIRECTORY_ERRORS().forbidden)} <a href="/beheer/leerlingen">Terug</a>`,
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
					return send(400, tr("Ongeldige aanvraag."));
				const approve = url.pathname === "/beheer/goedkeuren";
				const requestKey = identity.store.requestKeys(id)[1];
				const raw = await identity.store.client.get(requestKey);
				const request = identity.store.decode(requestKey, raw);
				const done = approve
					? await identity.store.approveRequest(
							id,
							value.saved.sub,
							value.membership.version,
							raw,
						)
					: await identity.store.rejectRequest(id, raw);
				if (done) {
					const key = `decision:${value.id}`;
					await identity.store.takeFlow(key);
					if (request?.profile?.email)
						await identity.store.putFlow(key, { email: request.profile.email, approved: approve });
				}
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
								tr("Aanvraag niet verwerkt"),
								ui`Deze aanvraag bestaat niet meer of je beheertoegang is gewijzigd. <a href="/beheer">Terug</a>`,
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
					tr("Ongeldige accountcode; je eigen toegang kan hier niet worden gewijzigd."),
				);
			if (url.pathname === "/beheer/intrekken") {
				await identity.audit("membership.revoke", value.saved.sub, subject);
				await identity.store.revokeMember(subject);
				// the adult's links and extra rights end with their membership (breinhap#25)
				if (directory) await directory.revokeAdult(adminPrincipal, subject);
				return send(
					200,
					page(
						tr("Toegang ingetrokken"),
						tr("Deze accountcode heeft geen toegang meer tot deze werkplek."),
						null,
						req.managementSession,
					),
				);
			}
			if (url.pathname !== "/beheer/uitnodigen")
				return send(404, tr("Niet gevonden"));
			const role = form.get("role");
			if (
				form.getAll("role").length !== 1 ||
				!["breinhap.parent", "breinhap.tutor", "breinhap.teacher"].includes(
					role,
				)
			)
				return send(400, tr("Ongeldige rol."));
			const target = managementAccess(await identity.grants(subject), subject);
			if (
				target.access !== "management" ||
				!target.roleKeys.includes(role) ||
				(await identity.store.membership(subject))
			)
				return send(
					409,
					page(
						tr("Uitnodiging niet gemaakt"),
						tr("Dit account moet actief zijn, de gekozen ASafariM-rol hebben en nog geen lid van deze werkplek zijn."),
					),
				);
			const token = randomBytes(32).toString("base64url");
			await identity.audit("invitation.create", value.saved.sub, subject);
			const created = await identity.store.invite(token, {
				subject,
				role,
				inviter: value.saved.sub,
				inviterVersion: value.membership.version,
			});
			if (!created)
				return send(409, tr("Je beheertoegang is gewijzigd. Probeer opnieuw."));
			return send(
				200,
				page(
					tr("Uitnodiging gemaakt"),
					ui`Deze link is één dag geldig en werkt alleen voor het bedoelde account. Deel de link zelf met de ontvanger.</p><label>Uitnodigingslink <input readonly value="https://management.breinhap.com/uitnodiging#${token}"></label><p>`,
					null,
					req.managementSession,
				),
			);
		}
		// breinhap#27: the content library (its forms POST, so it comes before the GET-only routes)
		if (
			identity &&
			(url.pathname === "/bibliotheek" || url.pathname.startsWith("/bibliotheek/"))
		) {
			let access;
			try {
				access = await resolveAccess(req);
			} catch {
				return send(
					503,
					page(
						tr("Tijdelijk niet beschikbaar"),
						tr("Je toegang kan nu niet worden gecontroleerd. Probeer later opnieuw. Wat je typte, is niet opgeslagen."),
					),
				);
			}
			if (access === "anonymous")
				return send(303, "", undefined, { Location: "/login" });
			// signed in, not a member yet: the same way in as every other page
			if (access !== "management" && req.managementSession?.canRequest)
				return send(303, "", undefined, { Location: "/registreren" });
			if (access !== "management")
				return send(
					403,
					page(
						tr("Geen toegang"),
						tr("Dit is de beheeromgeving voor bevoegde begeleiders."),
						undefined,
						req.managementSession,
					),
				);
			// uploads read their own (multipart) bodies, so they come before the library's form reader
			const result =
				(await handleUploads(req, url, { identity, uploads, extractions })) ??
				(await handleImports(req, url, { identity, imports })) ??
				(await handleExtractions(req, url, { identity, extractions })) ??
				(await handleLibrary(req, url, { identity, content, publishing, assignments, practice, extractions }));
			if (result.raw) return send(result.status, result.body, result.type, result.headers);
			if (result.status === 303)
				return send(303, "", undefined, result.headers);
			return send(
				result.status,
				withLocale(result.locale ?? uiLocale(), () => page(result.title, result.body, result.active ?? null, req.managementSession)),
				undefined,
				result.headers ?? {},
			);
		}
		if (!["GET", "HEAD"].includes(req.method))
			return send(405, tr("Method not allowed"), "text/plain; charset=utf-8", {
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
		const asset = assets.get(url.pathname);
		if (asset) {
			const headers = { "Cache-Control": "public, max-age=0, must-revalidate", ETag: asset.etag };
			const unchanged = req.headers["if-none-match"] === asset.etag;
			return send(unchanged ? 304 : 200, unchanged ? "" : asset.body, asset.type, headers);
		}
		if (url.pathname === "/logo.svg")
			return send(
				200,
				await readFile(new URL("../../site/public/logo.svg", import.meta.url)),
				"image/svg+xml",
				{ "Cache-Control": "public, max-age=86400" },
			);
		if (url.pathname === "/uitnodiging" && req.method === "GET")
			return send(
				200,
				page(
					tr("Uitnodiging openen"),
					tr("Je uitnodiging wordt geopend. Gebruik de volledige link die je begeleider heeft gedeeld."),
				),
			);
		if (["/login", "/register", "/aanmelden"].includes(url.pathname)) {
			const stepUp = url.pathname === "/login" && (url.searchParams.get("opnieuw") === "1" || url.searchParams.get("fresh") === "1");
			const switching = url.pathname === "/login" && url.searchParams.get("switch") === "1";
			const signedIn = identity ? await identity.current(req, false).catch(() => null) : null;
			if (signedIn && !stepUp && !switching) return send(303, "", undefined, { Location: "/" });
			// breinhap#signup: Breinhap's own pages; ASafariM only sends the e-mail code.
			if (identity?.headless) {
				const lang = localeOf(req, url);
				const notice = stepUp
					? ui`<p class="notice" role="status">${T[lang].stepUpNotice}</p>`
					: url.searchParams.has("verlopen")
					? ui`<p class="notice" role="status">${T[lang].errors.flow}</p>`
					: "";
				return send(
					200,
					emailPage(lang, { register: url.pathname === "/register", version: manifest.version, notice, email: stepUp ? signedIn?.saved.email ?? "" : "", stepUp, switching, next: stepUp ? safeNext(url.searchParams.get("next")) : null }),
					undefined,
					url.searchParams.has("lang") ? { "Set-Cookie": langCookie(lang, req.headers.host) } : {},
				);
			}
			if (identity) {
				const lang = localeOf(req, url);
				return send(
					200,
					fallbackPage(lang, { register: url.pathname === "/register", version: manifest.version }),
					undefined,
					url.searchParams.has("lang") ? { "Set-Cookie": langCookie(lang, req.headers.host) } : {},
				);
			}

			return send(
				503,
				page(
					tr("Aanmelden binnenkort beschikbaar"),
					tr("De beveiligde aanmelding wordt nog ingericht. Je kunt hier nog niet aanmelden of inhoud beheren."),
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
					tr("Tijdelijk niet beschikbaar"),
					tr("Je toegang kan nu niet worden gecontroleerd. Probeer later opnieuw."),
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
					tr("Geen toegang"),
					tr("Dit is de beheeromgeving voor bevoegde begeleiders. Vraag een beheerder om toegang of ga naar Breinhap voor leerlingen."),
					undefined,
					req.managementSession,
				),
			);
		if (req.managementSession?.admin && url.pathname === "/") {
			// administrators see waiting role requests first: nobody else is told about them
			const waiting = identity ? (await identity.store.roleRequests()).length : 0;
			return send(
				200,
				page(
					tr("Overzicht"),
					waiting
						? ui`<strong>${waiting} ${waiting === 1 ? tr("aanvraag wacht") : tr("aanvragen wachten")} op jouw goedkeuring.</strong> <a href="/beheer">Aanvragen bekijken in Toegang beheren</a>`
						: ui`Je beheerwerkplek is klaar. Er wachten geen aanvragen. <a href="/beheer">Toegang beheren</a>`,
					url.pathname,
					req.managementSession,
				),
			);
		}
		if (url.pathname === "/leerlingen") {
			if (!directory) return send(200, directoryUnavailable(req.managementSession));
			const principal = await identity?.principal(req);
			if (!principal)
				return send(403, page(tr("Geen toegang"), tr("Je hebt geen toegang tot deze pagina.")));
			const [learners, groups] = await Promise.all([
				directory.learners(principal),
				directory.groups(principal),
			]);
			return send(
				200,
				page(tr("Leerlingen"), learnersPage(learners, groups), url.pathname, req.managementSession),
			);
		}
		const route = routes().get(url.pathname);
		if (!route)
			return send(
				404,
				page(
					tr("Pagina niet gevonden"),
					ui`Ga terug naar het <a href="/">overzicht</a>.`,
					null,
				),
			);
		return send(
			200,
			page(route[0], route[1], url.pathname, req.managementSession),
		);
	};
	return (req, res) => {
		let url;
		try { url = new URL(req.url, origin); } catch { /* The handler rejects malformed requests. */ }
		return withLocale(localeOf(req, url), () => handle(req, res));
	};
}

export function createManagementServer(options) {
	const handler = createHandler(options);
	const server = createServer((req, res) => {
		handler(req, res).catch((error) => withLocale(localeOf(req, new URL(req.url, origin)), () => {
			if (!res.headersSent)
				res.writeHead(error.status === 413 ? 413 : 503, {
					"Cache-Control": "no-store",
					"Content-Type": "text/html; charset=utf-8",
					"Content-Language": uiLocale(),
					"X-Content-Type-Options": "nosniff",
					"X-Frame-Options": "DENY",
					"Content-Security-Policy":
						"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
				});
			res.end(
				documentPage(
					tr("Tijdelijk niet beschikbaar"),
					tr("Je toegang kan nu niet worden gecontroleerd. Probeer later opnieuw."),
				),
			);
		}));
	});
	// long enough for one upload on a slow connection (breinhap#29); headers still have to arrive quickly
	server.requestTimeout = 120_000;
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
			// breinhap#signup: with its client secret, Breinhap shows its own sign-in pages (e-mail codes)
			const headless = process.env.ASAFARIM_HEADLESS_SECRET
				? createHeadlessAuth({
						issuer: "https://id.asafarim.site",
						clientId: "breinhap",
						clientSecret: process.env.ASAFARIM_HEADLESS_SECRET,
					})
				: undefined;
			identity = createIdentity({ provider, grants: platform.grants, store, headless, version: manifest.version });
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
	// breinhap#29: uploads need the database, the private bucket, the scanner and a link secret
	let uploads;
	let extractions;
	const env = process.env;
	if (directory && env.UPLOADS_S3_ENDPOINT && env.CLAMAV_HOST && env.UPLOADS_LINK_SECRET) {
		try {
			const storage = new S3Client({
				endpoint: env.UPLOADS_S3_ENDPOINT,
				bucket: env.UPLOADS_S3_BUCKET ?? "breinhap-uploads",
				accessKeyId: env.UPLOADS_S3_ACCESS_KEY_ID,
				secretAccessKey: env.UPLOADS_S3_SECRET_ACCESS_KEY,
			});
			if (!(await storage.ready())) throw new Error("bucket");
			uploads = new UploadStore({
				directory,
				storage,
				scanner: createClamav({ host: env.CLAMAV_HOST, port: Number(env.CLAMAV_PORT ?? 3310) }),
				linkSecret: env.UPLOADS_LINK_SECRET,
				log: (event, detail) => console.log(JSON.stringify({ event, ...detail })),
			});
			// files left in quarantine while the scanner was down are scanned again every minute
			setInterval(() => {
				uploads.scanPending().catch(() => console.error("Upload rescan failed; will retry"));
			}, 60_000).unref();
			console.log("Management uploads ready");
			// breinhap#31: one extraction at a time in this process; queued jobs and jobs whose worker
			// died (lapsed lease) are picked up every few seconds, and stale extractions are removed hourly
			extractions = new ExtractionStore({ uploads, log: (event) => console.log(JSON.stringify({ event })) });
			setInterval(() => extractions.kick(), 5_000).unref();
			setInterval(() => {
				extractions.cleanup().catch(() => console.error("Extraction cleanup failed; will retry"));
			}, 3_600_000).unref();
			extractions.kick();
		} catch {
			console.error("Management uploads unavailable; the upload page stays closed");
			uploads = undefined;
			extractions = undefined;
		}
	}
	createManagementServer({ identity, directory, uploads, extractions }).listen(8080, "0.0.0.0");
}
