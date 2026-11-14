import { studentPayload } from "./mission";
import { samplePack } from "./samples";
import type { Mission } from "./schema";

/** The learning object and mission shown on the website's home page (the biology plant mission). */
export const WEB_EXAMPLE = { objectId: "biologie-prikkel-reactie-planten", missionId: "bio-prikkel-reactie-volgorde" } as const;

/**
 * What the website embeds: only the student payload of one reviewed mission, never review data. Throws
 * when the mission is gone or no longer reviewed, so the website cannot show unreviewed content.
 */
export function webExample(): { title: string; subject: string; grade: number; leerdoel: string; mission: Mission } {
  const object = samplePack.objects.find((o) => o.id === WEB_EXAMPLE.objectId);
  if (!object || object.review.status !== "reviewed") throw new Error(`web example object is missing or not reviewed: ${WEB_EXAMPLE.objectId}`);
  const mission = studentPayload(object).missions.find((m) => m.id === WEB_EXAMPLE.missionId);
  if (!mission) throw new Error(`web example mission is missing: ${WEB_EXAMPLE.missionId}`);
  return { title: object.title, subject: object.subject, grade: object.grade, leerdoel: object.curriculum.leerdoel, mission };
}
