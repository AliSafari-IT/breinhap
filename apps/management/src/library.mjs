import { tr, ui, uiLocale, formatLocale } from "./workspace-i18n.mjs";
import { ContentError } from "./content.mjs";
import { esc } from "./directory-pages.mjs";
import { SCHEMA_VERSION } from "./vendor/content-schema.mjs";

/**
 * The content library and mission editor (breinhap#27): plain server-rendered forms that work with the
 * keyboard and without JavaScript. Field names ARE the schema paths ("missions.0.practice.1.prompt"),
 * so every validation issue lands on its own field. The page re-renders what the person typed on any
 * error, and a save over a newer version is shown as a conflict, never applied.
 */

export const SUBJECTS = Object.freeze([
	["wiskunde", "Wiskunde"],
	["biologie", "Biologie"],
	["chemie", "Chemie"],
	["fysica", "Fysica"],
	["nederlands", "Nederlands"],
	["engels", "Engels"],
	["frans", "Frans"],
	["aardrijkskunde", "Aardrijkskunde"],
	["geschiedenis", "Geschiedenis"],
	["economie", "Economie"],
	["digitale-vaardigheden", "Digitale vaardigheden"],
]);
const SUBJECT_NAME = Object.fromEntries(SUBJECTS);

/** Slots per list, the schema's maximums. */
export const SLOTS = Object.freeze({
	learn: 4,
	practice: 4,
	check: 3,
	options: 4,
	items: 6,
	commonMistakes: 4,
	missions: 12,
});

const YEAR = (y) => uiLocale() === "nl" ? `${y}${y === 1 ? "ste" : "de"} jaar` : tr("Jaar {0}", y);

/** What the library shows for an object: its draft, and where its latest revision stands. */
export function stateOf(row) {
	if (row.publicationState === "active")
		return { label: tr`Gepubliceerd · revisie ${row.publicationRevision}`, tone: "ok" };
	if (row.publicationState === "withdrawn")
		return { label: tr`Publicatie ingetrokken · revisie ${row.publicationRevision}`, tone: "pending" };
	if (!row.latestRevision) return { label: tr("Concept"), tone: "draft" };
	if (row.latestDecision === "approved") {
		if (row.draftChanged)
			return { label: tr`Revisie ${row.latestRevision} goedgekeurd · concept gewijzigd`, tone: "pending" };
		return { label: tr`Revisie ${row.latestRevision} goedgekeurd`, tone: "ok" };
	}
	if (row.latestDecision === "changes_requested")
		return { label: tr`Revisie ${row.latestRevision}: aanpassen`, tone: "pending" };
	if (row.latestSubmittedAt)
		return { label: tr`Revisie ${row.latestRevision} ter nakijking`, tone: "pending" };
	return { label: tr`Revisie ${row.latestRevision} vastgelegd`, tone: "draft" };
}

// ── form → learning object ──────────────────────────────────────────────────────────────────────

const text = (form, name) => {
	const value = form.get(name);
	return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : "";
};

/**
 * Builds a learning object from the editor's fields. Empty slots are left out; `paths` maps each
 * compact schema path ("missions.0.practice.1") back to the form slot it came from, so an issue on the
 * object is shown on the right field. Returns `{ object, sources, paths, values }`; `values` is the form
 * as typed, to re-render it unchanged after an error.
 */
