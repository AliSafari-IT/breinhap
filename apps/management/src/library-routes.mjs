import { tr, ui } from "./workspace-i18n.mjs";
import { validate } from "./content.mjs";
import { esc } from "./directory-pages.mjs";
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
import { previewPage } from "./preview.mjs";
import { publicationPage } from "./publishing-page.mjs";
import { assignmentsPage } from "./assignments-page.mjs";
import { LINK_TARGETS } from "./directory.mjs";
import { issueText, reviewPage, reviewQueuePage } from "./review.mjs";
import { assertSupported, studentPayload, SUPPORTED_SCHEMA_VERSIONS } from "./vendor/content-mission.mjs";

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
	ui`<div class="notice" role="${role}"><p>${text}</p></div>`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A plain day boundary in UTC; the assignment service rejects anything malformed or out of range. */
const dayValue = (value, end) => {
	if (!value) return null;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return "invalid";
	return `${value}T${end ? "23:59:59.999" : "00:00:00.000"}Z`;
};

export async function handleLibrary(req, url, { identity, content, publishing, assignments, extractions }) {
	const path = url.pathname;
	if (path !== "/bibliotheek" && !path.startsWith("/bibliotheek/")) return null;
	if (!["GET", "HEAD", "POST"].includes(req.method))
		return { status: 405, title: tr("Niet toegestaan"), body: tr("Deze actie bestaat hier niet."), headers: { Allow: "GET, POST" } };
	// a main navigation item: without the database it explains itself, like the placeholder it replaces
	if (!content)
		return {
			status: req.method === "POST" ? 503 : 200,
			title: tr("Bibliotheek"),
			body: tr("De bibliotheek is nog niet ingericht op deze server. Er is nog geen inhoudsbibliotheek beschikbaar."),
			active: "/bibliotheek",
		};
	// breinhap#33: publishing needs the content store's database and schema
	if (!publishing && (path === "/bibliotheek/publicaties" || path.startsWith("/bibliotheek/publicaties/")))
		return {
			status: req.method === "POST" ? 503 : 200,
			title: tr("Publicaties"),
			body: tr("Publicaties zijn nog niet ingericht op deze server."),
			active: "/bibliotheek",
		};
	// breinhap#34: assigning needs the directory (links) and the publications
	if (!assignments && (path === "/bibliotheek/toewijzen" || path.startsWith("/bibliotheek/toewijzen/")))
		return {
			status: req.method === "POST" ? 503 : 200,
			title: tr("Inhoud toewijzen"),
			body: tr("Toewijzen is nog niet ingericht op deze server."),
			active: "/bibliotheek",
		};
	const principal = await identity.principal(req);
	if (!principal) return { status: 403, title: tr("Geen toegang"), body: tr("Je hebt geen toegang tot de bibliotheek.") };
	const csrf = req.managementSession.csrf;
	const refused = { status: 403, title: tr("Geen toegang"), body: tr("Alleen ouders, begeleiders en leerkrachten maken leerobjecten. Beheerders beheren mensen en toegang.") };
	const reviewRefused = { status: 403, title: tr("Geen toegang"), body: tr("Alleen aangewezen nakijkers kunnen inhoud nakijken.") };
	const publishRefused = { status: 403, title: tr("Geen toegang"), body: tr("Alleen aangewezen uitgevers kunnen inhoud publiceren.") };
	const assignmentRefused = { status: 403, title: tr("Geen toegang"), body: tr("Alleen ouders, begeleiders en leerkrachten wijzen inhoud toe aan hun eigen leerlingen of groepen.") };
	const canPublish = await content.directory.can(principal, "content.publish");
	const canAssign = await content.directory.can(principal, "content.assign");

	let form;
	if (req.method === "POST") {
		form = await readForm(req, EDITOR_FORM_LIMIT);
		if (req.headers.origin !== ORIGIN || form.getAll("csrf").length !== 1 || form.get("csrf") !== csrf)
			return { status: 403, title: tr("Aanvraag geweigerd"), body: tr("Laad de pagina opnieuw en probeer nog eens. Wat je typte, is niet opgeslagen.") };
	}
	const guard = async (work, forbidden = refused) => {
		try {
			return await work();
		} catch (error) {
			if (error?.code === "forbidden") return forbidden;
			if (error?.code === "not_found")
				return { status: 404, title: tr("Niet gevonden"), body: ui`Dit leerobject bestaat niet of is niet van jou. <a href="/bibliotheek">Naar de bibliotheek</a>` };
			throw error;
		}
	};

	// the library
	if (path === "/bibliotheek") {
		if (req.method === "POST") return { status: 405, title: tr("Niet toegestaan"), body: "", headers: { Allow: "GET" } };
		const q = url.searchParams.get("q")?.trim().slice(0, 100) ?? "";
		const subject = SUBJECTS.some(([v]) => v === url.searchParams.get("vak")) ? url.searchParams.get("vak") : "";
		const grade = /^[1-6]$/.test(url.searchParams.get("jaar") ?? "") ? url.searchParams.get("jaar") : "";
		return guard(async () => {
			const rows = await content.list(principal, {
				...(q ? { q } : {}),
				...(subject ? { subject } : {}),
				...(grade ? { grade: Number(grade) } : {}),
			});
			const archived = url.searchParams.get("gearchiveerd") === "1" ? notice(tr("Het leerobject is gearchiveerd.")) : "";
			const canReview = await content.directory.can(principal, "content.review");
			const pending = canReview ? (await content.reviewQueue(principal)).length : 0;
			return { status: 200, title: tr("Bibliotheek"), body: libraryPage(rows, { q, subject, grade, notice: archived, canReview, canPublish, canAssign, pending }), active: "/bibliotheek" };
		});
	}

	// breinhap#33: the publisher's page, before the object matcher takes "publicaties" for an id
	if (path === "/bibliotheek/publicaties") {
		if (req.method === "POST") return { status: 405, title: tr("Niet toegestaan"), body: "", headers: { Allow: "GET" } };
		return guard(async () => {
			const rows = await publishing.candidates(principal);
			const published = /^[1-9]\d{0,5}$/.test(url.searchParams.get("gepubliceerd") ?? "") ? Number(url.searchParams.get("gepubliceerd")) : null;
			const restored = /^[1-9]\d{0,5}$/.test(url.searchParams.get("hersteld") ?? "") ? Number(url.searchParams.get("hersteld")) : null;
			const feedback = published
				? notice(tr`Revisie ${published} is gepubliceerd.`)
				: restored
					? notice(tr`Revisie ${restored} is opnieuw gepubliceerd.`)
					: url.searchParams.get("ingetrokken") === "1"
						? notice(tr("De publicatie is ingetrokken."))
						: "";
			return { status: 200, title: tr("Publicaties"), body: publicationPage(rows, { csrf, notice: feedback }), active: "/bibliotheek" };
		}, publishRefused);
	}
	const publicationMatch = /^\/bibliotheek\/publicaties\/([a-z0-9-]{1,80})\/(publiceren|intrekken|herstellen)$/.exec(path);
	if (publicationMatch) {
		if (req.method !== "POST") return { status: 405, title: tr("Niet toegestaan"), body: "", headers: { Allow: "POST" } };
		const [, publicationObject, publicationAction] = publicationMatch;
		if (!ID.test(publicationObject)) return { status: 404, title: tr("Niet gevonden"), body: ui`<a href="/bibliotheek/publicaties">${tr("Terug naar de publicaties")}</a>` };
		return guard(async () => {
			const back = ui`<p><a href="/bibliotheek/publicaties">${tr("Terug naar de publicaties")}</a></p>`;
			try {
				if (publicationAction === "intrekken") {
					await publishing.withdraw(principal, publicationObject);
					return redirect("/bibliotheek/publicaties?ingetrokken=1");
				}
				const revision = Number(form.get("revision"));
				if (publicationAction === "publiceren") await publishing.publish(principal, publicationObject, revision);
				else await publishing.restore(principal, publicationObject, revision);
				return redirect(`/bibliotheek/publicaties?${publicationAction === "publiceren" ? "gepubliceerd" : "hersteld"}=${revision}`);
			} catch (error) {
				if (error?.code === "not_found")
					return { status: 404, title: tr("Niet gevonden"), body: ui`${tr("Dit leerobject of deze revisie bestaat niet.")}${back}` };
				if (error?.code === "not_approved")
					return { status: 409, title: tr("Niet gepubliceerd"), body: ui`${tr("Deze revisie is nog niet goedgekeurd.")}${back}` };
				if (error?.code === "self_approved")
					return { status: 409, title: tr("Niet gepubliceerd"), body: ui`${tr("Deze revisie is niet onafhankelijk nagekeken.")}${back}` };
				if (error?.code === "already_published")
					return { status: 409, title: tr("Niet gepubliceerd"), body: ui`${tr("Deze revisie is al gepubliceerd.")}${back}` };
				if (error?.code === "not_published")
					return { status: 409, title: tr("Niet ingetrokken"), body: ui`${tr("Er is nog geen actieve publicatie om in te trekken.")}${back}` };
				if (error?.code === "unsupported_version")
					return { status: 422, title: tr("Niet gepubliceerd"), body: ui`${tr("Deze inhoud gebruikt een schemaversie die publicatie niet ondersteunt.")}${back}` };
				if (error?.code === "not_ready")
					return {
						status: 409,
						title: tr("Niet gepubliceerd"),
						body: ui`${tr("Deze revisie is niet klaar om te publiceren:")}<ul>${(error.issues ?? []).map((issue) => ui`<li>${esc(issueText(issue))}</li>`).join("")}</ul>${back}`,
					};
				if (error?.code === "conflict")
					return { status: 409, title: tr("Niet gepubliceerd"), body: ui`${tr("De publicatie is intussen gewijzigd. Probeer opnieuw.")}${back}` };
				if (error?.code === "invalid")
					return { status: 422, title: tr("Niet gepubliceerd"), body: ui`${tr("Deze inhoud kan niet als pakket worden gepubliceerd.")}${back}` };
				throw error;
			}
		}, publishRefused);
	}

	// breinhap#32: the review queue and one submitted revision, before the object matcher takes "nakijken" for an id
	if (path === "/bibliotheek/nakijken") {
		if (req.method === "POST") return { status: 405, title: tr("Niet toegestaan"), body: "", headers: { Allow: "GET" } };
		return guard(async () => {
			const rows = await content.reviewQueue(principal);
			const decided = url.searchParams.get("beoordeeld");
			const feedback = decided === "approved" ? notice(tr("Goedgekeurd.")) : decided === "changes_requested" ? notice(tr("Aanpassingen gevraagd.")) : "";
			return { status: 200, title: tr("Inhoud nakijken"), body: reviewQueuePage(rows, { notice: feedback }), active: "/bibliotheek" };
		}, reviewRefused);
	}
	const reviewMatch = /^\/bibliotheek\/nakijken\/([a-z0-9-]{1,80})\/([1-9]\d{0,5})$/.exec(path);
	if (reviewMatch) {
		const [, reviewId, askedRevision] = reviewMatch;
		if (!ID.test(reviewId)) return { status: 404, title: tr("Niet gevonden"), body: ui`<a href="/bibliotheek/nakijken">Naar de wachtrij</a>` };
		const revision = Number(askedRevision);
		const gone = { status: 404, title: tr("Niet gevonden"), body: ui`${tr("Deze revisie wacht niet (meer) op nakijken.")} <a href="/bibliotheek/nakijken">Naar de wachtrij</a>` };
		if (req.method === "GET" || req.method === "HEAD")
			return guard(async () => {
				try {
					const review = await content.reviewRevision(principal, reviewId, revision);
					return { status: 200, title: tr`Revisie ${revision} ter nakijking`, body: reviewPage(review, { csrf }), active: "/bibliotheek" };
				} catch (error) {
					if (error?.code === "not_found") return gone;
					throw error;
				}
			}, reviewRefused);
		return guard(async () => {
			const decision = form.get("decision");
			const comment = form.get("comment") ?? "";
			try {
				await content.review(principal, reviewId, revision, decision, comment);
				return redirect(`/bibliotheek/nakijken?beoordeeld=${decision}`);
			} catch (error) {
				const back = ui`<p><a href="/bibliotheek/nakijken/${esc(reviewId)}/${revision}">${tr("Terug naar de revisie")}</a></p>`;
				if (error?.code === "not_found") return gone;
				if (error?.code === "self_review")
					return { status: 409, title: tr("Niet nagekeken"), body: ui`${tr("Je kunt je eigen inhoud niet nakijken.")}${back}` };
				if (error?.code === "already_reviewed")
					return { status: 409, title: tr("Niet nagekeken"), body: ui`${tr("Deze revisie is al nagekeken.")}${back}` };
				if (error?.code === "comment_required")
					return { status: 422, title: tr("Niet nagekeken"), body: ui`${tr("Geef bij aanpassingen een opmerking voor de auteur.")}${back}` };
				if (error?.code === "invalid")
					return { status: 422, title: tr("Niet nagekeken"), body: ui`${tr("Kies goedkeuren of aanpassingen vragen.")}${back}` };
				if (error?.code === "not_ready")
					return { status: 409, title: tr("Niet nagekeken"), body: ui`${tr("De inhoud is nog niet klaar voor goedkeuring.")}<ul>${(error.issues ?? []).map((issue) => ui`<li>${esc(issueText(issue))}</li>`).join("")}</ul>${back}` };
				throw error;
			}
		}, reviewRefused);
	}

	// breinhap#34: assign active publications to the adult's linked learners and groups, before the
	// object matcher takes "toewijzen" for an id
	const assignmentBack = ui`<p><a href="/bibliotheek/toewijzen">${tr("Terug naar toewijzen")}</a></p>`;
	const assignmentProblem = (error) => {
		if (error?.code === "forbidden") return assignmentRefused;
		if (error?.code === "not_found")
			return {
				status: 404,
				title: tr("Niet gevonden"),
				body: ui`${tr("Deze publicatie, leerling of groep bestaat niet of is niet van jou.")}${assignmentBack}`,
			};
		if (error?.code === "exists")
			return {
				status: 409,
				title: tr("Al toegewezen"),
				body: ui`${tr("Deze publicatie is al aan dit doel toegewezen.")}${assignmentBack}`,
			};
		if (error?.code === "stale")
			return {
				status: 409,
				title: tr("Intussen gewijzigd"),
				body: ui`${tr("De toewijzing is intussen gewijzigd. Probeer opnieuw.")}${assignmentBack}`,
			};
		if (error?.code === "invalid")
			return {
				status: 422,
				title: tr("Niet toegewezen"),
				body: ui`${tr("Controleer de publicatie, het doel en de datums. Een periode duurt hoogstens één jaar.")}${assignmentBack}`,
			};
		if (error?.code === "unavailable")
			return {
				status: 503,
				title: tr("Tijdelijk niet beschikbaar"),
				body: ui`${tr("De toewijzing kan nu niet worden gecontroleerd. Probeer later opnieuw.")}${assignmentBack}`,
			};
		throw error;
	};
	const assignmentGuard = async (work) => {
		try {
			return await work();
		} catch (error) {
			return assignmentProblem(error);
		}
	};
	if (path === "/bibliotheek/toewijzen") {
		if (req.method === "POST")
			return assignmentGuard(async () => {
				const audience = (form.get("audience") ?? "").split(":");
				const audienceKind = audience[0];
				const audienceId = audience.slice(1).join(":");
				await assignments.assign(principal, {
					publicationId: form.get("publicationId") ?? "",
					audienceKind,
					audienceId,
					notBefore: dayValue(form.get("notBefore"), false),
					availableUntil: dayValue(form.get("availableUntil"), true),
				});
				return redirect("/bibliotheek/toewijzen?toegewezen=1");
			});
		if (req.method !== "GET" && req.method !== "HEAD")
			return { status: 405, title: tr("Niet toegestaan"), body: "", headers: { Allow: "GET, POST" } };
		return assignmentGuard(async () => {
			const targets = LINK_TARGETS[principal.role] ?? [];
			const [publications, learners, groups, list] = await Promise.all([
				assignments.publications(principal),
				targets.includes("learner")
					? content.directory.learners(principal)
					: [],
				targets.includes("group") ? content.directory.groups(principal) : [],
				assignments.list(principal),
			]);
			const feedback = url.searchParams.get("toegewezen")
				? notice(tr("De inhoud is toegewezen."))
				: url.searchParams.get("gewijzigd")
					? notice(tr("De periode is gewijzigd."))
					: url.searchParams.get("ingetrokken")
						? notice(tr("De toewijzing is ingetrokken."))
						: "";
			return {
				status: 200,
				title: tr("Inhoud toewijzen"),
				body: assignmentsPage({ publications, learners, groups, assignments: list, csrf, notice: feedback }),
				active: "/bibliotheek",
			};
		});
	}
	const assignmentMatch = /^\/bibliotheek\/toewijzen\/([0-9a-fA-F-]{36})(?:\/(intrekken))?$/.exec(path);
	if (assignmentMatch) {
		if (req.method !== "POST")
			return { status: 405, title: tr("Niet toegestaan"), body: "", headers: { Allow: "POST" } };
		const [, assignmentId, assignmentAction] = assignmentMatch;
		return assignmentGuard(async () => {
			if (assignmentAction === "intrekken") {
				await assignments.revoke(principal, assignmentId);
				return redirect("/bibliotheek/toewijzen?ingetrokken=1");
			}
			const expectedVersion = Number(form.get("expectedVersion"));
			await assignments.update(principal, assignmentId, expectedVersion, {
				notBefore: dayValue(form.get("notBefore"), false),
				availableUntil: dayValue(form.get("availableUntil"), true),
			});
			return redirect("/bibliotheek/toewijzen?gewijzigd=1");
		});
	}

	// a new learning object
	if (path === "/bibliotheek/nieuw") {
		if (req.method !== "POST")
			return guard(async () => {
				if (!(await content.directory.can(principal, "content.author"))) return refused;
				return { status: 200, title: tr("Nieuw leerobject"), body: editorPage({ values: { grade: "3" }, csrf }) };
			});
		const parsed = fromForm(form);
		// breinhap#31: a draft made from extracted text keeps a link to that extraction
		const extraction = UUID.test(form.get("uittreksel") ?? "") && extractions ? form.get("uittreksel") : null;
		delete parsed.values.uittreksel;
		const hidden = extraction ? { uittreksel: extraction } : {};
		return guard(async () => {
			try {
				const { id } = await content.create(principal, parsed.object, parsed.sources);
				if (extraction) await extractions.linkDraft(principal, extraction, id).catch(() => {});
				return redirect(`/bibliotheek/${id}?opgeslagen=1`);
			} catch (error) {
				if (!(error instanceof ContentError) || error.code === "forbidden" || error.code === "not_found") throw error;
				return { status: 422, title: tr("Nieuw leerobject"), body: editorPage({ values: parsed.values, errors: errorsOf(error, parsed.paths), csrf, hidden }) };
			}
		});
	}

	const match = /^\/bibliotheek\/([a-z0-9-]{1,80})(?:\/(vastleggen|dupliceren|archiveren|voorbeeld|aanbieden))?$/.exec(path);
	if (!match || !ID.test(match[1])) return { status: 404, title: tr("Niet gevonden"), body: ui`<a href="/bibliotheek">Naar de bibliotheek</a>` };
	const [, id, action] = match;
	// breinhap#28: the preview only reads; its state lives in the URL
	if (action === "voorbeeld") {
		if (req.method === "POST") return { status: 405, title: tr("Niet toegestaan"), body: "", headers: { Allow: "GET" } };
		return guard(() => preview(content, principal, id, url));
	}
	if (action && req.method !== "POST")
		return { status: 405, title: tr("Niet toegestaan"), body: "", headers: { Allow: "POST" } };

	if (!action && req.method !== "POST")
		return guard(async () => {
			const draft = await content.get(principal, id);
			const saved = url.searchParams.get("opgeslagen");
			const revised = url.searchParams.get("vastgelegd");
			const offered = url.searchParams.get("aangeboden");
			return {
				status: 200,
				title: draft.content.title,
				body: editorPage({
					values: toValues(draft.content, draft.sources),
					csrf,
					id,
					version: draft.version,
					revisions: draft.revisions,
					publications: draft.publications,
					canPublish,
					draftChanged: draft.draftChanged,
					notice: saved ? notice(tr`Opgeslagen (versie ${draft.version}).`) : revised ? notice(tr`Revisie ${Number(revised)} vastgelegd.`) : offered ? notice(tr`Revisie ${Number(offered)} ter nakijking aangeboden.`) : "",
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
							publications: current.publications,
							canPublish,
							notice: notice(
								ui`Iemand anders (of een ander tabblad) heeft dit leerobject intussen opgeslagen (nu versie ${current.version}). <strong>Je wijzigingen zijn niet opgeslagen</strong>; ze staan hieronder nog. <a href="/bibliotheek/${id}" target="_blank" rel="noopener">Open de nieuwste versie</a> in een nieuw tabblad om te vergelijken. Klik daarna op Opslaan om jouw versie over de nieuwste te bewaren.`,
								"alert",
							),
						}),
					};
				return {
					status: 422,
					title: current.content.title,
					body: editorPage({ values: parsed.values, errors: errorsOf(error, parsed.paths), csrf, id, version, revisions: current.revisions, publications: current.publications, canPublish }),
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
					title: tr("Niet vastgelegd"),
					body: ui`${error.code === "stale" ? tr("Het leerobject is intussen gewijzigd. Open het opnieuw en leg dan een revisie vast.") : tr("Het concept is niet geldig; sla het eerst correct op.")} <a href="/bibliotheek/${id}">Terug</a>`,
				};
			}
		});
	if (action === "aanbieden")
		return guard(async () => {
			const revision = Number(form.get("revision"));
			const back = ui`<p><a href="/bibliotheek/${esc(id)}">${tr("Terug naar het leerobject")}</a></p>`;
			try {
				await content.submit(principal, id, revision);
				return redirect(`/bibliotheek/${id}?aangeboden=${revision}`);
			} catch (error) {
				const problem = (text, issues = []) => ({
					status: error?.code === "not_found" ? 404 : 409,
					title: tr("Niet ingediend"),
					body: ui`${text}${issues.length ? ui`<ul>${issues.map((issue) => ui`<li>${esc(issueText(issue))}</li>`).join("")}</ul>` : ""}${back}`,
				});
				if (error?.code === "not_found") throw error;
				if (error?.code === "stale_draft")
					return problem(tr("Je concept heeft wijzigingen die nog niet in een revisie staan. Leg eerst een nieuwe revisie vast."));
				if (error?.code === "not_latest")
					return problem(tr("Deze revisie is niet de nieuwste. Leg eerst een nieuwe revisie vast."));
				if (error?.code === "already_submitted") return problem(tr("Deze revisie is al ingediend."));
				if (error?.code === "already_reviewed") return problem(tr("Deze revisie is al nagekeken."));
				if (error?.code === "not_ready")
					return problem(tr("Deze revisie is nog niet klaar om na te kijken:"), error.issues ?? []);
				if (error?.code === "invalid")
					return problem(tr("Kies een bestaande revisie."));
				throw error;
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
					title: tr("Niet gedupliceerd"),
					body: ui`${error.code === "exists" ? tr("Die code bestaat al.") : error.code === "mission_exists" ? tr("De missiecodes van de kopie bestaan al; kies een andere code.") : tr("Gebruik voor de code alleen kleine letters, cijfers en streepjes.")} <a href="/bibliotheek/${id}">Terug</a>`,
				};
			}
		});
	return guard(async () => {
		await content.archive(principal, id);
		return redirect("/bibliotheek?gearchiveerd=1");
	});
}

