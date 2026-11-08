import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
	isFinished,
	validAnswer,
	isCorrect,
	scoreAnswers,
} from "../vendor/content-mission.mjs";
import { shuffleForDisplay } from "../vendor/content-pick.mjs";
import {
	DAY,
	fail,
	token,
	tokenHash,
	derived,
	equal,
	pages,
	contentHash,
} from "./model.mjs";
import { parse } from "./store.mjs";

const integer = z.number().int().positive();
const answer = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("choice"),
			chosen: z.number().int().min(0).max(3),
		})
		.strict(),
	z
		.object({
			kind: z.literal("order"),
			placed: z.array(z.string().max(8192)).max(6),
			checked: z.boolean(),
		})
		.strict(),
]);
const request = z
	.object({
		csrf: z.string().max(43),
		expectedVersion: integer,
		nonce: z.string().max(43),
		pageKey: z.string().max(40),
		kind: z.enum(["answer", "advance"]),
		answer: answer.optional(),
	})
	.strict();
const submitRequest = z
	.object({
		csrf: z.string().max(43),
		expectedVersion: integer,
		nonce: z.string().max(43),
	})
	.strict();
const metadata = (e) => ({
	title: e.title,
	description: e.description,
	instructions: e.instructions,
	subject: e.subject,
	grade: e.grade,
	language: e.language,
	mode: e.mode,
	missionCount: e.missions.length,
	questionCount: pages(e).filter((p) => p.kind === "question").length,
});

/** Capability-only services. Transport must enforce exact public Origin, bounded body, duplicate
 * scalar refusal, cookies, budgets and safe errors before wiring these methods in #82/#84. */
