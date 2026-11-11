/*
 * The breinhap.com navbar's account state (breinhap#24, S4). breinhap.com is static and the session cookie is a
 * host-only __Host- cookie on management.breinhap.com, so this page learns the state only by asking management's
 * /auth/session with a credentialed request (same-site, so the SameSite=Lax cookie travels with it). Management
 * answers { active, access, initials } from the validated Breinhap session and the local grants it checks now;
 * nothing here is trusted for authorization, and management enforces the same permissions on its own routes.
 *
 * - Signed out (or any error): the Sign in and Create account links stay.
 * - Signed in: the account menu with the person's initials replaces them. Its "Breinhap beheer" entry appears
 *   only when management says the session has management access; otherwise it offers "My account".
 * - The state is asked again every 60 seconds and when the tab becomes visible, so a logout or a revoked
 *   membership reaches an open page within that bound.
 *
 * This script loads without defer in <head>: it marks the page as checking at once, and the stylesheet keeps the
 * navbar actions invisible (not removed) until the first answer or CHECK_MS, so a signed-in visitor does not see
 * the sign-in links flash first. Without JavaScript nothing is marked and the sign-in links simply show.
 */
(function () {
  if (typeof window === "undefined" || typeof document === "undefined" || typeof fetch !== "function") return;
  var MANAGEMENT = "https://management.breinhap.com";
  var RECHECK_MS = 60000;
  var CHECK_MS = 1500;
  var root = document.documentElement;
  var state = null;
  var inFlight = false;

  root.setAttribute("data-account-state", "checking");
  var reveal = setTimeout(function () {
    if (root.getAttribute("data-account-state") === "checking") root.setAttribute("data-account-state", "signed-out");
  }, CHECK_MS);

  function find(name) {
    return document.querySelector('[data-account="' + name + '"]');
  }
  function setHidden(element, hidden) {
    if (element) element.hidden = hidden;
  }

  function render() {
    if (!state || document.readyState === "loading") return;
    var signedIn = state.active === true;
    setHidden(find("login"), signedIn);
    setHidden(find("register"), signedIn);
    var menu = find("menu");
    if (menu) {
      menu.hidden = !signedIn;
      if (!signedIn) menu.open = false;
    }
    setHidden(find("manage"), !(signedIn && state.access === true));
    setHidden(find("profile"), !(signedIn && state.access !== true));
    var initials = find("initials");
    if (initials) initials.textContent = signedIn ? state.initials : "";
    clearTimeout(reveal);
    root.setAttribute("data-account-state", signedIn ? (state.access === true ? "management" : "signed-in") : "signed-out");
  }

  /** Only the shape management sends is accepted; anything else counts as signed out. */
  function accept(value) {
    var active = !!value && value.active === true;
    var initials = active && typeof value.initials === "string" && /^[\p{L}\p{N}]{1,2}$/u.test(value.initials) ? value.initials : "";
    state = { active: active, access: active && value.access === true, initials: initials };
    render();
  }

  function check() {
    if (inFlight) return;
    inFlight = true;
    var options = { credentials: "include", cache: "no-store", mode: "cors" };
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) options.signal = AbortSignal.timeout(5000);
    fetch(MANAGEMENT + "/auth/session", options)
      .then(function (response) {
        // Anonymous probes get 200 { active: false } (#91); any other answer means "not signed in".
        if (!response || !response.ok) return null;
        return response.json().catch(function () {
          return null;
        });
      })
      .then(
        function (value) {
          accept(value);
        },
        function () {
          // Offline or blocked: show signed out on the first check, keep the last known state afterwards.
          // Hiding a link is never authorization; management checks every request itself.
          if (!state) accept(null);
        },
      )
      .then(function () {
        inFlight = false;
      });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", render);
  check();
  setInterval(check, RECHECK_MS);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") check();
  });
})();
