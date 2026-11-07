import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { DirectoryError } from "../directory.mjs";
import { ScannerUnavailable } from "./clamav.mjs";
import { validateFile } from "./validate.mjs";

/**
 * breinhap#29: uploads of teaching material and images. An authoring adult uploads; the file is
 * validated (validate.mjs) before anything is stored, then written to the private bucket under a
 * generated key and recorded as `quarantined`. Only a clean ClamAV scan makes it `clean`, and only a
 * clean file can be downloaded, by its uploader, through a short-lived link bound to their account.
 *
 * Scanner down: the file stays quarantined (never read, never served); `scanPending` retries it, and
 * after QUARANTINE_DAYS without a verdict the file is deleted and the row says `scan_timeout`.
 * Infected: the object is deleted at once and the row says `infected`. Deleted: the object goes, and
 * the row keeps only what an audit needs (no name).
 */

export const QUOTA = { bytes: 500 * 1024 * 1024, files: 500 };
export const QUARANTINE_DAYS = 7;
export const MAX_SCAN_ATTEMPTS = 50;
export const LINK_SECONDS = 300;

export const SOURCE_KINDS = [
	["own", "Zelf gemaakt"],
	["school", "Van de school"],
	["publisher", "Van een uitgeverij of methode"],
	["open_licence", "Open leermateriaal"],
	["other", "Andere bron"],
];
export const LICENCES = [
	["own_work", "Mijn eigen werk"],
	["permission", "Ik heb toestemming van de maker"],
	["cc_by", "Creative Commons BY"],
	["cc_by_sa", "Creative Commons BY-SA"],
	["cc0", "CC0 (geen rechten voorbehouden)"],
	["public_domain", "Publiek domein"],
	["unknown", "Weet ik niet"],
];

