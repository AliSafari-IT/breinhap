// breinhap#30, without a database: the CSV reader, the CSV template, and the mapping of every
// problem to a row and column (CSV) or a path (ContentPack JSON); review flags are never trusted.
import assert from "node:assert/strict";
import { test } from "node:test";

import { duplicates, fromCsv, fromPack, ImportRefused, parseCsv } from "../src/imports/parse.mjs";
import { TEMPLATE } from "../src/imports/routes.mjs";
import { canonical } from "../src/imports/store.mjs";
import { objectNamed, packOf } from "./import-fixtures.mjs";

const csv = (lines) => {
	const head = TEMPLATE.split("\r\n")[0].split(";");
	const cell = (v = "") => (/[;"\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
	return [head.join(";"), ...lines.map((cells) => head.map((h) => cell(cells[h])).join(";"))].join("\n");
};
const base = { object_id: "obj-a", subject: "biologie", grade: "3", title: "Titel", leerdoel: "Doel", mission_id: "obj-a-m1", mission_title: "Missie", minutes: "3" };
const good = [
	{ ...base, part: "warmup", text: "Opwarmen" },
	{ ...base, part: "learn", text: "Leren" },
	{ ...base, part: "practice", kind: "choice", text: "Vraag", options: "A | B", answer: "2", explanation: "Omdat B" },
	{ ...base, part: "check", kind: "order", text: "Orden", items: "een | twee", explanation: "Zo" },
];
const at = (errors, row, column) => errors.find((e) => e.row === row && e.column === column);

test("the CSV template imports without a single error, as one complete mission", () => {
	const { objects, errors } = fromCsv(TEMPLATE);
	assert.deepEqual(errors, []);
	assert.equal(objects.length, 1);
	const [m] = objects[0].object.missions;
	assert.equal(m.practice[0].answerIndex, 1);
	assert.deepEqual(m.check[0].items, ["prikkel", "receptor", "reactie"]);
	assert.equal(objects[0].object.review.status, "draft");
});

test("CSV: quotes, embedded separators and newlines, a BOM, and either separator", () => {
	assert.deepEqual(parseCsv('﻿a;b\r\n"x;y";"regel 1\nregel 2"\r\n"zeg ""hoi""";\n'), [["a", "b"], ["x;y", "regel 1\nregel 2"], ['zeg "hoi"', ""]]);
	assert.deepEqual(parseCsv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
	assert.throws(() => parseCsv('a;b\n"open'), (e) => e instanceof ImportRefused && e.code === "csv_unterminated");
	assert.equal(fromCsv(csv(good).replaceAll(";", ",")).errors.length, 0);
});

test("CSV: missing and unknown columns are reported on the header row", () => {
	const head = "object_id;subject;grade;title;mission_id;mission_title;minutes;part;wachtwoord";
	const { errors, objects } = fromCsv(`${head}\nx;biologie;3;T;x-m1;M;3;warmup;geheim\n`);
	assert.equal(objects.length, 0);
	assert.ok(at(errors, 1, "leerdoel"), "required leerdoel");
	assert.ok(at(errors, 1, "wachtwoord"), "unknown column");
});

test("CSV: each problem points at its row and column; other objects still import", () => {
	const broken = [
		{ ...base, object_id: "obj-b", mission_id: "obj-b-m1", part: "warmup", text: "Opwarmen" },
		{ ...base, object_id: "obj-b", mission_id: "obj-b-m1", minutes: "9", part: "learn", text: "Leren" },
		{ ...base, object_id: "obj-b", mission_id: "obj-b-m1", part: "practice", kind: "choice", text: "Vraag", options: "A | B", answer: "x", explanation: "E" },
		{ ...base, object_id: "obj-b", mission_id: "obj-b-m1", part: "check", kind: "raadsel", text: "?" },
		{ ...base, object_id: "obj-b", mission_id: "obj-b-m1", title: "Andere titel", part: "uitleg", text: "?" },
	];
	const { objects, errors } = fromCsv(csv([...good, ...broken]));
	assert.deepEqual(objects.map((o) => o.object.id), ["obj-a"]);
	assert.ok(at(errors, 8, "answer"), "answer that is not a number");
	assert.ok(at(errors, 9, "kind"), "unknown kind");
	assert.ok(at(errors, 10, "part"), "unknown part");
	assert.match(at(errors, 10, "title").message, /Verschilt van rij 6/);
	assert.ok(errors.every((e) => e.object === "obj-b"));
	// a schema rule (minutes 2–6) is mapped back to the mission's first row
	const minutes = fromCsv(csv(good.map((r) => ({ ...r, minutes: "9" })))).errors;
	assert.deepEqual(minutes.map((e) => [e.row, e.column]), [[2, "minutes"]]);
	assert.match(minutes[0].message, /Hoogstens 6/);
});

test("CSV: formula-like and markup cells stay plain text, with a note", () => {
	const rows = good.map((r) => ({ ...r }));
	rows[1].text = '=HYPERLINK("https://evil.example","klik")';
	rows[0].text = "<script>alert(1)</script>";
	const { objects, errors, notes } = fromCsv(csv(rows));
	assert.deepEqual(errors, []);
	assert.equal(objects[0].object.missions[0].learn[0].text, '=HYPERLINK("https://evil.example","klik")');
	assert.equal(objects[0].object.missions[0].warmup.text, "<script>alert(1)</script>");
	assert.match(notes.join(" "), /Rij 3: een cel begint met =/);
});

test("ContentPack: valid objects import; versions, review flags and duplicates are handled", () => {
	const ok = fromPack(packOf(objectNamed("een"), objectNamed("twee")));
	assert.deepEqual(ok.errors, []);
	assert.equal(ok.objects.length, 2);
	// the file says "reviewed": that is never trusted
	assert.equal(ok.objects[0].object.review.status, "draft");
	assert.match(ok.notes[0], /nagekeken.*genegeerd/);
	assert.match(fromPack(JSON.stringify({ schemaVersion: 2, objects: [] })).errors[0].message, /Schemaversie 2/);
	const mixed = fromPack(packOf({ ...objectNamed("drie"), schemaVersion: 9 }, objectNamed("vier"), { ...objectNamed("vijf"), grade: 9 }));
	assert.deepEqual(mixed.objects.map((o) => o.object.id), ["vier"]);
	assert.deepEqual(mixed.errors.map((e) => e.path), ["objects.0.schemaVersion", "objects.2.grade"]);
	// the same code twice, or a mission code under two objects: refused before anything is planned
	const twice = fromPack(packOf(objectNamed("zes"), objectNamed("zes")));
	assert.equal(duplicates(twice.objects, twice.errors).length, 1);
	assert.match(twice.errors[0].message, /twee keer/);
	const shared = fromPack(packOf(objectNamed("zeven"), { ...objectNamed("acht"), missions: objectNamed("zeven").missions }));
	assert.equal(duplicates(shared.objects, shared.errors).length, 1);
	assert.match(shared.errors[0].message, /missiecode zeven-m1/);
	for (const [text, code] of [["{", "json_invalid"], ["[]", "pack_shape"], ['{"objects": 3}', "pack_shape"]])
		assert.throws(() => fromPack(text), (e) => e.code === code);
});

test("canonical JSON ignores key order", () => {
	assert.equal(canonical({ b: 1, a: [{ d: 2, c: 3 }] }), canonical({ a: [{ c: 3, d: 2 }], b: 1 }));
	assert.notEqual(canonical({ a: 1 }), canonical({ a: 2 }));
});
