import { draftSample } from "./build";

// AI-assisted samples for 5/6 Economie-wiskunde: one per vak with content, so every course in the
// picker has an example. Drafts until a person reviews them (wiskunde 5 is wiskunde-samengestelde-intrest).

export const economieVraagAanbod = draftSample({
  id: "economie-vraag-en-aanbod",
  subject: "economie",
  grade: 5,
  title: "Vraag, aanbod en de evenwichtsprijs",
  leerdoel: "De leerlingen verklaren hoe vraag en aanbod samen de marktprijs bepalen.",
  mission: "Hoe een markt zijn prijs vindt",
  minutes: 4,
  warmup: "Als concerttickets plots goedkoper worden, willen meer mensen er een kopen. Dat is de vraag die reageert op de prijs.",
  learn: [
    "De vraag is hoeveel kopers willen kopen bij elke prijs. Stijgt de prijs, dan daalt de gevraagde hoeveelheid.",
    "Het aanbod is hoeveel verkopers willen verkopen bij elke prijs. Stijgt de prijs, dan stijgt de aangeboden hoeveelheid.",
    [
      "Het marktevenwicht ligt waar de gevraagde en de aangeboden hoeveelheid gelijk zijn. Die prijs heet de evenwichtsprijs.",
      "Bij €4 vragen kopers 300 stuks en bieden verkopers 300 stuks aan: €4 is de evenwichtsprijs.",
    ],
  ],
  practice: [
    {
      choice: "De prijs ligt boven de evenwichtsprijs. Wat ontstaat er?",
      options: ["Een vraagoverschot", "Een aanbodoverschot", "Evenwicht"],
      answer: 1,
      why: "Boven de evenwichtsprijs bieden verkopers meer aan dan kopers vragen. Er blijft aanbod over, en de prijs zakt.",
    },
    {
      choice: "Wat gebeurt er met de gevraagde hoeveelheid als de prijs stijgt (en de rest gelijk blijft)?",
      options: ["Ze stijgt", "Ze daalt", "Ze blijft gelijk"],
      answer: 1,
      why: "Bij een hogere prijs willen kopers minder kopen. De vraagcurve daalt.",
    },
  ],
  check: [
    {
      order: "De prijs ligt onder het evenwicht. Zet de gevolgen in volgorde.",
      items: [
        "Kopers vragen meer dan er wordt aangeboden",
        "Er ontstaat een tekort (vraagoverschot)",
        "De prijs stijgt",
        "Vraag en aanbod komen weer in evenwicht",
      ],
      why: "Een tekort duwt de prijs omhoog tot vraag en aanbod weer gelijk zijn.",
    },
  ],
  mistakes: [
    [
      "Een hogere prijs verschuift de vraagcurve.",
      "Een prijsverandering is een beweging langs de curve. De curve zelf verschuift pas door iets anders, zoals een hoger inkomen.",
    ],
  ],
});

export const nederlandsDrogredenen = draftSample({
  id: "nederlands-drogredenen",
  subject: "nederlands",
  grade: 5,
  title: "Drogredenen herkennen",
  leerdoel: "De leerlingen herkennen veelvoorkomende drogredenen in een betoog.",
  mission: "Stroman, op de persoon, hellend vlak",
  minutes: 4,
  warmup: "Een argument kan overtuigend klinken en toch niet kloppen. Zo'n redenering heet een drogreden.",
  learn: [
    ["Op de persoon spelen: je valt de spreker aan in plaats van het argument.", "'Wat weet een student nu over belastingen?'"],
    [
      "Stroman: je geeft het standpunt van de ander verdraaid of overdreven weer, en valt dat aan.",
      "'We moeten minder vlees eten.' — 'Dus jij wil vlees verbieden?'",
    ],
    "Hellend vlak: je beweert zonder bewijs dat één kleine stap vanzelf tot een reeks rampen leidt.",
  ],
  practice: [
    {
      choice: "'Jij wil een uur later beginnen? Dan wil je zeker helemaal niet meer naar school.' Welke drogreden is dit?",
      options: ["Stroman", "Op de persoon spelen", "Geen drogreden"],
      answer: 0,
      why: "Het standpunt 'een uur later beginnen' wordt overdreven tot 'niet meer naar school willen'. Dat is een stroman.",
    },
    {
      choice: "'Wat weet zij nu over het klimaat? Ze is pas zestien.' Welke drogreden is dit?",
      options: ["Stroman", "Op de persoon spelen", "Geen drogreden"],
      answer: 1,
      why: "De leeftijd van de spreker zegt niets over haar argument. Dit is op de persoon spelen.",
    },
  ],
  check: [
    {
      choice: "'Als we vandaag één vak schrappen, schrappen ze morgen alle vakken en is de school straks leeg.' Welke drogreden?",
      options: ["Stroman", "Op de persoon spelen", "Hellend vlak"],
      answer: 2,
      why: "Zonder bewijs leidt één stap hier tot een ramp. Dat is een hellend vlak.",
    },
  ],
});

