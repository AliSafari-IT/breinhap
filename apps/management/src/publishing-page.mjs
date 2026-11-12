import { tr, ui, formatLocale } from "./workspace-i18n.mjs";
import { esc } from "./directory-pages.mjs";
import { SUBJECTS } from "./library.mjs";

/**
 * The publisher's page (breinhap#33): approved immutable revisions, the current release and the
 * actions to publish, supersede, withdraw or restore. It deliberately shows no sources, reviewer
 * comments or uploader identity.
 */

const SUBJECT_NAME = Object.fromEntries(SUBJECTS);
const dateTime = (value) =>
	new Date(value).toLocaleString(formatLocale(), { timeZone: "Europe/Brussels" });

function stateLabel(row) {
	if (row.state === "active")
		return { label: tr("Gepubliceerd (packversie {0})", row.version), tone: "ok" };
	if (row.state === "withdrawn") return { label: tr("Ingetrokken"), tone: "pending" };
	if (row.state === "superseded") return { label: tr("Vervangen"), tone: "draft" };
	return { label: tr("Nog niet gepubliceerd"), tone: "draft" };
}

function action(row, csrf, replaces) {
	if (row.state === "active")
		return ui`<form method="post" action="/bibliotheek/publicaties/${esc(row.id)}/intrekken"><input type="hidden" name="csrf" value="${esc(csrf)}"><button>${tr("Intrekken")}</button></form>`;
	if (row.state === "withdrawn" || row.state === "superseded")
		return ui`<form method="post" action="/bibliotheek/publicaties/${esc(row.id)}/herstellen"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="revision" value="${row.revision}"><button>${tr("Opnieuw publiceren")}</button></form>${replaces ? ui`<small>${tr("Vervangt de huidige publicatie.")}</small>` : ""}`;
	return ui`<form method="post" action="/bibliotheek/publicaties/${esc(row.id)}/publiceren"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="revision" value="${row.revision}"><button>${tr("Publiceren")}</button></form>${replaces ? ui`<small>${tr("Vervangt de huidige publicatie.")}</small>` : ""}`;
}

export function publicationPage(rows, { csrf, notice = "" } = {}) {
	const active = new Map(rows.filter((row) => row.state === "active").map((row) => [row.id, row]));
	const list = rows.length
		? ui`<table class="library"><caption>${tr("Goedgekeurde revisies")}</caption><thead><tr><th scope="col">${tr("Titel")}</th><th scope="col">${tr("Vak")}</th><th scope="col">${tr("Jaar")}</th><th scope="col">${tr("Revisie")}</th><th scope="col">${tr("Status")}</th><th scope="col">${tr("Acties")}</th></tr></thead><tbody>${rows
				.map((row) => {
					const state = stateLabel(row);
					const replaces = row.state !== "active" && active.has(row.id);
					const published = row.publishedAt
						? ui`<br><small>${tr("Gepubliceerd op {0}", dateTime(row.publishedAt))}</small>`
						: "";
					return ui`<tr><td><a href="/bibliotheek/${esc(row.id)}">${esc(row.title)}</a></td><td>${esc(tr(SUBJECT_NAME[row.subject] ?? row.subject))}</td><td>${tr("Jaar {0}", row.grade)}</td><td>${row.revision}</td><td><span class="state ${state.tone}">${esc(state.label)}</span>${published}</td><td>${action(row, csrf, replaces)}</td></tr>`;
				})
				.join("")}</tbody></table>`
		: ui`<p>${tr("Er zijn geen goedgekeurde revisies om te publiceren.")}</p>`;
	return ui`${notice}<p>${tr("Publiceer alleen inhoud die onafhankelijk is nagekeken. Leerlingen krijgen enkel de actieve publicatie. Wat leerlingen al kregen, kan niet worden teruggehaald.")}</p><p><a href="/bibliotheek">${tr("Terug naar de bibliotheek")}</a></p>${list}`;
}
