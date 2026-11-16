import { subjectName } from "./public-missions.mjs";
import { t } from "./messages.mjs";
import { esc, layout } from "./pages.mjs";

/**
 * The student pages (breinhap#135): sign in with an e-mail code, type the link code once, and the
 * landing page. Plain forms that work without JavaScript, one thing per screen, no inline script or
 * style. No e-mail address, code or token is ever put in a URL. breinhap#136 adds the assignment
 * list (/p/mijn) and the assignment page (/p/mijn/{assignment}) that plays the missions.
 */
export const MANAGEMENT_SIGN_IN = "https://management.breinhap.com/login";
const FOOT = { footer: "stFooter" };
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
const problem = (lang, key) => (key ? `<p class="error" role="alert">${esc(t(lang, key))}</p>` : "");
const signOut = (lang, csrf) =>
	`<form method="post" action="/p/afmelden">${hidden("csrf", csrf)}<p><button type="submit" class="secondary">${esc(t(lang, "stSignOut"))}</button></p></form>`;

/** "lina@school.example" → "l•••@school.example": enough to recognise, not the whole address. */
export const maskEmail = (email) => {
	const [local, domain] = String(email).split("@");
	return `${(local ?? "").slice(0, 1)}•••@${domain ?? ""}`;
};

/** GET /p/aanmelden: the e-mail address. The age line stands right before the field. */
export function signInPage(lang, { csrf, email = "", error = "" }) {
	return layout(
		lang,
		t(lang, "stSignInTitle"),
		`<p>${esc(t(lang, "stSignInIntro"))}</p><form method="post" action="/p/aanmelden">${hidden("csrf", csrf)}<p class="muted" id="leeftijd">${esc(t(lang, "stAge"))}</p><div class="field"><label for="email">${esc(t(lang, "stEmail"))}</label><input id="email" name="email" type="email" autocomplete="email" autocapitalize="off" spellcheck="false" maxlength="254" required aria-describedby="leeftijd" value="${esc(email)}"></div><label class="option"><input type="checkbox" name="gedeeld" value="1"> ${esc(t(lang, "stShared"))} <span class="muted">${esc(t(lang, "stSharedHint"))}</span></label>${problem(lang, error)}<p><button type="submit">${esc(t(lang, "stSendCode"))}</button></p></form><p>${esc(t(lang, "stAdultQuestion"))} <a href="${MANAGEMENT_SIGN_IN}">${esc(t(lang, "stAdultLink"))}</a></p>`,
		FOOT,
	);
}

/** GET /p/aanmelden/code: the six digits from the e-mail. */
export function codePage(lang, { csrf, masked, error = "" }) {
	return layout(
		lang,
		t(lang, "stCodeTitle"),
		`<p>${esc(t(lang, "stCodeIntro", masked))}</p><form method="post" action="/p/aanmelden/code" autocomplete="off">${hidden("csrf", csrf)}<div class="field"><label for="code">${esc(t(lang, "stCode"))}</label><input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="12" required></div>${problem(lang, error)}<p><button type="submit">${esc(t(lang, "stSignIn"))}</button></p></form><p>${esc(t(lang, "stRestartQuestion"))} <a href="/p/aanmelden">${esc(t(lang, "stRestart"))}</a></p>`,
		FOOT,
	);
}

/** GET /p/koppelen: the only step an account without a learner profile sees. */
export function linkPage(lang, { csrf, error = "" }) {
	return layout(
		lang,
		t(lang, "stLinkTitle"),
		`<p>${esc(t(lang, "stLinkIntro"))}</p><form method="post" action="/p/koppelen" autocomplete="off">${hidden("csrf", csrf)}<div class="field"><label for="code">${esc(t(lang, "stLinkCode"))}</label><input id="code" name="code" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="24" required></div>${problem(lang, error)}<p><button type="submit">${esc(t(lang, "stLink"))}</button></p></form><p>${esc(t(lang, "stNoCode"))}</p>${signOut(lang, csrf)}`,
		FOOT,
	);
}