export const fransSubjonctif = draftSample({
  id: "frans-subjonctif-present",
  subject: "frans",
  grade: 5,
  title: "Le subjonctif présent na 'il faut que'",
  leerdoel: "De leerlingen vormen en gebruiken de subjonctif présent na 'il faut que'.",
  mission: "Il faut que tu…",
  minutes: 4,
  warmup: "'Il faut que tu viennes.' Na 'il faut que' komt in het Frans een aparte vorm: de subjonctif.",
  learn: [
    "Na 'il faut que' gebruik je altijd de subjonctif.",
    [
      "Regelmatig: neem de stam van 'ils' in de présent en voeg toe: -e, -es, -e, -ions, -iez, -ent.",
      "ils finissent → que je finisse, que tu finisses",
    ],
    "Onregelmatig, uit het hoofd: être → que je sois, avoir → que j'aie, faire → que je fasse, aller → que j'aille.",
  ],
  practice: [
    {
      choice: "Il faut que tu ___ (parler) plus lentement.",
      options: ["parles", "parlais", "parleras", "parlé"],
      answer: 0,
      why: "Stam parl- (ils parlent) + -es: que tu parles.",
    },
    {
      choice: "Il faut que nous ___ (être) à l'heure.",
      options: ["sommes", "soyons", "serons", "étions"],
      answer: 1,
      why: "Être is onregelmatig: que nous soyons.",
    },
  ],
  check: [
    {
      choice: "Il faut qu'elle ___ (faire) ses devoirs.",
      options: ["fait", "faisait", "fasse", "fera"],
      answer: 2,
      why: "Faire is onregelmatig in de subjonctif: qu'elle fasse.",
    },
  ],
});

export const engelsPresentPerfect = draftSample({
  id: "engels-present-perfect-past-simple",
  subject: "engels",
  grade: 5,
  title: "Present perfect or past simple?",
  leerdoel: "De leerlingen kiezen correct tussen de present perfect en de past simple.",
  mission: "Yesterday, since, ever",
  minutes: 4,
  warmup: "'I lived in Gent' en 'I have lived in Gent' betekenen niet hetzelfde. De tijd hangt af van wanneer het gebeurde.",
  learn: [
    "Past simple: iets op een afgelopen moment dat je noemt of bedoelt (yesterday, last week, in 2020).",
    [
      "Present perfect (have/has + voltooid deelwoord): een ervaring of iets dat tot nu doorloopt, zonder afgelopen tijdstip (ever, never, already, since, for).",
      "I have lived here since 2019. / I lived in Gent in 2018.",
    ],
  ],
  practice: [
    {
      choice: "I ___ my keys yesterday.",
      options: ["have lost", "lost", "have lose", "lose"],
      answer: 1,
      why: "'Yesterday' is een afgelopen moment: past simple, lost.",
    },
    {
      choice: "She ___ in Brussels since 2021.",
      options: ["lives", "lived", "has lived", "is living"],
      answer: 2,
      why: "'Since' loopt tot nu door: present perfect, has lived.",
    },
  ],
  check: [
    {
      choice: "___ you ever ___ sushi?",
      options: ["Did / eat", "Have / eaten", "Have / ate", "Do / eaten"],
      answer: 1,
      why: "'Ever' vraagt naar een ervaring tot nu: Have you ever eaten…? Eaten is het voltooid deelwoord.",
    },
  ],
});

