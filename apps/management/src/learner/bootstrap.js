// breinhap#82: reads the link code from the address fragment, removes it from the address bar and the
// history BEFORE anything is sent, then posts it in a form body. Without JavaScript the same form takes
// the code typed or pasted by hand. The code never appears in a request line, referrer or log.
(() => {
	const form = document.querySelector('form[action="/p/resolve"]');
	const input = document.getElementById("code");
	if (!form || !input) return;
	const code = location.hash.slice(1);
	if (!code) return;
	history.replaceState(null, "", location.pathname + location.search);
	input.value = code;
	form.submit();
})();