/**
 * breinhap#28: the preview of the owner's draft, or of one of its revisions (`?revisie=N`). It reads
 * through the same owner-scoped store as the editor, renders only the student payload, and writes
 * nothing anywhere.
 */
async function preview(content, principal, id, url) {
	const asked = url.searchParams.get("revisie");
	const back = `/bibliotheek/${id}`;
	let stored;
	let label;
	if (asked !== null) {
		if (!/^[1-9]\d{0,5}$/.test(asked)) return { status: 404, title: tr("Niet gevonden"), body: ui`Deze revisie bestaat niet. <a href="${back}">Terug</a>` };
		stored = (await content.revision(principal, id, Number(asked))).content;
		label = `revisie ${Number(asked)}`;
	} else {
		const draft = await content.get(principal, id);
		stored = draft.content;
		label = tr`het concept (versie ${draft.version})`;
	}
	try {
		assertSupported(stored);
	} catch {
		return {
			status: 422,
			title: tr("Voorbeeld niet mogelijk"),
			body: ui`Deze inhoud gebruikt een schemaversie die deze preview niet kent (deze preview kent versie ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}). Ze toont niets wat ze niet begrijpt. <a href="${back}">Terug naar het leerobject</a>`,
		};
	}
	let object;
	try {
		({ object } = validate(stored, []));
	} catch (error) {
		if (!(error instanceof ContentError)) throw error;
		return {
			status: 422,
			title: tr("Voorbeeld niet mogelijk"),
			body: ui`Dit concept is nog niet geldig, dus een leerling kan het zo niet krijgen. Sla het eerst correct op in de editor. <a href="${back}">Terug naar het leerobject</a>`,
		};
	}
	const payload = studentPayload(object);
	return {
		status: 200,
		title: tr`Voorbeeld: ${payload.title}`,
		body: previewPage(payload, url.searchParams, { base: `${back}/voorbeeld`, back, label }),
		headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
	};
}