export const geschiedenisFranseRevolutie = draftSample({
  id: "geschiedenis-franse-revolutie",
  subject: "geschiedenis",
  grade: 5,
  title: "De Franse Revolutie",
  leerdoel: "De leerlingen ordenen de belangrijkste gebeurtenissen van de Franse Revolutie in de tijd.",
  mission: "Van Bastille tot Napoleon",
  minutes: 4,
  warmup: "In 1789 had Frankrijk een grote staatsschuld en duur brood. De koning riep de Staten-Generaal samen.",
  learn: [
    "Juni 1789: de derde stand vormde de Nationale Vergadering. Op 14 juli 1789 bestormde het volk de Bastille.",
    "Augustus 1789: de Verklaring van de Rechten van de Mens en de Burger zegt dat mensen vrij en gelijk in rechten geboren worden.",
    "1792: Frankrijk werd een republiek. In 1793 werd koning Lodewijk XVI terechtgesteld. In 1799 greep Napoleon de macht.",
  ],
  practice: [
    {
      choice: "Wat gebeurde er op 14 juli 1789?",
      options: ["De bestorming van de Bastille", "De terechtstelling van Lodewijk XVI", "De staatsgreep van Napoleon"],
      answer: 0,
      why: "Op 14 juli 1789 bestormde het volk de Bastille. Lodewijk XVI stierf in 1793, Napoleon greep de macht in 1799.",
    },
    {
      choice: "Welke tekst uit 1789 zegt dat mensen vrij en gelijk in rechten geboren worden?",
      options: ["De Code Napoléon", "De Verklaring van de Rechten van de Mens en de Burger", "Het Edict van Nantes"],
      answer: 1,
      why: "Dat is de Verklaring van de Rechten van de Mens en de Burger (augustus 1789).",
    },
  ],
  check: [
    {
      order: "Zet in de juiste volgorde.",
      items: [
        "Samenroepen van de Staten-Generaal",
        "Bestorming van de Bastille",
        "Uitroepen van de republiek",
        "Staatsgreep van Napoleon",
      ],
      why: "Staten-Generaal (mei 1789), Bastille (juli 1789), republiek (1792), Napoleon (1799).",
    },
  ],
});

export const aardrijkskundePlaatgrenzen = draftSample({
  id: "aardrijkskunde-plaatgrenzen",
  subject: "aardrijkskunde",
  grade: 5,
  title: "Platentektoniek: drie soorten plaatgrenzen",
  leerdoel: "De leerlingen onderscheiden divergente, convergente en transforme plaatgrenzen.",
  mission: "Uit elkaar, naar elkaar, langs elkaar",
  minutes: 4,
  warmup: "De aardkorst bestaat uit platen die elk jaar enkele centimeters bewegen. Aan hun grenzen gebeurt het meeste.",
  learn: [
    ["Divergente grens: platen bewegen uit elkaar. Magma komt omhoog en vormt nieuwe korst.", "De Mid-Atlantische Rug, met IJsland erop."],
    [
      "Convergente grens: platen bewegen naar elkaar. Een oceanische plaat duikt onder een andere (subductie), met vulkanen en zware aardbevingen.",
      "De Andes in Zuid-Amerika.",
    ],
    ["Transforme grens: platen schuiven langs elkaar. Dat geeft aardbevingen, maar weinig vulkanen.", "De San Andreasbreuk in Californië."],
  ],
  practice: [
    {
      choice: "Wat gebeurt er bij een divergente plaatgrens?",
      options: ["Platen schuiven langs elkaar", "Platen bewegen uit elkaar", "Een plaat duikt onder een andere"],
      answer: 1,
      why: "Divergent betekent uiteen: de platen bewegen uit elkaar en er ontstaat nieuwe korst.",
    },
    {
      choice: "De San Andreasbreuk is een voorbeeld van een…",
      options: ["divergente grens", "convergente grens", "transforme grens"],
      answer: 2,
      why: "Daar schuiven de Pacifische en de Noord-Amerikaanse plaat langs elkaar: een transforme grens.",
    },
  ],
  check: [
    {
      order: "Zet de stappen van subductie in volgorde.",
      items: [
        "Een oceanische en een continentale plaat bewegen naar elkaar",
        "De zwaardere oceanische plaat duikt onder de continentale",
        "Diep in de mantel smelt gesteente",
        "Magma stijgt op en vormt vulkanen",
      ],
      why: "De zware oceanische plaat zakt weg, smelt gedeeltelijk, en dat magma voedt de vulkanen erboven.",
    },
  ],
});

