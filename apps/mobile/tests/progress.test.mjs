import assert from "node:assert/strict";
import { test } from "node:test";
import { advance, decodeProgress, encodeProgress, freshProgress, missionPages, score, updateAnswer } from "../src/progress/model.ts";
import { createProgressStorage } from "../src/progress/storage.ts";

const mission = {
  id: "demo",
  title: "Een rustige missie",
  minutes: 5,
  warmup: { text: "Opwarmen" },
  learn: [{ text: "Leren" }],
  practice: [{ kind: "choice", prompt: "Kies", options: ["A", "B"], answerIndex: 1, explanation: "Waarom B" }],
  check: [{ kind: "order", prompt: "Orden", items: ["Eerst", "Daarna"], explanation: "Deze volgorde" }],
  commonMistakes: [],
};
const pages = missionPages(mission);
const question = () => advance(advance(freshProgress(), pages, 0), pages, 1);
const choice = (chosen = 1) => updateAnswer(question(), pages, 2, { kind: "choice", chosen });
const order = () => advance(choice(), pages, 2);
const roundTrip = (progress) => decodeProgress(mission, encodeProgress(mission, progress));

test("a process reload restores the exact step and selected answer data", () => {
  const progress = choice();
  assert.deepEqual(roundTrip(progress), progress);
  assert.equal(score(progress, pages), 0);
  assert.equal(score(advance(roundTrip(progress), pages, 2), pages), 1);
});

test("partial and checked ordering answers survive a reload", () => {
  const partial = updateAnswer(order(), pages, 3, { kind: "order", placed: ["Daarna"], checked: false });
  assert.deepEqual(roundTrip(partial), partial);
  assert.equal(advance(partial, pages, 3), partial);
  const checked = updateAnswer(partial, pages, 3, { kind: "order", placed: ["Daarna", "Eerst"], checked: true });
  assert.deepEqual(roundTrip(checked), checked);
  assert.equal(score(advance(checked, pages, 3), pages), 1);
});

test("score is derived from answers, and repeated taps cannot skip steps or count twice", () => {
  const answered = choice();
  const next = advance(answered, pages, 2);
  assert.equal(advance(next, pages, 2), next);
  assert.equal(updateAnswer(answered, pages, 2, { kind: "choice", chosen: 0 }), answered);
  assert.equal(score(next, pages), 1);
  const checked = updateAnswer(next, pages, 3, { kind: "order", placed: ["Eerst", "Daarna"], checked: true });
  const complete = advance(checked, pages, 3);
  assert.equal(score(complete, pages), 2);
  assert.equal(encodeProgress(mission, complete), null);
  assert.equal(advance(complete, pages, 3), complete);
});

test("unanswered questions and invalid answer updates cannot advance", () => {
  const progress = question();
  assert.equal(advance(progress, pages, 2), progress);
  assert.equal(updateAnswer(progress, pages, 2, { kind: "choice", chosen: 20 }), progress);
  assert.equal(updateAnswer(progress, pages, 1, { kind: "choice", chosen: 1 }), progress);
  assert.equal(updateAnswer(progress, pages, 2, { kind: "order", placed: [], checked: false }), progress);
});