export function fromForm(form, fixedId) {
	const values = Object.fromEntries([...form.keys()].map((key) => [key, text(form, key)]));
	const paths = new Map();
	const map = (compact, original) => paths.set(compact, original);
	const id = fixedId ?? text(form, "id");
	const object = {
		schemaVersion: SCHEMA_VERSION,
		id,
		subject: text(form, "subject"),
		title: text(form, "title"),
		grade: Number(text(form, "grade")),
		curriculum: {
			leerdoel: text(form, "curriculum.leerdoel"),
			references: text(form, "curriculum.references")
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean),
		},
		review: { status: "draft" },
		missions: [],
	};
	for (let m = 0; m < SLOTS.missions; m++) {
		const at = (name) => `missions.${m}.${name}`;
		if (!form.has(at("title")) || form.get(at("remove")) === "1") continue;
		const filled = [...form.keys()].some((key) => key.startsWith(`missions.${m}.`) && key !== at("minutes") && text(form, key));
		if (!filled) continue;
		const mi = object.missions.length;
		map(`missions.${mi}`, `missions.${m}`);
		const list = (name, size, build, isEmpty) => {
			const out = [];
			for (let s = 0; s < size; s++) {
				const item = build(`missions.${m}.${name}.${s}`);
				if (isEmpty(item)) continue;
				map(`missions.${mi}.${name}.${out.length}`, `missions.${m}.${name}.${s}`);
				out.push(item);
			}
			return out;
		};
		const card = (prefix) => {
			const c = { text: text(form, `${prefix}.text`) };
			const example = text(form, `${prefix}.example`);
			if (example) c.example = example;
			return c;
		};
		const question = (prefix, compactPrefix) => {
			const kind = text(form, `${prefix}.kind`) === "order" ? "order" : "choice";
			const base = { kind, prompt: text(form, `${prefix}.prompt`), explanation: text(form, `${prefix}.explanation`) };
			if (kind === "choice") {
				const options = [];
				let answerIndex = -1;
				const chosen = text(form, `${prefix}.answerIndex`);
				for (let o = 0; o < SLOTS.options; o++) {
					const option = text(form, `${prefix}.options.${o}`);
					if (!option) continue;
					if (chosen === String(o)) answerIndex = options.length;
					options.push(option);
				}
				return { ...base, options, answerIndex };
			}
			const items = [];
			for (let i = 0; i < SLOTS.items; i++) {
				const item = text(form, `${prefix}.items.${i}`);
				if (item) items.push(item);
			}
			return { ...base, items };
		};
		const questionEmpty = (prefix) =>
			[...form.keys()].every(
				(key) => !key.startsWith(`${prefix}.`) || key === `${prefix}.kind` || !text(form, key),
			);
		const questions = (name, size) => {
			const out = [];
			for (let s = 0; s < size; s++) {
				const prefix = `missions.${m}.${name}.${s}`;
				if (questionEmpty(prefix)) continue;
				map(`missions.${mi}.${name}.${out.length}`, prefix);
				out.push(question(prefix));
			}
			return out;
		};
		object.missions.push({
			id: text(form, at("id")) || `${id}-m${m + 1}`,
			title: text(form, at("title")),
			minutes: Number(text(form, at("minutes")) || 3),
			warmup: card(at("warmup")),
			learn: list("learn", SLOTS.learn, card, (c) => !c.text && !c.example),
			practice: questions("practice", SLOTS.practice),
			check: questions("check", SLOTS.check),
			commonMistakes: list(
				"commonMistakes",
				SLOTS.commonMistakes,
				(prefix) => ({ mistake: text(form, `${prefix}.mistake`), why: text(form, `${prefix}.why`) }),
				(c) => !c.mistake && !c.why,
			),
		});
	}
	const sources = [];
	for (let s = 0; s < 4; s++) {
		const title = text(form, `sources.${s}.title`);
		if (!title) continue;
		const url = text(form, `sources.${s}.url`);
		sources.push({ kind: text(form, `sources.${s}.kind`) || "own", title, ...(url ? { url } : {}) });
	}
	return { object, sources, paths, values };
}

/** A schema issue path on the compact object, as the form field it came from. */
export function fieldOf(path, paths) {
	const parts = path.split(".").filter((p) => p !== "");
	let field = "";
	for (let i = 0; i < parts.length; i++) {
		const compact = parts.slice(0, i + 1).join(".");
		if (paths.has(compact)) field = paths.get(compact);
		else field = field ? `${field}.${parts[i]}` : parts[i];
	}
	return field || "form";
}