export const wiskundeNormaleVerdeling = draftSample({
  id: "wiskunde-normale-verdeling",
  subject: "wiskunde",
  grade: 6,
  title: "De normale verdeling: de 68-95-99,7-regel",
  leerdoel: "De leerlingen gebruiken de vuistregel van de normale verdeling om kansen te schatten.",
  mission: "Hoeveel ligt binnen één, twee, drie σ?",
  minutes: 5,
  warmup: "Lengtes, testscores en vulgewichten liggen vaak rond een gemiddelde, met minder uitschieters naar boven en beneden. Dat geeft een klokvorm.",
  learn: [
    "Een normale verdeling heeft een gemiddelde μ en een standaardafwijking σ. De klok is symmetrisch rond μ.",
    [
      "Ongeveer 68% ligt tussen μ − σ en μ + σ. Ongeveer 95% tussen μ − 2σ en μ + 2σ. Ongeveer 99,7% tussen μ − 3σ en μ + 3σ.",
      "Lengte met μ = 170 cm en σ = 8 cm: ongeveer 95% is tussen 154 en 186 cm.",
    ],
    "Door de symmetrie ligt wat buiten een interval voor de helft boven en voor de helft onder.",
  ],
  practice: [
    {
      choice: "IQ heeft μ = 100 en σ = 15. Welk percentage ligt ongeveer tussen 85 en 115?",
      options: ["50%", "68%", "95%", "99,7%"],
      answer: 1,
      why: "85 en 115 zijn μ − σ en μ + σ. Daartussen ligt ongeveer 68%.",
    },
    {
      choice: "Dezelfde IQ-verdeling. Welk percentage scoort ongeveer hoger dan 130?",
      options: ["2,5%", "5%", "16%", "0,15%"],
      answer: 0,
      why: "130 is μ + 2σ. Binnen 2σ ligt 95%, buiten 5%. Door de symmetrie ligt de helft daarvan boven: 2,5%.",
    },
  ],
  check: [
    {
      choice: "Een machine vult flessen met μ = 500 ml en σ = 4 ml. Tussen welke waarden ligt ongeveer 99,7%?",
      options: ["496 en 504 ml", "492 en 508 ml", "488 en 512 ml", "480 en 520 ml"],
      answer: 2,
      why: "99,7% ligt binnen 3σ: 500 − 12 = 488 en 500 + 12 = 512 ml.",
    },
  ],
});

