import type { LearningObjectInput, Subject } from "../schema";

type Q =
  | { choice: string; options: string[]; answer: number; why: string }
  | { order: string; items: string[]; why: string };

const question = (q: Q) =>
  "choice" in q
    ? { kind: "choice" as const, prompt: q.choice, options: q.options, answerIndex: q.answer, explanation: q.why }
    : { kind: "order" as const, prompt: q.order, items: q.items, explanation: q.why };

/**
 * A one-mission sample object in the house shape (Opwarmen → Leren → Doen → Check).
 * AI-assisted: `review` stays a draft unless a person reviewed it, in which case the caller
 * passes who and when (CLAUDE.md, "AI never grades or decides").
 */
export function sample(spec: {
  reviewed?: { by: string; at: string };
  id: string;
  subject: Subject;
  grade: number;
  title: string;
  leerdoel: string;
  mission: string;
  minutes: number;
  warmup: string;
  learn: Array<string | [string, string]>;
  practice: Q[];
  check: Q[];
  mistakes?: Array<[string, string]>;
}): LearningObjectInput {
  return {
    schemaVersion: 1,
    id: spec.id,
    subject: spec.subject,
    title: spec.title,
    grade: spec.grade,
    curriculum: { leerdoel: spec.leerdoel, references: [] },
    review: spec.reviewed ? { status: "reviewed", reviewedBy: spec.reviewed.by, reviewedAt: spec.reviewed.at } : { status: "draft" },
    missions: [
      {
        id: `${spec.id}-1`,
        title: spec.mission,
        minutes: spec.minutes,
        warmup: { text: spec.warmup },
        learn: spec.learn.map((card) => (typeof card === "string" ? { text: card } : { text: card[0], example: card[1] })),
        practice: spec.practice.map(question),
        check: spec.check.map(question),
        commonMistakes: (spec.mistakes ?? []).map(([mistake, why]) => ({ mistake, why })),
      },
    ],
  };
}