// ── learning object → form values ───────────────────────────────────────────────────────────────

/** The editor's field values for a stored object (the inverse of fromForm, slot for slot). */
export function toValues(object, sources = []) {
	const v = {
		id: object.id,
		subject: object.subject,
		title: object.title,
		grade: String(object.grade),
		"curriculum.leerdoel": object.curriculum?.leerdoel ?? "",
		"curriculum.references": (object.curriculum?.references ?? []).join("\n"),
	};
	(object.missions ?? []).forEach((mission, m) => {
		const at = (name) => `missions.${m}.${name}`;
		v[at("id")] = mission.id;
		v[at("title")] = mission.title;
		v[at("minutes")] = String(mission.minutes);
		v[at("warmup.text")] = mission.warmup?.text ?? "";
		v[at("warmup.example")] = mission.warmup?.example ?? "";
		mission.learn.forEach((card, c) => {
			v[at(`learn.${c}.text`)] = card.text;
			v[at(`learn.${c}.example`)] = card.example ?? "";
		});
		for (const name of ["practice", "check"])
			mission[name].forEach((q, i) => {
				const p = at(`${name}.${i}`);
				v[`${p}.kind`] = q.kind;
				v[`${p}.prompt`] = q.prompt;
				v[`${p}.explanation`] = q.explanation;
				if (q.kind === "choice") {
					q.options.forEach((option, o) => {
						v[`${p}.options.${o}`] = option;
					});
					v[`${p}.answerIndex`] = String(q.answerIndex);
				} else
					q.items.forEach((item, o) => {
						v[`${p}.items.${o}`] = item;
					});
			});
		(mission.commonMistakes ?? []).forEach((c, i) => {
			v[at(`commonMistakes.${i}.mistake`)] = c.mistake;
			v[at(`commonMistakes.${i}.why`)] = c.why;
		});
	});
	sources.forEach((s, i) => {
		v[`sources.${i}.kind`] = s.kind;
		v[`sources.${i}.title`] = s.title;
		v[`sources.${i}.url`] = s.url ?? "";
	});
	return v;
}

/** A field name as a person reads it: "Missie 1 · Oefenvraag 2 · Optie 3". */
export function labelOf(field) {
	const names = {
		id: tr("Code"), title: tr("Titel"), subject: tr("Vak"), grade: tr("Jaar"), form: tr("Leerobject"), missions: tr("Missies"),
		curriculum: tr("Leerplan"), leerdoel: tr("Leerdoel"), references: tr("Verwijzingen"), warmup: tr("Opwarmer"),
		learn: tr("Uitlegkaart"), practice: tr("Oefenvraag"), check: tr("Checkvraag"), options: tr("Optie"), items: tr("Stap"),
		prompt: tr("Vraag"), explanation: tr("Uitleg"), answerIndex: tr("Juist antwoord"), minutes: tr("Minuten"),
		text: tr("Tekst"), example: tr("Voorbeeld"), commonMistakes: tr("Veelgemaakte fout"), mistake: tr("Fout"), why: tr("Waarom"),
		sources: tr("Bron"), url: tr("Link"), kind: tr("Soort"),
	};
	const parts = field.split(".");
	const out = [];
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const next = parts[i + 1];
		if (part === "missions" && /^\d+$/.test(next ?? "")) {
			out.push(tr`Missie ${Number(next) + 1}`);
			i++;
		} else if (/^\d+$/.test(next ?? "") && names[part]) {
			out.push(`${names[part]} ${Number(next) + 1}`);
			i++;
		} else out.push(names[part] ?? part);
	}
	return out.join(" · ");
}

