import { describe, expect, it } from "vitest";
import {
  ContentPack,
  LearningObject,
  isCorrectOrder,
  pickMission,
  samplePack,
  shuffleForDisplay,
} from "./index";
import { biologiePrikkelReactie } from "./samples/biologie-prikkel-reactie";

const reviewed = (object: LearningObject): LearningObject => ({
  ...object,
  review: { status: "reviewed", reviewedBy: "test", reviewedAt: "2026-10-23" },
});

describe("schema", () => {
  it("accepts the sample pack", () => {
    expect(samplePack.objects).toHaveLength(2);
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

  it("rejects duplicate mission ids in a pack", () => {
    const result = ContentPack.safeParse({
      schemaVersion: 1,
      id: "dup",
      version: 1,
      objects: [biologiePrikkelReactie, biologiePrikkelReactie],
    });
    expect(result.success).toBe(false);
  });

  it("requires a reviewer on reviewed content", () => {
    const broken = { ...biologiePrikkelReactie, review: { status: "reviewed" } };
    expect(LearningObject.safeParse(broken).success).toBe(false);
  });
});

describe("pickMission", () => {
  const objects = samplePack.objects.map(reviewed);

  it("never shows drafts unless asked", () => {
    expect(pickMission(samplePack.objects, 10)).toBeUndefined();
    expect(pickMission(samplePack.objects, 10, { includeDrafts: true })).toBeDefined();
  });

  it("only picks missions that fit the time", () => {
    expect(pickMission(objects, 2)).toBeUndefined();
    expect(pickMission(objects, 3)?.mission.id).toBe("bio-tropie-nastie");
  });

  it("uses the time offered: the longest mission that fits", () => {
    expect(pickMission(objects, 10)?.mission.id).toBe("wis-kwadraat-van-een-som");
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
