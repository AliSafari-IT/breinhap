/**
 * breinhap#29: reads one multipart/form-data upload form: a few short text fields and at most one file.
 * The whole body is bounded (`limit`); anything that is not exactly that shape is refused rather than
 * guessed at.
 */

export class FormRefused extends Error {
	constructor(code, status = 400) {
		super(code);
		this.code = code;
		this.status = status;
	}
}

const MAX_FIELDS = 10;
const MAX_FIELD = 2000;

export function boundaryOf(contentType) {
	const match = /^multipart\/form-data;\s*boundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))\s*$/i.exec(String(contentType ?? ""));
	return match ? match[1] ?? match[2] : null;
}

export async function readBody(req, limit) {
	const declared = Number(req.headers["content-length"]);
	if (Number.isFinite(declared) && declared > limit) throw new FormRefused("too_large", 413);
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) throw new FormRefused("too_large", 413);
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}

/** Parses the body into `{ fields: URLSearchParams, file: { name, type, bytes } | null }`. */
export function parseMultipart(body, boundary) {
	const delimiter = Buffer.from(`--${boundary}`);
	const fields = new URLSearchParams();
	let file = null;
	let at = body.indexOf(delimiter);
	if (at !== 0) throw new FormRefused("malformed");
	let count = 0;
	for (;;) {
		at += delimiter.length;
		if (body.subarray(at, at + 2).toString() === "--") return { fields, file };
		if (body.subarray(at, at + 2).toString() !== "\r\n") throw new FormRefused("malformed");
		at += 2;
		const headerEnd = body.indexOf("\r\n\r\n", at);
		if (headerEnd === -1 || headerEnd - at > 1024) throw new FormRefused("malformed");
		const headers = body.subarray(at, headerEnd).toString("utf8").split("\r\n");
		const next = body.indexOf(Buffer.concat([Buffer.from("\r\n"), delimiter]), headerEnd + 4);
		if (next === -1) throw new FormRefused("malformed");
		const content = body.subarray(headerEnd + 4, next);
		const disposition = headers.find((h) => /^content-disposition:/i.test(h)) ?? "";
		const name = /;\s*name="([^"]{1,40})"/i.exec(disposition)?.[1];
		const filename = /;\s*filename="([^"]{0,400})"/i.exec(disposition)?.[1];
		if (!name || ++count > MAX_FIELDS) throw new FormRefused("malformed");
		if (filename !== undefined) {
			if (file || name !== "bestand") throw new FormRefused("one_file");
			const type = headers.find((h) => /^content-type:/i.test(h))?.split(":")[1]?.trim() ?? "";
			file = { name: filename, type, bytes: Buffer.from(content) };
		} else {
			if (content.length > MAX_FIELD) throw new FormRefused("malformed");
			fields.append(name, content.toString("utf8"));
		}
		at = next + 2;
	}
}
