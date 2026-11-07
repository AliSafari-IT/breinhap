import { SLOTS } from "../library.mjs";

/**
 * breinhap#31: the author's mapping of extracted blocks onto the editor's fields. Each block gets the
 * role the author chose (nothing is chosen for them); the result fills the editor for one learning
 * object with one mission, which the author completes and saves as a draft themselves.
 *
 * Never filled in: a correct answer (no option is marked right), the minutes, the code, a review.
 * Options and steps are only ever the author's chosen blocks, in their order.
 */

export const ROLES = ["skip", "title", "goal", "reference", "warmup", "learn", "example", "practice", "check", "option", "step", "explanation", "mistake", "why"];

/** The upload's declared source as a source kind of the learning object (server-side only). */
const SOURCE_KIND = { own: "own", school: "school_material", publisher: "book", open_licence: "school_material", other: "school_material" };

/** "p. 1–3, 5" or "¶ 4, 7" from the blocks used. */
export function refsOf(blocks) {
	const pages = [...new Set(blocks.map((b) => b.ref?.page).filter(Number.isInteger))].sort((a, b) => a - b);
	const paragraphs = [...new Set(blocks.map((b) => b.ref?.paragraph).filter(Number.isInteger))].sort((a, b) => a - b);
	const ranges = (list) => {
		const out = [];
		for (const n of list) {
			const last = out.at(-1);
			if (last && n === last[1] + 1) last[1] = n;
			else out.push([n, n]);
		}
		return out.map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`)).join(", ");
	};
	if (pages.length) return `p. ${ranges(pages)}`;
	if (paragraphs.length) return `¶ ${ranges(paragraphs)}`;
	return "";
}

/**
 * `blocks` from the extraction, `roles` block index → role. Returns `{ values, notes, used }`: the
 * editor's field values, notes about blocks that did not fit (codes with the block numbers), and how
 * many blocks were used.
 */
export function toEditorValues(blocks, roles, { fileName, sourceKind, sourceNote } = {}) {
	const values = { grade: "3" };
	const notes = [];
	const used = [];
	const m = "missions.0";
	let title = "";
	const goal = [];
	const references = [];
	let lastCard = null;
	const counts = { learn: 0, practice: 0, check: 0, commonMistakes: 0 };
	let question = null;
	let mistake = null;
	const append = (key, text) => {
		values[key] = values[key] ? `${values[key]}\n${text}` : text;
	};
	const unfit = (code, index) => notes.push({ code, block: index + 1 });

	blocks.forEach((block, index) => {
		const role = roles.get(index) ?? "skip";
		if (!ROLES.includes(role) || role === "skip") return;
		const text = block.text;
		const take = () => used.push(block);
		switch (role) {
			case "title":
				if (title) return unfit("title_twice", index); // only the first title counts
				title = text.slice(0, 200);
				return take();
			case "goal":
				goal.push(text);
				return take();
			case "reference":
				references.push(...text.split("\n").map((l) => l.trim()).filter(Boolean));
				return take();
			case "warmup":
				append(`${m}.warmup.text`, text);
				lastCard = `${m}.warmup`;
				return take();
			case "learn":
				if (counts.learn >= SLOTS.learn) return unfit("too_many_cards", index);
				lastCard = `${m}.learn.${counts.learn++}`;
				values[`${lastCard}.text`] = text;
				return take();
			case "example":
				if (!lastCard) return unfit("example_without_card", index);
				append(`${lastCard}.example`, text);
				return take();
			case "practice":
			case "check": {
				const max = role === "practice" ? SLOTS.practice : SLOTS.check;
				if (counts[role] >= max) return unfit(role === "practice" ? "too_many_practice" : "too_many_check", index);
				question = { prefix: `${m}.${role}.${counts[role]++}`, options: 0, steps: 0 };
				values[`${question.prefix}.kind`] = "choice";
				values[`${question.prefix}.prompt`] = text;
				return take();
			}
			case "option":
				if (!question) return unfit("option_without_question", index);
				if (question.options >= SLOTS.options) return unfit("too_many_options", index);
				values[`${question.prefix}.options.${question.options++}`] = text.slice(0, 300);
				return take();
			case "step":
				if (!question) return unfit("step_without_question", index);
				if (question.steps >= SLOTS.items) return unfit("too_many_steps", index);
				values[`${question.prefix}.kind`] = "order";
				values[`${question.prefix}.items.${question.steps++}`] = text.slice(0, 300);
				return take();
			case "explanation":
				if (!question) return unfit("explanation_without_question", index);
				append(`${question.prefix}.explanation`, text);
				return take();
			case "mistake":
				if (counts.commonMistakes >= SLOTS.commonMistakes) return unfit("too_many_mistakes", index);
				mistake = `${m}.commonMistakes.${counts.commonMistakes++}`;
				values[`${mistake}.mistake`] = text.slice(0, 500);
				return take();
			case "why":
				if (!mistake) return unfit("why_without_mistake", index);
				append(`${mistake}.why`, text.slice(0, 500));
				return take();
		}
	});
	if (title) {
		values.title = title;
		values[`${m}.title`] = title;
	}
	if (goal.length) values["curriculum.leerdoel"] = goal.join("\n");
	if (references.length) values["curriculum.references"] = references.join("\n");
	// where it came from, with the pages or paragraphs used (kept server-side, never shown to students)
	const refs = refsOf(used);
	const name = [sourceNote, fileName].filter(Boolean).join(" · ");
	if (name) {
		values["sources.0.kind"] = SOURCE_KIND[sourceKind] ?? "school_material";
		const suffix = refs ? `, ${refs}` : "";
		values["sources.0.title"] = `${name.slice(0, 200 - suffix.length)}${suffix}`;
	}
	return { values, notes, used: used.length };
}
