import { decodeAnswers, encodeAnswers } from "../preview.mjs";
import { shuffleForDisplay } from "../vendor/content-pick.mjs";
import { isCorrect, isFinished, missionPages, scoreAnswers, validAnswer } from "../vendor/content-mission.mjs";
import { SUBJECTS } from "../library.mjs";
import { tr, withLocale } from "../workspace-i18n.mjs";
import { esc, layout } from "./pages.mjs";
import { t } from "./messages.mjs";

/**
 * breinhap#35: the public mission catalogue and player on breinhap.com (/p/missies). It shows only
 * objects a publisher listed whose current publication is active, and it stores nothing: no account,
 * no cookie, no attempt row. The whole state of a run (mission, page, answers) travels in the posted
 * form, so it never appears in a URL, browser history or a referrer, and closing the page ends it.
 * Tampering with that state can only change what this one visitor sees; there is nothing to record.
 * Verdicts use the shared mission rules (vendored packages/content), one card or question at a time
 * in the fixed Opwarmen → Leren → Doen → Check order, with no timer, streak or score history.
 */

export const CATALOGUE = "/p/missies";
const SUBJECT_CODES = new Set(SUBJECTS.map(([code]) => code));
const SUBJECT_LABEL = Object.fromEntries(SUBJECTS);
const MAX_STATE = 2000;

const subjectName = (lang, code) => withLocale(lang, () => tr(SUBJECT_LABEL[code] ?? code));
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${esc(value)}">`;

/** The catalogue filters a GET may carry. Anything else is dropped, never echoed. */
export function catalogueFilters(params) {
	const subject = params.get("vak");
	const grade = params.get("jaar");
	return {
		subject: SUBJECT_CODES.has(subject) ? subject : undefined,
		grade: /^[1-6]$/.test(grade ?? "") ? Number(grade) : undefined,
	};
}

/** GET /p/missies: the listed missions, with subject and year filters that also work without JavaScript. */
export function cataloguePage(lang, rows, { subject, grade } = {}) {
	const subjects = SUBJECTS.map(
		([code]) => `<option value="${code}"${code === subject ? " selected" : ""}>${esc(subjectName(lang, code))}</option>`,
	).join("");
	const years = [1, 2, 3, 4, 5, 6]
		.map((y) => `<option value="${y}"${y === grade ? " selected" : ""}>${esc(t(lang, "yearN", y))}</option>`)
		.join("");
	const filters = `<form method="get" action="${CATALOGUE}" class="filters"><div class="field"><label for="vak">${esc(t(lang, "subject"))}</label><select id="vak" name="vak"><option value="">${esc(t(lang, "allSubjects"))}</option>${subjects}</select></div><div class="field"><label for="jaar">${esc(t(lang, "year"))}</label><select id="jaar" name="jaar"><option value="">${esc(t(lang, "allYears"))}</option>${years}</select></div><p><button type="submit">${esc(t(lang, "filter"))}</button></p></form>`;
	const filtered = subject !== undefined || grade !== undefined;
	const list = rows.length
		? `<ul class="catalogue">${rows
				.map(
					(row) =>
						`<li class="card"><h2><a href="${CATALOGUE}/${esc(row.id)}">${esc(row.title)}</a></h2><p class="muted">${esc(subjectName(lang, row.subject))} · ${esc(t(lang, "yearN", row.grade))} · ${esc(t(lang, "missionCount", row.missions, row.minutes))}</p></li>`,
				)
				.join("")}</ul>`
		: `<p class="notice" role="status">${esc(t(lang, filtered ? "emptyFiltered" : "emptyCatalogue"))}</p>${filtered ? `<p><a href="${CATALOGUE}">${esc(t(lang, "showAll"))}</a></p>` : ""}`;
	return layout(lang, t(lang, "catalogueTitle"), `<p>${esc(t(lang, "catalogueIntro"))}</p>${filters}${list}`);
}

const stepList = (lang, step) =>
	`<ol class="steps" aria-label="${esc(t(lang, "step." + step))}">${["Opwarmen", "Leren", "Doen", "Check"]
		.map((s) => `<li${s === step ? ' aria-current="step"' : ""}>${esc(t(lang, "step." + s))}</li>`)
		.join("")}</ol>`;

const back = (lang) => `<p><a href="${CATALOGUE}">${esc(t(lang, "backToCatalogue"))}</a></p>`;

/** GET /p/missies/{id}: what the object is about, then one start button per mission. */
export function objectPage(lang, object) {
	const action = `${CATALOGUE}/${esc(object.id)}`;
	const missions = object.missions
		.map(
			(m, i) =>
				`<li class="card"><h2>${esc(m.title)}</h2><p class="muted">${esc(t(lang, "about", m.practice.length + m.check.length, m.minutes))}</p><form method="post" action="${action}">${hidden("missie", i)}${hidden("stap", 0)}${hidden("a", "")}<p><button type="submit">${esc(t(lang, "start"))}</button></p></form></li>`,
		)
		.join("");
	return layout(
		lang,
		object.title,
		`<p class="muted">${esc(subjectName(lang, object.subject))} · ${esc(t(lang, "yearN", object.grade))}</p><p>${esc(object.curriculum.leerdoel)}</p><p>${esc(t(lang, "stepsInfo"))}</p><p class="notice">${esc(t(lang, "publicPrivacy"))}</p><ul class="catalogue">${missions}</ul>${back(lang)}`,
	);
}

