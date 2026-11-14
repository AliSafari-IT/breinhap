import { describe, expect, it } from "vitest";
import { STUDIERICHTINGEN, YEARS, coursesFor, samplePack } from "./index";
import * as andereJaren from "./samples/andere-jaren";
import * as derdeGraad from "./samples/derde-graad-economie-wiskunde";

/**
 * Every year and every vak with a content subject in the picker has at least one bundled example,
 * so a student never lands on an empty Home just because samples were forgotten. Drafts count:
 * they show in preview builds and reach students once a person reviews them.
 */
describe("sample coverage", () => {
  it("every richting year has an example for every vak that has a content subject", () => {
    const missing: string[] = [];
    for (const richting of STUDIERICHTINGEN)
      for (const year of richting.years)
        for (const { course, objects } of coursesFor({ schoolId: null, year, richtingId: richting.id }, samplePack.objects))
          if (course.subject && objects.length === 0) missing.push(`${richting.label} ${year}: ${course.label}`);
    expect(missing).toEqual([]);
  });

  it("every school year has at least one example without a richting", () => {
    for (const year of YEARS) {
      const courses = coursesFor({ schoolId: null, year, richtingId: null }, samplePack.objects);
      expect(courses.length, `${year}de jaar`).toBeGreaterThan(0);
    }
  });

  it("the coverage samples carry their review, with unique mission ids", () => {
    const ids = samplePack.objects.flatMap((o) => o.missions.map((m) => m.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const object of [...Object.values(derdeGraad), ...Object.values(andereJaren)])
      expect(object.review, object.id).toEqual({ status: "reviewed", reviewedBy: "Ali Safari", reviewedAt: "2026-11-14" });
  });
});
