// Privacy policy, cookie policy, terms of use and account-deletion text (Google Play requires privacy and deletion
// on the web). Drafted for Ali's review (October 2026): not legal advice.
// It must always match what the app really does: version 1 is offline, with no account and no data leaving the device.
// Update it (and the Play Console Data safety form) before sign-in, sync or AI ship.
import { CONTACT_EMAIL, POLICY_UPDATED } from "./content.mjs";

const mail = `<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>`;

export const privacy = {
  nl: {
    title: "Privacybeleid",
    updated: `Laatst bijgewerkt: ${POLICY_UPDATED}`,
    sections: [
      ["Wie zijn wij", [`Breinhap is een app van ASafariM in België. Vragen over je gegevens? Mail naar ${mail}.`]],
      [
        "Kort",
        [
          "Deze versie van Breinhap werkt volledig op je toestel. Je hebt geen account nodig, en de app stuurt niets over jou naar ons of naar iemand anders.",
        ],
      ],
      [
        "Wat de app op je toestel bewaart",
        [
          {
            list: [
              "<strong>Je instellingen.</strong> Thema, rustige modus en grote tekst.",
              "<strong>Je school.</strong> De school, het jaar en de richting die je koos, zodat je meteen je eigen vakken ziet.",
              "<strong>Wat je vandaag deed.</strong> Welke missies je vandaag al deed, zodat je niet twee keer dezelfde krijgt. Dat verdwijnt als je de app sluit.",
            ],
          },
          "Dat blijft op je toestel. Wij kunnen het niet zien.",
        ],
      ],
      [
        "Wat we nooit verzamelen",
        [
          {
            list: [
              "Je naam, e-mailadres of een account.",
              "Een diagnose of andere gezondheidsgegevens.",
              "Je locatie, contacten, foto's, camera of microfoon.",
              "Een advertentie-id. Er zijn geen advertenties.",
              "Gegevens voor tracking of analytics, van ons of van andere bedrijven.",
            ],
          },
        ],
      ],
      [
        "Voorlezen",
        [
          "Als je een kaart laat voorlezen, gebruikt Breinhap de spraakfunctie van je toestel. De app stuurt die tekst niet naar ons.",
        ],
      ],
      [
        "Later: inloggen en AI",
        [
          "We willen later inloggen met een ASafariM-account, je voortgang op meer toestellen en een knop “Leg het anders uit” toevoegen. Voor dat er komt, passen we dit beleid aan en zeggen we in de app wat er verandert.",
        ],
      ],
      [
        "Je gegevens verwijderen",
        [
          'Alles staat op je toestel. Verwijder de app, of wis de gegevens van Breinhap in de instellingen van je toestel. Zie ook <a href="{{deleteHref}}">Je gegevens verwijderen</a>.',
        ],
      ],
      [
        "Jouw rechten",
        [
          `Vragen of opmerkingen over privacy? Mail naar ${mail}.`,
          'Ben je niet tevreden? Dan kan je klacht indienen bij de <a href="https://www.gegevensbeschermingsautoriteit.be/">Gegevensbeschermingsautoriteit</a>.',
        ],
      ],
      [
        "Deze website",
        [
          "Deze website gebruikt geen analytics en geen tracking. Er is één cookie: <code>asafarim-theme</code>, dat onthoudt of je het lichte of het donkere thema koos. Zie het <a href=\"{{cookiesHref}}\">cookiebeleid</a>.",
        ],
      ],
    ],
  },
  en: {
    title: "Privacy policy",
    updated: `Last updated: ${POLICY_UPDATED}`,
    sections: [
      ["Who we are", [`Breinhap is an app by ASafariM in Belgium. Questions about your data? Email ${mail}.`]],
      [
        "In short",
        [
          "This version of Breinhap works entirely on your device. You don't need an account, and the app sends nothing about you to us or to anyone else.",
        ],
      ],
      [
        "What the app keeps on your device",
        [
          {
            list: [
              "<strong>Your settings.</strong> Theme, calm mode and large text.",
              "<strong>Your school.</strong> The school, year and study programme you picked, so you see your own subjects straight away.",
              "<strong>What you did today.</strong> Which missions you already did today, so you don't get the same one twice. This is gone when you close the app.",
            ],
          },
          "This stays on your device. We can't see it.",
        ],
      ],
      [
        "What we never collect",
        [
          {
            list: [
              "Your name, email address or an account.",
              "A diagnosis or any other health data.",
              "Your location, contacts, photos, camera or microphone.",
              "An advertising id. There are no ads.",
              "Data for tracking or analytics, by us or by other companies.",
            ],
          },
        ],
      ],
      [
        "Read aloud",
        [
          "When you have a card read aloud, Breinhap uses your device's speech feature. The app does not send that text to us.",
        ],
      ],
      [
        "Later: sign-in and AI",
        [
          "We plan to add sign-in with an ASafariM account, your progress on more devices, and an “Explain it differently” button. Before any of that arrives, we update this policy and say in the app what changes.",
        ],
      ],
      [
        "Deleting your data",
        [
          'Everything is on your device. Uninstall the app, or clear Breinhap\'s data in your device settings. See also <a href="{{deleteHref}}">Delete your data</a>.',
        ],
      ],
      [
        "Your rights",
        [
          `Questions or remarks about privacy? Email ${mail}.`,
          'Not happy? You can complain to the Belgian <a href="https://www.dataprotectionauthority.be/">Data Protection Authority</a>.',
        ],
      ],
      [
        "This website",
        [
          "This website uses no analytics and no tracking. There is one cookie, <code>asafarim-theme</code>, which remembers whether you chose the light or the dark theme. See the <a href=\"{{cookiesHref}}\">cookie policy</a>.",
        ],
      ],
    ],
  },
};

