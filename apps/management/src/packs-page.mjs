import { tr, ui, formatLocale } from "./workspace-i18n.mjs";
import { esc } from "./directory-pages.mjs";
import { SUBJECTS } from "./library.mjs";

/**
 * Pages of the practice-pack editor (breinhap#80). Server-rendered forms that work without
 * JavaScript. Every typed value is escaped; typed values survive validation and stale-save errors.
 * The adult workspace copy is Dutch like the library; the learner language is a pack declaration.
 */

const LANGUAGES = [
	["nl", "Nederlands"],
	["en", "English"],
	["fr", "Français"],
	["de", "Deutsch"],
];
const SUBJECT_NAME = Object.fromEntries(SUBJECTS);
const STATE = {
	published: ["Gepubliceerd", "ok"],
	approved: ["Goedgekeurd, nog niet gepubliceerd", "pending"],
	pending: ["Ter nakijking", "pending"],
	changes: ["Aanpassen gevraagd", "pending"],
	snapshot: ["Vastgelegd, nog niet aangeboden", "draft"],
	draft: ["Nog geen revisie", "draft"],
	missing: ["Niet beschikbaar", "draft"],
};
export const stateText = (key) => STATE[key] ?? STATE.missing;
const stateChip = (key) => {
	const [label, tone] = stateText(key);
	return ui`<span class="state ${tone}">${tr(label)}</span>`;
};
const date = (value) => new Date(value).toLocaleDateString(formatLocale(), { timeZone: "Europe/Brussels" });

export function packsListPage(rows, { q = "", subject = "", grade = "", notice = "", csrf }) {
	const list = rows.length
		? ui`<table class="library"><caption>Jouw oefenpakketten</caption><thead><tr><th scope="col">Titel</th><th scope="col">Vak</th><th scope="col">Jaar</th><th scope="col">Soort</th><th scope="col">Gewijzigd</th></tr></thead><tbody>${rows
				.map(
					(row) =>
						ui`<tr><td><a href="/bibliotheek/packs/${esc(row.id)}">${esc(row.title)}</a></td><td>${esc(tr(SUBJECT_NAME[row.subject] ?? row.subject))}</td><td>${esc(row.grade)}</td><td>${row.mode === "test" ? tr("Toets") : tr("Oefenen")}</td><td>${esc(date(row.updatedAt))}</td></tr>`,
				)
				.join("")}</tbody></table>`
		: ui`<p>Geen oefenpakketten gevonden.</p>`;
	void csrf;
	return ui`${notice}<form method="get" action="/bibliotheek/packs" class="filters" role="search"><label>Zoeken in titels <input name="q" value="${esc(q)}" maxlength="100"></label><label>Vak <select name="vak"><option value="">Alle vakken</option>${SUBJECTS.map(([v, t]) => ui`<option value="${v}"${subject === v ? " selected" : ""}>${tr(t)}</option>`).join("")}</select></label><label>Jaar <select name="jaar"><option value="">Alle jaren</option>${[1, 2, 3, 4, 5, 6].map((y) => ui`<option value="${y}"${String(grade) === String(y) ? " selected" : ""}>${y}</option>`).join("")}</select></label><button>Filteren</button></form><p><a class="action" href="/bibliotheek/packs/nieuw">Nieuw oefenpakket</a> <a href="/bibliotheek">Terug naar de bibliotheek</a></p>${list}`;
}

const fieldError = (errors, name) =>
	errors[name] ? ui`<p class="error" id="fout-${name}" role="alert">${esc(errors[name])}</p>` : "";
const invalid = (errors, name) => (errors[name] ? ` aria-invalid="true" aria-describedby="fout-${name}"` : "");

function missionOptions(sources, selected) {
	return sources
		.filter((s) => s.revision && s.valid)
		.map(
			(s) =>
				ui`<optgroup label="${esc(s.title)} (revisie ${s.revision})">${s.missions
					.map((m) => {
						const value = `${s.id}|${m.id}`;
						return ui`<option value="${esc(value)}"${selected === value ? " selected" : ""}>${esc(m.title)}</option>`;
					})
					.join("")}</optgroup>`,
		)
		.join("");
}

