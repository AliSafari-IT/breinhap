import type { LearningObjectInput } from "../schema";

// Draft sample: AI-assisted, not yet reviewed by a teacher.
export const wiskundeMerkwaardigeProducten: LearningObjectInput = {
  schemaVersion: 1,
  id: "wiskunde-merkwaardige-producten",
  subject: "wiskunde",
  title: "Merkwaardige producten",
  grade: 3,
  curriculum: {
    leerdoel: "De leerlingen werken merkwaardige producten uit en herkennen ze.",
  },
  review: { status: "draft" },
  missions: [
    {
      id: "wis-kwadraat-van-een-som",
      title: "Het kwadraat van een som",
      minutes: 5,
      warmup: {
        text: "Hoeveel is (3 + 2)²? Reken eerst wat tussen de haakjes staat: 5² = 25.",
      },
      learn: [
        {
          text: "Met letters kun je niet eerst optellen. Daarom gebruik je de regel: (a + b)² = a² + 2ab + b².",
        },
        {
          text: "Controle met getallen: (3 + 2)² = 3² + 2·3·2 + 2² = 9 + 12 + 4 = 25. Klopt.",
        },
        {
          text: "Zo werk je het uit: (x + 3)² = x² + 2·x·3 + 3² = x² + 6x + 9.",
        },
      ],
      practice: [
        {
          kind: "choice",
          prompt: "Werk uit: (x + 4)²",
          options: ["x² + 16", "x² + 4x + 16", "x² + 8x + 16"],
          answerIndex: 2,
          explanation: "2·x·4 = 8x. Dus (x + 4)² = x² + 8x + 16.",
        },
        {
          kind: "order",
          prompt: "Zet de stappen om (a + 5)² uit te werken in de juiste volgorde.",
          items: ["Kwadraat van de eerste term: a²", "Dubbel product: 2·a·5 = 10a", "Kwadraat van de tweede term: 5² = 25", "Samen: a² + 10a + 25"],
          explanation: "Eerste term in het kwadraat, dan het dubbel product, dan de tweede term in het kwadraat, en dan alles samen.",
        },
      ],
      check: [
        {
          kind: "choice",
          prompt: "Werk uit: (2x + 1)²",
          options: ["4x² + 4x + 1", "2x² + 4x + 1", "4x² + 1"],
          answerIndex: 0,
          explanation: "(2x)² = 4x² en 2·2x·1 = 4x. Dus 4x² + 4x + 1.",
        },
      ],
      commonMistakes: [
        {
          mistake: "(a + b)² = a² + b²",
          why: "Dan vergeet je het dubbel product 2ab. Test met getallen: (3 + 2)² = 25, maar 3² + 2² = 13.",
        },
      ],
    },
  ],
};
