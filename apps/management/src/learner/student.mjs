import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { AssignmentError } from "../assignments.mjs";
import { LearnerAccountError } from "../learner-accounts.mjs";
import { managementAccess, roleLabels, validSubject } from "../platform.mjs";
import { STUDENT_ABSOLUTE_MS, STUDENT_SHARED_ABSOLUTE_MS } from "../store.mjs";
import { clear, cookie, label, readCookie, readForm } from "./http.mjs";
import { t } from "./messages.mjs";
import { runStep } from "./public-missions.mjs";
import { esc, messagePage } from "./pages.mjs";
import { adultPage, assignmentPage, codePage, linkPage, maskEmail, minePage, signInPage } from "./student-pages.mjs";

/**
 * Student sign-in on breinhap.com/p (breinhap#135).
 *
 *   GET/POST /p/aanmelden        the e-mail address; ASafariM e-mails a six-digit code
 *   GET/POST /p/aanmelden/code   that code; a student session starts
 *   GET/POST /p/koppelen         the link code, once (LearnerAccounts.redeem, breinhap#134)
 *   GET      /p/mijn             the assignments available to this learner (breinhap#136)
 *   GET/POST /p/mijn/{assignment}  one assignment, seen and played through the shared player
 *   POST     /p/afmelden         sign out
 *
 * The sign-in is the same headless e-mail code the adults use: the same client, the same budgets,
 * the same single-use flow entries. What differs is the session: its own cookie
 * (`__Secure-bh-student`, Path=/p, HttpOnly, SameSite=Lax) and its own store entries, which the
 * management site cannot read; no management cookie is read or set here. An adult account gets no
 * student session and is pointed to management. The e-mail address lives only in the ten-minute
 * sign-in flow entry: the session and the database hold the ASafariM subject, never the address.
 * Every POST needs the exact Origin and a CSRF token; nothing secret is put in a URL or a log.
 */
export const STUDENT_COOKIE = "__Secure-bh-student";
const LOGIN = "__Secure-bh-login";
const FORM = "__Secure-bh-form";
const GETS = new Set(["/p/aanmelden", "/p/aanmelden/code", "/p/koppelen", "/p/mijn"]);
const POSTS = new Set(["/p/aanmelden", "/p/aanmelden/code", "/p/koppelen", "/p/afmelden"]);
// breinhap#136: one assignment by its opaque id. Only GET and POST of exactly this shape.
const ASSIGNMENT = /^\/p\/mijn\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
export const isStudentPath = (path) => GETS.has(path) || POSTS.has(path) || ASSIGNMENT.test(path);

