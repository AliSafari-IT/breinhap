import { constants, inflateRawSync, inflateSync } from "node:zlib";

/**
 * breinhap#29: what an uploaded file must be before it is even stored in quarantine. Teaching material
 * (PDF, DOCX) and images (PNG, JPEG, WebP) only. The file's own bytes decide its type: the extension and
 * the browser's media type must agree with the signature, and each format is checked for the ways it is
 * abused (scripts and launch actions in a PDF, macros and ActiveX in a DOCX, data after an image's end,
 * one file that is also another). Executables, scripts, SVG, legacy Office and archives are refused.
 *
 * Only the structure is read: PDF objects are not executed, ZIP entries are not extracted to disk (only
 * the small [Content_Types].xml is inflated, with a hard output limit), images are not decoded.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_NAME = 120;

export const TYPES = {
	pdf: { mediaType: "application/pdf", extensions: ["pdf"], label: "PDF" },
	docx: {
		mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		extensions: ["docx"],
		label: "Word (DOCX)",
	},
	png: { mediaType: "image/png", extensions: ["png"], label: "PNG" },
	jpeg: { mediaType: "image/jpeg", extensions: ["jpg", "jpeg"], label: "JPEG" },
	webp: { mediaType: "image/webp", extensions: ["webp"], label: "WebP" },
};

export class UploadRefused extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}
const refuse = (code) => {
	throw new UploadRefused(code);
};

/** A display name that is safe anywhere: no path, no control or bidi characters, at most MAX_NAME. */
export function cleanFileName(raw) {
	const base = String(raw ?? "")
		.normalize("NFC")
		.split(/[\\/]/)
		.pop()
		.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩"<>:|?*]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "");
	if (!base) return "";
	if (base.length <= MAX_NAME) return base;
	const dot = base.lastIndexOf(".");
	const ext = dot > 0 && base.length - dot <= 6 ? base.slice(dot) : "";
	return base.slice(0, MAX_NAME - ext.length) + ext;
}

const extensionOf = (name) => {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
};
const startsWith = (buf, bytes, at = 0) => bytes.every((b, i) => buf[at + i] === b);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const indexOf = (buf, text, from = 0) => buf.indexOf(Buffer.from(text, "latin1"), from);

/** The format the bytes say, or null. Formats we refuse outright are reported by their own code. */
export function sniff(buf) {
	if (startsWith(buf, ascii("%PDF-"))) return "pdf";
	if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return "zip";
	if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
	if (startsWith(buf, [0xff, 0xd8, 0xff])) return "jpeg";
	if (startsWith(buf, ascii("RIFF")) && startsWith(buf, ascii("WEBP"), 8)) return "webp";
	if (startsWith(buf, [0x4d, 0x5a])) return "executable"; // MZ: Windows PE
	if (startsWith(buf, [0x7f, 0x45, 0x4c, 0x46])) return "executable"; // ELF
	if ([[0xfe, 0xed, 0xfa], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe]].some((m) => startsWith(buf, m))) return "executable";
	if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "legacy-office"; // OLE2: .doc, .xls, .ppt
	if (startsWith(buf, [0x1f, 0x8b]) || startsWith(buf, ascii("Rar!")) || startsWith(buf, [0x37, 0x7a, 0xbc, 0xaf])) return "archive";
	const head = buf.subarray(0, 512).toString("latin1").trimStart().toLowerCase();
	if (head.startsWith("#!") || head.startsWith("<?php")) return "script";
	if (head.startsWith("<svg") || head.startsWith("<?xml") || head.startsWith("<!doctype") || head.startsWith("<html")) return "markup";
	return null;
}

// ── PDF ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Names that make a PDF act instead of display (names are case-sensitive; a name may hide letters as #xx
 * escapes). They live in dictionaries: in the file's plain text, or compressed inside object streams.
 * Page content streams are skipped: random compressed bytes would otherwise look like names.
 */
