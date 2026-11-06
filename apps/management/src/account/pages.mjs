import { esc } from "../directory-pages.mjs";
import { header } from "../header.mjs";
import { LANGUAGE_NAMES, LANGUAGES, T } from "./i18n.mjs";

/**
 * Breinhap's own sign-in and registration pages (headless: identity sends the codes, Breinhap shows
 * every screen). Plain HTML forms, no inline script or style (the management CSP).
 */

const LOCK =
	'<svg class="lock" aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
const error = (lang, code) => (code ? `<p class="error" role="alert" id="form-error">${esc(T[lang].errors[code] ?? T[lang].errors.unavailable)}</p>` : "");

function steps(lang, current) {
	return `<ol class="auth-steps">${T[lang].steps
		.map(
			([title, text], i) =>
				`<li${i === current ? ' aria-current="step"' : ""}${i < current ? ' class="done"' : ""}><span class="step-n" aria-hidden="true">${i < current ? "✓" : i + 1}</span><div><strong>${title}</strong><small>${text}</small></div></li>`,
		)
		.join("")}</ol>`;
}

/**
 * The page around a card, with the language switch (same path, ?lang=): the ASafariM country & language
 * selector (locale-selector.client.jsx) mounts on it; without JavaScript its links remain.
 */
export function shell(lang, title, card, { path = "/login", version = "", signout = "" } = {}) {
	const switcher = `<nav class="lang-switch" aria-label="Taal / Langue / Language / Sprache">${LANGUAGES.map((l) =>
		l === lang ? `<span aria-current="true" lang="${l}">${l.toUpperCase()}</span>` : `<a href="${esc(path)}?lang=${l}" lang="${l}" hreflang="${l}" title="${LANGUAGE_NAMES[l]}">${l.toUpperCase()}</a>`,
	).join("")}</nav>`;
	return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} — Breinhap</title><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/locale-selector.css"><script src="/theme.js"></script><script src="/locale-selector.js" defer></script></head><body class="auth-body"><a class="skip" href="#inhoud">${lang === "fr" ? "Aller au contenu" : lang === "en" ? "Skip to content" : lang === "de" ? "Zum Inhalt" : "Naar inhoud"}</a>${header({ lang, tools: `<div class="locale-selector" data-locale-selector data-lang="${lang}">${switcher}</div>` })}<main id="inhoud" tabindex="-1" class="auth"><section class="auth-card" aria-labelledby="auth-title"><p class="eyebrow">${T[lang].eyebrow}</p><h1 id="auth-title">${esc(title)}</h1>${card}${signout}</section></main><footer>Breinhap beheer · ${esc(version)}</footer></body></html>`;
}

/** Sign in or register: one e-mail field. */
export function emailPage(lang, { register = false, email = "", errorCode = "", version, notice = "" }) {
	const t = T[lang];
	const [switchText, switchLink] = register ? t.toSignin : t.toRegister;
	const card = `${notice}<p class="auth-lead">${register ? t.registerLead : t.signinLead}</p>${register ? steps(lang, 0) : ""}
<form method="post" action="${register ? "/register" : "/login"}" class="auth-form" novalidate>
<div class="field"><label for="email">${t.email}</label><input id="email" name="email" type="email" autocomplete="email" inputmode="email" required maxlength="254" placeholder="${esc(t.emailPlaceholder)}" value="${esc(email)}"${errorCode ? ' aria-invalid="true" aria-describedby="form-error"' : ""}></div>
${error(lang, errorCode)}<button type="submit" class="action-block">${t.sendCode} <span aria-hidden="true">→</span></button></form>
<p class="auth-secure">${LOCK} ${t.secure}</p>
<p class="auth-switch">${switchText} <a href="${register ? "/login" : "/register"}">${switchLink}</a></p>
<p class="auth-student">${t.student}</p>`;
	return shell(lang, register ? t.registerTitle : t.signinTitle, card, { path: register ? "/register" : "/login", version });
}

