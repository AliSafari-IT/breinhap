import { describe, expect, it } from "vitest";
import { missionPages } from "./mission";
import { webExample } from "./web-example";
import committed from "../../../apps/web/src/example-mission.json" with { type: "json" };

describe("website example mission", () => {
  it("is the committed copy the website embeds (regenerate: pnpm --filter @breinhap/content exec tsx scripts/web-example.ts)", () => {
    expect(committed).toEqual(webExample());
  });
  it("carries no review data and follows the fixed four steps", () => {
    const example = webExample();
    expect(JSON.stringify(example)).not.toMatch(/review|reviewedBy/);
    const steps = missionPages(example.mission).map((p) => p.step);
    expect([...new Set(steps)]).toEqual(["Opwarmen", "Leren", "Doen", "Check"]);
  });
});
