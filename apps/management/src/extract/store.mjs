import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { DirectoryError } from "../directory.mjs";
import { ExtractFailed, FAILURES } from "./limits.mjs";
import { runParser } from "./sandbox.mjs";

/**
 * breinhap#31: extracting the text of an uploaded PDF or DOCX as a background job.
 *
 * - **Only after validation:** a job starts only for the requester's own upload that passed #29's
 *   validation and virus scan (`clean`), and only for PDF and DOCX (macro-free by then).
 * - **One per upload:** starting twice returns the same job; a retry runs the same job again. Jobs make
 *   no drafts: the author maps the text and saves a draft in the editor, which is linked back here.
 * - **Bounded:** one job at a time per process, each parse in a capped thread (sandbox.mjs).
 * - **Recoverable:** a running job holds a lease that its worker renews. A worker that dies (restart,
 *   crash) stops renewing; another picks the job up when the lease lapses, up to MAX_ATTEMPTS. A late
 *   answer from a worker that lost its lease is dropped.
 * - **Cancellable:** a queued job is cancelled at once; a running one at its worker's next heartbeat.
 * - **Scoped:** every read and change is the requester's own (others get `not_found`), with
 *   `content.author`, like uploads and imports.
 * - **Cleaned up:** deleting the upload deletes its extraction; jobs of files that are gone, and
 *   extractions older than RETENTION_DAYS, are removed by `cleanup`.
 */

export const MAX_ATTEMPTS = 3;
export const LEASE_SECONDS = 60;
export const RETENTION_DAYS = 30;
/** A transient failure (storage down, a crashed parser) waits this long × the attempt before the next. */
export const RETRY_SECONDS = 30;
export const SUPPORTED = new Set(["pdf", "docx"]);

