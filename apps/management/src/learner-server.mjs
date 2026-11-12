import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { PracticeError } from "./practice/model.mjs";
import { languageOf } from "./learner/messages.mjs";
import { bootstrapPage, donePage, messagePage, resultPage, runPage, startPage } from "./learner/pages.mjs";
import { t } from "./learner/messages.mjs";

/**
 * The isolated public learner handler (breinhap#82). The edge sends breinhap.com/p/* here; nothing
 * else on that Host is served. It is dispatched before any identity or session code and shares no
 * cookie with the management site: its cookies are `__Secure-` prefixed, host-only for breinhap.com
 * and scoped to /p. It never reads the management cookie, renders no management navigation, and
 * puts no token, answer, score or pack content in a URL.
 *
 * Allowlist (exact Host, exact method, exact path, anything else fails closed with 404/405):
 *   GET/HEAD /p/  /p/start  /p/run  /p/done  /p/assets/{learner.css,theme.css,bootstrap.js}
 *   POST     /p/resolve  /p/start  /p/answer  /p/submit  /p/finish
 */
export const PUBLIC_HOST = "breinhap.com";
export const PUBLIC_ORIGIN = `https://${PUBLIC_HOST}`;
const FLOW = "__Secure-bh-flow";
const ATTEMPT = "__Secure-bh-attempt";
const MAX_BODY = 16_384;
const PAGE_KEY = /^(?:m:\d{1,2}:\d{1,3}|a:\d{1,2})$/;

const assetFiles = new Map(
	await Promise.all(
		[
			["/p/assets/learner.css", "./learner/learner.css", "text/css"],
			["/p/assets/theme.css", "../../site/src/theme.css", "text/css"],
			["/p/assets/bootstrap.js", "./learner/bootstrap.js", "text/javascript"],
		].map(async ([path, file, type]) => {
			const body = await readFile(new URL(file, import.meta.url));
			return [path, { body, type: `${type}; charset=utf-8`, etag: `"${createHash("sha256").update(body).digest("base64url")}"` }];
		}),
	),
);

