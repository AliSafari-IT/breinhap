import { createHash } from "node:crypto";
import { HTML_LANG, t } from "./messages.mjs";

/**
 * Learner pages (breinhap#82). Plain server-rendered HTML with no management chrome, no inline
 * script or style, and no third-party request. Every authored string is escaped. Nothing here puts a
 * token, an answer or a score in a URL: the only query value is a page key on GET /p/run.
 */
export const esc = (value) =>
	String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function layout(lang, title, body, { script = "" } = {}) {
	return `<!doctype html><html lang="${HTML_LANG[lang] ?? "nl-BE"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>${esc(title)} — Breinhap</title><link rel="stylesheet" href="/p/assets/theme.css"><link rel="stylesheet" href="/p/assets/learner.css">${script ? `<script src="${esc(script)}" defer></script>` : ""}</head><body class="learner"><a class="skip" href="#inhoud">${esc(t(lang, "skip"))}</a><header class="learner-top"><span class="brand">Breinhap</span></header><main id="inhoud" tabindex="-1"><h1>${esc(title)}</h1>${body}</main><footer class="learner-foot"><p>${esc(t(lang, "footer"))}</p></footer></body></html>`;
}

const hidden = (name, value) => `<input type="hidden" name="${name}" value="${esc(value)}">`;

/** GET /p/: the bootstrap. The raw token is only ever typed or read from the fragment in the browser. */
export function bootstrapPage(lang, csrf) {
	return layout(
		lang,
		t(lang, "bootTitle"),
		`<p>${esc(t(lang, "bootIntro"))}</p><form method="post" action="/p/resolve" autocomplete="off">${hidden("csrf", csrf)}<div class="field"><label for="code">${esc(t(lang, "codeLabel"))}</label><input id="code" name="token" type="password" inputmode="text" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="43" required></div><p><button type="submit">${esc(t(lang, "open"))}</button></p></form>`,
		{ script: "/p/assets/bootstrap.js" },
	);
}

export function startPage(info) {
	const lang = info.language;
	return layout(
		lang,
		info.title,
		`${info.description ? `<p>${esc(info.description)}</p>` : ""}${info.instructions ? `<p>${esc(info.instructions)}</p>` : ""}<p>${esc(t(lang, "about", info.questionCount, Math.max(1, info.minutes)))}</p><p>${esc(t(lang, "stepsInfo"))}</p>${info.mode === "test" ? `<p class="notice">${esc(t(lang, "testInfo"))}</p>` : ""}<p class="notice">${esc(t(lang, "privacy"))}</p><form method="post" action="/p/start">${hidden("csrf", info.csrf)}${hidden("startNonce", info.startNonce)}<p><button type="submit">${esc(t(lang, "start"))}</button></p></form>`,
	);
}

const stepList = (lang, step) =>
	`<ol class="steps" aria-label="${esc(t(lang, "step." + step))}">${["Opwarmen", "Leren", "Doen", "Check"]
		.map((s) => `<li${s === step ? ' aria-current="step"' : ""}>${esc(t(lang, "step." + s))}</li>`)
		.join("")}</ol>`;

function answerForm(lang, run, nonce, error) {
	const { page } = run;
	const q = page.question;
	const common = `${hidden("csrf", run.csrf)}${hidden("expectedVersion", run.version)}${hidden("nonce", nonce)}${hidden("pageKey", page.key)}${hidden("kind", "answer")}`;
	const saved = page.answer;
	const err = error ? `<p class="error" role="alert">${esc(error)}</p>` : "";
	const button = run.mode === "test" ? t(lang, "save") : t(lang, "check");
	if (q.kind === "choice")
		return `<form method="post" action="/p/answer">${common}<fieldset><legend><h2>${esc(q.prompt)}</h2></legend>${q.options
			.map((o, i) => `<label class="option"><input type="radio" name="chosen" value="${i}"${saved?.chosen === i ? " checked" : ""} required> ${esc(o)}</label>`)
			.join("")}</fieldset>${err}<p><button type="submit">${esc(button)}</button></p></form>`;
	return `<form method="post" action="/p/answer">${common}${hidden("checked", "1")}<fieldset><legend><h2>${esc(q.prompt)}</h2></legend><p class="muted">${esc(t(lang, "itemsHint", q.items.join(" · ")))}</p>${q.items
		.map(
			(_, position) =>
				`<label class="field">${esc(t(lang, "place", position + 1))} <select name="plaats${position}" required><option value="">${esc(t(lang, "choose"))}</option>${q.items
					.map((item) => `<option value="${esc(item)}"${saved?.placed?.[position] === item ? " selected" : ""}>${esc(item)}</option>`)
					.join("")}</select></label>`,
		)
		.join("")}</fieldset>${err}<p><button type="submit">${esc(button)}</button></p></form>`;
}

