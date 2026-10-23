import { z } from "zod";

/**
 * A Breinhap learning object: one topic, aligned to official leerdoelen,
 * delivered as short missions. The app renders these objects and knows
 * nothing about the subject itself.
 *
 * Bump SCHEMA_VERSION on any breaking change and keep the app able to
 * refuse (not crash on) a pack it doesn't understand.
 */
export const SCHEMA_VERSION = 1;

export const Subject = z.enum([
  "wiskunde",
  "biologie",
  "chemie",
  "fysica",
  "nederlands",
  "engels",
  "frans",
  "aardrijkskunde",
  "geschiedenis",
  "economie",
  "digitale-vaardigheden",
]);
export type Subject = z.infer<typeof Subject>;

const Id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "kebab-case id");
const Text = z.string().trim().min(1);

/** One short piece of explanation. Keep to one idea per card. */
export const Card = z.object({
  text: Text,
  example: Text.optional(),
});
export type Card = z.infer<typeof Card>;

export const ChoiceQuestion = z
  .object({
    kind: z.literal("choice"),
    prompt: Text,
    options: z.array(Text).min(2).max(4),
    answerIndex: z.number().int().min(0),
    /** Shown after answering, right or wrong. Says why, never just "fout". */
    explanation: Text,
  })
  .refine((q) => q.answerIndex < q.options.length, {
    message: "answerIndex must point at an option",
    path: ["answerIndex"],
  });

/** Put items in the right order. `items` is stored in the correct order. */
export const OrderQuestion = z.object({
  kind: z.literal("order"),
  prompt: Text,
  items: z.array(Text).min(2).max(6),
  explanation: Text,
});

export const Question = z.union([ChoiceQuestion, OrderQuestion]);
export type Question = z.infer<typeof Question>;
export type ChoiceQuestion = z.infer<typeof ChoiceQuestion>;
export type OrderQuestion = z.infer<typeof OrderQuestion>;

export const CommonMistake = z.object({
  mistake: Text,
  why: Text,
});

/**
 * Every mission has the same four steps, always in this order:
 * Opwarmen → Leren → Doen → Check. Predictable structure is a core
 * accessibility promise; variety lives only inside the content.
 */
export const Mission = z.object({
  id: Id,
  title: Text,
  /** Planned length in minutes; missions are 2–6 minutes. */
  minutes: z.number().int().min(2).max(6),
  warmup: Card,
  learn: z.array(Card).min(1).max(4),
  practice: z.array(Question).min(1).max(4),
  check: z.array(Question).min(1).max(3),
  commonMistakes: z.array(CommonMistake).default([]),
});
export type Mission = z.infer<typeof Mission>;

/**
 * AI may draft content, but only reviewed content reaches students.
 * The app shows drafts in development builds only.
 */
export const Review = z.discriminatedUnion("status", [
  z.object({ status: z.literal("draft") }),
  z.object({
    status: z.literal("reviewed"),
    reviewedBy: Text,
    reviewedAt: z.iso.date(),
  }),
]);

export const LearningObject = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: Id,
  subject: Subject,
  title: Text,
  /** Year of secondary school (3 = 3de middelbaar). */
  grade: z.literal(3),
  curriculum: z.object({
    /** The learning goal in the school's own words. */
    leerdoel: Text,
    /** Leerplan or eindterm references; empty until aligned. */
    references: z.array(Text).default([]),
  }),
  review: Review,
  missions: z.array(Mission).min(1),
});
export type LearningObject = z.infer<typeof LearningObject>;
export type LearningObjectInput = z.input<typeof LearningObject>;

export const ContentPack = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    id: Id,
    version: z.number().int().min(1),
    objects: z.array(LearningObject).min(1),
  })
  .superRefine((pack, ctx) => {
    const seen = new Set<string>();
    for (const object of pack.objects) {
      for (const mission of object.missions) {
        if (seen.has(mission.id)) {
          ctx.addIssue({
            code: "custom",
            message: `duplicate mission id: ${mission.id}`,
            path: ["objects"],
          });
        }
        seen.add(mission.id);
      }
    }
  });
export type ContentPack = z.infer<typeof ContentPack>;