/** The answer posted with this request for `page`, `{ error }` when incomplete, or null for none. */
function posted(lang, page, form) {
	const question = page.question;
	if (question.kind === "choice") {
		if (form.kies === undefined) return null;
		const answer = { kind: "choice", chosen: Number(form.kies) };
		return /^\d$/.test(form.kies) && validAnswer(question, answer) ? answer : { error: t(lang, "chooseAnswer") };
	}
	if (form.plaats0 === undefined) return null;
	const placed = question.items.map((_, i) => {
		const raw = form[`plaats${i}`];
		return /^\d$/.test(raw ?? "") ? question.items[Number(raw)] : undefined;
	});
	const answer = { kind: "order", placed, checked: true };
	return placed.every((item) => typeof item === "string") && isFinished(question, answer)
		? answer
		: { error: t(lang, "placeAll") };
}

function feedback(lang, question, answer) {
	const correct = isCorrect(question, answer);
	const order = question.kind === "order" && !correct ? `${esc(t(lang, "correctOrder", question.items.join(" → ")))} ` : "";
	return `<div class="feedback ${correct ? "right" : "not-yet"}" role="status"><p><strong>${esc(t(lang, correct ? "right" : "wrong"))}</strong></p><p>${order}${esc(question.explanation)}</p></div>`;
}

/**
 * POST /p/missies/{id}: one step of a run. `form` is the bounded, duplicate-free form. Returns the
 * page HTML, or null when the posted mission does not exist (the caller answers 404).
 */
export function runStep(lang, object, form) {
	const missionIndex = /^\d{1,2}$/.test(form.missie ?? "") ? Number(form.missie) : -1;
	const mission = object.missions[missionIndex];
	if (!mission) return null;
	const pages = missionPages(mission);
	const answers = typeof form.a === "string" && form.a.length <= MAX_STATE ? decodeAnswers(form.a, pages) : {};
	// never past an unanswered question: the same rule as the app and the preview
	let index = /^\d{1,3}$/.test(form.stap ?? "") ? Math.min(Number(form.stap), pages.length) : 0;
	const open = pages.findIndex((page, i) => page.kind === "question" && !answers[i]);
	if (open !== -1 && index > open) index = open;
	const action = `${CATALOGUE}/${esc(object.id)}`;
	const state = (step) => `${hidden("missie", missionIndex)}${hidden("stap", step)}${hidden("a", encodeAnswers(answers, pages))}`;
	const next = () => `<form method="post" action="${action}">${state(index + 1)}<p><button type="submit">${esc(t(lang, "next"))}</button></p></form>`;
	const page = pages[index];

	if (!page) {
		const questions = mission.practice.length + mission.check.length;
		const score = scoreAnswers(pages, answers);
		const sentence = score > 0 ? t(lang, "scoreSome", score, questions) : t(lang, "scoreNone", questions);
		const mistakes = mission.commonMistakes.length
			? `<section class="card"><h2>${esc(t(lang, "commonMistake"))}</h2>${mission.commonMistakes.map((m) => `<p>“${esc(m.mistake)}” — ${esc(m.why)}</p>`).join("")}</section>`
			: "";
		const again = `<form method="post" action="${action}">${hidden("missie", missionIndex)}${hidden("stap", 0)}${hidden("a", "")}<p><button type="submit">${esc(t(lang, "again"))}</button></p></form>`;
		return layout(lang, t(lang, "missionDone"), `<p class="score">${esc(sentence)}</p>${mistakes}${again}${back(lang)}`);
	}

	const head = `${stepList(lang, page.step)}<p class="muted">${esc(mission.title)} · ${esc(t(lang, "progress", index + 1, pages.length))}</p>`;
	if (page.kind === "card")
		return layout(
			lang,
			object.title,
			`${head}<section class="card"><p>${esc(page.card.text)}</p>${page.card.example ? `<p class="muted">${esc(t(lang, "example", page.card.example))}</p>` : ""}${next()}</section>`,
		);

	const question = page.question;
	let error = "";
	if (!answers[index]) {
		const sent = posted(lang, page, form);
		if (sent?.error) error = `<p class="error" role="alert">${esc(sent.error)}</p>`;
		else if (sent) answers[index] = sent;
	}
	const answer = answers[index];
	if (answer) {
		const shown =
			question.kind === "choice"
				? `<ul class="options">${question.options.map((o, i) => `<li${i === answer.chosen ? ' class="chosen"' : ""}>${esc(o)}${i === answer.chosen ? ` <em>(${esc(t(lang, "yourChoice"))})</em>` : ""}</li>`).join("")}</ul>`
				: `<ol>${answer.placed.map((item) => `<li>${esc(item)}</li>`).join("")}</ol>`;
		return layout(lang, object.title, `${head}<section class="card"><h2>${esc(question.prompt)}</h2>${shown}${feedback(lang, question, answer)}${next()}</section>`);
	}
	const fields =
		question.kind === "choice"
			? question.options
					.map((o, i) => `<label class="option"><input type="radio" name="kies" value="${i}" required> ${esc(o)}</label>`)
					.join("")
			: (() => {
					// the same display order as the app (seed = page position + 1)
					const shownItems = shuffleForDisplay(question.items, index + 1);
					return `<p class="muted">${esc(t(lang, "itemsHint", shownItems.join(" · ")))}</p>${question.items
						.map(
							(_, position) =>
								`<label class="field">${esc(t(lang, "place", position + 1))} <select name="plaats${position}" required><option value="">${esc(t(lang, "choose"))}</option>${shownItems
									.map((item) => `<option value="${question.items.indexOf(item)}">${esc(item)}</option>`)
									.join("")}</select></label>`,
						)
						.join("")}`;
				})();
	return layout(
		lang,
		object.title,
		`${head}<section class="card"><form method="post" action="${action}">${state(index)}<fieldset><legend><h2>${esc(question.prompt)}</h2></legend>${fields}</fieldset>${error}<p><button type="submit">${esc(t(lang, "check"))}</button></p></form></section>`,
	);
}
