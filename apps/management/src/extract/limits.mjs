/**
 * breinhap#31: the bounds of one extraction. A document that needs more is cut off (with a warning) or
 * refused; it never gets more time or memory. The heap cap covers the parser's JavaScript objects; the
 * decoded-size budget and the process watchdog cover the buffers outside it.
 */
export const LIMITS = Object.freeze({
	/** Wall-clock time for one parse, start to finish; the parser thread is terminated after it. */
	timeoutMs: 45_000,
	/** The parser thread's V8 heap (old + young generation) and stack. */
	heapMb: 64,
	youngMb: 8,
	stackMb: 4,
	/** Pages of a PDF that are read; later pages are left out with a warning. */
	pages: 200,
	/** Extracted text kept per document. */
	chars: 400_000,
	blocks: 2_000,
	/** A block longer than this is split. */
	blockChars: 2_000,
	/** word/document.xml once inflated. */
	docxXmlBytes: 16 * 1024 * 1024,
	/**
	 * What a PDF's streams may decode to, each and together (pdf-budget.mjs). Decoded data lives
	 * outside the thread's heap cap, so it is measured (and refused) before pdf.js reads the file.
	 */
	pdfStreamBytes: 16 * 1024 * 1024,
	pdfDecodedBytes: 48 * 1024 * 1024,
	/** A last guard: the process may grow this much during one parse before the thread is stopped. */
	rssGrowthMb: 160,
});

/** A document that cannot be extracted, with a short code the pages explain. */
export class ExtractFailed extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}

/** Failure codes. `retryable` ones may succeed on another attempt (the file did not change). */
export const FAILURES = {
	corrupt: { retryable: false },
	encrypted: { retryable: false },
	too_large: { retryable: false },
	too_complex: { retryable: false },
	unsupported: { retryable: false },
	timeout: { retryable: true },
	interrupted: { retryable: true },
	storage_unavailable: { retryable: true },
	file_unavailable: { retryable: false },
	internal: { retryable: true },
};
