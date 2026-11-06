// GENERATED from packages/content/src/mission.ts by apps/management/scripts/vendor-content.mjs.
// Do not edit: change it there, then run the script (breinhap#26, #28).
/**
 * The student mission experience as plain data and pure functions (breinhap#28): the pages of a
 * mission, which answers are valid, which are right, the score, and what a student payload may hold.
 * The Android app, the management preview and a later web client all follow these rules, and
 * `fixtures/mission-parity.json` pins them so every client can prove it scores the same way.
 *
 * Only type imports here, so this file runs as-is (and vendored) without a bundler.
 */
/** Every mission, always in this order. */
export const STEPS = ["Opwarmen", "Leren", "Doen", "Check"];
/** The schema versions a client of this code can show. Anything else is refused, never guessed at. */
export const SUPPORTED_SCHEMA_VERSIONS = [1];
/** One thing per screen: the warm-up, each learn card, each practice question, each check question. */
export function missionPages(mission) {
    return [
        { step: "Opwarmen", kind: "card", card: mission.warmup },
        ...mission.learn.map((card) => ({ step: "Leren", kind: "card", card })),
        ...mission.practice.map((question) => ({ step: "Doen", kind: "question", question })),
        ...mission.check.map((question) => ({ step: "Check", kind: "question", question })),
    ];
}
const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
/** An answer that fits the question: a real option, or each order item at most once. */
export function validAnswer(question, value) {
    if (!isRecord(value) || value.kind !== question.kind)
        return false;
    if (question.kind === "choice")
        return Number.isInteger(value.chosen) && Number(value.chosen) >= 0 && Number(value.chosen) < question.options.length;
    return (Array.isArray(value.placed) &&
        value.placed.every((item) => typeof item === "string" && question.items.includes(item)) &&
        new Set(value.placed).size === value.placed.length &&
        typeof value.checked === "boolean" &&
        (!value.checked || value.placed.length === question.items.length));
}
/** A finished answer: chosen, or every item placed and checked. Only those get feedback and count. */
export function isFinished(question, answer) {
    return validAnswer(question, answer) && (answer.kind === "choice" || answer.checked);
}
/** Deterministic: the stored answer key decides, never a model. */
export function isCorrect(question, answer) {
    if (!isFinished(question, answer))
        return false;
    if (question.kind === "choice")
        return answer.kind === "choice" && answer.chosen === question.answerIndex;
    return (answer.kind === "order" &&
        answer.placed.length === question.items.length &&
        question.items.every((item, i) => answer.placed[i] === item));
}
/** Correct answers on the question pages before `upTo` (the whole mission by default). */
export function scoreAnswers(pages, answers, upTo = pages.length) {
    let total = 0;
    pages.forEach((page, index) => {
        if (index < upTo && page.kind === "question" && isCorrect(page.question, answers[index]))
            total += 1;
    });
    return total;
}
/** The end-of-mission sentence, the same wherever a student finishes. */
export function scoreSentence(correct, questions) {
    return correct > 0
        ? `Je had ${correct} van de ${questions} vragen juist.`
        : `Je hebt ${questions} vragen geoefend. Lees de uitleg nog eens rustig na.`;
}
export class UnsupportedSchemaVersion extends Error {
    version;
    constructor(version) {
        super(`unsupported schema version: ${String(version)}`);
        this.version = version;
        this.name = "UnsupportedSchemaVersion";
    }
}
/** Refuses (does not crash on, does not guess at) content written for a schema this code does not know. */
export function assertSupported(value) {
    const version = isRecord(value) ? value.schemaVersion : undefined;
    if (typeof version !== "number" || !SUPPORTED_SCHEMA_VERSIONS.includes(version))
        throw new UnsupportedSchemaVersion(version);
}
/**
 * Copies, field by field, only what the student experience needs. Answer keys (`answerIndex`, the
 * order of `items`) and explanations stay: deterministic feedback needs them on the device. Review
 * metadata, sources and any field the schema does not name never reach a student.
 */
export function studentPayload(object) {
    const card = (c) => (c.example === undefined ? { text: c.text } : { text: c.text, example: c.example });
    const question = (q) => q.kind === "choice"
        ? { kind: "choice", prompt: q.prompt, options: [...q.options], answerIndex: q.answerIndex, explanation: q.explanation }
        : { kind: "order", prompt: q.prompt, items: [...q.items], explanation: q.explanation };
    return {
        schemaVersion: object.schemaVersion,
        id: object.id,
        subject: object.subject,
        title: object.title,
        grade: object.grade,
        curriculum: { leerdoel: object.curriculum.leerdoel, references: [...object.curriculum.references] },
        missions: object.missions.map((m) => ({
            id: m.id,
            title: m.title,
            minutes: m.minutes,
            warmup: card(m.warmup),
            learn: m.learn.map(card),
            practice: m.practice.map(question),
            check: m.check.map(question),
            commonMistakes: m.commonMistakes.map(({ mistake, why }) => ({ mistake, why })),
        })),
    };
}