export const economieInflatie = draftSample({
  id: "economie-inflatie-koopkracht",
  subject: "economie",
  grade: 6,
  title: "Inflatie en koopkracht",
  leerdoel: "De leerlingen leggen uit wat inflatie is en hoe ze de koopkracht beïnvloedt.",
  mission: "Waarom je loon minder waard kan worden",
  minutes: 4,
  warmup: "Een broodje kostte vroeger €2 en nu €2,50. Als bijna alles duurder wordt, spreken we van inflatie.",
  learn: [
    "Inflatie is een algemene stijging van het prijspeil. In België meet men ze met de consumptieprijsindex.",
    [
      "Koopkracht is wat je met je inkomen kunt kopen. Stijgt je loon minder snel dan de prijzen, dan daalt je koopkracht.",
      "Loon +2%, prijzen +5%: je koopkracht daalt met ongeveer 3%.",
    ],
    "In België worden lonen en uitkeringen automatisch aangepast aan de index. De Europese Centrale Bank mikt op 2% inflatie en kan de rente verhogen om inflatie af te remmen.",
  ],
  practice: [
    {
      choice: "Je loon stijgt met 3% en de prijzen ook met 3%. Wat gebeurt er met je koopkracht?",
      options: ["Ze stijgt", "Ze daalt", "Ze blijft ongeveer gelijk"],
      answer: 2,
      why: "Loon en prijzen stijgen even snel, dus je kunt ongeveer evenveel kopen als voordien.",
    },
    {
      choice: "Wat doet de ECB meestal als de inflatie te hoog is?",
      options: ["De rente verhogen", "De rente verlagen", "Meer bankbiljetten drukken"],
      answer: 0,
      why: "Een hogere rente maakt lenen duurder. Er wordt minder uitgegeven, en dat remt de prijsstijging af.",
    },
  ],
  check: [
    {
      choice: "Met welke index meet België de inflatie?",
      options: ["De BEL20", "De consumptieprijsindex", "Het bruto binnenlands product"],
      answer: 1,
      why: "De consumptieprijsindex volgt de prijzen van een korf goederen en diensten. De BEL20 is een beursindex.",
    },
  ],
});

export const nederlandsCiterenParafraseren = draftSample({
  id: "nederlands-citeren-parafraseren",
  subject: "nederlands",
  grade: 6,
  title: "Citeren, parafraseren en bronnen vermelden",
  leerdoel: "De leerlingen gebruiken informatie uit bronnen correct door te citeren of te parafraseren met bronvermelding.",
  mission: "Andermans woorden, jouw tekst",
  minutes: 4,
  warmup: "Voor een paper of je eindwerk gebruik je bronnen. Hoe je die verwerkt, bepaalt of je tekst eerlijk is.",
  learn: [
    "Citeren: je neemt de tekst letterlijk over, tussen aanhalingstekens, en je vermeldt de bron.",
    "Parafraseren: je zegt hetzelfde in je eigen woorden. Ook dan vermeld je de bron, want het idee is niet van jou.",
    "Wie andermans tekst of idee gebruikt zonder bron, pleegt plagiaat.",
  ],
  practice: [
    {
      choice: "Je neemt één zin letterlijk over uit een artikel. Wat moet je doen?",
      options: ["Niets, het is maar één zin", "Aanhalingstekens én bronvermelding", "Alleen de bron in de bibliografie"],
      answer: 1,
      why: "Een letterlijke overname is een citaat: aanhalingstekens tonen wat niet van jou is, en de bron zegt van wie het is.",
    },
    {
      choice: "Je vat een idee van een auteur samen in je eigen woorden. Moet je de bron vermelden?",
      options: ["Ja, het idee is van de auteur", "Nee, de woorden zijn van jou"],
      answer: 0,
      why: "Bij een parafrase zijn de woorden van jou, maar het idee niet. Zonder bron is het plagiaat.",
    },
  ],
  check: [
    {
      order: "Zet de stappen voor een goede parafrase in volgorde.",
      items: [
        "Lees de passage tot je ze begrijpt",
        "Leg de tekst weg en schrijf het idee in je eigen woorden",
        "Vergelijk met het origineel: klopt de inhoud?",
        "Vermeld de bron",
      ],
      why: "Eerst begrijpen, dan zonder de tekst herschrijven, dan controleren, en altijd de bron vermelden.",
    },
  ],
});