const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[^\s@<>"]{2,}$/;
const TEXT = "text/plain; charset=utf-8";
const random = () => randomBytes(32).toString("base64url");
const hidden = (name, value) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
/** The calm answer for an assignment the learner cannot see (breinhap#136): never an error page. */
const gonePage = (lang) =>
	messagePage(lang, "stGoneTitle", "stGoneText", { link: `<p><a href="/p/mijn">${t(lang, "stBackToMine")}</a></p>` });

export function createStudentRoutes({
	origin,
	// the identity store: flows, budgets, student sessions, adult memberships
	store,
	// ASafariM's headless client and the cached "is this account still allowed" check, as management uses them
	headless,
	stillActive,
	grants,
	// breinhap#134: redeeming a code and reading the current link
	learnerAccounts,
	// breinhap#136: the learner read boundary for assignments, and the recorded voices for read-aloud
	assignments,
	narration = null,
	audit = async () => {},
	requesterOf = (req) => req.socket?.remoteAddress ?? "direct",
	now = Date.now,
	// whether /p/missies exists, for the "practise more" link
	catalogue = false,
}) {
	/** An active adult member of the workspace: never a student here, whatever cookie arrives. */
	const adultMember = async (sub) => {
		const member = await store.membership(sub);
		return member?.active === true && Object.hasOwn(roleLabels, member.role) && member.role !== "breinhap.student";
	};
	/** At sign-in: a member, someone who asked for an adult role, or an account ASafariM knows as an adult. */
	const adultAccount = async (sub) =>
		(await adultMember(sub)) || Boolean(await store.roleRequest(sub)) || managementAccess(await grants(sub), sub).adult;

	/** The student session of this request, checked again on every request, with the current link. */
	async function current(req) {
		const id = readCookie(req, STUDENT_COOKIE);
		const saved = id ? await store.getStudentSession(id) : null;
		if (!saved) return null;
		if (!(await stillActive(saved.sub)).active || (await adultMember(saved.sub))) {
			await store.destroyStudentSession(id);
			return null;
		}
		// read every time: an ended link ends the student's access on the next request
		return { id, saved, learnerId: await learnerAccounts.linkedLearner(saved.sub) };
	}
	const home = (session) => (session.learnerId ? "/p/mijn" : "/p/koppelen");
	async function emailFlow(req) {
		const token = readCookie(req, LOGIN);
		const flow = token ? await store.readFlow(token) : null;
		return flow?.kind === "student-email" && flow.expires > now() ? { token, flow } : null;
	}

	return async function handleStudent({ req, url, path, lang, send, redirect, narration: voices = narration }) {
		const method = req.method;
		const isGet = method === "GET" || method === "HEAD";
		const assignment = ASSIGNMENT.exec(path)?.[1];
		if (assignment) {
			if (!isGet && method !== "POST") return send(405, "Method not allowed", TEXT, { Allow: "GET, HEAD, POST" });
		} else {
			if (isGet && !GETS.has(path)) return send(405, "Method not allowed", TEXT, { Allow: "POST" });
			if (method === "POST" && !POSTS.has(path)) return send(405, "Method not allowed", TEXT, { Allow: "GET, HEAD" });
			if (!isGet && method !== "POST")
				return send(405, "Method not allowed", TEXT, { Allow: [GETS.has(path) ? "GET, HEAD" : "", POSTS.has(path) ? "POST" : ""].filter(Boolean).join(", ") });
		}
		const html = (status, body, cookies = [], extra = {}) =>
			send(status, body, "text/html; charset=utf-8", { ...(cookies.length ? { "Set-Cookie": cookies } : {}), ...extra });
		const wait = { "Retry-After": "60" };
		try {
			const requester = requesterOf(req);
			if (!(await store.budget("student-requests", 240, 60, label(requester))))
				return html(429, messagePage(lang, "tooManyTitle", "tooManyText"), [], wait);
			if (isGet && url.search) return redirect(path);
			let form;
			if (!isGet) {
				// every POST: the exact public Origin and a bounded, duplicate-free form
				if (req.headers.origin !== origin) return send(403, "Forbidden", TEXT);
				form = await readForm(req);
				if (!form) return send(400, "Bad request", TEXT);
			}
			const session = await current(req);
			// a cookie whose session ended is removed with the next answer
			const stale = !session && readCookie(req, STUDENT_COOKIE) ? [clear(STUDENT_COOKIE)] : [];

			if (path === "/p/afmelden") {
				const signedOut = [clear(STUDENT_COOKIE), clear(LOGIN)];
				if (!session) return redirect("/p/aanmelden", signedOut);
				if (form.csrf !== session.saved.csrf) return send(403, "Forbidden", TEXT);
				await store.destroyStudentSession(session.id);
				await audit("student.logout", session.saved.sub);
				return redirect("/p/aanmelden", signedOut);
			}

			if (path === "/p/mijn") {
				if (!session) return redirect("/p/aanmelden", stale);
				if (!session.learnerId) return redirect("/p/koppelen");
				return html(200, minePage(lang, { csrf: session.saved.csrf, catalogue, assignments: await assignments.availableForLearner(session.learnerId) }));
			}

			// breinhap#136: one assigned homework, seen and played through the shared stateless player.
			// An id this learner cannot see — unknown, another student's, closed, withdrawn — is one
			// calm "not available" page, exactly like the catalogue's missing missions.
			if (assignment) {
				if (!session) return redirect("/p/aanmelden", stale);
				if (!session.learnerId) return redirect("/p/koppelen");
				if (!isGet && form.csrf !== session.saved.csrf) return send(403, "Forbidden", TEXT);
				let work;
				try {
					work = await assignments.assignmentForLearner(session.learnerId, assignment);
				} catch (error) {
					if (error instanceof AssignmentError && error.code === "not_found") return html(404, gonePage(lang));
					throw error;
				}
				if (isGet) return html(200, assignmentPage(lang, { csrf: session.saved.csrf, assignment: work }));
				const page = runStep(lang, work.object, form, voices, {
					action: `/p/mijn/${assignment}`,
					extra: hidden("csrf", session.saved.csrf),
					back: { href: "/p/mijn", label: "stBackToMine" },
				});
				return page ? html(200, page) : html(404, gonePage(lang));
			}

			if (path === "/p/koppelen") {
				if (!session) return redirect("/p/aanmelden", stale);
				if (isGet) return session.learnerId ? redirect("/p/mijn") : html(200, linkPage(lang, { csrf: session.saved.csrf }));
				if (form.csrf !== session.saved.csrf) return send(403, "Forbidden", TEXT);
				if (session.learnerId) return redirect("/p/mijn");
				try {
					await learnerAccounts.redeem(session.saved.sub, form.code ?? "", { requester: label(requester) });
				} catch (error) {
					if (!(error instanceof LearnerAccountError)) throw error;
					if (error.code === "adult") {
						await store.destroyStudentSession(session.id);
						return html(403, adultPage(lang), [clear(STUDENT_COOKIE)]);
					}
					if (error.code === "rate") return html(429, linkPage(lang, { csrf: session.saved.csrf, error: "stErrBusy" }), [], wait);
					// wrong, used, expired and revoked codes: one answer
					if (error.code === "code") return html(400, linkPage(lang, { csrf: session.saved.csrf, error: "stErrLink" }));
					throw error;
				}
				return redirect("/p/mijn");
			}

			// the two sign-in steps: someone already signed in goes on to their page
			if (session) return redirect(home(session));

			if (path === "/p/aanmelden") {
				// before a session exists, the form's CSRF token is the keyed tag of this browser's form cookie
				const known = readCookie(req, FORM);
				const seed = known ?? random();
				const formCookies = [...stale, cookie(FORM, seed, 86400)];
				const page = (status, error = "", email = "", extra = {}) =>
					html(status, signInPage(lang, { csrf: store.tag("student-form", seed), email, error }), formCookies, extra);
				if (isGet) return page(200);
				const email = String(form.email ?? "").trim().toLowerCase().slice(0, 254);
				if (!known || form.csrf !== store.tag("student-form", known)) return page(403, "stErrForm", EMAIL.test(email) ? email : "");
				if (!EMAIL.test(email)) return page(400, "stErrEmail", email);
				// the adults' limits, on the same counters: per address, overall and per mailbox
				if (
					!(await store.budget("start", 30, 60, requester)) ||
					!(await store.budget("start-global", 3000)) ||
					!(await store.budget("start-email", 5, 900, email))
				)
					return page(429, "stErrBusy", email, wait);
				const sent = await headless.startEmail({ email, locale: lang, intent: "signin", ...(isIP(requester) ? { clientIp: requester } : {}) });
				if (!sent.ok) {
					if (sent.error === "invalid_email") return page(400, "stErrEmail", email);
					if (sent.error === "send_failed" || sent.error === "unavailable") return page(503, "stErrDown", email);
					return page(429, "stErrBusy", email, wait);
				}
				const token = random();
				const flow = { kind: "student-email", email, challenge: sent.challenge, shared: form.gedeeld === "1", csrf: random(), expires: now() + 600_000 };
				if (!(await store.putFlow(token, flow))) return page(503, "stErrDown", email);
				await audit("student.code_sent", "anonymous");
				return redirect("/p/aanmelden/code", [cookie(LOGIN, token, 600)]);
			}

			// /p/aanmelden/code
			const pending = await emailFlow(req);
			if (!pending) return redirect("/p/aanmelden", [clear(LOGIN)]);
			const { token, flow } = pending;
			const page = (status, error = "", extra = {}) =>
				html(status, codePage(lang, { csrf: flow.csrf, masked: maskEmail(flow.email), error }), [], extra);
			/** Back to the first step, with a fresh form: this sign-in attempt is over. */
			const restart = (status, error, extra = {}) => {
				const seed = random();
				return html(status, signInPage(lang, { csrf: store.tag("student-form", seed), error }), [clear(LOGIN), cookie(FORM, seed, 86400)], extra);
			};
			if (isGet) return page(200);
			if (form.csrf !== flow.csrf) return send(403, "Forbidden", TEXT);
			if (!(await store.budget("verify", 5, 600, token))) {
				await store.takeFlow(token);
				return restart(429, "stErrBusy", wait);
			}
			if (!(await store.budget("verify-ip", 30, 600, requester))) return page(429, "stErrBusy", wait);
			const code = String(form.code ?? "").replace(/\s/g, "");
			if (!/^\d{6}$/.test(code)) return page(400, "stErrCode");
			const result = await headless.verifyEmail({ challenge: flow.challenge, email: flow.email, code, ...(isIP(requester) ? { clientIp: requester } : {}) });
			if (!result.ok) {
				if (result.error === "not_connected" || result.error === "revoked") {
					await store.takeFlow(token);
					return restart(403, "stErrRefused");
				}
				if (result.error === "rate_limited") return page(429, "stErrBusy", wait);
				if (result.error === "unavailable") return page(503, "stErrDown");
				return page(400, result.error === "expired" ? "stErrExpired" : "stErrCode");
			}
			// only the request that consumes the single-use flow may start a session
			if (!(await store.takeFlow(token))) return restart(400, "stErrExpired");
			if (!validSubject(result.sub) || typeof result.email !== "string" || !EMAIL.test(result.email)) return restart(400, "stErrExpired");
			if (await adultAccount(result.sub)) {
				await audit("student.adult", result.sub);
				return html(403, adultPage(lang), [clear(LOGIN), clear(STUDENT_COOKIE)]);
			}
			const previous = readCookie(req, STUDENT_COOKIE);
			if (previous) await store.destroyStudentSession(previous);
			const time = now();
			const shared = flow.shared === true;
			const lifetime = shared ? STUDENT_SHARED_ABSOLUTE_MS : STUDENT_ABSOLUTE_MS;
			const id = random();
			// the subject only: the e-mail address is not kept past the sign-in flow
			const saved = {
				kind: "student",
				sub: result.sub,
				sid: random(),
				authTime: Math.floor(time / 1000),
				issuedAt: Math.floor(time / 1000),
				csrf: random(),
				shared,
				expires: time + lifetime,
			};
			if (!(await store.saveStudentSession(id, saved))) return restart(400, "stErrExpired");
			await audit("student.login", result.sub);
			const learnerId = await learnerAccounts.linkedLearner(result.sub);
			return redirect(home({ learnerId }), [
				// on a shared computer the cookie has no Max-Age: it ends with the browser
				cookie(STUDENT_COOKIE, id, shared ? undefined : Math.floor(lifetime / 1000)),
				clear(LOGIN),
				clear(FORM),
			]);
		} catch {
			return html(503, messagePage(lang, "errorTitle", "errorText"));
		}
	};
}