/** "12 mei 2026", in the page's language, Brussels time (the school's clock). */
const dueDate = (lang, at) =>
	new Intl.DateTimeFormat(`${lang}-BE`, { dateStyle: "long", timeZone: "Europe/Brussels" }).format(new Date(at));
const due = (lang, at) => `<p class="muted">${esc(t(lang, "stDue", dueDate(lang, at)))}</p>`;
const FROM = { "breinhap.teacher": "stFromTeacher", "breinhap.parent": "stFromParent", "breinhap.tutor": "stFromTutor" };

/**
 * GET /p/mijn: the assignments available to this learner, closing soonest first. breinhap#36: each
 * card says Nieuw, Bezig or Klaar from the student's own saved progress (`status` by assignment id).
 */
export function minePage(lang, { csrf, catalogue = false, assignments = [], status = new Map() }) {
	const sorted = [...assignments].sort((a, b) => {
		const left = a.availableUntil ? +new Date(a.availableUntil) : Number.POSITIVE_INFINITY;
		const right = b.availableUntil ? +new Date(b.availableUntil) : Number.POSITIVE_INFINITY;
		return left - right || String(a.title).localeCompare(String(b.title));
	});
	const list = sorted.length
		? `<ul class="catalogue">${sorted
				.map(
					(row) =>
						`<li class="card"><h2><a href="/p/mijn/${esc(row.assignmentId)}">${esc(row.title)}</a></h2><p class="muted">${esc(subjectName(lang, row.subject))} · ${esc(t(lang, "yearN", row.grade))} · ${esc(t(lang, "missionCount", row.missions, row.minutes))}</p>${row.availableUntil ? due(lang, row.availableUntil) : ""}${status.has(row.assignmentId) ? `<p><span class="badge">${esc(t(lang, STATUS[status.get(row.assignmentId)]))}</span></p>` : ""}</li>`,
				)
				.join("")}</ul>`
		: `<p class="notice" role="status">${esc(t(lang, "stNothingYet"))}</p>`;
	return layout(
		lang,
		t(lang, "stMineTitle"),
		`${list}${catalogue ? `<p><a href="/p/missies">${esc(t(lang, "stMorePractice"))}</a></p>` : ""}<p><a href="/p/mijn/gegevens">${esc(t(lang, "stMyData"))}</a></p>${signOut(lang, csrf)}`,
		FOOT,
	);
}

const STATUS = { new: "prNew", busy: "prBusy", done: "prDone" };

/** A form that posts one saved-progress action (breinhap#36) for mission `i`. */
const act = (action, csrf, i, doe, label, { secondary = false, fields = "" } = {}) =>
	`<form method="post" action="${action}">${hidden("csrf", csrf)}${hidden("missie", i)}${hidden("doe", doe)}${fields}<p><button type="submit"${secondary ? ' class="secondary"' : ""}>${esc(label)}</button></p></form>`;
/** The unsaved replay of #136: the whole run travels in the form. */
const replay = (action, csrf, i, label) =>
	`<form method="post" action="${action}">${hidden("csrf", csrf)}${hidden("missie", i)}${hidden("stap", 0)}${hidden("a", "")}<p><button type="submit">${esc(label)}</button></p></form>`;

/**
 * One mission's card on the assignment page. With saved progress (breinhap#36, `progress` a Map by
 * mission id, each entry `{ row, usable, pages }`): Start, or Bezig with Verder and Opnieuw beginnen,
 * or Klaar with an unsaved Nog eens. Progress made on another publication is never continued.
 */
function missionCard(lang, action, csrf, m, i, progress) {
	const head = `<h2>${esc(m.title)}</h2><p class="muted">${esc(t(lang, "about", m.practice.length + m.check.length, m.minutes))}</p>`;
	if (!progress) return `<li class="card">${head}${replay(action, csrf, i, t(lang, "start"))}</li>`;
	const saved = progress.get(m.id);
	if (!saved) return `<li class="card">${head}${act(action, csrf, i, "start", t(lang, "start"))}</li>`;
	if (!saved.usable)
		return `<li class="card">${head}<p class="notice" role="status">${esc(t(lang, "prChanged"))}</p>${act(action, csrf, i, "start", t(lang, "prRestart"))}</li>`;
	const { row, pages } = saved;
	if (row.state === "finished")
		return `<li class="card">${head}<p><span class="badge">${esc(t(lang, "prDoneOn", dueDate(lang, row.finishedAt)))}</span></p>${replay(action, csrf, i, t(lang, "again"))}</li>`;
	return `<li class="card">${head}<p><span class="badge">${esc(t(lang, "prBusyAt", Math.min(row.page + 1, pages), pages))}</span></p>${act(action, csrf, i, "verder", t(lang, "prResume"))}${act(action, csrf, i, "start", t(lang, "prRestart"), { secondary: true })}</li>`;
}

