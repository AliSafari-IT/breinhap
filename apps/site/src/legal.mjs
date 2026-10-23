// Privacy policy and account-deletion text (Google Play requires both on the web).
// A draft: it is reviewed before Breinhap is published, and must always match what the app really does.
import { CONTACT_EMAIL, POLICY_UPDATED } from "./content.mjs";

const mail = `<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>`;

export const privacy = {
  nl: {
    title: "Privacybeleid",
    draft: "Dit is een concept. Het wordt nagekeken en bijgewerkt voordat Breinhap op Google Play verschijnt.",
    updated: `Laatst bijgewerkt: ${POLICY_UPDATED}`,
    sections: [
      ["Wie zijn wij", [`Breinhap is een app van ASafariM in België. Vragen over je gegevens? Mail naar ${mail}.`]],
      [
        "Welke gegevens we gebruiken",
        [
          {
            list: [
              "<strong>Je account.</strong> Je logt in met je ASafariM-account. Breinhap krijgt een account-id, je e-mailadres (voor de inlogcode) en je weergavenaam.",
              "<strong>Je leervoortgang.</strong> Welke missies je deed, welke vragen juist of nog niet juist waren, en wanneer je iets herhaalt.",
              "<strong>Wat je zelf invoert over school.</strong> Lessen, toetsen en taken. We verwijderen ze automatisch 30 dagen na de datum.",
              "<strong>Je instellingen.</strong> Thema, rustige modus en grote tekst. Die blijven op je toestel.",
              "<strong>Vragen aan de AI</strong> (“Leg het anders uit”). We sturen alleen de tekst van de kaart mee, nooit je naam, school of rooster. We bewaren dit 30 dagen om misbruik te kunnen nakijken.",
            ],
          },
        ],
      ],
      [
        "Wat we nooit verzamelen",
        [
          {
            list: [
              "Een diagnose of andere gezondheidsgegevens.",
              "Je locatie, contacten, foto's, camera of microfoon.",
              "Een advertentie-id. Er zijn geen advertenties.",
              "Gegevens voor tracking of analytics van andere bedrijven.",
            ],
          },
        ],
      ],
      [
        "Waarom we ze gebruiken",
        [
          "Om de app te laten werken: je missies kiezen, je voortgang bewaren en op je andere toestellen tonen. Dat is de uitvoering van de dienst die je vraagt (AVG artikel 6.1.b).",
          "In België mag je vanaf 13 jaar zelf beslissen over een app als deze. We schrijven alles zo dat je het zelf kan lezen.",
        ],
      ],
      [
        "Wie helpt ons",
        [
          "We werken met een paar dienstverleners: hosting in de Europese Unie, een e-maildienst voor inlogcodes en een AI-aanbieder. Met elk hebben we een verwerkersovereenkomst. De AI-aanbieder mag je gegevens niet gebruiken om zijn modellen te trainen. We verkopen nooit gegevens.",
        ],
      ],
      [
        "Hoe lang we gegevens bewaren",
        [
          {
            list: [
              "Account en leervoortgang: tot je je account verwijdert.",
              "Schoolitems: tot 30 dagen na de datum.",
              "Vragen aan de AI: 30 dagen.",
            ],
          },
        ],
      ],
      [
        "Jouw rechten",
        [
          `Je mag je gegevens inkijken, laten verbeteren, laten verwijderen en meenemen. Je mag bezwaar maken. Mail naar ${mail}. Je kan je account ook zelf verwijderen: zie <a href="{{deleteHref}}">Account verwijderen</a>.`,
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
    draft: "This is a draft. It will be reviewed and updated before Breinhap is published on Google Play.",
    updated: `Last updated: ${POLICY_UPDATED}`,
    sections: [
      ["Who we are", [`Breinhap is an app by ASafariM in Belgium. Questions about your data? Email ${mail}.`]],
      [
        "What data we use",
        [
          {
            list: [
              "<strong>Your account.</strong> You sign in with your ASafariM account. Breinhap receives an account id, your email address (for the sign-in code) and your display name.",
              "<strong>Your learning progress.</strong> Which missions you did, which questions were right or not yet right, and when to review something.",
              "<strong>What you enter about school.</strong> Lessons, tests and tasks. We delete them automatically 30 days after their date.",
              "<strong>Your settings.</strong> Theme, calm mode and large text. These stay on your device.",
              "<strong>Requests to the AI</strong> (“Explain it differently”). We only send the text of the card, never your name, school or timetable. We keep these for 30 days to review misuse.",
            ],
          },
        ],
      ],
      [
        "What we never collect",
        [
          {
            list: [
              "A diagnosis or any other health data.",
              "Your location, contacts, photos, camera or microphone.",
              "An advertising id. There are no ads.",
              "Data for tracking or analytics by other companies.",
            ],
          },
        ],
      ],
      [
        "Why we use it",
        [
          "To make the app work: picking your missions, keeping your progress and showing it on your other devices. That is performing the service you ask for (GDPR article 6.1.b).",
          "In Belgium you can decide about an app like this yourself from age 13. We write everything so you can read it yourself.",
        ],
      ],
      [
        "Who helps us",
        [
          "We work with a few service providers: hosting in the European Union, an email service for sign-in codes, and an AI provider. Each has a data processing agreement with us. The AI provider may not use your data to train its models. We never sell data.",
        ],
      ],
      [
        "How long we keep data",
        [
          {
            list: [
              "Account and learning progress: until you delete your account.",
              "School items: until 30 days after their date.",
              "Requests to the AI: 30 days.",
            ],
          },
        ],
      ],
      [
        "Your rights",
        [
          `You can see, correct, delete and take your data with you, and you can object. Email ${mail}. You can also delete your account yourself: see <a href="{{deleteHref}}">Delete your account</a>.`,
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
    title: "Je account verwijderen",
    lead: "Je kan je Breinhap-account en al je gegevens altijd verwijderen. Zo doe je dat.",
    sections: [
      [
        "In de app",
        [{ ordered: ["Open Breinhap.", "Ga naar Instellingen.", "Tik op Account verwijderen en bevestig."] }],
      ],
      [
        "Zonder de app",
        [
          `Mail naar ${mail} vanaf het e-mailadres van je account, met als onderwerp “Account verwijderen”. We verwijderen je account binnen 30 dagen en bevestigen dat per mail.`,
        ],
      ],
      [
        "Wat we verwijderen",
        [{ list: ["Je Breinhap-account.", "Je leervoortgang en herhaalplanning.", "De lessen, toetsen en taken die je invoerde.", "Je vragen aan de AI."] }],
      ],
      [
        "Wat we bewaren",
        [
          "Alleen een notitie dát we een account verwijderd hebben, met de datum, als bewijs. Die notitie bevat geen leergegevens en verdwijnt na 12 maanden.",
          "Je ASafariM-account zelf wordt ook door andere ASafariM-apps gebruikt. Wil je dat ook verwijderen? Zet het in je mail.",
        ],
      ],
    ],
  },
  en: {
    title: "Delete your account",
    lead: "You can always delete your Breinhap account and all your data. Here's how.",
    sections: [
      ["In the app", [{ ordered: ["Open Breinhap.", "Go to Settings.", "Tap Delete account and confirm."] }]],
      [
        "Without the app",
        [
          `Email ${mail} from your account's email address, with the subject “Delete account”. We delete your account within 30 days and confirm by email.`,
        ],
      ],
      [
        "What we delete",
        [{ list: ["Your Breinhap account.", "Your learning progress and review schedule.", "The lessons, tests and tasks you entered.", "Your requests to the AI."] }],
      ],
      [
        "What we keep",
        [
          "Only a note that we deleted an account, with the date, as proof. It holds no learning data and is removed after 12 months.",
          "Your ASafariM account itself is also used by other ASafariM apps. Want that deleted too? Say so in your email.",
        ],
      ],
    ],
  },
};