export const fransPasseSimple = draftSample({
  id: "frans-passe-simple",
  subject: "frans",
  grade: 6,
  title: "Le passé simple herkennen",
  leerdoel: "De leerlingen herkennen de passé simple in verhalende teksten en begrijpen de betekenis.",
  mission: "Il fut, il eut, il fit",
  minutes: 4,
  warmup: "In romans en sprookjes staat vaak een verleden tijd die je in gesprekken nooit hoort: de passé simple.",
  learn: [
    "De passé simple vind je vooral in geschreven verhalen. Je moet hem vooral herkennen, niet zelf gebruiken.",
    ["Werkwoorden op -er: il parla, ils parlèrent. Op -ir en -re: il finit, il vendit.", "Il entra et regarda la salle."],
    "Onregelmatig: être → il fut, avoir → il eut, faire → il fit, venir → il vint.",
  ],
  practice: [
    {
      choice: "'Il fut très surpris.' Van welk werkwoord komt 'fut'?",
      options: ["faire", "être", "falloir", "finir"],
      answer: 1,
      why: "Fut is de passé simple van être: il fut = il a été.",
    },
    {
      choice: "'Ils arrivèrent à Paris.' Wat is dat in de passé composé?",
      options: ["Ils arrivent", "Ils sont arrivés", "Ils arrivaient", "Ils arriveront"],
      answer: 1,
      why: "Arrivèrent is de passé simple van arriver. In de passé composé: ils sont arrivés.",
    },
  ],
  check: [
    {
      choice: "'Elle eut peur.' Wat betekent dit?",
      options: ["Ze heeft angst", "Ze werd bang", "Ze zal bang zijn"],
      answer: 1,
      why: "Eut is de passé simple van avoir: een afgelopen moment in het verhaal. Elle eut peur = ze werd (kreeg) bang.",
    },
  ],
});

export const engelsConditionals = draftSample({
  id: "engels-second-third-conditional",
  subject: "engels",
  grade: 6,
  title: "Second and third conditional",
  leerdoel: "De leerlingen gebruiken de second en third conditional voor denkbeeldige situaties.",
  mission: "If I were… / If I had…",
  minutes: 4,
  warmup: "'If I had more time…' en 'If I had studied…' gaan allebei over iets wat niet zo is. Maar het ene gaat over nu, het andere over vroeger.",
  learn: [
    [
      "Second conditional: een denkbeeldige situatie nu. If + past simple, would + infinitief.",
      "If I had more time, I would learn Spanish.",
    ],
    [
      "Third conditional: een denkbeeldige situatie in het verleden, die niet gebeurd is. If + past perfect, would have + voltooid deelwoord.",
      "If I had studied, I would have passed.",
    ],
  ],
  practice: [
    {
      choice: "If I ___ rich, I would travel the world.",
      options: ["am", "were", "had been", "will be"],
      answer: 1,
      why: "Denkbeeldig nu: second conditional met de past simple. Bij 'to be' is 'were' de correcte vorm.",
    },
    {
      choice: "If she had left earlier, she ___ the train.",
      options: ["would catch", "will catch", "would have caught", "caught"],
      answer: 2,
      why: "'Had left' is past perfect: third conditional, dus would have + voltooid deelwoord: would have caught.",
    },
  ],
  check: [
    {
      choice: "Welke zin gaat over iets in het verleden dat niet gebeurd is?",
      options: ["If it rains, we stay inside.", "If I won the lottery, I would buy a house.", "If we had known, we would have come."],
      answer: 2,
      why: "If + past perfect en would have + voltooid deelwoord: een third conditional over het verleden.",
    },
  ],
});