/** GET /p/mijn/{assignment}: what it is about, then one card per mission with its saved state. */
export function assignmentPage(lang, { csrf, assignment, progress = null }) {
	const action = `/p/mijn/${esc(assignment.assignmentId)}`;
	const object = assignment.object;
	const missions = object.missions.map((m, i) => missionCard(lang, action, csrf, m, i, progress)).join("");
	const from = assignment.assignedRole ? `<p class="muted">${esc(t(lang, FROM[assignment.assignedRole] ?? "stFromTeacher"))}</p>` : "";
	return layout(
		lang,
		assignment.title,
		`<p class="muted">${esc(subjectName(lang, assignment.subject))} · ${esc(t(lang, "yearN", assignment.grade))}</p><p>${esc(object.curriculum.leerdoel)}</p>${from}${assignment.availableUntil ? due(lang, assignment.availableUntil) : ""}<p>${esc(t(lang, "stepsInfo"))}</p><p class="notice">${esc(t(lang, "stPrivate"))}</p><ul class="catalogue">${missions}</ul><p><a href="/p/mijn">${esc(t(lang, "stBackToMine"))}</a></p>`,
		FOOT,
	);
}

/** An adult account on the student page: no session here, the workspace is elsewhere. */
export function adultPage(lang) {
	return layout(
		lang,
		t(lang, "stAdultTitle"),
		`<p>${esc(t(lang, "stAdultText"))}</p><p><a href="${MANAGEMENT_SIGN_IN}">${esc(t(lang, "stAdultLink"))}</a></p>`,
		FOOT,
	);
}

/** The calm pages around saved progress (breinhap#36): each names what happened and the way on. */
const back = (lang) => `<p><a href="/p/mijn">${esc(t(lang, "stBackToMine"))}</a></p>`;

/** "Pauzeren": the stored version was read back, so the answers are on the server. */
export function pausedPage(lang, { csrf, assignmentId, missionIndex }) {
	const action = `/p/mijn/${esc(assignmentId)}`;
	return layout(lang, t(lang, "prPausedTitle"), `<p class="notice" role="status">${esc(t(lang, "prPausedText"))}</p>${act(action, csrf, missionIndex, "verder", t(lang, "prResume"))}${back(lang)}`, FOOT);
}

/** Another tab or device moved on: nothing was written, the student continues from the stored page. */
export function stalePage(lang, { csrf, assignmentId, missionIndex }) {
	const action = `/p/mijn/${esc(assignmentId)}`;
	return layout(lang, t(lang, "prStaleTitle"), `<p class="notice" role="status">${esc(t(lang, "prStaleText"))}</p>${act(action, csrf, missionIndex, "verder", t(lang, "prResume"))}${back(lang)}`, FOOT);
}

/** Progress made on another publication, or a row that no longer fits the mission: start again. */
export function changedPage(lang, { csrf, assignmentId, missionIndex }) {
	const action = `/p/mijn/${esc(assignmentId)}`;
	return layout(lang, t(lang, "prChangedTitle"), `<p class="notice" role="status">${esc(t(lang, "prChanged"))}</p>${act(action, csrf, missionIndex, "start", t(lang, "prRestart"))}${back(lang)}`, FOOT);
}