const PDF_ACTIVE = new Set(["JavaScript", "JS", "Launch", "EmbeddedFile", "EmbeddedFiles", "RichMedia", "XFA", "SubmitForm", "ImportData", "GoToE"]);
const PDF_INFLATE_BUDGET = 8 * 1024 * 1024;

function pdfNames(text) {
	for (const match of text.matchAll(/\/([A-Za-z0-9#]{1,40})/g)) {
		const name = match[1].replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
		if (PDF_ACTIVE.has(name)) refuse("pdf_active_content");
	}
}

function checkPdf(buf) {
	const tail = buf.subarray(Math.max(0, buf.length - 1024)).toString("latin1");
	if (!tail.includes("%%EOF")) refuse("pdf_truncated");
	if (buf.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]))) refuse("polyglot");
	const text = buf.toString("latin1");
	if (/\/Encrypt\b/.test(text)) refuse("encrypted");
	let budget = PDF_INFLATE_BUDGET;
	let plain = "";
	let last = 0;
	for (const match of text.matchAll(/(?<!end)stream\r?\n/g)) {
		const begin = match.index + match[0].length;
		if (begin < last) continue;
		const finish = text.indexOf("endstream", begin);
		if (finish === -1) refuse("pdf_truncated");
		const dictionary = text.slice(Math.max(last, match.index - 600), match.index);
		plain += text.slice(last, match.index);
		last = finish + "endstream".length;
		// an object stream holds dictionaries: read it (compressed or not) like the plain text
		if (!/\/Type\s*\/ObjStm/.test(dictionary)) continue;
		let body = buf.subarray(begin, finish);
		if (/\/FlateDecode/.test(dictionary)) {
			if (budget <= 0) refuse("pdf_active_content");
			try {
				body = inflateSync(body, { maxOutputLength: budget, finishFlush: constants.Z_SYNC_FLUSH });
			} catch {
				refuse("pdf_active_content"); // what cannot be read cannot be shown to be harmless
			}
			budget -= body.length;
		} else if (/\/Filter/.test(dictionary)) refuse("pdf_active_content");
		pdfNames(body.toString("latin1"));
	}
	pdfNames(plain + text.slice(last));
}

// ── DOCX (a ZIP) ───────────────────────────────────────────────────────────────────────────────────

const MAX_ENTRIES = 2000;
const MAX_UNCOMPRESSED = 100 * 1024 * 1024;
const MAX_RATIO = 200;

/** The central directory of a ZIP that starts at byte 0 and ends exactly at its EOCD record. */
export function zipEntries(buf) {
	const min = Math.max(0, buf.length - 22 - 0xffff);
	let eocd = -1;
	for (let i = buf.length - 22; i >= min; i--)
		if (buf.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	if (eocd < 0) refuse("zip_invalid");
	const commentLength = buf.readUInt16LE(eocd + 20);
	if (eocd + 22 + commentLength !== buf.length) refuse("polyglot"); // data after the archive
	const count = buf.readUInt16LE(eocd + 10);
	const size = buf.readUInt32LE(eocd + 12);
	const offset = buf.readUInt32LE(eocd + 16);
	if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) refuse("zip_invalid"); // ZIP64
	if (count > MAX_ENTRIES) refuse("zip_too_many_entries");
	if (offset + size !== eocd) refuse("zip_invalid");
	const entries = [];
	let at = offset;
	let total = 0;
	for (let n = 0; n < count; n++) {
		if (at + 46 > eocd || buf.readUInt32LE(at) !== 0x02014b50) refuse("zip_invalid");
		const flags = buf.readUInt16LE(at + 8);
		const method = buf.readUInt16LE(at + 10);
		const compressed = buf.readUInt32LE(at + 20);
		const uncompressed = buf.readUInt32LE(at + 24);
		const nameLength = buf.readUInt16LE(at + 28);
		const extra = buf.readUInt16LE(at + 30);
		const comment = buf.readUInt16LE(at + 32);
		const local = buf.readUInt32LE(at + 42);
		const name = buf.subarray(at + 46, at + 46 + nameLength).toString("utf8");
		if (flags & 0x1) refuse("encrypted");
		if (![0, 8].includes(method)) refuse("zip_invalid");
		if (local >= offset || buf.readUInt32LE(local) !== 0x04034b50) refuse("zip_invalid");
		if (name.includes("..") || name.startsWith("/") || name.includes("\\")) refuse("zip_invalid");
		total += uncompressed;
		if (total > MAX_UNCOMPRESSED) refuse("zip_bomb");
		if (compressed > 0 && uncompressed / compressed > MAX_RATIO) refuse("zip_bomb");
		entries.push({ name, method, compressed, uncompressed, local });
		at += 46 + nameLength + extra + comment;
	}
	return entries;
}