function questionChoices(sources, values, errors) {
	const chosen = new Set([].concat(values.vraag ?? []));
	const objects = new Set(["missie1", "missie2", "missie3"].map((k) => String(values[k] ?? "").split("|")[0]).filter(Boolean));
	const rows = [];
	for (const s of sources.filter((x) => objects.has(x.id))) {
		for (const m of s.missions)
			for (const [stage, list] of [["practice", m.practice], ["check", m.check]])
				list.forEach((prompt, index) => {
					const value = `${s.id}|${m.id}|${stage}|${index}`;
					rows.push(
						ui`<label class="option"><input type="checkbox" name="vraag" value="${esc(value)}"${chosen.has(value) ? " checked" : ""}> ${esc(s.title)} · ${esc(m.title)} · ${stage === "practice" ? tr("Doen") : tr("Check")} ${index + 1}: ${esc(prompt)}</label>`,
					);
				});
	}
	if (!rows.length)
		return ui`<p class="muted">Kies eerst een missie en sla op; daarna kun je hier vragen uit dezelfde leerobjecten toevoegen.</p>`;
	return ui`<fieldset><legend>Extra vragen (hoogstens 6)</legend>${rows.join("")}${fieldError(errors, "vraag")}</fieldset>`;
}

export function packEditorPage({ values, errors = {}, notice = "", csrf, id, version, sources = [], readiness, backups = "" }) {
	const v = (name) => esc(values[name] ?? "");
	const action = id ? `/bibliotheek/packs/${esc(id)}` : "/bibliotheek/packs/nieuw";
	const field = (name, label, control, hint = "") =>
		ui`<div class="field${errors[name] ? " invalid" : ""}"><label for="f-${name}">${label}</label>${control}${hint}${fieldError(errors, name)}</div>`;
	const select = (name, items, selected) =>
		ui`<select id="f-${name}" name="${name}"${invalid(errors, name)}>${items.map(([val, label]) => ui`<option value="${esc(val)}"${String(selected) === String(val) ? " selected" : ""}>${esc(label)}</option>`).join("")}</select>`;
	const missionSelect = (n) =>
		field(
			`missie${n}`,
			n === 1 ? tr("Missie 1 (verplicht)") : tr("Missie {0} (optioneel)", n),
			ui`<select id="f-missie${n}" name="missie${n}"${invalid(errors, `missie${n}`)}><option value="">${tr("— geen —")}</option>${missionOptions(sources, values[`missie${n}`])}</select>`,
		);
	const status = readiness
		? ui`<section class="card" aria-labelledby="bronnen"><h2 id="bronnen">Bronnen en delen</h2><ul>${readiness.items
				.map(
					(item) =>
						ui`<li>${esc(item.title)}: ${stateChip(item.state.key)}${item.newer ? ui` <em>Er is een nieuwere revisie (${item.revision}); sla het pakket op om die te gebruiken.</em>` : ""}</li>`,
				)
				.join("")}</ul>${
				readiness.shareable
					? ui`<p>Alle bronnen zijn gepubliceerd. Een pakket vastleggen en delen komt in een volgende stap.</p>`
					: ui`<p class="notice" role="note">Delen is uitgeschakeld tot elke bron onafhankelijk is nagekeken én gepubliceerd. Je kunt het pakket wel bewerken en bekijken als voorbeeld.</p>`
			}</section>`
		: "";
	const extra = id
		? ui`<p><a class="action" href="/bibliotheek/packs/${esc(id)}/voorbeeld">Voorbeeld bekijken</a> <a class="action" href="/bibliotheek/packs/${esc(id)}/links">Delen en links</a> <a class="action" href="/bibliotheek/packs/${esc(id)}/resultaten">Resultaten</a></p><div class="row-actions"><form method="post" action="/bibliotheek/packs/${esc(id)}/dupliceren"><input type="hidden" name="csrf" value="${esc(csrf)}"><button>Dupliceren</button></form><form method="post" action="/bibliotheek/packs/${esc(id)}/archiveren"><input type="hidden" name="csrf" value="${esc(csrf)}"><button>Archiveren</button></form></div>`
		: "";
	return ui`${notice}<form method="post" action="${action}" novalidate><input type="hidden" name="csrf" value="${esc(csrf)}">${id ? ui`<input type="hidden" name="expectedVersion" value="${version}">` : ""}${field("titel", tr("Titel"), ui`<input id="f-titel" name="titel" value="${v("titel")}" maxlength="120" required${invalid(errors, "titel")}>`)}${field("beschrijving", tr("Beschrijving"), ui`<textarea id="f-beschrijving" name="beschrijving" rows="2" maxlength="500"${invalid(errors, "beschrijving")}>${v("beschrijving")}</textarea>`)}${field("instructies", tr("Instructies voor de leerling"), ui`<textarea id="f-instructies" name="instructies" rows="3" maxlength="500"${invalid(errors, "instructies")}>${v("instructies")}</textarea>`, ui`<p class="muted">Gewone tekst, hoogstens 500 tekens.</p>`)}${field("vak", tr("Vak"), select("vak", SUBJECTS.map(([val, label]) => [val, tr(label)]), values.vak ?? SUBJECTS[0][0]))}${field("jaar", tr("Jaar"), select("jaar", [1, 2, 3, 4, 5, 6].map((y) => [y, y]), values.jaar ?? "3"))}${field("taal", tr("Taal van de inhoud"), select("taal", LANGUAGES, values.taal ?? "nl"), ui`<p class="muted">De taal waarin de leerling de inhoud leest. Er wordt niets automatisch vertaald.</p>`)}${field("modus", tr("Soort"), select("modus", [["practice", tr("Oefenen: meteen feedback")], ["test", tr("Toets: feedback na afloop")]], values.modus ?? "practice"))}${missionSelect(1)}${missionSelect(2)}${missionSelect(3)}${questionChoices(sources, values, errors)}${field("verloopDagen", tr("Standaard geldigheid van een link (dagen)"), ui`<input id="f-verloopDagen" name="verloopDagen" type="number" min="1" max="30" value="${v("verloopDagen") || "7"}"${invalid(errors, "verloopDagen")}>`, ui`<p class="muted">Geldt alleen voor links die je later maakt. Eén poging per link.</p>`)}<p><button type="submit">Opslaan</button></p></form>${status}${extra}${backups}`;
}