const HEADERS = {
	"Cache-Control": "no-store",
	"Content-Security-Policy":
		"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	// not "no-referrer": a browser then sends `Origin: null` on same-origin form posts, which the Origin check must refuse.
	// same-origin sends nothing cross-site, and the only same-origin referrer is a /p path that never holds a secret.
	"Referrer-Policy": "same-origin",
	"X-Robots-Tag": "noindex, nofollow",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const cookie = (name, value, maxAge) =>
	`${name}=${value}; Path=/p; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
const clear = (name) => cookie(name, "", 0);
function readCookie(req, name) {
	const found = [];
	for (const part of String(req.headers.cookie ?? "").split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) found.push(rest.join("="));
	}
	// duplicates are refused, never guessed at
	return found.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(found[0]) ? found[0] : null;
}

async function readForm(req) {
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

/** Converts the service's typed failures into the generic learner answers (no title or count leaks). */
function failure(error) {
	if (error instanceof PracticeError) {
		if (["not_found"].includes(error.code)) return { status: 404, title: "notFoundTitle", text: "notFoundText" };
		if (["gone", "exhausted"].includes(error.code)) return { status: 410, title: "goneTitle", text: "goneText" };
		if (["stale", "conflict"].includes(error.code)) return { status: 409, title: "staleTitle", text: "staleText", link: true };
		if (["invalid", "unfinished"].includes(error.code)) return { status: 400, title: "staleTitle", text: "staleText", link: true };
		return { status: 503, title: "errorTitle", text: "errorText" };
	}
	return { status: 503, title: "errorTitle", text: "errorText" };
}

/** A short, one-way label for a budget key: raw addresses, codes and cookies never reach Redis. */
const label = (value) => createHash("sha256").update(String(value)).digest("base64url").slice(0, 22);

/**
 * `budget(kind, limit, seconds, who)` is the shared Redis counter (fixed window, self-expiring), so a
 * burst only waits for the window to pass: there is no permanent lockout, and a guessing flood against
 * one code cannot lock the real learner out of anything but that single code's resolve for a minute.
 * `requesterOf(req)` is the trusted-proxy client address. Without a budget the player does not run.
 */
export function createLearnerHandler({ learner, budget, requesterOf = (req) => req.socket?.remoteAddress ?? "direct" }) {
	return async function handleLearner(req, res) {
		let lang = languageOf(req.headers["accept-language"]);
		const send = (status, body, type = "text/html; charset=utf-8", extra = {}) => {
			res.writeHead(status, { "Content-Type": type, ...HEADERS, ...extra });
			res.end(req.method === "HEAD" ? undefined : body);
		};
		const redirect = (location, cookies = []) =>
			send(303, "", "text/plain; charset=utf-8", { Location: location, ...(cookies.length ? { "Set-Cookie": cookies } : {}) });
		const message = (error, cookies = []) => {
			const f = failure(error);
			return send(f.status, messagePage(lang, f.title, f.text, { link: f.link ? `<p><a href="/p/run">${t(lang, "continue")}</a></p>` : "" }), "text/html; charset=utf-8", cookies.length ? { "Set-Cookie": cookies } : {});
		};
		const tooMany = () => send(429, messagePage(lang, "tooManyTitle", "tooManyText"), "text/html; charset=utf-8", { "Retry-After": "60" });
		const method = req.method;
		let url;
		try {
			url = new URL(req.url, PUBLIC_ORIGIN);
		} catch {
			return send(404, "Not found", "text/plain; charset=utf-8");
		}
		const path = url.pathname;
		if (req.headers.host !== PUBLIC_HOST || url.origin !== PUBLIC_ORIGIN || !req.url.startsWith("/"))
			return send(421, "Misdirected request", "text/plain; charset=utf-8");

		const asset = assetFiles.get(path);
		if (asset) {
			if (method !== "GET" && method !== "HEAD") return send(405, "Method not allowed", "text/plain; charset=utf-8", { Allow: "GET, HEAD" });
			return send(200, asset.body, asset.type, { ETag: asset.etag, "Cache-Control": "public, max-age=300" });
		}
		const GETS = new Set(["/p", "/p/", "/p/start", "/p/run", "/p/done"]);
		const POSTS = new Set(["/p/resolve", "/p/start", "/p/answer", "/p/submit", "/p/finish"]);
		if (!GETS.has(path) && !POSTS.has(path)) return send(404, "Not found", "text/plain; charset=utf-8");
		const isGet = method === "GET" || method === "HEAD";
		if (isGet && !GETS.has(path)) return send(405, "Method not allowed", "text/plain; charset=utf-8", { Allow: "POST" });
		if (method === "POST" && !POSTS.has(path)) return send(405, "Method not allowed", "text/plain; charset=utf-8", { Allow: "GET, HEAD" });
		if (!isGet && method !== "POST") return send(405, "Method not allowed", "text/plain; charset=utf-8", { Allow: "GET, HEAD, POST" });

		// fixed windows, per client / per code / per attempt / global; a refusal is a plain 429
		const limited = async (rules) => {
			for (const [kind, limit, seconds, who] of rules) if (!(await budget(`learner-${kind}`, limit, seconds, who))) return true;
			return false;
		};
		const who = label(requesterOf(req));
		try {
			if (!budget) return send(503, messagePage(lang, "errorTitle", "errorText"));
			if (isGet) {
				if (url.search && path !== "/p/run") return redirect(path);
				if (path === "/p" || path === "/p/") {
					if (await limited([["boot", 30, 60, who], ["boot-all", 600, 60, "all"]])) return tooMany();
					const boot = await learner.bootstrap();
					return send(200, bootstrapPage(lang, boot.csrf), "text/html; charset=utf-8", { "Set-Cookie": cookie(FLOW, boot.seed, 300) });
				}
				if (path === "/p/start") {
					const seed = readCookie(req, FLOW);
					if (!seed) return redirect("/p/");
					const info = await learner.flowInfo(seed);
					lang = info.language;
					if (info.state === "consumed") return redirect("/p/run");
					return send(200, startPage(info));
				}
				const credential = readCookie(req, ATTEMPT);
				if (!credential) return redirect("/p/");
				if (await limited([["read", 240, 60, label(credential)], ["read-ip", 600, 60, who]])) return tooMany();
				if (path === "/p/run") {
					const page = url.searchParams.get("pagina") ?? undefined;
					if (page !== undefined && !PAGE_KEY.test(page)) return redirect("/p/run");
					const run = await learner.read(credential, page);
					lang = run.language;
					if (run.state !== "active") return redirect("/p/done");
					return send(200, runPage(run, randomBytes(32).toString("base64url"), { error: url.searchParams.get("fout") ? t(lang, "unfinished") : "" }));
				}
				// /p/done
				const run = await learner.read(credential);
				lang = run.language;
				if (run.state === "active") return redirect("/p/run");
				const review = await learner.review(credential);
				return send(200, resultPage(review, run.csrf, randomBytes(32).toString("base64url")));
			}

			// every POST: the exact public Origin and a bounded, duplicate-free form
			if (req.headers.origin !== PUBLIC_ORIGIN) return send(403, "Forbidden", "text/plain; charset=utf-8");
			const form = await readForm(req);
			if (!form) return send(400, "Bad request", "text/plain; charset=utf-8");
			if (path === "/p/resolve") {
				const seed = readCookie(req, FLOW);
				if (!seed) return redirect("/p/");
				if (await limited([["resolve", 20, 60, who], ["resolve-code", 30, 60, label(form.token ?? "")], ["resolve-all", 1200, 60, "all"]])) return tooMany();
				try {
					await learner.resolve(seed, { token: form.token ?? "", csrf: form.csrf ?? "" });
				} catch (error) {
					// a malformed code is exactly as unknown as a wrong one
					if (error instanceof PracticeError && error.code === "invalid") throw new PracticeError("not_found");
					throw error;
				}
				return redirect("/p/start");
			}
			if (path === "/p/start") {
				const seed = readCookie(req, FLOW);
				if (!seed) return redirect("/p/");
				if (await limited([["start", 20, 60, who], ["start-all", 600, 60, "all"]])) return tooMany();
				const started = await learner.start(seed, { csrf: form.csrf ?? "", startNonce: form.startNonce ?? "" });
				return redirect("/p/run", [cookie(ATTEMPT, started.credential, 86400)]);
			}
			const credential = readCookie(req, ATTEMPT);
			if (!credential) return redirect("/p/");
			if (await limited([["write", 120, 60, label(credential)], ["write-ip", 240, 60, who], ["write-all", 3000, 60, "all"]])) return tooMany();
			if (path === "/p/finish") {
				await learner.finish(credential, { csrf: form.csrf ?? "", nonce: form.nonce ?? "" });
				return send(200, donePage(lang), "text/html; charset=utf-8", { "Set-Cookie": [clear(ATTEMPT), clear(FLOW)] });
			}
			const expectedVersion = Number(form.expectedVersion);
			if (path === "/p/submit") {
				await learner.submit(credential, { csrf: form.csrf ?? "", expectedVersion, nonce: form.nonce ?? "" });
				return redirect("/p/done");
			}
			// /p/answer: an answer or a plain "continue"
			if (!PAGE_KEY.test(form.pageKey ?? "")) return message(new PracticeError("invalid"));
			const input = { csrf: form.csrf ?? "", expectedVersion, nonce: form.nonce ?? "", pageKey: form.pageKey, kind: form.kind };
			if (form.kind === "answer") {
				if (form.chosen !== undefined) {
					if (!/^[0-3]$/.test(form.chosen)) return redirect("/p/run?fout=1");
					input.answer = { kind: "choice", chosen: Number(form.chosen) };
				} else {
					const placed = [];
					for (let i = 0; i < 6 && form[`plaats${i}`] !== undefined; i++) placed.push(form[`plaats${i}`]);
					if (!placed.length || placed.some((p) => p === "")) return redirect("/p/run?fout=1");
					input.answer = { kind: "order", placed, checked: form.checked === "1" };
				}
			}
			try {
				await learner.save(credential, input);
			} catch (error) {
				if (error instanceof PracticeError && ["invalid", "unfinished"].includes(error.code)) return redirect("/p/run?fout=1");
				throw error;
			}
			return redirect("/p/run");
		} catch (error) {
			return message(error);
		}
	};
}
