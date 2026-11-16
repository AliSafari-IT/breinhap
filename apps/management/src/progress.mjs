/**
 * A student's own progress on assigned homework (breinhap#36), one row per learner, assignment and
 * mission (migration 012). Every method takes a learner id the caller has already verified through
 * the student's session (breinhap#135); nothing here takes an adult principal, and no adult route
 * calls it.
 *
 * - `begin` starts (or starts again) a mission at its first page. A finished mission on the same
 *   publication is left alone: "Nog eens" is an unsaved replay, so the finished state and its date
 *   stay. Progress made on another publication hash is replaced, never mixed in.
 * - `save` writes the next page and answers only when the version the student's form carries is
 *   still the stored one: a second tab or device that moved on makes the first one `stale`, so no
 *   tab silently overwrites another.
 * - `clear` and the account/profile changes delete at once; `retain` deletes 90 days after the
 *   assignment closed, was revoked, or its publication was replaced or withdrawn.
 */

const DAY = 86400_000;
/** Owner decision 2026-11-15: 90 days after the window closes or the assignment is revoked. */
export const PROGRESS_RETENTION_MS = 90 * DAY;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[A-Za-z0-9_-]{43}$/;
const ANSWERS = /^[0-9co.;]{0,2000}$/;
const SWEEP_LIMIT = 500;

export class ProgressError extends Error {
	constructor(code) {
		super(`progress.${code}`);
		this.code = code;
	}
}
const fail = (code) => {
	throw new ProgressError(code);
};

const COLUMNS = `assignment_id AS "assignmentId", mission_id AS "missionId",
  publication_hash AS "publicationHash", page, answers, state, started_at AS "startedAt",
  finished_at AS "finishedAt", updated_at AS "updatedAt", version`;

const checkKey = (learnerId, assignmentId, missionId) => {
	if (!UUID.test(learnerId ?? "") || !UUID.test(assignmentId ?? "")) fail("not_found");
	if (typeof missionId !== "string" || missionId.length < 1 || missionId.length > 200) fail("not_found");
};

export class ProgressStore {
	constructor({ directory, clock }) {
		this.pool = directory.pool;
		this.workspace = directory.workspace;
		this.clock = clock;
	}
	async time(db = this.pool) {
		return this.clock ? new Date(this.clock()) : (await db.query("SELECT clock_timestamp() AS t")).rows[0].t;
	}

	/** This learner's rows for one assignment, by mission id. */
	async forAssignment(learnerId, assignmentId) {
		if (!UUID.test(learnerId ?? "") || !UUID.test(assignmentId ?? "")) return new Map();
		const { rows } = await this.pool.query(
			`SELECT ${COLUMNS} FROM assignment_progress
			 WHERE workspace_id = $1 AND learner_id = $2 AND assignment_id = $3`,
			[this.workspace, learnerId, assignmentId],
		);
		return new Map(rows.map((row) => [row.missionId, row]));
	}

	/** Every row of this learner, for /p/mijn and the student's own data page. */
	async forLearner(learnerId) {
		if (!UUID.test(learnerId ?? "")) return [];
		const { rows } = await this.pool.query(
			`SELECT ${COLUMNS} FROM assignment_progress
			 WHERE workspace_id = $1 AND learner_id = $2
			 ORDER BY started_at, assignment_id, mission_id`,
			[this.workspace, learnerId],
		);
		return rows;
	}

	/**
	 * Starts the mission at page 0, or starts it again. Returns the row, or null when the mission is
	 * already finished on this same publication (the caller plays an unsaved replay instead).
	 */
	async begin(learnerId, assignmentId, missionId, publicationHash) {
		checkKey(learnerId, assignmentId, missionId);
		if (!HASH.test(publicationHash ?? "")) fail("invalid");
		const now = await this.time();
		const { rows } = await this.pool.query(
			`INSERT INTO assignment_progress
			   (workspace_id, assignment_id, learner_id, mission_id, publication_hash, page, answers,
			    state, started_at, updated_at, version)
			 VALUES ($1, $2, $3, $4, $5, 0, '', 'started', $6, $6, 1)
			 ON CONFLICT (workspace_id, assignment_id, learner_id, mission_id) DO UPDATE
			   SET publication_hash = EXCLUDED.publication_hash, page = 0, answers = '',
			       state = 'started', started_at = EXCLUDED.started_at, finished_at = NULL,
			       updated_at = EXCLUDED.updated_at, version = assignment_progress.version + 1
			   WHERE assignment_progress.state = 'started'
			      OR assignment_progress.publication_hash <> EXCLUDED.publication_hash
			 RETURNING ${COLUMNS}`,
			[this.workspace, assignmentId, learnerId, missionId, publicationHash, now],
		);
		return rows[0] ?? null;
	}

