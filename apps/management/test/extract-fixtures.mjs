// breinhap#31: PDFs and DOCX files for the extraction tests, built byte by byte (no test runs here).
import { createHash } from "node:crypto";

import { CONTENT_TYPES, zip } from "./upload-fixtures.mjs";

const pdfString = (text) => `(${text.replace(/[()\\]/g, (c) => `\\${c}`)})`;

/**
 * A valid PDF with an xref table. `pages` is a list of pages; each page a list of lines (strings, or
 * `{ text, size }`; an empty string leaves a gap). `image: true` draws a filled box instead of text
 * (what a scan looks like to a text extractor). `trailer` adds trailer entries (e.g. /Encrypt).
 */
export function textPdf(pages, { image = [], trailer = "", extraObjects = [] } = {}) {
	const objects = [];
	const add = (body) => objects.push(body) && objects.length;
	const font = add("<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>");
	const pagesId = add(null);
	const kids = [];
	pages.forEach((lines, index) => {
		let ops;
		if (image.includes(index)) ops = "q 400 0 0 500 100 100 cm 0.5 g 0 0 1 1 re f Q";
		else {
			ops = "BT 72 740 Td";
			for (const line of lines) {
				const { text, size = 12 } = typeof line === "string" ? { text: line } : line;
				ops += ` /F1 ${size} Tf 0 -${Math.round(size * 1.2)} Td ${text ? `${pdfString(text)} Tj` : ""}`;
			}
			ops += " ET";
		}
		const content = add(`<</Length ${Buffer.byteLength(ops, "latin1")}>>stream\n${ops}\nendstream`);
		kids.push(add(`<</Type/Page/Parent ${pagesId} 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 ${font} 0 R>>>>/Contents ${content} 0 R>>`));
	});
	objects[pagesId - 1] = `<</Type/Pages/Kids[${kids.map((k) => `${k} 0 R`).join(" ")}]/Count ${kids.length}>>`;
	for (const extra of extraObjects) add(extra);
	const catalog = add(`<</Type/Catalog/Pages ${pagesId} 0 R>>`);
	let out = "%PDF-1.7\n";
	const offsets = [];
	objects.forEach((body, i) => {
		offsets.push(Buffer.byteLength(out, "latin1"));
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xref = Buffer.byteLength(out, "latin1");
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
	out += `trailer\n<</Size ${objects.length + 1}/Root ${catalog} 0 R${trailer}>>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

// ── an encrypted PDF (standard security handler, revision 2, RC4 40-bit, with a user password) ────

const PAD = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");
const padded = (password) => Buffer.concat([Buffer.from(password, "latin1"), PAD]).subarray(0, 32);
function rc4(key, data) {
	const s = [...Array(256).keys()];
	for (let i = 0, j = 0; i < 256; i++) {
		j = (j + s[i] + key[i % key.length]) & 255;
		[s[i], s[j]] = [s[j], s[i]];
	}
	const out = Buffer.alloc(data.length);
	for (let n = 0, i = 0, j = 0; n < data.length; n++) {
		i = (i + 1) & 255;
		j = (j + s[i]) & 255;
		[s[i], s[j]] = [s[j], s[i]];
		out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
	}
	return out;
}
const md5 = (...parts) => createHash("md5").update(Buffer.concat(parts)).digest();

export function encryptedPdf(userPassword = "geheim", ownerPassword = "eigenaar") {
	const id = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
	const permissions = -4;
	const owner = rc4(md5(padded(ownerPassword)).subarray(0, 5), padded(userPassword));
	const p = Buffer.alloc(4);
	p.writeInt32LE(permissions);
	const key = md5(padded(userPassword), owner, p, id).subarray(0, 5);
	const user = rc4(key, PAD);
	const hex = (b) => `<${b.toString("hex")}>`;
	// the encryption dictionary is the last object before the catalog: number = pages + 2·pages + 3
	const pdf = textPdf([["Geheim"]], { extraObjects: [`<</Filter/Standard/V 1/R 2/O ${hex(owner)}/U ${hex(user)}/P ${permissions}>>`] });
	return Buffer.from(pdf.toString("latin1").replace("/Root 6 0 R>>", `/Root 6 0 R/Encrypt 5 0 R/ID[${hex(id)}${hex(id)}]>>`), "latin1");
}

// ── DOCX ─────────────────────────────────────────────────────────────────────────────────────────

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
export const para = (text, style) =>
	`<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
export const listItem = (text) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
export const table = (rows) =>
	`<w:tbl>${rows.map((cells) => `<w:tr>${cells.map((c) => `<w:tc>${para(c)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
export const documentXml = (body, prolog = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>') => `${prolog}<w:document ${W}><w:body>${body}</w:body></w:document>`;

/** A DOCX with the given body XML, plus extra entries. */
export const docxOf = (body, extra = [], options) =>
	zip([["[Content_Types].xml", CONTENT_TYPES], ["word/document.xml", typeof body === "string" && body.startsWith("<?xml") ? body : documentXml(body)], ...extra], options);
