import { tr, ui, diagnostic } from "../workspace-i18n.mjs";
import { esc } from "../directory-pages.mjs";
import { ORIGIN } from "../identity.mjs";
import { boundaryOf, FormRefused, parseMultipart, readBody } from "../uploads/multipart.mjs";
import { CSV_COLUMNS, ImportRefused, MAX_IMPORT_BYTES } from "./parse.mjs";
import { ImportError, PLAN_MINUTES } from "./store.mjs";

/**
 * breinhap#30: /bibliotheek/importeren. Upload a ContentPack (JSON) or the CSV template, see exactly
 * what would happen, then confirm. Returns `{ status, title, body, … }`, `{ raw: true, … }` for the
 * template, or null for a path it does not own.
 */

const BASE = "/bibliotheek/importeren";
const redirect = (location) => ({ status: 303, headers: { Location: location }, body: "" });
const notice = (text, role = "status") => ui`<div class="notice" role="${role}"><p>${text}</p></div>`;
const refusedForm = () => ({ status: 403, title: tr("Aanvraag geweigerd"), body: tr("Laad de pagina opnieuw en probeer nog eens.") });

const REFUSED = {
	empty: "Het bestand is leeg.",
	too_large: `Het bestand is te groot (maximaal ${MAX_IMPORT_BYTES / 1024 / 1024} MB).`,
	type_not_allowed: "Gebruik een Breinhap-inhoudspakket (.json) of het CSV-sjabloon (.csv).",
	encoding: "Sla het bestand op als UTF-8 en probeer opnieuw.",
	json_invalid: "Dit is geen geldig JSON-bestand.",
	pack_shape: "Dit JSON-bestand is geen Breinhap-inhoudspakket (er ontbreekt een lijst objects).",
	csv_empty: "Het CSV-bestand heeft geen rijen onder de kolomnamen.",
	csv_unterminated: "Een aanhalingsteken in het CSV-bestand wordt niet afgesloten.",
	too_many_rows: "Het CSV-bestand heeft te veel rijen (maximaal 5000).",
	too_many_objects: "Het bestand heeft te veel leerobjecten (maximaal 200 per keer).",
};
const ACTION = {
	create: ["Nieuw", "ok"],
	update: ["Bijwerken (jouw concept)", "pending"],
	skip: ["Overslaan", "muted"],
};
const REASON = {
	identical: "staat er al precies zo in",
	owned_elsewhere: "deze code is al in gebruik in deze werkplek",
	archived: "je hebt dit leerobject gearchiveerd",
	mission_in_use: "een missiecode is al in gebruik bij een ander leerobject",
};
const RESULT = {
	done: "Gedaan",
	conflict: "Niet gedaan: het is intussen gewijzigd. Importeer opnieuw.",
	skipped: "Overgeslagen",
	pending: "Nog niet gedaan",
};