	/**
	 * Saves the next page and answers when `expectedVersion` is still the stored version of a mission
	 * that is not finished. `finished` ends it with today's date. Anything else is `stale`.
	 */
	async save(learnerId, assignmentId, missionId, expectedVersion, { publicationHash, page, answers, finished = false }) {
		checkKey(learnerId, assignmentId, missionId);
		if (!Number.isInteger(expectedVersion) || expectedVersion < 1) fail("stale");
		if (!Number.isInteger(page) || page < 0 || page > 999 || typeof answers !== "string" || !ANSWERS.test(answers)) fail("invalid");
		const now = await this.time();
		const { rows } = await this.pool.query(
			`UPDATE assignment_progress
			 SET page = $6, answers = $7, updated_at = $8, version = version + 1,
			     state = CASE WHEN $9 THEN 'finished' ELSE 'started' END,
			     finished_at = CASE WHEN $9 THEN $8::timestamptz ELSE NULL END
			 WHERE workspace_id = $1 AND learner_id = $2 AND assignment_id = $3 AND mission_id = $4
			   AND version = $5 AND state = 'started' AND publication_hash = $10
			 RETURNING ${COLUMNS}`,
			[this.workspace, learnerId, assignmentId, missionId, expectedVersion, page, answers, now, finished, publicationHash],
		);
		if (!rows[0]) fail("stale");
		return rows[0];
	}

	/** The student's own "clear": one assignment, or everything when `assignmentId` is omitted. */
	async clear(learnerId, assignmentId) {
		if (!UUID.test(learnerId ?? "")) fail("not_found");
		if (assignmentId !== undefined && !UUID.test(assignmentId)) fail("not_found");
		const done = await this.pool.query(
			assignmentId === undefined
				? "DELETE FROM assignment_progress WHERE workspace_id = $1 AND learner_id = $2"
				: "DELETE FROM assignment_progress WHERE workspace_id = $1 AND learner_id = $2 AND assignment_id = $3",
			assignmentId === undefined ? [this.workspace, learnerId] : [this.workspace, learnerId, assignmentId],
		);
		return done.rowCount;
	}

	/**
	 * One bounded retention pass: rows 90 days past their assignment's end (window closed, revoked,
	 * publication replaced or withdrawn), and at once rows whose learner is archived or no longer
	 * linked to an account. Counts only.
	 */
	async retain() {
		const now = await this.time();
		const cutoff = new Date(+now - PROGRESS_RETENTION_MS);
		const done = await this.pool.query(
			`DELETE FROM assignment_progress
			 WHERE (workspace_id, assignment_id, learner_id, mission_id) IN (
			   SELECT ap.workspace_id, ap.assignment_id, ap.learner_id, ap.mission_id
			   FROM assignment_progress ap
			   JOIN content_assignments a ON a.workspace_id = ap.workspace_id AND a.id = ap.assignment_id
			   JOIN content_publications p ON p.workspace_id = a.workspace_id AND p.id = a.publication_id
			   JOIN learners l ON l.id = ap.learner_id
			   WHERE ap.workspace_id = $1 AND (
			     a.revoked_at <= $2
			     OR a.available_until <= $2
			     OR (p.state <> 'active' AND p.state_changed_at <= $2)
			     OR l.archived_at IS NOT NULL
			     OR NOT EXISTS (SELECT 1 FROM learner_accounts la
			                     WHERE la.workspace_id = ap.workspace_id AND la.learner_id = ap.learner_id
			                       AND la.unlinked_at IS NULL)
			   )
			   LIMIT ${SWEEP_LIMIT}
			   FOR UPDATE OF ap SKIP LOCKED)`,
			[this.workspace, cutoff],
		);
		return { progress: done.rowCount };
	}
}

/** The bounded sweep: a few passes until one deletes less than the limit. Counts only. */
export async function sweepProgress(store, { rounds = 20 } = {}) {
	let progress = 0;
	for (let i = 0; i < rounds; i++) {
		const done = await store.retain();
		progress += done.progress;
		if (done.progress < SWEEP_LIMIT) break;
	}
	return { progress };
}

/** The hourly pass, like the practice sweep (breinhap#84): counts only in the log, retried on failure. */
export function scheduleProgressSweep(store, { log = console.log, errorLog = console.error, everyMs = 3_600_000, firstMs = 90_000 } = {}) {
	const run = () =>
		sweepProgress(store).then(
			(counts) => {
				if (counts.progress > 0) log(JSON.stringify({ event: "progress.retention", ...counts }));
			},
			() => errorLog("Progress retention failed; will retry"),
		);
	const first = setTimeout(run, firstMs);
	const every = setInterval(run, everyMs);
	first.unref();
	every.unref();
	return () => {
		clearTimeout(first);
		clearInterval(every);
	};
}
