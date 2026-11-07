// breinhap#31: PDFs and DOCX files for the extraction tests, built byte by byte (no test runs here).
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

// ── an encrypted PDF ─────────────────────────────────────────────────────────────────────────────

/**
 * A PDF behind the standard security handler (revision 2) whose check values match no empty password:
 * a reader can only open it with a password it is not given. (The check values need not come from a
 * real password for that, so none is derived here.)
 */
export function encryptedPdf() {
	const id = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
	const hex = (b) => `<${b.toString("hex")}>`;
	const check = (byte) => Buffer.alloc(32, byte);
	// the encryption dictionary is object 5, just before the catalog (object 6)
	const pdf = textPdf([["Geheim"]], { extraObjects: [`<</Filter/Standard/V 1/R 2/O ${hex(check(0xa5))}/U ${hex(check(0x5a))}/P -4>>`] });
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
