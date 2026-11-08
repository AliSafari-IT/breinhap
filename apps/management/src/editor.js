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
