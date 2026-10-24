import * as Application from "expo-application";
import Constants from "expo-constants";
import { includeDrafts } from "./content";

/** "v1.0.0 (3)": the app version and the Play version code, so testers see which build they have. */
export const versionLabel = `v${Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? "?"}${
  Application.nativeBuildVersion ? ` (${Application.nativeBuildVersion})` : ""
}${includeDrafts ? " proef" : ""}`;
