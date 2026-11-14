import { samplePack, type LearningObject, type Mission } from "@breinhap/content";

/**
 * Content bundled in this build. Only reviewed content reaches students;
 * development builds and the "preview" EAS profile (an APK for the team's own
 * phones, never uploaded to Google Play) also show drafts so content can be tried out.
 * The public catalogue from breinhap.com is downloaded on request and added to these
 * (see catalogue/ContentContext.tsx); the samples keep working offline.
 */
export const includeDrafts = __DEV__ || process.env.EXPO_PUBLIC_INCLUDE_DRAFTS === "1";

export const bundledObjects: readonly LearningObject[] = samplePack.objects.filter(
  (object) => includeDrafts || object.review.status === "reviewed",
);

/** True when this build shows missions that nobody has checked yet. */
export const showsDrafts = bundledObjects.some((object) => object.review.status === "draft");

export function findMission(
  objects: readonly LearningObject[],
  id: string,
): { object: LearningObject; mission: Mission } | undefined {
  for (const object of objects) {
    const mission = object.missions.find((m) => m.id === id);
    if (mission) return { object, mission };
  }
  return undefined;
}

export { subjectLabel } from "@breinhap/content";
