import { describe, expect, it } from "vitest";
import {
  SCHOOLS,
  STUDIERICHTINGEN,
  cities,
  coursesFor,
  parseProfile,
  richtingenFor,
  samplePack,
  schoolsIn,
  type LearningObject,
} from "./index";

const biologie = samplePack.objects.find((o) => o.subject === "biologie")!;
// A 5de-jaar wiskunde object; built by hand so the test does not depend on which samples ship.
const wiskunde5 = { ...biologie, id: "test-wiskunde-5", subject: "wiskunde", grade: 5 } as unknown as LearningObject;
const objects = [biologie, wiskunde5];

const herk = "sint-martinusscholen-herk-de-stad";

describe("catalogue", () => {
  it("has unique ids and only known richtingen", () => {
    const schoolIds = SCHOOLS.map((s) => s.id);
    expect(new Set(schoolIds).size).toBe(schoolIds.length);
    const richtingIds = new Set(STUDIERICHTINGEN.map((r) => r.id));
    expect(richtingIds.size).toBe(STUDIERICHTINGEN.length);
    for (const school of SCHOOLS) for (const id of school.richtingen) expect(richtingIds.has(id)).toBe(true);
    for (const richting of STUDIERICHTINGEN) {
      const courseIds = richting.courses.map((c) => c.id);
      expect(new Set(courseIds).size).toBe(courseIds.length);
    }
  });

  it("lists Sint-Martinusscholen in Herk-de-Stad with Economie-wiskunde in 5 and 6", () => {
    expect(cities().map((c) => c.name)).toContain("Herk-de-Stad");
    expect(schoolsIn("Herk-de-Stad").map((s) => s.id)).toEqual([herk]);
    expect(richtingenFor(herk, 5).map((r) => r.id)).toEqual(["economie-wiskunde"]);
    expect(richtingenFor(herk, 6).map((r) => r.id)).toEqual(["economie-wiskunde"]);
    expect(richtingenFor(herk, 3)).toEqual([]);
  });

  it("offers every richting for the year when the school is not listed", () => {
    expect(richtingenFor(null, 5).map((r) => r.id)).toContain("economie-wiskunde");
  });
});

describe("coursesFor", () => {
  it("gives the richting's vakken in order, with content only for the student's year", () => {
    const courses = coursesFor({ schoolId: herk, year: 5, richtingId: "economie-wiskunde" }, objects);
    expect(courses[0]?.course.label).toBe("Wiskunde");
    expect(courses[0]?.objects.map((o) => o.id)).toEqual(["test-wiskunde-5"]);
    expect(courses.filter((c) => c.objects.length > 0)).toHaveLength(1);
    expect(courses.find((c) => c.course.id === "godsdienst")?.objects).toEqual([]);
  });

  it("shows a 6de-jaar student no 5de-jaar content", () => {
    const courses = coursesFor({ schoolId: herk, year: 6, richtingId: "economie-wiskunde" }, objects);
    expect(courses.every((c) => c.objects.length === 0)).toBe(true);
  });

  it("falls back to every subject with content for the year", () => {
    const courses = coursesFor({ schoolId: null, year: 3, richtingId: null }, objects);
    expect(courses.map((c) => c.course.label)).toEqual(["Biologie"]);
  });
});

describe("parseProfile", () => {
  it("accepts a stored profile", () => {
    const profile = { schoolId: herk, year: 5, richtingId: "economie-wiskunde" };
    expect(parseProfile(profile)).toEqual(profile);
    expect(parseProfile({ schoolId: null, year: 3, richtingId: null })).toBeDefined();
  });

  it("refuses what no longer fits the catalogue", () => {
    expect(parseProfile(null)).toBeUndefined();
    expect(parseProfile({ schoolId: "gone", year: 5, richtingId: null })).toBeUndefined();
    expect(parseProfile({ schoolId: null, year: 7, richtingId: null })).toBeUndefined();
    expect(parseProfile({ schoolId: null, year: 5, richtingId: "gone" })).toBeUndefined();
  });
});