export class ExtractionError extends DirectoryError {}
const fail = (code) => {
	throw new ExtractionError(code);
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const SUMMARY = `e.id, e.upload_id AS "uploadId", e.kind, e.status, e.progress, e.attempts, e.error, e.warnings, e.units,
  e.cancel_requested AS "cancelRequested", e.created_at AS "createdAt", e.updated_at AS "updatedAt", e.finished_at AS "finishedAt",
  u.file_name AS "fileName", u.source_kind AS "sourceKind", u.source_note AS "sourceNote", u.licence`;

export class ExtractionStore {
	constructor({ uploads, run = runParser, log = () => {}, leaseSeconds = LEASE_SECONDS, owner } = {}) {
		Object.assign(this, { uploads, run, log, leaseSeconds });
		this.directory = uploads.directory;
		this.storage = uploads.storage;
		this.pool = uploads.pool;
		this.workspace = uploads.workspace;
		this.owner = owner ?? `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
		this.busy = null;
	}

	async author(principal, action) {
		await this.directory.require(principal, "content.author", action);
	}

	// ── the requester's side ─────────────────────────────────────────────────────────────────────────

	/**
	 * Starts (or finds) the extraction of the requester's clean PDF/DOCX upload. Returns `{ id }`.
	 * Errors: `not_found` (not theirs), `not_ready` (not scanned clean yet), `unsupported` (an image).
	 */
	async start(principal, uploadId) {
		await this.author(principal, "extraction.start");
		const upload = await this.uploads.owned(principal, uploadId);
		if (upload.status !== "clean") fail("not_ready");
		if (!SUPPORTED.has(upload.kind)) fail("unsupported");
		// the upload row is share-locked, so a delete of the file cannot slip in between check and insert
		const rows = await this.directory.transaction(async (db) => {
			const { rows: still } = await db.query("SELECT 1 FROM uploads WHERE workspace_id = $1 AND id = $2 AND status = 'clean' FOR SHARE", [this.workspace, uploadId]);
			if (!still.length) fail("not_found");
			return (
				await db.query(
					`INSERT INTO extractions (workspace_id, id, upload_id, requester_sub, kind) VALUES ($1, $2, $3, $4, $5)
					 ON CONFLICT (workspace_id, upload_id) DO UPDATE SET updated_at = extractions.updated_at
					 RETURNING id, (xmax = 0) AS created`,
					[this.workspace, randomUUID(), uploadId, principal.sub, upload.kind],
				)
			).rows;
		});
		if (rows[0].created) await this.directory.audit(principal.sub, "extraction.start", rows[0].id);
		this.kick();
		return { id: rows[0].id, created: rows[0].created };
	}

	/** The requester's extractions, newest first, without their text. */
	async list(principal) {
		await this.author(principal, "extraction.list");
		const { rows } = await this.pool.query(
			`SELECT ${SUMMARY} FROM extractions e JOIN uploads u ON u.workspace_id = e.workspace_id AND u.id = e.upload_id
			 WHERE e.workspace_id = $1 AND e.requester_sub = $2 AND u.status = 'clean' ORDER BY e.updated_at DESC LIMIT 200`,
			[this.workspace, principal.sub],
		);
		return rows;
	}

	/** Extraction ids by upload, for the files page. */
	async byUpload(principal) {
		const { rows } = await this.pool.query(
			"SELECT upload_id AS \"uploadId\", id, status FROM extractions WHERE workspace_id = $1 AND requester_sub = $2",
			[this.workspace, principal.sub],
		);
		return new Map(rows.map((r) => [r.uploadId, r]));
	}

	/** One of the requester's extractions with its blocks and the drafts saved from it. */
	async get(principal, id) {
		await this.author(principal, "extraction.read");
		if (typeof id !== "string" || !UUID.test(id)) fail("not_found");
		const { rows } = await this.pool.query(
			`SELECT ${SUMMARY}, e.blocks FROM extractions e JOIN uploads u ON u.workspace_id = e.workspace_id AND u.id = e.upload_id
			 WHERE e.workspace_id = $1 AND e.id = $2 AND e.requester_sub = $3 AND u.status = 'clean'`,
			[this.workspace, id, principal.sub],
		);
		const row = rows[0] ?? fail("not_found");
		const { rows: drafts } = await this.pool.query(
			`SELECT d.learning_object_id AS id, lo.title FROM extraction_drafts d
			 JOIN learning_objects lo ON lo.workspace_id = d.workspace_id AND lo.id = d.learning_object_id
			 WHERE d.workspace_id = $1 AND d.extraction_id = $2 AND lo.owner_sub = $3 AND lo.archived_at IS NULL ORDER BY d.created_at`,
			[this.workspace, id, principal.sub],
		);
		return { ...row, blocks: row.blocks ?? [], drafts };
	}

	/** Cancels a queued job at once, a running one at its next heartbeat. Returns the status. */
	async cancel(principal, id) {
		await this.author(principal, "extraction.cancel");
		await this.get(principal, id);
		const { rows } = await this.pool.query(
			`UPDATE extractions SET
			   status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
			   cancel_requested = (status = 'running'),
			   finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END,
			   lease_until = CASE WHEN status = 'queued' THEN NULL ELSE lease_until END,
			   updated_at = now()
			 WHERE workspace_id = $1 AND id = $2 AND status IN ('queued', 'running') RETURNING status`,
			[this.workspace, id],
		);
		if (rows[0]) await this.directory.audit(principal.sub, "extraction.cancel", id);
		return rows[0]?.status ?? (await this.get(principal, id)).status;
	}

	/**
	 * Runs a failed or cancelled job again: the same job, from the start. Drafts already saved from it
	 * stay as they are (they are linked, never re-created). Errors: `not_retryable` (queued, running, done).
	 */
	async retry(principal, id) {
		await this.author(principal, "extraction.retry");
		await this.get(principal, id);
		const { rowCount } = await this.pool.query(
			`UPDATE extractions SET status = 'queued', progress = 0, attempts = 0, error = NULL, warnings = '[]', blocks = NULL,
			   units = NULL, cancel_requested = false, lease_until = NULL, finished_at = NULL, updated_at = now()
			 WHERE workspace_id = $1 AND id = $2 AND status IN ('failed', 'cancelled')`,
			[this.workspace, id],
		);
		if (!rowCount) fail("not_retryable");
		await this.directory.audit(principal.sub, "extraction.retry", id);
		this.kick();
	}

	/** Deletes the extracted text (a running job is dropped too). Saved drafts stay the author's. */
	async remove(principal, id) {
		await this.author(principal, "extraction.delete");
		await this.get(principal, id);
		await this.pool.query("DELETE FROM extractions WHERE workspace_id = $1 AND id = $2", [this.workspace, id]);
		await this.directory.audit(principal.sub, "extraction.delete", id);
	}

	/** Records that the author saved draft `objectId` from extraction `id` (both theirs). Idempotent. */
	async linkDraft(principal, id, objectId) {
		const extraction = await this.get(principal, id);
		await this.pool.query(
			`INSERT INTO extraction_drafts (workspace_id, extraction_id, learning_object_id)
			 SELECT $1, $2, lo.id FROM learning_objects lo WHERE lo.workspace_id = $1 AND lo.id = $3 AND lo.owner_sub = $4
			 ON CONFLICT DO NOTHING`,
			[this.workspace, extraction.id, objectId, principal.sub],
		);
	}

	// ── the worker's side ────────────────────────────────────────────────────────────────────────────

	/** Starts working through the queue now, unless this process already is. */
	kick() {
		if (this.busy) return this.busy;
		this.busy = (async () => {
			try {
				while (await this.runOnce());
			} catch {
				this.log("extraction.worker_failed");
			} finally {
				this.busy = null;
			}
		})();
		return this.busy;
	}

	/**
	 * Claims the oldest queued job, or a running one whose lease lapsed (its worker is gone), and runs
	 * it. Returns false when there was nothing to do. Safe across processes: SKIP LOCKED.
	 */
	async runOnce() {
		const job = await this.directory.transaction(async (db) => {
			const { rows } = await db.query(
				`SELECT e.id, e.kind, e.status, e.attempts, e.cancel_requested AS "cancelRequested", u.storage_key AS key, u.status AS "uploadStatus"
				 FROM extractions e JOIN uploads u ON u.workspace_id = e.workspace_id AND u.id = e.upload_id
				 WHERE e.workspace_id = $1 AND e.status IN ('queued', 'running') AND (e.lease_until IS NULL OR e.lease_until < now())
				 ORDER BY e.created_at LIMIT 1 FOR UPDATE OF e SKIP LOCKED`,
				[this.workspace],
			);
			const row = rows[0];
			if (!row) return null;
			const end = async (status, error = null) => {
				await db.query(
					`UPDATE extractions SET status = $3, error = $4, lease_owner = NULL, lease_until = NULL, cancel_requested = false,
					   blocks = NULL, finished_at = now(), updated_at = now() WHERE workspace_id = $1 AND id = $2`,
					[this.workspace, row.id, status, error],
				);
				return { id: row.id, ended: status, error };
			};
			if (row.cancelRequested) return end("cancelled");
			if (row.uploadStatus !== "clean") return end("failed", "file_unavailable");
			// a job that keeps losing its worker (a crash mid-parse, every time) is not tried forever
			if (row.attempts >= MAX_ATTEMPTS) return end("failed", "interrupted");
			await db.query(
				`UPDATE extractions SET status = 'running', lease_owner = $3, lease_until = now() + make_interval(secs => $4),
				   attempts = attempts + 1, progress = 0, started_at = coalesce(started_at, now()), updated_at = now()
				 WHERE workspace_id = $1 AND id = $2`,
				[this.workspace, row.id, this.owner, this.leaseSeconds],
			);
			if (row.status === "running") this.log("extraction.recovered");
			return row;
		});
		if (!job) return false;
		if (job.ended) {
			await this.directory.audit("system", `extraction.${job.error ?? job.ended}`, job.id, job.ended === "failed" ? "refused" : "done");
			return true;
		}
		await this.process(job);
		return true;
	}

	async process(job) {
		const controller = new AbortController();
		let progress = 0;
		let reason = null;
		const beat = async () => {
			const { rows } = await this.pool.query(
				`UPDATE extractions SET lease_until = now() + make_interval(secs => $4), progress = greatest(progress, $5), updated_at = now()
				 WHERE workspace_id = $1 AND id = $2 AND lease_owner = $3 AND status = 'running' RETURNING cancel_requested AS cancel`,
				[this.workspace, job.id, this.owner, this.leaseSeconds, progress],
			);
			if (!rows[0]) reason = "lost";
			else if (rows[0].cancel) reason = "cancelled";
			if (reason) controller.abort();
		};
		const heartbeat = setInterval(() => beat().catch(() => {}), Math.max(100, Math.min(2_000, (this.leaseSeconds * 1000) / 4)));
		let outcome;
		try {
			let bytes;
			try {
				bytes = await this.storage.get(job.key);
			} catch {
				throw new ExtractFailed("storage_unavailable");
			}
			if (!bytes) throw new ExtractFailed("file_unavailable");
			const result = await this.run({
				kind: job.kind,
				bytes,
				signal: controller.signal,
				onProgress: (done, total) => {
					progress = Math.min(99, Math.floor((done / total) * 100));
				},
			});
			outcome = { status: "done", result };
		} catch (error) {
			const code = error instanceof ExtractFailed ? error.code : "internal";
			outcome = code === "cancelled" ? { status: reason === "lost" ? "lost" : "cancelled" } : { status: "failed", code };
		} finally {
			clearInterval(heartbeat);
		}
		await this.settle(job, outcome);
	}

	/** Records the outcome, only while this worker still holds the job's lease. */
	async settle(job, outcome) {
		const where = "WHERE workspace_id = $1 AND id = $2 AND lease_owner = $3 AND status = 'running'";
		const params = [this.workspace, job.id, this.owner];
		let rowCount = 0;
		if (outcome.status === "done") {
			const { blocks, warnings, units } = outcome.result;
			// a cancel that arrived after the last heartbeat still wins: the text is not kept
			({ rowCount } = await this.pool.query(
				`UPDATE extractions SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'done' END,
				   progress = CASE WHEN cancel_requested THEN progress ELSE 100 END,
				   blocks = CASE WHEN cancel_requested THEN NULL ELSE $4::jsonb END,
				   warnings = CASE WHEN cancel_requested THEN warnings ELSE $5::jsonb END,
				   units = CASE WHEN cancel_requested THEN NULL ELSE $6::integer END, error = NULL,
				   lease_owner = NULL, lease_until = NULL, cancel_requested = false, finished_at = now(), updated_at = now() ${where}`,
				[...params, JSON.stringify(blocks), JSON.stringify(warnings), units ?? null],
			));
		} else if (outcome.status === "cancelled") {
			({ rowCount } = await this.pool.query(
				`UPDATE extractions SET status = 'cancelled', lease_owner = NULL, lease_until = NULL, cancel_requested = false,
				   finished_at = now(), updated_at = now() ${where}`,
				params,
			));
		} else if (outcome.status === "failed") {
			// a transient failure goes back to the queue (attempts still count); the rest is final
			const again = FAILURES[outcome.code]?.retryable && outcome.code !== "timeout";
			({ rowCount } = await this.pool.query(
				again
					? `UPDATE extractions SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
					     error = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN $4 ELSE NULL END, lease_owner = NULL,
					     -- back in the queue, but not before a pause that grows with each attempt
					     lease_until = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN NULL ELSE now() + make_interval(secs => ${RETRY_SECONDS} * attempts) END,
					     finished_at = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN now() END, updated_at = now() ${where}`
					: `UPDATE extractions SET status = 'failed', error = $4, lease_owner = NULL, lease_until = NULL, cancel_requested = false,
					     finished_at = now(), updated_at = now() ${where}`,
				[...params, FAILURES[outcome.code] ? outcome.code : "internal"],
			));
		}
		if (!rowCount) {
			this.log("extraction.result_dropped");
			return;
		}
		const action = outcome.status === "failed" ? `extraction.${outcome.code}` : `extraction.${outcome.status}`;
		await this.directory.audit("system", action, job.id, outcome.status === "failed" ? "refused" : "done");
	}

	/**
	 * Removes extractions whose file is gone (deleted, or never clean) and those older than
	 * RETENTION_DAYS. Their saved drafts stay. Returns how many were removed.
	 */
	async cleanup() {
		const { rowCount } = await this.pool.query(
			`DELETE FROM extractions e USING uploads u
			 WHERE e.workspace_id = $1 AND u.workspace_id = e.workspace_id AND u.id = e.upload_id
			   AND (u.status <> 'clean' OR (e.status <> 'running' AND e.updated_at < now() - make_interval(days => $2)))`,
			[this.workspace, RETENTION_DAYS],
		);
		return rowCount;
	}
}