/** The CSV template: the header and one complete example mission. */
export const TEMPLATE = [
	CSV_COLUMNS.join(";"),
	"prikkel-reactie;biologie;3;Prikkel en reactie;Ik leg prikkel en reactie uit.;LPD 12;prikkel-reactie-m1;Wat is een prikkel?;3;warmup;;Denk aan iets dat je laat schrikken.;;;;;;;",
	"prikkel-reactie;;;;;;prikkel-reactie-m1;;;learn;;Een prikkel is een verandering die je waarneemt.;Een harde knal.;;;;;;",
	"prikkel-reactie;;;;;;prikkel-reactie-m1;;;practice;choice;Wat is een prikkel?;;Een spier | Een verandering;2;;Een prikkel is een verandering in of rond je lichaam.;;",
	"prikkel-reactie;;;;;;prikkel-reactie-m1;;;check;order;Zet in volgorde.;;;;prikkel | receptor | reactie;Eerst de prikkel, dan de receptor, dan de reactie.;;",
	"prikkel-reactie;;;;;;prikkel-reactie-m1;;;mistake;;;;;;;;Een prikkel is een reactie.;De reactie komt pas na de prikkel.",
].map((line) => line.split(";").map((v) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(";")).join("\r\n") + "\r\n";

const where = (e) =>
	e.row !== undefined ? tr`Rij ${e.row}${e.column ? tr`, kolom ${esc(e.column)}` : ""}` : e.path ? ui`<code>${esc(e.path)}</code>` : tr("Bestand");

function formPage(csrf, message = "") {
	return ui`${message}<p>Importeer leerobjecten uit een bestand. Je ziet eerst precies wat er zou gebeuren; er wordt pas iets opgeslagen als je bevestigt. Alles wordt een <strong>concept</strong>: een bestand kan niets als nagekeken of gepubliceerd markeren.</p>
<section class="card upload-card" aria-labelledby="import-title"><h2 id="import-title">Bestand kiezen</h2>
<form method="post" action="${BASE}" enctype="multipart/form-data">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<div class="field"><label for="f-bestand">Bestand</label><small id="f-bestand-hint">Een Breinhap-inhoudspakket (.json) of het CSV-sjabloon (.csv), maximaal ${MAX_IMPORT_BYTES / 1024 / 1024} MB.</small><input id="f-bestand" name="bestand" type="file" required accept=".json,.csv,application/json,text/csv" aria-describedby="f-bestand-hint"></div>
<button type="submit">Controleren</button>
</form></section>
<h2>Het CSV-sjabloon</h2>
<p><a href="${BASE}/sjabloon.csv" download>Download het sjabloon</a>: één rij per opwarming, uitleg, vraag of veelgemaakte fout. Rijen met dezelfde <code>object_id</code> horen bij één leerobject; de gegevens van het leerobject en de missie staan op de eerste rij.</p>
<ul class="auth-facts"><li><code>part</code>: warmup, learn, practice, check of mistake.</li><li><code>kind</code> (bij practice en check): choice of order.</li><li>Opties en volgordes scheid je met <code>|</code>; <code>answer</code> is het nummer van het juiste antwoord (1, 2, …).</li><li>Puntkomma of komma als scheidingsteken, UTF-8.</li></ul>`;
}

function previewPage(plan, csrf) {
	const writes = plan.items.filter((i) => i.action !== "skip").length;
	const errors = plan.errors.length
		? ui`<section class="alert" role="alert" aria-labelledby="import-errors"><h2 id="import-errors">${plan.errors.length} ${plan.errors.length === 1 ? tr("fout") : tr("fouten")}: deze leerobjecten worden niet geïmporteerd</h2><ul>${plan.errors
				.slice(0, 100)
				.map((e) => ui`<li>${where(e)}${e.object ? ` (${esc(e.object)})` : ""}: ${esc(diagnostic(e.message))}</li>`)
				.join("")}</ul>${plan.errors.length > 100 ? ui`<p>En nog ${plan.errors.length - 100} meer.</p>` : ""}</section>`
		: "";
	const notes = plan.notes.length ? ui`<section class="notice"><ul>${plan.notes.slice(0, 50).map((n) => ui`<li>${esc(diagnostic(n))}</li>`).join("")}</ul></section>` : "";
	const rows = plan.items.length
		? ui`<table class="library"><thead><tr><th scope="col">Code</th><th scope="col">Titel</th><th scope="col">Missies</th><th scope="col">Wat gebeurt er</th></tr></thead><tbody>${plan.items
				.map((i) => {
					const [label, tone] = ACTION[i.action];
					return ui`<tr><td><code>${esc(i.objectId)}</code></td><td>${esc(i.title ?? "")}</td><td>${i.missions}</td><td><span class="state ${tone}">${tr(label)}</span>${i.reason ? ui` <small>(${tr(REASON[i.reason] ?? i.reason)})</small>` : ""}</td></tr>`;
				})
				.join("")}</tbody></table>`
		: ui`<p>Er is niets om te importeren.</p>`;
	const confirm = writes
		? ui`<form method="post" action="${BASE}/${esc(plan.id)}/bevestigen"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit">${writes} ${writes === 1 ? tr("leerobject") : tr("leerobjecten")} importeren als concept</button></form><p class="muted"><small>Er is nog niets opgeslagen. Dit voorstel blijft ${PLAN_MINUTES} minuten geldig.</small></p>`
		: ui`<p><a href="${BASE}">Een ander bestand kiezen</a></p>`;
	return ui`<p>Dit zou er gebeuren. <strong>Er is nog niets opgeslagen.</strong></p>${errors}${notes}${rows}${confirm}`;
}

function resultPage(row) {
	const done = row.items.filter((i) => i.result === "done").length;
	return ui`${notice(row.status === "done" ? tr`Import afgerond: ${done} ${done === 1 ? tr("leerobject") : tr("leerobjecten")} opgeslagen als concept.` : tr("Deze import is nog niet bevestigd."))}<table class="library"><thead><tr><th scope="col">Code</th><th scope="col">Titel</th><th scope="col">Resultaat</th></tr></thead><tbody>${row.items
		.map((i) => ui`<tr><td>${i.result === "done" ? ui`<a href="/bibliotheek/${esc(i.objectId)}">${esc(i.objectId)}</a>` : ui`<code>${esc(i.objectId)}</code>`}</td><td>${esc(i.title ?? "")}</td><td>${tr(RESULT[i.result] ?? i.result)}${i.reason ? ui` <small>(${tr(REASON[i.reason] ?? "")})</small>` : ""}</td></tr>`)
		.join("")}</tbody></table><p><a href="/bibliotheek">Naar de bibliotheek</a> · <a href="${BASE}">Nog een bestand importeren</a></p>`;
}

export async function handleImports(req, url, { identity, imports }) {
	const path = url.pathname;
	if (path !== BASE && !path.startsWith(`${BASE}/`)) return null;
	if (path === `${BASE}/sjabloon.csv`) {
		if (req.method !== "GET" && req.method !== "HEAD") return { status: 405, title: tr("Niet toegestaan"), body: "", headers: { Allow: "GET" } };
		return { raw: true, status: 200, body: `﻿${TEMPLATE}`, type: "text/csv; charset=utf-8", headers: { "Content-Disposition": 'attachment; filename="breinhap-sjabloon.csv"' } };
	}
	if (!imports)
		return { status: req.method === "POST" ? 503 : 200, title: tr("Importeren"), body: tr("Importeren is nog niet ingericht op deze server."), active: "/bibliotheek" };
	const principal = await identity.principal(req);
	if (!principal) return { status: 403, title: tr("Geen toegang"), body: tr("Je hebt geen toegang tot importeren.") };
	const csrf = req.managementSession.csrf;
	const guard = async (work) => {
		try {
			return await work();
		} catch (error) {
			if (error?.code === "forbidden") return { status: 403, title: tr("Geen toegang"), body: tr("Alleen ouders, begeleiders en leerkrachten importeren leerobjecten.") };
			if (error?.code === "not_found") return { status: 404, title: tr("Niet gevonden"), body: ui`Deze import bestaat niet of is niet van jou. <a href="${BASE}">Importeren</a>` };
			if (error instanceof ImportError && error.code === "expired") return { status: 410, title: tr("Voorstel verlopen"), body: ui`Dit voorstel is ouder dan ${PLAN_MINUTES} minuten en wordt niet meer uitgevoerd. <a href="${BASE}">Laad het bestand opnieuw op</a>.` };
			if (error instanceof ImportError && error.code === "busy") return { status: 409, title: tr("Bezig"), body: ui`Deze import wordt al uitgevoerd. <a href="${url.pathname.replace(/\/bevestigen$/, "")}">Bekijk het resultaat</a>.` };
			throw error;
		}
	};

	if (path === BASE) {
		if (req.method === "GET" || req.method === "HEAD")
			return guard(async () => {
				await imports.author(principal, "import.read");
				return { status: 200, title: tr("Importeren"), body: formPage(csrf), active: "/bibliotheek" };
			});
		if (req.method !== "POST") return { status: 405, title: tr("Niet toegestaan"), body: "", headers: { Allow: "GET, POST" } };
		const boundary = boundaryOf(req.headers["content-type"]);
		if (req.headers.origin !== ORIGIN || !boundary) return refusedForm();
		let form;
		try {
			form = parseMultipart(await readBody(req, MAX_IMPORT_BYTES + 16 * 1024), boundary);
		} catch (error) {
			if (!(error instanceof FormRefused)) throw error;
			return { status: error.status, title: tr("Importeren"), body: formPage(csrf, notice(error.code === "too_large" ? diagnostic(REFUSED.too_large) : tr("Het formulier kon niet worden gelezen."), "alert")), active: "/bibliotheek" };
		}
		if (form.fields.getAll("csrf").length !== 1 || form.fields.get("csrf") !== csrf) return refusedForm();
		if (!form.file) return { status: 400, title: tr("Importeren"), body: formPage(csrf, notice(tr("Kies een bestand."), "alert")), active: "/bibliotheek" };
		return guard(async () => {
			try {
				const plan = await imports.plan(principal, { name: form.file.name, bytes: form.file.bytes });
				return { status: 200, title: tr("Importeren: voorstel"), body: previewPage(plan, csrf), active: "/bibliotheek", headers: { "Cache-Control": "no-store" } };
			} catch (error) {
				if (!(error instanceof ImportRefused)) throw error;
				return { status: 422, title: tr("Importeren"), body: formPage(csrf, notice(diagnostic(REFUSED[error.code] ?? "") || tr("Dit bestand kan niet worden geïmporteerd."), "alert")), active: "/bibliotheek" };
			}
		});
	}

	const match = /^\/bibliotheek\/importeren\/([0-9a-f-]{36})(\/bevestigen)?$/.exec(path);
	if (!match) return { status: 404, title: tr("Niet gevonden"), body: ui`<a href="${BASE}">Importeren</a>` };
	const [, id, confirming] = match;
	if (!confirming) {
		if (req.method !== "GET" && req.method !== "HEAD") return { status: 405, title: tr("Niet toegestaan"), body: "", headers: { Allow: "GET" } };
		return guard(async () => ({ status: 200, title: tr("Importeren: resultaat"), body: resultPage(await imports.get(principal, id)), active: "/bibliotheek" }));
	}
	if (req.method !== "POST") return { status: 405, title: tr("Niet toegestaan"), body: "", headers: { Allow: "POST" } };
	const fields = new URLSearchParams((await readBody(req, 4096).catch(() => Buffer.alloc(0))).toString("utf8"));
	if (req.headers.origin !== ORIGIN || fields.getAll("csrf").length !== 1 || fields.get("csrf") !== csrf) return refusedForm();
	return guard(async () => {
		await imports.confirm(principal, id);
		return redirect(`${BASE}/${id}`);
	});
}