/** The schema's message for an issue, in Dutch and saying what to do. */
export function messageOf(issue) {
	if (issue.path.endsWith("answerIndex")) return tr("Kies welke ingevulde optie het juiste antwoord is.");
	switch (issue.code) {
		case "too_small":
			return issue.origin === "array" ? tr`Vul er minstens ${issue.minimum} in.` : issue.origin === "number" ? tr`Minstens ${issue.minimum}.` : tr("Vul dit in.");
		case "too_big":
			return issue.origin === "array" || issue.origin === "number" ? tr`Hoogstens ${issue.maximum}.` : tr("Dit is te lang.");
		case "invalid_format":
			return tr("Gebruik alleen kleine letters, cijfers en streepjes (bv. prikkel-reactie).");
		case "invalid_value":
			return tr("Kies een van de mogelijke waarden.");
		case "invalid_type":
			return tr("Vul dit in.");
		default:
			return issue.message === "order items must be unique" ? tr("Gebruik elk stukje maar één keer.")
				: issue.path === "missions" ? tr("Gebruik voor elke missie een unieke code.")
					: tr("Controleer wat je invulde.");
	}
}

// ── rendering ───────────────────────────────────────────────────────────────────────────────────

const fieldId = (name) => `f-${name.replace(/[^A-Za-z0-9_-]/g, "-")}`;

/** One labelled input (or textarea) with its error, linked for screen readers. */
function input(name, label, values, errors, { area = false, required = false, type = "text", max = 2000, hint = "" } = {}) {
	const id = fieldId(name);
	const error = errors[name];
	const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ");
	const attrs = `id="${id}" name="${esc(name)}"${required ? " required" : ""}${describedBy ? ` aria-describedby="${describedBy}"` : ""}${error ? ' aria-invalid="true"' : ""}`;
	const value = values[name] ?? "";
	const control = area
		? ui`<textarea ${attrs} maxlength="${max}" rows="3">${esc(value)}</textarea>`
		: ui`<input ${attrs} type="${type}" value="${esc(value)}"${type === "text" ? ` maxlength="${max}"` : ""}>`;
	return ui`<div class="field${error ? " invalid" : ""}"><label for="${id}">${label}</label>${hint ? ui`<small id="${id}-hint">${hint}</small>` : ""}${control}${error ? ui`<p class="error" id="${id}-error">${esc(error)}</p>` : ""}</div>`;
}

function select(name, label, options, values, errors) {
	const id = fieldId(name);
	const error = errors[name];
	return ui`<div class="field${error ? " invalid" : ""}"><label for="${id}">${label}</label><select id="${id}" name="${esc(name)}"${error ? ` aria-invalid="true" aria-describedby="${id}-error"` : ""}>${options
		.map(([value, text]) => ui`<option value="${esc(value)}"${String(values[name] ?? "") === String(value) ? " selected" : ""}>${esc(tr(text))}</option>`)
		.join("")}</select>${error ? ui`<p class="error" id="${id}-error">${esc(error)}</p>` : ""}</div>`;
}

function questionFields(prefix, label, values, errors) {
	const radios = Array.from({ length: SLOTS.options }, (_, o) => {
		const id = fieldId(`${prefix}.answerIndex.${o}`);
		return ui`<label for="${id}" class="answer"><input type="radio" id="${id}" name="${prefix}.answerIndex" value="${o}"${values[`${prefix}.answerIndex`] === String(o) ? " checked" : ""}> Optie ${o + 1} is juist</label>`;
	}).join("");
	const answerError = errors[`${prefix}.answerIndex`];
	return ui`<fieldset class="question"><legend>${label}</legend>
${select(`${prefix}.kind`, tr("Soort vraag"), [["choice", tr("Meerkeuze")], ["order", tr("In de juiste volgorde zetten")]], values, errors)}
${input(`${prefix}.prompt`, tr("Vraag"), values, errors, { area: true, max: 1000 })}
<fieldset><legend>Bij meerkeuze: 2 tot 4 opties en het juiste antwoord</legend>${Array.from({ length: SLOTS.options }, (_, o) => input(`${prefix}.options.${o}`, tr`Optie ${o + 1}`, values, errors, { max: 300 })).join("")}<div class="answers" role="group" aria-label="Juist antwoord">${radios}</div>${answerError ? ui`<p class="error">${esc(answerError)}</p>` : ""}${errors[`${prefix}.options`] ? ui`<p class="error">${esc(errors[`${prefix}.options`])}</p>` : ""}</fieldset>
<fieldset><legend>Bij volgorde: 2 tot 6 stappen, in de juiste volgorde</legend>${Array.from({ length: SLOTS.items }, (_, i) => input(`${prefix}.items.${i}`, tr`Stap ${i + 1}`, values, errors, { max: 300 })).join("")}${errors[`${prefix}.items`] ? ui`<p class="error">${esc(errors[`${prefix}.items`])}</p>` : ""}</fieldset>
${input(`${prefix}.explanation`, tr("Uitleg na het antwoord (waarom het juist is, nooit alleen 'fout')"), values, errors, { area: true, max: 1000 })}
</fieldset>`;
}

