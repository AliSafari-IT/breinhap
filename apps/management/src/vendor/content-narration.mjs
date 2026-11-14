// GENERATED from packages/content/src/narration.ts by apps/management/scripts/vendor-content.mjs.
// Do not edit: change it there, then run the script (breinhap#26, #28).
/**
 * Recorded narration (prototype): read-aloud audio made offline, before a release, so the app and
 * breinhap.com can play a natural voice without sending any text to a speech service at runtime.
 *
 * A clip is found by the hash of the exact text it speaks. When a card's text changes, its hash
 * changes, the old clip no longer matches, and the client falls back to the device voice until the
 * clip is generated again. A stale recording can never be played over new text.
 *
 * Pure code with no imports, so the Android app (Hermes), the management server (vendored) and the
 * generation script all compute the same key.
 */
/** Bump when the normalisation or the key below changes, so every clip is regenerated. */
export const NARRATION_KEY_VERSION = 1;
/** The narrators a student can choose. Each maps to one recorded voice in the manifest. */
export const NARRATORS = ["vrouw", "man"];
/** The sentence a voice preview speaks (Instellingen → Voorleesstem). Recorded too, so the preview is real. */
export const NARRATION_PREVIEW = "Hallo! Zo klink ik als ik een kaart voorlees.";
/** What gets read aloud for a learn card: the text, then the example. The same on every client. */
export function narrationText(card) {
    return [card.text, card.example].filter(Boolean).join(" ");
}
/** The text as it is hashed: Unicode NFC, whitespace runs collapsed, trimmed. */
export function normaliseNarration(text) {
    return text.normalize("NFC").replace(/\s+/g, " ").trim();
}
/** The clip key for a text: the first 16 hex digits of SHA-256 over the versioned, normalised text. */
export function narrationKey(text) {
    return sha256Hex(`breinhap-narration:${NARRATION_KEY_VERSION}\n${normaliseNarration(text)}`).slice(0, 16);
}
/** The clip file for a text and narrator, or undefined when there is none (use the device voice). */
export function findClip(manifest, narrator, text) {
    if (!manifest || manifest.keyVersion !== NARRATION_KEY_VERSION)
        return undefined;
    return manifest.narrators[narrator]?.clips[narrationKey(text)];
}
// SHA-256 (FIPS 180-4) over UTF-8, small and dependency-free: Hermes has no Web Crypto digest.
const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
function utf8(text) {
    const out = [];
    for (const ch of text) {
        const c = ch.codePointAt(0);
        if (c < 0x80)
            out.push(c);
        else if (c < 0x800)
            out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000)
            out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else
            out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
}
export function sha256Hex(text) {
    const bytes = utf8(text);
    const bitLength = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56)
        bytes.push(0);
    for (let i = 7; i >= 0; i--)
        bytes.push(i >= 4 ? 0 : (bitLength >>> (i * 8)) & 0xff);
    const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < bytes.length; off += 64) {
        for (let i = 0; i < 16; i++)
            w[i] = (bytes[off + 4 * i] << 24) | (bytes[off + 4 * i + 1] << 16) | (bytes[off + 4 * i + 2] << 8) | bytes[off + 4 * i + 3];
        for (let i = 16; i < 64; i++) {
            const a = w[i - 15];
            const b = w[i - 2];
            const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
            const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
            const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
            const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
            hh = g;
            g = f;
            f = e;
            e = (d + t1) | 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) | 0;
        }
        const next = [a, b, c, d, e, f, g, hh];
        for (let i = 0; i < 8; i++)
            h[i] = (h[i] + next[i]) | 0;
    }
    return h.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}
