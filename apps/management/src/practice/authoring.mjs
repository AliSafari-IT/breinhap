import { LearningObject } from "../vendor/content-schema.mjs";
import { studentPayload } from "../vendor/content-mission.mjs";
import { Draft, PracticeError, fail } from "./model.mjs";

/**
 * Authoring of practice packs (breinhap#80). It composes the owner's own learning objects into a pack
 * draft on top of the closed `PracticeStore`. Everything that matters is decided here on the server:
 *
 * - a reference always points at the object's LATEST immutable revision as the server finds it;
 * - the revision hash and the publication reference are read from the database, never from the form;
 * - "shareable" is derived from an active publication of exactly that revision (#32/#33), so no
 *   field in a request can make a draft shareable.
 *
 * Nothing here creates a link, session, attempt, answer or progress; preview is a pure read.
 */

const SEP = "|";
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_PACK_FORM = 20_000;

/** Where the latest revision of an owned object stands, derived from server records only. */
export function sourceState(row) {
	if (row.publicationId) return { key: "published", shareable: true };
	if (!row.revision) return { key: "draft", shareable: false };
	if (row.decision === "approved" && row.reviewer && row.reviewer !== row.ownerSub)
		return { key: "approved", shareable: false };
	if (row.decision === "changes_requested") return { key: "changes", shareable: false };
	if (row.submittedAt) return { key: "pending", shareable: false };
	return { key: "snapshot", shareable: false };
}

export class PackAuthoring {
	constructor({ practice, content }) {
		this.practice = practice;
		this.content = content;
		this.pool = content.pool;
		this.workspace = content.workspace;
	}

	/** The owner's objects with their latest revision, review state and active publication. */
	async sources(p, onlyIds) {
		await this.practice.author(p, "practice.sources");
		const params = [this.workspace, p.sub];
		let filter = "";
		if (onlyIds) {
			params.push([...onlyIds]);
			filter = " AND lo.id = ANY($3::text[])";
		}
		const { rows } = await this.pool.query(
			`SELECT lo.id, lo.title, lo.subject, lo.grade, lo.owner_sub AS "ownerSub",
			   r.revision, r.content_hash AS "revisionHash", r.content,
			   v.decision, v.reviewer_sub AS reviewer, s.submitted_at AS "submittedAt",
			   pub.id AS "publicationId", pub.pack_hash AS "publicationHash"
			 FROM learning_objects lo
			 LEFT JOIN LATERAL (
			   SELECT revision, content_hash, content FROM learning_object_revisions
			   WHERE workspace_id = lo.workspace_id AND learning_object_id = lo.id
			   ORDER BY revision DESC LIMIT 1
			 ) r ON TRUE
			 LEFT JOIN revision_reviews v ON v.workspace_id = lo.workspace_id AND v.learning_object_id = lo.id AND v.revision = r.revision
			 LEFT JOIN revision_submissions s ON s.workspace_id = lo.workspace_id AND s.learning_object_id = lo.id AND s.revision = r.revision
			 LEFT JOIN content_publications pub ON pub.workspace_id = lo.workspace_id AND pub.learning_object_id = lo.id
			   AND pub.revision = r.revision AND pub.state = 'active'
			 WHERE lo.workspace_id = $1 AND lo.owner_sub = $2 AND lo.archived_at IS NULL${filter}
			 ORDER BY lo.title, lo.id LIMIT 200`,
			params,
		);
		return rows.map((row) => {
			const parsed = row.content ? LearningObject.safeParse(row.content) : null;
			const missions = parsed?.success
				? parsed.data.missions.map((m) => ({
						id: m.id,
						title: m.title,
						practice: m.practice.map((q) => q.prompt),
						check: m.check.map((q) => q.prompt),
					}))
				: [];
			return { ...row, missions, valid: parsed?.success ?? false, state: sourceState(row) };
		});
	}