// ── sharing (breinhap#81) ────────────────────────────────────────────────────────────────────────

const LINK_STATUS = {
	active: ["Actief", "ok"],
	scheduled: ["Gepland", "pending"],
	used: ["Gebruikt (poging gestart)", "pending"],
	expired: ["Verlopen", "draft"],
	revoked: ["Ingetrokken", "draft"],
};
const dateTime = (value) =>
	new Date(value).toLocaleString(formatLocale(), { timeZone: "Europe/Brussels", dateStyle: "short", timeStyle: "short" });
const hiddenCsrf = (csrf) => ui`<input type="hidden" name="csrf" value="${esc(csrf)}">`;

/** The public learner URL. The token sits in the fragment only: it is never sent in an HTTP request line. */
export const learnerUrl = (secret) => `https://breinhap.com/p/#${secret}`;

export function packLinksPage({ id, pack, versions, links, readiness, csrf, nonce, notice = "" }) {
	const active = links.find((l) => l.active);
	const latest = versions[0];
	const freeze = readiness.shareable
		? ui`<form method="post" action="/bibliotheek/packs/${esc(id)}/vastleggen">${hiddenCsrf(csrf)}<input type="hidden" name="expectedVersion" value="${pack.version}"><p>Leg de huidige inhoud van dit pakket vast als een nieuwe, onveranderlijke versie. Latere wijzigingen aan het pakket of de bronnen veranderen een vastgelegde versie nooit.</p><p><button>Nieuwe versie vastleggen</button></p></form>`
		: ui`<p class="notice" role="note">Vastleggen en delen kan pas als elke bron onafhankelijk is nagekeken én gepubliceerd. <a href="/bibliotheek/packs/${esc(id)}">Bekijk de status van de bronnen</a>.</p>`;
	const versionList = versions.length
		? ui`<table class="library"><caption>Vastgelegde versies</caption><thead><tr><th scope="col">Versie</th><th scope="col">Vastgelegd</th></tr></thead><tbody>${versions
				.map((v) => ui`<tr><td>${v.version}</td><td>${esc(dateTime(v.createdAt))}</td></tr>`)
				.join("")}</tbody></table>`
		: ui`<p>Er is nog geen versie vastgelegd.</p>`;
	const mint =
		latest && !active
			? ui`<form method="post" action="/bibliotheek/packs/${esc(id)}/links/nieuw">${hiddenCsrf(csrf)}<input type="hidden" name="nonce" value="${esc(nonce)}"><input type="hidden" name="version" value="${latest.version}"><div class="field"><label for="f-dagen">Geldig voor (dagen)</label><input id="f-dagen" name="expiryDays" type="number" min="1" max="30" value="${esc(pack.draft.shareDefaults?.expiryDays ?? 7)}"></div><div class="field"><label for="f-vanaf">Pas beschikbaar vanaf (optioneel)</label><input id="f-vanaf" name="notBefore" type="date"></div><p>De link werkt voor één leerling en één poging. De link wordt maar één keer getoond.</p><p><button>Link maken voor versie ${latest.version}</button></p></form>`
			: latest
				? ui`<p>Er is al een actieve link. Maak een nieuwe link met “Nieuwe link maken” bij die link; de oude link stopt dan meteen.</p>`
				: "";
	const linkRows = links.length
		? ui`<table class="library"><caption>Links (zonder de link zelf; die is niet terug te halen)</caption><thead><tr><th scope="col">Versie</th><th scope="col">Status</th><th scope="col">Geldig tot</th><th scope="col">Pogingen</th><th scope="col">Laatst gebruikt</th><th scope="col">Acties</th></tr></thead><tbody>${links
				.map((l) => {
					const [label, tone] = LINK_STATUS[l.status] ?? LINK_STATUS.expired;
					const actions = l.active
						? ui`<form method="post" action="/bibliotheek/packs/${esc(id)}/links/${esc(l.id)}/roteren">${hiddenCsrf(csrf)}<input type="hidden" name="nonce" value="${esc(`${nonce}-${l.id.slice(0, 8)}`.slice(0, 190))}"><button>Nieuwe link maken</button></form><form method="post" action="/bibliotheek/packs/${esc(id)}/links/${esc(l.id)}/intrekken">${hiddenCsrf(csrf)}<button>Intrekken</button></form>`
						: "";
					return ui`<tr><td>${l.version}</td><td><span class="state ${tone}">${tr(label)}</span></td><td>${esc(dateTime(l.expiresAt))}</td><td>${l.attemptsStarted} van ${l.maxAttempts}</td><td>${l.lastUsedAt ? esc(dateTime(l.lastUsedAt)) : "—"}</td><td>${actions}</td></tr>`;
				})
				.join("")}</tbody></table>`
		: ui`<p>Er zijn nog geen links.</p>`;
	return ui`${notice}<p><a href="/bibliotheek/packs/${esc(id)}">Terug naar het oefenpakket</a></p><section class="card" aria-labelledby="vastleggen"><h2 id="vastleggen">Versie vastleggen</h2>${freeze}${versionList}</section><section class="card" aria-labelledby="link"><h2 id="link">Link voor de leerling</h2>${mint}${linkRows}</section>`;
}

