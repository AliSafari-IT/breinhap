import { samplePack, type LearningObject, type Mission } from "@breinhap/content";

/**
 * Content shown in this build. Only reviewed content reaches students;
 * development builds also show drafts so content can be tried out.
 * Content packs will be downloaded later; for now the samples ship in the app.
 */
export const includeDrafts = __DEV__;

export const learningObjects: readonly LearningObject[] = samplePack.objects.filter(
  (object) => includeDrafts || object.review.status === "reviewed",
);

export function findMission(id: string): { object: LearningObject; mission: Mission } | undefined {
  for (const object of learningObjects) {
    const mission = object.missions.find((m) => m.id === id);
    if (mission) return { object, mission };
  }
  return undefined;
}

export const subjectLabel: Record<string, string> = {
  wiskunde: "Wiskunde",
  biologie: "Biologie",
  chemie: "Chemie",
  fysica: "Fysica",
  nederlands: "Nederlands",
  engels: "Engels",
  frans: "Frans",
  aardrijkskunde: "Aardrijkskunde",
  geschiedenis: "Geschiedenis",
  economie: "Economie",
  "digitale-vaardigheden": "Digitale vaardigheden",
};
