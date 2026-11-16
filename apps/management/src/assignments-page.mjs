import { tr, ui, formatLocale } from "./workspace-i18n.mjs";
import { esc } from "./directory-pages.mjs";
import { SUBJECTS } from "./library.mjs";

/**
 * Assigning published content to linked learners and groups (breinhap#34). Server-rendered, keyboard
 * friendly and without JavaScript, like the rest of the workspace. An adult sees only their own
 * assignments and only targets they may still read. Dates are shown in UTC because the form stores
 * plain day boundaries; the exact local time is not part of the assignment decision.
 */

const SUBJECT_NAME = Object.fromEntries(SUBJECTS);
const date = (value) =>
	value
		? new Date(value).toLocaleDateString(formatLocale(), { timeZone: "UTC" })
		: "";
const inputDate = (value) => (value ? new Date(value).toISOString().slice(0, 10) : "");

function stateLabel(state) {
	switch (state) {
		case "active":
			return { label: tr("Beschikbaar"), tone: "ok" };
		case "scheduled":
			return { label: tr("Gepland"), tone: "pending" };
		case "expired":
			return { label: tr("Verlopen"), tone: "draft" };
		case "revoked":
			return { label: tr("Ingetrokken"), tone: "draft" };
		case "withdrawn":
			return { label: tr("Publicatie ingetrokken"), tone: "draft" };
		case "superseded":
			return { label: tr("Publicatie vervangen"), tone: "draft" };
		default:
			return { label: tr("Onbekend"), tone: "draft" };
	}
}

const targetLabel = (row) =>
	row.kind === "group"
		? row.groupName ?? tr("Onbekende groep")
		: row.learnerName ?? tr("Onbekende leerling");

const publicationLabel = (row) =>
	tr("{0} · revisie {1} (packversie {2})", row.title, row.revision, row.publicationVersion ?? row.version);

function windowText(row) {
	const from = row.notBefore ? tr("vanaf {0}", date(row.notBefore)) : "";
	const until = row.availableUntil
		? tr("tot en met {0}", date(row.availableUntil))
		: tr("zonder einddatum");
	return `${from} ${until}`.trim();
}

/** A learner's status in words (breinhap#137): only the state and its day, never answers or a score. */
function learnerStatus(learner) {
	if (learner.state === "finished")
		return { label: tr("klaar op {0}", date(learner.finishedOn)), tone: "ok" };
	if (learner.state === "started")
		return { label: tr("bezig sinds {0}", date(learner.startedOn)), tone: "pending" };
	return { label: tr("niet begonnen"), tone: "draft" };
}

/** Per assignment: how many are done, and per learner it reaches now, the state and its day. */
function progressCell(row) {
	const learners = row.learners ?? [];
	if (!learners.length) return ui`<small>${tr("Geen leerlingen")}</small>`;
	const done = learners.filter((learner) => learner.state === "finished").length;
	const items = learners
		.map((learner) => {
			const status = learnerStatus(learner);
			return ui`<li>${esc(learner.displayName)}: <span class="state ${status.tone}">${esc(status.label)}</span></li>`;
		})
		.join("");
	return ui`<details class="assignment-status"><summary>${tr("{0} van {1} klaar", done, learners.length)}</summary><ul>${items}</ul></details>`;
}

function editForm(row, csrf) {
	return ui`<form method="post" action="/bibliotheek/toewijzen/${esc(row.id)}" class="assignment-window"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="expectedVersion" value="${row.version}"><label>${tr("Vanaf")} <input type="date" name="notBefore" value="${inputDate(row.notBefore)}"></label><label>${tr("Tot en met")} <input type="date" name="availableUntil" value="${inputDate(row.availableUntil)}"></label><button>${tr("Wijzigen")}</button></form>`;
}

function revokeForm(row, csrf) {
	return ui`<form method="post" action="/bibliotheek/toewijzen/${esc(row.id)}/intrekken"><input type="hidden" name="csrf" value="${esc(csrf)}"><button>${tr("Intrekken")}</button></form>`;
}

function targetOptions(learners, groups) {
	const learnerOptions = learners.map(
		(learner) =>
			ui`<option value="learner:${esc(learner.id)}">${esc(learner.displayName)} (${tr("jaar {0}", learner.schoolYear)})</option>`,
	);
	const groupOptions = groups.map(
		(group) => ui`<option value="group:${esc(group.id)}">${esc(group.name)}</option>`,
	);
	return [
		learnerOptions.length
			? ui`<optgroup label="${tr("Leerlingen")}">${learnerOptions.join("")}</optgroup>`
			: "",
		groupOptions.length
			? ui`<optgroup label="${tr("Groepen")}">${groupOptions.join("")}</optgroup>`
			: "",
	].join("");
}

