import { tr, ui, formatLocale, diagnostic } from "../workspace-i18n.mjs";
import { esc } from "../directory-pages.mjs";
import { ORIGIN } from "../identity.mjs";
import { boundaryOf, FormRefused, parseMultipart, readBody } from "./multipart.mjs";
import { LICENCES, LINK_SECONDS, SOURCE_KINDS, UploadError } from "./store.mjs";
import { MAX_FILE_BYTES, REFUSALS, TYPES, UploadRefused } from "./validate.mjs";
import { fileAction } from "../extract/routes.mjs";
import { extractLocale } from "../extract/i18n.mjs";
import { SUPPORTED } from "../extract/store.mjs";

/**
 * breinhap#29: /bibliotheek/bestanden, the author's uploaded teaching material and images. Returns
 * `{ status, title, body, headers, active }` for the shell, `{ raw: true, … }` for a download, or null
 * for a path it does not own.
 */

const BODY_LIMIT = MAX_FILE_BYTES + 64 * 1024;
const BASE = "/bibliotheek/bestanden";
const redirect = (location) => ({ status: 303, headers: { Location: location }, body: "" });
const notice = (text, role = "status") => ui`<div class="notice" role="${role}"><p>${text}</p></div>`;

const size = (bytes) =>
	bytes >= 1024 * 1024
		? `${(bytes / 1024 / 1024).toLocaleString(formatLocale(), { maximumFractionDigits: 1 })} MB`
		: tr`${Math.max(1, Math.round(bytes / 1024)).toLocaleString(formatLocale())} kB`;
const KIND_LABEL = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [k, v.label]));
const REASONS = {
	infected: "Er is schadelijke inhoud gevonden. Het bestand is verwijderd.",
	scan_timeout: "Het bestand kon niet op tijd worden gecontroleerd en is verwijderd. Laad het opnieuw op.",
	storage_failed: "Opslaan lukte niet. Laad het opnieuw op.",
	missing: "Het bestand ontbreekt. Laad het opnieuw op.",
};
const STATUS = {
	quarantined: ["Wordt gecontroleerd", "pending"],
	clean: ["Klaar", "ok"],
	rejected: ["Geweigerd", "bad"],
};
const UPLOADED = {
	clean: "Opgeladen en gecontroleerd: het bestand is klaar.",
	quarantined: "Opgeladen. De viruscontrole is nog bezig of tijdelijk niet beschikbaar; het bestand blijft in quarantaine tot het gecontroleerd is. Kom later terug.",
	rejected: "Het bestand is geweigerd: er is schadelijke inhoud gevonden. Het is verwijderd.",
};

