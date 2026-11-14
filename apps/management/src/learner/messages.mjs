/**
 * Learner chrome in the four languages of the pack (breinhap#82). The language is the pack's
 * declaration (or the browser's Accept-Language before a pack is known); authored content is never
 * translated. Score prose keeps the numbers of the shared mission rules.
 */
export const LANGUAGES = ["nl", "en", "fr", "de"];

const M = {
	skip: ["Naar inhoud", "Skip to content", "Aller au contenu", "Zum Inhalt"],
	bootTitle: ["Oefenen met Breinhap", "Practise with Breinhap", "S’exercer avec Breinhap", "Üben mit Breinhap"],
	bootIntro: [
		"Open de link die je kreeg. Gebeurt er niets? Plak dan hieronder de code uit de link (het stuk na het #-teken).",
		"Open the link you were given. Nothing happening? Paste the code from the link below (the part after the # sign).",
		"Ouvrez le lien que vous avez reçu. Rien ne se passe ? Collez ci-dessous le code du lien (la partie après le signe #).",
		"Öffne den Link, den du bekommen hast. Passiert nichts? Füge unten den Code aus dem Link ein (der Teil nach dem #-Zeichen).",
	],
	codeLabel: ["Code uit de link", "Code from the link", "Code du lien", "Code aus dem Link"],
	open: ["Openen", "Open", "Ouvrir", "Öffnen"],
	startTitle: ["Klaar om te beginnen?", "Ready to start?", "Prêt à commencer ?", "Bereit zum Start?"],
	about: [
		"{0} vragen, ongeveer {1} minuten. Je kunt rustig nadenken: er is geen tijdsdruk.",
		"{0} questions, about {1} minutes. Take your time: there is no time pressure.",
		"{0} questions, environ {1} minutes. Prenez votre temps : il n’y a pas de pression de temps.",
		"{0} Fragen, etwa {1} Minuten. Lass dir Zeit: Es gibt keinen Zeitdruck.",
	],
	stepsInfo: [
		"Elke missie heeft vier stappen: Opwarmen, Leren, Doen en Check.",
		"Every mission has four steps: Warm up, Learn, Do and Check.",
		"Chaque mission comporte quatre étapes : Échauffement, Apprendre, Faire et Vérifier.",
		"Jede Mission hat vier Schritte: Aufwärmen, Lernen, Tun und Prüfen.",
	],
	privacy: [
		"Je antwoorden zijn zichtbaar voor de volwassene die je deze link gaf. Je hoeft geen naam of e-mailadres in te vullen.",
		"Your answers can be seen by the adult who gave you this link. You do not need to enter a name or email address.",
		"Vos réponses sont visibles par l’adulte qui vous a donné ce lien. Vous n’avez pas besoin d’indiquer un nom ni une adresse e-mail.",
		"Deine Antworten kann die erwachsene Person sehen, die dir diesen Link gegeben hat. Du musst keinen Namen und keine E-Mail-Adresse eingeben.",
	],
	testInfo: [
		"Dit is een toets: je ziet pas na het inleveren of je antwoorden kloppen.",
		"This is a test: you only see whether your answers are right after you hand it in.",
		"Ceci est un test : vous ne voyez si vos réponses sont justes qu’après l’avoir remis.",
		"Das ist ein Test: Ob deine Antworten stimmen, siehst du erst nach dem Abgeben.",
	],
	start: ["Starten", "Start", "Commencer", "Starten"],
	"step.Opwarmen": ["Opwarmen", "Warm up", "Échauffement", "Aufwärmen"],
	"step.Leren": ["Leren", "Learn", "Apprendre", "Lernen"],
	"step.Doen": ["Doen", "Do", "Faire", "Tun"],
	"step.Check": ["Check", "Check", "Vérifier", "Prüfen"],
	progress: ["Stap {0} van {1}", "Step {0} of {1}", "Étape {0} sur {1}", "Schritt {0} von {1}"],
	example: ["Voorbeeld: {0}", "Example: {0}", "Exemple : {0}", "Beispiel: {0}"],
	next: ["Verder", "Continue", "Continuer", "Weiter"],
	readAloud: ["🔊 Voorlezen", "🔊 Read aloud", "🔊 Lire à voix haute", "🔊 Vorlesen"],
	stopReading: ["⏹ Stoppen", "⏹ Stop", "⏹ Arrêter", "⏹ Stoppen"],
	voice: ["Stem", "Voice", "Voix", "Stimme"],
	voice_vrouw: ["Breinhap · vrouw", "Breinhap · woman", "Breinhap · femme", "Breinhap · Frau"],
	voice_man: ["Breinhap · man", "Breinhap · man", "Breinhap · homme", "Breinhap · Mann"],
	voiceDevice: ["Stem van je toestel", "Your device's voice", "Voix de ton appareil", "Stimme deines Geräts"],
	check: ["Controleer", "Check answer", "Vérifier", "Prüfen"],
	save: ["Bewaar antwoord", "Save answer", "Enregistrer la réponse", "Antwort speichern"],
	chooseAnswer: ["Kies een antwoord.", "Choose an answer.", "Choisissez une réponse.", "Wähle eine Antwort."],
	place: ["Plaats {0}", "Place {0}", "Place {0}", "Platz {0}"],
	choose: ["Kies…", "Choose…", "Choisir…", "Wählen…"],
	itemsHint: [
		"De stukjes: {0}. Kies voor elke plaats een stukje; gebruik elk stukje één keer.",
		"The pieces: {0}. Choose a piece for each place; use every piece once.",
		"Les éléments : {0}. Choisissez un élément pour chaque place ; utilisez chaque élément une fois.",
		"Die Teile: {0}. Wähle für jeden Platz ein Teil; benutze jedes Teil einmal.",
	],
	placeAll: [
		"Zet elk stukje op precies één plaats.",
		"Put every piece in exactly one place.",
		"Placez chaque élément à exactement une place.",
		"Setze jedes Teil an genau einen Platz.",
	],
	right: ["Klopt.", "Correct.", "C’est juste.", "Stimmt."],
	wrong: ["Nog niet.", "Not yet.", "Pas encore.", "Noch nicht."],
	correctOrder: ["De juiste volgorde: {0}.", "The correct order: {0}.", "Le bon ordre : {0}.", "Die richtige Reihenfolge: {0}."],
	yourChoice: ["jouw keuze", "your choice", "votre choix", "deine Wahl"],
	submitTitle: ["Alles beantwoord", "All answered", "Tout est répondu", "Alles beantwortet"],
	submitText: [
		"Je hebt alle vragen gehad. Lever in om je resultaat te zien.",
		"You have been through all the questions. Hand in to see your result.",
		"Vous avez parcouru toutes les questions. Remettez pour voir votre résultat.",
		"Du hast alle Fragen gehabt. Gib ab, um dein Ergebnis zu sehen.",
	],
	submit: ["Inleveren", "Hand in", "Remettre", "Abgeben"],
	resultTitle: ["Resultaat", "Result", "Résultat", "Ergebnis"],
	scoreSome: [
		"Je had {0} van de {1} vragen juist.",
		"You got {0} of the {1} questions right.",
		"Vous avez eu {0} réponses justes sur {1}.",
		"Du hattest {0} von {1} Fragen richtig.",
	],
	scoreNone: [
		"Je hebt {0} vragen geoefend. Lees de uitleg nog eens rustig na.",
		"You practised {0} questions. Read the explanations again at your own pace.",
		"Vous avez travaillé {0} questions. Relisez calmement les explications.",
		"Du hast {0} Fragen geübt. Lies die Erklärungen noch einmal in Ruhe.",
	],
	review: ["Terugblik", "Review", "Retour sur les réponses", "Rückblick"],
	yourAnswer: ["Jouw antwoord: {0}", "Your answer: {0}", "Votre réponse : {0}", "Deine Antwort: {0}"],
	done: ["Klaar", "Done", "Terminé", "Fertig"],
	doneText: [
		"Klaar. Dit apparaat onthoudt je poging niet meer. Je kunt dit venster sluiten.",
		"Done. This device no longer remembers your attempt. You can close this window.",
		"Terminé. Cet appareil ne se souvient plus de votre essai. Vous pouvez fermer cette fenêtre.",
		"Fertig. Dieses Gerät merkt sich deinen Versuch nicht mehr. Du kannst dieses Fenster schließen.",
	],
	notFoundTitle: ["Deze link werkt niet", "This link does not work", "Ce lien ne fonctionne pas", "Dieser Link funktioniert nicht"],
	notFoundText: [
		"Controleer of je de hele link hebt gekopieerd, of vraag de volwassene die je de link gaf om hulp.",
		"Check that you copied the whole link, or ask the adult who gave you the link for help.",
		"Vérifiez que vous avez copié tout le lien, ou demandez de l’aide à l’adulte qui vous l’a donné.",
		"Prüfe, ob du den ganzen Link kopiert hast, oder frage die erwachsene Person, die dir den Link gegeben hat.",
	],
	goneTitle: ["Deze link is niet meer beschikbaar", "This link is no longer available", "Ce lien n’est plus disponible", "Dieser Link ist nicht mehr verfügbar"],
	goneText: [
		"Vraag de volwassene die je de link gaf om een nieuwe.",
		"Ask the adult who gave you the link for a new one.",
		"Demandez-en un nouveau à l’adulte qui vous a donné le lien.",
		"Bitte die erwachsene Person, die dir den Link gegeben hat, um einen neuen.",
	],
	staleTitle: ["Dit scherm is verouderd", "This screen is out of date", "Cet écran est périmé", "Dieser Bildschirm ist veraltet"],
	staleText: [
		"Er is intussen iets veranderd, bijvoorbeeld in een ander tabblad. Ga verder vanaf waar je was.",
		"Something changed in the meantime, for example in another tab. Continue from where you were.",
		"Quelque chose a changé entre-temps, par exemple dans un autre onglet. Reprenez là où vous en étiez.",
		"Inzwischen hat sich etwas geändert, zum Beispiel in einem anderen Tab. Mach dort weiter, wo du warst.",
	],
	unfinished: ["Beantwoord eerst de vraag.", "Answer the question first.", "Répondez d’abord à la question.", "Beantworte zuerst die Frage."],
	errorTitle: ["Er ging iets mis", "Something went wrong", "Une erreur s’est produite", "Etwas ist schiefgelaufen"],
	errorText: ["Probeer het over een poosje opnieuw.", "Try again in a little while.", "Réessayez dans un moment.", "Versuche es in einer Weile noch einmal."],
	tooManyTitle: ["Even wachten", "Please wait a moment", "Patientez un instant", "Bitte einen Moment warten"],
	tooManyText: [
		"Er kwamen te veel aanvragen tegelijk. Probeer het over een minuut opnieuw; er is niets verloren gegaan.",
		"Too many requests came in at once. Try again in a minute; nothing has been lost.",
		"Trop de demandes sont arrivées en même temps. Réessayez dans une minute ; rien n’a été perdu.",
		"Es kamen zu viele Anfragen auf einmal. Versuche es in einer Minute erneut; nichts ist verloren gegangen.",
	],
	continue: ["Ga verder", "Continue", "Continuer", "Weiter machen"],
	footer: [
		"Breinhap · geen account nodig · geen advertenties of tracking",
		"Breinhap · no account needed · no ads or tracking",
		"Breinhap · aucun compte requis · ni publicité ni suivi",
		"Breinhap · kein Konto nötig · keine Werbung und kein Tracking",
	],
	// breinhap#35: the public mission catalogue (/p/missies)
	catalogueTitle: ["Missies", "Missions", "Missions", "Missionen"],
	catalogueIntro: [
		"Kies een missie om rustig te oefenen. Je hebt geen account nodig en er wordt niets bewaard.",
		"Choose a mission to practise at your own pace. You do not need an account and nothing is saved.",
		"Choisissez une mission pour vous exercer à votre rythme. Aucun compte n’est nécessaire et rien n’est enregistré.",
		"Wähle eine Mission und übe in Ruhe. Du brauchst kein Konto und es wird nichts gespeichert.",
	],
	subject: ["Vak", "Subject", "Matière", "Fach"],
	year: ["Jaar", "Year", "Année", "Jahr"],
	yearN: ["Jaar {0}", "Year {0}", "Année {0}", "Jahr {0}"],
	allSubjects: ["Alle vakken", "All subjects", "Toutes les matières", "Alle Fächer"],
	allYears: ["Alle jaren", "All years", "Toutes les années", "Alle Jahre"],
	filter: ["Toon missies", "Show missions", "Afficher les missions", "Missionen zeigen"],
	missionCount: [
		"{0} missie(s), samen ongeveer {1} minuten",
		"{0} mission(s), about {1} minutes in all",
		"{0} mission(s), environ {1} minutes au total",
		"{0} Mission(en), zusammen etwa {1} Minuten",
	],
	emptyCatalogue: [
		"Er staan nog geen missies klaar. Kom later nog eens kijken.",
		"There are no missions ready yet. Have a look again later.",
		"Aucune mission n’est encore prête. Revenez plus tard.",
		"Es sind noch keine Missionen bereit. Schau später noch einmal vorbei.",
	],
	emptyFiltered: [
		"Voor deze keuze is er nog geen missie.",
		"There is no mission for this choice yet.",
		"Il n’y a pas encore de mission pour ce choix.",
		"Für diese Auswahl gibt es noch keine Mission.",
	],
	showAll: ["Toon alle missies", "Show all missions", "Afficher toutes les missions", "Alle Missionen zeigen"],
	backToCatalogue: ["Terug naar de missies", "Back to the missions", "Retour aux missions", "Zurück zu den Missionen"],
	publicPrivacy: [
		"Je antwoorden blijven alleen op dit scherm. Niemand ziet ze en ze worden niet bewaard.",
		"Your answers stay on this screen only. Nobody sees them and they are not saved.",
		"Vos réponses restent uniquement sur cet écran. Personne ne les voit et elles ne sont pas enregistrées.",
		"Deine Antworten bleiben nur auf diesem Bildschirm. Niemand sieht sie und sie werden nicht gespeichert.",
	],
	missionDone: ["Missie klaar", "Mission done", "Mission terminée", "Mission geschafft"],
	commonMistake: ["Veelgemaakte fout", "A common mistake", "Erreur fréquente", "Häufiger Fehler"],
	again: ["Nog eens", "Once more", "Encore une fois", "Noch einmal"],
	missionGoneTitle: ["Deze missie is er niet", "This mission is not here", "Cette mission n’est pas disponible", "Diese Mission gibt es nicht"],
	missionGoneText: [
		"Ze bestaat niet of is niet meer beschikbaar. Kies een andere missie.",
		"It does not exist or is no longer available. Choose another mission.",
		"Elle n’existe pas ou n’est plus disponible. Choisissez une autre mission.",
		"Sie existiert nicht oder ist nicht mehr verfügbar. Wähle eine andere Mission.",
	],
};

/** A learner message in `lang` with `{n}` slots filled. Unknown languages fall back to Dutch. */
export function t(lang, key, ...values) {
	const index = Math.max(0, LANGUAGES.indexOf(lang));
	const message = M[key]?.[index] ?? key;
	return message.replace(/\{(\d+)\}/g, (_, i) => String(values[i] ?? ""));
}

/** The language for pages shown before any pack is known: the first supported Accept-Language entry. */
export function languageOf(header) {
	for (const part of String(header ?? "").split(",").slice(0, 8)) {
		const code = part.trim().slice(0, 2).toLowerCase();
		if (LANGUAGES.includes(code)) return code;
	}
	return "nl";
}

export const HTML_LANG = { nl: "nl-BE", en: "en", fr: "fr-BE", de: "de-BE" };
