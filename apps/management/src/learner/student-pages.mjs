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

/** GET /p/mijn: the assignments available to this learner, closing soonest first. */
export function minePage(lang, { csrf, catalogue = false, assignments = [] }) {
	const sorted = [...assignments].sort((a, b) => {
		const left = a.availableUntil ? +new Date(a.availableUntil) : Number.POSITIVE_INFINITY;
		const right = b.availableUntil ? +new Date(b.availableUntil) : Number.POSITIVE_INFINITY;
		return left - right || String(a.title).localeCompare(String(b.title));
	});
	const list = sorted.length
		? `<ul class="catalogue">${sorted
				.map(
					(row) =>
						`<li class="card"><h2><a href="/p/mijn/${esc(row.assignmentId)}">${esc(row.title)}</a></h2><p class="muted">${esc(subjectName(lang, row.subject))} · ${esc(t(lang, "yearN", row.grade))} · ${esc(t(lang, "missionCount", row.missions, row.minutes))}</p>${row.availableUntil ? due(lang, row.availableUntil) : ""}</li>`,
				)
				.join("")}</ul>`
		: `<p class="notice" role="status">${esc(t(lang, "stNothingYet"))}</p>`;
	return layout(
		lang,
		t(lang, "stMineTitle"),
		`${list}${catalogue ? `<p><a href="/p/missies">${esc(t(lang, "stMorePractice"))}</a></p>` : ""}${signOut(lang, csrf)}`,
		FOOT,
	);
}

/** GET /p/mijn/{assignment}: what it is about, then one start button per mission. */
export function assignmentPage(lang, { csrf, assignment }) {
	const action = `/p/mijn/${esc(assignment.assignmentId)}`;
	const object = assignment.object;
	const missions = object.missions
		.map(
			(m, i) =>
				`<li class="card"><h2>${esc(m.title)}</h2><p class="muted">${esc(t(lang, "about", m.practice.length + m.check.length, m.minutes))}</p><form method="post" action="${action}">${hidden("csrf", csrf)}${hidden("missie", i)}${hidden("stap", 0)}${hidden("a", "")}<p><button type="submit">${esc(t(lang, "start"))}</button></p></form></li>`,
		)
		.join("");
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
