import { describe, expect, it } from "vitest";
import committedData from "../../../apps/web/src/example-data.js?raw";
import player from "../../../apps/web/src/example.js?raw";
import { missionPages } from "./mission";
import { pickMission } from "./pick";
import { SCHOOLS, STUDIERICHTINGEN, YEARS, coursesFor, richtingenFor } from "./schools";
import { samplePack } from "./samples";
import { reviewedObjects, webData, webDataSource } from "./web-example";

/** Runs the website's classic scripts the way a page does, with `globalThis` being a plain object. */
function loadWebsite() {
  const sandbox: Record<string, any> = {};
  new Function("globalThis", committedData)(sandbox);
  new Function("globalThis", player)(sandbox);
  return { data: sandbox.BreinhapData, logic: sandbox.BreinhapExample.logic(sandbox.BreinhapData) };
}

describe("website: Try Breinhap on the home page", () => {
  it("embeds the committed copy of the catalogue and reviewed missions (regenerate: pnpm --filter @breinhap/content exec tsx scripts/web-example.ts)", () => {
    expect(committedData).toBe(webDataSource());
  });

  it("carries only reviewed missions and no review data", () => {
    const { objects } = webData();
    expect(objects.length).toBeGreaterThan(0);
    expect(committedData).not.toMatch(/reviewedBy|reviewedAt|"review"/);
    expect(objects.map((o) => o.id)).toEqual(reviewedObjects().map((o) => o.id));
    expect(objects.length).toBe(samplePack.objects.filter((o) => o.review.status === "reviewed").length);
    for (const object of objects) {
      const steps = object.missions.flatMap((m) => missionPages(m).map((p) => p.step));
      expect([...new Set(steps)]).toEqual(["Opwarmen", "Leren", "Doen", "Check"]);
    }
  });

  it("offers the same richtingen, vakken and missions as the Android app for every profile and time", () => {
    const { logic } = loadWebsite();
    const reviewed = reviewedObjects();
    const schoolIds = [null, ...SCHOOLS.map((s) => s.id)];
    for (const schoolId of schoolIds) {
      for (const year of YEARS) {
        expect(logic.richtingenFor(schoolId, year).map((r: { id: string }) => r.id)).toEqual(richtingenFor(schoolId, year).map((r) => r.id));
        for (const richtingId of [null, ...STUDIERICHTINGEN.map((r) => r.id)]) {
          const profile = { schoolId, year, richtingId };
          const web = logic.coursesFor(profile);
          const app = coursesFor(profile, reviewed);
          expect(web.map((c: any) => [c.course.id, c.objects.map((o: any) => o.id)])).toEqual(app.map((c) => [c.course.id, c.objects.map((o) => o.id)]));
          for (const [i, course] of app.entries()) {
            for (const minutes of [2, 5, 10, 15]) {
              const a = pickMission(course.objects, minutes);
              const w = logic.pickMission(web[i].objects, minutes);
              expect(w?.mission.id).toBe(a?.mission.id);
            }
          }
        }
      }
    }
  });
});
