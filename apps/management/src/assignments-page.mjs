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
		? ui`<table class="library"><caption>${tr("Jouw toewijzingen")}</caption><thead><tr><th scope="col">${tr("Titel")}</th><th scope="col">${tr("Voor")}</th><th scope="col">${tr("Periode")}</th><th scope="col">${tr("Status")}</th><th scope="col">${tr("Acties")}</th></tr></thead><tbody>${assignments
				.map((row) => {
					const state = stateLabel(row.state);
					const editable = !row.revokedAt && row.publicationState === "active";
					const actions = editable
						? ui`${editForm(row, csrf)}${revokeForm(row, csrf)}`
						: row.revokedAt
							? ui`<small>${tr("Ingetrokken op {0}.", date(row.revokedAt))}</small>`
							: ui`<small>${tr("Deze toewijzing kan niet meer worden gewijzigd.")}</small>`;
					return ui`<tr><td>${esc(publicationLabel(row))}<br><small>${esc(tr(SUBJECT_NAME[row.subject] ?? row.subject))} · ${tr("jaar {0}", row.grade)}</small></td><td>${esc(targetLabel(row))}</td><td>${esc(windowText(row))}</td><td><span class="state ${state.tone}">${esc(state.label)}</span></td><td>${actions}</td></tr>`;
				})
				.join("")}</tbody></table>`
		: ui`<p>${tr("Je hebt nog geen inhoud toegewezen.")}</p>`;

	return ui`${notice}<p>${tr("Wijs alleen gepubliceerde, onafhankelijk nagekeken inhoud toe. Leerlingen zien enkel wat aan hen of aan hun groep is toegewezen, zolang de publicatie actief is en de periode loopt.")}</p><p><small>${tr("Datums zijn in UTC.")}</small></p>${assign}${list}<p><a href="/bibliotheek">${tr("Terug naar de bibliotheek")}</a></p>`;
}