function feedbackBlock(lang, q, fb) {
	const order = q.kind === "order" && !fb.correct ? ` ${esc(t(lang, "correctOrder", fb.items.join(" → ")))}` : "";
	return `<div class="feedback ${fb.correct ? "right" : "not-yet"}" role="status"><p><strong>${esc(t(lang, fb.correct ? "right" : "wrong"))}</strong></p><p>${order} ${esc(fb.explanation)}</p></div>`;
}

const advanceForm = (lang, run, nonce, label = "next") =>
	`<form method="post" action="/p/answer">${hidden("csrf", run.csrf)}${hidden("expectedVersion", run.version)}${hidden("nonce", nonce)}${hidden("pageKey", run.page.key)}${hidden("kind", "advance")}<p><button type="submit">${esc(t(lang, label))}</button></p></form>`;

/** GET /p/run: one card or question at a time, or the hand-in screen. */
export function runPage(run, nonce, { error = "" } = {}) {
	const lang = run.language;
	const progress = `<p class="muted">${esc(t(lang, "progress", run.position, run.total))}</p>`;
	if (!run.page)
		return layout(
			lang,
			t(lang, "submitTitle"),
			`<p>${esc(t(lang, "submitText"))}</p><form method="post" action="/p/submit">${hidden("csrf", run.csrf)}${hidden("expectedVersion", run.version)}${hidden("nonce", nonce)}<p><button type="submit">${esc(t(lang, "submit"))}</button></p></form>`,
		);
	const page = run.page;
	const head = `${stepList(lang, page.step)}${progress}`;
	if (page.kind === "card")
		return layout(
			lang,
			run.title,
			`${head}<section class="card"><p>${esc(page.card.text)}</p>${page.card.example ? `<p class="muted">${esc(t(lang, "example", page.card.example))}</p>` : ""}${advanceForm(lang, run, nonce)}</section>`,
		);
	const q = page.question;
	// practice: a finalized answer shows its verdict at once; test: nothing but the saved choice
	if (page.feedback && page.answer) {
		const shown =
			q.kind === "choice"
				? `<ul class="options">${q.options.map((o, i) => `<li${i === page.answer.chosen ? ' class="chosen"' : ""}>${esc(o)}${i === page.answer.chosen ? ` <em>(${esc(t(lang, "yourChoice"))})</em>` : ""}</li>`).join("")}</ul>`
				: `<ol>${page.answer.placed.map((item) => `<li>${esc(item)}</li>`).join("")}</ol>`;
		return layout(lang, run.title, `${head}<section class="card"><h2>${esc(q.prompt)}</h2>${shown}${feedbackBlock(lang, q, page.feedback)}${advanceForm(lang, run, nonce)}</section>`);
	}
	const again = page.answer && run.mode === "test" ? advanceForm(lang, run, createHash("sha256").update(`${nonce}:advance`).digest("base64url")) : "";
	return layout(lang, run.title, `${head}<section class="card">${answerForm(lang, run, nonce, error)}${again}</section>`);
}

/** GET /p/done: the learner's own result and review, then Done. */
export function resultPage(review, csrf, nonce) {
	const lang = review.language;
	const sentence = review.score > 0 ? t(lang, "scoreSome", review.score, review.questionCount) : t(lang, "scoreNone", review.questionCount);
	const items = review.items
		.map((item, n) => {
			const mine =
				item.kind === "choice"
					? item.answer && item.options[item.answer.chosen]
					: item.answer?.placed?.join(" → ");
			const order = item.kind === "order" && !item.correct ? ` ${esc(t(lang, "correctOrder", item.items.join(" → ")))}` : "";
			return `<li class="review-item"><h3>${n + 1}. ${esc(item.prompt)}</h3>${mine ? `<p>${esc(t(lang, "yourAnswer", mine))}</p>` : ""}<div class="feedback ${item.correct ? "right" : "not-yet"}"><p><strong>${esc(t(lang, item.correct ? "right" : "wrong"))}</strong></p><p>${order} ${esc(item.explanation)}</p></div></li>`;
		})
		.join("");
	return layout(
		lang,
		t(lang, "resultTitle"),
		`<p class="score">${esc(sentence)}</p><section aria-labelledby="terug"><h2 id="terug">${esc(t(lang, "review"))}</h2><ol class="review">${items}</ol></section><form method="post" action="/p/finish">${hidden("csrf", csrf)}${hidden("nonce", nonce)}<p><button type="submit">${esc(t(lang, "done"))}</button></p></form>`,
	);
}

export const donePage = (lang) => layout(lang, t(lang, "done"), `<p>${esc(t(lang, "doneText"))}</p>`);

export function messagePage(lang, titleKey, textKey, { link = "" } = {}) {
	return layout(lang, t(lang, titleKey), `<p>${esc(t(lang, textKey))}</p>${link}`);
}