	/** Packs the owner has, optionally narrowed by title, subject or year. Never anyone else's. */
	async list(p, { q, subject, grade } = {}) {
		await this.practice.author(p, "practice.list");
		const params = [this.workspace, p.sub];
		let filter = "";
		if (q) {
			params.push(`%${String(q).slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
			filter += ` AND draft->>'title' ILIKE $${params.length}`;
		}
		if (subject) {
			params.push(String(subject));
			filter += ` AND draft->>'subject' = $${params.length}`;
		}
		if (grade) {
			params.push(String(Number(grade)));
			filter += ` AND draft->>'grade' = $${params.length}`;
		}
		return (
			await this.pool.query(
				`SELECT id, draft_version AS version, draft->>'title' AS title, draft->>'subject' AS subject,
				   (draft->>'grade')::int AS grade, draft->>'mode' AS mode, draft->>'language' AS language, updated_at AS "updatedAt"
				 FROM practice_packs WHERE workspace_id = $1 AND owner_sub = $2 AND archived_at IS NULL${filter}
				 ORDER BY updated_at DESC, id LIMIT 100`,
				params,
			)
		).rows;
	}

	/**
	 * Turns the request values into a draft. Mission/question choices are `objectId|missionId[|stage|n]`
	 * strings; the revision and publication data come from the server's own records. Returns
	 * `{ draft }` or `{ errors }` keyed by form field. Never throws for bad input.
	 */
	async compose(p, values) {
		const errors = {};
		const pick = (name) => {
			const raw = values[name];
			return Array.isArray(raw) ? raw : raw === undefined || raw === "" ? [] : [raw];
		};
		const missionChoices = ["missie1", "missie2", "missie3"]
			.map((name) => [name, String(pick(name)[0] ?? "")])
			.filter(([, value]) => value !== "");
		const questionChoices = pick("vraag").map(String);
		const parsedChoices = (choice, parts) => {
			const bits = choice.split(SEP);
			return bits.length === parts && ID.test(bits[0]) && ID.test(bits[1]) ? bits : null;
		};
		const wanted = new Set();
		const missionBits = missionChoices.map(([name, value]) => {
			const bits = parsedChoices(value, 2);
			if (!bits) errors[name] = "Kies een missie uit de lijst.";
			else wanted.add(bits[0]);
			return [name, bits];
		});
		const questionBits = questionChoices.map((value) => {
			const bits = parsedChoices(value, 4);
			if (!bits || !["practice", "check"].includes(bits[2]) || !/^[0-3]$/.test(bits[3])) {
				errors.vraag = "Een gekozen vraag bestaat niet.";
				return null;
			}
			wanted.add(bits[0]);
			return bits;
		});
		const known = new Map((await this.sources(p, wanted.size ? wanted : [])).map((s) => [s.id, s]));
		const ref = (bits, name) => {
			const object = bits && known.get(bits[0]);
			if (!object) {
				errors[name] = "Dit leerobject bestaat niet, is gearchiveerd of is niet van jou.";
				return null;
			}
			if (!object.revision || !object.valid) {
				errors[name] = `“${object.title}” heeft nog geen bruikbare revisie. Leg het leerobject eerst vast in de bibliotheek.`;
				return null;
			}
			const mission = object.missions.find((m) => m.id === bits[1]);
			if (!mission) {
				errors[name] = `“${object.title}” heeft deze missie niet (meer) in revisie ${object.revision}.`;
				return null;
			}
			const base = { objectId: object.id, revision: object.revision, missionId: bits[1], revisionHash: object.revisionHash };
			if (object.publicationId) {
				base.publicationId = object.publicationId;
				base.publicationHash = object.publicationHash;
			}
			return base;
		};
		const missionRefs = missionBits.map(([name, bits]) => ref(bits, name)).filter(Boolean);
		const assessmentRefs = questionBits
			.map((bits) => {
				const base = bits && ref(bits, "vraag");
				if (!base) return null;
				const object = known.get(bits[0]);
				const mission = object.missions.find((m) => m.id === bits[1]);
				const list = bits[2] === "practice" ? mission.practice : mission.check;
				if (Number(bits[3]) >= list.length) {
					errors.vraag = "Een gekozen vraag bestaat niet (meer).";
					return null;
				}
				return { ...base, stage: bits[2], questionIndex: Number(bits[3]) };
			})
			.filter(Boolean);
		if (!missionChoices.length) errors.missie1 = "Kies minstens één missie.";
		const number = (name) => (values[name] === undefined || values[name] === "" ? undefined : Number(values[name]));
		const expiry = number("verloopDagen");
		const draft = {
			title: String(values.titel ?? ""),
			description: String(values.beschrijving ?? ""),
			instructions: String(values.instructies ?? ""),
			subject: String(values.vak ?? ""),
			grade: Number(values.jaar),
			language: String(values.taal ?? ""),
			mode: String(values.modus ?? ""),
			missionRefs,
			assessmentRefs,
			shareDefaults: { ...(expiry === undefined ? {} : { expiryDays: expiry }), maxAttempts: 1 },
		};
		const result = Draft.safeParse(draft);
		if (!result.success) {
			const field = { title: "titel", description: "beschrijving", instructions: "instructies", subject: "vak", grade: "jaar", language: "taal", mode: "modus", missionRefs: "missie1", assessmentRefs: "vraag", shareDefaults: "verloopDagen" };
			for (const issue of result.error.issues) {
				const name = field[issue.path[0]];
				if (name && !errors[name])
					errors[name] =
						issue.path[0] === "assessmentRefs" ? "Kies hoogstens zes vragen." : issue.path[0] === "missionRefs" ? "Kies één tot drie missies." : "Controleer dit veld.";
			}
		}
		if (result.success) {
			// the cross-field rules the storage model also enforces, reported on the field that caused them
			const missionKeys = missionRefs.map((r) => `${r.objectId}:${r.missionId}`);
			if (new Set(missionKeys).size !== missionKeys.length) errors.missie1 = "Kies elke missie hoogstens één keer.";
			const chosen = new Set(missionRefs.map((r) => r.objectId));
			if (assessmentRefs.some((r) => !chosen.has(r.objectId))) errors.vraag = "Kies vragen alleen uit leerobjecten van de gekozen missies.";
			const questionKeys = assessmentRefs.map((r) => `${r.objectId}:${r.missionId}:${r.stage}:${r.questionIndex}`);
			if (new Set(questionKeys).size !== questionKeys.length) errors.vraag = "Kies elke vraag hoogstens één keer.";
		}
		if (Object.keys(errors).length || !result.success) return { errors: Object.keys(errors).length ? errors : { titel: "Controleer de gegevens." } };
		const data = result.data;
		const objects = new Set(data.missionRefs.map((r) => r.objectId));
		if (objects.size > 3) return { errors: { missie1: "Kies missies uit hoogstens drie leerobjecten." } };
		return { draft: data };
	}

	/** Maps a stored draft back to form values. */
	static values(draft) {
		const key = (r) => `${r.objectId}${SEP}${r.missionId}`;
		return {
			titel: draft.title,
			beschrijving: draft.description,
			instructies: draft.instructions,
			vak: draft.subject,
			jaar: String(draft.grade),
			taal: draft.language,
			modus: draft.mode,
			verloopDagen: String(draft.shareDefaults?.expiryDays ?? 7),
			missie1: draft.missionRefs[0] ? key(draft.missionRefs[0]) : "",
			missie2: draft.missionRefs[1] ? key(draft.missionRefs[1]) : "",
			missie3: draft.missionRefs[2] ? key(draft.missionRefs[2]) : "",
			vraag: draft.assessmentRefs.map((r) => `${key(r)}${SEP}${r.stage}${SEP}${r.questionIndex}`),
		};
	}

	async create(p, draft) {
		return this.practice.create(p, draft);
	}
	async update(p, id, version, draft) {
		return this.practice.update(p, id, version, draft);
	}
	async get(p, id) {
		return this.practice.get(p, id);
	}
	async duplicate(p, id) {
		// a new identity: the draft only; no links, attempts, versions or publication authority
		return this.practice.duplicate(p, id);
	}
	async archive(p, id) {
		return this.practice.archive(p, id);
	}

	/**
	 * What the pack would be today: for each referenced object the CURRENT latest revision state, plus
	 * whether the saved reference still matches it. Sharing needs `shareable` (all published, exact).
	 */
	async readiness(p, draft) {
		const ids = new Set([...draft.missionRefs, ...draft.assessmentRefs].map((r) => r.objectId));
		const known = new Map((await this.sources(p, ids)).map((s) => [s.id, s]));
		const items = [...ids].map((objectId) => {
			const object = known.get(objectId);
			const saved = draft.missionRefs.find((r) => r.objectId === objectId) ?? draft.assessmentRefs.find((r) => r.objectId === objectId);
			if (!object) return { objectId, title: objectId, missing: true, shareable: false, state: { key: "missing" }, savedRevision: saved.revision };
			const sameRevision = object.revision === saved.revision && object.revisionHash === saved.revisionHash;
			const exact = object.state.shareable && saved.publicationId === object.publicationId && saved.publicationHash === object.publicationHash;
			return { objectId, title: object.title, revision: object.revision, savedRevision: saved.revision, newer: !sameRevision, state: object.state, shareable: exact };
		});
		return { items, shareable: items.length > 0 && items.every((i) => i.shareable) };
	}

	/**
	 * Read-only preview material: the referenced revisions' student payloads (read directly from the
	 * owner's immutable revisions, so a pending or draft source can be previewed by its owner but never
	 * shared), arranged in pack order. No write of any kind happens here.
	 */
	async previewObject(p, id) {
		const { draft } = await this.practice.get(p, id);
		const ids = new Set([...draft.missionRefs, ...draft.assessmentRefs].map((r) => r.objectId));
		const revisions = new Map();
		for (const objectId of ids) {
			const wantedRevision = (draft.missionRefs.find((r) => r.objectId === objectId) ?? draft.assessmentRefs.find((r) => r.objectId === objectId)).revision;
			const { rows } = await this.pool.query(
				`SELECT r.content FROM learning_object_revisions r JOIN learning_objects lo
				   ON lo.workspace_id = r.workspace_id AND lo.id = r.learning_object_id
				 WHERE r.workspace_id = $1 AND r.learning_object_id = $2 AND r.revision = $3 AND lo.owner_sub = $4 AND lo.archived_at IS NULL`,
				[this.workspace, objectId, wantedRevision, p.sub],
			);
			if (!rows[0]) fail("unavailable");
			const parsed = LearningObject.safeParse(rows[0].content);
			if (!parsed.success) fail("unsupported_version");
			revisions.set(objectId, studentPayload(parsed.data));
		}
		const mission = (r) => revisions.get(r.objectId).missions.find((m) => m.id === r.missionId) ?? fail("unavailable");
		const missions = draft.missionRefs.map(mission);
		const extra = draft.assessmentRefs.map((r) => mission(r)[r.stage][r.questionIndex] ?? fail("unavailable"));
		if (extra.length) {
			missions.push({
				id: "extra-vragen",
				title: "Extra vragen",
				minutes: Math.max(1, extra.length),
				warmup: { text: "Extra vragen die de begeleider heeft gekozen." },
				learn: [],
				practice: [],
				check: extra,
				commonMistakes: [],
			});
		}
		return { draft, payload: { schemaVersion: 1, id: "pack-preview", subject: draft.subject, title: draft.title, grade: draft.grade, curriculum: { leerdoel: draft.title, references: [] }, missions } };
	}
}

export { PracticeError };
