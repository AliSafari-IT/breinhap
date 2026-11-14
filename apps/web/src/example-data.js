// Generated from packages/content by scripts/web-example.ts. Do not edit; run:
//   pnpm --filter @breinhap/content exec tsx scripts/web-example.ts
globalThis.BreinhapData = {
 "schools": [
  {
   "id": "sint-martinusscholen-herk-de-stad",
   "name": "Sint-Martinusscholen",
   "city": "Herk-de-Stad",
   "postcode": "3540",
   "richtingen": [
    "economie-wiskunde"
   ]
  }
 ],
 "richtingen": [
  {
   "id": "economie-wiskunde",
   "label": "Economie-wiskunde",
   "years": [
    5,
    6
   ],
   "courses": [
    {
     "id": "wiskunde",
     "label": "Wiskunde",
     "subject": "wiskunde"
    },
    {
     "id": "economie",
     "label": "Economie",
     "subject": "economie"
    },
    {
     "id": "nederlands",
     "label": "Nederlands",
     "subject": "nederlands"
    },
    {
     "id": "frans",
     "label": "Frans",
     "subject": "frans"
    },
    {
     "id": "engels",
     "label": "Engels",
     "subject": "engels"
    },
    {
     "id": "duits",
     "label": "Duits"
    },
    {
     "id": "geschiedenis",
     "label": "Geschiedenis",
     "subject": "geschiedenis"
    },
    {
     "id": "aardrijkskunde",
     "label": "Aardrijkskunde",
     "subject": "aardrijkskunde"
    },
    {
     "id": "natuurwetenschappen",
     "label": "Natuurwetenschappen"
    },
    {
     "id": "godsdienst",
     "label": "Godsdienst"
    },
    {
     "id": "lichamelijke-opvoeding",
     "label": "Lichamelijke opvoeding"
    }
   ]
  }
 ],
 "subjectLabel": {
  "wiskunde": "Wiskunde",
  "biologie": "Biologie",
  "chemie": "Chemie",
  "fysica": "Fysica",
  "nederlands": "Nederlands",
  "engels": "Engels",
  "frans": "Frans",
  "aardrijkskunde": "Aardrijkskunde",
  "geschiedenis": "Geschiedenis",
  "economie": "Economie",
  "digitale-vaardigheden": "Digitale vaardigheden"
 },
 "objects": [
  {
   "schemaVersion": 1,
   "id": "aardrijkskunde-demografische-transitie",
   "subject": "aardrijkskunde",
   "title": "Het model van de demografische transitie",
   "grade": 6,
   "curriculum": {
    "leerdoel": "De leerlingen beschrijven de fasen van de demografische transitie en hun oorzaken.",
    "references": []
   },
   "missions": [
    {
     "id": "aardrijkskunde-demografische-transitie-1",
     "title": "Geboorte, sterfte en groei",
     "minutes": 4,
     "warmup": {
      "text": "Waarom groeit de bevolking in sommige landen snel en in andere bijna niet? Het model van de demografische transitie helpt het uitleggen."
     },
     "learn": [
      {
       "text": "Fase 1: hoge geboorte en hoge sterfte. De bevolking groeit nauwelijks."
      },
      {
       "text": "Fase 2: de sterfte daalt door betere voeding, hygiëne en geneeskunde. De geboorte blijft hoog, dus de bevolking groeit snel."
      },
      {
       "text": "Fase 3: ook de geboorte daalt (onderwijs, verstedelijking, anticonceptie). Fase 4: geboorte en sterfte zijn laag, de bevolking is stabiel.",
       "example": "België zit in fase 4."
      }
     ],
     "practice": [
      {
       "kind": "choice",
       "prompt": "In welke fase groeit de bevolking het snelst?",
       "options": [
        "Fase 1",
        "Fase 2",
        "Fase 4"
       ],
       "answerIndex": 1,
       "explanation": "In fase 2 sterven er veel minder mensen, maar worden er nog evenveel kinderen geboren."
      },
      {
       "kind": "choice",
       "prompt": "Waarom daalt de sterfte in fase 2?",
       "options": [
        "Er worden minder kinderen geboren",
        "Betere voeding, hygiëne en geneeskunde",
        "Mensen verhuizen naar het buitenland"
       ],
       "answerIndex": 1,
       "explanation": "Betere voeding, proper drinkwater en geneeskunde laten mensen langer leven."
      }
     ],
     "check": [
      {
       "kind": "order",
       "prompt": "Zet de fasen in volgorde.",
       "items": [
        "Hoge geboorte, hoge sterfte",
        "Sterfte daalt, geboorte blijft hoog",
        "Ook de geboorte daalt",
        "Lage geboorte, lage sterfte"
       ],
       "explanation": "Eerst daalt de sterfte, pas later de geboorte. Daartussen groeit de bevolking snel."
      }
     ],
     "commonMistakes": []
    }
   ]
  },
  {
   "schemaVersion": 1,
   "id": "aardrijkskunde-plaatgrenzen",
   "subject": "aardrijkskunde",
   "title": "Platentektoniek: drie soorten plaatgrenzen",
   "grade": 5,
   "curriculum": {
    "leerdoel": "De leerlingen onderscheiden divergente, convergente en transforme plaatgrenzen.",
    "references": []
   },
   "missions": [
    {
     "id": "aardrijkskunde-plaatgrenzen-1",
     "title": "Uit elkaar, naar elkaar, langs elkaar",
     "minutes": 4,
     "warmup": {
      "text": "De aardkorst bestaat uit platen die elk jaar enkele centimeters bewegen. Aan hun grenzen gebeurt het meeste."
     },
     "learn": [
      {
       "text": "Divergente grens: platen bewegen uit elkaar. Magma komt omhoog en vormt nieuwe korst.",
       "example": "De Mid-Atlantische Rug, met IJsland erop."
      },
      {
       "text": "Convergente grens: platen bewegen naar elkaar. Een oceanische plaat duikt onder een andere (subductie), met vulkanen en zware aardbevingen.",
       "example": "De Andes in Zuid-Amerika."
      },
      {
       "text": "Transforme grens: platen schuiven langs elkaar. Dat geeft aardbevingen, maar weinig vulkanen.",
       "example": "De San Andreasbreuk in Californië."
      }
     ],
     "practice": [
      {
       "kind": "choice",
       "prompt": "Wat gebeurt er bij een divergente plaatgrens?",
       "options": [
        "Platen schuiven langs elkaar",
        "Platen bewegen uit elkaar",
        "Een plaat duikt onder een andere"
       ],
       "answerIndex": 1,
       "explanation": "Divergent betekent uiteen: de platen bewegen uit elkaar en er ontstaat nieuwe korst."
      },
      {
       "kind": "choice",
       "prompt": "De San Andreasbreuk is een voorbeeld van een…",
       "options": [
        "divergente grens",
        "convergente grens",
        "transforme grens"
       ],
       "answerIndex": 2,
       "explanation": "Daar schuiven de Pacifische en de Noord-Amerikaanse plaat langs elkaar: een transforme grens."
      }
     ],
     "check": [
      {
       "kind": "order",
       "prompt": "Zet de stappen van subductie in volgorde.",
       "items": [
        "Een oceanische en een continentale plaat bewegen naar elkaar",
        "De zwaardere oceanische plaat duikt onder de continentale",
        "De dalende plaat geeft water af aan de mantel erboven, die daardoor gedeeltelijk smelt",
        "Magma stijgt op en vormt vulkanen"
       ],
       "explanation": "De dalende oceanische plaat smelt zelf meestal niet. Ze geeft water af, en daardoor smelt de mantel erboven gedeeltelijk. Dat magma voedt de vulkanen."
      }
     ],
     "commonMistakes": []
    }
   ]
  },
  {
   "schemaVersion": 1,
   "id": "biologie-prikkel-reactie-planten",
   "subject": "biologie",
   "title": "Prikkel, receptor, conductor, reactie bij planten",
   "grade": 3,
   "curriculum": {
    "leerdoel": "De leerlingen tonen aan dat plantaardige en dierlijke organismen als systeem functioneren.",
    "references": []
   },
   "missions": [
    {
     "id": "bio-prikkel-reactie-volgorde",
     "title": "Een plant buigt naar het licht",
     "minutes": 4,
     "warmup": {
      "text": "Een plant staat op de vensterbank. Het licht komt maar van één kant. Na een paar dagen buigt de stengel naar het raam."
     },
     "learn": [
      {
       "text": "Een plant reageert in vier stappen: prikkel → receptor → conductor → reactie."
      },
      {
       "text": "De prikkel is wat verandert in de omgeving. Hier: licht van één kant."
      },
      {
       "text": "De receptor neemt de prikkel waar. Hier: lichtgevoelige cellen in de top van de stengel."
      },
      {
       "text": "De conductor geeft het signaal door. Bij planten is dat een plantenhormoon. Hier: auxine gaat naar de schaduwkant. Daardoor groeien de cellen aan de schaduwkant sterker. De reactie: de stengel buigt naar het licht."
      }
     ],
     "practice": [
      {
       "kind": "order",
       "prompt": "Zet de vier stappen in de juiste volgorde.",
       "items": [
        "Prikkel",
        "Receptor",
        "Conductor",
        "Reactie"
       ],
       "explanation": "Eerst verandert er iets (prikkel). Dan wordt het waargenomen (receptor). Dan wordt het signaal doorgegeven (conductor). Pas dan volgt de reactie."
      },
      {
       "kind": "choice",
       "prompt": "Wat is de conductor bij een plant die naar het licht buigt?",
       "options": [
        "Het licht",
        "Het plantenhormoon auxine",
        "De bladeren",
        "De wortels"
       ],
       "answerIndex": 1,
       "explanation": "Auxine geeft het signaal door van de top naar de cellen die moeten groeien. Het licht is de prikkel, geen conductor."
      }
     ],
     "check": [
      {
       "kind": "choice",
       "prompt": "Een plant buigt naar het licht. Hoe heet die reactie?",
       "options": [
        "Fototropie",
        "Nastie",
        "Fotosynthese"
       ],
       "answerIndex": 0,
       "explanation": "Fototropie: een groeibeweging in de richting van de lichtprikkel. Fotosynthese is iets anders: suikers maken met licht."
      }
     ],
     "commonMistakes": [
      {
       "mistake": "Het licht is de conductor.",
       "why": "Het licht is de prikkel. De conductor geeft het signaal door in de plant zelf."
      }
     ]
    },
    {
     "id": "bio-tropie-nastie",
     "title": "Tropie of nastie?",
     "minutes": 3,
     "warmup": {
      "text": "Planten kunnen bewegen. Er zijn twee soorten bewegingen: tropie en nastie."
     },
     "learn": [
      {
       "text": "Tropie: de richting van de beweging hangt af van de richting van de prikkel.",
       "example": "De stengel groeit naar de kant waar het licht vandaan komt."
      },
      {
       "text": "Nastie: de richting van de beweging hangt niet af van de richting van de prikkel.",
       "example": "Je raakt een blaadje van het kruidje-roer-mij-niet aan, van welke kant ook. De blaadjes vouwen altijd op dezelfde manier dicht."
      }
     ],
     "practice": [
      {
       "kind": "choice",
       "prompt": "Een tulp gaat open als het warm wordt. Is dat een tropie of een nastie?",
       "options": [
        "Tropie",
        "Nastie"
       ],
       "answerIndex": 1,
       "explanation": "De tulp gaat altijd op dezelfde manier open, waar de warmte ook vandaan komt. De richting hangt niet af van de prikkel: nastie."
      }
     ],
     "check": [
      {
       "kind": "choice",
       "prompt": "Wortels groeien naar beneden, door de zwaartekracht. Wat is dat?",
       "options": [
        "Tropie",
        "Nastie"
       ],
       "answerIndex": 0,
       "explanation": "De wortel groeit in de richting van de zwaartekracht. De richting hangt af van de prikkel: tropie."
      }
     ],
     "commonMistakes": [
      {
       "mistake": "Elke beweging van een plant is een tropie.",
       "why": "Alleen als de richting van de beweging afhangt van de richting van de prikkel. Anders is het een nastie."
      }
     ]
    }
   ]
  },
  {
   "schemaVersion": 1,
   "id": "economie-inflatie-koopkracht",
   "subject": "economie",
   "title": "Inflatie en koopkracht",
   "grade": 6,
   "curriculum": {
    "leerdoel": "De leerlingen leggen uit wat inflatie is en hoe ze de koopkracht beïnvloedt.",
    "references": []
   },
   "missions": [
    {
     "id": "economie-inflatie-koopkracht-1",
     "title": "Waarom je loon minder waard kan worden",
     "minutes": 4,
     "warmup": {
      "text": "Een broodje kostte vroeger €2 en nu €2,50. Als bijna alles duurder wordt, spreken we van inflatie."
     },
     "learn": [
      {
       "text": "Inflatie is een algemene stijging van het prijspeil. In België meet men ze met de consumptieprijsindex."
      },
      {
       "text": "Koopkracht is wat je met je inkomen kunt kopen. Stijgt je loon minder snel dan de prijzen, dan daalt je koopkracht.",
       "example": "Loon +2%, prijzen +5%: je koopkracht daalt met ongeveer 3%."
      },
      {
       "text": "In België worden lonen en uitkeringen automatisch aangepast aan de index. De Europese Centrale Bank mikt op 2% inflatie en kan de rente verhogen om inflatie af te remmen."
      }
     ],
     "practice": [
      {
       "kind": "choice",
       "prompt": "Je loon stijgt met 3% en de prijzen ook met 3%. Wat gebeurt er met je koopkracht?",
       "options": [
        "Ze stijgt",
        "Ze daalt",
        "Ze blijft ongeveer gelijk"
       ],
       "answerIndex": 2,
       "explanation": "Loon en prijzen stijgen even snel, dus je kunt ongeveer evenveel kopen als voordien."
      },
      {
       "kind": "choice",
       "prompt": "Wat doet de ECB meestal als de inflatie te hoog is?",
       "options": [
        "De rente verhogen",
        "De rente verlagen",
        "Meer bankbiljetten drukken"
       ],
       "answerIndex": 0,
       "explanation": "Een hogere rente maakt lenen duurder. Er wordt minder uitgegeven, en dat remt de prijsstijging af."
      }
     ],
     "check": [
      {
       "kind": "choice",
       "prompt": "Met welke index meet België de inflatie?",
       "options": [
        "De BEL20",
        "De consumptieprijsindex",
        "Het bruto binnenlands product"
       ],
       "answerIndex": 1,
       "explanation": "De consumptieprijsindex volgt de prijzen van een korf goederen en diensten. De BEL20 is een beursindex."
      }
     ],
     "commonMistakes": []
    }
   ]
  },
  {
   "schemaVersion": 1,
   "id": "economie-vraag-en-aanbod",
   "subject": "economie",
   "title": "Vraag, aanbod en de evenwichtsprijs",
   "grade": 5,
   "curriculum": {
    "leerdoel": "De leerlingen verklaren hoe vraag en aanbod samen de marktprijs bepalen.",
    "references": []
   },
   "missions": [
    {
     "id": "economie-vraag-en-aanbod-1",
     "title": "Hoe een markt zijn prijs vindt",
     "minutes": 4,
     "warmup": {
      "text": "Als concerttickets plots goedkoper worden, willen meer mensen er een kopen. Dat is de vraag die reageert op de prijs."
     },
     "learn": [
      {
       "text": "De vraag is hoeveel kopers willen kopen bij elke prijs. Stijgt de prijs, dan daalt de gevraagde hoeveelheid."
      },
      {
       "text": "Het aanbod is hoeveel verkopers willen verkopen bij elke prijs. Stijgt de prijs, dan stijgt de aangeboden hoeveelheid."
      },
      {
       "text": "Het marktevenwicht ligt waar de gevraagde en de aangeboden hoeveelheid gelijk zijn. Die prijs heet de evenwichtsprijs.",
       "example": "Bij €4 vragen kopers 300 stuks en bieden verkopers 300 stuks aan: €4 is de evenwichtsprijs."
      }
     ],
     "practice": [
      {
       "kind": "choice",
       "prompt": "De prijs ligt boven de evenwichtsprijs. Wat ontstaat er?",
       "options": [
        "Een vraagoverschot",
        "Een aanbodoverschot",
        "Evenwicht"
       ],
       "answerIndex": 1,
       "explanation": "Boven de evenwichtsprijs bieden verkopers meer aan dan kopers vragen. Er blijft aanbod over, en de prijs zakt."
      },
      {
       "kind": "choice",
       "prompt": "Wat gebeurt er met de gevraagde hoeveelheid als de prijs stijgt (en de rest gelijk blijft)?",
       "options": [
        "Ze stijgt",
        "Ze daalt",
        "Ze blijft gelijk"
       ],
       "answerIndex": 1,
       "explanation": "Bij een hogere prijs willen kopers minder kopen. De vraagcurve daalt."
      }
     ],
     "check": [
      {
       "kind": "order",
       "prompt": "De prijs ligt onder het evenwicht. Zet de gevolgen in volgorde.",
       "items": [
        "Kopers vragen meer dan er wordt aangeboden",
        "Er ontstaat een tekort (vraagoverschot)",
        "De prijs stijgt",
        "Vraag en aanbod komen weer in evenwicht"
       ],
       "explanation": "Een tekort duwt de prijs omhoog tot vraag en aanbod weer gelijk zijn."
      }
     ],
     "commonMistakes": [
      {
       "mistake": "Een hogere prijs verschuift de vraagcurve.",
       "why": "Een prijsverandering is een beweging langs de curve. De curve zelf verschuift pas door iets anders, zoals een hoger inkomen."
      }
     ]
    }
   ]
  },
  {
   "schemaVersion": 1,
   "id": "engels-present-perfect-past-simple",
   "subject": "engels",
   "title": "Present perfect or past simple?",
   "grade": 5,
   "curriculum": {
    "leerdoel": "De leerlingen kiezen correct tussen de present perfect en de past simple.",
    "references": []
   },
   "missions": [
    {
     "id": "engels-present-perfect-past-simple-1",
     "title": "Yesterday, since, ever",
     "minutes": 4,
     "warmup": {
      "text": "'I lived in Gent' en 'I have lived in Gent' betekenen niet hetzelfde. De tijd hangt af van wanneer het gebeurde."
     },
     "learn": [
      {
       "text": "Past simple: iets op een afgelopen moment dat je noemt of bedoelt (yesterday, last week, in 2020)."
      },
      {
       "text": "Present perfect (have/has + voltooid deelwoord): een ervaring of iets dat tot nu doorloopt, zonder afgelopen tijdstip (ever, never, already, since, for).",
       "example": "I have lived here since 2019. / I lived in Gent in 2018."
      }
     ],
     "practice": [
      {
       "kind": "choice",
       "prompt": "I ___ my keys yesterday.",
       "options": [
        "have lost",
        "lost",
        "have lose",
        "lose"
       ],
       "answerIndex": 1,
       "explanation": "'Yesterday' is een afgelopen moment: past simple, lost."
      },
      {
       "kind": "choice",
       "prompt": "She ___ in Brussels since 2021.",
       "options": [
        "lives",
        "lived",
        "has lived",
        "is living"
       ],
       "answerIndex": 2,
       "explanation": "'Since' loopt tot nu door: present perfect, has lived."
      }
     ],
     "check": [
      {
       "kind": "choice",
       "prompt": "___ you ever ___ sushi?",
       "options": [
        "Did / eat",
        "Have / eaten",
        "Have / ate",
        "Do / eaten"
       ],
       "answerIndex": 1,
       "explanation": "'Ever' vraagt naar een ervaring tot nu: Have you ever eaten…? Eaten is het voltooid deelwoord."
      }
     ],
     "commonMistakes": []
    }
   ]
  },
  {
   "schemaVersion": 1,
   "id": "engels-second-third-conditional",
   "subject": "engels",
   "title": "Second and third conditional",
   "grade": 6,
   "curriculum": {
    "leerdoel": "De leerlingen gebruiken de second en third conditional voor denkbeeldige situaties.",
    "references": []
   },
   "missions": [
    {
     "id": "engels-second-third-conditional-1",
     "title": "If I were… / If I had…",
     "minutes": 4,
     "warmup": {
      "text": "'If I had more time…' en 'If I had studied…' gaan allebei over iets wat niet zo is. Maar het ene gaat over nu, het andere over vroeger."
     },
     "learn": [
      {
       "text": "Second conditional: een denkbeeldige situatie nu. If + past simple, would + infinitief.",
       "example": "If I had more time, I would learn Spanish."
      },
      {
       "text": "Third conditional: een denkbeeldige situatie in het verleden, die niet gebeurd is. If + past perfect, would have + voltooid deelwoord.",
       "example": "If I had studied, I would have passed."
      }
     ],
     "practice": [
      {
       "kind": "choice",
       "prompt": "If I ___ rich, I would travel the world.",
       "options": [
        "am",
        "were",
        "had been",
        "will be"
       ],
       "answerIndex": 1,
       "explanation": "Denkbeeldig nu: second conditional met de past simple. Bij 'to be' is 'were' de correcte vorm."
      },
      {
       "kind": "choice",
       "prompt": "If she had left earlier, she ___ the train.",
       "options": [
        "would catch",
        "will catch",
        "would have caught",
        "caught"
       ],
       "answerIndex": 2,
       "explanation": "'Had left' is past perfect: third conditional, dus would have + voltooid deelwoord: would have caught."
      }
     ],
     "check": [
      {
       "kind": "choice",
       "prompt": "Welke zin gaat over iets in het verleden dat niet gebeurd is?",
       "options": [
        "If it rains, we stay inside.",
        "If I won the lottery, I would buy a house.",
        "If we had known, we would have come."
       ],
       "answerIndex": 2,
       "explanation": "If + past perfect en would have + voltooid deelwoord: een third conditional over het verleden."
      }
     ],
     "commonMistakes": []
    }
   ]
  },
  {
   "schemaVersion": 1,
   "id": "frans-passe-simple",
   "subject": "frans",
   "title": "Le passé simple herkennen",
   "grade": 6,
   "curriculum": {
    "leerdoel": "De leerlingen herkennen de passé simple in verhalende teksten en begrijpen de betekenis.",
    "references": []
   },
   "missions": [
    {
     "id": "frans-passe-simple-1",
     "title": "Il fut, il eut, il fit",
     "minutes": 4,
     "warmup": {
      "text": "In romans en sprookjes staat vaak een verleden tijd die je in gesprekken nooit hoort: de passé simple."
     },
     "learn": [
      {
       "text": "De passé simple vind je vooral in geschreven verhalen. Je moet hem vooral herkennen, niet zelf gebruiken."
      },
      {
       "text": "Werkwoorden op -er: il parla, ils parlèrent. Op -ir en -re: il finit, il vendit.",
       "example": "Il entra et regarda la salle."
      },
      {
       "text": "Onregelmatig: être → il fut, avoir → il eut, faire → il fit, venir → il vint."
      }
     ],
     "practice": [
      {
       "kind": "choice",
       "prompt": "'Il fut très surpris.' Van welk werkwoord komt 'fut'?",
       "options": [
        "faire",
        "être",
        "falloir",
        "finir"
       ],
       "answerIndex": 1,
       "explanation": "Fut is de passé simple van être: il fut = il a été."
      },
      {
       "kind": "choice",
       "prompt": "'Ils arrivèrent à Paris.' Wat is dat in de passé composé?",
       "options": [
        "Ils arrivent",
        "Ils sont arrivés",
        "Ils arrivaient",
        "Ils arriveront"
       ],
       "answerIndex": 1,
       "explanation": "Arrivèrent is de passé simple van arriver. In de passé composé: ils sont arrivés."
      }
     ],
     "check": [
      {
       "kind": "choice",
       "prompt": "'Elle eut peur.' Wat betekent dit?",
       "options": [
        "Ze heeft angst",
        "Ze werd bang",
        "Ze zal bang zijn"
       ],
       "answerIndex": 1,
       "explanation": "Eut is de passé simple van avoir: een afgelopen moment in het verhaal. Elle eut peur = ze werd (kreeg) bang."
      }
     ],
     "commonMistakes": []
    }
   ]
  },
  {
   "schemaVersion": 1,
   "id": "frans-subjonctif-present",
   "subject": "frans",
   "title": "Le subjonctif présent na 'il faut que'",
   "grade": 5,
   "curriculum": {
    "leerdoel": "De leerlingen vormen en gebruiken de subjonctif présent na 'il faut que'.",
    "references": []
   },
   "missions": [
    {
     "id": "frans-subjonctif-present-1",
     "title": "Il faut que tu…",
     "minutes": 4,
     "warmup": {
      "text": "'Il faut que tu viennes.' Na 'il faut que' komt in het Frans een aparte vorm: de subjonctif."
     },
     "learn": [
      {
       "text": "Na 'il faut que' gebruik je altijd de subjonctif."
      },
      {
       "text": "Regelmatig: neem de stam van 'ils' in de présent en voeg toe: -e, -es, -e, -ions, -iez, -ent.",
       "example": "ils finissent → que je finisse, que tu finisses"
      },
      {
       "text": "Onregelmatig, uit het hoofd: être → que je sois, avoir → que j'aie, faire → que je fasse, aller → que j'aille."
      }
     ],
     "practice": [
      {
       "kind": "choice",
       "prompt": "Il faut que tu ___ (parler) plus lentement.",
       "options": [
        "parles",
        "parlais",
        "parleras",
        "parlé"
       ],
       "answerIndex": 0,
       "explanation": "Stam parl- (ils parlent) + -es: que tu parles."
      },
      {
       "kind": "choice",
       "prompt": "Il faut que nous ___ (être) à l'heure.",
       "options": [
        "sommes",
        "soyons",
        "serons",
        "étions"
       ],
       "answerIndex": 1,
       "explanation": "Être is onregelmatig: que nous soyons."
      }
     ],
     "check": [
      {
       "kind": "choice",
       "prompt": "Il faut qu'elle ___ (faire) ses devoirs.",
       "options": [
        "fait",
        "faisait",
        "fasse",
        "fera"
       ],
       "answerIndex": 2,
       "explanation": "Faire is onregelmatig in de subjonctif: qu'elle fasse."
      }
     ],
     "commonMistakes": []
    }
   ]
  },
  {
   "schemaVersion": 1,
   "id": "fysica-eenparige-beweging",
   "subject": "fysica",
   "title": "Snelheid bij een eenparige beweging",
   "grade": 4,
   "curriculum": {
    "leerdoel": "De leerlingen berekenen de snelheid bij een eenparige rechtlijnige beweging en rekenen m/s om naar km/h.",
    "references": []
   },
   "missions": [
    {
     "id": "fysica-eenparige-beweging-1",
     "title": "v = Δx / Δt",
     "minutes": 4,
     "warmup": {
      "text": "Je fietst naar school aan een constante snelheid. Elke minuut leg je even ver af."
     },
     "learn": [
      {
       "text": "Bij een eenparige rechtlijnige beweging leg je in gelijke tijden gelijke afstanden af: de snelheid is constant."
      },
      {
       "text": "Snelheid v = Δx / Δt: de verplaatsing gedeeld door de tijdsduur, in m/s.",
       "example": "1 800 m in 300 s: v = 1 800 / 300 = 6 m/s"
      },
      {
       "text": "Van m/s naar km/h vermenigvuldig je met 3,6.",
       "example": "6 m/s · 3,6 = 21,6 km/h"
      }
     ],
     "practice": [
      {
       "kind": "choice",
       "prompt": "Een loper legt 100 m af in 20 s aan constante snelheid. Hoe groot is v?",
       "options": [
        "2 m/s",
        "5 m/s",
        "20 m/s",
        "2 000 m/s"
       ],
       "answerIndex": 1,
       "explanation": "v = 100 m / 20 s = 5 m/s."
      },
      {
       "kind": "choice",
       "prompt": "Hoeveel is 10 m/s in km/h?",
       "options": [
        "2,8 km/h",
        "36 km/h",
        "100 km/h",
        "3,6 km/h"
       ],
       "answerIndex": 1,
       "explanation": "10 · 3,6 = 36 km/h."
      }
     ],
     "check": [
      {
       "kind": "choice",
       "prompt": "Een trein rijdt 2 uur aan 90 km/h. Welke afstand legt hij af?",
       "options": [
        "45 km",
        "92 km",
        "180 km",
        "90 km"
       ],
       "answerIndex": 2,
       "explanation": "Δx = v · Δt = 90 km/h · 2 h = 180 km."
      }
     ],
     "commonMistakes": [
      {
       "mistake": "Van m/s naar km/h deel je door 3,6.",
       "why": "Andersom: km/h is het grotere getal. Van m/s naar km/h vermenigvuldig je met 3,6."
      }
     ]
    }
   ]
  },
  {
   "schemaVersion": 1,
   "id": "geschiedenis-franse-revolutie",
   "subject": "geschiedenis",
   "title": "De Franse Revolutie",
   "grade": 5,
   "curriculum": {
    "leerdoel": "De leerlingen ordenen de belangrijkste gebeurtenissen van de Franse Revolutie in de tijd.",
    "references": []
   },
   "missions": [
    {
     "id": "geschiedenis-franse-revolutie-1",
     "title": "Van Bastille tot Napoleon",
     "minutes": 4,
     "warmup": {
      "text": "In 1789 had Frankrijk een grote staatsschuld en duur brood. De koning riep de Staten-Generaal samen."
     },
     "learn": [
      {
       "text": "Juni 1789: de derde stand vormde de Nationale Vergadering. Op 14 juli 1789 bestormde het volk de Bastille."
      },
      {
       "text": "Augustus 1789: de Verklaring van de Rechten van de Mens en de Burger zegt dat mensen vrij en gelijk in rechten geboren worden."
      },
      {
       "text": "1792: Frankrijk werd een republiek. In 1793 werd koning Lodewijk XVI terechtgesteld. In 1799 greep Napoleon de macht."
      }
     ],
     "practice": [
      {
       "kind": "choice",
       "prompt": "Wat gebeurde er op 14 juli 1789?",
       "options": [
        "De bestorming van de Bastille",
        "De terechtstelling van Lodewijk XVI",
        "De staatsgreep van Napoleon"
       ],
       "answerIndex": 0,
       "explanation": "Op 14 juli 1789 bestormde het volk de Bastille. Lodewijk XVI stierf in 1793, Napoleon greep de macht in 1799."
      },
      {
       "kind": "choice",
       "prompt": "Welke tekst uit 1789 zegt dat mensen vrij en gelijk in rechten geboren worden?",
       "options": [
        "De Code Napoléon",
        "De Verklaring van de Rechten van de Mens en de Burger",
        "Het Edict van Nantes"
       ],
       "answerIndex": 1,
       "explanation": "Dat is de Verklaring van de Rechten van de Mens en de Burger (augustus 1789)."
      }
     ],
     "check": [
      {
       "kind": "order",
       "prompt": "Zet in de juiste volgorde.",
       "items": [
        "Samenroepen van de Staten-Generaal",
        "Bestorming van de Bastille",
        "Uitroepen van de republiek",
        "Staatsgreep van Napoleon"
       ],
       "explanation": "Staten-Generaal (mei 1789), Bastille (juli 1789), republiek (1792), Napoleon (1799)."
      }
     ],
     "commonMistakes": []
    }
   ]
  },
  {
   "schemaVersion": 1,
   "id": "geschiedenis-koude-oorlog",
   "subject": "geschiedenis",
   "title": "De Koude Oorlog",
   "grade": 6,
   "curriculum": {
    "leerdoel": "De leerlingen situeren de belangrijkste crisissen van de Koude Oorlog in de tijd.",
    "references": []
   },
   "missions": [
    {
     "id": "geschiedenis-koude-oorlog-1",
     "title": "Van luchtbrug tot val van de Muur",
     "minutes": 4,
     "warmup": {
      "text": "Na 1945 stonden de VS en de Sovjet-Unie tegenover elkaar: democratie en kapitalisme tegenover communisme."
     },
     "learn": [
      {
       "text": "Ze vochten nooit rechtstreeks tegen elkaar. Daarom heet het een 'koude' oorlog."
      },
      {
       "text": "1948–1949: de Sovjet-Unie blokkeerde West-Berlijn. De westerse geallieerden bevoorraadden de stad via een luchtbrug."
      },
      {
       "text": "1961: de Berlijnse Muur werd gebouwd. 1962: de Cubacrisis, over Sovjetkernraketten op Cuba, bracht de wereld dicht bij een kernoorlog."
      },
      {
       "text": "1989: de Berlijnse Muur viel. In 1991 hield de Sovjet-Unie op te bestaan."
      }
     ],
     "practice": [
      {
       "kind": "choice",
       "prompt": "Waarom heet het een 'koude' oorlog?",
       "options": [
        "Hij speelde zich af in Siberië",
        "De supermachten vochten niet rechtstreeks tegen elkaar",
        "Hij duurde maar één winter"
       ],
       "answerIndex": 1,
       "explanation": "De VS en de Sovjet-Unie voerden nooit rechtstreeks oorlog tegen elkaar, wel via dreiging, wapenwedloop en conflicten elders."
      },
      {
       "kind": "choice",
       "prompt": "Waarover ging de Cubacrisis van 1962?",
       "options": [
        "Sovjetkernraketten op Cuba",
        "Een burgeroorlog in Berlijn",
        "Het einde van de Sovjet-Unie"
       ],
       "answerIndex": 0,
       "explanation": "De Sovjet-Unie plaatste kernraketten op Cuba, vlak bij de VS. Na dertien spannende dagen werden ze teruggetrokken."
      }
     ],
     "check": [
      {
       "kind": "order",
       "prompt": "Zet in de juiste volgorde.",
       "items": [
        "Berlijnse blokkade en luchtbrug",
        "Bouw van de Berlijnse Muur",
        "Cubacrisis",
        "Val van de Berlijnse Muur"
       ],
       "explanation": "Blokkade (1948–1949), Muur (1961), Cubacrisis (1962), val van de Muur (1989)."
      }
     ],
     "commonMistakes": []
    }
   ]
  },
  {
   "schemaVersion": 1,
   "id": "nederlands-citeren-parafraseren",
   "subject": "nederlands",
   "title": "Citeren, parafraseren en bronnen vermelden",
   "grade": 6,
   "curriculum": {
    "leerdoel": "De leerlingen gebruiken informatie uit bronnen correct door te citeren of te parafraseren met bronvermelding.",
    "references": []
   },
   "missions": [
    {
     "id": "nederlands-citeren-parafraseren-1",
     "title": "Andermans woorden, jouw tekst",
     "minutes": 4,
     "warmup": {
      "text": "Voor een paper of je eindwerk gebruik je bronnen. Hoe je die verwerkt, bepaalt of je tekst eerlijk is."
     },
     "learn": [
      {
       "text": "Citeren: je neemt de tekst letterlijk over, tussen aanhalingstekens, en je vermeldt de bron."
      },
      {
       "text": "Parafraseren: je zegt hetzelfde in je eigen woorden. Ook dan vermeld je de bron, want het idee is niet van jou."
      },
      {
       "text": "Wie andermans tekst of idee gebruikt zonder bron, pleegt plagiaat."
      }
     ],
     "practice": [
      {
       "kind": "choice",
       "prompt": "Je neemt één zin letterlijk over uit een artikel. Wat moet je doen?",
       "options": [
        "Niets, het is maar één zin",
        "Aanhalingstekens én bronvermelding",
        "Alleen de bron in de bibliografie"
       ],
       "answerIndex": 1,
       "explanation": "Een letterlijke overname is een citaat: aanhalingstekens tonen wat niet van jou is, en de bron zegt van wie het is."
      },
      {
       "kind": "choice",
       "prompt": "Je vat een idee van een auteur samen in je eigen woorden. Moet je de bron vermelden?",
       "options": [
        "Ja, het idee is van de auteur",
        "Nee, de woorden zijn van jou"
       ],
       "answerIndex": 0,
       "explanation": "Bij een parafrase zijn de woorden van jou, maar het idee niet. Zonder bron is het plagiaat."
      }
     ],
     "check": [
      {
       "kind": "order",
       "prompt": "Zet de stappen voor een goede parafrase in volgorde.",
       "items": [
        "Lees de passage tot je ze begrijpt",
        "Leg de tekst weg en schrijf het idee in je eigen woorden",
        "Vergelijk met het origineel: klopt de inhoud?",
        "Vermeld de bron"
       ],
       "explanation": "Eerst begrijpen, dan zonder de tekst herschrijven, dan controleren, en altijd de bron vermelden."
      }
     ],
     "commonMistakes": []
    }
   ]
  },
  {
   "schemaVersion": 1,
   "id": "nederlands-drogredenen",
   "subject": "nederlands",
   "title": "Drogredenen herkennen",
   "grade": 5,
   "curriculum": {
    "leerdoel": "De leerlingen herkennen veelvoorkomende drogredenen in een betoog.",
    "references": []
   },
   "missions": [
    {
     "id": "nederlands-drogredenen-1",
     "title": "Stroman, op de persoon, hellend vlak",
     "minutes": 4,
     "warmup": {
      "text": "Een argument kan overtuigend klinken en toch niet kloppen. Zo'n redenering heet een drogreden."
     },
     "learn": [
      {
       "text": "Op de persoon spelen: je valt de spreker aan in plaats van het argument.",
       "example": "'Wat weet een student nu over belastingen?'"
      },
      {
       "text": "Stroman: je geeft het standpunt van de ander verdraaid of overdreven weer, en valt dat aan.",
       "example": "'We moeten minder vlees eten.' — 'Dus jij wil vlees verbieden?'"
      },
      {
       "text": "Hellend vlak: je beweert zonder bewijs dat één kleine stap vanzelf tot een reeks rampen leidt."
      }
     ],
     "practice": [
      {
       "kind": "choice",
       "prompt": "'Jij wil een uur later beginnen? Dan wil je zeker helemaal niet meer naar school.' Welke drogreden is dit?",
       "options": [
        "Stroman",
        "Op de persoon spelen",
        "Geen drogreden"
       ],
       "answerIndex": 0,
       "explanation": "Het standpunt 'een uur later beginnen' wordt overdreven tot 'niet meer naar school willen'. Dat is een stroman."
      },
      {
       "kind": "choice",
       "prompt": "'Wat weet zij nu over het klimaat? Ze is pas zestien.' Welke drogreden is dit?",
       "options": [
        "Stroman",
        "Op de persoon spelen",
        "Geen drogreden"
       ],
       "answerIndex": 1,
       "explanation": "De leeftijd van de spreker zegt niets over haar argument. Dit is op de persoon spelen."
      }
     ],
     "check": [
      {
       "kind": "choice",
       "prompt": "'Als we vandaag één vak schrappen, schrappen ze morgen alle vakken en is de school straks leeg.' Welke drogreden?",
       "options": [
        "Stroman",
        "Op de persoon spelen",
        "Hellend vlak"
       ],
       "answerIndex": 2,
       "explanation": "Zonder bewijs leidt één stap hier tot een ramp. Dat is een hellend vlak."
      }
     ],
     "commonMistakes": []
    }
   ]
  },
  {
   "schemaVersion": 1,
   "id": "wiskunde-gehele-getallen",
   "subject": "wiskunde",
   "title": "Rekenen met negatieve getallen",
   "grade": 1,
   "curriculum": {
    "leerdoel": "De leerlingen rekenen met gehele getallen, ook negatieve.",
    "references": []
   },
   "missions": [
    {
     "id": "wiskunde-gehele-getallen-1",
     "title": "Onder nul",
     "minutes": 4,
     "warmup": {
      "text": "Het vriest −3 °C en het wordt 5 graden warmer. Hoe warm is het dan?"
     },
     "learn": [
      {
       "text": "Op de getallenas ligt een negatief getal links van 0. Optellen is naar rechts gaan.",
       "example": "−3 + 5: start bij −3, ga 5 naar rechts: 2."
      },
      {
       "text": "Een getal aftrekken is het tegengestelde optellen.",
       "example": "4 − (−2) = 4 + 2 = 6"
      },
      {
       "text": "Vermenigvuldigen: gelijke tekens geven plus, verschillende tekens geven min.",
       "example": "(−3) · (−4) = 12 en (−3) · 4 = −12"
      }
     ],
     "practice": [
      {
       "kind": "choice",
       "prompt": "−7 + 3 = ?",
       "options": [
        "−10",
        "−4",
        "4",
        "10"
       ],
       "answerIndex": 1,
       "explanation": "Start bij −7 en ga 3 naar rechts: −4."
      },
      {
       "kind": "choice",
       "prompt": "5 − (−3) = ?",
       "options": [
        "2",
        "−8",
        "8",
        "−2"
       ],
       "answerIndex": 2,
       "explanation": "−3 aftrekken is 3 optellen: 5 + 3 = 8."
      }
     ],
     "check": [
      {
       "kind": "choice",
       "prompt": "(−6) · 2 = ?",
       "options": [
        "12",
        "−12",
        "−3",
        "4"
       ],
       "answerIndex": 1,
       "explanation": "Verschillende tekens geven min: 6 · 2 = 12, dus −12."
      },
      {
       "kind": "order",
       "prompt": "Zet van klein naar groot.",
       "items": [
        "−5",
        "−2",
        "0",
        "3"
       ],
       "explanation": "Hoe verder links op de getallenas, hoe kleiner: −5 < −2 < 0 < 3."
      }
     ],
     "commonMistakes": [
      {
       "mistake": "−5 is groter dan −2, want 5 is groter dan 2.",
       "why": "Bij negatieve getallen is het omgekeerd: −5 ligt verder links, dus −5 is kleiner."
      }
     ]
    }
   ]
  },
  {
   "schemaVersion": 1,
   "id": "wiskunde-normale-verdeling",
   "subject": "wiskunde",
   "title": "De normale verdeling: de 68-95-99,7-regel",
   "grade": 6,
   "curriculum": {
    "leerdoel": "De leerlingen gebruiken de vuistregel van de normale verdeling om kansen te schatten.",
    "references": []
   },
   "missions": [
    {
     "id": "wiskunde-normale-verdeling-1",
     "title": "Hoeveel ligt binnen één, twee, drie σ?",
     "minutes": 5,
     "warmup": {
      "text": "Lengtes, testscores en vulgewichten liggen vaak rond een gemiddelde, met minder uitschieters naar boven en beneden. Dat geeft een klokvorm."
     },
     "learn": [
      {
       "text": "Een normale verdeling heeft een gemiddelde μ en een standaardafwijking σ. De klok is symmetrisch rond μ."
      },
      {
       "text": "Ongeveer 68% ligt tussen μ − σ en μ + σ. Ongeveer 95% tussen μ − 2σ en μ + 2σ. Ongeveer 99,7% tussen μ − 3σ en μ + 3σ.",
       "example": "Lengte met μ = 170 cm en σ = 8 cm: ongeveer 95% is tussen 154 en 186 cm."
      },
      {
       "text": "Door de symmetrie ligt wat buiten een interval voor de helft boven en voor de helft onder."
      }
     ],
     "practice": [
      {
       "kind": "choice",
       "prompt": "IQ heeft μ = 100 en σ = 15. Welk percentage ligt ongeveer tussen 85 en 115?",
       "options": [
        "50%",
        "68%",
        "95%",
        "99,7%"
       ],
       "answerIndex": 1,
       "explanation": "85 en 115 zijn μ − σ en μ + σ. Daartussen ligt ongeveer 68%."
      },
      {
       "kind": "choice",
       "prompt": "Dezelfde IQ-verdeling. Welk percentage scoort ongeveer hoger dan 130?",
       "options": [
        "2,5%",
        "5%",
        "16%",
        "0,15%"
       ],
       "answerIndex": 0,
       "explanation": "130 is μ + 2σ. Binnen 2σ ligt 95%, buiten 5%. Door de symmetrie ligt de helft daarvan boven: 2,5%."
      }
     ],
     "check": [
      {
       "kind": "choice",
       "prompt": "Een machine vult flessen met μ = 500 ml en σ = 4 ml. Tussen welke waarden ligt ongeveer 99,7%?",
       "options": [
        "496 en 504 ml",
        "492 en 508 ml",
        "488 en 512 ml",
        "480 en 520 ml"
       ],
       "answerIndex": 2,
       "explanation": "99,7% ligt binnen 3σ: 500 − 12 = 488 en 500 + 12 = 512 ml."
      }
     ],
     "commonMistakes": []
    }
   ]
  },
  {
   "schemaVersion": 1,
   "id": "wiskunde-vergelijkingen-eerste-graad",
   "subject": "wiskunde",
   "title": "Vergelijkingen van de eerste graad oplossen",
   "grade": 2,
   "curriculum": {
    "leerdoel": "De leerlingen lossen eenvoudige vergelijkingen van de eerste graad op en controleren de oplossing.",
    "references": []
   },
   "missions": [
    {
     "id": "wiskunde-vergelijkingen-eerste-graad-1",
     "title": "Zoek x",
     "minutes": 4,
     "warmup": {
      "text": "3 gelijke zakjes snoep en nog 4 losse snoepjes zijn samen 19 snoepjes. Hoeveel zit er in één zakje?"
     },
     "learn": [
      {
       "text": "Een vergelijking is een gelijkheid met een onbekende, zoals 3x + 4 = 19."
      },
      {
       "text": "Je mag in beide leden hetzelfde doen: hetzelfde getal optellen of aftrekken, of beide leden delen door hetzelfde getal (niet 0).",
       "example": "3x + 4 = 19 → 3x = 15 → x = 5"
      },
      {
       "text": "Controleer altijd door je oplossing in te vullen: 3 · 5 + 4 = 19. Klopt."
      }
     ],
     "practice": [
      {
       "kind": "choice",
       "prompt": "Los op: x + 7 = 12",
       "options": [
        "x = 19",
        "x = 5",
        "x = −5",
        "x = 84"
       ],
       "answerIndex": 1,
       "explanation": "Trek in beide leden 7 af: x = 12 − 7 = 5."
      },
      {
       "kind": "choice",
       "prompt": "Los op: 4x = 28",
       "options": [
        "x = 24",
        "x = 32",
        "x = 7",
        "x = 112"
       ],
       "answerIndex": 2,
       "explanation": "Deel beide leden door 4: x = 28 : 4 = 7."
      }
     ],
     "check": [
      {
       "kind": "order",
       "prompt": "Los 2x − 3 = 11 op. Zet de stappen in volgorde.",
       "items": [
        "2x − 3 = 11",
        "2x = 14",
        "x = 7",
        "Controle: 2 · 7 − 3 = 11"
       ],
       "explanation": "Tel 3 op in beide leden, deel dan door 2, en controleer door in te vullen."
      }
     ],
     "commonMistakes": []
    }
   ]
  }
 ]
};
