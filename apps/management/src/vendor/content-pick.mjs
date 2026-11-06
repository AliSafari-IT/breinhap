// GENERATED from packages/content/src/pick.ts by apps/management/scripts/vendor-content.mjs.
// Do not edit: change it there, then run the script (breinhap#26, #28).
/**
 * "Ik heb __ minuten": pick the single best next mission.
 *
 * Deterministic on purpose: no AI decides what a student learns next
 * (AI Act Annex III). Order of preference:
 * 1. fits in the available minutes,
 * 2. not done today,
 * 3. subject the student has soonest,
 * 4. the longest mission that still fits (uses the time they offered),
 * 5. stable content order.
 */
export function pickMission(objects, availableMinutes, options = {}) {
    const priority = options.prioritySubjects ?? [];
    const done = options.doneToday ?? new Set();
    const candidates = [];
    let order = 0;
    for (const object of objects) {
        if (object.review.status !== "reviewed" && !options.includeDrafts)
            continue;
        for (const mission of object.missions) {
            if (mission.minutes <= availableMinutes) {
                candidates.push({ object, mission, order: order++ });
            }
        }
    }
    const rank = (subject) => {
        const index = priority.indexOf(subject);
        return index === -1 ? priority.length : index;
    };
    candidates.sort((a, b) => Number(done.has(a.mission.id)) - Number(done.has(b.mission.id)) ||
        rank(a.object.subject) - rank(b.object.subject) ||
        b.mission.minutes - a.mission.minutes ||
        a.order - b.order);
    const best = candidates[0];
    return best && { object: best.object, mission: best.mission };
}
/** True when the student's order matches the stored (correct) order. */
export function isCorrectOrder(correct, answer) {
    return correct.length === answer.length && correct.every((item, i) => item === answer[i]);
}
/**
 * Shuffle for display, never returning the correct order (that would make
 * an order question trivially "solved" on screen). Deterministic for a seed.
 */
export function shuffleForDisplay(items, seed) {
    if (items.length < 2)
        return [...items];
    let state = seed >>> 0 || 1;
    const next = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 0x100000000;
    };
    const result = [...items];
    for (let attempt = 0; attempt < 8; attempt++) {
        for (let i = result.length - 1; i > 0; i--) {
            const j = Math.floor(next() * (i + 1));
            [result[i], result[j]] = [result[j], result[i]];
        }
        if (result.some((item, i) => item !== items[i]))
            return result;
    }
    // Fall back to a rotation, which always differs for 2+ distinct items.
    return [...items.slice(1), items[0]];
}
