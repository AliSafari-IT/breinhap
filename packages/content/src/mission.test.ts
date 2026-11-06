import { describe, expect, test } from "vitest";
import {
  assertSupported,
  isCorrect,
  LearningObject,
  missionPages,
  samplePack,
  scoreAnswers,
  scoreSentence,
  shuffleForDisplay,
  studentPayload,
  UnsupportedSchemaVersion,
} from "./index";
import parity from "../fixtures/mission-parity.json" with { type: "json" };

const fixture: any = parity;
const object = LearningObject.parse(fixture.object);
const mission = object.missions[0]!;
const pages = missionPages(mission);

describe("the parity fixture (breinhap#28)", () => {
  test("pages follow Opwarmen → Leren → Doen → Check", () => {
    expect(pages.map((p) => `${p.step}:${p.kind}`)).toEqual(fixture.pages);
  });
  for (const c of fixture.cases)
    test(`score: ${c.name}`, () => {
      expect(scoreAnswers(pages, c.answers)).toBe(c.score);
      expect(scoreSentence(scoreAnswers(pages, c.answers), mission.practice.length + mission.check.length)).toBe(c.sentence);
    });
  test("order questions are shown in the pinned display order", () => {
    for (const s of fixture.shuffles) expect(shuffleForDisplay(s.items, s.seed)).toEqual(s.shown);
  });
});

test("isCorrect follows the answer key only", () => {
  const choice = mission.practice[0]!;
  expect(isCorrect(choice, { kind: "choice", chosen: 1 })).toBe(true);
  expect(isCorrect(choice, { kind: "choice", chosen: 0 })).toBe(false);
  expect(isCorrect(choice, { kind: "order", placed: [], checked: true })).toBe(false);
  expect(isCorrect(choice, null)).toBe(false);
});

test("the student payload keeps answer keys and explanations, and drops review metadata and unknown fields", () => {
  const extra = structuredClone(fixture.object);
  extra.missions[0].notes = "private author note";
  extra.missions[0].practice[0].authorNote = "private";
  const payload = studentPayload({ ...LearningObject.parse(extra), sources: ["x"] } as never);
  const text = JSON.stringify(payload);
  for (const key of fixture.studentPayloadOmits) expect(payload).not.toHaveProperty(key);
  expect(text).not.toContain("Een begeleider");
  expect(text).not.toContain("private");
  expect(payload.missions[0]!.practice[0]).toMatchObject({ answerIndex: 1, explanation: expect.any(String) });
  expect(payload.missions[0]!.practice[1]).toMatchObject({ items: ["Prikkel", "Receptor", "Zenuw", "Reactie"] });
  // every sample still survives the trip
  for (const o of samplePack.objects) expect(studentPayload(o).missions.length).toBe(o.missions.length);
});

test("unknown schema versions are refused clearly", () => {
  expect(() => assertSupported({ schemaVersion: 1 })).not.toThrow();
  expect(() => assertSupported({ schemaVersion: 2 })).toThrow(UnsupportedSchemaVersion);
  expect(() => assertSupported({})).toThrow(/unsupported schema version: undefined/);
});
