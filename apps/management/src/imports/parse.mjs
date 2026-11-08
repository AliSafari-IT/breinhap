import { withLocale } from "../workspace-i18n.mjs";
import { ContentError, validate } from "../content.mjs";
import { messageOf } from "../library.mjs";
import { SCHEMA_VERSION } from "../vendor/content-schema.mjs";

/**
 * breinhap#30: turns an import file into learning objects, or into errors that point at a row and a
 * column (CSV) or a path (JSON). Two formats:
 *
 * - a Breinhap ContentPack (JSON), the same shape the Android app ships;
 * - the CSV template (one row per card, question or common mistake; see CSV_COLUMNS), with `,` or `;`.
 *
 * Every object goes through the same `validate()` as the editor. The file's review status is never
 * trusted: whatever it says, the object becomes a draft (validate() forces it).
 */

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_ROWS = 5000;
export const MAX_OBJECTS = 200;

export const CSV_COLUMNS = [
	"object_id", "subject", "grade", "title", "leerdoel", "references",
	"mission_id", "mission_title", "minutes",
	"part", "kind", "text", "example", "options", "answer", "items", "explanation", "mistake", "why",
];
const REQUIRED = ["object_id", "subject", "grade", "title", "leerdoel", "mission_id", "mission_title", "minutes", "part"];
const PARTS = ["warmup", "learn", "practice", "check", "mistake"];
const LIST = /\s*\|\s*/;

