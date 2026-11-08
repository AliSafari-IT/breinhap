import { tr, ui, withLocale } from "../workspace-i18n.mjs";
import { esc } from "../directory-pages.mjs";
import { langCookie } from "../account/i18n.mjs";
import { ORIGIN } from "../identity.mjs";
import { editorPage } from "../library.mjs";
import { readBody } from "../uploads/multipart.mjs";
import { EXTRACT_LANGUAGES, extractLocale, XT } from "./i18n.mjs";
import { ROLES, toEditorValues } from "./map.mjs";
import { ExtractionError } from "./store.mjs";

/**
 * breinhap#31: /bibliotheek/uittreksels, the text read from the author's PDF and DOCX files, and the
 * screen where they map it onto a learning object. Returns `{ status, title, body, … }` for the shell,
 * or null for a path it does not own. In en (default), nl, fr and de (i18n.mjs).
 */

export const BASE = "/bibliotheek/uittreksels";
const FORM_LIMIT = 128 * 1024;
const LOCALE = { en: "en-GB", nl: "nl-BE", fr: "fr-BE", de: "de-BE" };
const TONE = { queued: "pending", running: "pending", done: "ok", failed: "bad", cancelled: "muted" };

const redirect = (location) => ({ status: 303, headers: { Location: location }, body: "" });
const box = (text, role = "status") => ui`<div class="notice" role="${role}"><p>${text}</p></div>`;
const wrap = (lang, html) => ui`</p><div lang="${lang}" class="extraction">${html}</div><p>`;
const hidden = (csrf, lang) => ui`<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="lang" value="${lang}">`;
const withLang = (path, lang, query = "") => `${path}?${query ? `${query}&` : ""}lang=${lang}`;
const when = (at, lang) => new Date(at).toLocaleString(LOCALE[lang], { timeZone: "Europe/Brussels", dateStyle: "short", timeStyle: "short" });
const refOf = (t, ref) => (Number.isInteger(ref?.page) ? t.ref.page(ref.page) : Number.isInteger(ref?.paragraph) ? t.ref.paragraph(ref.paragraph) : "");

/** The ?notice= / ?error= message of a page, when it is one of ours. */
function messageOf(t, url) {
	const notice = url.searchParams.get("notice");
	const error = url.searchParams.get("error");
	if (error && Object.hasOwn(t.error, error)) return box(t.error[error], "alert");
	if (notice && Object.hasOwn(t.notice, notice)) return box(t.notice[notice]);
	return "";
}

function listPage(t, lang, rows, csrf, message) {
	const list = rows.length
		? ui`<table class="library"><thead><tr><th scope="col">${t.columns.file}</th><th scope="col">${t.columns.status}</th><th scope="col">${t.columns.updated}</th></tr></thead><tbody>${rows
				.map(
					(r) =>
						ui`<tr><td><a href="${withLang(`${BASE}/${esc(r.id)}`, lang)}">${esc(r.fileName ?? "")}</a></td><td><span class="state ${TONE[r.status]}">${t.status[r.status]}</span>${r.status === "running" ? ui` <small>${t.progress(r.progress)}</small>` : ""}</td><td>${when(r.updatedAt, lang)}</td></tr>`,
				)
				.join("")}</tbody></table>`
		: ui`<p>${t.none}</p>`;
	return wrap(lang, ui`${message}<p>${t.intro}</p><p><a href="/bibliotheek/bestanden">${t.toFiles}</a></p>${list}`);
}

function statusPart(t, lang, job, csrf) {
	const self = `${BASE}/${esc(job.id)}`;
	const action = (path, label, cls = "") => ui`<form method="post" action="${self}/${path}" class="inline">${hidden(csrf, lang)}<button type="submit"${cls ? ` class="${cls}"` : ""}>${label}</button></form>`;
	const state = ui`<p><span class="state ${TONE[job.status]}">${t.status[job.status]}</span>${job.attempts > 1 && job.status !== "done" ? ui` <small>${t.attempts(job.attempts)}</small>` : ""}</p>`;
	if (job.status === "queued" || job.status === "running") {
		const percent = job.status === "running" ? job.progress : 0;
		return ui`${state}<p><progress max="100" value="${percent}" aria-label="${t.progressLabel}">${percent}%</progress> ${t.progress(percent)}</p><p>${job.status === "queued" ? t.waiting : t.reading} <a href="${withLang(self, lang)}">${t.refresh}</a></p>${job.cancelRequested ? ui`<p>${t.cancelPending}</p>` : action("stoppen", t.cancel, "secondary")}`;
	}
	if (job.status === "failed") return `${state}${box(t.failed[job.error] ?? t.failed.internal, "alert")}${action("opnieuw", t.retry)}`;
	if (job.status === "cancelled") return `${state}${action("opnieuw", t.retry)}`;
	return state;
}

