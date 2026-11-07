import { ExtractFailed, LIMITS } from "./limits.mjs";
import { checkPdfBudget } from "./pdf-budget.mjs";

/**
 * breinhap#31: the text layer of a PDF, through pdf.js (Mozilla's parser, the one Firefox uses for
 * untrusted PDFs), run only inside the parser thread (thread.mjs). Configured to read, never to act:
 *
 * - no `eval` (fonts are not compiled to code), no font faces, no system fonts, no XFA forms;
 * - no URLs: the bytes are passed in memory; no CMap or font URL is set, so nothing is fetched (the
 *   thread has no fetch either); annotations, links, attachments and scripts are never loaded;
 * - only `getTextContent`: pages are not rendered and images are not decoded.
 *
 * Pages without text are reported: a scanned or image-only PDF gets the "OCR not available" warning.
 * Returns `{ blocks, warnings, units }`; each block is `{ type, text, ref: { page } }`.
 */

const OPTIONS = {
	isEvalSupported: false,
	disableFontFace: true,
	useSystemFonts: false,
	enableXfa: false,
	isOffscreenCanvasSupported: false,
	isImageDecoderSupported: false,
	useWorkerFetch: false,
	disableAutoFetch: true,
	disableStream: true,
	disableRange: true,
	stopAtErrors: false,
	maxImageSize: 0,
	verbosity: 0,
};

let pdfjs;
async function library() {
	pdfjs ??= await import("pdfjs-dist/legacy/build/pdf.mjs");
	return pdfjs;
}

const median = (values) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

/** Lines (text + size + baseline) from pdf.js text items, in reading order as the file gives them. */
function linesOf(items) {
	const lines = [];
	let line = null;
	for (const item of items) {
		if (typeof item.str !== "string") continue;
		const y = item.transform?.[5] ?? 0;
		const size = Math.abs(item.transform?.[3] ?? item.height ?? 0) || item.height || 0;
		if (!line || (item.str && Math.abs(y - line.y) > Math.max(2, line.size * 0.5))) {
			if (line) lines.push(line);
			line = { text: "", y, size };
		}
		line.text += item.str;
		if (item.str.trim()) line.size = Math.max(line.size, size);
		if (item.hasEOL) {
			lines.push(line);
			line = null;
		}
	}
	if (line) lines.push(line);
	return lines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })).filter((l) => l.text);
}

export async function extractPdf(bytes, { onProgress = () => {} } = {}) {
	// decoded streams sit outside the heap cap: a compression bomb is refused before pdf.js reads it
	checkPdfBudget(bytes);
	const { getDocument } = await library();
	let doc;
	const task = getDocument({ ...OPTIONS, data: new Uint8Array(bytes) });
	try {
		doc = await task.promise;
	} catch (error) {
		await task.destroy().catch(() => {});
		if (error?.name === "PasswordException") throw new ExtractFailed("encrypted");
		if (error?.name === "InvalidPDFException" || error?.name === "FormatError") throw new ExtractFailed("corrupt");
		throw new ExtractFailed("corrupt");
	}
	const warnings = new Set();
	const blocks = [];
	const empty = [];
	let chars = 0;
	try {
		const pages = Math.min(doc.numPages, LIMITS.pages);
		if (doc.numPages > LIMITS.pages) warnings.add("truncated_pages");
		for (let number = 1; number <= pages; number++) {
			let lines;
			try {
				const page = await doc.getPage(number);
				const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
				lines = linesOf(content.items);
				page.cleanup();
			} catch {
				warnings.add("pages_unreadable");
				onProgress(number, pages);
				continue;
			}
			if (!lines.length) empty.push(number);
			const body = median(lines.map((l) => l.size));
			let paragraph = null;
			const flush = () => {
				if (!paragraph) return;
				for (let text = paragraph.text; text; ) {
					const piece = text.length > LIMITS.blockChars ? text.slice(0, text.lastIndexOf(" ", LIMITS.blockChars) > 0 ? text.lastIndexOf(" ", LIMITS.blockChars) : LIMITS.blockChars) : text;
					text = text.slice(piece.length).trim();
					if (blocks.length >= LIMITS.blocks || chars + piece.length > LIMITS.chars) {
						warnings.add("truncated");
						break;
					}
					chars += piece.length;
					blocks.push({ type: paragraph.type, text: piece.trim(), ref: { page: number } });
				}
				paragraph = null;
			};
			let previous = null;
			for (const line of lines) {
				const heading = body > 0 && line.size >= body * 1.25 && line.text.length <= 200;
				const gap = previous ? Math.abs(previous.y - line.y) : 0;
				const bullet = /^([•▪◦\-–*]|\d{1,2}[.)]|[a-z][.)])\s/.test(line.text);
				const breaks = !paragraph || heading || paragraph.type === "heading" || bullet || gap > Math.max(previous.size, line.size) * 1.7;
				if (breaks) {
					flush();
					paragraph = { type: heading ? "heading" : bullet ? "list" : "paragraph", text: line.text };
				} else paragraph.text = paragraph.text.endsWith("-") ? `${paragraph.text.slice(0, -1)}${line.text}` : `${paragraph.text} ${line.text}`;
				previous = line;
			}
			flush();
			onProgress(number, pages);
		}
		if (pages > 0 && empty.length === pages) warnings.add("ocr_unavailable");
		else if (empty.length) warnings.add("pages_without_text");
		return { blocks, warnings: [...warnings], units: pages, emptyPages: empty.slice(0, 50) };
	} finally {
		await task.destroy().catch(() => {});
	}
}