/** A write that failed: the same step can be sent again, unchanged. */
export function saveFailedPage(lang, { action, form }) {
	const fields = Object.entries(form)
		.map(([name, value]) => hidden(esc(name), value))
		.join("");
	return layout(
		lang,
		t(lang, "prSaveFailedTitle"),
		`<p class="error" role="alert">${esc(t(lang, "prSaveFailedText"))}</p><form method="post" action="${esc(action)}">${fields}<p><button type="submit">${esc(t(lang, "prRetry"))}</button></p></form>${back(lang)}`,
		FOOT,
	);
}

/** The delete-your-data page of the legal site, in the page's language (nl, or English otherwise). */
const DELETE_ACCOUNT = (lang) => `https://breinhap.asafarim.site/${lang === "nl" ? "account-verwijderen" : "en/delete-account"}/`;
const sure = (lang, id) =>
	`<label class="option"><input type="checkbox" name="zeker" value="1" required id="${id}"> ${esc(t(lang, "gdSure"))}</label>`;

/**
 * GET /p/mijn/gegevens (breinhap#36): everything Breinhap stores about this student, how long, who
 * sees what, and the controls: clear one assignment or all, download, end the link, delete the
 * account. `groups` is the progress by assignment: `{ assignmentId, title | null, missions: [...] }`.
 */
export function dataPage(lang, { csrf, linkedAt, groups = [], error = "" }) {
	const day = (at) => dueDate(lang, at);
	const progress = groups.length
		? `<ul class="catalogue">${groups
				.map(
					(g) =>
						`<li class="card"><h3>${esc(g.title ?? t(lang, "gdUnavailable"))}</h3><ul>${g.missions
							.map((m) => {
								const parts = [
									t(lang, m.state === "finished" ? "prDone" : "prBusy"),
									t(lang, "gdAnswers", m.answerCount),
									t(lang, "gdStarted", day(m.startedAt)),
									...(m.finishedAt ? [t(lang, "gdFinished", day(m.finishedAt))] : []),
								];
								return `<li>${esc(m.title ?? t(lang, "gdMission"))}: ${esc(parts.join(" · "))}</li>`;
							})
							.join("")}</ul><form method="post" action="/p/mijn/gegevens/wissen">${hidden("csrf", csrf)}${hidden("opdracht", g.assignmentId)}<p><button type="submit" class="secondary">${esc(t(lang, "gdClearOne"))}</button></p></form></li>`,
				)
				.join("")}</ul><form method="post" action="/p/mijn/gegevens/wissen">${hidden("csrf", csrf)}${sure(lang, "zeker-wis")}<p><button type="submit">${esc(t(lang, "gdClearAll"))}</button></p></form>`
		: `<p class="notice" role="status">${esc(t(lang, "gdNone"))}</p>`;
	return layout(
		lang,
		t(lang, "stMyData"),
		`<p>${esc(t(lang, "gdIntro"))}</p>${problem(lang, error)}<section class="card"><h2>${esc(t(lang, "gdAccountTitle"))}</h2><p>${esc(t(lang, "gdAccount"))}</p>${linkedAt ? `<p>${esc(t(lang, "gdLinked", day(linkedAt)))}</p>` : ""}</section><h2>${esc(t(lang, "gdProgressTitle"))}</h2>${progress}<section class="card"><h2>${esc(t(lang, "gdKeepTitle"))}</h2><p>${esc(t(lang, "gdKeep"))}</p><p>${esc(t(lang, "gdAdults"))}</p></section><p><a href="/p/mijn/gegevens/download">${esc(t(lang, "gdDownload"))}</a></p><section class="card"><h2>${esc(t(lang, "gdUnlinkTitle"))}</h2><p>${esc(t(lang, "gdUnlinkText"))}</p><form method="post" action="/p/mijn/gegevens/ontkoppelen">${hidden("csrf", csrf)}${sure(lang, "zeker-ontkoppel")}<p><button type="submit" class="secondary">${esc(t(lang, "gdUnlinkTitle"))}</button></p></form></section><section class="card"><h2>${esc(t(lang, "gdDeleteTitle"))}</h2><p>${esc(t(lang, "gdDelete"))} <a href="${DELETE_ACCOUNT(lang)}">${esc(t(lang, "gdDeleteLink"))}</a></p></section>${back(lang)}${signOut(lang, csrf)}`,
		FOOT,
	);
}
