// breinhap#27: small comforts on top of plain forms (everything also works without this script).
// Focus the error summary after a refused save, warn before leaving with unsaved changes, and
// prevent a double submit.
(() => {
	const summary = document.getElementById("fouten");
	if (summary) summary.focus();
	const form = document.querySelector("form[data-editor]");
	if (!form) return;
	let dirty = false;
	form.addEventListener("input", () => {
		dirty = true;
	});
	window.addEventListener("beforeunload", (event) => {
		if (dirty) event.preventDefault();
	});
	form.addEventListener("submit", (event) => {
		if (form.dataset.sending === "1") {
			event.preventDefault();
			return;
		}
		form.dataset.sending = "1";
		dirty = false;
		const button = form.querySelector('button[type="submit"]');
		if (button) button.textContent = document.documentElement.dataset.saving;
	});
})();

// breinhap#81: the practice-pack link is shown once; this adds a copy button on top of the selectable field.
(() => {
	for (const input of document.querySelectorAll?.("input[data-select]") ?? []) input.addEventListener("focus", () => input.select());
	const button = document.querySelector("button[data-copy]");
	if (!button) return;
	const field = document.getElementById(button.dataset.copy);
	const status = document.getElementById("kopieerstatus");
	if (!field || typeof navigator === "undefined" || !navigator.clipboard) return;
	button.hidden = false;
	button.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(field.value);
			if (status) status.textContent = button.dataset.copied;
		} catch {
			field.focus();
			field.select();
			if (status) status.textContent = button.dataset.failed;
		}
	});
})();
