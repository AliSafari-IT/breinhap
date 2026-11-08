import { tr, ui, diagnostic } from "./workspace-i18n.mjs";
import { esc } from "./directory-pages.mjs";
import { shuffleForDisplay } from "./vendor/content-pick.mjs";
import { isFinished, missionPages, STEPS, scoreAnswers, scoreSentence, validAnswer } from "./vendor/content-mission.mjs";

/**
 * breinhap#28: the management-only preview of a draft or revision, built from the student payload
 * with the shared mission rules (`packages/content/src/mission.ts`, vendored). It is plain links and
 * GET forms: the whole state (mission, page, answers) lives in the URL, so a preview stores nothing,
 * publishes nothing, assigns nothing and leaves no student progress behind.
 */

const MAX_STATE = 2000;

/**
 * Answers as the URL carries them: `3c1` (page 3, option 1) and `4o2.0.1` (page 4, the items of the
 * stored order in the order placed), joined by `;`. Anything that does not fit the mission is dropped.
 */
export function decodeAnswers(raw, pages) {
	const answers = {};
	if (typeof raw !== "string" || raw.length > MAX_STATE) return answers;
	for (const part of raw.split(";")) {
		const match = /^(\d{1,3})(?:c(\d)|o(\d(?:\.\d){0,5}))$/.exec(part);
		if (!match) continue;
		const index = Number(match[1]);
		const page = pages[index];
		if (!page || page.kind !== "question" || answers[index]) continue;
		if ((match[2] !== undefined) !== (page.question.kind === "choice")) continue;
		const answer =
			match[2] !== undefined
				? { kind: "choice", chosen: Number(match[2]) }
				: { kind: "order", placed: match[3].split(".").map((i) => page.question.items[Number(i)]), checked: true };
		if (isFinished(page.question, answer)) answers[index] = answer;
	}
	return answers;
}

export function encodeAnswers(answers, pages) {
	return Object.keys(answers)
		.map(Number)
		.sort((a, b) => a - b)
		.map((index) => {
			const answer = answers[index];
			return answer.kind === "choice"
				? `${index}c${answer.chosen}`
				: `${index}o${answer.placed.map((item) => pages[index].question.items.indexOf(item)).join(".")}`;
		})
		.join(";");
}

/** The answer the student just submitted on `page`, or `{ error }` when it is not complete yet. */
export function submitted(page, params) {
	const question = page.question;
	if (question.kind === "choice") {
		if (!params.has("kies")) return null;
		const answer = { kind: "choice", chosen: Number(params.get("kies")) };
		return validAnswer(question, answer) && /^\d$/.test(params.get("kies")) ? answer : { error: tr("Kies eerst een antwoord.") };
	}
	if (!params.has("plaats0")) return null;
	const placed = question.items.map((_, i) => question.items[Number(params.get(`plaats${i}`) ?? "x")]);
	const answer = { kind: "order", placed, checked: true };
	return placed.every((item) => typeof item === "string") && isFinished(question, answer)
		? answer
		: { error: tr("Zet elk stukje op precies één plaats.") };
}

const steps = (current) =>
	ui`<ol class="steps" aria-label="Stap ${STEPS.indexOf(current) + 1} van 4: ${tr(current)}">${STEPS.map(
		(step) => ui`<li${step === current ? ' aria-current="step"' : ""}>${tr(step)}</li>`,
	).join("")}</ol>`;

const feedback = (question, answer) => {
	const correct =
		question.kind === "choice"
			? answer.chosen === question.answerIndex
			: question.items.every((item, i) => answer.placed[i] === item);
	const explanation =
		question.kind === "order" && !correct
			? tr`De juiste volgorde: ${question.items.join(" → ")}. ${question.explanation}`
			: question.explanation;
	return ui`<div class="feedback ${correct ? "right" : "not-yet"}" role="status"><p><strong>${correct ? tr("Klopt.") : tr("Nog niet.")}</strong></p><p>${esc(explanation)}</p></div>`;
};

/**
 * The preview page. `object` is the student payload (already validated); `params` the query string.
 * `base` is the preview URL of this object; `back` the editor.
 */
