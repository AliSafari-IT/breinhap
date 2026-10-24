import type { LearningObjectInput } from "../schema";

// AI-assisted sample for 5/6 Economie-wiskunde (3de graad doorstroom). Draft until reviewed.
export const wiskundeSamengesteldeIntrest: LearningObjectInput = {
  schemaVersion: 1,
  id: "wiskunde-samengestelde-intrest",
  subject: "wiskunde",
  title: "Exponentiële groei: samengestelde intrest",
  grade: 5,
  curriculum: {
    leerdoel: "De leerlingen gebruiken exponentiële functies als model voor exponentiële groei.",
    references: [
      "Katholiek Onderwijs Vlaanderen, leerplan wiskunde B+S'' (III-WisS''-d, 2024), LPD 15",
      "Minimumdoel 06.06, 3de graad basisvorming",
    ],
  },
  review: { status: "draft" },
  missions: [
    {
      id: "wis-samengestelde-intrest",
      title: "Sparen met samengestelde intrest",
      minutes: 5,
      warmup: {
        text: "Je zet €100 op een spaarrekening met 5% intrest per jaar. Na 1 jaar krijg je €5 intrest. Dan heb je €105.",
      },
      learn: [
        {
          text: "Enkelvoudige intrest: je krijgt elk jaar intrest op het beginbedrag alleen. Elk jaar komt er dus €5 bij: 100, 105, 110, 115. Dat is lineaire groei.",
        },
        {
          text: "Samengestelde intrest: de intrest blijft staan en brengt zelf ook intrest op. Elk jaar vermenigvuldig je met dezelfde groeifactor: 1 + 5/100 = 1,05.",
        },
        {
          text: "Na n jaar heb je: K = 100 · 1,05ⁿ. Dat is exponentiële groei.",
          example: "Na 2 jaar: 100 · 1,05² = €110,25. Na 3 jaar: 100 · 1,05³ ≈ €115,76.",
        },
        {
          text: "Het verschil groeit met de tijd. Na 10 jaar: enkelvoudig €150, samengesteld 100 · 1,05¹⁰ ≈ €162,89.",
        },
      ],
      practice: [
        {
          kind: "choice",
          prompt: "Wat is de groeifactor bij 2,5% intrest per jaar?",
          options: ["2,5", "1,25", "1,025", "0,025"],
          answerIndex: 2,
          explanation: "Groeifactor = 1 + 2,5/100 = 1,025. Je houdt het bedrag (1) en krijgt er 2,5% (0,025) bij.",
        },
        {
          kind: "choice",
          prompt: "Je spaart €200 aan 3% samengestelde intrest per jaar. Welke formule geeft het bedrag na n jaar?",
          options: ["200 + 6n", "200 · 1,03ⁿ", "200 · 3ⁿ", "200 · 0,03ⁿ"],
          answerIndex: 1,
          explanation: "Elk jaar maal de groeifactor 1,03, dus 200 · 1,03ⁿ. 200 + 6n is enkelvoudige intrest.",
        },
        {
          kind: "order",
          prompt: "Je zet €500 vast aan 4% samengestelde intrest. Zet de stappen om het bedrag na 3 jaar te vinden in de juiste volgorde.",
          items: [
            "Groeifactor: 1 + 4/100 = 1,04",
            "Formule: K = 500 · 1,04³",
            "Reken de macht uit: 1,04³ = 1,124864",
            "Bedrag: 500 · 1,124864 ≈ €562,43",
          ],
          explanation: "Eerst de groeifactor, dan de formule, dan de macht, en pas op het einde maal het beginbedrag.",
        },
      ],
      check: [
        {
          kind: "choice",
          prompt: "€1000 staat 2 jaar aan 10% samengestelde intrest. Hoeveel heb je dan?",
          options: ["€1200", "€1210", "€1100"],
          answerIndex: 1,
          explanation: "1000 · 1,1² = €1210. In het tweede jaar krijg je ook 10% op de €100 intrest van het eerste jaar. €1200 is enkelvoudige intrest.",
        },
        {
          kind: "choice",
          prompt: "Welk soort groei is samengestelde intrest?",
          options: [
            "Lineaire groei: elk jaar hetzelfde bedrag erbij",
            "Exponentiële groei: elk jaar maal dezelfde factor",
          ],
          answerIndex: 1,
          explanation: "Bij samengestelde intrest vermenigvuldig je elk jaar met dezelfde groeifactor. Dat is exponentiële groei.",
        },
      ],
      commonMistakes: [
        {
          mistake: "Bij 5% intrest vermenigvuldigen met 5 of met 0,05",
          why: "Maal 5 geeft na 1 jaar €500 in plaats van €105. Maal 0,05 geeft alleen de intrest (€5). De groeifactor is 1 + 0,05 = 1,05.",
        },
        {
          mistake: "Elk jaar intrest rekenen op het beginbedrag alleen",
          why: "Dat is enkelvoudige intrest. Bij samengestelde intrest brengt de intrest van vorige jaren ook intrest op.",
        },
      ],
    },
  ],
};