function missionFields(m, values, errors, isNew) {
	const at = (name) => `missions.${m}.${name}`;
	const listError = (name) => (errors[at(name)] ? ui`<p class="error">${esc(errors[at(name)])}</p>` : "");
	return ui`<fieldset class="mission"><legend>${isNew ? tr("Nieuwe missie (laat leeg als je er geen wilt toevoegen)") : tr`Missie ${m + 1}`}</legend>
${input(at("title"), tr("Titel van de missie"), values, errors, { max: 200 })}
${input(at("id"), tr("Missiecode"), values, errors, { max: 80, hint: tr("Kleine letters, cijfers en streepjes. Leeg: wordt gemaakt uit de code van het leerobject.") })}
${input(at("minutes"), tr("Minuten (2 tot 6)"), values, errors, { type: "number" })}
<h3>Opwarmen</h3>${input(at("warmup.text"), tr("Opwarmer"), values, errors, { area: true })}${input(at("warmup.example"), "Voorbeeld (optioneel)", values, errors, { area: true })}
<h3>Leren: 1 tot 4 uitlegkaarten</h3>${listError("learn")}${Array.from({ length: SLOTS.learn }, (_, c) => `${input(at(`learn.${c}.text`), tr`Kaart ${c + 1}`, values, errors, { area: true })}${input(at(`learn.${c}.example`), tr`Voorbeeld bij kaart ${c + 1} (optioneel)`, values, errors, { area: true })}`).join("")}
<h3>Doen: 1 tot 4 oefenvragen</h3>${listError("practice")}${Array.from({ length: SLOTS.practice }, (_, q) => questionFields(at(`practice.${q}`), tr`Oefenvraag ${q + 1}`, values, errors)).join("")}
<h3>Check: 1 tot 3 vragen</h3>${listError("check")}${Array.from({ length: SLOTS.check }, (_, q) => questionFields(at(`check.${q}`), tr`Checkvraag ${q + 1}`, values, errors)).join("")}
<h3>Veelgemaakte fouten (optioneel)</h3>${Array.from({ length: SLOTS.commonMistakes }, (_, c) => `${input(at(`commonMistakes.${c}.mistake`), tr`Fout ${c + 1}`, values, errors, { max: 500 })}${input(at(`commonMistakes.${c}.why`), tr`Waarom ${c + 1}`, values, errors, { max: 500 })}`).join("")}
${isNew ? "" : ui`<label class="remove"><input type="checkbox" name="${at("remove")}" value="1"> Deze missie verwijderen bij het opslaan</label>`}
</fieldset>`;
}

/**
 * The editor. `values` are the fields to show (stored or as typed), `errors` field → message,
 * `notice` an alert above the form. New objects get the id field; existing ones keep theirs. `hidden`
 * fields travel with the form (breinhap#31: the extraction a new draft is made from).
 */
