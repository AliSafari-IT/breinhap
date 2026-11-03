import type { Card, Mission, Question } from "@breinhap/content";
import type { Step } from "../components/StepBar";

export type Page = { step: Step; kind: "card"; card: Card } | { step: Step; kind: "question"; question: Question };
export type Answer = { kind: "choice"; chosen: number } | { kind: "order"; placed: string[]; checked: boolean };
export interface Progress {
  index: number;
  answers: Record<string, Answer>;
}

export function missionPages(mission: Mission): Page[] {
  return [
    { step: "Opwarmen", kind: "card", card: mission.warmup },
    ...mission.learn.map((card): Page => ({ step: "Leren", kind: "card", card })),
    ...mission.practice.map((question): Page => ({ step: "Doen", kind: "question", question })),
    ...mission.check.map((question): Page => ({ step: "Check", kind: "question", question })),
  ];
}

export const freshProgress = (): Progress => ({ index: 0, answers: {} });
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function validAnswer(question: Question, value: unknown): value is Answer {
  if (!object(value) || value.kind !== question.kind) return false;
  if (question.kind === "choice") {
    return Number.isInteger(value.chosen) && Number(value.chosen) >= 0 && Number(value.chosen) < question.options.length;
  }
  return (
    Array.isArray(value.placed) &&
    value.placed.every((item) => typeof item === "string" && question.items.includes(item)) &&
    new Set(value.placed).size === value.placed.length &&
    typeof value.checked === "boolean" &&
    (!value.checked || value.placed.length === question.items.length)
  );
}

export function answered(page: Page, answer: Answer | undefined): boolean {
  return page.kind === "card" || (!!answer && validAnswer(page.question, answer) && (answer.kind === "choice" || answer.checked));
}

export function updateAnswer(progress: Progress, pages: Page[], index: number, answer: Answer): Progress {
  const page = pages[index];
  if (
    progress.index !== index ||
    !page ||
    page.kind !== "question" ||
    !validAnswer(page.question, answer) ||
    answered(page, progress.answers[index])
  )
    return progress;
  return { ...progress, answers: { ...progress.answers, [index]: answer } };
}

export function advance(progress: Progress, pages: Page[], expectedIndex: number): Progress {
  const page = pages[progress.index];
  if (progress.index !== expectedIndex || !page || !answered(page, progress.answers[progress.index])) return progress;
  return { ...progress, index: progress.index + 1 };
}

export function score(progress: Progress, pages: Page[]): number {
  return pages.reduce((total, page, index) => {
    if (index >= progress.index || page.kind !== "question") return total;
    const answer = progress.answers[index];
    const correct =
      page.question.kind === "choice" && answer?.kind === "choice"
        ? answer.chosen === page.question.answerIndex
        : page.question.kind === "order" &&
          answer?.kind === "order" &&
          answer.checked &&
          page.question.items.every((item, i) => answer.placed[i] === item);
    return total + (correct ? 1 : 0);
  }, 0);
}

/** Exact content identity prevents reusing answers after questions or feedback change. */
export function encodeProgress(mission: Mission, progress: Progress): string | null {
  if (progress.index === missionPages(mission).length) return null;
  return JSON.stringify({ version: 1, missionId: mission.id, content: JSON.stringify(mission), progress });
}

export function decodeProgress(mission: Mission, raw: string): Progress | null {
  if (raw.length > 1_000_000) return null;
  try {
    const saved: unknown = JSON.parse(raw);
    if (
      !object(saved) ||
      saved.version !== 1 ||
      saved.missionId !== mission.id ||
      saved.content !== JSON.stringify(mission) ||
      !object(saved.progress)
    )
      return null;
    const { index, answers } = saved.progress;
    const pages = missionPages(mission);
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= pages.length || !object(answers)) return null;
    for (const [key, answer] of Object.entries(answers)) {
      const position = Number(key);
      const page = pages[position];
      if (
        String(position) !== key ||
        position < 0 ||
        position > index ||
        !page ||
        page.kind !== "question" ||
        !validAnswer(page.question, answer)
      )
        return null;
    }
    for (let i = 0; i < index; i++) {
      const page = pages[i];
      if (!page || !answered(page, answers[i] as Answer | undefined)) return null;
    }
    return { index, answers: answers as Record<string, Answer> };
  } catch {
    return null;
  }
}