function listPage({ files, usage }, links, { csrf, message = "", extract }) {
	const percent = Math.min(100, Math.round((usage.bytes / usage.quota.bytes) * 100));
	const rows = files.length
		? ui`<table class="library uploads"><thead><tr><th scope="col">Bestand</th><th scope="col">Soort</th><th scope="col">Grootte</th><th scope="col">Status</th><th scope="col">Opgeladen</th><th scope="col"><span class="visually-hidden">Acties</span></th></tr></thead><tbody>${files
				.map((f) => {
					const [label, tone] = STATUS[f.status] ?? ["?", "pending"];
					const download = links.get(f.id);
					return ui`<tr><td>${esc(f.name)}</td><td>${esc(KIND_LABEL[f.kind] ?? f.kind)}</td><td>${size(f.size)}</td><td><span class="state ${tone}">${tr(label)}</span>${f.reason && REASONS[f.reason] ? ui`<br><small>${tr(REASONS[f.reason])}</small>` : ""}</td><td>${new Date(f.createdAt).toLocaleDateString(formatLocale(), { timeZone: "Europe/Brussels" })}</td><td class="actions">${download ? ui`<a href="${esc(download)}" download>Downloaden</a>` : ""}${extract && f.status === "clean" && SUPPORTED.has(f.kind) ? fileAction(extract.lang, f, extract.jobs.get(f.id), csrf) : ""}<form method="post" action="${BASE}/${esc(f.id)}/verwijderen"><input type="hidden" name="csrf" value="${esc(csrf)}"><button type="submit" class="link">Verwijderen</button></form></td></tr>`;
				})
				.join("")}</tbody></table>`
		: ui`<p>Je hebt nog geen bestanden opgeladen.</p>`;
	return ui`${message}<p>Laad lesmateriaal en afbeeldingen op om later leerobjecten van te maken. Alleen jij ziet je bestanden.</p>
<section class="card upload-card" aria-labelledby="upload-title"><h2 id="upload-title">Bestand opladen</h2>
<form method="post" action="${BASE}" enctype="multipart/form-data" class="upload-form">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<div class="field"><label for="f-bestand">Bestand</label><small id="f-bestand-hint">PDF, Word (DOCX), PNG, JPEG of WebP, maximaal ${MAX_FILE_BYTES / 1024 / 1024} MB. Geen macro's, scripts of beveiligde bestanden.</small><input id="f-bestand" name="bestand" type="file" required accept=".pdf,.docx,.png,.jpg,.jpeg,.webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/png,image/jpeg,image/webp" aria-describedby="f-bestand-hint"></div>
<div class="field"><label for="f-bron">Waar komt het vandaan?</label><select id="f-bron" name="bron" required>${SOURCE_KINDS.map(([v, t]) => ui`<option value="${v}">${tr(t)}</option>`).join("")}</select></div>
<div class="field"><label for="f-licentie">Mag je het gebruiken?</label><select id="f-licentie" name="licentie" required>${LICENCES.map(([v, t]) => ui`<option value="${v}">${tr(t)}</option>`).join("")}</select></div>
<div class="field"><label for="f-notitie">Bron of maker (optioneel)</label><input id="f-notitie" name="notitie" type="text" maxlength="300" placeholder="Bijvoorbeeld: Biologie voor jou 3, hoofdstuk 2"></div>
<button type="submit">Opladen</button>
</form>
<p class="muted"><small>Elk bestand wordt eerst gecontroleerd op virussen. Tot die controle klaar is, staat het in quarantaine: niemand kan het openen.</small></p></section>
<p class="quota">Gebruikt in deze werkplek: <strong>${size(usage.bytes)}</strong> van ${size(usage.quota.bytes)} · ${usage.files} van ${usage.quota.files} bestanden</p><progress max="100" value="${percent}" aria-label="Gebruikte opslag">${percent}%</progress>
<h2>Je bestanden</h2>${rows}${files.some((f) => f.status === "clean") ? ui`<p class="muted"><small>Downloadlinks werken ${LINK_SECONDS / 60} minuten en alleen voor jou. Laad de pagina opnieuw voor nieuwe links.</small></p>` : ""}`;
}

