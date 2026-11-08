import { tr, ui, uiLocale } from "./workspace-i18n.mjs";
import { DirectoryError, GRANTABLE, SCHOOL_YEARS } from "./directory.mjs";
import { SELF_SERVICE_ROLES } from "./store.mjs";
const ROLE_NAME = { "breinhap.parent": "ouder", "breinhap.tutor": "begeleider", "breinhap.teacher": "leerkracht", "breinhap.admin": "beheerder" };

/**
 * The management pages of breinhap#25: the administrator's "Leerlingen en groepen" page with its
 * forms, and the adult's own "Mijn leerlingen". The directory decides every permission; these only
 * render what it returns and turn form fields into calls. All text the user typed is escaped.
 */

export const esc = (value) =>
	String(value).replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
	);

const YEAR = (year) => uiLocale() === "nl" ? `${year}${year === 1 ? "ste" : "de"} middelbaar` : tr("Middelbaar, jaar {0}", year);
const CAPABILITY = {
	"content.review": "Inhoud nakijken",
	"content.publish": "Inhoud publiceren",
};

/** What the administrator reads when a change is refused. */
export const DIRECTORY_ERRORS = () => Object.freeze({
	forbidden: tr("Je hebt geen toegang tot deze actie."),
	invalid: tr("Controleer wat je invulde: een naam van 1 tot 40 tekens (groepen 60), zonder < of >."),
	not_found: tr("Deze leerling, groep of koppeling bestaat niet (meer) in deze werkplek."),
	self: tr("Je kunt jezelf geen koppeling of recht geven."),
	not_member:
		tr("Dit account is geen actieve ouder, begeleider of leerkracht in deze werkplek. Keur eerst de rol goed."),
	role_mismatch:
		tr("Deze rol past niet bij deze koppeling: een ouder koppel je aan een leerling, een leerkracht aan een groep, een begeleider aan beide."),
	exists: tr("Deze koppeling of dit recht bestaat al."),
});

const csrfField = (csrf) => ui`<input type="hidden" name="csrf" value="${esc(csrf)}">`;
const button = (path, fields, label, csrf) =>
	ui`<form method="post" action="${path}" class="inline">${Object.entries(fields)
		.map(([name, value]) => ui`<input type="hidden" name="${name}" value="${esc(value)}">`)
		.join("")}${csrfField(csrf)}<button>${label}</button></form>`;