export const deletion = {
  nl: {
    title: "Je gegevens verwijderen",
    lead: "Breinhap heeft in deze versie geen account. Alles wat de app bewaart, staat op je toestel. Zo verwijder je het.",
    sections: [
      [
        "Op je toestel",
        [
          {
            ordered: [
              "Open de Instellingen van je toestel.",
              "Ga naar Apps en kies Breinhap.",
              "Tik op Opslag en dan op Gegevens wissen. Of verwijder de app.",
            ],
          },
        ],
      ],
      [
        "Wat er dan weg is",
        [{ list: ["Je instellingen (thema, rustige modus, grote tekst).", "Je school, jaar en richting.", "Wat je vandaag deed."] }],
      ],
      [
        "Bij ons",
        [
          `Wij bewaren niets over jou, dus er is bij ons niets te verwijderen. Vragen? Mail naar ${mail}.`,
          "Komt er later een account, dan kan je dat in de app verwijderen. Deze pagina legt dan uit hoe.",
        ],
      ],
    ],
  },
  en: {
    title: "Delete your data",
    lead: "This version of Breinhap has no account. Everything the app keeps is on your device. Here's how to remove it.",
    sections: [
      [
        "On your device",
        [
          {
            ordered: [
              "Open your device's Settings.",
              "Go to Apps and choose Breinhap.",
              "Tap Storage, then Clear data. Or uninstall the app.",
            ],
          },
        ],
      ],
      [
        "What is then gone",
        [{ list: ["Your settings (theme, calm mode, large text).", "Your school, year and study programme.", "What you did today."] }],
      ],
      [
        "On our side",
        [
          `We keep nothing about you, so there is nothing to delete on our side. Questions? Email ${mail}.`,
          "If an account comes later, you will be able to delete it in the app, and this page will explain how.",
        ],
      ],
    ],
  },
};

