import { tr, ui, formatLocale } from "./workspace-i18n.mjs";
import { esc } from "./directory-pages.mjs";
import { messageOf, SUBJECTS } from "./library.mjs";

/**
 * The review queue and one submitted revision (breinhap#32). Server-rendered, keyboard-friendly and
 * without JavaScript, like the library. Reviewers see the immutable revision, its sources and the
 * readiness checks; they never see the author's editable draft.
 */

const SUBJECT_NAME = Object.fromEntries(SUBJECTS);
const dateTime = (value) =>
	new Date(value).toLocaleString(formatLocale(), { timeZone: "Europe/Brussels" });

const sourceLabel = (kind) =>
	tr({ own: "Eigen werk", book: "Boek", website: "Website", school_material: "Schoolmateriaal" }[kind] ?? kind);

/** A readiness issue as a person reads it. */
export function issueText(issue) {
	switch (issue.code) {
		case "source_missing":
			return tr("Voeg minstens één bron toe.");
		case "source_permission":
			return tr("Een websitebron heeft een https-link nodig.");
		case "explanation_missing":
			return tr("Elke oefen- en checkvraag heeft een uitleg nodig.");
		case "answer_key_invalid":
			return tr("Controleer het juiste antwoord of de volgorde.");
		default:
			return messageOf(issue);
	}
}

export function reviewQueuePage(rows, { notice = "" } = {}) {
	const list = rows.length
		? ui`<table class="library"><caption>${tr("Revisies die op nakijken wachten")}</caption><thead><tr><th scope="col">${tr("Titel")}</th><th scope="col">${tr("Vak")}</th><th scope="col">${tr("Jaar")}</th><th scope="col">${tr("Revisie")}</th><th scope="col">${tr("Ingediend")}</th></tr></thead><tbody>${rows
				.map(
					(row) =>
						ui`<tr><td><a href="/bibliotheek/nakijken/${esc(row.id)}/${row.revision}">${esc(row.title)}</a></td><td>${esc(tr(SUBJECT_NAME[row.subject] ?? row.subject))}</td><td>${tr("Jaar {0}", row.grade)}</td><td>${row.revision}</td><td>${dateTime(row.submittedAt)}</td></tr>`,
				)
				.join("")}</tbody></table>`
		: ui`<p>${tr("Er zijn geen revisies die op nakijken wachten.")}</p>`;
	return ui`${notice}<p><a href="/bibliotheek">${tr("Terug naar de bibliotheek")}</a></p>${list}`;
}

function questionList(label, questions) {
	return ui`<h4>${label}</h4><ol>${questions
		.map((question) => {
			if (question.kind === "choice")
				return ui`<li><p><strong>${esc(question.prompt)}</strong></p><ol>${question.options
					.map(
						(option, index) =>
							ui`<li>${esc(option)}${index === question.answerIndex ? ui` <strong>(${tr("Juist antwoord")})</strong>` : ""}</li>`,
					)
					.join("")}</ol><p><small>${tr("Uitleg")}: ${esc(question.explanation)}</small></p></li>`;
			return ui`<li><p><strong>${esc(question.prompt)}</strong></p><p><small>${tr("Juiste volgorde")}: ${question.items.map((item) => esc(item)).join(" → ")}</small></p><p><small>${tr("Uitleg")}: ${esc(question.explanation)}</small></p></li>`;
		})
		.join("")}</ol>`;
}

export function reviewPage(review, { csrf, notice = "" }) {
	const content = review.content;
	const issues = review.issues ?? [];
	const missions = content.missions
		.map(
			(mission) =>
				ui`<section class="review-mission"><h3>${esc(mission.title)}</h3><p><strong>${tr("Opwarmer")}:</strong> ${esc(mission.warmup.text)}</p><h4>${tr("Leren")}</h4><ul>${mission.learn
					.map(
						(card) =>
							ui`<li>${esc(card.text)}${card.example ? ui`<br><small>${esc(card.example)}</small>` : ""}</li>`,
					)
					.join("")}</ul>${questionList(tr("Oefenvragen"), mission.practice)}${questionList(tr("Checkvragen"), mission.check)}</section>`,
		)
		.join("");
	const sources = review.sources?.length
		? ui`<ul>${review.sources
				.map(
					(source) =>
						ui`<li>${esc(source.title)} <small>${sourceLabel(source.kind)}</small>${source.url ? ui` · <a href="${esc(source.url)}" rel="noopener noreferrer">${esc(source.url)}</a>` : ""}</li>`,
				)
				.join("")}</ul>`
		: ui`<p>${tr("Geen bronnen opgegeven.")}</p>`;
	const issuesBlock = issues.length
		? ui`<div class="alert" role="alert"><p><strong>${tr("Deze revisie is nog niet klaar om na te kijken:")}</strong></p><ul>${issues
				.map((issue) => ui`<li>${esc(issueText(issue))}</li>`)
				.join("")}</ul></div>`
		: "";
	return ui`${notice}<p><a href="/bibliotheek/nakijken">${tr("Terug naar de wachtrij")}</a></p>
<dl class="review-meta"><dt>${tr("Titel")}</dt><dd>${esc(review.title)}</dd><dt>${tr("Vak")}</dt><dd>${esc(tr(SUBJECT_NAME[review.subject] ?? review.subject))}</dd><dt>${tr("Jaar")}</dt><dd>${tr("Jaar {0}", review.grade)}</dd><dt>${tr("Revisie")}</dt><dd>${review.revision}</dd><dt>${tr("Ingediend")}</dt><dd>${dateTime(review.submittedAt)}</dd></dl>
<h2>${tr("Leerdoel")}</h2><p>${esc(content.curriculum.leerdoel)}</p>
<h2>${tr("Missies")}</h2>${missions}
<h2>${tr("Bronnen")}</h2>${sources}
${issuesBlock}
<form method="post" action="/bibliotheek/nakijken/${esc(review.id)}/${review.revision}" class="review-form">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<label for="comment">${tr("Opmerking voor de auteur")} <small>${tr("Verplicht bij aanpassingen.")}</small></label>
<textarea id="comment" name="comment" maxlength="2000" rows="4"></textarea>
<p><button type="submit" name="decision" value="approved"${issues.length ? " disabled" : ""}>${tr("Goedkeuren")}</button> <button type="submit" name="decision" value="changes_requested">${tr("Aanpassingen vragen")}</button></p>
${issues.length ? ui`<p><small>${tr("Los eerst de punten hierboven op, of vraag aanpassingen.")}</small></p>` : ""}
</form>`;
}
