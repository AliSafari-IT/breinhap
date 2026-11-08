import type { LearningObjectInput } from "../schema";

// §3.2 uit de aangeleverde bronfragmenten. AI-ondersteund ontwerp; menselijke review blijft nodig.
export const wiskundeOntbindenInFactoren: LearningObjectInput = {
  schemaVersion: 1,
  id: "wiskunde-ontbinden-in-factoren",
  title: "Ontbinden in factoren",
  subject: "wiskunde",
  grade: 3,
  curriculum: {
    leerdoel: "De leerlingen ontbinden veeltermen in factoren door een gemeenschappelijke factor buiten haakjes te brengen, het verschil van twee kwadraten te herkennen en een drieterm als kwadraat van een tweeterm te schrijven.",
    references: [],
  },
  review: { status: "draft" },
  missions: [
    {
      id: "wis-ontbinden-in-factoren",
      title: "Van som naar product",
      minutes: 4,
      warmup: {
        text: "Uitwerken en ontbinden zijn elkaars omgekeerde. 3(2x + 3) = 6x + 9, dus 6x + 9 = 3(2x + 3). Je schrijft een som als een product.",
        example: "2(x + 4) = 2x + 8, dus 2x + 8 = 2(x + 4).",
      },
      learn: [
        {
          text: "Zoek de grootste factor die in elke term voorkomt. Zet die voor de haakjes en deel elke term erdoor.",
          example: "4a²b − 8ab² = 4ab(a − 2b). Je deelt beide termen door 4ab.",
        },
        {
          text: "Probeer zelf: breng bij 6a² − 9a de grootste gemeenschappelijke factor buiten haakjes. Werk je product terug uit voor je verdergaat.",
          example: "6a² − 9a = 3a(2a − 3), want 3a · 2a = 6a² en 3a · 3 = 9a.",
        },
        {
          text: "Een verschil van twee kwadraten wordt een product: a² − b² = (a + b)(a − b). De twee haakjes verschillen alleen in het teken van de tweede term.",
          example: "9a² − 4b² = (3a + 2b)(3a − 2b). De termen met ab vallen weg als je uitwerkt.",
        },
        {
          text: "Herken je a² + 2ab + b² of a² − 2ab + b²? Dan krijg je (a + b)² of (a − b)². Controleer ook de middelste term.",
          example: "9a² − 12ab + 4b² = (3a − 2b)², want −12ab = −2 · 3a · 2b.",
        },
      ],
      practice: [
        {
          kind: "choice",
          prompt: "Ontbind 21x⁵y³ + 7x²y⁷ in factoren.",
          options: [
            "7x²y²(3x³ + y⁵)",
            "7x²y³(3x³ + y⁴)",
            "7x²y⁷(3x³ + 1)",
            "3x³ + y⁴",
          ],
          answerIndex: 1,
          explanation: "De grootste gemeenschappelijke factor is 7x²y³. Je deelt elke term erdoor: 21x⁵y³ : 7x²y³ = 3x³ en 7x²y⁷ : 7x²y³ = y⁴. Dus 7x²y³(3x³ + y⁴).",
        },
        {
          kind: "choice",
          prompt: "Ontbind 25x⁶ − 16 in factoren.",
          options: [
            "(5x³ − 4)²",
            "(5x² + 4)(5x² − 4)",
            "(5x³ + 4)(5x³ − 4)",
            "(25x³ + 4)(x³ − 4)",
          ],
          answerIndex: 2,
          explanation: "25x⁶ = (5x³)² en 16 = 4². Gebruik a² − b² = (a + b)(a − b). Je krijgt (5x³ + 4)(5x³ − 4); bij (5x³ − 4)² krijg je ook een middelste term −40x³.",
        },
        {
          kind: "order",
          prompt: "Zet de stappen om 4a²b − 8ab² te ontbinden in de juiste volgorde.",
          items: [
            "Zoek de grootste gemeenschappelijke factor: 4ab.",
            "Zet 4ab voor de haakjes.",
            "Deel elke term: a − 2b.",
            "Controleer: 4ab(a − 2b) = 4a²b − 8ab².",
          ],
          explanation: "Je zoekt eerst de gemeenschappelijke factor en zet die voor de haakjes. Daarna deel je elke term. Controleer door terug uit te werken: 4ab · a = 4a²b en 4ab · 2b = 8ab².",
        },
        {
          kind: "choice",
          prompt: "Ontbind 49x² − 14x + 1 in factoren.",
          options: ["(7x + 1)²", "(7x − 1)(7x + 1)", "(7x − 1)²", "(49x − 1)²"],
          answerIndex: 2,
          explanation: "49x² = (7x)², 1 = 1² en −14x = −2 · 7x · 1. Dus (7x − 1)². Met (7x − 1)(7x + 1) krijg je 49x² − 1; dan ontbreekt de middelste term.",
        },
      ],
      check: [
        {
          kind: "choice",
          prompt: "Ontbind 9a² − 4b² in factoren.",
          options: ["(3a − 2b)²", "(3a + 2b)(3a − 2b)", "(9a + 4b)(a − b)"],
          answerIndex: 1,
          explanation: "9a² = (3a)² en 4b² = (2b)². Het verschil van kwadraten geeft (3a + 2b)(3a − 2b). Met (3a − 2b)² krijg je 9a² − 12ab + 4b²; dat is een andere veelterm.",
        },
        {
          kind: "choice",
          prompt: "Welke ontbinding van 2x² − 8 is volledig?",
          options: ["2(x² − 4)", "(2x − 4)(2x + 4)", "2(x − 2)(x + 2)"],
          answerIndex: 2,
          explanation: "Je haalt eerst 2 buiten: 2x² − 8 = 2(x² − 4). Ontbind ook x² − 4: je krijgt 2(x − 2)(x + 2). Met (2x − 4)(2x + 4) krijg je 4x² − 16, dus twee keer de oorspronkelijke veelterm.",
        },
      ],
      commonMistakes: [
        {
          mistake: "a² − b² = (a − b)² schrijven",
          why: "Het kwadraat van een verschil bevat een middelste term: (a − b)² = a² − 2ab + b². Bij a² − b² heb je die term niet. Je gebruikt (a + b)(a − b).",
        },
        {
          mistake: "De gemeenschappelijke factor vergeten of te vroeg stoppen",
          why: "2x² − 8 = 2(x² − 4) = 2(x − 2)(x + 2). Je houdt de factor 2 en ontbindt ook het verschil van kwadraten in de haakjes.",
        },
        {
          mistake: "(a + b)² = a² + b² schrijven",
          why: "De middelste term 2ab ontbreekt. Als je (a + b)(a + b) uitwerkt, krijg je a² + ab + ab + b² = a² + 2ab + b².",
        },
        {
          mistake: "Hetzelfde teken in beide haakjes zetten bij een verschil van kwadraten",
          why: "Je hebt (3a + 2b)(3a − 2b) nodig. Als je uitwerkt, krijg je 9a² − 6ab + 6ab − 4b² = 9a² − 4b². Met hetzelfde teken vallen de termen met ab niet weg.",
        },
      ],
    },
  ],
};