export const geschiedenisKoudeOorlog = draftSample({
  id: "geschiedenis-koude-oorlog",
  subject: "geschiedenis",
  grade: 6,
  title: "De Koude Oorlog",
  leerdoel: "De leerlingen situeren de belangrijkste crisissen van de Koude Oorlog in de tijd.",
  mission: "Van luchtbrug tot val van de Muur",
  minutes: 4,
  warmup: "Na 1945 stonden de VS en de Sovjet-Unie tegenover elkaar: democratie en kapitalisme tegenover communisme.",
  learn: [
    "Ze vochten nooit rechtstreeks tegen elkaar. Daarom heet het een 'koude' oorlog.",
    "1948–1949: de Sovjet-Unie blokkeerde West-Berlijn. De westerse geallieerden bevoorraadden de stad via een luchtbrug.",
    "1961: de Berlijnse Muur werd gebouwd. 1962: de Cubacrisis, over Sovjetkernraketten op Cuba, bracht de wereld dicht bij een kernoorlog.",
    "1989: de Berlijnse Muur viel. In 1991 hield de Sovjet-Unie op te bestaan.",
  ],
  practice: [
    {
      choice: "Waarom heet het een 'koude' oorlog?",
      options: ["Hij speelde zich af in Siberië", "De supermachten vochten niet rechtstreeks tegen elkaar", "Hij duurde maar één winter"],
      answer: 1,
      why: "De VS en de Sovjet-Unie voerden nooit rechtstreeks oorlog tegen elkaar, wel via dreiging, wapenwedloop en conflicten elders.",
    },
    {
      choice: "Waarover ging de Cubacrisis van 1962?",
      options: ["Sovjetkernraketten op Cuba", "Een burgeroorlog in Berlijn", "Het einde van de Sovjet-Unie"],
      answer: 0,
      why: "De Sovjet-Unie plaatste kernraketten op Cuba, vlak bij de VS. Na dertien spannende dagen werden ze teruggetrokken.",
    },
  ],
  check: [
    {
      order: "Zet in de juiste volgorde.",
      items: ["Berlijnse blokkade en luchtbrug", "Bouw van de Berlijnse Muur", "Cubacrisis", "Val van de Berlijnse Muur"],
      why: "Blokkade (1948–1949), Muur (1961), Cubacrisis (1962), val van de Muur (1989).",
    },
  ],
});

export const aardrijkskundeDemografischeTransitie = draftSample({
  id: "aardrijkskunde-demografische-transitie",
  subject: "aardrijkskunde",
  grade: 6,
  title: "Het model van de demografische transitie",
  leerdoel: "De leerlingen beschrijven de fasen van de demografische transitie en hun oorzaken.",
  mission: "Geboorte, sterfte en groei",
  minutes: 4,
  warmup: "Waarom groeit de bevolking in sommige landen snel en in andere bijna niet? Het model van de demografische transitie helpt het uitleggen.",
  learn: [
    "Fase 1: hoge geboorte en hoge sterfte. De bevolking groeit nauwelijks.",
    "Fase 2: de sterfte daalt door betere voeding, hygiëne en geneeskunde. De geboorte blijft hoog, dus de bevolking groeit snel.",
    ["Fase 3: ook de geboorte daalt (onderwijs, verstedelijking, anticonceptie). Fase 4: geboorte en sterfte zijn laag, de bevolking is stabiel.", "België zit in fase 4."],
  ],
  practice: [
    {
      choice: "In welke fase groeit de bevolking het snelst?",
      options: ["Fase 1", "Fase 2", "Fase 4"],
      answer: 1,
      why: "In fase 2 sterven er veel minder mensen, maar worden er nog evenveel kinderen geboren.",
    },
    {
      choice: "Waarom daalt de sterfte in fase 2?",
      options: ["Er worden minder kinderen geboren", "Betere voeding, hygiëne en geneeskunde", "Mensen verhuizen naar het buitenland"],
      answer: 1,
      why: "Betere voeding, proper drinkwater en geneeskunde laten mensen langer leven.",
    },
  ],
  check: [
    {
      order: "Zet de fasen in volgorde.",
      items: ["Hoge geboorte, hoge sterfte", "Sterfte daalt, geboorte blijft hoog", "Ook de geboorte daalt", "Lage geboorte, lage sterfte"],
      why: "Eerst daalt de sterfte, pas later de geboorte. Daartussen groeit de bevolking snel.",
    },
  ],
});