/** `filename*` for any name, plus an ASCII fallback with nothing a header could misread. */
function disposition(name, extension) {
	const fallback = name.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/["\\;%]/g, "").trim() || `bestand.${extension}`;
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function handleUploads(req, url, { identity, uploads, extractions }) {
	const path = url.pathname;
	if (path !== BASE && !path.startsWith(`${BASE}/`)) return null;
	if (!uploads)
		return {
			status: req.method === "POST" ? 503 : 200,
			title: tr("Bestanden"),
			body: tr("Bestanden opladen is nog niet ingericht op deze server."),
			active: "/bibliotheek",
		};
	const principal = await identity.principal(req);
	if (!principal) return { status: 403, title: tr("Geen toegang"), body: tr("Je hebt geen toegang tot de bestanden.") };
	const csrf = req.managementSession.csrf;
	const guard = async (work) => {
		try {
			return await work();
		} catch (error) {
			if (error?.code === "forbidden")
				return { status: 403, title: tr("Geen toegang"), body: tr("Alleen ouders, begeleiders en leerkrachten laden lesmateriaal op.") };
			if (error?.code === "not_found")
				return { status: 404, title: tr("Niet gevonden"), body: ui`Dit bestand bestaat niet, is niet van jou of is niet klaar. <a href="${BASE}">Naar je bestanden</a>` };
			if (error?.code === "expired")
				return { status: 410, title: tr("Link verlopen"), body: ui`Deze downloadlink is verlopen. <a href="${BASE}">Open je bestanden</a> voor een nieuwe link.` };
			if (error?.code === "unavailable" || error?.name === "StorageError")
				return { status: 503, title: tr("Tijdelijk niet beschikbaar"), body: ui`De opslag is nu niet bereikbaar. Probeer later opnieuw. <a href="${BASE}">Naar je bestanden</a>` };
			throw error;
		}
	};

	if (path === BASE) {
		if (req.method === "GET" || req.method === "HEAD")
			return guard(async () => {
				const list = await uploads.list(principal);
				const links = new Map();
				for (const f of list.files) if (f.status === "clean") links.set(f.id, await uploads.link(principal, f.id));
				const done = url.searchParams.get("opgeladen");
				const message = done && UPLOADED[done] ? notice(tr(UPLOADED[done]), done === "rejected" ? "alert" : "status") : url.searchParams.get("verwijderd") === "1" ? notice(tr("Het bestand is verwijderd.")) : "";
				// breinhap#31: clean PDF and DOCX files can have their text extracted
				const extract = extractions ? { lang: extractLocale(req, url), jobs: await extractions.byUpload(principal) } : undefined;
				return { status: 200, title: tr("Bestanden"), body: listPage(list, links, { csrf, message, extract }), active: "/bibliotheek", headers: { "Cache-Control": "no-store" } };
			});
		if (req.method !== "POST") return { status: 405, title: tr("Niet toegestaan"), body: "", headers: { Allow: "GET, POST" } };
		const boundary = boundaryOf(req.headers["content-type"]);
		const refusedPage = async (status, text) =>
			guard(async () => {
				const list = await uploads.list(principal);
				return { status, title: tr("Bestanden"), body: listPage(list, new Map(), { csrf, message: notice(text, "alert") }), active: "/bibliotheek" };
			});
		if (req.headers.origin !== ORIGIN || !boundary) return { status: 403, title: tr("Aanvraag geweigerd"), body: tr("Laad de pagina opnieuw en probeer nog eens.") };
		let form;
		try {
			form = parseMultipart(await readBody(req, BODY_LIMIT), boundary);
		} catch (error) {
			if (!(error instanceof FormRefused)) throw error;
			return refusedPage(error.status, error.code === "too_large" ? diagnostic(REFUSALS.too_large) : tr("Het formulier kon niet worden gelezen. Laad één bestand tegelijk op."));
		}
		if (form.fields.getAll("csrf").length !== 1 || form.fields.get("csrf") !== csrf)
			return { status: 403, title: tr("Aanvraag geweigerd"), body: tr("Laad de pagina opnieuw en probeer nog eens.") };
		if (!form.file) return refusedPage(400, tr("Kies een bestand."));
		try {
			const result = await uploads.upload(principal, {
				name: form.file.name,
				declaredType: form.file.type,
				bytes: form.file.bytes,
				sourceKind: form.fields.get("bron"),
				licence: form.fields.get("licentie"),
				sourceNote: form.fields.get("notitie"),
			});
			return redirect(`${BASE}?opgeladen=${result.status}`);
		} catch (error) {
			if (error instanceof UploadRefused) return refusedPage(422, diagnostic(REFUSALS[error.code] ?? "") || tr("Dit bestand kan niet worden opgeladen."));
			if (error instanceof UploadError && error.code === "quota") return refusedPage(409, tr("De opslag van deze werkplek is vol. Verwijder eerst bestanden die je niet meer nodig hebt."));
			if (error instanceof UploadError && error.code === "invalid") return refusedPage(422, tr("Kies waar het bestand vandaan komt en of je het mag gebruiken."));
			return guard(() => {
				throw error;
			});
		}
	}

	const match = /^\/bibliotheek\/bestanden\/([0-9a-f-]{36})\/(download|verwijderen)$/.exec(path);
	if (!match) return { status: 404, title: tr("Niet gevonden"), body: ui`<a href="${BASE}">Naar je bestanden</a>` };
	const [, id, action] = match;
	if (action === "download") {
		if (req.method !== "GET" && req.method !== "HEAD") return { status: 405, title: tr("Niet toegestaan"), body: "", headers: { Allow: "GET" } };
		return guard(async () => {
			const file = await uploads.download(principal, id, {
				expires: url.searchParams.get("verloopt"),
				signature: url.searchParams.get("handtekening"),
			});
			return {
				raw: true,
				status: 200,
				body: file.bytes,
				type: file.mediaType,
				headers: {
					"Content-Disposition": disposition(file.name, TYPES[file.kind].extensions[0]),
					"Content-Length": String(file.bytes.length),
					"Content-Security-Policy": "sandbox; default-src 'none'",
					"Cache-Control": "private, no-store",
					"Cross-Origin-Resource-Policy": "same-origin",
				},
			};
		});
	}
	if (req.method !== "POST") return { status: 405, title: tr("Niet toegestaan"), body: "", headers: { Allow: "POST" } };
	const body = await readBody(req, 4096).catch(() => Buffer.alloc(0));
	const fields = new URLSearchParams(body.toString("utf8"));
	if (req.headers.origin !== ORIGIN || fields.getAll("csrf").length !== 1 || fields.get("csrf") !== csrf)
		return { status: 403, title: tr("Aanvraag geweigerd"), body: tr("Laad de pagina opnieuw en probeer nog eens.") };
	return guard(async () => {
		await uploads.remove(principal, id);
		return redirect(`${BASE}?verwijderd=1`);
	});
}
