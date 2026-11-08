import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LearningObject } from "../vendor/content-schema.mjs";
import { studentPayload } from "../vendor/content-mission.mjs";
import {
	DAY,
	equal,
	PracticeError,
	fail,
	validateDraft,
	canonical,
	contentHash,
	token,
	tokenHash,
	pages,
} from "./model.mjs";

const uuid = z.string().uuid();
export const parse = (schema, value) => {
	const r = schema.safeParse(value);
	return r.success ? r.data : fail("invalid");
};
const withoutReview = ({ review, ...object }) => object;

// External authority errors must not carry upstream request bodies or credentials outward.
async function authority(work) {
	try {
		return await work();
	} catch (error) {
		if (
			error instanceof PracticeError &&
			["gone", "unsupported_version"].includes(error.code)
		)
			fail(error.code);
		fail("unavailable");
	}
}

/** Closed storage boundary. No runtime/HTTP registration: #32/#33 and the identity integration
 * must supply the two trusted adapters before any freeze/share/public operation can succeed. */
export class PracticeStore {
	constructor({ directory, publishedContent, ownerEligibility, clock }) {
		this.directory = directory;
		this.pool = directory.pool;
		this.workspace = directory.workspace;
		this.publishedContent = publishedContent;
		this.ownerEligibility = ownerEligibility;
		this.clock = clock;
	}
	async tx(work) {
		const db = await this.pool.connect();
		try {
			await db.query("BEGIN");
			const result = await work(db);
			await db.query("COMMIT");
			return result;
		} catch (e) {
			await db.query(
				e instanceof PracticeError && e.commit ? "COMMIT" : "ROLLBACK",
			);
			throw e;
		} finally {
			db.release();
		}
	}
	async time(db) {
		return this.clock
			? new Date(this.clock())
			: (await db.query("SELECT clock_timestamp() AS t")).rows[0].t;
	}
	async author(p, action = "practice.read") {
		await this.directory.require(p, "content.author", action);
	}
	async assign(p) {
		await this.author(p, "practice.share");
		await this.directory.require(p, "content.assign", "practice.share");
	}
	async audit(db, actor, action, target) {
		await this.directory.audit(actor, `practice.${action}`, target, "done", db);
	}
	async owned(db, p, id, lock = false, archived = false) {
		if (!uuid.safeParse(id).success) fail("not_found");
		const { rows } = await db.query(
			`SELECT * FROM practice_packs WHERE workspace_id=$1 AND id=$2 AND owner_sub=$3 ${archived ? "" : "AND archived_at IS NULL"} ${lock ? "FOR UPDATE" : ""}`,
			[this.workspace, id, p.sub],
		);
		return rows[0] ?? fail("not_found");
	}
	async create(p, input) {
		await this.author(p, "practice.create");
		const draft = validateDraft(input);
		return this.tx(async (db) => {
			// Serialize the bounded owner count, including concurrent creates in another process.
			await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
				JSON.stringify([this.workspace, p.sub, "practice-create"]),
			]);
			const count = await db.query(
				"SELECT count(*)::int AS n FROM practice_packs WHERE workspace_id=$1 AND owner_sub=$2 AND archived_at IS NULL",
				[this.workspace, p.sub],
			);
			if (count.rows[0].n >= 100) fail("limit");
			const id = randomUUID(),
				now = await this.time(db);
			await db.query(
				"INSERT INTO practice_packs(workspace_id,id,owner_sub,draft,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)",
				[this.workspace, id, p.sub, draft, now],
			);
			await this.audit(db, p.sub, "create", id);
			return { id, version: 1 };
		});
	}
	async get(p, id) {
		await this.author(p);
		const row = await this.owned(this.pool, p, id);
		return { id: row.id, version: row.draft_version, draft: row.draft };
	}
	async list(p) {
		await this.author(p);
		return (
			await this.pool.query(
				"SELECT id,draft_version AS version,draft->>'title' AS title,updated_at FROM practice_packs WHERE workspace_id=$1 AND owner_sub=$2 AND archived_at IS NULL ORDER BY updated_at DESC,id LIMIT 100",
				[this.workspace, p.sub],
			)
		).rows;
	}
	async update(p, id, expectedVersion, input) {
		await this.author(p, "practice.update");
		const draft = validateDraft(input);
		return this.tx(async (db) => {
			const row = await this.owned(db, p, id, true);
			if (row.draft_version !== expectedVersion) fail("stale");
			await db.query(
				"UPDATE practice_packs SET draft=$3,draft_version=draft_version+1,updated_at=$4 WHERE workspace_id=$1 AND id=$2",
				[this.workspace, id, draft, await this.time(db)],
			);
			await this.audit(db, p.sub, "update", id);
			return { id, version: expectedVersion + 1 };
		});
	}
	async duplicate(p, id) {
		return this.create(p, (await this.get(p, id)).draft);
	}
	async archive(p, id) {
		await this.author(p, "practice.archive");
		return this.tx(async (db) => {
			await this.owned(db, p, id, true);
			const now = await this.time(db);
			await db.query(
				"UPDATE practice_packs SET archived_at=$3 WHERE workspace_id=$1 AND id=$2",
				[this.workspace, id, now],
			);
			await db.query(
				"UPDATE practice_share_links SET revoked_at=coalesce(revoked_at,$3),active_slot=false WHERE workspace_id=$1 AND pack_id=$2",
				[this.workspace, id, now],
			);
			await this.audit(db, p.sub, "archive", id);
		});
	}
	refs(draft) {
		const refs = new Map();
		for (const r of [...draft.missionRefs, ...draft.assessmentRefs]) {
			if (!r.publicationId || !r.revisionHash || !r.publicationHash)
				fail("unavailable");
			const ref = {
				objectId: r.objectId,
				revision: r.revision,
				publicationId: r.publicationId,
				revisionHash: r.revisionHash,
				publicationHash: r.publicationHash,
			};
			if (
				refs.has(r.objectId) &&
				canonical(refs.get(r.objectId)) !== canonical(ref)
			)
				fail("invalid");
			refs.set(r.objectId, ref);
		}
		return [...refs.values()].sort((a, b) =>
			a.objectId < b.objectId ? -1 : 1,
		);
	}
	/** Adapter locks publication/withdrawal rows until this transaction commits. It returns the
	 * requested refs in order plus `object` (LearningObject with independently reviewed status).
	 * No publication table or author-provided review flag is substituted here. */
	async sources(db, ownerSub, refs) {
		if (!this.publishedContent?.lockForPractice) fail("unavailable");
		const approved = await authority(() =>
			this.publishedContent.lockForPractice(db, {
				workspaceId: this.workspace,
				ownerSub,
				refs: refs.map(
					({
						objectId,
						revision,
						publicationId,
						revisionHash,
						publicationHash,
					}) => ({
						objectId,
						revision,
						publicationId,
						revisionHash,
						publicationHash,
					}),
				),
			}),
		);
		if (!Array.isArray(approved) || approved.length !== refs.length)
			fail("unavailable");
		const objects = new Map();
		for (let i = 0; i < refs.length; i++) {
			const r = refs[i],
				a = approved[i];
			if (
				!a ||
				[
					"objectId",
					"revision",
					"publicationId",
					"revisionHash",
					"publicationHash",
				].some((k) => a[k] !== r[k])
			)
				fail("unavailable");
			const parsed = LearningObject.safeParse(a.object);
			if (!parsed.success)
				fail(
					a.object?.schemaVersion !== 1 ? "unsupported_version" : "unavailable",
				);
			const object = parsed.data;
			if (
				object.id !== r.objectId ||
				object.review.status !== "reviewed" ||
				!object.review.reviewedBy ||
				object.review.reviewedBy === ownerSub
			)
				fail("unavailable");
			const stored = (
				await db.query(
					`SELECT r.content,r.content_hash FROM learning_object_revisions r JOIN learning_objects o ON o.workspace_id=r.workspace_id AND o.id=r.learning_object_id
			 WHERE r.workspace_id=$1 AND r.learning_object_id=$2 AND r.revision=$3 AND o.owner_sub=$4 AND o.archived_at IS NULL`,
					[this.workspace, r.objectId, r.revision, ownerSub],
				)
			).rows[0];
			if (
				!stored ||
				stored.content_hash !== r.revisionHash ||
				canonical(withoutReview(LearningObject.parse(stored.content))) !==
					canonical(withoutReview(object))
			)
				fail("unavailable");
			objects.set(r.objectId, studentPayload(object));
		}
		return objects;
	}
	async freeze(p, id, expectedVersion) {
		await this.author(p, "practice.freeze");
		return this.tx(async (db) => {
			const first = await this.owned(db, p, id),
				d = validateDraft(first.draft),
				refs = this.refs(d);
			if ((await this.eligibility(p.sub, p.membershipVersion)) !== "eligible")
				fail("gone");
			const objects = await this.sources(db, p.sub, refs); // source locks before pack lock
			const row = await this.owned(db, p, id, true);
			if (
				row.draft_version !== expectedVersion ||
				first.draft_version !== expectedVersion
			)
				fail("stale");
			const mission = (r) =>
				objects.get(r.objectId)?.missions.find((m) => m.id === r.missionId) ??
				fail("invalid");
			const missions = d.missionRefs.map(mission);
			const assessments = d.assessmentRefs.map(
				(r) => mission(r)[r.stage][r.questionIndex] ?? fail("invalid"),
			);
			const version = (
				await db.query(
					"SELECT coalesce(max(version),0)+1 AS v FROM practice_pack_versions WHERE workspace_id=$1 AND pack_id=$2",
					[this.workspace, id],
				)
			).rows[0].v;
			const { missionRefs, assessmentRefs, shareDefaults, ...metadata } = d;
			const envelope = {
				modelVersion: 1,
				contentSchemaVersion: 1,
				workspaceId: this.workspace,
				packId: id,
				version,
				...metadata,
				sourceRefs: refs.map((ref) => ({
					...ref,
					missionRefs: missionRefs
						.filter((r) => r.objectId === ref.objectId)
						.map((r) => r.missionId),
					assessmentRefs: assessmentRefs
						.filter((r) => r.objectId === ref.objectId)
						.map((r) => ({
							missionId: r.missionId,
							stage: r.stage,
							questionIndex: r.questionIndex,
						})),
				})),
				missions,
				assessments,
			};
			if (
				Buffer.byteLength(canonical(envelope)) > 1_048_576 ||
				pages(envelope).filter((p) => p.kind === "question").length > 27
			)
				fail("invalid");
			for (const page of pages(envelope).filter(
				(p) => p.kind === "question" && p.question.kind === "order",
			)) {
				const sample = {
					csrf: "x".repeat(43),
					nonce: "x".repeat(43),
					expectedVersion: Number.MAX_SAFE_INTEGER,
					pageKey: page.key,
					kind: "answer",
					answer: { kind: "order", placed: page.question.items, checked: true },
				};
				if (Buffer.byteLength(JSON.stringify(sample)) > 8192) fail("invalid");
			}
			const hash = contentHash(envelope),
				now = await this.time(db);
			await db.query(
				"INSERT INTO practice_pack_versions(workspace_id,pack_id,version,model_version,content_schema_version,envelope,content_hash,created_by,created_at) VALUES($1,$2,$3,1,1,$4,$5,$6,$7)",
				[this.workspace, id, version, envelope, hash, p.sub, now],
			);
			for (const r of refs)
				await db.query(
					"INSERT INTO practice_pack_sources(workspace_id,pack_id,version,object_id,revision,revision_hash,publication_id,publication_hash,mission_refs,assessment_refs) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
					[
						this.workspace,
						id,
						version,
						r.objectId,
						r.revision,
						r.revisionHash,
						r.publicationId,
						r.publicationHash,
						JSON.stringify(
							envelope.sourceRefs.find((s) => s.objectId === r.objectId)
								.missionRefs,
						),
						JSON.stringify(
							envelope.sourceRefs.find((s) => s.objectId === r.objectId)
								.assessmentRefs,
						),
					],
				);
			await this.audit(db, p.sub, "freeze", `${id}:${version}`);
			return { id, version, hash };
		});
	}
	async eligibility(ownerSub, membershipVersion) {
		if (
			!this.ownerEligibility?.checkForPractice ||
			typeof membershipVersion !== "string" ||
			!membershipVersion.length ||
			membershipVersion.length > 200
		)
			fail("unavailable");
		const verdict = await authority(() =>
			this.ownerEligibility.checkForPractice({
				workspaceId: this.workspace,
				ownerSub,
				membershipVersion,
			}),
		);
		if (verdict !== "eligible" && verdict !== "denied") fail("unavailable");
		return verdict;
	}
	async frozen(db, id, version) {
		const row =
			(
				await db.query(
					"SELECT * FROM practice_pack_versions WHERE workspace_id=$1 AND pack_id=$2 AND version=$3",
					[this.workspace, id, version],
				)
			).rows[0] ?? fail("not_found");
		pages(row.envelope);
		if (contentHash(row.envelope) !== row.content_hash) fail("unavailable");
		return row.envelope;
	}
	async mint(p, id, version, options) {
		await this.assign(p);
		const o = parse(
			z
				.object({
					nonce: z.string().min(1).max(200),
					expiryDays: z.number().int().min(1).max(30).optional(),
					notBefore: z.date().optional(),
					rotate: z.boolean().default(false),
				})
				.strict(),
			options,
		);
		return this.tx(async (db) => {
			const owner = await this.owned(db, p, id),
				envelope = await this.frozen(
					db,
					id,
					parse(z.number().int().positive(), version),
				);
			if ((await this.eligibility(p.sub, p.membershipVersion)) !== "eligible")
				fail("gone");
			await this.sources(db, p.sub, envelope.sourceRefs);
			await this.owned(db, p, id, true);
			const active = (
				await db.query(
					"SELECT * FROM practice_share_links WHERE workspace_id=$1 AND pack_id=$2 AND active_slot FOR UPDATE",
					[this.workspace, id],
				)
			).rows[0];
			const now = await this.time(db),
				nonceHash = contentHash({ nonce: o.nonce });
			if (
				equal(active?.last_mint_nonce_hash, Buffer.from(nonceHash, "base64url"))
			)
				return {
					id: active.id,
					version: active.pack_version,
					expiresAt: active.expires_at,
				};
			if (active && !o.rotate && active.expires_at > now) fail("exists");
			if (active)
				await db.query(
					"UPDATE practice_share_links SET active_slot=false,revoked_at=coalesce(revoked_at,$3) WHERE workspace_id=$1 AND id=$2",
					[this.workspace, active.id, now],
				);
			const expires = new Date(
					+now + (o.expiryDays ?? owner.draft.shareDefaults.expiryDays) * DAY,
				),
				notBefore =
					o.notBefore ??
					(owner.draft.shareDefaults.notBefore
						? new Date(owner.draft.shareDefaults.notBefore)
						: now);
			if (notBefore < now || notBefore >= expires) fail("invalid");
			const secret = token(),
				linkId = randomUUID();
			await db.query(
				"INSERT INTO practice_share_links(workspace_id,id,pack_id,pack_version,token_hash,owner_membership_version,not_before,expires_at,created_by,created_at,last_mint_nonce_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
				[
					this.workspace,
					linkId,
					id,
					version,
					tokenHash(secret),
					p.membershipVersion,
					notBefore,
					expires,
					p.sub,
					now,
					Buffer.from(nonceHash, "base64url"),
				],
			);
			await this.audit(db, p.sub, "mint", linkId);
			return { id: linkId, version, expiresAt: expires, token: secret };
		});
	}
	async revoke(p, id, linkId) {
		await this.assign(p);
		return this.tx(async (db) => {
			await this.owned(db, p, id, false, true);
			const result = await db.query(
				"UPDATE practice_share_links SET revoked_at=coalesce(revoked_at,$4),active_slot=false WHERE workspace_id=$1 AND id=$2 AND pack_id=$3 RETURNING id",
				[this.workspace, parse(uuid, linkId), id, await this.time(db)],
			);
			if (!result.rowCount) fail("not_found");
			await this.audit(db, p.sub, "revoke", linkId);
		});
	}
	/** Public operations acquire source locks, then the link, then flow/attempt/answer locks.
	 * A definite owner denial commits revocation before reporting gone. Outages roll back. */
	validLink(link, now) {
		if (
			link.revoked_at ||
			!link.active_slot ||
			link.expires_at <= now ||
			link.not_before > now
		)
			fail("gone");
	}

	async context(db, linkId) {
		const first =
			(
				await db.query(
					"SELECT l.*,p.owner_sub FROM practice_share_links l JOIN practice_packs p ON p.workspace_id=l.workspace_id AND p.id=l.pack_id WHERE l.workspace_id=$1 AND l.id=$2",
					[this.workspace, linkId],
				)
			).rows[0] ?? fail("not_found");
		const verdict = await this.eligibility(
			first.owner_sub,
			first.owner_membership_version,
		);
		if (verdict === "denied") {
			await db.query(
				"UPDATE practice_share_links SET revoked_at=coalesce(revoked_at,$3),active_slot=false WHERE workspace_id=$1 AND id=$2",
				[this.workspace, linkId, await this.time(db)],
			);
			fail("gone", true);
		}
		const envelope = await this.frozen(db, first.pack_id, first.pack_version);
		await this.sources(db, first.owner_sub, envelope.sourceRefs);
		const link =
			(
				await db.query(
					"SELECT * FROM practice_share_links WHERE workspace_id=$1 AND id=$2 FOR UPDATE",
					[this.workspace, linkId],
				)
			).rows[0] ?? fail("not_found");
		const now = await this.time(db);
		this.validLink(link, now);
		return { link, envelope, now };
	}
	async results(p, id) {
		await this.author(p, "practice.results");
		await this.owned(this.pool, p, id, false, true);
		if ((await this.eligibility(p.sub, p.membershipVersion)) !== "eligible")
			fail("gone");
		return this.tx(async (db) => {
			const attempts = (
				await db.query(
					"SELECT * FROM practice_attempts WHERE workspace_id=$1 AND pack_id=$2 ORDER BY started_at,id LIMIT 100",
					[this.workspace, id],
				)
			).rows;
			const results = [];
			for (const a of attempts) {
				const result = {
					id: a.id,
					linkId: a.link_id,
					version: a.pack_version,
					state: a.state,
					startedAt: a.started_at,
					completedAt: a.completed_at,
					score: a.server_score,
					questionCount: a.question_count,
				};
				if (a.completed_at)
					result.answers = (
						await db.query(
							"SELECT page_key,answer,server_correct FROM practice_answers WHERE workspace_id=$1 AND attempt_id=$2 ORDER BY page_key",
							[this.workspace, a.id],
						)
					).rows;
				results.push(result);
			}
			return results;
		});
	}
	async deleteAttempts(p, id, attemptId) {
		await this.author(p, "practice.delete");
		if (attemptId !== undefined) parse(uuid, attemptId);
		return this.tx(async (db) => {
			await this.owned(db, p, id, true, true);
			const links = (
				await db.query(
					"SELECT id FROM practice_share_links WHERE workspace_id=$1 AND pack_id=$2 ORDER BY id FOR UPDATE",
					[this.workspace, id],
				)
			).rows;
			let count = 0;
			for (const l of links) {
				const attempts = (
					await db.query(
						`SELECT id FROM practice_attempts WHERE workspace_id=$1 AND link_id=$2 ${attemptId === undefined ? "" : "AND id=$3"} FOR UPDATE`,
						attemptId === undefined
							? [this.workspace, l.id]
							: [this.workspace, l.id, attemptId],
					)
				).rows;
				for (const a of attempts) {
					await this.erase(db, a.id);
					count++;
				}
			}
			if (attemptId !== undefined && !count) fail("not_found");
			await this.audit(db, p.sub, "delete", id);
			return { deleted: count };
		});
	}
	async erase(db, id) {
		await db.query(
			"DELETE FROM practice_link_sessions WHERE workspace_id=$1 AND consumed_attempt_id=$2",
			[this.workspace, id],
		);
		await db.query(
			"DELETE FROM practice_attempts WHERE workspace_id=$1 AND id=$2",
			[this.workspace, id],
		);
	}
	/** One bounded maintenance pass. Run hourly and repeat until counts are below the limits.
	 * No credentials/answers/identifiers in the result; link consumption is never decremented. */
	async retain() {
		return this.tx(async (db) => {
			const now = await this.time(db);
			const flows = await db.query(
				"DELETE FROM practice_link_sessions WHERE session_hash IN (SELECT session_hash FROM practice_link_sessions WHERE workspace_id=$1 AND expires_at<=$2 ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED)",
				[this.workspace, now],
			);
			// Lock links first; Start recovery takes link → flow → attempt, so an attempt-first
			// sweeper could deadlock with recovery while deleting its consumed flow.
			const locked = (
				await db.query(
					"SELECT l.id FROM practice_share_links l WHERE l.workspace_id=$1 AND EXISTS(SELECT 1 FROM practice_attempts a WHERE a.workspace_id=l.workspace_id AND a.link_id=l.id AND a.delete_after<=$2) ORDER BY l.id LIMIT 100 FOR UPDATE SKIP LOCKED",
					[this.workspace, now],
				)
			).rows;
			const due = locked.length
				? (
						await db.query(
							"SELECT id FROM practice_attempts WHERE workspace_id=$1 AND link_id=ANY($2::uuid[]) AND delete_after<=$3 ORDER BY delete_after,id LIMIT 100 FOR UPDATE SKIP LOCKED",
							[this.workspace, locked.map((l) => l.id), now],
						)
					).rows
				: [];
			for (const a of due) await this.erase(db, a.id);
			const links = await db.query(
				`DELETE FROM practice_share_links WHERE (workspace_id,id) IN (SELECT l.workspace_id,l.id FROM practice_share_links l WHERE l.workspace_id=$1 AND least(l.expires_at,coalesce(l.revoked_at,l.expires_at))<=$2
			 AND NOT EXISTS(SELECT 1 FROM practice_attempts a WHERE a.workspace_id=l.workspace_id AND a.link_id=l.id)
			 AND NOT EXISTS(SELECT 1 FROM practice_link_sessions f WHERE f.workspace_id=l.workspace_id AND f.link_id=l.id) ORDER BY l.id LIMIT 100 FOR UPDATE SKIP LOCKED)`,
				[this.workspace, new Date(+now - 30 * DAY)],
			);
			// Source references cascade only from an archived, unreferenced immutable version.
			const versions = await db.query(
				`DELETE FROM practice_pack_versions WHERE (workspace_id,pack_id,version) IN (SELECT v.workspace_id,v.pack_id,v.version FROM practice_pack_versions v JOIN practice_packs p ON p.workspace_id=v.workspace_id AND p.id=v.pack_id WHERE v.workspace_id=$1 AND p.archived_at IS NOT NULL
			 AND NOT EXISTS(SELECT 1 FROM practice_share_links l WHERE l.workspace_id=v.workspace_id AND l.pack_id=v.pack_id AND l.pack_version=v.version) ORDER BY v.pack_id,v.version LIMIT 100 FOR UPDATE OF v SKIP LOCKED)`,
				[this.workspace],
			);
			return {
				flows: flows.rowCount,
				attempts: due.length,
				links: links.rowCount,
				versions: versions.rowCount,
			};
		});
	}
}