// The site sets one cookie (the theme choice, shared with every *.asafarim.site page); the app sets none.
export const cookies = {
  nl: {
    title: "Cookiebeleid",
    updated: `Laatst bijgewerkt: ${POLICY_UPDATED}`,
    lead: "Kort: deze website heeft één cookie, en dat onthoudt alleen je thema. Geen tracking, geen advertenties, geen cookies van andere bedrijven. Daarom is er ook geen cookiemelding.",
    sections: [
      [
        "Wat is een cookie?",
        ["Een cookie is een klein stukje tekst dat een website in je browser bewaart en later terugleest."],
      ],
      [
        "Het enige cookie",
        [
          {
            list: [
              "<strong>Naam:</strong> <code>asafarim-theme</code>",
              "<strong>Waarvoor:</strong> onthoudt of je het lichte of het donkere thema koos. Het wordt pas gezet als je zelf op de themaknop drukt.",
              "<strong>Waar:</strong> breinhap.asafarim.site en de andere ASafariM-sites op asafarim.site, zodat je keuze overal geldt.",
              "<strong>Hoe lang:</strong> 1 jaar.",
              "<strong>Wat het bevat:</strong> alleen <code>light</code> of <code>dark</code>. Niets over jou.",
            ],
          },
          "Omdat je dit cookie zelf vraagt door een thema te kiezen, mag het volgens de Belgische wet zonder toestemming. Je kan het altijd wissen in de instellingen van je browser: dan volgt de site weer het thema van je toestel.",
        ],
      ],
      [
        "De app",
        [
          "De Breinhap-app gebruikt geen cookies. Je instellingen (thema, rustige modus, grote tekst) staan alleen op je toestel. Lees meer in het <a href=\"{{privacyHref}}\">privacybeleid</a>.",
        ],
      ],
      ["Vragen?", [`Mail naar ${mail}.`]],
    ],
  },
  en: {
    title: "Cookie policy",
    updated: `Last updated: ${POLICY_UPDATED}`,
    lead: "In short: this website has one cookie, and it only remembers your theme. No tracking, no ads, no cookies from other companies. That's why there is no cookie banner.",
    sections: [
      [
        "What is a cookie?",
        ["A cookie is a small piece of text a website keeps in your browser and reads back later."],
      ],
      [
        "The only cookie",
        [
          {
            list: [
              "<strong>Name:</strong> <code>asafarim-theme</code>",
              "<strong>What for:</strong> remembers whether you chose the light or the dark theme. It is only set when you press the theme button yourself.",
              "<strong>Where:</strong> breinhap.asafarim.site and the other ASafariM sites on asafarim.site, so your choice holds everywhere.",
              "<strong>How long:</strong> 1 year.",
              "<strong>What it holds:</strong> only <code>light</code> or <code>dark</code>. Nothing about you.",
            ],
          },
          "Because you ask for this cookie yourself by choosing a theme, Belgian law allows it without consent. You can delete it in your browser settings at any time: the site then follows your device's theme again.",
        ],
      ],
      [
        "The app",
        [
          "The Breinhap app uses no cookies. Your settings (theme, calm mode, large text) are only on your device. Read more in the <a href=\"{{privacyHref}}\">privacy policy</a>.",
        ],
      ],
      ["Questions?", [`Email ${mail}.`]],
    ],
  },
};

