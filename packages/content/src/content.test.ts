import { describe, expect, it } from "vitest";
import {
  ContentPack,
  LearningObject,
  isCorrectOrder,
  isCorrect,
  missionPages,
  pickMission,
  samplePack,
  shuffleForDisplay,
} from "./index";
import { biologiePrikkelReactie } from "./samples/biologie-prikkel-reactie";
import { wiskundeOntbindenInFactoren } from "./samples/wiskunde-ontbinden-in-factoren";
import { wiskundeSamengesteldeIntrest } from "./samples/wiskunde-samengestelde-intrest";

const reviewed = (object: LearningObject): LearningObject => ({
  ...object,
  review: { status: "reviewed", reviewedBy: "test", reviewedAt: "2026-10-23" },
});

describe("schema", () => {
  it("accepts the sample pack", () => {
    expect(samplePack.objects.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects a choice answer that points past the options", () => {
    const broken = structuredClone(biologiePrikkelReactie);
    const question = broken.missions[0]?.practice[1];
    if (question?.kind !== "choice") throw new Error("fixture changed");
    question.answerIndex = 9;
    expect(LearningObject.safeParse(broken).success).toBe(false);
  });

  it("rejects missions longer than 6 minutes", () => {
    const broken = structuredClone(biologiePrikkelReactie);
    broken.missions[0]!.minutes = 12;
    expect(LearningObject.safeParse(broken).success).toBe(false);
  });

  it("rejects repeated ordering items, including duplicates after trimming", () => {
    for (const items of [["prikkel", "prikkel"], ["prikkel", " prikkel "]]) {
      const broken = structuredClone(biologiePrikkelReactie);
      const question = broken.missions[0]?.practice.find((item) => item.kind === "order");
      if (!question || question.kind !== "order") throw new Error("fixture changed");
      question.items = items;
      expect(LearningObject.safeParse(broken).success).toBe(false);
    }
  });

  it("rejects duplicate mission ids in a pack", () => {
    const result = ContentPack.safeParse({
      schemaVersion: 1,
      id: "dup",
      version: 1,
      objects: [biologiePrikkelReactie, biologiePrikkelReactie],
    });
    expect(result.success).toBe(false);
  });

  it("only accepts secondary school years 1 to 6", () => {
    expect(LearningObject.safeParse({ ...biologiePrikkelReactie, grade: 5 }).success).toBe(true);
    expect(LearningObject.safeParse({ ...biologiePrikkelReactie, grade: 7 }).success).toBe(false);
  });

  it("keeps new samples as drafts until reviewed", () => {
    expect(LearningObject.parse(wiskundeSamengesteldeIntrest).review.status).toBe("draft");
  });

  it("requires a reviewer on reviewed content", () => {
    const broken = { ...biologiePrikkelReactie, review: { status: "reviewed" } };
    expect(LearningObject.safeParse(broken).success).toBe(false);
  });
});

describe("pickMission", () => {
  const objects = samplePack.objects.map(reviewed);

  it("never shows drafts unless asked", () => {
    const drafts = samplePack.objects.map((o) => ({ ...o, review: { status: "draft" as const } }));
    expect(pickMission(drafts, 10)).toBeUndefined();
    expect(pickMission(drafts, 10, { includeDrafts: true })).toBeDefined();
    expect(pickMission(samplePack.objects, 10)).toBeDefined();
  });

  it("only picks missions that fit the time", () => {
    expect(pickMission(objects, 2)).toBeUndefined();
    expect(pickMission(objects, 3)?.mission.id).toBe("bio-tropie-nastie");
  });

  it("uses the time offered: the longest mission that fits", () => {
    expect(pickMission(objects, 10)?.mission.id).toBe("wis-samengestelde-intrest");
  });

  it("prefers the subject the student has soonest", () => {
    const choice = pickMission(objects, 10, { prioritySubjects: ["biologie"] });
    expect(choice?.mission.id).toBe("bio-prikkel-reactie-volgorde");
  });

  it("prefers missions not done today", () => {
    const choice = pickMission(objects, 10, {
      prioritySubjects: ["biologie"],
      doneToday: new Set(["bio-prikkel-reactie-volgorde"]),
    });
    expect(choice?.mission.id).toBe("bio-tropie-nastie");
  });
});

describe("order questions", () => {
  const items = ["Prikkel", "Receptor", "Conductor", "Reactie"];

  it("checks the order exactly", () => {
    expect(isCorrectOrder(items, [...items])).toBe(true);
    expect(isCorrectOrder(items, ["Receptor", "Prikkel", "Conductor", "Reactie"])).toBe(false);
    expect(isCorrectOrder(items, items.slice(0, 3))).toBe(false);
  });

  it("never displays the solved order", () => {
    for (let seed = 0; seed < 200; seed++) {
      const shown = shuffleForDisplay(items, seed);
      expect(isCorrectOrder(items, shown)).toBe(false);
      expect([...shown].sort()).toEqual([...items].sort());
    }
    expect(isCorrectOrder(["a", "b"], shuffleForDisplay(["a", "b"], 1))).toBe(false);
  });

  it("is deterministic per seed", () => {
    expect(shuffleForDisplay(items, 42)).toEqual(shuffleForDisplay(items, 42));
  });
});

describe("factoring mission", () => {
  const object = LearningObject.parse(wiskundeOntbindenInFactoren);
  const mission = object.missions[0]!;

  it("is one four-minute grade-3 draft with no invented curriculum references", () => {
    expect(object.grade).toBe(3);
    expect(object.subject).toBe("wiskunde");
    expect(object.schemaVersion).toBe(1);
    expect(object.review).toEqual({ status: "draft" });
    expect(object.curriculum.references).toEqual([]);
    expect(object.missions).toHaveLength(1);
    expect(mission.id).toBe("wis-ontbinden-in-factoren");
    expect(mission.minutes).toBe(4);
    expect(mission.warmup.text).toBeTruthy();
    expect(mission.learn).toHaveLength(4);
    expect(mission.practice).toHaveLength(4);
    expect(mission.check).toHaveLength(2);
    expect(mission.commonMistakes).toHaveLength(4);
  });

  it("is playable in the four fixed steps and stays behind the draft gate", () => {
    expect(pickMission([object], 4)).toBeUndefined();
    expect(pickMission([object], 4, { includeDrafts: true })?.mission.id).toBe(mission.id);
    expect(missionPages(mission).map((page) => page.step)).toEqual([
      "Opwarmen", "Leren", "Leren", "Leren", "Leren", "Doen", "Doen", "Doen", "Doen", "Check", "Check",
    ]);
    const routine = mission.practice[2]!;
    if (routine.kind !== "order") throw new Error("expected factoring routine");
    expect(new Set(routine.items).size).toBe(4);
    expect(isCorrect(routine, { kind: "order", placed: routine.items, checked: true })).toBe(true);
    expect(isCorrect(routine, { kind: "order", placed: [...routine.items].reverse(), checked: true })).toBe(false);
  });

  it("keys the corrected expressions and the fully factored result explicitly", () => {
    const choices = [...mission.practice, ...mission.check].filter((q) => q.kind === "choice");
    expect(choices.map((q) => q.options[q.answerIndex])).toEqual([
      "7x²y³(3x³ + y⁴)", "(5x³ + 4)(5x³ − 4)", "(7x − 1)²", "(3a + 2b)(3a − 2b)", "2(x − 2)(x + 2)",
    ]);
    expect(mission.practice[0]!.prompt).toContain("21x⁵y³ + 7x²y⁷");
    expect(mission.check[1]!.prompt).toContain("2x² − 8");
    expect(mission.check[1]!.explanation).toContain("4x² − 16");
  });
});