export function previewPage(object, params, { base, back, label }) {
	const keep = (extra) => {
		const query = new URLSearchParams();
		if (params.get("revisie")) query.set("revisie", params.get("revisie"));
		for (const [key, value] of Object.entries(extra)) if (value !== "" && value !== undefined) query.set(key, String(value));
		const text = query.toString();
		return `${base}${text ? `?${text}` : ""}`;
	};
	const banner = ui`<div class="notice preview" role="note"><p><strong>Voorbeeld van ${esc(label)}.</strong> Zo ziet een leerling deze missie. Er wordt niets gepubliceerd, toegewezen of bewaard, en er ontstaat geen voortgang. Antwoorden blijven alleen in dit adres staan.</p><p><a href="${esc(back)}">Terug naar het leerobject</a></p></div>`;

	const chosenMission = params.get("missie");
	if (object.missions.length > 1 && chosenMission === null)
		return ui`${banner}<h2>${esc(object.title)}</h2><p>Kies een missie om te bekijken.</p><ul>${object.missions
			.map((m, i) => ui`<li><a href="${esc(keep({ missie: i }))}">${esc(m.title)}</a> · ${m.minutes} minuten</li>`)
			.join("")}</ul>`;
	const missionIndex = /^\d{1,2}$/.test(chosenMission ?? "") ? Number(chosenMission) : 0;
	const mission = object.missions[missionIndex];
	if (!mission) return ui`${banner}<p>Deze missie bestaat niet. <a href="${esc(keep({}))}">Kies een missie</a></p>`;

	const pages = missionPages(mission);
	const answers = decodeAnswers(params.get("a"), pages);
	// never past an unanswered question: the same rule as the app
	let index = /^\d{1,3}$/.test(params.get("stap") ?? "") ? Math.min(Number(params.get("stap")), pages.length) : 0;
	const open = pages.findIndex((page, i) => page.kind === "question" && !answers[i]);
	if (open !== -1 && index > open) index = open;
	const at = (extra) => keep({ missie: object.missions.length > 1 ? missionIndex : "", ...extra });
	const page = pages[index];

	if (!page) {
		const questions = mission.practice.length + mission.check.length;
		return ui`${banner}<h2>Missie klaar.</h2><p>${esc(diagnostic(scoreSentence(scoreAnswers(pages, answers), questions)))}</p>${
			mission.commonMistakes.length
				? ui`<section class="card"><h3>Veelgemaakte fout</h3>${mission.commonMistakes.map((m) => ui`<p>“${esc(m.mistake)}” — ${esc(m.why)}</p>`).join("")}</section>`
				: ""
		}<p><a href="${esc(at({}))}">Opnieuw bekijken</a>${object.missions.length > 1 ? ui` · <a href="${esc(keep({}))}">Andere missie</a>` : ""}</p>`;
	}

	const header = ui`${banner}${steps(page.step)}<p class="muted">${esc(mission.title)} · ${index + 1} van ${pages.length}</p>${index === pages.length - 1 ? ui`<p class="muted">Laatste vraag.</p>` : ""}`;
	const next = ui`<a class="action" href="${esc(at({ stap: index + 1, a: encodeAnswers(answers, pages) }))}">Verder</a>`;
	if (page.kind === "card")
		return ui`${header}<section class="card"><p>${esc(page.card.text)}</p>${page.card.example ? ui`<p class="muted">Voorbeeld: ${esc(page.card.example)}</p>` : ""}${next}</section>`;

	const question = page.question;
	let error = "";
	if (!answers[index]) {
		const sent = submitted(page, params);
		if (sent?.error) error = ui`<p class="error" role="alert">${esc(sent.error)}</p>`;
		else if (sent) answers[index] = sent;
	}
	const answer = answers[index];
	const verder = ui`<a class="action" href="${esc(at({ stap: index + 1, a: encodeAnswers(answers, pages) }))}">Verder</a>`;
	const hidden = ui`${object.missions.length > 1 ? ui`<input type="hidden" name="missie" value="${missionIndex}">` : ""}${params.get("revisie") ? ui`<input type="hidden" name="revisie" value="${esc(params.get("revisie"))}">` : ""}<input type="hidden" name="stap" value="${index}"><input type="hidden" name="a" value="${esc(encodeAnswers(answers, pages))}">`;

	if (question.kind === "choice") {
		if (answer)
			return ui`${header}<section class="card"><h2>${esc(question.prompt)}</h2><ul class="options">${question.options
				.map((o, i) => ui`<li${i === answer.chosen ? ' class="chosen"' : ""}>${esc(o)}${i === answer.chosen ? ui` <em>(jouw keuze)</em>` : ""}</li>`)
				.join("")}</ul>${feedback(question, answer)}${verder}</section>`;
		return ui`${header}<section class="card"><form method="get" action="${esc(base)}">${hidden}<fieldset><legend><h2>${esc(question.prompt)}</h2></legend>${question.options
			.map((o, i) => ui`<label class="option"><input type="radio" name="kies" value="${i}" required> ${esc(o)}</label>`)
			.join("")}</fieldset>${error}<button type="submit">Controleer</button></form></section>`;
	}

	// an order question: the same display order as the app (seed = page position + 1)
	const shown = shuffleForDisplay(question.items, index + 1);
	if (answer)
		return ui`${header}<section class="card"><h2>${esc(question.prompt)}</h2><ol>${answer.placed.map((item) => ui`<li>${esc(item)}</li>`).join("")}</ol>${feedback(question, answer)}${verder}</section>`;
	return ui`${header}<section class="card"><form method="get" action="${esc(base)}">${hidden}<fieldset><legend><h2>${esc(question.prompt)}</h2></legend><p class="muted">De stukjes: ${shown.map(esc).join(" · ")}. Kies voor elke plaats een stukje; gebruik elk stukje één keer.</p>${question.items
		.map(
			(_, position) =>
				ui`<label class="field">Plaats ${position + 1} <select name="plaats${position}" required><option value="">Kies…</option>${shown
					.map((item) => ui`<option value="${question.items.indexOf(item)}">${esc(item)}</option>`)
					.join("")}</select></label>`,
		)
		.join("")}</fieldset>${error}<button type="submit">Controleer</button></form></section>`;
}