export class UploadError extends DirectoryError {}
const fail = (code) => {
	throw new UploadError(code);
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** pg_advisory_xact_lock namespace for one workspace's quota. */
const QUOTA_LOCK = 742_119_29;

const COLUMNS = `id, file_name AS "name", kind, media_type AS "mediaType", size_bytes AS "size", status, reason,
  source_kind AS "sourceKind", licence, source_note AS "sourceNote", created_at AS "createdAt", scanned_at AS "scannedAt"`;

export class UploadStore {
	constructor({ directory, storage, scanner, quota = QUOTA, linkSecret, now = () => Date.now(), log = () => {} }) {
		if (!linkSecret || String(linkSecret).length < 32) throw new Error("Upload link secret must have at least 32 characters");
		Object.assign(this, { directory, storage, scanner, quota, linkSecret: String(linkSecret), now, log });
		this.pool = directory.pool;
		this.workspace = directory.workspace;
	}

	async author(principal, action) {
		await this.directory.require(principal, "content.author", action);
	}

	/** The workspace's use of its quota (quarantined and clean files count; rejected and deleted do not). */
	async usage(db = this.pool) {
		const { rows } = await db.query(
			`SELECT coalesce(sum(size_bytes), 0)::bigint AS bytes, count(*)::int AS files FROM uploads
			 WHERE workspace_id = $1 AND status IN ('quarantined', 'clean')`,
			[this.workspace],
		);
		return { bytes: Number(rows[0].bytes), files: rows[0].files, quota: this.quota };
	}

	/**
	 * Validates, stores in quarantine and scans one file. Returns `{ id, status }`. Throws UploadRefused
	 * (validate.mjs) for a file that is not acceptable, UploadError `invalid` / `quota` / `forbidden`.
	 */
	async upload(principal, { name, declaredType, bytes, sourceKind, licence, sourceNote }) {
		await this.author(principal, "upload.create");
		if (!SOURCE_KINDS.some(([k]) => k === sourceKind) || !LICENCES.some(([k]) => k === licence)) fail("invalid");
		const note = String(sourceNote ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300) || null;
		const file = validateFile({ name, declaredType, bytes });
		const id = randomUUID();
		const key = `uploads/${id}`;
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		await this.directory.transaction(async (db) => {
			await db.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [QUOTA_LOCK, this.workspace]);
			const used = await this.usage(db);
			if (used.files + 1 > this.quota.files || used.bytes + bytes.length > this.quota.bytes) fail("quota");
			await db.query(
				`INSERT INTO uploads (workspace_id, id, uploader_sub, file_name, kind, media_type, size_bytes, sha256, storage_key, source_kind, licence, source_note)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
				[this.workspace, id, principal.sub, file.name, file.kind, file.mediaType, bytes.length, sha256, key, sourceKind, licence, note],
			);
			await this.directory.audit(principal.sub, "upload.create", id, "done", db);
		});
		try {
			await this.storage.put(key, bytes, file.mediaType);
		} catch {
			await this.storage.delete(key).catch(() => {});
			await this.finish(id, "rejected", "storage_failed");
			this.log("upload.storage_failed");
			fail("unavailable");
		}
		return { id, status: await this.scanBytes(id, key, bytes) };
	}

	/** Scans bytes already in quarantine and records the verdict; returns the new status. */
	async scanBytes(id, key, bytes) {
		let verdict;
		try {
			verdict = await this.scanner.scan(bytes);
		} catch (error) {
			if (!(error instanceof ScannerUnavailable)) throw error;
			await this.pool.query(
				"UPDATE uploads SET scan_attempts = scan_attempts + 1 WHERE workspace_id = $1 AND id = $2 AND status = 'quarantined'",
				[this.workspace, id],
			);
			this.log("upload.scan_unavailable", { reason: error.reason });
			return "quarantined";
		}
		if (verdict.result === "clean") return this.finish(id, "clean");
		await this.storage.delete(key).catch(() => this.log("upload.delete_failed"));
		this.log("upload.infected");
		return this.finish(id, "rejected", "infected");
	}

	async finish(id, status, reason = null) {
		const { rowCount } = await this.pool.query(
			`UPDATE uploads SET status = $3, reason = $4, scanned_at = now(), scan_attempts = scan_attempts + 1
			 WHERE workspace_id = $1 AND id = $2 AND status = 'quarantined'`,
			[this.workspace, id, status, reason],
		);
		// the action names the outcome (upload.clean, upload.infected, upload.scan_timeout, …)
		if (rowCount) await this.directory.audit("system", `upload.${reason ?? status}`, id, status === "clean" ? "done" : "refused");
		return status;
	}

	/**
	 * Retries files still in quarantine (the scanner was down), oldest first; gives up on one after
	 * QUARANTINE_DAYS or MAX_SCAN_ATTEMPTS and deletes it. Safe to run from several processes: each row
	 * is claimed with SKIP LOCKED.
	 */
	async scanPending({ limit = 5, minAgeSeconds = 60 } = {}) {
		let done = 0;
		for (let i = 0; i < limit; i++) {
			const claimed = await this.directory.transaction(async (db) => {
				const { rows } = await db.query(
					`SELECT id, storage_key AS key, scan_attempts AS attempts, created_at < now() - make_interval(days => $2) AS expired
					 FROM uploads WHERE workspace_id = $1 AND status = 'quarantined' AND created_at < now() - make_interval(secs => $3)
					 ORDER BY scanned_at NULLS FIRST, created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
					[this.workspace, QUARANTINE_DAYS, minAgeSeconds],
				);
				if (!rows[0]) return null;
				// move it to the back of the queue whatever happens next
				await db.query("UPDATE uploads SET scanned_at = now() WHERE workspace_id = $1 AND id = $2", [this.workspace, rows[0].id]);
				return rows[0];
			});
			if (!claimed) break;
			done += 1;
			if (claimed.expired || claimed.attempts >= MAX_SCAN_ATTEMPTS) {
				await this.storage.delete(claimed.key).catch(() => this.log("upload.delete_failed"));
				await this.finish(claimed.id, "rejected", "scan_timeout");
				continue;
			}
			let bytes;
			try {
				bytes = await this.storage.get(claimed.key);
			} catch {
				this.log("upload.storage_unavailable");
				break;
			}
			if (!bytes) {
				await this.finish(claimed.id, "rejected", "missing");
				continue;
			}
			const status = await this.scanBytes(claimed.id, claimed.key, bytes);
			if (status === "quarantined") break; // still down: try again on the next round
		}
		return done;
	}

	/** The uploader's own files (newest first) and the workspace's use of its quota. */
	async list(principal) {
		await this.author(principal, "upload.list");
		const { rows } = await this.pool.query(
			`SELECT ${COLUMNS} FROM uploads WHERE workspace_id = $1 AND uploader_sub = $2 AND status <> 'deleted' ORDER BY created_at DESC LIMIT 200`,
			[this.workspace, principal.sub],
		);
		return { files: rows, usage: await this.usage() };
	}

	async owned(principal, id) {
		if (typeof id !== "string" || !UUID.test(id)) fail("not_found");
		const { rows } = await this.pool.query(
			`SELECT ${COLUMNS}, storage_key AS key FROM uploads WHERE workspace_id = $1 AND id = $2 AND uploader_sub = $3 AND status <> 'deleted'`,
			[this.workspace, id, principal.sub],
		);
		return rows[0] ?? fail("not_found");
	}

	/** A download link for the uploader's clean file, valid LINK_SECONDS, bound to their account. */
	async link(principal, id) {
		await this.author(principal, "upload.read");
		const row = await this.owned(principal, id);
		if (row.status !== "clean") fail("not_ready");
		const expires = Math.floor(this.now() / 1000) + LINK_SECONDS;
		return `/bibliotheek/bestanden/${id}/download?verloopt=${expires}&handtekening=${this.sign(principal.sub, id, expires)}`;
	}

	sign(sub, id, expires) {
		return createHmac("sha256", this.linkSecret).update(`download\n${this.workspace}\n${sub}\n${id}\n${expires}`).digest("base64url");
	}

	/**
	 * The bytes of a clean file for a valid link. Errors: `expired` (a link past its time), `not_found`
	 * (someone else's file, a bad signature, or not clean).
	 */
	async download(principal, id, { expires, signature }) {
		await this.author(principal, "upload.read");
		const at = Number(expires);
		const expected = Buffer.from(this.sign(principal.sub, id, at));
		const given = Buffer.from(String(signature ?? ""));
		if (!Number.isInteger(at) || given.length !== expected.length || !timingSafeEqual(given, expected)) fail("not_found");
		if (at < Math.floor(this.now() / 1000)) fail("expired");
		const row = await this.owned(principal, id);
		if (row.status !== "clean") fail("not_found");
		const bytes = await this.storage.get(row.key);
		if (!bytes) fail("not_found");
		await this.directory.audit(principal.sub, "upload.download", id);
		return { bytes, name: row.name, mediaType: row.mediaType, kind: row.kind };
	}

	/** Deletes the uploader's file: the object first, then the row keeps no name. */
	async remove(principal, id) {
		await this.author(principal, "upload.delete");
		const row = await this.owned(principal, id);
		await this.storage.delete(row.key);
		await this.directory.transaction(async (db) => {
			await db.query(
				`UPDATE uploads SET status = 'deleted', file_name = NULL, source_note = NULL, deleted_at = now()
				 WHERE workspace_id = $1 AND id = $2 AND status <> 'deleted'`,
				[this.workspace, id],
			);
			// breinhap#31: the text extracted from the file goes with it (drafts saved from it stay); the
			// upload row is locked first, so no extraction can be started in between
			await db.query("DELETE FROM extractions WHERE workspace_id = $1 AND upload_id = $2", [this.workspace, id]);
		});
		await this.directory.audit(principal.sub, "upload.delete", id);
	}
}
