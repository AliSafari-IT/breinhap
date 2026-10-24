import type { LearningObjectInput } from "../schema";

// AI-assisted sample, reviewed by Ali Safari on 2026-10-24.
export const biologiePrikkelReactie: LearningObjectInput = {
  schemaVersion: 1,
  id: "biologie-prikkel-reactie-planten",
  subject: "biologie",
  title: "Prikkel, receptor, conductor, reactie bij planten",
  grade: 3,
  curriculum: {
    leerdoel:
      "De leerlingen tonen aan dat plantaardige en dierlijke organismen als systeem functioneren.",
  },
  review: { status: "reviewed", reviewedBy: "Ali Safari", reviewedAt: "2026-10-24" },
  missions: [
    {
      id: "bio-prikkel-reactie-volgorde",
      title: "Een plant buigt naar het licht",
      minutes: 4,
      warmup: {
        text: "Een plant staat op de vensterbank. Het licht komt maar van één kant. Na een paar dagen buigt de stengel naar het raam.",
      },
      learn: [
        {
          text: "Een plant reageert in vier stappen: prikkel → receptor → conductor → reactie.",
        },
        {
          text: "De prikkel is wat verandert in de omgeving. Hier: licht van één kant.",
        },
        {
          text: "De receptor neemt de prikkel waar. Hier: lichtgevoelige cellen in de top van de stengel.",
        },
        {
          text: "De conductor geeft het signaal door. Bij planten is dat een plantenhormoon. Hier: auxine gaat naar de schaduwkant. Daardoor groeien de cellen aan de schaduwkant sterker. De reactie: de stengel buigt naar het licht.",
        },
      ],
      practice: [
        {
          kind: "order",
          prompt: "Zet de vier stappen in de juiste volgorde.",
          items: ["Prikkel", "Receptor", "Conductor", "Reactie"],
          explanation:
            "Eerst verandert er iets (prikkel). Dan wordt het waargenomen (receptor). Dan wordt het signaal doorgegeven (conductor). Pas dan volgt de reactie.",
        },
        {
          kind: "choice",
          prompt: "Wat is de conductor bij een plant die naar het licht buigt?",
          options: ["Het licht", "Het plantenhormoon auxine", "De bladeren", "De wortels"],
          answerIndex: 1,
          explanation:
            "Auxine geeft het signaal door van de top naar de cellen die moeten groeien. Het licht is de prikkel, geen conductor.",
        },
      ],
      check: [
        {
          kind: "choice",
          prompt: "Een plant buigt naar het licht. Hoe heet die reactie?",
          options: ["Fototropie", "Nastie", "Fotosynthese"],
          answerIndex: 0,
          explanation:
            "Fototropie: een groeibeweging in de richting van de lichtprikkel. Fotosynthese is iets anders: suikers maken met licht.",
        },
      ],
      commonMistakes: [
        {
          mistake: "Het licht is de conductor.",
          why: "Het licht is de prikkel. De conductor geeft het signaal door in de plant zelf.",
        },
      ],
    },
    {
      id: "bio-tropie-nastie",
      title: "Tropie of nastie?",
      minutes: 3,
      warmup: {
        text: "Planten kunnen bewegen. Er zijn twee soorten bewegingen: tropie en nastie.",
      },
      learn: [
        {
          text: "Tropie: de richting van de beweging hangt af van de richting van de prikkel.",
          example: "De stengel groeit naar de kant waar het licht vandaan komt.",
        },
        {
          text: "Nastie: de richting van de beweging hangt niet af van de richting van de prikkel.",
          example:
            "Je raakt een blaadje van het kruidje-roer-mij-niet aan, van welke kant ook. De blaadjes vouwen altijd op dezelfde manier dicht.",
        },
      ],
      practice: [
        {
          kind: "choice",
          prompt: "Een tulp gaat open als het warm wordt. Is dat een tropie of een nastie?",
          options: ["Tropie", "Nastie"],
          answerIndex: 1,
          explanation:
            "De tulp gaat altijd op dezelfde manier open, waar de warmte ook vandaan komt. De richting hangt niet af van de prikkel: nastie.",
        },
      ],
      check: [
        {
          kind: "choice",
          prompt: "Wortels groeien naar beneden, door de zwaartekracht. Wat is dat?",
          options: ["Tropie", "Nastie"],
          answerIndex: 0,
          explanation:
            "De wortel groeit in de richting van de zwaartekracht. De richting hangt af van de prikkel: tropie.",
        },
      ],
      commonMistakes: [
        {
          mistake: "Elke beweging van een plant is een tropie.",
          why: "Alleen als de richting van de beweging afhangt van de richting van de prikkel. Anders is het een nastie.",
        },
      ],
    },
  ],
};