export function editorPage({ values, errors = {}, notice = "", csrf, id, version, revisions = [], publications = [], draftChanged = false, canPublish = false, hidden = {} }) {
	const missionCount = Math.max(
		0,
		...Object.keys(values)
			.map((key) => /^missions\.(\d+)\./.exec(key)?.[1])
			.filter((n) => n !== undefined)
			.map((n) => Number(n) + 1),
	);
	const slots = Math.min(SLOTS.missions, missionCount + 1);
	const errorCount = Object.keys(errors).length;
	const publicationOf = (revision) =>
		publications.find((publication) => publication.revision === revision && publication.state === "active") ??
		publications.find((publication) => publication.revision === revision) ??
		null;
	const activePublication = publications.find((publication) => publication.state === "active") ?? null;
	const publicationNotice = canPublish
		? activePublication
			? ui`<div class="notice" role="status"><p>${tr`Gepubliceerd: revisie ${activePublication.revision} (packversie ${activePublication.version}).`}</p></div>`
			: ui`<p>${tr("Nog geen actieve publicatie.")}</p>`
		: "";
	const publicationAction = (revision) => {
		const publication = publicationOf(revision);
		if (publication?.state === "active")
			return ui`<form method="post" action="/bibliotheek/publicaties/${esc(id)}/intrekken"><input type="hidden" name="csrf" value="${esc(csrf)}"><button>${tr("Intrekken")}</button></form>`;
		if (publication)
			return ui`<form method="post" action="/bibliotheek/publicaties/${esc(id)}/herstellen"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="revision" value="${revision}"><button>${tr("Opnieuw publiceren")}</button></form>`;
		return ui`<form method="post" action="/bibliotheek/publicaties/${esc(id)}/publiceren"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="revision" value="${revision}"><button>${tr("Publiceren")}</button></form>`;
	};
	const history = id
		? ui`<p><a href="/bibliotheek/${esc(id)}/voorbeeld">Voorbeeld bekijken zoals een leerling</a> <small>(het laatst opgeslagen concept)</small></p>${
				draftChanged
					? ui`<div class="notice" role="status"><p>${tr("Je concept is gewijzigd na de laatste revisie. Leg een nieuwe revisie vast en bied die aan ter nakijking.")}</p></div>`
					: ""
			}${publicationNotice}<h2>Geschiedenis</h2>${
				revisions.length
					? ui`<ol class="history">${revisions
							.map((r) => {
								const status = r.decision === "approved" ? tr("goedgekeurd") : r.decision === "changes_requested" ? tr("aanpassen gevraagd") : tr("nog niet nagekeken");
								const publication = publicationOf(r.revision);
								const publicationStatus = publication
									? publication.state === "active"
										? tr` · gepubliceerd (packversie ${publication.version})`
										: publication.state === "withdrawn"
											? tr` · publicatie ingetrokken`
											: tr` · vervangen`
									: "";
								const offered = r.submittedAt ? ui` <span>${tr`Ingediend op ${new Date(r.submittedAt).toLocaleString(formatLocale(), { timeZone: "Europe/Brussels" })}.`}</span>` : "";
								const decided = r.decision
									? ui` <span>${r.decision === "approved" ? tr`Goedgekeurd door ${r.reviewer}.` : tr`Aanpassingen gevraagd door ${r.reviewer}.`}</span>`
									: "";
								const note = r.comment ? ui`<blockquote>${esc(r.comment)}</blockquote>` : "";
								const canOffer =
									!r.decision &&
									!r.submittedAt &&
									r.revision === revisions[0]?.revision &&
									r.sourceVersion === version;
								const offer = canOffer
									? ui`<form method="post" action="/bibliotheek/${esc(id)}/aanbieden"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="revision" value="${r.revision}"><button>${tr("Ter nakijking aanbieden")}</button></form>`
									: "";
								const publish = canPublish && r.decision === "approved" ? publicationAction(r.revision) : "";
								return ui`<li>Revisie ${r.revision} · ${new Date(r.createdAt).toLocaleString(formatLocale(), { timeZone: "Europe/Brussels" })} · ${status}${publicationStatus} · <a href="/bibliotheek/${esc(id)}/voorbeeld?revisie=${r.revision}">Voorbeeld</a>${offered}${decided}${note}${offer}${publish}</li>`;
							})
							.join("")}</ol>`
					: ui`<p>Nog geen vastgelegde revisies. Leg een revisie vast wanneer de inhoud klaar is om na te kijken.</p>`
			}<form method="post" action="/bibliotheek/${esc(id)}/vastleggen"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="expectedVersion" value="${esc(version)}"><button>Revisie vastleggen</button></form>
<form method="post" action="/bibliotheek/${esc(id)}/dupliceren"><label>Code van de kopie <input name="newId" required maxlength="80" pattern="[a-z0-9]+(-[a-z0-9]+)*"></label><input type="hidden" name="csrf" value="${esc(csrf)}"><button>Dupliceren</button></form>
<form method="post" action="/bibliotheek/${esc(id)}/archiveren"><input type="hidden" name="csrf" value="${esc(csrf)}"><button>Archiveren</button></form><p><small>Archiveren verbergt het leerobject in je bibliotheek. Vastgelegde revisies en wat leerlingen al kregen, blijven bewaard.</small>`
		: "";
	// an error summary at the top, each item a link to its field (or the section that holds it)
	const summary = errorCount
		? ui`<div class="alert" role="alert" tabindex="-1" id="fouten"><p><strong>${errorCount} ${errorCount === 1 ? tr("punt moet") : tr("punten moeten")} nog aangepast worden.</strong> Wat je typte, is bewaard.</p><ul>${Object.entries(errors)
				.map(([field, message]) => ui`<li><a href="#${fieldId(field)}">${esc(labelOf(field))}</a>: ${esc(message)}</li>`)
				.join("")}</ul></div>`
		: "";
	return ui`${notice}${summary}</p>
<form method="post" action="${id ? `/bibliotheek/${esc(id)}` : "/bibliotheek/nieuw"}" class="editor" data-editor>
<input type="hidden" name="csrf" value="${esc(csrf)}">${id ? ui`<input type="hidden" name="expectedVersion" value="${esc(version)}">` : ""}${Object.entries(hidden)
		.map(([name, value]) => ui`<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
		.join("")}