function warningsPart(t, job) {
	const list = (job.warnings ?? []).filter((w) => Object.hasOwn(t.warnings, w));
	if (!list.length) return "";
	return ui`<section class="notice" aria-labelledby="xt-warnings"><h2 id="xt-warnings">${t.warningsTitle}</h2><ul>${list.map((w) => ui`<li>${t.warnings[w]}</li>`).join("")}</ul></section>`;
}

function mapPart(t, lang, job, csrf) {
	if (!job.blocks.length) return ui`<p>${t.noBlocks}</p>`;
	const options = ROLES.map((r) => ui`<option value="${r}">${esc(t.roles[r])}</option>`).join("");
	const items = job.blocks
		.map((b, i) => {
			const id = `xt-b${i}`;
			const ref = refOf(t, b.ref);
			return ui`<li class="block"><div class="block-head"><strong id="${id}-n">${t.blockNo(i + 1)}</strong> · ${esc(t.type[b.type] ?? b.type)}${ref ? ` · ${esc(ref)}` : ""}</div><p class="block-text" id="${id}-t">${esc(b.text)}</p><label for="${id}">${t.roleLabel}</label> <select id="${id}" name="r.${i}" aria-describedby="${id}-n ${id}-t">${options}</select></li>`;
		})
		.join("");
	return ui`<h2 id="xt-map">${t.mapTitle}</h2><p>${t.mapIntro}</p><p><small>${t.mapHint}</small></p><form method="post" action="${BASE}/${esc(job.id)}/overnemen" aria-labelledby="xt-map">${hidden(csrf, lang)}<ol class="blocks">${items}</ol><p><button type="submit">${t.toEditor}</button></p></form>`;
}

function jobPage(t, lang, job, csrf, message) {
	const source = [job.sourceNote, job.fileName].filter(Boolean).join(" · ");
	const drafts = job.drafts.length
		? ui`<h2>${t.drafts}</h2><ul>${job.drafts.map((d) => ui`<li><a href="/bibliotheek/${esc(d.id)}">${esc(d.title)}</a></li>`).join("")}</ul>`
		: "";
	const units = job.status === "done" && Number.isInteger(job.units) ? ui`<p><small>${t.units[job.kind](job.units)}</small></p>` : "";
	return wrap(
		lang,
		ui`${message}<p>${t.source}: ${esc(source)}</p>${statusPart(t, lang, job, csrf)}${units}${job.status === "done" ? warningsPart(t, job) : ""}${drafts}${job.status === "done" ? mapPart(t, lang, job, csrf) : ""}
<p><a href="${withLang(BASE, lang)}">${t.title}</a> · <a href="/bibliotheek/bestanden">${t.toFiles}</a></p>
<form method="post" action="${BASE}/${esc(job.id)}/verwijderen">${hidden(csrf, lang)}<button type="submit" class="secondary">${t.remove}</button> <small>${t.removeHint}</small></form>`,
	);
}

/** The cell the files page shows for a clean PDF/DOCX: the extraction, or a button to start one. */
export function fileAction(lang, file, extraction, csrf) {
	const t = XT[lang];
	if (extraction) return ui`<a href="${withLang(`${BASE}/${esc(extraction.id)}`, lang)}" lang="${lang}">${t.title}</a>`;
	return ui`<form method="post" action="${BASE}" lang="${lang}">${hidden(csrf, lang)}<input type="hidden" name="bestand" value="${esc(file.id)}"><button type="submit" class="link" title="${esc(t.startHint)}">${t.start}</button></form>`;
}