/** The administrator's page. `content` goes inside the shell's paragraph, hence the leading </p>. */
export function adminDirectoryPage(view, csrf, members = []) {
	// breinhap#signup: people by name and e-mail, never an account code to type
	const nameOf = new Map(members.map((m) => [m.subject, [[m.profile?.firstName, m.profile?.lastName].filter(Boolean).join(" "), m.profile?.email].filter(Boolean).join(" · ") || tr("(onbekend lid)")]));
	const who = (sub) => esc(nameOf.get(sub) ?? tr("(geen lid meer)"));
	const adults = members.filter((m) => m.role !== "breinhap.admin");
	const peopleSelect = (label) =>
		adults.length
			? ui`<label>${label} <select name="subject" required>${adults.map((m) => ui`<option value="${esc(m.subject)}">${esc(nameOf.get(m.subject))} (${esc(tr(ROLE_NAME[m.role] ?? m.role))})</option>`).join("")}</select></label>`
			: "";
	const learnerName = new Map(view.learners.map((l) => [l.id, l.displayName]));
	const groupName = new Map(view.groups.map((g) => [g.id, g.name]));
	const membersOf = (groupId) =>
		view.memberships.filter((m) => m.groupId === groupId && learnerName.has(m.learnerId));
	const years = SCHOOL_YEARS.map(
		(y) => ui`<option value="${y}"${y === 3 ? " selected" : ""}>${YEAR(y)}</option>`,
	).join("");
	const learnerOptions = view.learners
		.map((l) => ui`<option value="${esc(l.id)}">${esc(l.displayName)}</option>`)
		.join("");
	const targets = [
		...view.learners.map(
			(l) => ui`<option value="learner:${esc(l.id)}">Leerling: ${esc(l.displayName)}</option>`,
		),
		...view.groups.map((g) => ui`<option value="group:${esc(g.id)}">Groep: ${esc(g.name)}</option>`),
	].join("");

	const learners = view.learners.length
		? ui`<ul class="requests">${view.learners
				.map(
					(l) =>
						ui`<li><p><strong>${esc(l.displayName)}</strong> · ${YEAR(l.schoolYear)}</p>${button("/beheer/leerlingen/archiveren", { learner: l.id }, tr("Archiveren"), csrf)}</li>`,
				)
				.join("")}</ul>`
		: ui`<p>Nog geen leerlingen.</p>`;
	const groups = view.groups.length
		? ui`<ul class="requests">${view.groups
				.map((g) => {
					const members = membersOf(g.id);
					return ui`<li><p><strong>${esc(g.name)}</strong> · ${members.length} leerling(en)${
						members.length
							? `: ${members.map((m) => esc(learnerName.get(m.learnerId))).join(", ")}`
							: ""
					}</p>${members
						.map((m) =>
							button(
								"/beheer/groepen/verwijderen",
								{ group: g.id, learner: m.learnerId },
								tr`${esc(learnerName.get(m.learnerId))} uit groep halen`,
								csrf,
							),
						)
						.join("")}${
						learnerOptions
							? ui`<form method="post" action="/beheer/groepen/toevoegen" class="inline"><input type="hidden" name="group" value="${esc(g.id)}"><label>Leerling toevoegen <select name="learner">${learnerOptions}</select></label>${csrfField(csrf)}<button>Toevoegen</button></form>`
							: ""
					}${button("/beheer/groepen/archiveren", { group: g.id }, tr("Groep archiveren"), csrf)}</li>`;
				})
				.join("")}</ul>`
		: ui`<p>Nog geen groepen.</p>`;
	const links = view.links.length
		? ui`<ul class="requests">${view.links
				.map(
					(k) =>
						ui`<li><p><strong>${who(k.adultSub)}</strong> → ${
							k.learnerId
								? ui`leerling <strong>${esc(learnerName.get(k.learnerId) ?? tr("(gearchiveerd)"))}</strong>`
								: ui`groep <strong>${esc(groupName.get(k.groupId) ?? tr("(gearchiveerd)"))}</strong>`
						}</p>${button("/beheer/koppelingen/intrekken", { link: k.id }, tr("Koppeling intrekken"), csrf)}</li>`,
				)
				.join("")}</ul>`
		: ui`<p>Nog geen koppelingen.</p>`;
	const grants = view.grants.length
		? ui`<ul class="requests">${view.grants
				.map(
					(r) =>
						ui`<li><p><strong>${who(r.adultSub)}</strong>: ${esc(tr(CAPABILITY[r.capability] ?? r.capability))}</p>${button("/beheer/rechten/intrekken", { grant: r.id }, tr("Recht intrekken"), csrf)}</li>`,
				)
				.join("")}</ul>`
		: ui`<p>Nog geen extra rechten.</p>`;

	return ui`Leerlingen hebben (nog) geen eigen account. Een leerlingprofiel bevat alleen een voornaam of bijnaam en het jaar. Vul nooit een diagnose of andere gevoelige gegevens in.</p>
<h2>Leerlingen</h2>${learners}
<form method="post" action="/beheer/leerlingen/nieuw"><label>Voornaam of bijnaam <input name="displayName" required maxlength="40"></label><label>Jaar <select name="schoolYear">${years}</select></label>${csrfField(csrf)}<button>Leerling toevoegen</button></form>
<h2>Groepen</h2>${groups}
<form method="post" action="/beheer/groepen/nieuw"><label>Naam van de groep <input name="name" required maxlength="60"></label>${csrfField(csrf)}<button>Groep maken</button></form>
<h2>Koppelingen</h2><p>Een ouder of begeleider ziet alleen de leerlingen die je aan hen koppelt; een leerkracht of begeleider ziet de leerlingen van de groepen die je aan hen koppelt. Je kunt jezelf niet koppelen.</p>${links}
${!targets ? ui`<p>Maak eerst een leerling of groep.</p>` : !adults.length ? ui`<p>Er zijn nog geen goedgekeurde ouders, begeleiders of leerkrachten. Keur eerst een aanvraag goed bij <a href="/beheer">Toegang beheren</a>.</p>` : ui`<form method="post" action="/beheer/koppelingen/nieuw">${peopleSelect(tr("Wie"))}<label>Koppelen aan <select name="target">${targets}</select></label>${csrfField(csrf)}<button>Koppeling maken</button></form>`}
<h2>Extra rechten</h2><p>Nakijken en publiceren horen bij geen enkele rol vanzelf. Geef ze alleen aan wie dat werk doet.</p>${grants}
${adults.length ? "" : ui`<p>Er zijn nog geen leden om een recht aan te geven.</p>`}<form method="post" action="/beheer/rechten/toekennen"${adults.length ? "" : " hidden"}>${peopleSelect(tr("Wie"))}<label>Recht <select name="capability">${GRANTABLE.map((c) => ui`<option value="${c}">${tr(CAPABILITY[c])}</option>`).join("")}</select></label>${csrfField(csrf)}<button>Recht toekennen</button></form><p><a href="/beheer">Terug naar Toegang beheren</a>`;
}

