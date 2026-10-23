import { ContentPack } from "../schema";
import { biologiePrikkelReactie } from "./biologie-prikkel-reactie";
import { wiskundeMerkwaardigeProducten } from "./wiskunde-merkwaardige-producten";

/** Sample content pack, validated at load so a broken sample fails loudly. */
export const samplePack: ContentPack = ContentPack.parse({
  schemaVersion: 1,
  id: "samples",
  version: 1,
  objects: [wiskundeMerkwaardigeProducten, biologiePrikkelReactie],
});
