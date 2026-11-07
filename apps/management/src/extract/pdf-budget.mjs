import { constants, inflateSync } from "node:zlib";

import { ExtractFailed, LIMITS } from "./limits.mjs";

/**
 * breinhap#31: how much a PDF decodes to, measured before pdf.js sees it. A worker thread's heap cap
 * does not cover ArrayBuffers, and pdf.js keeps each decoded stream in one growing buffer, so a
 * compression bomb (a small stream that inflates to gigabytes) would otherwise grow the whole process
 * past its memory limit. Every stream is decoded here with a hard output cap, per stream and in total;
 * a PDF over either is refused (`too_large`) without pdf.js ever reading it.
 *
 * Filters measured: FlateDecode, ASCIIHexDecode, ASCII85Decode, RunLengthDecode (also chained). Image
 * filters (DCT, JPX, JBIG2, CCITT) are never decoded by text extraction, so they end the chain. LZW and
 * filters given indirectly cannot be measured here: such a PDF is refused (`unsupported`).
 */

const IMAGE = new Set(["DCTDecode", "DCT", "JPXDecode", "JBIG2Decode", "CCITTFaxDecode", "CCF"]);
const ALIAS = { Fl: "FlateDecode", AHx: "ASCIIHexDecode", A85: "ASCII85Decode", RL: "RunLengthDecode", LZW: "LZWDecode" };

function filtersOf(dictionary) {
	const at = dictionary.search(/\/Filter\b/);
	if (at === -1) return [];
	const rest = dictionary.slice(at + 7).trimStart();
	if (/^\d+\s+\d+\s+R/.test(rest)) throw new ExtractFailed("unsupported");
	const names = rest.startsWith("[") ? rest.slice(1, rest.indexOf("]")) : (/^\/[A-Za-z0-9]+/.exec(rest)?.[0] ?? "");
	return [...names.matchAll(/\/([A-Za-z0-9]+)/g)].map((m) => ALIAS[m[1]] ?? m[1]);
}

function ascii85(buf, cap) {
	const out = Buffer.alloc(Math.min(cap + 4, Math.ceil(buf.length * 1.25) + 4));
	let at = 0;
	let group = 0;
	let count = 0;
	for (const byte of buf) {
		if (byte === 0x7e) break; // ~>
		if (byte <= 0x20) continue;
		if (byte === 0x7a && count === 0) {
			if (at + 4 > cap) throw new ExtractFailed("too_large");
			at += 4; // "z": four zero bytes
			continue;
		}
		group = group * 85 + (byte - 33);
		if (++count === 5) {
			if (at + 4 > cap) throw new ExtractFailed("too_large");
			out.writeUInt32BE(group >>> 0, at);
			at += 4;
			group = 0;
			count = 0;
		}
	}
	return out.subarray(0, at);
}

function runLength(buf, cap) {
	const out = Buffer.alloc(Math.min(cap + 128, buf.length * 128));
	let at = 0;
	for (let i = 0; i < buf.length; ) {
		const n = buf[i++];
		if (n === 128) break;
		const length = n < 128 ? n + 1 : 257 - n;
		if (at + length > cap) throw new ExtractFailed("too_large");
		if (n < 128) {
			buf.copy(out, at, i, i + length);
			i += length;
		} else out.fill(buf[i++], at, at + length);
		at += length;
	}
	return out.subarray(0, at);
}

function decode(filter, data, cap) {
	if (filter === "FlateDecode") {
		try {
			return inflateSync(data, { maxOutputLength: cap + 1, finishFlush: constants.Z_SYNC_FLUSH });
		} catch (error) {
			if (error instanceof RangeError || error?.code === "ERR_BUFFER_TOO_LARGE") throw new ExtractFailed("too_large");
			return Buffer.alloc(0); // broken data: pdf.js reads what it can, which is no more than this
		}
	}
	if (filter === "ASCIIHexDecode") return Buffer.from(data.toString("latin1").replace(/[^0-9a-fA-F]/g, ""), "hex");
	if (filter === "ASCII85Decode") return ascii85(data, cap);
	if (filter === "RunLengthDecode") return runLength(data, cap);
	throw new ExtractFailed("unsupported");
}

/** Throws ExtractFailed when the PDF's streams decode past the limits. Returns the decoded total. */
export function checkPdfBudget(buf, { perStream = LIMITS.pdfStreamBytes, total = LIMITS.pdfDecodedBytes } = {}) {
	const text = buf.toString("latin1");
	let used = 0;
	let last = 0;
	for (const match of text.matchAll(/(?<!end)stream\r?\n/g)) {
		const begin = match.index + match[0].length;
		if (begin < last) continue;
		const finish = text.indexOf("endstream", begin);
		if (finish === -1) break;
		// the stream's dictionary: from its object header ("N 0 obj") to the stream keyword
		const window = text.slice(Math.max(last, match.index - 4000), match.index);
		const header = window.search(/\d+\s+\d+\s+obj\b(?![\s\S]*\bobj\b)/);
		last = finish + 9;
		let data = buf.subarray(begin, finish);
		for (const filter of filtersOf(header === -1 ? window : window.slice(header))) {
			if (IMAGE.has(filter)) {
				data = data.subarray(0, 0); // image data is never decoded for text
				break;
			}
			data = decode(filter, data, Math.min(perStream, total - used));
			if (data.length > perStream || used + data.length > total) throw new ExtractFailed("too_large");
		}
		used += data.length;
		if (used > total) throw new ExtractFailed("too_large");
	}
	return used;
}