/** The adult's own page: only what the directory lets them see. */
export function learnersPage(learners, groups) {
	const list = learners.length
		? ui`<ul>${learners.map((l) => ui`<li>${esc(l.displayName)} · ${YEAR(l.schoolYear)}</li>`).join("")}</ul>`
		: ui`<p>Er zijn nog geen leerlingen aan jou gekoppeld. Een beheerder van Breinhap koppelt je aan je leerlingen of groepen.</p>`;
	const groupList = groups.length
		? ui`<h2>Mijn groepen</h2><ul>${groups.map((g) => ui`<li>${esc(g.name)} · ${g.size} leerling(en)</li>`).join("")}</ul>`
		: "";
	return ui`Hier zie je alleen de leerlingen die aan jou gekoppeld zijn.</p><h2>Mijn leerlingen</h2>${list}${groupList}<p>`;
}

const one = (form, name) => {
	const all = form.getAll(name);
	return all.length === 1 && typeof all[0] === "string" ? all[0] : null;
};

/** The adult behind an account code, as their CURRENT membership says, or null. */
async function adultOf(store, subject) {
	if (!subject) return null;
	const membership = await store.membership(subject);
	if (membership?.active !== true) return null;
	if (membership.role === "breinhap.admin" || SELF_SERVICE_ROLES.includes(membership.role))
		return { sub: subject, role: membership.role };
	return null;
}

/**
 * Runs one administrator action from its form. Returns `null` for a path this module does not own,
 * else `{ ok: true }` or `{ error: code }`. Permission is the directory's call, with the principal
 * the server resolved for this request.
 */
export async function adminDirectoryAction(path, form, { directory, principal, store }) {
	const actions = {
		"/beheer/leerlingen/nieuw": () =>
			directory.createLearner(principal, {
				displayName: one(form, "displayName"),
				schoolYear: one(form, "schoolYear"),
			}),
		"/beheer/leerlingen/archiveren": () => directory.archiveLearner(principal, one(form, "learner")),
		"/beheer/groepen/nieuw": () => directory.createGroup(principal, { name: one(form, "name") }),
		"/beheer/groepen/archiveren": () => directory.archiveGroup(principal, one(form, "group")),
		"/beheer/groepen/toevoegen": () =>
			directory.addToGroup(principal, { groupId: one(form, "group"), learnerId: one(form, "learner") }),
		"/beheer/groepen/verwijderen": () =>
			directory.removeFromGroup(principal, {
				groupId: one(form, "group"),
				learnerId: one(form, "learner"),
			}),
		"/beheer/koppelingen/nieuw": async () => {
			const target = /^(learner|group):([0-9a-f-]{36})$/.exec(one(form, "target") ?? "");
			if (!target) throw new DirectoryError("invalid");
			const subject = one(form, "subject")?.trim();
			const adult = subject === principal.sub ? principal : await adultOf(store, subject);
			return directory.link(principal, adult, {
				[target[1] === "learner" ? "learnerId" : "groupId"]: target[2],
			});
		},
		"/beheer/koppelingen/intrekken": () => directory.unlink(principal, one(form, "link")),
		"/beheer/rechten/toekennen": async () => {
			const subject = one(form, "subject")?.trim();
			const adult = subject === principal.sub ? principal : await adultOf(store, subject);
			return directory.grantCapability(principal, adult, one(form, "capability"));
		},
		"/beheer/rechten/intrekken": () => directory.revokeCapability(principal, one(form, "grant")),
	};
	const action = actions[path];
	if (!action) return null;
	try {
		await action();
		return { ok: true };
	} catch (error) {
		if (error instanceof DirectoryError) return { error: error.code };
		throw error;
	}
}
