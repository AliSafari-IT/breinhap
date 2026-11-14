/**
 * Writes apps/web/src/example-mission.json: the one reviewed mission that breinhap.com's home page lets a
 * visitor try. The website cannot import this package (its image is built from apps/ only), so the student
 * payload is committed there, and src/web-example.test.ts fails while it differs from a fresh copy.
 *
 *   pnpm --filter @breinhap/content exec tsx scripts/web-example.ts
 */
import { writeFileSync } from "node:fs";
import { webExample } from "../src/web-example";

export const TARGET = new URL("../../../apps/web/src/example-mission.json", import.meta.url);

writeFileSync(TARGET, `${JSON.stringify(webExample(), null, 2)}\n`);
console.log(`Wrote ${TARGET.pathname}`);
