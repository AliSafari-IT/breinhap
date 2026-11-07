import { entryData, UploadRefused, zipEntries } from "../uploads/validate.mjs";
import { ExtractFailed, LIMITS } from "./limits.mjs";

/**
 * breinhap#31: the text of a DOCX, read as data. Only word/document.xml and its relationships are
 * inflated (with an output cap); nothing is executed, rendered or fetched.
 *
 * - A DOCTYPE or entity declaration is refused: no external entities, no entity expansion.
 * - Field codes (INCLUDETEXT, INCLUDEPICTURE, HYPERLINK, …) are dropped: their instructions can point
 *   at files or URLs, and only their last computed result (the visible text) is kept.
 * - External relationships (links, linked images, a remote template) and embedded chunks are never
 *   followed; the extraction says they were ignored.
 * - Images are not read. A document with images and no text gets the "OCR not available" warning.
 *
 * Returns `{ blocks, warnings, units }`; each block is `{ type, text, ref: { paragraph } }`.
 */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (text) =>
	text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/g, (_, name) => {
		if (name[0] !== "#") return ENTITIES[name];
		const code = name[1] === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
		return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
	});

/** Heading styles in the languages Word ships (Heading1, Kop1, Titre1, Überschrift1) and Title. */
const HEADING = /^(heading|kop|titre|berschrift|titel|title|subtitle|ondertitel)/i;

function part(buf, entries, name, limit) {
	const entry = entries.find((e) => e.name === name);
	if (!entry) return null;
	try {
		return entryData(buf, entry, limit).toString("utf8");
	} catch (error) {
		// a declared size over the limit, or data that inflates past it whatever it declared
		if (error instanceof UploadRefused || error instanceof RangeError || error?.code === "ERR_BUFFER_TOO_LARGE") throw new ExtractFailed("too_large");
		throw new ExtractFailed("corrupt");
	}
}

export function extractDocx(bytes, { onProgress = () => {} } = {}) {
	let entries;
	try {
		entries = zipEntries(bytes);
	} catch (error) {
		if (error instanceof UploadRefused) throw new ExtractFailed(error.code === "encrypted" ? "encrypted" : error.code === "zip_bomb" ? "too_large" : "corrupt");
		throw new ExtractFailed("corrupt");
	}
	const xml = part(bytes, entries, "word/document.xml", LIMITS.docxXmlBytes);
	if (xml === null) throw new ExtractFailed("corrupt");
	if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new ExtractFailed("unsupported");
	if (!/<w:body\b/.test(xml)) throw new ExtractFailed("corrupt");

	const warnings = new Set();
	const rels = part(bytes, entries, "word/_rels/document.xml.rels", 512 * 1024) ?? "";
	if (/TargetMode\s*=\s*"External"/i.test(rels)) warnings.add("external_links_ignored");
	const settings = part(bytes, entries, "word/_rels/settings.xml.rels", 64 * 1024) ?? "";
	if (/TargetMode\s*=\s*"External"/i.test(settings)) warnings.add("external_links_ignored");
	if (/<w:altChunk\b/.test(xml)) warnings.add("embedded_content_ignored");
	if (/<w:(instrText|fldSimple)\b/.test(xml)) warnings.add("fields_ignored");
	const images = entries.some((e) => e.name.startsWith("word/media/")) || /<w:drawing\b|<w:pict\b/.test(xml);
	if (images) warnings.add("images_ignored");
	if (entries.some((e) => /^word\/(footnotes|endnotes|comments)\.xml$/.test(e.name))) warnings.add("notes_ignored");

	const blocks = [];
	let chars = 0;
	let paragraph = 0;
	const push = (type, text, inTable) => {
		const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
		if (!clean) return;
		if (blocks.length >= LIMITS.blocks || chars + clean.length > LIMITS.chars) {
			warnings.add("truncated");
			return;
		}
		chars += clean.length;
		blocks.push({ type: inTable ? "table" : type, text: clean, ref: { paragraph } });
	};

	// paragraphs (w:p) in body order; table cells' paragraphs are joined per row. Text boxes hold
	// paragraphs inside a paragraph: their text is read after the body (once: the VML fallback copy of
	// a text box is dropped), so the paragraph around them stays whole.
	const boxes = [];
	const body =
		xml
			.slice(xml.indexOf("<w:body"))
			.replace(/<mc:Fallback\b[\s\S]*?<\/mc:Fallback>/g, "")
			.replace(/<w:txbxContent\b[^>]*>([\s\S]*?)<\/w:txbxContent>/g, (_, inner) => {
				boxes.push(inner);
				return "";
			}) + boxes.join("");
	const total = Math.max(1, (body.match(/<w:p[ >]/g) ?? []).length);
	let row = null;
	const token = /<w:tr[ >]|<\/w:tr>|<w:p(?=[ >\/])[^>]*\/>|<w:p(?=[ >])[^>]*>([\s\S]*?)<\/w:p>/g;
	for (const match of body.matchAll(token)) {
		const tag = match[0];
		if (tag.startsWith("<w:tr")) {
			row = [];
			continue;
		}
		if (tag === "</w:tr>") {
			if (row) push("table", row.join(" | "), true);
			row = null;
			continue;
		}
		paragraph += 1;
		if (paragraph % 50 === 0) onProgress(paragraph, total);
		const inner = match[1] ?? "";
		const text = paragraphText(inner);
		if (row) {
			if (text.trim()) row.push(text.trim());
			continue;
		}
		const style = /<w:pStyle\s+w:val="([^"]{1,80})"/.exec(inner)?.[1] ?? "";
		const type = HEADING.test(style) || /<w:outlineLvl\b/.test(inner) ? "heading" : /<w:numPr\b/.test(inner) ? "list" : "paragraph";
		push(type, text, false);
	}
	onProgress(total, total);
	if (!blocks.length) warnings.add(images ? "ocr_unavailable" : "no_text");
	return { blocks, warnings: [...warnings], units: paragraph };
}

/** The visible text of one paragraph: runs' w:t, tabs and breaks; field instructions left out. */
function paragraphText(inner) {
	let out = "";
	let inField = 0;
	let instruction = false;
	const token = /<w:fldChar\b[^>]*w:fldCharType="(begin|separate|end)"[^>]*\/?>|<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>|<w:delText\b[^>]*>[\s\S]*?<\/w:delText>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\b[^>]*\/>|<w:cr\/>/g;
	for (const match of inner.matchAll(token)) {
		const tag = match[0];
		if (match[1] === "begin") {
			inField += 1;
			instruction = true;
		} else if (match[1] === "separate") instruction = false;
		else if (match[1] === "end") {
			inField = Math.max(0, inField - 1);
			instruction = inField > 0;
		} else if (tag.startsWith("<w:instrText") || tag.startsWith("<w:delText")) continue;
		else if (instruction) continue;
		else if (tag.startsWith("<w:t")) out += decode(match[2] ?? "");
		else if (tag === "<w:tab/>") out += "\t";
		else out += "\n";
	}
	return out;
}
