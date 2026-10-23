// Privacy policy and account-deletion text (Google Play requires both on the web).
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
          "Deze website gebruikt geen analytics en geen tracking. Er is één cookie: <code>asafarim-theme</code>, dat onthoudt of je het lichte of het donkere thema koos.",
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
          "This website uses no analytics and no tracking. There is one cookie, <code>asafarim-theme</code>, which remembers whether you chose the light or the dark theme.",
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
        [{ list: ["Je instellingen (thema, rustige modus, grote tekst).", "Wat je vandaag deed."] }],
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
        [{ list: ["Your settings (theme, calm mode, large text).", "What you did today."] }],
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
