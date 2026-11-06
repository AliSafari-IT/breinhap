// breinhap#30: import files for the tests (no test runs here).
import { readFile } from "node:fs/promises";

import { TEMPLATE } from "../src/imports/routes.mjs";

export const parity = JSON.parse(await readFile(new URL("../../../packages/content/fixtures/mission-parity.json", import.meta.url), "utf8"));
export const packOf = (...objects) => JSON.stringify({ schemaVersion: 1, id: "pakket", version: 1, objects });
export const objectNamed = (id, overrides = {}) => ({
	...structuredClone(parity.object),
	id,
	missions: parity.object.missions.map((m, i) => ({ ...structuredClone(m), id: `${id}-m${i + 1}` })),
	...overrides,
});
export const csvRows = (...rows) => [TEMPLATE.split("\r\n")[0], ...rows].join("\r\n");