for (const [label, mutate] of [
  [
    "another mission",
    (v) => {
      v.missionId = "other";
    },
  ],
  [
    "unsupported version",
    (v) => {
      v.version = 2;
    },
  ],
  [
    "negative page",
    (v) => {
      v.progress.index = -1;
    },
  ],
  [
    "fractional page",
    (v) => {
      v.progress.index = 1.5;
    },
  ],
  [
    "out-of-range page",
    (v) => {
      v.progress.index = 100;
    },
  ],
  [
    "completed checkpoint",
    (v) => {
      v.progress.index = pages.length;
    },
  ],
  [
    "unknown choice",
    (v) => {
      v.progress.answers[2].chosen = 90;
    },
  ],
  [
    "missing completed answer",
    (v) => {
      v.progress.index = 3;
      v.progress.answers = {};
    },
  ],
  [
    "future answer",
    (v) => {
      v.progress.answers[3] = { kind: "order", placed: [], checked: false };
    },
  ],
  [
    "answer on a card",
    (v) => {
      v.progress.answers[0] = v.progress.answers[2];
    },
  ],
  [
    "duplicate ordered items",
    (v) => {
      v.progress.index = 3;
      v.progress.answers[3] = { kind: "order", placed: ["Eerst", "Eerst"], checked: true };
    },
  ],
  [
    "unknown ordered item",
    (v) => {
      v.progress.index = 3;
      v.progress.answers[3] = { kind: "order", placed: ["Privé"], checked: false };
    },
  ],
  [
    "incomplete checked order",
    (v) => {
      v.progress.index = 3;
      v.progress.answers[3] = { kind: "order", placed: ["Eerst"], checked: true };
    },
  ],
]) {
  test(`rejects ${label}`, () => {
    const value = JSON.parse(encodeProgress(mission, choice()));
    mutate(value);
    assert.equal(decodeProgress(mission, JSON.stringify(value)), null);
  });
}

test("corrupt, wrong-shaped and oversized checkpoints are safely rejected", () => {
  for (const raw of ["{", "null", "[]", "{}", "x".repeat(1_000_001)]) assert.equal(decodeProgress(mission, raw), null);
});

test("changed question, answer key or feedback invalidates the old checkpoint", () => {
  const raw = encodeProgress(mission, choice());
  for (const patch of [{ prompt: "Anders" }, { answerIndex: 0 }, { explanation: "Nieuwe uitleg" }]) {
    const changed = structuredClone(mission);
    Object.assign(changed.practice[0], patch);
    assert.equal(decodeProgress(changed, raw), null);
  }
});

function memoryStorage() {
  const values = new Map();
  return {
    values,
    async getAllKeys() {
      return [...values.keys()];
    },
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
    async removeItem(key) {
      values.delete(key);
    },
  };
}

test("a new storage/session instance restores the persisted state", async () => {
  const disk = memoryStorage();
  await createProgressStorage(disk).save(mission, choice());
  assert.deepEqual(await createProgressStorage(disk).load(mission), { progress: choice(), discarded: false });
});

test("completion and restart clear only this mission's checkpoint", async () => {
  const disk = memoryStorage();
  const store = createProgressStorage(disk);
  const other = { ...mission, id: "other" };
  await store.save(other, question());
  await store.save(mission, choice());
  await store.clear(mission.id);
  assert.equal((await store.load(mission)).progress, null);
  await store.save(mission, choice());
  const checked = updateAnswer(order(), pages, 3, { kind: "order", placed: ["Eerst", "Daarna"], checked: true });
  await store.save(mission, advance(checked, pages, 3));
  assert.equal((await store.load(mission)).progress, null);
  assert.deepEqual((await store.load(other)).progress, question());
});

test("stale content or corrupt storage is removed before starting fresh", async () => {
  const disk = memoryStorage();
  const store = createProgressStorage(disk);
  await store.save(mission, choice());
  const changed = { ...mission, title: "Bijgewerkt" };
  assert.deepEqual(await store.load(changed), { progress: null, discarded: true });
  assert.equal(disk.values.size, 0);
  disk.values.set("breinhap.mission.v1.demo", "{");
  assert.deepEqual(await store.load(mission), { progress: null, discarded: true });
});

test("old writes cannot resurrect a restarted or completed mission", async () => {
  const disk = memoryStorage();
  const original = disk.setItem;
  let release;
  disk.setItem = async (key, value) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    await original(key, value);
  };
  const store = createProgressStorage(disk);
  const pending = store.save(mission, choice());
  const cleared = store.clear(mission.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disk.values.size, 0);
  release();
  await Promise.all([pending, cleared]);
  assert.equal((await store.load(mission)).progress, null);
});