export async function handleExtractions(req, url, { identity, extractions }) {
	const path = url.pathname;
	if (path !== BASE && !path.startsWith(`${BASE}/`)) return null;
	let lang = extractLocale(req, url);
	let t = XT[lang];
	const active = "/bibliotheek";
	if (!extractions) return { status: req.method === "POST" ? 503 : 200, title: t.title, body: wrap(lang, ui`<p>${t.unavailable}</p>`), active };
	const principal = await identity.principal(req);
	if (!principal) return { status: 403, title: t.forbiddenTitle, body: wrap(lang, ui`<p>${t.forbidden}</p>`) };
	const csrf = req.managementSession.csrf;
	const refused = () => ({ status: 403, title: t.refusedTitle, body: wrap(lang, ui`<p>${t.refused}</p>`) });
	const guard = async (work) => {
		try {
			return await work();
		} catch (error) {
			if (error?.code === "forbidden") return { status: 403, title: t.forbiddenTitle, body: wrap(lang, ui`<p>${t.forbidden}</p>`) };
			if (error?.code === "not_found") return { status: 404, title: t.notFoundTitle, body: wrap(lang, ui`<p>${t.notFound} <a href="${withLang(BASE, lang)}">${t.title}</a></p>`) };
			throw error;
		}
	};

	let form;
	if (req.method === "POST") {
		const body = await readBody(req, FORM_LIMIT).catch(() => null);
		if (!body) return refused();
		form = new URLSearchParams(body.toString("utf8"));
		if (req.headers.origin !== ORIGIN || form.getAll("csrf").length !== 1 || form.get("csrf") !== csrf) return refused();
		if (EXTRACT_LANGUAGES.includes(form.get("lang"))) {
			lang = form.get("lang");
			t = XT[lang];
		}
	} else if (req.method !== "GET" && req.method !== "HEAD") return { status: 405, title: t.notAllowed, body: "", headers: { Allow: "GET, POST" } };

	return withLocale(lang, async () => {
		if (path === BASE) {
			if (req.method !== "POST")
				return guard(async () => ({
					status: 200,
					title: t.title,
					body: listPage(t, lang, await extractions.list(principal), csrf, messageOf(t, url)),
					active,
					headers: { "Cache-Control": "no-store" },
				}));
			return guard(async () => {
				try {
					const { id } = await extractions.start(principal, form.get("bestand") ?? "");
					return redirect(withLang(`${BASE}/${id}`, lang, "notice=started"));
				} catch (error) {
					if (!(error instanceof ExtractionError) || !["not_ready", "unsupported"].includes(error.code)) throw error;
					return redirect(withLang(BASE, lang, `error=${error.code}`));
				}
			});
		}

		const match = /^\/bibliotheek\/uittreksels\/([0-9a-f-]{36})(?:\/(stoppen|opnieuw|verwijderen|overnemen))?$/.exec(path);
		if (!match) return { status: 404, title: t.notFoundTitle, body: wrap(lang, ui`<p><a href="${withLang(BASE, lang)}">${t.title}</a></p>`) };
		const [, id, action] = match;
		const self = `${BASE}/${id}`;
		if (!action) {
			if (req.method === "POST") return { status: 405, title: t.notAllowed, body: "", headers: { Allow: "GET" } };
			return guard(async () => {
				const job = await extractions.get(principal, id);
				return { status: 200, title: t.jobTitle(esc(job.fileName ?? "")), body: jobPage(t, lang, job, csrf, messageOf(t, url)), active, headers: { "Cache-Control": "no-store" } };
			});
		}
		if (req.method !== "POST") return { status: 405, title: t.notAllowed, body: "", headers: { Allow: "POST" } };
		if (action === "stoppen")
			return guard(async () => {
				const status = await extractions.cancel(principal, id);
				return redirect(withLang(self, lang, `notice=${status === "cancelled" ? "cancelled" : "stopping"}`));
			});
		if (action === "opnieuw")
			return guard(async () => {
				try {
					await extractions.retry(principal, id);
					return redirect(withLang(self, lang, "notice=retried"));
				} catch (error) {
					if (error?.code !== "not_retryable") throw error;
					return redirect(withLang(self, lang, "error=not_retryable"));
				}
			});
		if (action === "verwijderen")
			return guard(async () => {
				await extractions.remove(principal, id);
				return redirect(withLang(BASE, lang, "notice=deleted"));
			});
		// overnemen: the chosen roles fill the editor; nothing is saved here
		return guard(async () => {
			const job = await extractions.get(principal, id);
			if (job.status !== "done") return redirect(withLang(self, lang, "error=not_done"));
			const roles = new Map();
			for (const [key, value] of form) {
				const index = /^r\.(\d{1,5})$/.exec(key)?.[1];
				if (index !== undefined && Number(index) < job.blocks.length && ROLES.includes(value)) roles.set(Number(index), value);
			}
			const { values, notes, used } = toEditorValues(job.blocks, roles, job);
			if (!used) return redirect(withLang(self, lang, "error=nothing_chosen"));
			const unfit = notes.length
				? ui`<section class="notice" lang="${lang}"><h2>${t.notesTitle}</h2><ul>${notes.map((n) => ui`<li>${esc(t.notes[n.code](n.block))}</li>`).join("")}</ul></section>`
				: "";
			return {
				status: 200,
				title: tr("Nieuw leerobject"),
				body: editorPage({ values, csrf, hidden: { uittreksel: id }, notice: ui`<div lang="${lang}">${box(t.editorNotice)}${unfit}</div>` }),
				active,
				headers: { "Cache-Control": "no-store" },
			};
		});
	}).then((result) => ({ ...result, locale: lang, headers: { ...result.headers, "Content-Language": lang, "Set-Cookie": langCookie(lang, req.headers.host) } }));
}
