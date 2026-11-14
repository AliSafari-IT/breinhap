// Recorded read-aloud on breinhap.com (prototype): only installed clips for the exact text are
// offered and served, and without clips the page still offers the browser's own voice.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { createLearnerHandler } from "../src/learner-server.mjs";
import { loadNarration } from "../src/learner/narration.mjs";
import { runStep } from "../src/learner/public-missions.mjs";
import { narrationKey, narrationText } from "../src/vendor/content-narration.mjs";

// a minimal valid public object (no database)
function samplePack() {
	return {
		id: "test-object",
		title: "Test",
		missions: [
			{
				id: "m1",
				title: "Missie",
				minutes: 3,
				warmup: { text: "Een plant staat op de vensterbank.", example: "Het licht komt van één kant." },
				learn: [{ text: "Een prikkel is een verandering." }],
				practice: [{ kind: "choice", prompt: "Wat?", options: ["a", "b"], answerIndex: 0, explanation: "Omdat." }],
				check: [{ kind: "choice", prompt: "Wat?", options: ["a", "b"], answerIndex: 0, explanation: "Omdat." }],
				commonMistakes: [],
			},
		],
	};
}

const object = samplePack();
const card = object.missions[0].warmup;
const key = narrationKey(narrationText(card));
let narration;
let server;
let base;

before(async () => {
	const dir = await mkdtemp(join(tmpdir(), "bh-narration-"));
	await mkdir(join(dir, "vrouw"));
	await writeFile(join(dir, "vrouw", `${key}.mp3`), "ID3clip");
	await writeFile(join(dir, "vrouw", "0000000000000000.mp3"), "not in the manifest");
	await writeFile(
		join(dir, "manifest.json"),
		JSON.stringify({ keyVersion: 1, narrators: { vrouw: { provider: "elevenlabs", voiceId: "v", voiceName: "V", model: "m", format: "mp3_44100_64", clips: { [key]: `${key}.mp3` } } } }),
	);
	narration = await loadNarration(pathToFileURL(`${dir}/`));
	const handler = createLearnerHandler({ learner: null, catalog: null, budget: null, narration });
	server = createServer((req, res) => {
		req.headers.host = "breinhap.com";
		handler(req, res);
	});
	await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
	base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("a card with a clip offers it; the text is always there for the browser's voice", () => {
	const html = runStep("nl", object, { missie: "0", stap: "0", a: "" }, narration);
	assert.match(html, new RegExp(`data-clip-vrouw="/p/audio/vrouw/${key}.mp3"`));
	assert.doesNotMatch(html, /data-clip-man=/);
	assert.match(html, /data-narration="[^"]+"/);
	assert.match(html, /<script src="\/p\/assets\/narration.js" defer><\/script>/);
	const none = runStep("nl", object, { missie: "0", stap: "0", a: "" }, null);
	assert.doesNotMatch(none, /data-clip-/);
	assert.match(none, /data-narration=/);
});

test("only manifest clips are served, as immutable audio, and the CSP allows same-origin media", async () => {
	const ok = await fetch(`${base}/p/audio/vrouw/${key}.mp3`);
	assert.equal(ok.status, 200);
	assert.equal(ok.headers.get("content-type"), "audio/mpeg");
	assert.match(ok.headers.get("cache-control"), /immutable/);
	assert.match(ok.headers.get("content-security-policy"), /media-src 'self'/);
	assert.equal(await ok.text(), "ID3clip");
	for (const path of ["/p/audio/vrouw/0000000000000000.mp3", `/p/audio/man/${key}.mp3`, "/p/audio/vrouw/..%2fmanifest.json", "/p/audio/vrouw/x.mp3"])
		assert.equal((await fetch(`${base}${path}`)).status, 404, path);
	assert.equal((await fetch(`${base}/p/assets/narration.js`)).status, 200);
});
