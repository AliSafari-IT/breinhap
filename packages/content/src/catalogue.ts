import { z } from "zod";
import { LearningObject, SCHEMA_VERSION } from "./schema";

/**
 * The public mission catalogue the Android app downloads from breinhap.com.
 *
 * GET https://breinhap.com/p/missies.json answers
 *   { schemaVersion: 1, objects: [{ publishedAt: "YYYY-MM-DD", object: <delivery LearningObject> }] }
 * with only the objects an administrator listed whose current publication is active. A delivery
 * object is a LearningObject without `review` (and without authoring sources): the management site
 * publishes reviewed content only, so the app treats it as reviewed on the day it was published.
 *
 * Content is data and the network is not trusted: every object is validated on its own, and one
 * that does not fit this app's schema is skipped (refused, never crashed on).
 */

/** The most the app reads from one download; anything larger is refused whole. */
export const MAX_CATALOGUE_BYTES = 5_000_000;
export const MAX_CATALOGUE_OBJECTS = 200;

const DeliveryObject = LearningObject.omit({ review: true });
const Entry = z.object({
  publishedAt: z.iso.date(),
  object: z.unknown(),
});
const Envelope = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  objects: z.array(z.unknown()).max(MAX_CATALOGUE_OBJECTS),
});

export interface PublicCatalogue {
  objects: LearningObject[];
  /** Entries that did not fit this app's schema (e.g. made for a newer app version). */
  skipped: number;
}

/** Who checked public content, as the app shows it: the management site's review. */
export const PUBLIC_REVIEWER = "Breinhap";

/**
 * Parses the downloaded catalogue text. Throws `catalogue.invalid` when the envelope itself is
 * not a catalogue this app understands; skips (and counts) single objects that do not fit.
 */
export function parsePublicCatalogue(text: string): PublicCatalogue {
  if (text.length > MAX_CATALOGUE_BYTES) throw new Error("catalogue.too_large");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("catalogue.invalid");
  }
  const envelope = Envelope.safeParse(json);
  if (!envelope.success) throw new Error("catalogue.invalid");

  const objects: LearningObject[] = [];
  const objectIds = new Set<string>();
  const missionIds = new Set<string>();
  let skipped = 0;
  for (const raw of envelope.data.objects) {
    const entry = Entry.safeParse(raw);
    const object = entry.success ? DeliveryObject.safeParse(entry.data.object) : undefined;
    if (!entry.success || !object?.success) {
      skipped++;
      continue;
    }
    const ids = object.data.missions.map((m) => m.id);
    // a mission id is the key of a paused mission on the device, so it must be unique
    if (objectIds.has(object.data.id) || new Set(ids).size !== ids.length || ids.some((id) => missionIds.has(id))) {
      skipped++;
      continue;
    }
    objectIds.add(object.data.id);
    for (const id of ids) missionIds.add(id);
    objects.push({
      ...object.data,
      review: { status: "reviewed", reviewedBy: PUBLIC_REVIEWER, reviewedAt: entry.data.publishedAt },
    });
  }
  return { objects, skipped };
}

/**
 * The content this app shows: the bundled objects plus the downloaded public ones. A downloaded
 * object with the same id as a bundled one replaces it (it is the newer, published release). A
 * downloaded object that reuses a mission id of another object is left out, so a paused mission
 * can never resume inside different content.
 */
export function mergeContent(
  bundled: readonly LearningObject[],
  downloaded: readonly LearningObject[],
): LearningObject[] {
  const replaced = new Set(downloaded.map((o) => o.id));
  const result = bundled.filter((o) => !replaced.has(o.id));
  const missionIds = new Set(result.flatMap((o) => o.missions.map((m) => m.id)));
  for (const object of downloaded) {
    if (object.missions.some((m) => missionIds.has(m.id))) continue;
    for (const m of object.missions) missionIds.add(m.id);
    result.push(object);
  }
  return result;
}
