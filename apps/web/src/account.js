/*
 * Shows a signed-in adult that they are signed in. breinhap.com is static, and the session cookie is a
 * host-only __Host- cookie on management.breinhap.com, so this page can only learn it by asking management.
 * The two hosts are same-site, so the SameSite=Lax cookie travels with this credentialed request; the
 * answer is only { active }. On any error or timeout the navbar keeps its sign-in links.
 */
(function () {
  if (typeof window === "undefined" || typeof fetch !== "function") return;
  var MANAGEMENT = "https://management.breinhap.com";

  function show() {
    var login = document.querySelector('[data-account="login"]');
    if (!login) return;
    login.textContent = login.getAttribute("data-signed-in-label");
    login.setAttribute("href", MANAGEMENT + "/");
    var register = document.querySelector('[data-account="register"]');
    if (register) register.hidden = true;
  }

  var options = { credentials: "include", cache: "no-store", mode: "cors" };
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) options.signal = AbortSignal.timeout(5000);
  fetch(MANAGEMENT + "/auth/session", options).then(
    function (response) {
      // 200: signed in with access; 403: signed in without management access yet. 401: not signed in.
      if (response.status !== 200 && response.status !== 403) return;
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", show);
      else show();
    },
    function () {
      /* Offline or blocked: keep the sign-in links. */
    },
  );
})();
