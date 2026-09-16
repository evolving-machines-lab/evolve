// The navbar links and the Dashboard button belong on the tab bar. Maple
// renders them at the sidebar's bottom (#sidebar > ul); this copies that list
// into the tab bar's own container (#navbar-transition-maple), at its right
// end, and keeps the copy there: on first paint (DOMContentLoaded, load, and a
// short retry timer), and across every later re-render (a mutation observer
// over the whole document, the tab bar included).
(function () {
  function place() {
    var strip = document.getElementById("navbar-transition-maple");
    var source = document.querySelector("#sidebar > ul");
    if (!strip || !source) return false;
    var existing = document.getElementById("topbar-cluster");
    if (existing && existing.parentElement === strip) return true;
    if (existing) existing.remove();
    var cluster = source.cloneNode(true);
    cluster.id = "topbar-cluster";
    cluster.removeAttribute("class");
    strip.appendChild(cluster);
    return true;
  }
  place();
  document.addEventListener("DOMContentLoaded", place);
  window.addEventListener("load", place);
  var tries = 0;
  var timer = setInterval(function () {
    if (place() || ++tries >= 40) clearInterval(timer);
  }, 250);
  new MutationObserver(function () { place(); }).observe(document.documentElement, { childList: true, subtree: true });
})();