// Written for students of about 14 or 15: short sentences, no legalese where plain words do.
export const terms = {
  nl: {
    title: "Gebruiksvoorwaarden",
    updated: `Laatst bijgewerkt: ${POLICY_UPDATED}`,
    lead: "Dit zijn de afspraken als je Breinhap gebruikt, de app en deze website. Door Breinhap te gebruiken, ga je ermee akkoord.",
    sections: [
      ["Wie zijn wij", [`Breinhap is een app van ASafariM in België. Contact: ${mail}.`]],
      [
        "Wat Breinhap is",
        [
          "Breinhap helpt je studeren in korte missies. De app is gratis en heeft geen advertenties.",
          "Breinhap vervangt je leerkracht, je lessen of je handboek niet. Het is ook geen medisch hulpmiddel en geen therapie: de app stelt geen diagnose en geeft geen medisch advies.",
        ],
      ],
      [
        "Wie Breinhap mag gebruiken",
        [
          "Breinhap is gemaakt voor leerlingen van het 3de middelbaar in Vlaanderen, maar iedereen mag het gebruiken. Ben je jonger dan 18? Praat er dan gerust over met een ouder.",
        ],
      ],
      [
        "De leerstof",
        [
          "We werken de leerstof zorgvuldig uit en laten ze nalezen voor ze in de app komt. Toch kan er een fout in staan. Twijfel je? Check het in je cursus of vraag het aan je leerkracht. Zie je een fout, mail ons dan: dan verbeteren we ze.",
          "De teksten, oefeningen, het logo en de naam Breinhap zijn van ASafariM. Je mag ze gebruiken om zelf te studeren. Ze kopiëren, verkopen of op een andere plek publiceren mag niet zonder onze toestemming.",
        ],
      ],
      [
        "Wat niet mag",
        [
          {
            list: [
              "De app of de website proberen te kraken, te verstoren of te misbruiken.",
              "Breinhap gebruiken voor iets wat de wet verbiedt.",
            ],
          },
        ],
      ],
      [
        "Geen garantie",
        [
          "We doen ons best om Breinhap goed te laten werken, maar we beloven niet dat het altijd zonder fouten of onderbrekingen werkt. De app kan veranderen, en we kunnen een functie stoppen.",
          "Voor zover de wet het toelaat, zijn we niet aansprakelijk voor indirecte schade, zoals een slechter resultaat op een toets. Niets in deze voorwaarden neemt rechten weg die je als consument hebt.",
        ],
      ],
      [
        "Privacy",
        [
          'Hoe we met gegevens omgaan, staat in het <a href="{{privacyHref}}">privacybeleid</a>. Kort: deze versie bewaart alles op je toestel en stuurt niets over jou door.',
        ],
      ],
      [
        "Veranderingen",
        [
          "Als we deze voorwaarden aanpassen, zie je dat aan de datum hieronder. Bij een belangrijke verandering zeggen we het in de app.",
        ],
      ],
      [
        "Recht",
        [
          "Het Belgische recht is van toepassing. Is er een probleem, mail ons dan eerst: we zoeken samen een oplossing.",
        ],
      ],
    ],
  },
  en: {
    title: "Terms of use",
    updated: `Last updated: ${POLICY_UPDATED}`,
    lead: "These are the rules for using Breinhap, the app and this website. By using Breinhap, you agree to them.",
    sections: [
      ["Who we are", [`Breinhap is an app by ASafariM in Belgium. Contact: ${mail}.`]],
      [
        "What Breinhap is",
        [
          "Breinhap helps you study in short missions. The app is free and has no ads.",
          "Breinhap does not replace your teacher, your lessons or your textbook. It is not a medical device or therapy either: the app makes no diagnosis and gives no medical advice.",
        ],
      ],
      [
        "Who may use Breinhap",
        [
          "Breinhap is made for students in their 3rd year of secondary school in Flanders, but anyone may use it. Under 18? Feel free to talk it over with a parent.",
        ],
      ],
      [
        "The content",
        [
          "We write the content carefully and have it checked before it reaches the app. Still, a mistake can slip in. Not sure? Check your course notes or ask your teacher. Found a mistake? Email us and we'll fix it.",
          "The texts, exercises, the logo and the name Breinhap belong to ASafariM. You may use them to study. Copying, selling or publishing them elsewhere is not allowed without our permission.",
        ],
      ],
      [
        "What's not allowed",
        [
          {
            list: [
              "Trying to hack, disrupt or misuse the app or the website.",
              "Using Breinhap for anything the law forbids.",
            ],
          },
        ],
      ],
      [
        "No guarantee",
        [
          "We do our best to make Breinhap work well, but we don't promise it will always work without errors or interruptions. The app may change, and we may stop a feature.",
          "As far as the law allows, we are not liable for indirect damage, such as a lower test result. Nothing in these terms takes away rights you have as a consumer.",
        ],
      ],
      [
        "Privacy",
        [
          'How we handle data is in the <a href="{{privacyHref}}">privacy policy</a>. In short: this version keeps everything on your device and sends nothing about you anywhere.',
        ],
      ],
      [
        "Changes",
        [
          "When we change these terms, the date below shows it. For an important change, we say so in the app.",
        ],
      ],
      [
        "Law",
        ["Belgian law applies. If there is a problem, email us first: we'll look for a solution together."],
      ],
    ],
  },
};
