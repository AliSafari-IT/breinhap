import { ContentPack } from "../schema";
import { biologiePrikkelReactie } from "./biologie-prikkel-reactie";
import { wiskundeOntbindenInFactoren } from "./wiskunde-ontbinden-in-factoren";
import { wiskundeSamengesteldeIntrest } from "./wiskunde-samengestelde-intrest";
import * as derdeGraad from "./derde-graad-economie-wiskunde";
import * as andereJaren from "./andere-jaren";

/** Sample content pack, validated at load so a broken sample fails loudly. */
export const samplePack: ContentPack = ContentPack.parse({
  schemaVersion: 1,
  id: "samples",
  version: 2,
  objects: [
    wiskundeSamengesteldeIntrest,
    biologiePrikkelReactie,
    wiskundeOntbindenInFactoren,
    ...Object.values(derdeGraad),
    ...Object.values(andereJaren),
  ],
});
