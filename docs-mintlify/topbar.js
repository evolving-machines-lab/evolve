// The navbar links and the Dashboard button belong on the tab bar. Maple
// renders them at the sidebar's bottom (#sidebar > ul); this copies that list
// into the tab bar's own container (#navbar-transition-maple), at its right
// end, and keeps the copy there across client-side navigation.
(function () {
  function place() {
    var strip = document.getElementById("navbar-transition-maple");
    var source = document.querySelector("#sidebar > ul");
    if (!strip || !source || document.getElementById("topbar-cluster")) return;
    var cluster = source.cloneNode(true);
    cluster.id = "topbar-cluster";
    cluster.removeAttribute("class");
    strip.appendChild(cluster);
  }
  place();
  new MutationObserver(place).observe(document.documentElement, { childList: true, subtree: true });
})();
