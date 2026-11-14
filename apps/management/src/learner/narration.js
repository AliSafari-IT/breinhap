// Read-aloud on breinhap.com (prototype). Progressive: without JavaScript there is no button and the
// page works as before. A block marked data-narration gets a button that plays the recorded clip for
// the chosen Breinhap voice when the server has one for this exact text, and otherwise the browser's
// own speech in Dutch. Nothing is fetched except the clip itself from this site; the voice choice is
// kept in this browser only.
(() => {
	const KEY = "breinhap.narrator";
	const blocks = document.querySelectorAll("[data-narration]");
	if (!blocks.length) return;
	let audio = null;
	const synth = "speechSynthesis" in window ? window.speechSynthesis : null;
	const stored = () => {
		try {
			return localStorage.getItem(KEY);
		} catch {
			return null;
		}
	};
	const store = (value) => {
		try {
			localStorage.setItem(KEY, value);
		} catch {}
	};
	const stop = () => {
		if (audio) audio.pause();
		if (synth) synth.cancel();
	};
	for (const block of blocks) {
		const d = block.dataset;
		const narrators = ["vrouw", "man"].filter((n) => d[`clip${n[0].toUpperCase()}${n.slice(1)}`]);
		if (!narrators.length && !synth) continue;
		const bar = document.createElement("div");
		bar.className = "narration";
		const button = document.createElement("button");
		button.type = "button";
		button.className = "secondary";
		button.textContent = d.labelRead;
		bar.append(button);
		let select = null;
		if (narrators.length) {
			select = document.createElement("select");
			select.setAttribute("aria-label", d.labelVoice);
			for (const value of [...narrators, ...(synth ? ["device"] : [])]) {
				const option = document.createElement("option");
				option.value = value;
				option.textContent = d[`label${value[0].toUpperCase()}${value.slice(1)}`];
				select.append(option);
			}
			const saved = stored();
			if (saved && [...select.options].some((o) => o.value === saved)) select.value = saved;
			select.addEventListener("change", () => {
				stop();
				store(select.value);
			});
			bar.append(select);
		}
		const setPlaying = (on) => {
			button.textContent = on ? d.labelStop : d.labelRead;
			button.setAttribute("aria-pressed", on ? "true" : "false");
		};
		button.addEventListener("click", () => {
			if (button.getAttribute("aria-pressed") === "true") {
				stop();
				return setPlaying(false);
			}
			stop();
			const choice = select ? select.value : "device";
			const clip = choice !== "device" ? d[`clip${choice[0].toUpperCase()}${choice.slice(1)}`] : null;
			if (clip) {
				audio = audio ?? new Audio();
				audio.src = clip;
				audio.onended = audio.onpause = () => setPlaying(false);
				audio.play().then(() => setPlaying(true), () => setPlaying(false));
				return;
			}
			if (!synth) return;
			const utterance = new SpeechSynthesisUtterance(d.narration);
			utterance.lang = "nl-BE";
			utterance.rate = 0.9;
			const voice = synth.getVoices().find((v) => /^nl[-_]BE/i.test(v.lang)) ?? synth.getVoices().find((v) => /^nl/i.test(v.lang));
			if (voice) utterance.voice = voice;
			utterance.onend = utterance.onerror = () => setPlaying(false);
			synth.speak(utterance);
			setPlaying(true);
		});
		block.prepend(bar);
	}
})();