function entryData(buf, entry, limit) {
	const nameLength = buf.readUInt16LE(entry.local + 26);
	const extra = buf.readUInt16LE(entry.local + 28);
	const start = entry.local + 30 + nameLength + extra;
	const raw = buf.subarray(start, start + entry.compressed);
	if (entry.uncompressed > limit) refuse("zip_bomb");
	return entry.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: limit });
}

/** Parts that can run code or pull in other programs. */
const DOCX_ACTIVE = [/vbaproject\.bin$/i, /vbadata\.xml$/i, /^word\/activex\//i, /\.(exe|dll|bat|cmd|com|scr|js|vbs|ps1|jar|msi)$/i, /oleobject\d*\.bin$/i, /^word\/embeddings\//i];

function checkDocx(buf) {
	const entries = zipEntries(buf);
	const names = new Set(entries.map((e) => e.name));
	if (!names.has("[Content_Types].xml") || !names.has("word/document.xml")) refuse("type_mismatch");
	if (entries.some((e) => DOCX_ACTIVE.some((pattern) => pattern.test(e.name)))) refuse("docx_active_content");
	const types = entries.find((e) => e.name === "[Content_Types].xml");
	let xml;
	try {
		xml = entryData(buf, types, 256 * 1024).toString("utf8");
	} catch (error) {
		if (error instanceof UploadRefused) throw error;
		refuse("zip_invalid");
	}
	if (/macroEnabled|vbaProject|activeX/i.test(xml)) refuse("docx_active_content");
	if (!/wordprocessingml\.document\.main\+xml/.test(xml)) refuse("type_mismatch");
}

// ── images ─────────────────────────────────────────────────────────────────────────────────────────

function checkPng(buf) {
	// chunks to IEND, which must be the last 12 bytes: anything after it is a second file
	let at = 8;
	let first = true;
	while (at + 12 <= buf.length) {
		const length = buf.readUInt32BE(at);
		const type = buf.subarray(at + 4, at + 8).toString("latin1");
		if (first && type !== "IHDR") refuse("type_mismatch");
		first = false;
		if (length > buf.length) refuse("image_invalid");
		at += 12 + length;
		if (type === "IEND") {
			if (at !== buf.length) refuse("polyglot");
			return;
		}
	}
	refuse("image_invalid");
}

function checkJpeg(buf) {
	// an end-of-image marker must close the file
	if (buf.length < 4 || buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) refuse("polyglot");
}

function checkWebp(buf) {
	if (buf.readUInt32LE(4) + 8 !== buf.length) refuse("polyglot");
}

function checkNoOtherFormat(buf) {
	if (indexOf(buf, "%PDF-") !== -1 || buf.includes(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) refuse("polyglot");
	const text = buf.toString("latin1").toLowerCase();
	if (text.includes("<script") || text.includes("<?php") || text.includes("<html")) refuse("polyglot");
}

/**
 * Validates one file. Returns `{ kind, mediaType, extension, name }`; throws `UploadRefused` with a code
 * for the page to explain.
 */
export function validateFile({ name, declaredType, bytes }) {
	const clean = cleanFileName(name);
	if (!clean) refuse("name_missing");
	if (!bytes || bytes.length === 0) refuse("empty");
	if (bytes.length > MAX_FILE_BYTES) refuse("too_large");
	const extension = extensionOf(clean);
	const kind = Object.keys(TYPES).find((k) => TYPES[k].extensions.includes(extension));
	const sniffed = sniff(bytes);
	if (["executable", "script", "markup", "legacy-office", "archive"].includes(sniffed)) refuse(`refused_${sniffed.replace("-", "_")}`);
	if (/^(docm|dotm|xlsm|pptm|doc|xls|ppt|exe|js|svg|zip|html?)$/.test(extension)) refuse("type_not_allowed");
	if (!kind) refuse("type_not_allowed");
	const expected = kind === "docx" ? "zip" : kind;
	if (sniffed !== expected) refuse("type_mismatch");
	const mediaType = TYPES[kind].mediaType;
	// browsers send this from the extension; a different one means the name and the content disagree
	const declared = String(declaredType ?? "").split(";")[0].trim().toLowerCase();
	if (declared && declared !== "application/octet-stream" && declared !== mediaType) refuse("type_mismatch");
	if (kind === "pdf") checkPdf(bytes);
	if (kind === "docx") checkDocx(bytes);
	if (kind === "png") checkPng(bytes);
	if (kind === "jpeg") checkJpeg(bytes);
	if (kind === "webp") checkWebp(bytes);
	if (["png", "jpeg", "webp"].includes(kind)) checkNoOtherFormat(bytes.subarray(kind === "png" ? 8 : 2));
	return { kind, mediaType, extension, name: clean };
}

/** Dutch messages for the upload page. */
export const REFUSALS = {
	name_missing: "Het bestand heeft geen naam.",
	empty: "Het bestand is leeg.",
	too_large: `Het bestand is te groot (maximaal ${MAX_FILE_BYTES / 1024 / 1024} MB).`,
	type_not_allowed: "Dit soort bestand kan niet. Gebruik PDF, Word (DOCX), PNG, JPEG of WebP.",
	type_mismatch: "De naam van het bestand past niet bij wat erin zit. Sla het opnieuw op in het juiste formaat.",
	refused_executable: "Programma's kunnen niet worden opgeladen.",
	refused_script: "Scripts kunnen niet worden opgeladen.",
	refused_markup: "Web- en SVG-bestanden kunnen niet worden opgeladen. Gebruik PNG of PDF.",
	refused_legacy_office: "Oude Office-bestanden (.doc, .xls, .ppt) kunnen macro's bevatten. Sla het op als DOCX of PDF.",
	refused_archive: "Archieven (zoals .zip of .rar) kunnen niet. Laad de bestanden afzonderlijk op.",
	pdf_truncated: "Deze PDF is onvolledig of beschadigd.",
	pdf_active_content: "Deze PDF bevat scripts, bijlagen of acties. Sla hem opnieuw op als gewone PDF (bijvoorbeeld via Afdrukken naar PDF).",
	docx_active_content: "Dit Word-bestand bevat macro's, ActiveX of ingesloten programma's. Sla het op als gewoon DOCX-document zonder macro's.",
	encrypted: "Beveiligde of versleutelde bestanden kunnen niet worden gecontroleerd. Verwijder het wachtwoord en probeer opnieuw.",
	zip_invalid: "Dit Word-bestand is beschadigd.",
	zip_too_many_entries: "Dit Word-bestand is te complex.",
	zip_bomb: "Dit bestand is uitgepakt veel te groot.",
	image_invalid: "Deze afbeelding is beschadigd.",
	polyglot: "Dit bestand bevat ook nog een ander bestand. Sla het opnieuw op en probeer nog eens.",
};
