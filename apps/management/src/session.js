// Invitation secrets stay in the URL fragment until moved into a host-only cookie.
(async () => {
	const token =
		location.pathname === "/uitnodiging" ? location.hash.slice(1) : "";
	if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
		history.replaceState(null, "", location.pathname);
		try {
			const response = await fetch("/auth/invite-link", {
				method: "POST",
				credentials: "same-origin",
				body: new URLSearchParams({ token }),
				redirect: "manual",
			});
			if (response.type === "opaqueredirect" || response.ok)
				location.replace("/uitnodiging/bevestigen");
		} catch {
			/* Retry by reopening the original invitation link. */
		}
		return;
	}
	if (!document.querySelector('nav.management-nav')) return;
	let checking = false;
	async function check() {
		if (document.hidden || checking) return;
		checking = true;
		try {
			const response = await fetch("/auth/session", {
				credentials: "same-origin",
				cache: "no-store",
				signal: AbortSignal.timeout(5000),
			});
			if (response.status === 401) location.replace("/login");
			else if (response.status === 403) location.replace("/registreren");
			else if (!response.ok) {
				// Hide private content during an outage; reload triggers a fresh server-side check.
				const main = document.querySelector("main");
				main.replaceChildren();
				const text = document.createElement("p");
				text.textContent =
					document.documentElement.dataset.accessUnavailable;
				main.append(text);
			}
		} catch {
			const main = document.querySelector("main");
			main.textContent =
				document.documentElement.dataset.connectionLost;
		} finally {
			checking = false;
		}
	}
	setInterval(check, 45_000);
	addEventListener("focus", check);
	document.addEventListener("visibilitychange", check);
})();
