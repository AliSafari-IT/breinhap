import { ORIGIN, readForm } from "./identity.mjs";
import {
	ContentError,
	editorPage,
	errorsOf,
	fromForm,
	libraryPage,
	SUBJECTS,
	toValues,
} from "./library.mjs";

/**
 * Routes of the content library (breinhap#27), under /bibliotheek. Every request resolves the
 * signed-in adult again; the content store decides what they may see and change (#26), so a filter in
 * the URL can only narrow their own list. Returns `{ status, title, body, headers }` for the shell to
 * render, or null for a path it does not own.
 */

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** An editor form with every slot filled stays far under this. */
export const EDITOR_FORM_LIMIT = 400_000;

const redirect = (location) => ({ status: 303, headers: { Location: location }, body: "" });
const notice = (text, role = "status") =>
	`<div class="notice" role="${role}"><p>${text}</p></div>`;

export async function handleLibrary(req, url, { identity, content }) {
	const path = url.pathname;
	if (path !== "/bibliotheek" && !path.startsWith("/bibliotheek/")) return null;
	if (!["GET", "HEAD", "POST"].includes(req.method))
		return { status: 405, title: "Niet toegestaan", body: "Deze actie bestaat hier niet.", headers: { Allow: "GET, POST" } };
	// a main navigation item: without the database it explains itself, like the placeholder it replaces
	if (!content)
		return {
			status: req.method === "POST" ? 503 : 200,
			title: "Bibliotheek",
			body: "De bibliotheek is nog niet ingericht op deze server. Er is nog geen inhoudsbibliotheek beschikbaar.",
			active: "/bibliotheek",
		};
	const principal = await identity.principal(req);
	if (!principal) return { status: 403, title: "Geen toegang", body: "Je hebt geen toegang tot de bibliotheek." };
	const csrf = req.managementSession.csrf;
	const refused = { status: 403, title: "Geen toegang", body: "Alleen ouders, begeleiders en leerkrachten maken leerobjecten. Beheerders beheren mensen en toegang." };

	let form;
	if (req.method === "POST") {
		form = await readForm(req, EDITOR_FORM_LIMIT);
		if (req.headers.origin !== ORIGIN || form.getAll("csrf").length !== 1 || form.get("csrf") !== csrf)
			return { status: 403, title: "Aanvraag geweigerd", body: "Laad de pagina opnieuw en probeer nog eens. Wat je typte, is niet opgeslagen." };
	}
	const guard = async (work) => {
		try {
			return await work();
		} catch (error) {
			if (error?.code === "forbidden") return refused;
			if (error?.code === "not_found")
				return { status: 404, title: "Niet gevonden", body: 'Dit leerobject bestaat niet of is niet van jou. <a href="/bibliotheek">Naar de bibliotheek</a>' };
			throw error;
		}
	};

	// the library
	if (path === "/bibliotheek") {
		if (req.method === "POST") return { status: 405, title: "Niet toegestaan", body: "", headers: { Allow: "GET" } };
		const q = url.searchParams.get("q")?.trim().slice(0, 100) ?? "";
		const subject = SUBJECTS.some(([v]) => v === url.searchParams.get("vak")) ? url.searchParams.get("vak") : "";
		const grade = /^[1-6]$/.test(url.searchParams.get("jaar") ?? "") ? url.searchParams.get("jaar") : "";
		return guard(async () => {
			const rows = await content.list(principal, {
				...(q ? { q } : {}),
				...(subject ? { subject } : {}),
				...(grade ? { grade: Number(grade) } : {}),
			});
			const archived = url.searchParams.get("gearchiveerd") === "1" ? notice("Het leerobject is gearchiveerd.") : "";
			return { status: 200, title: "Bibliotheek", body: libraryPage(rows, { q, subject, grade, notice: archived }), active: "/bibliotheek" };
		});
	}

	// a new learning object
	if (path === "/bibliotheek/nieuw") {
		if (req.method !== "POST")
			return guard(async () => {
				if (!(await content.directory.can(principal, "content.author"))) return refused;
				return { status: 200, title: "Nieuw leerobject", body: editorPage({ values: { grade: "3" }, csrf }) };
			});
		const parsed = fromForm(form);
		return guard(async () => {
			try {
				const { id } = await content.create(principal, parsed.object, parsed.sources);
				return redirect(`/bibliotheek/${id}?opgeslagen=1`);
			} catch (error) {
				if (!(error instanceof ContentError) || error.code === "forbidden" || error.code === "not_found") throw error;
				return { status: 422, title: "Nieuw leerobject", body: editorPage({ values: parsed.values, errors: errorsOf(error, parsed.paths), csrf }) };
			}
		});
	}

	const match = /^\/bibliotheek\/([a-z0-9-]{1,80})(?:\/(vastleggen|dupliceren|archiveren))?$/.exec(path);
	if (!match || !ID.test(match[1])) return { status: 404, title: "Niet gevonden", body: '<a href="/bibliotheek">Naar de bibliotheek</a>' };
	const [, id, action] = match;
	if (action && req.method !== "POST")
		return { status: 405, title: "Niet toegestaan", body: "", headers: { Allow: "POST" } };

	if (!action && req.method !== "POST")
		return guard(async () => {
			const draft = await content.get(principal, id);
			const saved = url.searchParams.get("opgeslagen");
			const revised = url.searchParams.get("vastgelegd");
			return {
				status: 200,
				title: draft.content.title,
				body: editorPage({
					values: toValues(draft.content, draft.sources),
					csrf,
					id,
					version: draft.version,
					revisions: draft.revisions,
					notice: saved ? notice(`Opgeslagen (versie ${draft.version}).`) : revised ? notice(`Revisie ${Number(revised)} vastgelegd.`) : "",
				}),
			};
		});

	const version = Number(form.get("expectedVersion"));
	if (!action) {
		const parsed = fromForm(form, id);
		return guard(async () => {
			try {
				await content.update(principal, id, version, parsed.object, parsed.sources);
				return redirect(`/bibliotheek/${id}?opgeslagen=1`);
			} catch (error) {
				if (!(error instanceof ContentError) || error.code === "forbidden" || error.code === "not_found") throw error;
				const current = await content.get(principal, id);
				if (error.code === "stale")
					// never overwrite silently: show what they typed, and let a second Save be the explicit choice
					return {
						status: 409,
						title: current.content.title,
						body: editorPage({
							values: parsed.values,
							csrf,
							id,
							version: current.version,
							revisions: current.revisions,
							notice: notice(
								`Iemand anders (of een ander tabblad) heeft dit leerobject intussen opgeslagen (nu versie ${current.version}). <strong>Je wijzigingen zijn niet opgeslagen</strong>; ze staan hieronder nog. <a href="/bibliotheek/${id}" target="_blank" rel="noopener">Open de nieuwste versie</a> in een nieuw tabblad om te vergelijken. Klik daarna op Opslaan om jouw versie over de nieuwste te bewaren.`,
								"alert",
							),
						}),
					};
				return {
					status: 422,
					title: current.content.title,
					body: editorPage({ values: parsed.values, errors: errorsOf(error, parsed.paths), csrf, id, version, revisions: current.revisions }),
				};
			}
		});
	}

	if (action === "vastleggen")
		return guard(async () => {
			try {
				const { revision } = await content.snapshot(principal, id, version);
				return redirect(`/bibliotheek/${id}?vastgelegd=${revision}`);
			} catch (error) {
				if (error?.code !== "stale" && error?.code !== "invalid") throw error;
				return {
					status: 409,
					title: "Niet vastgelegd",
					body: `${error.code === "stale" ? "Het leerobject is intussen gewijzigd. Open het opnieuw en leg dan een revisie vast." : "Het concept is niet geldig; sla het eerst correct op."} <a href="/bibliotheek/${id}">Terug</a>`,
				};
			}
		});
	if (action === "dupliceren")
		return guard(async () => {
			const newId = (form.get("newId") ?? "").trim();
			try {
				await content.duplicate(principal, id, newId);
				return redirect(`/bibliotheek/${newId}?opgeslagen=1`);
			} catch (error) {
				if (!(error instanceof ContentError) || error.code === "not_found" || error.code === "forbidden") throw error;
				return {
					status: 409,
					title: "Niet gedupliceerd",
					body: `${error.code === "exists" ? "Die code bestaat al." : error.code === "mission_exists" ? "De missiecodes van de kopie bestaan al; kies een andere code." : "Gebruik voor de code alleen kleine letters, cijfers en streepjes."} <a href="/bibliotheek/${id}">Terug</a>`,
				};
			}
		});
	return guard(async () => {
		await content.archive(principal, id);
		return redirect("/bibliotheek?gearchiveerd=1");
	});
}