<fieldset><legend>Leerobject</legend>
${id ? ui`<p>Code: <code>${esc(id)}</code></p>` : input("id", tr("Code"), values, errors, { required: true, max: 80, hint: tr("Kleine letters, cijfers en streepjes, bv. biologie-prikkel-reactie. Kan later niet meer veranderen.") })}
${input("title", tr("Titel"), values, errors, { required: true, max: 200 })}
${select("subject", tr("Vak"), SUBJECTS, values, errors)}
${select("grade", tr("Jaar"), [1, 2, 3, 4, 5, 6].map((y) => [String(y), YEAR(y)]), values, errors)}
${input("curriculum.leerdoel", tr("Leerdoel (in de woorden van de school)"), values, errors, { area: true, required: true })}
${input("curriculum.references", tr("Leerplan- of eindtermverwijzingen (één per regel, optioneel)"), values, errors, { area: true })}
</fieldset>
${Array.from({ length: slots }, (_, m) => missionFields(m, values, errors, m === slots - 1 && m >= missionCount)).join("")}
<fieldset><legend>Bronnen (alleen voor beheer, nooit voor leerlingen)</legend>${Array.from({ length: 4 }, (_, s) => `${select(`sources.${s}.kind`, tr`Soort bron ${s + 1}`, [["own", tr("Eigen werk")], ["book", tr("Boek")], ["website", tr("Website")], ["school_material", tr("Schoolmateriaal")]], values, errors)}${input(`sources.${s}.title`, tr`Bron ${s + 1}`, values, errors, { max: 200 })}${input(`sources.${s}.url`, tr`Link ${s + 1} (https, optioneel)`, values, errors, { type: "url", max: 500 })}`).join("")}</fieldset>
<p><button type="submit">Opslaan</button></p>
</form>
${history}<p>`;
}

/** The library: filters, then one row per object with its subject, year and state. */
export function libraryPage(rows, { q = "", subject = "", grade = "", notice = "", canReview = false, canPublish = false, canAssign = false, pending = 0 } = {}) {
	const list = rows.length
		? ui`<table class="library"><caption>Jouw leerobjecten</caption><thead><tr><th scope="col">Titel</th><th scope="col">Vak</th><th scope="col">Jaar</th><th scope="col">Status</th><th scope="col">Gewijzigd</th></tr></thead><tbody>${rows
				.map((row) => {
					const state = stateOf(row);
					return ui`<tr><td><a href="/bibliotheek/${esc(row.id)}">${esc(row.title)}</a></td><td>${esc(tr(SUBJECT_NAME[row.subject] ?? row.subject))}</td><td>${YEAR(row.grade)}</td><td><span class="state ${state.tone}">${esc(state.label)}</span></td><td>${new Date(row.updatedAt).toLocaleDateString(formatLocale(), { timeZone: "Europe/Brussels" })}</td></tr>`;
				})
				.join("")}</tbody></table>`
		: ui`<p>Geen leerobjecten gevonden.</p>`;
	return ui`${notice}</p><p><a href="/bibliotheek/bestanden">Bestanden</a>: lesmateriaal en afbeeldingen die je hebt opgeladen. <a href="/bibliotheek/importeren">Importeren</a>: leerobjecten uit een inhoudspakket of CSV-bestand.</p>${canReview ? ui`<p><a class="action" href="/bibliotheek/nakijken">${tr("Inhoud nakijken")}${pending ? ui` (${pending})` : ""}</a></p>` : ""}${canPublish ? ui`<p><a class="action" href="/bibliotheek/publicaties">${tr("Publicaties beheren")}</a></p>` : ""}${canAssign ? ui`<p><a class="action" href="/bibliotheek/toewijzen">${tr("Inhoud toewijzen")}</a></p>` : ""}<p><a class="action" href="/bibliotheek/packs">Oefenpakketten</a></p><form method="get" action="/bibliotheek" class="filters" role="search"><label>Zoeken in titels <input name="q" value="${esc(q)}" maxlength="100"></label><label>Vak <select name="vak"><option value="">Alle vakken</option>${SUBJECTS.map(([v, t]) => ui`<option value="${v}"${subject === v ? " selected" : ""}>${tr(t)}</option>`).join("")}</select></label><label>Jaar <select name="jaar"><option value="">Alle jaren</option>${[1, 2, 3, 4, 5, 6].map((y) => ui`<option value="${y}"${String(grade) === String(y) ? " selected" : ""}>${YEAR(y)}</option>`).join("")}</select></label><button>Filteren</button></form>
<p><a class="action" href="/bibliotheek/nieuw">Nieuw leerobject</a></p>${list}<p>`;
}

/** Turns a ContentError into the editor's field errors. */
export function errorsOf(error, paths) {
	const messages = {
		exists: ["id", tr("Deze code bestaat al in deze werkplek. Kies een andere.")],
		mission_exists: ["form", tr("Een missiecode bestaat al, hier of in een ander leerobject. Kies een andere missiecode.")],
		unsupported_version: ["form", tr("Deze inhoud is voor een andere schemaversie.")],
		id_changed: ["form", tr("De code van een leerobject kan niet veranderen.")],
	};
	if (messages[error.code]) return Object.fromEntries([messages[error.code]]);
	const out = {};
	for (const issue of error.issues ?? []) {
		const field = fieldOf(issue.path, paths);
		out[field] ??= messageOf(issue);
	}
	return Object.keys(out).length ? out : { form: tr("Controleer wat je invulde.") };
}

export { ContentError };
