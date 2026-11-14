import { describe, expect, test } from "vitest";
import { findClip, narrationKey, narrationText, NARRATION_KEY_VERSION, sha256Hex, type NarrationManifest } from "./narration";

describe("narration", () => {
  test("sha256 matches known digests, including accents, emoji and block boundaries", () => {
    const vectors: [string, string][] = [
      ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
      ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
      ["Één café, één ü — 😀", "42e2980ce324c038fab81cf396dc803497e3d9703e70826b1d335874de578ebd"],
      ["x".repeat(55), "d5e285683cd4efc02d021a5c62014694958901005d6f71e89e0989fac77e4072"],
      ["y".repeat(56), "4877e564e5e36e367c7c8d59670774becd3350610b6df4c399c9fa9b66da5813"],
      ["z".repeat(64), "72996563049cc84daa2c3f31fd5c3d10770e69d6ebbb8da5b6d76db303dbae43"],
      ["q".repeat(1000), "2e6bba1f3cf48fe45fa1c56e25b47fb622dde50eba1e17e0a72464e32bf4ab41"],
    ];
    for (const [text, digest] of vectors) expect(sha256Hex(text)).toBe(digest);
  });

  test("the key ignores whitespace layout but not wording", () => {
    expect(narrationKey("Een  kapitaal\ngroeit. ")).toBe(narrationKey("Een kapitaal groeit."));
    expect(narrationKey("Een kapitaal groeit.")).not.toBe(narrationKey("Een kapitaal groeit!"));
    expect(narrationKey("x")).toMatch(/^[0-9a-f]{16}$/);
  });

  test("narration text is the card text, then the example", () => {
    expect(narrationText({ text: "Regel.", example: "Voorbeeld." })).toBe("Regel. Voorbeeld.");
    expect(narrationText({ text: "Regel." })).toBe("Regel.");
  });

  test("a clip is found only for the exact text and the current key version", () => {
    const manifest: NarrationManifest = {
      keyVersion: NARRATION_KEY_VERSION,
      narrators: {
        vrouw: { provider: "elevenlabs", voiceId: "v", voiceName: "V", model: "m", format: "mp3", clips: { [narrationKey("Hallo.")]: "a.mp3" } },
      },
    };
    expect(findClip(manifest, "vrouw", "Hallo.")).toBe("a.mp3");
    expect(findClip(manifest, "vrouw", "Hallo!")).toBeUndefined();
    expect(findClip(manifest, "man", "Hallo.")).toBeUndefined();
    expect(findClip({ ...manifest, keyVersion: 0 }, "vrouw", "Hallo.")).toBeUndefined();
    expect(findClip(null, "vrouw", "Hallo.")).toBeUndefined();
  });
});