export class PracticeLearner {
	constructor(store) {
		this.store = store;
		this.pool = store.pool;
		this.workspace = store.workspace;
	}
	async flow(db, seed, csrf, lock = true) {
		const f =
			(
				await db.query(
					`SELECT * FROM practice_link_sessions WHERE workspace_id=$1 AND session_hash=$2 ${lock ? "FOR UPDATE" : ""}`,
					[this.workspace, tokenHash(seed)],
				)
			).rows[0] ?? fail("not_found");
		const now = await this.store.time(db);
		if (!equal(f.csrf_hash, tokenHash(csrf)) || f.expires_at <= now)
			fail("not_found");
		return f;
	}
	async bootstrap() {
		return this.store.tx(async (db) => {
			await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
				`${this.workspace}:practice-flow`,
			]);
			const now = await this.store.time(db);
			const count = (
				await db.query(
					"SELECT count(*)::int AS n FROM practice_link_sessions WHERE workspace_id=$1 AND expires_at>$2",
					[this.workspace, now],
				)
			).rows[0].n;
			if (count >= 500) fail("limit");
			const seed = token(),
				csrf = derived(seed, "csrf"),
				startNonce = derived(seed, "start", 16);
			await db.query(
				"INSERT INTO practice_link_sessions(session_hash,workspace_id,csrf_hash,state,created_at,expires_at) VALUES($1,$2,$3,'unresolved',$4,$5)",
				[
					tokenHash(seed),
					this.workspace,
					tokenHash(csrf),
					now,
					new Date(+now + 300_000),
				],
			);
			return { seed, csrf, startNonce };
		});
	}
	async resolve(seed, input) {
		const o = parse(
			z
				.object({ token: z.string().max(43), csrf: z.string().max(43) })
				.strict(),
			input,
		);
		return this.store.tx(async (db) => {
			// Check flow/CSRF before external authority calls, then recheck under its lock.
			await this.flow(db, seed, o.csrf, false);
			const link =
				(
					await db.query(
						"SELECT id FROM practice_share_links WHERE workspace_id=$1 AND token_hash=$2",
						[this.workspace, tokenHash(o.token)],
					)
				).rows[0] ?? fail("not_found");
			const ctx = await this.store.context(db, link.id),
				f = await this.flow(db, seed, o.csrf);
			if (f.state === "consumed" || (f.link_id && f.link_id !== link.id))
				fail("not_found");
			await db.query(
				"UPDATE practice_link_sessions SET state='resolved',link_id=$3 WHERE workspace_id=$1 AND session_hash=$2",
				[this.workspace, f.session_hash, link.id],
			);
			return metadata(ctx.envelope);
		});
	}
	async start(seed, input) {
		const o = parse(
			z
				.object({ csrf: z.string().max(43), startNonce: z.string().max(22) })
				.strict(),
			input,
		);
		const nonceHash = tokenHash(o.startNonce, 16),
			credential = derived(seed, "attempt");
		if (!equal(nonceHash, tokenHash(derived(seed, "start", 16), 16)))
			fail("not_found");
		return this.store.tx(async (db) => {
			const first = await this.flow(db, seed, o.csrf, false);
			if (!first.link_id) fail("not_found");
			const { link, envelope } = await this.store.context(db, first.link_id);
			const f = await this.flow(db, seed, o.csrf);
			const now = await this.store.time(db);
			this.store.validLink(link, now);
			if (f.link_id !== link.id || f.state === "unresolved") fail("not_found");
			if (f.state === "consumed") {
				const a = (
					await db.query(
						"SELECT * FROM practice_attempts WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
						[this.workspace, f.consumed_attempt_id],
					)
				).rows[0];
				if (
					!a ||
					!equal(f.start_nonce_hash, nonceHash) ||
					!equal(a.resume_hash, tokenHash(credential)) ||
					a.state === "closed" ||
					+a.last_active_at + DAY <= +now ||
					a.delete_after <= now
				)
					fail("gone");
				return { id: a.id, credential, version: a.version };
			}
			if (link.attempts_started >= link.max_attempts) fail("exhausted");
			const id = randomUUID(),
				pp = pages(envelope),
				questionCount = pp.filter((p) => p.kind === "question").length;
			await db.query(
				"INSERT INTO practice_attempts(workspace_id,id,link_id,pack_id,pack_version,resume_hash,state,current_page_key,started_at,last_active_at,delete_after,question_count) VALUES($1,$2,$3,$4,$5,$6,'active',$7,$8,$8,$9,$10)",
				[
					this.workspace,
					id,
					link.id,
					link.pack_id,
					link.pack_version,
					tokenHash(credential),
					pp[0].key,
					now,
					new Date(+now + 30 * DAY),
					questionCount,
				],
			);
			await db.query(
				"UPDATE practice_share_links SET attempts_started=attempts_started+1,last_used_at=$3 WHERE workspace_id=$1 AND id=$2",
				[this.workspace, link.id, now],
			);
			await db.query(
				"UPDATE practice_link_sessions SET state='consumed',consumed_attempt_id=$3,start_nonce_hash=$4 WHERE workspace_id=$1 AND session_hash=$2",
				[this.workspace, f.session_hash, id, nonceHash],
			);
			await this.store.audit(db, "anonymous", "start", id);
			return { id, credential, version: 1 };
		});
	}
	async attempt(db, credential) {
		const hash = tokenHash(credential);
		const first =
			(
				await db.query(
					"SELECT link_id FROM practice_attempts WHERE workspace_id=$1 AND resume_hash=$2",
					[this.workspace, hash],
				)
			).rows[0] ?? fail("not_found");
		const ctx = await this.store.context(db, first.link_id);
		const a =
			(
				await db.query(
					"SELECT * FROM practice_attempts WHERE workspace_id=$1 AND resume_hash=$2 FOR UPDATE",
					[this.workspace, hash],
				)
			).rows[0] ?? fail("not_found");
		const now = await this.store.time(db);
		if (
			!equal(a.resume_hash, hash) ||
			a.state === "closed" ||
			a.delete_after <= now ||
			+a.last_active_at + DAY <= +now
		)
			fail("gone");
		const answers = (
			await db.query(
				"SELECT * FROM practice_answers WHERE workspace_id=$1 AND attempt_id=$2 ORDER BY page_key FOR UPDATE",
				[this.workspace, a.id],
			)
		).rows;
		const fresh = await this.store.time(db);
		this.store.validLink(ctx.link, fresh);
		if (a.delete_after <= fresh || +a.last_active_at + DAY <= +fresh)
			fail("gone");
		return { ...ctx, a, answers, pp: pages(ctx.envelope), now: fresh };
	}
	csrf(credential, value) {
		if (!equal(tokenHash(derived(credential, "answer-csrf")), tokenHash(value)))
			fail("not_found");
	}
	async read(credential, pageKey) {
		if (pageKey !== undefined) parse(z.string().max(40), pageKey);
		return this.store.tx(async (db) => {
			const { a, pp, answers, envelope } = await this.attempt(db, credential);
			const current =
				a.current_page_key === "end"
					? pp.length
					: pp.findIndex((p) => p.key === a.current_page_key);
			const index =
				pageKey === undefined
					? current
					: pp.findIndex((p) => p.key === pageKey);
			if (
				index < 0 ||
				index > current ||
				(pageKey !== undefined && index === pp.length)
			)
				fail("invalid");
			const result = {
				...metadata(envelope),
				id: a.id,
				version: a.version,
				state: a.state,
				currentPageKey: a.current_page_key,
				csrf: derived(credential, "answer-csrf"),
			};
			if (a.completed_at) result.score = a.server_score;
			if (index === pp.length) return result;
			const page = pp[index],
				saved = answers.find((r) => r.page_key === page.key);
			const feedback =
				!!a.completed_at || (envelope.mode === "practice" && saved?.finalized);
			if (page.kind === "card")
				result.page = {
					key: page.key,
					kind: page.kind,
					step: page.step,
					card: page.card,
				};
			else {
				const q = page.question;
				result.page = {
					key: page.key,
					kind: page.kind,
					step: page.step,
					question:
						q.kind === "choice"
							? { kind: q.kind, prompt: q.prompt, options: q.options }
							: {
									kind: q.kind,
									prompt: q.prompt,
									items: shuffleForDisplay(q.items, index + 1),
								},
				};
				if (saved) result.page.answer = saved.answer;
				if (feedback)
					result.page.feedback = {
						correct: saved?.server_correct ?? false,
						explanation: q.explanation,
						...(q.kind === "choice"
							? { answerIndex: q.answerIndex }
							: { items: q.items }),
					};
			}
			return result;
		});
	}
	/** Current-last nonce only: replaying an older mutation cannot repeat a transition. */
	retry(a, input, action) {
		const nonce = tokenHash(input.nonce),
			payload = Buffer.from(contentHash({ action, ...input }), "base64url");
		if (equal(a.last_nonce_hash, nonce)) {
			if (!equal(a.last_payload_hash, payload) || a.last_action !== action)
				fail("conflict");
			return { nonce, payload, replay: true };
		}
		if (a.version !== input.expectedVersion) fail("stale");
		return { nonce, payload, replay: false };
	}
	async mutation(db, a, now, action, r, pageKey = a.current_page_key) {
		await db.query(
			"UPDATE practice_attempts SET version=version+1,current_page_key=$3,last_active_at=$4,last_nonce_hash=$5,last_payload_hash=$6,last_action=$7,last_outcome_version=version+1 WHERE workspace_id=$1 AND id=$2",
			[this.workspace, a.id, pageKey, now, r.nonce, r.payload, action],
		);
		return { version: a.version + 1 };
	}
	async save(credential, input) {
		const o = parse(request, input);
		this.csrf(credential, o.csrf);
		if (
			(o.kind === "answer") !== !!o.answer ||
			Buffer.byteLength(JSON.stringify(o)) > 8192
		)
			fail("invalid");
		return this.store.tx(async (db) => {
			const { a, pp, answers, envelope, now } = await this.attempt(
					db,
					credential,
				),
				r = this.retry(a, o, o.kind);
			if (r.replay) return { version: a.last_outcome_version };
			if (a.state !== "active") fail("conflict");
			const index = pp.findIndex((p) => p.key === o.pageKey),
				current =
					a.current_page_key === "end"
						? pp.length
						: pp.findIndex((p) => p.key === a.current_page_key);
			if (
				index < 0 ||
				index > current ||
				(envelope.mode === "practice" && index !== current) ||
				(o.kind === "advance" && index !== current)
			)
				fail("invalid");
			const page = pp[index],
				saved = answers.find((r) => r.page_key === page.key);
			if (o.kind === "advance") {
				if (
					page.kind === "question" &&
					(!saved || !isFinished(page.question, saved.answer))
				)
					fail("unfinished");
				return this.mutation(
					db,
					a,
					now,
					"advance",
					r,
					pp[index + 1]?.key ?? "end",
				);
			}
			if (
				page.kind !== "question" ||
				!validAnswer(page.question, o.answer) ||
				(envelope.mode === "practice" && !isFinished(page.question, o.answer))
			)
				fail("invalid");
			if (saved?.finalized || equal(saved?.last_nonce_hash, r.nonce))
				fail("conflict");
			const finalized = envelope.mode === "practice",
				correct = finalized ? isCorrect(page.question, o.answer) : null;
			await db.query(
				`INSERT INTO practice_answers(workspace_id,attempt_id,page_key,answer,finalized,server_correct,saved_at,last_nonce_hash,last_payload_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
			 ON CONFLICT(workspace_id,attempt_id,page_key) DO UPDATE SET answer=excluded.answer,saved_at=excluded.saved_at,last_nonce_hash=excluded.last_nonce_hash,last_payload_hash=excluded.last_payload_hash`,
				[
					this.workspace,
					a.id,
					page.key,
					o.answer,
					finalized,
					correct,
					now,
					r.nonce,
					r.payload,
				],
			);
			return this.mutation(db, a, now, "answer", r);
		});
	}
	async submit(credential, input) {
		const o = parse(submitRequest, input);
		this.csrf(credential, o.csrf);
		return this.store.tx(async (db) => {
			const { a, pp, answers, now } = await this.attempt(db, credential),
				r = this.retry(a, o, "submit");
			if (r.replay)
				return { version: a.last_outcome_version, score: a.server_score };
			if (a.state !== "active") fail("conflict");
			const byKey = new Map(answers.map((a) => [a.page_key, a.answer]));
			if (
				a.current_page_key !== "end" ||
				pp.some(
					(p) =>
						p.kind === "question" && !isFinished(p.question, byKey.get(p.key)),
				)
			)
				fail("unfinished");
			const score = scoreAnswers(
				pp,
				pp.map((p) => byKey.get(p.key)),
			);
			for (const page of pp.filter((p) => p.kind === "question"))
				await db.query(
					"UPDATE practice_answers SET finalized=true,server_correct=$4 WHERE workspace_id=$1 AND attempt_id=$2 AND page_key=$3 AND NOT finalized",
					[
						this.workspace,
						a.id,
						page.key,
						isCorrect(page.question, byKey.get(page.key)),
					],
				);
			const result = await this.mutation(db, a, now, "submit", r);
			await db.query(
				"UPDATE practice_attempts SET state='submitted',completed_at=$3,server_score=$4 WHERE workspace_id=$1 AND id=$2",
				[this.workspace, a.id, now, score],
			);
			await this.store.audit(db, "anonymous", "submit", a.id);
			return { ...result, score };
		});
	}
	async finish(credential, input) {
		const o = parse(
			z
				.object({ csrf: z.string().max(43), nonce: z.string().max(43) })
				.strict(),
			input,
		);
		this.csrf(credential, o.csrf);
		tokenHash(o.nonce);
		return this.store.tx(async (db) => {
			// Done only erases access; it must work during an authority outage or after
			// expiry/revocation too. Lock order matches deletion; never read source data.
			const hash = tokenHash(credential);
			const first = (
				await db.query(
					"SELECT link_id FROM practice_attempts WHERE workspace_id=$1 AND resume_hash=$2",
					[this.workspace, hash],
				)
			).rows[0];
			if (!first) return { closed: true };
			await db.query(
				"SELECT id FROM practice_share_links WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
				[this.workspace, first.link_id],
			);
			const a = (
				await db.query(
					"SELECT * FROM practice_attempts WHERE workspace_id=$1 AND resume_hash=$2 FOR UPDATE",
					[this.workspace, hash],
				)
			).rows[0];
			if (!a) return { closed: true };
			const now = await this.store.time(db);
			await db.query(
				"DELETE FROM practice_link_sessions WHERE workspace_id=$1 AND consumed_attempt_id=$2",
				[this.workspace, a.id],
			);
			await db.query(
				"UPDATE practice_attempts SET state='closed',closed_at=$3,resume_hash=NULL,version=version+1 WHERE workspace_id=$1 AND id=$2",
				[this.workspace, a.id, now],
			);
			await this.store.audit(db, "anonymous", "finish", a.id);
			return { closed: true };
		});
	}
}
