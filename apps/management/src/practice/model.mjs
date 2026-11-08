import {
	createHash,
	createHmac,
	randomBytes,
	timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { Subject } from "../vendor/content-schema.mjs";
import { missionPages } from "../vendor/content-mission.mjs";

export const DAY = 86400_000;
export class PracticeError extends Error {
	constructor(code, commit = false) {
		super(`practice.${code}`);
		this.code = code;
		this.commit = commit;
	}
}
export const fail = (code, commit = false) => {
	throw new PracticeError(code, commit);
};
const text = (max) =>
	z
		.string()
		.trim()
		.max(max)
		.refine((s) => !/[\p{Cc}<>]/u.test(s));
const id = z
	.string()
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
	.max(80);
const hash = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const source = z
	.object({
		objectId: id,
		revision: z.number().int().positive(),
		// Mission IDs have no 80-character object-ID limit in the shared schema.
		// Their upper bound follows the existing complete learning-object byte cap.
		missionId: z
			.string()
			.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
			.max(200_000),
		publicationId: text(120).min(1).optional(),
		revisionHash: hash.optional(),
		publicationHash: hash.optional(),
	})
	.strict();
export const Draft = z
	.object({
		title: text(120).min(1),
		description: text(500).default(""),
		instructions: text(500).default(""),
		subject: Subject,
		grade: z.number().int().min(1).max(6),
		language: z.enum(["nl", "en", "fr", "de"]),
		mode: z.enum(["practice", "test"]),
		missionRefs: z.array(source).min(1).max(3),
		assessmentRefs: z
			.array(
				source.extend({
					stage: z.enum(["practice", "check"]),
					questionIndex: z.number().int().min(0).max(3),
				}),
			)
			.max(6)
			.default([]),
		shareDefaults: z
			.object({
				expiryDays: z.number().int().min(1).max(30).default(7),
				maxAttempts: z.literal(1).default(1),
				notBefore: z.iso.datetime().optional(),
			})
			.strict()
			.default({ expiryDays: 7, maxAttempts: 1 }),
	})
	.strict();
export function validateDraft(value) {
	const result = Draft.safeParse(value);
	if (!result.success) fail("invalid");
	const d = result.data;
	const missions = d.missionRefs.map(
		(r) => `${r.objectId}:${r.revision}:${r.missionId}`,
	);
	const assessments = d.assessmentRefs.map(
		(r) =>
			`${r.objectId}:${r.revision}:${r.missionId}:${r.stage}:${r.questionIndex}`,
	);
	if (
		new Set(missions).size !== missions.length ||
		new Set(assessments).size !== assessments.length
	)
		fail("invalid");
	const objects = new Map();
	for (const r of d.missionRefs) {
		if (objects.has(r.objectId) && objects.get(r.objectId) !== r.revision)
			fail("invalid");
		objects.set(r.objectId, r.revision);
	}
	if (d.assessmentRefs.some((r) => objects.get(r.objectId) !== r.revision))
		fail("invalid");
	return d;
}
export function canonical(value) {
	if (value === null || typeof value === "string" || typeof value === "boolean")
		return JSON.stringify(value);
	if (typeof value === "number" && Number.isSafeInteger(value))
		return JSON.stringify(value);
	if (Array.isArray(value) && Object.keys(value).length !== value.length)
		fail("invalid");
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && Object.getPrototypeOf(value) === Object.prototype)
		return `{${Object.keys(value)
			.sort((a, b) => {
				const x = Array.from(a, (c) => c.codePointAt(0)),
					y = Array.from(b, (c) => c.codePointAt(0));
				for (let i = 0; i < Math.min(x.length, y.length); i++)
					if (x[i] !== y[i]) return x[i] - y[i];
				return x.length - y.length;
			})
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	fail("invalid");
}
export const digest = (value) => createHash("sha256").update(value).digest();
export const contentHash = (value) =>
	digest(canonical(value)).toString("base64url");
export const token = () => randomBytes(32).toString("base64url");
export function bytes(value, size = 32) {
	if (
		typeof value !== "string" ||
		value.length !== Math.ceil((size * 4) / 3) ||
		!/^[A-Za-z0-9_-]+$/.test(value)
	)
		fail("not_found");
	const b = Buffer.from(value, "base64url");
	if (b.length !== size || b.toString("base64url") !== value) fail("not_found");
	return b;
}
export const tokenHash = (value, size = 32) => digest(bytes(value, size));
export const equal = (a, b) =>
	Buffer.isBuffer(a) &&
	Buffer.isBuffer(b) &&
	a.length === b.length &&
	timingSafeEqual(a, b);
export const derived = (seed, purpose, size = 32) =>
	createHmac("sha256", bytes(seed))
		.update(`breinhap:practice:${purpose}:v1`)
		.digest()
		.subarray(0, size)
		.toString("base64url");
export function pages(envelope) {
	if (envelope.modelVersion !== 1 || envelope.contentSchemaVersion !== 1)
		fail("unsupported_version");
	return [
		...envelope.missions.flatMap((m, i) =>
			missionPages(m).map((p, j) => ({ ...p, key: `m:${i}:${j}` })),
		),
		...envelope.assessments.map((question, i) => ({
			step: "Check",
			kind: "question",
			question,
			key: `a:${i}`,
		})),
	];
}