/** The one and only display of a raw link. Plain selectable text first; the copy button is an enhancement. */
export function mintedPage({ id, url, expiresAt }) {
	return ui`<div class="notice" role="status"><p><strong>De link is gemaakt.</strong> Kopieer hem nu: hij wordt hier maar één keer getoond en is daarna niet meer terug te vinden. Verlies je hem, maak dan een nieuwe link; de oude stopt dan.</p></div><div class="field"><label for="f-link">Link voor de leerling</label><input id="f-link" class="pack-link" readonly value="${esc(url)}" size="60" data-select></div><p><button type="button" data-copy="f-link" data-copied="${esc(tr("Gekopieerd."))}" data-failed="${esc(tr("Kopiëren lukt niet. Selecteer de link en kopieer hem met je toetsenbord."))}" hidden>Kopieer de link</button> <span id="kopieerstatus" role="status"></span></p><p>Geldig tot ${esc(dateTime(expiresAt))}. Eén leerling, één poging. Deel de link alleen met die leerling of zijn ouder; wie de link heeft, kan beginnen.</p><p><a href="/bibliotheek/packs/${esc(id)}/links">Naar de links</a></p>`;
}

// ── results (breinhap#83) ────────────────────────────────────────────────────────────────────────

const ATTEMPT_STATUS = {
	active: ["Bezig", "pending"],
	submitted: ["Ingeleverd", "ok"],
	submitted_done: ["Ingeleverd en afgesloten", "ok"],
	abandoned: ["Afgesloten zonder inleveren", "draft"],
};
const duration = (minutes) => (minutes === null || minutes === undefined ? "—" : `${minutes} min`);

