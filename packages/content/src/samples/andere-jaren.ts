import { sample } from "./build";

/** Reviewed by Ali Safari on 2026-11-14 (breinhap#109 follow-up). */
const REVIEW = { by: "Ali Safari", at: "2026-11-14" };

// AI-assisted samples for years 1, 2 and 4, so a student in any year sees at least one example
// (the picker has no richting for these years yet). Reviewed by Ali Safari on 2026-11-14.

export const wiskundeGeheleGetallen = sample({
  reviewed: REVIEW,
  id: "wiskunde-gehele-getallen",
  subject: "wiskunde",
  grade: 1,
  title: "Rekenen met negatieve getallen",
  leerdoel: "De leerlingen rekenen met gehele getallen, ook negatieve.",
  mission: "Onder nul",
  minutes: 4,
  warmup: "Het vriest −3 °C en het wordt 5 graden warmer. Hoe warm is het dan?",
  learn: [
    ["Op de getallenas ligt een negatief getal links van 0. Optellen is naar rechts gaan.", "−3 + 5: start bij −3, ga 5 naar rechts: 2."],
    ["Een getal aftrekken is het tegengestelde optellen.", "4 − (−2) = 4 + 2 = 6"],
    ["Vermenigvuldigen: gelijke tekens geven plus, verschillende tekens geven min.", "(−3) · (−4) = 12 en (−3) · 4 = −12"],
  ],
  practice: [
    { choice: "−7 + 3 = ?", options: ["−10", "−4", "4", "10"], answer: 1, why: "Start bij −7 en ga 3 naar rechts: −4." },
    { choice: "5 − (−3) = ?", options: ["2", "−8", "8", "−2"], answer: 2, why: "−3 aftrekken is 3 optellen: 5 + 3 = 8." },
  ],
  check: [
    { choice: "(−6) · 2 = ?", options: ["12", "−12", "−3", "4"], answer: 1, why: "Verschillende tekens geven min: 6 · 2 = 12, dus −12." },
    { order: "Zet van klein naar groot.", items: ["−5", "−2", "0", "3"], why: "Hoe verder links op de getallenas, hoe kleiner: −5 < −2 < 0 < 3." },
  ],
  mistakes: [["−5 is groter dan −2, want 5 is groter dan 2.", "Bij negatieve getallen is het omgekeerd: −5 ligt verder links, dus −5 is kleiner."]],
});

export const wiskundeVergelijkingen = sample({
  reviewed: REVIEW,
  id: "wiskunde-vergelijkingen-eerste-graad",
  subject: "wiskunde",
  grade: 2,
  title: "Vergelijkingen van de eerste graad oplossen",
  leerdoel: "De leerlingen lossen eenvoudige vergelijkingen van de eerste graad op en controleren de oplossing.",
  mission: "Zoek x",
  minutes: 4,
  warmup: "3 gelijke zakjes snoep en nog 4 losse snoepjes zijn samen 19 snoepjes. Hoeveel zit er in één zakje?",
  learn: [
    "Een vergelijking is een gelijkheid met een onbekende, zoals 3x + 4 = 19.",
    [
      "Je mag in beide leden hetzelfde doen: hetzelfde getal optellen of aftrekken, of beide leden delen door hetzelfde getal (niet 0).",
      "3x + 4 = 19 → 3x = 15 → x = 5",
    ],
    "Controleer altijd door je oplossing in te vullen: 3 · 5 + 4 = 19. Klopt.",
  ],
  practice: [
    { choice: "Los op: x + 7 = 12", options: ["x = 19", "x = 5", "x = −5", "x = 84"], answer: 1, why: "Trek in beide leden 7 af: x = 12 − 7 = 5." },
    { choice: "Los op: 4x = 28", options: ["x = 24", "x = 32", "x = 7", "x = 112"], answer: 2, why: "Deel beide leden door 4: x = 28 : 4 = 7." },
  ],
  check: [
    {
      order: "Los 2x − 3 = 11 op. Zet de stappen in volgorde.",
      items: ["2x − 3 = 11", "2x = 14", "x = 7", "Controle: 2 · 7 − 3 = 11"],
      why: "Tel 3 op in beide leden, deel dan door 2, en controleer door in te vullen.",
    },
  ],
});

export const fysicaEenparigeBeweging = sample({
  reviewed: REVIEW,
  id: "fysica-eenparige-beweging",
  subject: "fysica",
  grade: 4,
  title: "Snelheid bij een eenparige beweging",
  leerdoel: "De leerlingen berekenen de snelheid bij een eenparige rechtlijnige beweging en rekenen m/s om naar km/h.",
  mission: "v = Δx / Δt",
  minutes: 4,
  warmup: "Je fietst naar school aan een constante snelheid. Elke minuut leg je even ver af.",
  learn: [
    "Bij een eenparige rechtlijnige beweging leg je in gelijke tijden gelijke afstanden af: de snelheid is constant.",
    ["Snelheid v = Δx / Δt: de verplaatsing gedeeld door de tijdsduur, in m/s.", "1 800 m in 300 s: v = 1 800 / 300 = 6 m/s"],
    ["Van m/s naar km/h vermenigvuldig je met 3,6.", "6 m/s · 3,6 = 21,6 km/h"],
  ],
  practice: [
    {
      choice: "Een loper legt 100 m af in 20 s aan constante snelheid. Hoe groot is v?",
      options: ["2 m/s", "5 m/s", "20 m/s", "2 000 m/s"],
      answer: 1,
      why: "v = 100 m / 20 s = 5 m/s.",
    },
    {
      choice: "Hoeveel is 10 m/s in km/h?",
      options: ["2,8 km/h", "36 km/h", "100 km/h", "3,6 km/h"],
      answer: 1,
      why: "10 · 3,6 = 36 km/h.",
    },
  ],
  check: [
    {
      choice: "Een trein rijdt 2 uur aan 90 km/h. Welke afstand legt hij af?",
      options: ["45 km", "92 km", "180 km", "90 km"],
      answer: 2,
      why: "Δx = v · Δt = 90 km/h · 2 h = 180 km.",
    },
  ],
  mistakes: [["Van m/s naar km/h deel je door 3,6.", "Andersom: km/h is het grotere getal. Van m/s naar km/h vermenigvuldig je met 3,6."]],
});
