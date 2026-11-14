// Copies the shared learning-object code from packages/content into management as plain JavaScript,
// so the management image (built from apps/ only) validates and previews content with exactly the
// same rules as the app: the schema (breinhap#26), and the mission experience rules and display
// shuffle (breinhap#28). Run after any change to those files:
//
//   node apps/management/scripts/vendor-content.mjs
//
// test/content.test.mjs fails while a copy differs from a fresh transpile.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const FILES = [
	["schema.ts", "content-schema.mjs"],
	["pick.ts", "content-pick.mjs"],
	["mission.ts", "content-mission.mjs"],
	["narration.ts", "content-narration.mjs"],
].map(([from, to]) => ({
	source: new URL(`../../../packages/content/src/${from}`, import.meta.url),
	target: new URL(`../src/vendor/${to}`, import.meta.url),
	from,
}));
export const TARGET = FILES[0].target;
export const TARGETS = FILES.map((f) => f.target);

/** The transpiled files as [{ target, text }], or null when TypeScript is not installed (the image build). */
export async function renderAll() {
	let ts;
	try {
		ts = createRequire(FILES[0].source)("typescript");
	} catch {
		return null;
	}
	return Promise.all(
		FILES.map(async ({ source, target, from }) => {
			const { outputText } = ts.transpileModule(await readFile(source, "utf8"), {
				compilerOptions: {
					module: ts.ModuleKind.ESNext,
					target: ts.ScriptTarget.ES2022,
					removeComments: false,
					verbatimModuleSyntax: true,
				},
			});
			// only type imports cross these files, so a vendored copy never imports a sibling
			if (/^import (?!type)/m.test(outputText.replace(/^import \{ z \} from "zod";$/m, "")))
				throw new Error(`${from} gained a runtime import; vendor it explicitly`);
			const header =
				`// GENERATED from packages/content/src/${from} by apps/management/scripts/vendor-content.mjs.\n` +
				"// Do not edit: change it there, then run the script (breinhap#26, #28).\n";
			return { target, text: header + outputText };
		}),
	);
}

/** The vendored schema alone (kept for the #26 test). */
export async function render() {
	return (await renderAll())?.[0].text ?? null;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
	const output = await renderAll();
	if (!output) throw new Error("TypeScript is not installed: run pnpm install at the repository root");
	for (const { target, text } of output) {
		await writeFile(target, text);
		console.log("Wrote", target.pathname);
	}
}
