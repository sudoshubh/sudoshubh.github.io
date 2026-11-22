(function () {
  "use strict";
  var P = window.PATTERNS, CMP = window.COMPARE, CON = window.CONCEPTS;
  var main = document.getElementById("main");
  var navList = document.getElementById("navList");
  var sidebar = document.getElementById("sidebar");
  var menuBtn = document.getElementById("menuBtn");
  var search = document.getElementById("search");

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }

  /* ---------- navigation ---------- */
  var extra = [
    { id: "compare", name: "Compare all patterns", tag: "vs" },
    { id: "concepts", name: "Shared building blocks", tag: "Core" }
  ];
  function renderNav(filter) {
    var f = (filter || "").toLowerCase();
    var html = '<li><a href="#home" data-id="home">Overview</a></li><li class="sep">Patterns</li>';
    P.forEach(function (p) {
      if (f && (p.name + " " + p.tag + " " + p.tagline).toLowerCase().indexOf(f) < 0) return;
      html += '<li><a href="#' + p.id + '" data-id="' + p.id + '"><span class="pill">' + esc(p.tag) + "</span>" + esc(p.name) + "</a></li>";
    });
    html += '<li class="sep">Reference</li>';
    extra.forEach(function (e) {
      html += '<li><a href="#' + e.id + '" data-id="' + e.id + '"><span class="pill">' + e.tag + "</span>" + e.name + "</a></li>";
    });
    navList.innerHTML = html;
    markActive();
  }
  function markActive() {
    var id = currentId();
    Array.prototype.forEach.call(navList.querySelectorAll("a"), function (a) {
      var on = a.getAttribute("data-id") === id;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  }
  function currentId() { return (location.hash || "#home").slice(1) || "home"; }

  /* ---------- views ---------- */
  function home() {
    var h = "<h1>Storage System Design Patterns</h1>" +
      '<p class="lead">' + P.length + " storage-domain architectures in one place: requirements, architecture, request flows, deep dives, failure handling and trade-offs. Pick one to start, or compare them side by side.</p>" +
      '<div class="grid">';
    P.forEach(function (p) {
      h += '<a class="card" href="#' + p.id + '"><span class="pill">' + esc(p.tag) + "</span><h3>" + esc(p.name) + "</h3><p>" + esc(p.tagline) + "</p></a>";
    });
    h += '<a class="card" href="#compare"><span class="pill">vs</span><h3>Compare all patterns</h3><p>Data unit, consistency, redundancy, latency and best-fit use case in one table.</p></a>';
    h += '<a class="card" href="#concepts"><span class="pill">Core</span><h3>Shared building blocks</h3><p>EC vs replication, quorums, fencing, GC, checksums, throttled repair.</p></a></div>';
    return h;
  }

  function arch(layers) {
    return '<div class="arch">' + layers.map(function (l, i) {
      var nodes = l.nodes.map(function (n) {
        return '<div class="node"><b>' + esc(n.n) + "</b><span>" + esc(n.d) + "</span></div>";
      }).join("");
      return (i ? '<div class="arrow" aria-hidden="true">&#8595;</div>' : "") +
        '<div class="layer"><div class="layer-title">' + esc(l.title) + '</div><div class="nodes">' + nodes + "</div></div>";
    }).join("") + "</div>";
  }

  function table(head, rows) {
    return '<div class="tbl-wrap"><table><thead><tr>' + head.map(function (h) { return "<th>" + esc(h) + "</th>"; }).join("") +
      "</tr></thead><tbody>" + rows.map(function (r) {
        return "<tr>" + r.map(function (c) { return "<td>" + esc(c) + "</td>"; }).join("") + "</tr>";
      }).join("") + "</tbody></table></div>";
  }

  function pattern(p, idx) {
    var h = '<h1>' + esc(p.name) + '</h1><p class="lead">' + esc(p.tagline) + "</p>";
    h += '<div class="chips">' + p.scale.map(function (s) { return '<div class="chip"><b>' + esc(s[1]) + "</b><span>" + esc(s[0]) + "</span></div>"; }).join("") + "</div>";
    h += "<h2>Requirements</h2><ul class=\"req\">" + p.requirements.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul>";
    h += "<h2>Architecture</h2>" + arch(p.layers);
    var keys = Object.keys(p.flows);
    h += "<h2>Request flows</h2><div class=\"tabs\" role=\"tablist\">" + keys.map(function (k, i) {
      return '<button class="tab" role="tab" aria-selected="' + (i === 0) + '" data-flow="' + i + '">' + esc(k) + "</button>";
    }).join("") + '</div><div id="flowBody"></div>';
    h += '<h2>Deep dives</h2><div class="toolbar"><button data-act="open">Expand all</button><button data-act="close">Collapse all</button></div>' +
      p.deepDives.map(function (d, i) { return "<details" + (i === 0 ? " open" : "") + "><summary>" + esc(d.t) + "</summary><div>" + d.b + "</div></details>"; }).join("");
    h += "<h2>Failure scenarios</h2>" + table(["Scenario", "Handling"], p.failures);
    h += "<h2>Trade-offs and decisions</h2>" + table(["Decision", "Choice", "Why"], p.tradeoffs);
    h += '<h2>Interview cheat sheet</h2><div class="cheat"><b>In 30 seconds:</b> ' + esc(p.cheat) + "</div>";
    if (p.doc) h += '<a class="docs-link" href="' + esc(p.doc) + '">Read the full written design (' + esc(p.doc) + ") &rarr;</a>";
    var prev = P[idx - 1], next = P[idx + 1];
    h += '<div class="pager"><span>' + (prev ? '<a href="#' + prev.id + '">&larr; ' + esc(prev.name) + "</a>" : "") + "</span><span>" +
      (next ? '<a href="#' + next.id + '">' + esc(next.name) + " &rarr;</a>" : '<a href="#compare">Compare all &rarr;</a>') + "</span></div>";
    return h;
  }

  function bindPattern(p) {
    var keys = Object.keys(p.flows), body = document.getElementById("flowBody");
    function show(i) {
      body.innerHTML = '<ol class="steps">' + p.flows[keys[i]].map(function (s) { return "<li>" + s + "</li>"; }).join("") + "</ol>";
    }
    show(0);
    var tabs = main.querySelectorAll(".tab");
    Array.prototype.forEach.call(tabs, function (t) {
      t.addEventListener("click", function () {
        Array.prototype.forEach.call(tabs, function (x) { x.setAttribute("aria-selected", x === t); });
        show(+t.getAttribute("data-flow"));
      });
    });
    Array.prototype.forEach.call(main.querySelectorAll(".toolbar button"), function (b) {
      b.addEventListener("click", function () {
        var open = b.getAttribute("data-act") === "open";
        Array.prototype.forEach.call(main.querySelectorAll("details"), function (d) { d.open = open; });
      });
    });
  }

  function compare() {
    return "<h1>Compare all patterns</h1><p class=\"lead\">Same trade-offs, different points on the design space.</p>" +
      table(CMP.cols, CMP.rows) +
      "<h2>How to choose</h2><ul class=\"req\">" +
      "<li><b>Unstructured blobs at huge scale, cheap, HTTP:</b> object store (+ dedup and EC subsystems underneath).</li>" +
      "<li><b>Databases and VMs needing sub-ms latency:</b> block store.</li>" +
      "<li><b>Big sequential analytics:</b> distributed file system.</li>" +
      "<li><b>Online lookups by key at high QPS:</b> distributed KV.</li>" +
      "<li><b>Cloud drive or backup with delta sync:</b> sync + dedup.</li>" +
      "<li><b>Ordered event streams and replay:</b> commit log.</li>" +
      "<li><b>Cross-cutting:</b> inline dedup, erasure coding with self-healing, and QoS apply to almost every system above.</li></ul>";
  }

  function concepts() {
    return "<h1>Shared building blocks</h1><p class=\"lead\">Ideas that recur across every storage system.</p>" +
      CON.map(function (c) { return "<details open><summary>" + esc(c.t) + "</summary><div>" + c.b + "</div></details>"; }).join("");
  }

  /* ---------- router ---------- */
  function route() {
    var id = currentId(), html, idx = -1, p = null;
    if (id === "home") html = home();
    else if (id === "compare") html = compare();
    else if (id === "concepts") html = concepts();
    else {
      for (var i = 0; i < P.length; i++) if (P[i].id === id) { idx = i; p = P[i]; }
      html = p ? pattern(p, idx) : home();
    }
    main.innerHTML = html;
    if (p) bindPattern(p);
    document.title = (p ? p.name : id === "compare" ? "Compare" : id === "concepts" ? "Building blocks" : "Storage System Design Patterns") + " | Storage Design";
    markActive();
    sidebar.classList.remove("open"); menuBtn.setAttribute("aria-expanded", "false");
    window.scrollTo(0, 0);
    main.focus({ preventScroll: true });
  }

  /* ---------- chrome ---------- */
  menuBtn.addEventListener("click", function () {
    var o = sidebar.classList.toggle("open"); menuBtn.setAttribute("aria-expanded", String(o));
  });
  document.getElementById("themeBtn").addEventListener("click", function () {
    var r = document.documentElement, t = r.getAttribute("data-theme") === "dark" ? "light" : "dark";
    r.setAttribute("data-theme", t);
    try { localStorage.setItem("ssd-theme", t); } catch (e) {}
  });
  search.addEventListener("input", function () { renderNav(search.value); });
  window.addEventListener("hashchange", route);

  renderNav();
  route();
})();
