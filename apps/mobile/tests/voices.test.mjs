import assert from "node:assert/strict";
import { test } from "node:test";
import { RATE, dutchVoices, speechOptions, voiceGender, voiceLabels } from "../src/speech/voices.ts";

const v = (identifier, language, quality = "Default") => ({ identifier, name: identifier, language, quality });
const device = [
  v("en-us-x-sfg-local", "en-US"),
  v("nl-nl-x-bmh-local", "nl-NL"),
  v("nl-be-x-bed-network", "nl-BE", "Enhanced"),
  v("nl-be-x-bec-local", "nl-BE"),
  v("nl-be-x-bed-local", "nl-BE", "Enhanced"),
  v("nl-nl-x-tfb-local", "nl-NL"),
  v("nl-NL-SMTf00", "nl_NL"),
  v("mystery-voice", "nl-NL"),
];

test("only Dutch on-device voices, Flemish and better quality first", () => {
  assert.deepEqual(
    dutchVoices(device).map((x) => x.identifier),
    ["nl-be-x-bed-local", "nl-be-x-bec-local", "mystery-voice", "nl-NL-SMTf00", "nl-nl-x-bmh-local", "nl-nl-x-tfb-local"],
  );
  assert.ok(!dutchVoices(device).some((x) => /network/.test(x.identifier)), "network voices send text away");
});

test("gender is known only for engine voices we recognise", () => {
  assert.equal(voiceGender(v("nl-be-x-bec-local", "nl-BE")), "vrouw");
  assert.equal(voiceGender(v("nl-be-x-bed-local", "nl-BE")), "man");
  assert.equal(voiceGender(v("nl-NL-SMTm00", "nl-NL")), "man");
  assert.equal(voiceGender(v("mystery-voice", "nl-NL")), undefined);
});

test("labels say man/vrouw, language and quality, numbered when there are several", () => {
  const labels = voiceLabels(dutchVoices(device));
  assert.equal(labels.get("nl-be-x-bed-local"), "Man 1 · Vlaams · beter");
  assert.equal(labels.get("nl-be-x-bec-local"), "Vrouw 1 · Vlaams");
  assert.equal(labels.get("nl-nl-x-bmh-local"), "Man 2 · Nederlands");
  assert.equal(labels.get("mystery-voice"), "Stem 1 · Nederlands");
  assert.equal(labels.get("nl-NL-SMTf00"), "Vrouw 2 · Nederlands");
  assert.equal(labels.get("nl-nl-x-tfb-local"), "Vrouw 3 · Nederlands");
});

test("the chosen voice is used; a missing one falls back to the best, none to the engine default", () => {
  assert.deepEqual(speechOptions(device, { voiceId: "nl-be-x-bec-local", tempo: "normaal" }), {
    language: "nl-BE",
    voice: "nl-be-x-bec-local",
    rate: 1,
  });
  assert.equal(speechOptions(device, { voiceId: "uninstalled", tempo: "rustig" }).voice, "nl-be-x-bed-local");
  assert.equal(speechOptions(device, { voiceId: null, tempo: "rustig" }).rate, RATE.rustig);
  assert.deepEqual(speechOptions([v("en-us-x", "en-US")], { voiceId: null, tempo: "rustig" }), { language: "nl-BE", rate: RATE.rustig });
  // a network voice is never used, even when it was chosen
  assert.equal(speechOptions(device, { voiceId: "nl-be-x-bed-network", tempo: "rustig" }).voice, "nl-be-x-bed-local");
});
