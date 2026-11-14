import { describe, expect, it } from "vitest";
import { MAX_CATALOGUE_BYTES, PUBLIC_REVIEWER, mergeContent, parsePublicCatalogue, samplePack } from "./index";
import { biologiePrikkelReactie } from "./samples/biologie-prikkel-reactie";

/** A delivery object as the management site sends it: no review, no sources. */
function delivery(id: string, missionId = `${id}-m1`) {
  const { review: _review, ...rest } = structuredClone(biologiePrikkelReactie);
  return {
    ...rest,
    id,
    title: `Openbaar ${id}`,
    missions: [{ ...rest.missions[0]!, id: missionId }],
    sources: [{ kind: "own", title: "never shown" }],
  };
}
const catalogue = (objects: unknown[]) => JSON.stringify({ schemaVersion: 1, objects });

describe("parsePublicCatalogue", () => {
  it("reads listed objects as reviewed on their publication day and drops authoring fields", () => {
    const { objects, skipped } = parsePublicCatalogue(catalogue([{ publishedAt: "2026-11-12", object: delivery("pub-a") }]));
    expect(skipped).toBe(0);
    expect(objects).toHaveLength(1);
    expect(objects[0]?.review).toEqual({ status: "reviewed", reviewedBy: PUBLIC_REVIEWER, reviewedAt: "2026-11-12" });
    expect("sources" in objects[0]!).toBe(false);
  });

  it("skips objects that do not fit, without losing the rest", () => {
    const broken = delivery("pub-b");
    broken.missions[0]!.minutes = 60;
    const newer = { ...delivery("pub-c"), schemaVersion: 2 };
    const { objects, skipped } = parsePublicCatalogue(
      catalogue([
        { publishedAt: "2026-11-12", object: broken },
        { publishedAt: "2026-11-12", object: newer },
        { publishedAt: "not a date", object: delivery("pub-d") },
        { publishedAt: "2026-11-12", object: delivery("pub-e") },
        { publishedAt: "2026-11-12", object: delivery("pub-e", "other") },
        { publishedAt: "2026-11-12", object: delivery("pub-f", "pub-e-m1") },
      ]),
    );
    expect(objects.map((o) => o.id)).toEqual(["pub-e"]);
    expect(skipped).toBe(5);
  });

  it("refuses a body that is not a catalogue this app understands", () => {
    expect(() => parsePublicCatalogue("<html>")).toThrow("catalogue.invalid");
    expect(() => parsePublicCatalogue(JSON.stringify({ schemaVersion: 2, objects: [] }))).toThrow("catalogue.invalid");
    expect(() => parsePublicCatalogue(JSON.stringify({ objects: "x" }))).toThrow("catalogue.invalid");
    expect(() => parsePublicCatalogue(" ".repeat(MAX_CATALOGUE_BYTES + 1))).toThrow("catalogue.too_large");
    expect(parsePublicCatalogue(catalogue([])).objects).toEqual([]);
  });
});

describe("mergeContent", () => {
  const [pub] = parsePublicCatalogue(catalogue([{ publishedAt: "2026-11-12", object: delivery("pub-a") }])).objects;

  it("keeps every bundled sample and adds downloaded objects after them", () => {
    const merged = mergeContent(samplePack.objects, [pub!]);
    expect(merged.map((o) => o.id)).toEqual([...samplePack.objects.map((o) => o.id), "pub-a"]);
    expect(mergeContent(samplePack.objects, [])).toEqual(samplePack.objects);
  });

  it("a published release of a bundled object replaces it", () => {
    const [same] = parsePublicCatalogue(
      catalogue([{ publishedAt: "2026-11-12", object: delivery(biologiePrikkelReactie.id, biologiePrikkelReactie.missions[0]!.id) }]),
    ).objects;
    const merged = mergeContent(samplePack.objects, [same!]);
    expect(merged.filter((o) => o.id === biologiePrikkelReactie.id)).toEqual([same]);
  });

  it("leaves out a downloaded object that reuses another object's mission id", () => {
    const [clash] = parsePublicCatalogue(
      catalogue([{ publishedAt: "2026-11-12", object: delivery("pub-x", samplePack.objects[0]!.missions[0]!.id) }]),
    ).objects;
    expect(mergeContent(samplePack.objects, [clash!])).toEqual(samplePack.objects);
  });
});
