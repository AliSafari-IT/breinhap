import { samplePack, type LearningObject, type Mission } from "@breinhap/content";

/**
 * Content shown in this build. Only reviewed content reaches students;
 * development builds and the "preview" EAS profile (an APK for the team's own
 * phones, never uploaded to Google Play) also show drafts so content can be tried out.
 * Content packs will be downloaded later; for now the samples ship in the app.
 */
export const includeDrafts = __DEV__ || process.env.EXPO_PUBLIC_INCLUDE_DRAFTS === "1";

export const learningObjects: readonly LearningObject[] = samplePack.objects.filter(
  (object) => includeDrafts || object.review.status === "reviewed",
);

/** True when this build shows missions that nobody has checked yet. */
export const showsDrafts = learningObjects.some((object) => object.review.status === "draft");

export function findMission(id: string): { object: LearningObject; mission: Mission } | undefined {
  for (const object of learningObjects) {
    const mission = object.missions.find((m) => m.id === id);
    if (mission) return { object, mission };
  }
  return undefined;
}

export { subjectLabel } from "@breinhap/content";
