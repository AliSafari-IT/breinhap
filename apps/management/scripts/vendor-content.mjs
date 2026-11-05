// Copies the shared learning-object schema (packages/content/src/schema.ts) into management as plain
// JavaScript, so the management image (built from apps/ only) validates content with exactly the same
// rules as the app. Run after any schema change:
//
//   node apps/management/scripts/vendor-content.mjs
//
// test/content-schema.test.mjs fails while the copy differs from a fresh transpile.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const SOURCE = new URL("../../../packages/content/src/schema.ts", import.meta.url);
export const TARGET = new URL("../src/vendor/content-schema.mjs", import.meta.url);
const HEADER =
	"// GENERATED from packages/content/src/schema.ts by apps/management/scripts/vendor-content.mjs.\n" +
	"// Do not edit: change the schema there, then run the script (breinhap#26).\n";

/** The transpiled schema, or null when TypeScript is not installed (the image build's npm install). */
export async function render() {
	let ts;
	try {
		ts = createRequire(SOURCE)("typescript");
	} catch {
		return null;
	}
	const { outputText } = ts.transpileModule(await readFile(SOURCE, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
			removeComments: false,
		},
	});
	return HEADER + outputText;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
	const output = await render();
	if (!output) throw new Error("TypeScript is not installed: run pnpm install at the repository root");
	await writeFile(TARGET, output);
	console.log("Wrote", TARGET.pathname);
}
