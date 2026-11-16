import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { AssignmentError } from "../assignments.mjs";
import { LearnerAccountError } from "../learner-accounts.mjs";
import { managementAccess, roleLabels, validSubject } from "../platform.mjs";
import { STUDENT_ABSOLUTE_MS, STUDENT_SHARED_ABSOLUTE_MS } from "../store.mjs";
import { clear, cookie, label, readCookie, readForm } from "./http.mjs";
import { t } from "./messages.mjs";
import { posted, runStep } from "./public-missions.mjs";
import { esc, messagePage } from "./pages.mjs";
import { decodeAnswers, encodeAnswers } from "../preview.mjs";
import { ProgressError } from "../progress.mjs";
import { missionPages } from "../vendor/content-mission.mjs";
import {
	adultPage,
	assignmentPage,
	changedPage,
	codePage,
	dataPage,
	linkPage,
	maskEmail,
	minePage,
	pausedPage,
	saveFailedPage,
	signInPage,
	stalePage,
} from "./student-pages.mjs";

/**
 * Student sign-in on breinhap.com/p (breinhap#135).
 *
 *   GET/POST /p/aanmelden        the e-mail address; ASafariM e-mails a six-digit code
 *   GET/POST /p/aanmelden/code   that code; a student session starts
 *   GET/POST /p/koppelen         the link code, once (LearnerAccounts.redeem, breinhap#134)
 *   GET      /p/mijn             the assignments available to this learner (breinhap#136)
 *   GET/POST /p/mijn/{assignment}  one assignment, seen and played through the shared player
 *   GET      /p/mijn/gegevens    the student's own data: what is stored, how long, the controls (breinhap#36)
 *   GET      /p/mijn/gegevens/download   the same as JSON
 *   POST     /p/mijn/gegevens/wissen     clear the progress of one assignment, or all of it
 *   POST     /p/mijn/gegevens/ontkoppelen  end the link to the learner profile (progress is deleted)
 *   POST     /p/afmelden         sign out
 *
 * breinhap#36: progress on an assignment is stored on the server per learner, assignment and mission
 * (ProgressStore). A saved run posts `doe` = start | verder | stap | pauze with the row's version;
 * the answers never travel in the form. A version that moved on (another tab or device) writes
 * nothing and says so; a failed write says so and offers the same step again; progress made on
 * another publication is never continued. A POST without `doe` is #136's unsaved replay ("Nog eens").
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
const DATA = "/p/mijn/gegevens";
const GETS = new Set(["/p/aanmelden", "/p/aanmelden/code", "/p/koppelen", "/p/mijn", DATA, `${DATA}/download`]);
const POSTS = new Set(["/p/aanmelden", "/p/aanmelden/code", "/p/koppelen", "/p/afmelden", `${DATA}/wissen`, `${DATA}/ontkoppelen`]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
	// breinhap#36: the student's own saved progress; without it the player stays #136's unsaved run
	progress = null,
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

	/**
	 * Whether a saved row still fits the mission as it is published now: the same publication hash,
	 * a page inside the mission, answers that decode to exactly what is stored, and a finished state
	 * only past the last page. Anything else is shown as "changed", never continued or mixed in.
	 */
	const usable = (row, pages, hash) =>
		row.publicationHash === hash &&
		row.page <= pages.length &&
		(row.state === "finished") === (row.page === pages.length) &&
		encodeAnswers(decodeAnswers(row.answers, pages), pages) === row.answers;

	/** The saved state by mission id for the assignment page. */
	async function savedFor(learnerId, work) {
		if (!progress) return null;
		const rows = await progress.forAssignment(learnerId, work.assignmentId);
		const map = new Map();
		for (const mission of work.object.missions) {
			const row = rows.get(mission.id);
			if (!row) continue;
			const pages = missionPages(mission);
			map.set(mission.id, { row, pages: pages.length, usable: usable(row, pages, work.publicationHash) });
		}
		return map;
	}

	/** Nieuw / Bezig / Klaar per assignment on /p/mijn, from the student's own rows on the current publication. */
	async function statusFor(learnerId, list) {
		const status = new Map();
		if (!progress) return status;
		const rows = await progress.forLearner(learnerId);
		for (const entry of list) {
			const mine = rows.filter((r) => r.assignmentId === entry.assignmentId && r.publicationHash === entry.publicationHash);
			const finished = new Set(mine.filter((r) => r.state === "finished").map((r) => r.missionId)).size;
			status.set(entry.assignmentId, !mine.length ? "new" : entry.missions > 0 && finished >= entry.missions ? "done" : "busy");
		}
		return status;
	}

	/** Everything stored about this learner, grouped by assignment, with titles where still available. */
	async function storedData(learnerId) {
		const rows = progress ? await progress.forLearner(learnerId) : [];
		const available = new Map((await assignments.availableForLearner(learnerId)).map((a) => [a.assignmentId, a]));
		const groups = new Map();
		for (const row of rows) {
			if (!groups.has(row.assignmentId)) {
				let object = null;
				if (available.has(row.assignmentId)) {
					try {
						object = (await assignments.assignmentForLearner(learnerId, row.assignmentId)).object;
					} catch (error) {
						if (!(error instanceof AssignmentError)) throw error;
					}
				}
				groups.set(row.assignmentId, { assignmentId: row.assignmentId, title: object ? available.get(row.assignmentId).title : null, object, missions: [] });
			}
			const group = groups.get(row.assignmentId);
			const mission = group.object?.missions.find((m) => m.id === row.missionId);
			group.missions.push({
				...row,
				title: mission?.title ?? null,
				answerCount: row.answers ? row.answers.split(";").length : 0,
			});
		}
		return [...groups.values()].map(({ object, ...group }) => group);
	}

	/**
	 * One POST of a saved run (breinhap#36). `form.doe` is start, verder, stap or pauze; `form.versie`
	 * the row version the page was rendered from. Returns [status, html].
	 */
	async function savedRun({ lang, learnerId, work, form, voices, csrf }) {
		const object = work.object;
		const missionIndex = /^\d{1,2}$/.test(form.missie ?? "") ? Number(form.missie) : -1;
		const mission = object.missions[missionIndex];
		if (!mission) return [404, gonePage(lang)];
		const pages = missionPages(mission);
		const hash = work.publicationHash;
		const action = `/p/mijn/${work.assignmentId}`;
		const where = { csrf, assignmentId: work.assignmentId, missionIndex };
		const base = { action, extra: hidden("csrf", csrf), back: { href: "/p/mijn", label: "stBackToMine" } };
		/** The player at the stored page, its forms carrying the row version instead of the answers. */
		const show = (row, answerFields = {}) =>
			runStep(lang, object, { missie: String(missionIndex), stap: String(row.page), a: row.answers, ...answerFields }, voices, {
				...base,
				state: () => `${hidden("missie", missionIndex)}${hidden("doe", "stap")}${hidden("versie", row.version)}`,
				after: `<form method="post" action="${action}">${hidden("csrf", csrf)}${hidden("missie", missionIndex)}${hidden("doe", "pauze")}${hidden("versie", row.version)}<p><button type="submit" class="secondary">${esc(t(lang, "prPause"))}</button></p></form>`,
			});
		const failed = () => [503, saveFailedPage(lang, { action, form })];

		if (form.doe === "start") {
			let row;
			try {
				row = await progress.begin(learnerId, work.assignmentId, mission.id, hash);
			} catch {
				return failed();
			}
			// finished on this publication: "Nog eens" is the unsaved replay, the finished state stays
			if (!row) return [200, runStep(lang, object, { missie: String(missionIndex), stap: "0", a: "" }, voices, base)];
			return [200, show(row)];
		}
		if (!["verder", "stap", "pauze"].includes(form.doe)) return [400, gonePage(lang)];
		let row;
		try {
			row = (await progress.forAssignment(learnerId, work.assignmentId)).get(mission.id);
		} catch {
			return failed();
		}
		if (!row) return [409, changedPage(lang, where)];
		if (!usable(row, pages, hash)) return [409, changedPage(lang, where)];
		if (form.doe === "verder") return [200, show(row)];
		const expected = /^\d{1,9}$/.test(form.versie ?? "") ? Number(form.versie) : 0;
		if (row.version !== expected || row.state !== "started") return [409, stalePage(lang, where)];
		// the stored version is the one this page showed: everything on it is on the server
		if (form.doe === "pauze") return [200, pausedPage(lang, where)];

		const answers = decodeAnswers(row.answers, pages);
		const index = row.page;
		const page = pages[index];
		let next;
		if (page.kind === "question" && !answers[index]) {
			const sent = posted(lang, page, form);
			// no answer, or an incomplete one: the same question again, with the message; nothing to save
			if (!sent || sent.error) {
				const fields = Object.fromEntries(Object.entries(form).filter(([k]) => k === "kies" || /^plaats\d$/.test(k)));
				return [200, show(row, fields)];
			}
			answers[index] = sent;
			next = { page: index, answers: encodeAnswers(answers, pages) };
		} else {
			next = { page: index + 1, answers: row.answers, finished: index + 1 >= pages.length };
		}
		try {
			row = await progress.save(learnerId, work.assignmentId, mission.id, expected, { ...next, publicationHash: hash });
		} catch (error) {
			if (error instanceof ProgressError && error.code === "stale") return [409, stalePage(lang, where)];
			return failed();
		}
		return [200, show(row)];
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
				const list = await assignments.availableForLearner(session.learnerId);
				return html(200, minePage(lang, { csrf: session.saved.csrf, catalogue, assignments: list, status: await statusFor(session.learnerId, list) }));
			}

			// breinhap#36: the student's own data, and the controls over it
			if (path.startsWith(`${DATA}`)) {
				if (!session) return redirect("/p/aanmelden", stale);
				if (!session.learnerId) return redirect("/p/koppelen");
				const csrf = session.saved.csrf;
				if (!isGet && form.csrf !== csrf) return send(403, "Forbidden", TEXT);
				const page = async (status, error = "") =>
					html(status, dataPage(lang, { csrf, linkedAt: await learnerAccounts.linkedSince(session.saved.sub), groups: await storedData(session.learnerId), error }));
				if (path === DATA) return page(200);
				if (path === `${DATA}/download`) {
					const body = JSON.stringify(
						{
							linkedSince: await learnerAccounts.linkedSince(session.saved.sub),
							progress: (await storedData(session.learnerId)).flatMap((g) =>
								g.missions.map((m) => ({
									assignment: g.title,
									assignmentId: g.assignmentId,
									mission: m.title,
									missionId: m.missionId,
									state: m.state,
									page: m.page,
									answers: m.answers,
									startedAt: m.startedAt,
									finishedAt: m.finishedAt,
									updatedAt: m.updatedAt,
								})),
							),
						},
						null,
						2,
					);
					return send(200, body, "application/json; charset=utf-8", { "Content-Disposition": 'attachment; filename="breinhap-mijn-gegevens.json"' });
				}
				if (path === `${DATA}/wissen`) {
					if (!progress) return redirect(DATA);
					if (form.opdracht !== undefined) {
						if (!UUID.test(form.opdracht)) return page(400);
						await progress.clear(session.learnerId, form.opdracht);
					} else {
						if (form.zeker !== "1") return page(400, "gdSureError");
						await progress.clear(session.learnerId);
					}
					await audit("student.progress_clear", session.saved.sub);
					return redirect(DATA);
				}
				// /p/mijn/gegevens/ontkoppelen
				if (form.zeker !== "1") return page(400, "gdSureError");
				await learnerAccounts.unlinkSelf(session.saved.sub);
				return redirect("/p/koppelen");
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
				if (isGet) return html(200, assignmentPage(lang, { csrf: session.saved.csrf, assignment: work, progress: await savedFor(session.learnerId, work) }));
				if (progress && form.doe !== undefined) {
					const [status, body] = await savedRun({ lang, learnerId: session.learnerId, work, form, voices, csrf: session.saved.csrf });
					return html(status, body);
				}
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
