import { createHash } from "node:crypto";
import { Readable } from "node:stream";

/**
 * Small HTTP helpers shared by the learner handler (breinhap#82) and the student routes
 * (breinhap#135). Every cookie on the public Host is `__Secure-` prefixed, host-only, HttpOnly,
 * SameSite=Lax and scoped to /p.
 */
const MAX_BODY = 16_384;

/** Without `maxAge` the cookie ends with the browser (the shared-computer choice). */
export const cookie = (name, value, maxAge) =>
	`${name}=${value}; Path=/p; Secure; HttpOnly; SameSite=Lax${maxAge === undefined ? "" : `; Max-Age=${maxAge}`}`;
export const clear = (name) => cookie(name, "", 0);

export function readCookie(req, name) {
	const found = [];
	for (const part of String(req.headers.cookie ?? "").split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) found.push(rest.join("="));
	}
	// duplicates are refused, never guessed at
	return found.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(found[0]) ? found[0] : null;
}

/** A bounded, duplicate-free urlencoded form, or null. */
export async function readForm(req) {
	const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
	if (type !== "application/x-www-form-urlencoded") return null;
	const declared = Number(req.headers["content-length"] ?? 0);
	if (declared > MAX_BODY) return null;
	let size = 0;
	const chunks = [];
	for await (const chunk of Readable.from(req)) {
		size += chunk.length;
		if (size > MAX_BODY) return null;
		chunks.push(chunk);
	}
	const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
	const form = {};
	for (const key of new Set(params.keys())) {
		const all = params.getAll(key);
		if (all.length !== 1) return null; // duplicate scalar fields are refused
		form[key] = all[0];
	}
	return form;
}

/** A short, one-way label for a budget key: raw addresses, codes and cookies never reach Redis. */
export const label = (value) => createHash("sha256").update(String(value)).digest("base64url").slice(0, 22);
