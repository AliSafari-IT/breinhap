/**
 * Writes apps/web/src/example-data.js: the school catalogue and reviewed missions that breinhap.com's home page
 * plays, like the Android app. src/web-example.test.ts fails while the committed file differs from a fresh copy.
 *
 *   pnpm --filter @breinhap/content exec tsx scripts/web-example.ts
 */
import { writeFileSync } from "node:fs";
import { webDataSource } from "../src/web-example";

export const TARGET = new URL("../../../apps/web/src/example-data.js", import.meta.url);

writeFileSync(TARGET, webDataSource());
console.log(`Wrote ${TARGET.pathname}`);