export function assignmentsPage({
	publications,
	learners,
	groups,
	assignments,
	csrf,
	notice = "",
}) {
	const options = targetOptions(learners, groups);
	const assign =
		publications.length && options
			? ui`<form method="post" action="/bibliotheek/toewijzen" class="assignment-create"><label>${tr("Publicatie")} <select name="publicationId" required>${publications
					.map(
						(publication) =>
							ui`<option value="${esc(publication.publicationId)}">${esc(publicationLabel(publication))}</option>`,
					)
					.join("")}</select></label><label>${tr("Voor")} <select name="audience" required>${options}</select></label><label>${tr("Vanaf")} <input type="date" name="notBefore"></label><label>${tr("Tot en met")} <input type="date" name="availableUntil"></label><button>${tr("Toewijzen")}</button></form>`
			: publications.length
				? ui`<p>${tr("Je hebt nog geen leerling of groep waaraan je inhoud kunt toewijzen.")}</p>`
				: ui`<p>${tr("Er is nog geen actieve publicatie om toe te wijzen. Publiceer eerst een nagekeken revisie.")}</p>`;

	const list = assignments.length
		? ui`<table class="library"><caption>${tr("Jouw toewijzingen")}</caption><thead><tr><th scope="col">${tr("Titel")}</th><th scope="col">${tr("Voor")}</th><th scope="col">${tr("Periode")}</th><th scope="col">${tr("Status")}</th><th scope="col">${tr("Voortgang")}</th><th scope="col">${tr("Acties")}</th></tr></thead><tbody>${assignments
				.map((row) => {
					const state = stateLabel(row.state);
					const editable = !row.revokedAt && row.publicationState === "active";
					const actions = editable
						? ui`${editForm(row, csrf)}${revokeForm(row, csrf)}`
						: row.revokedAt
							? ui`<small>${tr("Ingetrokken op {0}.", date(row.revokedAt))}</small>`
							: ui`<small>${tr("Deze toewijzing kan niet meer worden gewijzigd.")}</small>`;
					return ui`<tr><td>${esc(publicationLabel(row))}<br><small>${esc(tr(SUBJECT_NAME[row.subject] ?? row.subject))} · ${tr("jaar {0}", row.grade)}</small></td><td>${esc(targetLabel(row))}</td><td>${esc(windowText(row))}</td><td><span class="state ${state.tone}">${esc(state.label)}</span></td><td>${progressCell(row)}</td><td>${actions}</td></tr>`;
				})
				.join("")}</tbody></table>`
		: ui`<p>${tr("Je hebt nog geen inhoud toegewezen.")}</p>`;

	return ui`${notice}<p>${tr("Wijs alleen gepubliceerde, onafhankelijk nagekeken inhoud toe. Leerlingen zien enkel wat aan hen of aan hun groep is toegewezen, zolang de publicatie actief is en de periode loopt.")}</p><p>${tr("Bij Voortgang zie je per leerling alleen of die begon en klaar is, en op welke dag. Antwoorden, scores en tijd zie je niet: die blijven van de leerling. Leerlingen lezen dit ook op hun eigen pagina.")}</p><p><small>${tr("Datums zijn in UTC.")}</small></p>${assign}${list}<p><a href="/bibliotheek">${tr("Terug naar de bibliotheek")}</a></p>`;
}

/**
 * The administrator's view (breinhap#137): counts per publication over current assignments, without
 * learner, group or adult names and without dates.
 */
export function assignmentCountsPage(rows) {
	const table = rows.length
		? ui`<table class="library"><caption>${tr("Voortgang van toewijzingen")}</caption><thead><tr><th scope="col">${tr("Titel")}</th><th scope="col">${tr("Toewijzingen")}</th><th scope="col">${tr("Leerlingen")}</th><th scope="col">${tr("Niet begonnen")}</th><th scope="col">${tr("Bezig")}</th><th scope="col">${tr("Afgewerkt")}</th></tr></thead><tbody>${rows
				.map(
					(row) =>
						ui`<tr><td>${esc(tr("{0} · revisie {1}", row.title, row.revision))}</td><td>${row.assignments}</td><td>${row.learners}</td><td>${row.notStarted}</td><td>${row.started}</td><td>${row.finished}</td></tr>`,
				)
				.join("")}</tbody></table>`
		: ui`<p>${tr("Er zijn nu geen lopende toewijzingen.")}</p>`;
	return ui`<p>${tr("Als beheerder zie je alleen aantallen: geen namen van leerlingen, groepen of volwassenen, en geen datums. Alleen de volwassene die iets toewees, ziet per leerling of die begon en klaar is.")}</p>${table}`;
}