export function codePage(lang, { masked, csrf, register = false, errorCode = "", version }) {
	const t = T[lang];
	const card = `<p class="auth-lead">${t.codeLead(esc(masked))}</p>${register ? steps(lang, 0) : ""}
<form method="post" action="/login/code" class="auth-form" novalidate>${hidden("csrf", csrf)}
<div class="field"><label for="code">${t.code}</label><input id="code" name="code" class="code-input" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*" maxlength="9" required autofocus${errorCode ? ' aria-invalid="true" aria-describedby="form-error"' : ""}></div>
${error(lang, errorCode)}<button type="submit" class="action-block">${t.verify}</button></form>
<form method="post" action="/login/opnieuw" class="auth-inline">${hidden("csrf", csrf)}<button type="submit" class="link">${t.resend}</button></form>
<p class="auth-switch"><a href="${register ? "/register" : "/login"}">${t.otherEmail}</a></p>
<p class="auth-student">${t.noMail}</p>`;
	return shell(lang, t.codeTitle, card, { path: "/login/code", version });
}

const ROLE_KEYS = ["breinhap.parent", "breinhap.tutor", "breinhap.teacher"];

export function profilePage(lang, { csrf, values = {}, errorCode = "", version }) {
	const t = T[lang];
	const field = (name, label, { required = false, type = "text", max = 80, auto = "", hint = "" } = {}) =>
		`<div class="field"><label for="p-${name}">${label}</label>${hint ? `<small id="p-${name}-hint">${hint}</small>` : ""}<input id="p-${name}" name="${name}" type="${type}" maxlength="${max}"${required ? " required" : ""}${auto ? ` autocomplete="${auto}"` : ""}${hint ? ` aria-describedby="p-${name}-hint"` : ""} value="${esc(values[name] ?? "")}"></div>`;
	const card = `<p class="auth-lead">${t.profileLead}</p>${steps(lang, 1)}
<form method="post" action="/registreren" class="auth-form">${hidden("csrf", csrf)}
<div class="field-row">${field("firstName", t.firstName, { required: true, max: 60, auto: "given-name" })}${field("lastName", t.lastName, { required: true, auto: "family-name" })}</div>
<fieldset class="role-cards"><legend>${t.role}</legend>${ROLE_KEYS.map(
		(key) =>
			`<label class="role-card"><input type="radio" name="role" value="${key}" required${(values.role ?? "") === key ? " checked" : ""}><span><strong>${t.roles[key][0]}</strong><small>${t.roles[key][1]}</small></span></label>`,
	).join("")}</fieldset>
${field("organisation", t.organisation, { max: 120, auto: "organization", hint: t.organisationHint })}
<div class="field"><label for="p-note">${t.note}</label><small id="p-note-hint">${t.noteHint}</small><textarea id="p-note" name="note" rows="3" maxlength="500" aria-describedby="p-note-hint">${esc(values.note ?? "")}</textarea></div>
<label class="consent"><input type="checkbox" name="consent" value="1" required${values.consent ? " checked" : ""}> <span>${t.consent}</span></label>
${error(lang, errorCode)}<button type="submit" class="action-block">${t.submitProfile}</button></form>`;
	return shell(lang, t.profileTitle, card, { path: "/registreren", version, signout: signoutForm(lang, csrf) });
}

export function pendingPage(lang, { csrf, request, version }) {
	const t = T[lang];
	const p = request.profile ?? {};
	const role = t.roles[request.role]?.[0] ?? request.role;
	const summary = `<dl class="summary">${[
		[t.fullName, [p.firstName, p.lastName].filter(Boolean).join(" ")],
		[t.email, p.email],
		[t.role, role],
		[t.organisation, p.organisation],
	]
		.filter(([, v]) => v)
		.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`)
		.join("")}</dl>`;
	const card = `<p class="auth-lead">${t.pendingLead(esc(role))}</p>${steps(lang, 2)}${summary}<h2 class="auth-h2">${t.pendingNext}</h2><ul class="auth-facts">${t.pendingFacts.map((f) => `<li>${f}</li>`).join("")}</ul><a class="action action-block" href="/registreren">${t.check}</a>`;
	return shell(lang, t.pendingTitle, card, { path: "/registreren", version, signout: signoutForm(lang, csrf) });
}

export const signoutForm = (lang, csrf) =>
	`<form method="post" action="/afmelden" class="auth-signout">${hidden("csrf", csrf)}<button type="submit" class="link">${T[lang].signout}</button></form>`;

/** user@example.com → u•••@example.com */
export function maskEmail(email) {
	const [local, domain] = String(email).split("@");
	return `${(local ?? "").slice(0, 1)}•••@${domain ?? ""}`;
}