export function packResultsPage({ id, links, filter, results, csrf, notice = "" }) {
	const rows = results.attempts.length
		? ui`<table class="library"><caption>Pogingen</caption><thead><tr><th scope="col">Gestart</th><th scope="col">Status</th><th scope="col">Score</th><th scope="col">Duur</th><th scope="col">Versie</th><th scope="col">Bewaard tot</th></tr></thead><tbody>${results.attempts
				.map((a) => {
					const [label, tone] = ATTEMPT_STATUS[a.status] ?? ATTEMPT_STATUS.active;
					return ui`<tr><td><a href="/bibliotheek/packs/${esc(id)}/resultaten/${esc(a.id)}">${esc(dateTime(a.startedAt))}</a></td><td><span class="state ${tone}">${tr(label)}</span></td><td>${a.completedAt ? ui`${a.score} van ${a.questionCount}` : "—"}</td><td>${esc(duration(a.minutes))}</td><td>${a.version}</td><td>${esc(date(a.deleteAfter))}</td></tr>`;
				})
				.join("")}</tbody></table>`
		: ui`<p>Er zijn nog geen pogingen.</p>`;
	const filterForm = links.length > 1
		? ui`<form method="get" action="/bibliotheek/packs/${esc(id)}/resultaten" class="filters"><label>Link <select name="link"><option value="">Alle links</option>${links
				.map((l) => ui`<option value="${esc(l.id)}"${filter === l.id ? " selected" : ""}>${esc(dateTime(l.createdAt))} · versie ${l.version}</option>`)
				.join("")}</select></label><button>Filteren</button></form>`
		: "";
	const remove = results.attempts.length
		? ui`<form method="post" action="/bibliotheek/packs/${esc(id)}/resultaten/verwijderen"><input type="hidden" name="csrf" value="${esc(csrf)}"><label><input type="checkbox" name="bevestig" value="1" required> Ik wil alle antwoorden en pogingen van dit pakket verwijderen. Dit kan niet ongedaan worden gemaakt.</label><p><button>Alles verwijderen</button></p></form>`
		: "";
	return ui`${notice}<p><a href="/bibliotheek/packs/${esc(id)}">Terug naar het oefenpakket</a></p><p>${results.started} poging${results.started === 1 ? "" : "en"} gestart, ${results.completed} ingeleverd. De pogingen zijn anoniem: er is geen naam of e-mailadres bij. Antwoorden worden automatisch verwijderd 30 dagen nadat de poging begon. Verwijderen geeft de poging van een link niet terug: een link blijft één poging tellen.</p>${filterForm}${rows}${remove}`;
}

export function packAttemptPage({ id, attempt, csrf }) {
	const [label, tone] = ATTEMPT_STATUS[attempt.status] ?? ATTEMPT_STATUS.active;
	const items = attempt.items
		? ui`<ol class="review">${attempt.items
				.map((item) => {
					const mine = item.kind === "choice" ? item.options[item.chosen] : (item.placed ?? []).join(" → ");
					const right = item.kind === "choice" ? item.correctAnswer : item.correctAnswer.join(" → ");
					return ui`<li class="review-item"><h3>${esc(item.prompt)}</h3><p>Antwoord van de leerling: ${esc(mine ?? "—")}</p><p><span class="state ${item.correct ? "ok" : "pending"}">${item.correct ? tr("Klopt.") : tr("Nog niet.")}</span> Juist antwoord: ${esc(right)}</p><p class="muted">${esc(item.explanation)}</p></li>`;
				})
				.join("")}</ol>`
		: ui`<p class="notice" role="note">Deze poging is nog niet ingeleverd. Tot dan zie je alleen de status: geen antwoorden en geen tussentijds resultaat.</p>`;
	return ui`<p><a href="/bibliotheek/packs/${esc(id)}/resultaten">Terug naar de pogingen</a></p><p><span class="state ${tone}">${tr(label)}</span> Gestart ${esc(dateTime(attempt.startedAt))}${attempt.completedAt ? ui` · ingeleverd ${esc(dateTime(attempt.completedAt))} · score ${attempt.score} van ${attempt.questionCount} · duur ${esc(duration(attempt.minutes))}` : ""} · versie ${attempt.version} · bewaard tot ${esc(date(attempt.deleteAfter))}</p>${items}<form method="post" action="/bibliotheek/packs/${esc(id)}/resultaten/${esc(attempt.id)}/verwijderen"><input type="hidden" name="csrf" value="${esc(csrf)}"><label><input type="checkbox" name="bevestig" value="1" required> Ik wil deze poging en haar antwoorden verwijderen. Dit kan niet ongedaan worden gemaakt.</label><p><button>Poging verwijderen</button></p></form>`;
}
