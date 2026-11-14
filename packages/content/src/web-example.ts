import { studentPayload } from "./mission";
import { samplePack } from "./samples";
import { SCHOOLS, STUDIERICHTINGEN, subjectLabel } from "./schools";
import type { LearningObject } from "./schema";

/**
 * The reviewed objects in a fixed order (by id). The sample pack's own order depends on how the bundler orders
 * module exports, so it differs between tools; the website file must not.
 */
export function reviewedObjects(): LearningObject[] {
  return samplePack.objects.filter((o: LearningObject) => o.review.status === "reviewed").sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * What breinhap.com's home page needs to play the same flow as the Android app (gemeente → school → jaar →
 * richting → vak → "Ik heb __ minuten" → mission): the school and richting catalogue and the reviewed
 * objects, as student payloads. The website cannot import this package (its image is built from apps/ only),
 * so apps/web/src/example-data.js is generated from this and src/web-example.test.ts fails while it drifts.
 * Only reviewed objects are included, and no review data, so unreviewed content cannot reach the website.
 */
export function webData() {
  const reviewed = reviewedObjects();
  return {
    schools: SCHOOLS,
    richtingen: STUDIERICHTINGEN,
    subjectLabel,
    objects: reviewed.map(studentPayload),
  };
}

/** The exact text of apps/web/src/example-data.js. */
export function webDataSource(): string {
  return `// Generated from packages/content by scripts/web-example.ts. Do not edit; run:\n//   pnpm --filter @breinhap/content exec tsx scripts/web-example.ts\nglobalThis.BreinhapData = ${JSON.stringify(webData(), null, 1)};\n`;
}
