/**
 * Retention for practice data (breinhap#84). One pass of `PracticeStore.retain()` is bounded; a
 * backlog is worked off in a few passes, never an unbounded loop. Idempotent and restart-safe: it
 * only deletes rows already past their time, and consumed link quota is never given back.
 * The result is counts only: no id, credential, answer or score.
 */
const LIMITS = { flows: 500, attempts: 100, links: 100, versions: 100 };

export async function sweep(store, { rounds = 20 } = {}) {
	const total = { flows: 0, attempts: 0, links: 0, versions: 0, rounds: 0 };
	for (let i = 0; i < rounds; i++) {
		const done = await store.retain();
		total.rounds++;
		for (const key of Object.keys(LIMITS)) total[key] += done[key];
		if (Object.keys(LIMITS).every((key) => done[key] < LIMITS[key])) break;
	}
	return total;
}

/** Starts the hourly pass. `log` receives counts only; a failure is logged without detail and retried. */
export function scheduleSweep(store, { log = console.log, errorLog = console.error, everyMs = 3_600_000, firstMs = 60_000 } = {}) {
	const run = () =>
		sweep(store).then(
			(counts) => {
				if (counts.flows + counts.attempts + counts.links + counts.versions > 0) log(JSON.stringify({ event: "practice.retention", ...counts }));
			},
			() => errorLog("Practice retention failed; will retry"),
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
