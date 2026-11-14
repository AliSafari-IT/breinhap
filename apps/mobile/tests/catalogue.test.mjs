import assert from "node:assert/strict";
import { test } from "node:test";
import { CatalogueError, createCatalogueStore } from "../src/catalogue/store.ts";

function memory() {
  const data = new Map();
  return {
    data,
    getItem: async (k) => (data.has(k) ? data.get(k) : null),
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
}
const parse = (text) => {
  const json = JSON.parse(text);
  if (json.schemaVersion !== 1) throw new Error("catalogue.invalid");
  return { objects: json.objects.map((e) => ({ ...e.object, review: { status: "reviewed" } })), skipped: 0 };
};
const body = JSON.stringify({ schemaVersion: 1, objects: [{ publishedAt: "2026-11-12", object: { id: "pub-a", missions: [] } }] });
const respond = (status, text) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => text });

test("nothing is on the device until a download, which is one plain GET without credentials", async () => {
  const storage = memory();
  const calls = [];
  const store = createCatalogueStore({
    storage,
    url: "https://breinhap.com/p/missies.json",
    parse,
    today: () => "2026-11-14",
    fetch: async (url, init) => {
      calls.push({ url, init });
      return respond(200, body)();
    },
  });
  assert.equal(await store.load(), null);
  assert.equal(calls.length, 0, "loading never goes online");
  const copy = await store.download();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://breinhap.com/p/missies.json");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.credentials, "omit");
  assert.deepEqual(Object.keys(calls[0].init.headers), ["Accept"]);
  assert.equal(copy.saved, true);
  assert.equal(copy.fetchedAt, "2026-11-14");
  assert.deepEqual(copy.objects.map((o) => o.id), ["pub-a"]);
  // works offline afterwards: the next start reads the copy from the device
  const again = await store.load();
  assert.deepEqual(again.objects.map((o) => o.id), ["pub-a"]);
  assert.equal(again.fetchedAt, "2026-11-14");
  await store.forget();
  assert.equal(await store.load(), null);
});

test("a failed or invalid download keeps the copy already on the device", async () => {
  const storage = memory();
  const ok = createCatalogueStore({ storage, url: "u", parse, fetch: respond(200, body) });
  await ok.download();
  const before = [...storage.data.values()];
  for (const [fetch, kind] of [
    [respond(404, "Not found"), "unavailable"],
    [respond(503, "{}"), "unavailable"],
    [async () => { throw new TypeError("Network request failed"); }, "offline"],
    [respond(200, "<html>"), "invalid"],
    [respond(200, JSON.stringify({ schemaVersion: 2, objects: [] })), "invalid"],
  ]) {
    const store = createCatalogueStore({ storage, url: "u", parse, fetch });
    await assert.rejects(store.download(), (e) => e instanceof CatalogueError && e.kind === kind);
    assert.deepEqual([...storage.data.values()], before, kind);
  }
});

test("a download that times out is reported as offline", async () => {
  const store = createCatalogueStore({
    storage: memory(),
    url: "u",
    parse,
    timeoutMs: 10,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))),
  });
  await assert.rejects(store.download(), (e) => e.kind === "offline");
});

test("an unreadable or outdated copy on the device is dropped, not trusted", async () => {
  for (const raw of ["not json", JSON.stringify({ fetchedAt: "x", text: body }), JSON.stringify({ fetchedAt: "2026-11-14", text: "{\"schemaVersion\":2}" })]) {
    const storage = memory();
    storage.data.set("breinhap.catalogue.v1", raw);
    const store = createCatalogueStore({ storage, url: "u", parse, fetch: respond(200, body) });
    assert.equal(await store.load(), null);
    assert.equal(storage.data.size, 0);
  }
});

test("when saving fails the download is still usable for this session", async () => {
  const storage = { ...memory(), setItem: async () => { throw new Error("disk full"); } };
  const store = createCatalogueStore({ storage, url: "u", parse, fetch: respond(200, body) });
  const copy = await store.download();
  assert.equal(copy.saved, false);
  assert.equal(copy.objects.length, 1);
});