test("load waits for queued writes and failed writes can be retried", async () => {
  const disk = memoryStorage();
  let fail = true;
  const original = disk.setItem;
  disk.setItem = async (key, value) => {
    if (fail) throw new Error("storage unavailable");
    await original(key, value);
  };
  const store = createProgressStorage(disk);
  await assert.rejects(store.save(mission, choice()), /storage unavailable/);
  fail = false;
  const pending = store.save(mission, choice(0));
  const loaded = store.load(mission);
  await pending;
  assert.deepEqual((await loaded).progress, choice(0));
});

test("read and delete failures are surfaced instead of silently replacing checkpoints", async () => {
  const disk = memoryStorage();
  const store = createProgressStorage(disk);
  await store.save(mission, choice());
  disk.getItem = async () => {
    throw new Error("read failed");
  };
  await assert.rejects(store.load(mission), /read failed/);
  assert.equal(disk.values.size, 1);
  disk.removeItem = async () => {
    throw new Error("delete failed");
  };
  await assert.rejects(store.clear(mission.id), /delete failed/);
  assert.equal(disk.values.size, 1);
});

test("inventory cleanup removes orphan checkpoints of any ID length and preserves other app data", async () => {
  const disk = memoryStorage();
  const store = createProgressStorage(disk);
  const longId = `${"long-".repeat(40)}mission`;
  const removedId = `${"removed-".repeat(30)}mission`;
  await store.save({ ...mission, id: longId }, choice());
  await store.save({ ...mission, id: removedId }, choice());
  await store.save(mission, choice());
  disk.values.set("breinhap.settings.v1", "settings");
  disk.values.set("breinhap.profile.v1", "profile");
  disk.values.set("breinhap.mission.v1.%broken", "invalid key");
  await store.prune([mission.id, longId]);
  assert.equal(disk.values.size, 4);
  assert.deepEqual((await store.load({ ...mission, id: longId })).progress, choice());
  assert.equal(disk.values.get("breinhap.settings.v1"), "settings");
  assert.equal(disk.values.get("breinhap.profile.v1"), "profile");
  assert.equal(disk.values.has(`breinhap.mission.v1.${removedId}`), false);
  assert.equal(disk.values.has("breinhap.mission.v1.%broken"), false);
});

test("a failed orphan removal is reported, other removals proceed, and retry clears the rest", async () => {
  const disk = memoryStorage();
  const store = createProgressStorage(disk);
  await store.save(mission, choice());
  await store.save({ ...mission, id: "removed" }, choice());
  const remove = disk.removeItem;
  disk.removeItem = async (key) => {
    if (key.endsWith(".demo")) throw new Error("temporary failure");
    await remove(key);
  };
  await assert.rejects(store.prune([]), /progress.cleanup_failed/);
  assert.equal(disk.values.size, 1);
  disk.removeItem = remove;
  await store.prune([]);
  assert.equal(disk.values.size, 0);
});

test("enumeration failure keeps saved state and cleanup can be retried", async () => {
  const disk = memoryStorage();
  const store = createProgressStorage(disk);
  await store.save(mission, choice());
  const enumerate = disk.getAllKeys;
  disk.getAllKeys = async () => {
    throw new Error("enumeration unavailable");
  };
  await assert.rejects(store.prune([]), /enumeration unavailable/);
  assert.equal(disk.values.size, 1);
  disk.getAllKeys = enumerate;
  await store.prune([]);
  assert.equal(disk.values.size, 0);
});

test("cleanup waits for an in-flight orphan save so it cannot resurrect after pruning", async () => {
  const disk = memoryStorage();
  const set = disk.setItem;
  let release;
  disk.setItem = async (key, value) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    await set(key, value);
  };
  const store = createProgressStorage(disk);
  const saving = store.save(mission, choice());
  const pruning = store.prune([]);
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([saving, pruning]);
  assert.equal(disk.values.size, 0);
});

test("direct removal accepts the same long IDs as the content schema", async () => {
  const disk = memoryStorage();
  const store = createProgressStorage(disk);
  const long = { ...mission, id: `${"long-".repeat(40)}mission` };
  await store.save(long, choice());
  await store.clear(long.id);
  assert.equal(disk.values.size, 0);
});
