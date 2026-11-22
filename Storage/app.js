(function () {
  "use strict";
  var P = window.PATTERNS, CMP = window.COMPARE, CON = window.CONCEPTS;
  var main = document.getElementById("main");
  var navList = document.getElementById("navList");
  var sidebar = document.getElementById("sidebar");
  var menuBtn = document.getElementById("menuBtn");
  var search = document.getElementById("search");

  /* Learning path: recommended order and difficulty for a newcomer */
  var PATH = [
    ["dfs", "b"], ["kv-lsm", "i"], ["object-store", "i"], ["log-storage", "i"], ["sync-dedup", "i"],
    ["ec-selfheal", "a"], ["dedup-pipeline", "a"], ["qos-engine", "i"], ["block-store", "a"]
  ];
  var LVL = { b: "Beginner", i: "Intermediate", a: "Advanced" };
  var byId = {}; P.forEach(function (p) { byId[p.id] = p; });
  var ordered = PATH.map(function (x) { var p = byId[x[0]]; p.lvl = x[1]; return p; })
    .concat(P.filter(function (p) { return !p.lvl; }));
  ordered.forEach(function (p, i) { if (!p.lvl) p.lvl = "i"; p.step = i + 1; });

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]; }); }
  function words(s) { return String(s).replace(/<[^>]*>/g, " ").split(/\s+/).filter(Boolean).length; }
  function readMins(p) {
    var w = words(p.tagline) + words(p.requirements.join(" ")) + p.deepDives.reduce(function (a, d) { return a + words(d.b); }, 0) +
      Object.keys(p.flows).reduce(function (a, k) { return a + words(p.flows[k].join(" ")); }, 0);
    return Math.max(3, Math.round(w / 200));
  }

  /* progress (localStorage, tolerant of being unavailable) */
  var done = [];
  try { done = JSON.parse(localStorage.getItem("ssd-done") || "[]"); } catch (e) { done = []; }
  if (!Array.isArray(done)) done = [];
  function saveDone() { try { localStorage.setItem("ssd-done", JSON.stringify(done)); } catch (e) {} }
  function isDone(id) { return done.indexOf(id) >= 0; }

  /* ---------- navigation ---------- */
  var extra = [["compare", "Compare all patterns", "vs"], ["concepts", "Shared building blocks", "+"]];
  function currentId() { return (location.hash || "#home").slice(1) || "home"; }
  function renderNav(filter) {
    var f = (filter || "").toLowerCase(), n = done.length, pct = Math.round(n / P.length * 100);
    var html = '<div class="progress"><div class="row"><span>Your progress</span><span>' + n + "/" + P.length + '</span></div><div class="bar"><i style="width:' + pct + '%"></i></div></div>' +
      '<ul><li><a href="#home" data-id="home"><span class="num">&#9679;</span><span>Start here</span><span></span></a></li><li class="sep">Learning path</li>';
    ordered.forEach(function (p) {
      if (f && (p.name + " " + p.tag + " " + p.tagline).toLowerCase().indexOf(f) < 0) return;
      html += '<li><a href="#' + p.id + '" data-id="' + p.id + '"><span class="num' + (isDone(p.id) ? " done" : "") + '">' + (isDone(p.id) ? "&#10003;" : p.step) +
        "</span><span>" + esc(p.name) + '</span><span class="lvl ' + p.lvl + '">' + LVL[p.lvl].slice(0, 3) + "</span></a></li>";
    });
    html += '<li class="sep">Reference</li>';
    extra.forEach(function (e) { html += '<li><a href="#' + e[0] + '" data-id="' + e[0] + '"><span class="num">' + e[2] + "</span><span>" + e[1] + "</span><span></span></a></li>"; });
    navList.innerHTML = html + "</ul>";
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

  /* ---------- views ---------- */
  function home() {
    var next = ordered.filter(function (p) { return !isDone(p.id); })[0];
    var total = ordered.reduce(function (a, p) { return a + readMins(p); }, 0);
    var h = '<div class="hero"><div class="eyebrow">A field guide for learners</div><h1>How storage systems are really built</h1>' +
      '<p class="lead">' + P.length + " architectures, one reading order. Each chapter gives you the problem, the architecture, the request flows, the hard parts, and a self-test, so you can explain it, not just recognise it.</p>" +
      '<div class="meta"><span>Light &amp; dark reading modes</span><span>Progress saved in your browser</span><span>~' + total + " min total</span></div>" +
      (next ? '<div class="pager" style="justify-content:flex-start;margin-top:16px"><a href="#' + next.id + '">' + (done.length ? "Continue: " : "Begin with ") + esc(next.name) + " &rarr;</a></div>" : "") + "</div>";
    h += '<div class="grid">' + ordered.map(function (p) {
      return '<a class="card" href="#' + p.id + '"><div class="top"><span>CHAPTER ' + String(p.step).padStart(2, "0") + '</span><span class="lvl ' + p.lvl + '">' + LVL[p.lvl] + "</span></div><h3>" +
        esc(p.name) + "</h3><p>" + esc(p.tagline) + '</p><div class="meta" style="border:0;padding:8px 0 0">' + readMins(p) + " min read</div>" + (isDone(p.id) ? '<span class="tick">&#10003; learned</span>' : "") + "</a>";
    }).join("") + "</div>";
    return h;
  }

  function arch(layers) {
    return '<div class="arch">' + layers.map(function (l, i) {
      return (i ? '<div class="arrow" aria-hidden="true">&#8595;</div>' : "") + '<div class="layer"><div class="layer-title">' + esc(l.title) + '</div><div class="nodes">' +
        l.nodes.map(function (n) { return '<div class="node"><b>' + esc(n.n) + "</b><span>" + esc(n.d) + "</span></div>"; }).join("") + "</div></div>";
    }).join("") + "</div>";
  }
  function table(head, rows) {
    return '<div class="tbl-wrap"><table><thead><tr>' + head.map(function (h) { return "<th>" + esc(h) + "</th>"; }).join("") + "</tr></thead><tbody>" +
      rows.map(function (r) { return "<tr>" + r.map(function (c) { return "<td>" + esc(c) + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table></div>";
  }
  function h2(n, id, t) { return '<h2 id="sec-' + id + '"><span class="n">' + n + "</span>" + t + "</h2>"; }

  function pattern(p) {
    var i = ordered.indexOf(p), prev = ordered[i - 1], next = ordered[i + 1], keys = Object.keys(p.flows);
    var secs = [["req", "Requirements"], ["arch", "Architecture"], ["flow", "Flows"], ["deep", "Deep dives"], ["fail", "Failures"], ["trade", "Trade-offs"], ["quiz", "Self-test"], ["sum", "Summary"]];
    var h = '<div class="eyebrow"><span>Chapter ' + String(p.step).padStart(2, "0") + '</span><span class="lvl ' + p.lvl + '">' + LVL[p.lvl] + "</span></div><h1>" + esc(p.name) + '</h1><p class="lead">' + esc(p.tagline) + "</p>" +
      '<div class="meta"><span>' + readMins(p) + " min read</span><span>" + p.deepDives.length + " deep dives</span><span>" + p.tradeoffs.length + " decisions to defend</span></div>" +
      '<div class="jump">' + secs.map(function (s) { return '<button data-jump="sec-' + s[0] + '">' + s[1] + "</button>"; }).join("") + "</div>" +
      '<div class="chips">' + p.scale.map(function (s) { return '<div class="chip"><b>' + esc(s[1]) + "</b><span>" + esc(s[0]) + "</span></div>"; }).join("") + "</div>";
    h += h2("01", "req", "What it must do") + '<ul class="req">' + p.requirements.map(function (r) { return "<li>" + esc(r) + "</li>"; }).join("") + "</ul>";
    h += h2("02", "arch", "The architecture") + arch(p.layers);
    h += h2("03", "flow", "How requests flow") + '<div class="tabs" role="tablist">' + keys.map(function (k, j) {
      return '<button class="tab" role="tab" aria-selected="' + (j === 0) + '" data-flow="' + j + '">' + esc(k) + "</button>"; }).join("") + '</div><div id="flowBody"></div>';
    h += h2("04", "deep", "The hard parts") + '<div class="toolbar"><button data-act="open">Expand all</button><button data-act="close">Collapse all</button></div>' +
      p.deepDives.map(function (d, j) { return "<details" + (j === 0 ? " open" : "") + "><summary>" + esc(d.t) + "</summary><div>" + d.b + "</div></details>"; }).join("");
    h += h2("05", "fail", "When things break") + table(["Scenario", "Handling"], p.failures);
    h += h2("06", "trade", "Decisions and trade-offs") + table(["Decision", "Choice", "Why"], p.tradeoffs);
    h += h2("07", "quiz", "Test yourself") + '<p style="color:var(--muted);margin-top:0">Answer out loud first, then reveal.</p><div class="flash">' + p.tradeoffs.map(function (t) {
      return '<div class="fc"><div class="q">Decision: ' + esc(t[0]) + "</div><p>What would you choose here, and why?</p><button>Reveal answer</button>" +
        '<div class="a"><b>' + esc(t[1]) + "</b><br>" + esc(t[2]) + "</div></div>"; }).join("") + "</div>";
    h += h2("08", "sum", "The 30-second version") + '<div class="cheat"><b>Say it like this</b>' + esc(p.cheat) + "</div>";
    if (p.doc) h += '<a class="docs-link" href="' + esc(p.doc) + '">Read the full written design (' + esc(p.doc) + ") &rarr;</a>";
    h += '<div class="mark-done"><button id="doneBtn" aria-pressed="' + isDone(p.id) + '">' + (isDone(p.id) ? "&#10003; Marked as learned" : "Mark chapter as learned") + "</button><span>Tracks your progress in this browser.</span></div>";
    h += '<div class="pager"><span>' + (prev ? '<a href="#' + prev.id + '">&larr; ' + esc(prev.name) + "</a>" : "") + "</span><span>" +
      (next ? '<a href="#' + next.id + '">' + esc(next.name) + " &rarr;</a>" : '<a href="#compare">Compare all &rarr;</a>') + "</span></div>";
    return h;
  }

  function bindPattern(p) {
    var keys = Object.keys(p.flows), body = document.getElementById("flowBody");
    function show(i) { body.innerHTML = '<ol class="steps">' + p.flows[keys[i]].map(function (s) { return "<li>" + s + "</li>"; }).join("") + "</ol>"; }
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
    Array.prototype.forEach.call(main.querySelectorAll(".jump button"), function (b) {
      b.addEventListener("click", function () { var el = document.getElementById(b.getAttribute("data-jump")); if (el) el.scrollIntoView({ behavior: "smooth", block: "start" }); });
    });
    Array.prototype.forEach.call(main.querySelectorAll(".fc button"), function (b) {
      b.addEventListener("click", function () { b.parentNode.classList.add("open"); });
    });
    var db = document.getElementById("doneBtn");
    db.addEventListener("click", function () {
      var k = done.indexOf(p.id);
      if (k >= 0) done.splice(k, 1); else done.push(p.id);
      saveDone();
      db.setAttribute("aria-pressed", String(isDone(p.id)));
      db.innerHTML = isDone(p.id) ? "&#10003; Marked as learned" : "Mark chapter as learned";
      renderNav(search.value);
    });
  }

  function compare() {
    return '<div class="eyebrow">Reference</div><h1>Compare all patterns</h1><p class="lead">Same trade-offs, different points on the design space.</p>' + table(CMP.cols, CMP.rows) +
      '<h2><span class="n">&mdash;</span>How to choose</h2><ul class="req">' +
      "<li><b>Unstructured blobs at huge scale, cheap, HTTP:</b> object store (with dedup and EC subsystems underneath).</li>" +
      "<li><b>Databases and VMs needing sub-ms latency:</b> block store.</li><li><b>Big sequential analytics:</b> distributed file system.</li>" +
      "<li><b>Online lookups by key at high QPS:</b> distributed KV.</li><li><b>Cloud drive or backup with delta sync:</b> sync + dedup.</li>" +
      "<li><b>Ordered event streams and replay:</b> commit log.</li><li><b>Cross-cutting:</b> inline dedup, erasure coding with self-healing, and QoS apply to almost every system above.</li></ul>";
  }
  function concepts() {
    return '<div class="eyebrow">Reference</div><h1>Shared building blocks</h1><p class="lead">Ideas that recur in every storage system. Learn these once.</p>' +
      CON.map(function (c) { return "<details open><summary>" + esc(c.t) + "</summary><div>" + c.b + "</div></details>"; }).join("");
  }

  /* ---------- router ---------- */
  function route() {
    var id = currentId(), p = byId[id], html;
    if (id === "compare") html = compare(); else if (id === "concepts") html = concepts(); else if (p) html = pattern(p); else html = home();
    main.innerHTML = html;
    if (p) bindPattern(p);
    document.title = (p ? p.name : id === "compare" ? "Compare" : id === "concepts" ? "Building blocks" : "Storage Field Guide") + " | Storage Design";
    markActive();
    sidebar.classList.remove("open"); menuBtn.setAttribute("aria-expanded", "false");
    window.scrollTo(0, 0);
    main.focus({ preventScroll: true });
  }

  /* ---------- theme + chrome ---------- */
  var themeBtns = document.querySelectorAll("[data-set-theme]");
  function syncTheme() {
    var t = document.documentElement.getAttribute("data-theme");
    Array.prototype.forEach.call(themeBtns, function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-set-theme") === t)); });
  }
  Array.prototype.forEach.call(themeBtns, function (b) {
    b.addEventListener("click", function () {
      var t = b.getAttribute("data-set-theme");
      document.documentElement.setAttribute("data-theme", t);
      try { localStorage.setItem("ssd-theme", t); } catch (e) {}
      syncTheme();
    });
  });
  syncTheme();
  menuBtn.addEventListener("click", function () { var o = sidebar.classList.toggle("open"); menuBtn.setAttribute("aria-expanded", String(o)); });
  search.addEventListener("input", function () { renderNav(search.value); });
  window.addEventListener("hashchange", route);

  renderNav();
  route();
})();
