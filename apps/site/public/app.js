/*
 * The "Hoe het werkt" player: shows one phone scene at a time and highlights its step.
 * - Plays on its own, one scene every few seconds, with a pause button (moving content must be pausable).
 * - Clicking a step shows that scene and pauses.
 * - With prefers-reduced-motion it never plays on its own; the steps still work by clicking.
 * Without JavaScript the first scene and the full list of steps are shown.
 */
(function () {
  var flow = document.querySelector("[data-flow]");
  if (!flow) return;
  var scenes = flow.querySelectorAll(".scene");
  var steps = flow.querySelectorAll("[data-step]");
  var toggle = flow.querySelector("[data-flow-toggle]");
  var caption = flow.querySelector("[data-flow-caption]");
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
  var DURATIONS = [3500, 3500, 3800, 5200, 4200, 4200];
  var current = 0;
  var timer = null;
  var playing = false;

  function show(index) {
    current = (index + scenes.length) % scenes.length;
    for (var i = 0; i < scenes.length; i++) {
      scenes[i].classList.toggle("is-active", i === current);
      steps[i].classList.toggle("is-active", i === current);
      steps[i].setAttribute("aria-pressed", i === current ? "true" : "false");
    }
    if (caption) {
      var title = steps[current].querySelector(".flow-title");
      caption.innerHTML = "";
      var strong = document.createElement("strong");
      strong.textContent = (current + 1) + ". ";
      caption.appendChild(strong);
      caption.appendChild(document.createTextNode(title ? title.textContent : ""));
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (playing) timer = setTimeout(function () { show(current + 1); schedule(); }, DURATIONS[current] || 4000);
  }
  function setPlaying(value) {
    playing = value;
    if (toggle) toggle.textContent = playing ? toggle.getAttribute("data-pause") : toggle.getAttribute("data-play");
    schedule();
  }

  for (var i = 0; i < steps.length; i++) {
    steps[i].addEventListener("click", function (e) {
      show(Number(e.currentTarget.getAttribute("data-step")));
      setPlaying(false);
    });
  }
  if (toggle) {
    toggle.hidden = false;
    toggle.addEventListener("click", function () { setPlaying(!playing); });
  }

  // Start only when the phone is on screen, so nobody misses the first steps.
  var startWhenVisible = function () {
    if (reduce && reduce.matches) { setPlaying(false); return; }
    if (!("IntersectionObserver" in window)) { setPlaying(true); return; }
    var seen = false;
    new IntersectionObserver(function (entries, observer) {
      if (!seen && entries[0].isIntersecting) {
        seen = true;
        observer.disconnect();
        show(0);
        setPlaying(true);
      }
    }, { threshold: 0.4 }).observe(flow);
  };
  if (reduce && reduce.addEventListener) {
    reduce.addEventListener("change", function () { if (reduce.matches) setPlaying(false); });
  }
  setPlaying(false);
  startWhenVisible();
})();