/** RFC 4180 with `,` or `;` (detected from the header), quotes, CRLF or LF, a leading BOM. */
export function parseCsv(text) {
	const source = text.replace(/^﻿/, "");
	const firstLine = source.slice(0, source.search(/\r?\n|$/));
	const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
	const rows = [];
	let row = [];
	let cell = "";
	let quoted = false;
	for (let i = 0; i < source.length; i++) {
		const c = source[i];
		if (quoted) {
			if (c === '"' && source[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (c === '"') quoted = false;
			else cell += c;
		} else if (c === '"' && cell === "") quoted = true;
		else if (c === delimiter) {
			row.push(cell);
			cell = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && source[i + 1] === "\n") i++;
			row.push(cell);
			rows.push(row);
			row = [];
			cell = "";
			if (rows.length > MAX_ROWS + 1) throw new ImportRefused("too_many_rows");
		} else cell += c;
	}
	if (quoted) throw new ImportRefused("csv_unterminated");
	if (cell !== "" || row.length) {
		row.push(cell);
		rows.push(row);
	}
	return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

export class ImportRefused extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}

const err = (errors, where, message) => errors.push({ ...where, message });

/**
 * Validates one object; returns the stored shape, or pushes errors mapped through `locate(path)`.
 */
function check(input, locate, errors) {
	try {
		return validate(input, []).object;
	} catch (error) {
		if (!(error instanceof ContentError)) throw error;
		if (error.code === "unsupported_version") {
			err(errors, locate("schemaVersion"), `Schemaversie ${String(input?.schemaVersion)} wordt niet ondersteund (alleen ${SCHEMA_VERSION}).`);
			return null;
		}
		for (const issue of error.issues.slice(0, 40)) err(errors, locate(issue.path), withLocale("nl", () => messageOf(issue)));
		return null;
	}
}

/** A ContentPack (JSON). Returns `{ objects, errors, notes }`. */
export function fromPack(text) {
	const errors = [];
	const notes = [];
	let pack;
	try {
		pack = JSON.parse(text);
	} catch {
		throw new ImportRefused("json_invalid");
	}
	if (!pack || typeof pack !== "object" || Array.isArray(pack) || !Array.isArray(pack.objects)) throw new ImportRefused("pack_shape");
	if (pack.schemaVersion !== SCHEMA_VERSION) {
		err(errors, { path: "schemaVersion" }, `Schemaversie ${String(pack.schemaVersion)} wordt niet ondersteund (alleen ${SCHEMA_VERSION}).`);
		return { objects: [], errors, notes };
	}
	if (pack.objects.length > MAX_OBJECTS) throw new ImportRefused("too_many_objects");
	const objects = [];
	pack.objects.forEach((input, i) => {
		const label = typeof input?.id === "string" ? input.id.slice(0, 80) : `#${i + 1}`;
		if (input?.review?.status === "reviewed") notes.push(`${label}: het bestand zegt "nagekeken"; dat wordt genegeerd. Het leerobject wordt een concept.`);
		const object = check(input, (path) => ({ object: label, path: `objects.${i}${path ? `.${path}` : ""}` }), errors);
		if (object) objects.push({ object, where: { object: label, path: `objects.${i}` } });
	});
	return { objects, errors, notes };
}

/** The CSV template. Returns `{ objects, errors, notes }`; rows are 1-based as a spreadsheet shows them. */
export function fromCsv(text) {
	const errors = [];
	const notes = [];
	const rows = parseCsv(text);
	if (rows.length < 2) throw new ImportRefused("csv_empty");
	const header = rows[0].map((h) => h.trim().toLowerCase());
	const unknown = header.filter((h) => !CSV_COLUMNS.includes(h));
	for (const name of unknown) err(errors, { row: 1, column: name }, "Onbekende kolom. Gebruik de kolommen van het sjabloon.");
	for (const name of REQUIRED) if (!header.includes(name)) err(errors, { row: 1, column: name }, "Verplichte kolom ontbreekt.");
	if (new Set(header).size !== header.length) err(errors, { row: 1 }, "Een kolom staat er twee keer in.");
	if (errors.length) return { objects: [], errors, notes };

	const byObject = new Map();
	rows.slice(1).forEach((cells, index) => {
		const row = index + 2;
		const value = Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? "").trim()]));
		if (cells.length > header.length && cells.slice(header.length).some((c) => c.trim())) err(errors, { row }, "Meer cellen dan kolommen.");
		// a spreadsheet would run =, +, @ or -cmd as a formula; here a cell is only ever text
		if (Object.values(value).some((v) => /^[=+@]/.test(v) || /^-[^\d\s]/.test(v)))
			notes.push(`Rij ${row}: een cel begint met =, + of @. Ze wordt als gewone tekst bewaard, nooit als formule.`);
		const id = value.object_id;
		if (!id) return err(errors, { row, column: "object_id" }, "Vul dit in.");
		if (!byObject.has(id)) byObject.set(id, { id, rows: [] });
		byObject.get(id).rows.push({ row, value });
	});
	if (byObject.size > MAX_OBJECTS) throw new ImportRefused("too_many_objects");

	const objects = [];
	for (const { id, rows: group } of byObject.values()) {
		const cells = new Map(); // object path → { row, column }
		const first = group[0];
		const same = (column, path) => {
			for (const { row, value } of group.slice(1))
				if (value[column] && value[column] !== first.value[column]) err(errors, { object: id, row, column }, `Verschilt van rij ${first.row} voor hetzelfde leerobject.`);
			cells.set(path, { row: first.row, column });
			return first.value[column];
		};
		const input = {
			schemaVersion: SCHEMA_VERSION,
			id,
			subject: same("subject", "subject"),
			grade: /^\d+$/.test(first.value.grade) ? Number(first.value.grade) : first.value.grade,
			title: same("title", "title"),
			curriculum: {
				leerdoel: same("leerdoel", "curriculum.leerdoel"),
				references: (same("references", "curriculum.references") || "").split(LIST).filter(Boolean),
			},
			review: { status: "draft" },
			missions: [],
		};
		same("grade", "grade");
		cells.set("id", { row: first.row, column: "object_id" });
		const missions = new Map();
		for (const { row, value } of group) {
			if (!value.mission_id) {
				err(errors, { object: id, row, column: "mission_id" }, "Vul dit in.");
				continue;
			}
			let m = missions.get(value.mission_id);
			if (!m) {
				const i = missions.size;
				m = { i, mission: { id: value.mission_id, title: value.mission_title, minutes: /^\d+$/.test(value.minutes) ? Number(value.minutes) : value.minutes, warmup: undefined, learn: [], practice: [], check: [], commonMistakes: [] } };
				missions.set(value.mission_id, m);
				input.missions.push(m.mission);
				const at = `missions.${i}`;
				cells.set(`${at}.id`, { row, column: "mission_id" });
				cells.set(`${at}.title`, { row, column: "mission_title" });
				cells.set(`${at}.minutes`, { row, column: "minutes" });
				for (const part of ["warmup", "learn", "practice", "check"]) cells.set(`${at}.${part}`, { row, column: "part" });
			}
			const at = `missions.${m.i}`;
			const part = value.part.toLowerCase();
			if (!PARTS.includes(part)) {
				err(errors, { object: id, row, column: "part" }, "Kies warmup, learn, practice, check of mistake.");
				continue;
			}
			const card = () => ({ text: value.text, ...(value.example ? { example: value.example } : {}) });
			if (part === "warmup") {
				if (m.mission.warmup) err(errors, { object: id, row, column: "part" }, "Een missie heeft één opwarming.");
				m.mission.warmup = card();
				cells.set(`${at}.warmup.text`, { row, column: "text" });
				cells.set(`${at}.warmup.example`, { row, column: "example" });
			} else if (part === "learn") {
				const n = m.mission.learn.push(card()) - 1;
				cells.set(`${at}.learn.${n}`, { row, column: "text" });
				cells.set(`${at}.learn.${n}.text`, { row, column: "text" });
				cells.set(`${at}.learn.${n}.example`, { row, column: "example" });
			} else if (part === "mistake") {
				const n = m.mission.commonMistakes.push({ mistake: value.mistake, why: value.why }) - 1;
				cells.set(`${at}.commonMistakes.${n}.mistake`, { row, column: "mistake" });
				cells.set(`${at}.commonMistakes.${n}.why`, { row, column: "why" });
			} else {
				const kind = value.kind.toLowerCase();
				const list = m.mission[part];
				const q = `${at}.${part}.${list.length}`;
				if (kind === "choice") {
					const options = value.options.split(LIST).filter(Boolean);
					const answer = /^\d+$/.test(value.answer) ? Number(value.answer) - 1 : NaN;
					if (!Number.isInteger(answer) || answer < 0) err(errors, { object: id, row, column: "answer" }, "Geef het nummer van het juiste antwoord (1, 2, …).");
					list.push({ kind, prompt: value.text, options, answerIndex: Number.isInteger(answer) ? answer : 0, explanation: value.explanation });
					cells.set(`${q}.options`, { row, column: "options" });
					for (let o = 0; o < 6; o++) cells.set(`${q}.options.${o}`, { row, column: "options" });
					cells.set(`${q}.answerIndex`, { row, column: "answer" });
				} else if (kind === "order") {
					list.push({ kind, prompt: value.text, items: value.items.split(LIST).filter(Boolean), explanation: value.explanation });
					cells.set(`${q}.items`, { row, column: "items" });
					for (let o = 0; o < 6; o++) cells.set(`${q}.items.${o}`, { row, column: "items" });
				} else {
					err(errors, { object: id, row, column: "kind" }, "Kies choice of order.");
					continue;
				}
				cells.set(q, { row, column: "kind" });
				cells.set(`${q}.prompt`, { row, column: "text" });
				cells.set(`${q}.explanation`, { row, column: "explanation" });
			}
		}
		for (const { mission } of missions.values()) if (!mission.warmup) mission.warmup = { text: "" };
		// a schema path names the closest cell we know (falling back to the object's first row)
		const locate = (path) => {
			let p = path;
			while (p && !cells.has(p)) p = p.includes(".") ? p.slice(0, p.lastIndexOf(".")) : "";
			return { object: id, ...(cells.get(p) ?? { row: first.row }) };
		};
		const object = check(input, locate, errors);
		if (object) objects.push({ object, where: { object: id, row: first.row } });
	}
	return { objects, errors, notes };
}

/** Duplicate object ids are impossible in CSV (rows group by id) but not in JSON; missions must be unique too. */
export function duplicates(objects, errors) {
	const seen = new Map();
	const missions = new Map();
	const kept = [];
	for (const entry of objects) {
		const { object, where } = entry;
		if (seen.has(object.id)) {
			err(errors, where, `De code ${object.id} staat twee keer in het bestand.`);
			continue;
		}
		let clash = false;
		for (const m of object.missions) {
			if (missions.has(m.id) && missions.get(m.id) !== object.id) {
				err(errors, where, `De missiecode ${m.id} staat ook bij ${missions.get(m.id)} in het bestand.`);
				clash = true;
			}
			missions.set(m.id, object.id);
		}
		seen.set(object.id, true);
		if (!clash) kept.push(entry);
	}
	return kept;
}
