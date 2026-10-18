/* DOM and state for the events page. Logic lives in core.js.
   All third-party text is inserted with textContent / createTextNode, never innerHTML. */
(function () {
  "use strict";

  const C = window.EventsCore;
  const $ = (sel) => document.querySelector(sel);
  const PAGE = 50;
  const MODES = [["all", "All"], ["online", "Online"], ["onsite", "On-site"]];
  const SOURCE_NAMES = { ctftime: "CTFtime", manual: "manual events" };

  const state = {
    tab: "events",
    q: "", types: new Set(), mode: "all", range: "all", cfp: false,
    pq: "", platform: "", bountyOnly: false, sort: "payout", shown: PAGE,
  };
  let events = [], programs = [], eventsMeta = {}, programsMeta = {};
  let now = new Date();
  let loadError = "";
  const chipEls = {};
  const segEls = {};

  /* ---------- helpers ---------- */

  function h(tag, props) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }

  function add(el, kid) {
    if (Array.isArray(kid)) kid.forEach((k) => add(el, k));
    else if (kid != null && kid !== false) el.append(kid);
  }

  const fmt = (d, opts) => new Intl.DateTimeFormat(undefined, opts).format(d);
  const plural = (n, one, many) => n + " " + (n === 1 ? one : many);

  function linkOrText(ev, extra) {
    const url = C.safeUrl(ev.url) || C.safeUrl(ev.sourceUrl);
    return url
      ? h("a", Object.assign({ href: url, target: "_blank", rel: "noopener noreferrer" }, extra), ev.title)
      : ev.title;
  }

  function placeLabel(ev) {
    if (ev.mode === "online") return "Online";
    if (ev.mode === "hybrid") return ev.location ? ev.location + " and online" : "Hybrid";
    return ev.location || "";
  }

  function untilLabel(ev) {
    const last = new Date(ev._end.getTime() - 1);
    if (last.toDateString() === now.toDateString()) return "ends today";
    return "until " + fmt(last, { weekday: "short", day: "numeric" });
  }

  function cfpLabel(info) {
    if (info.days <= 0) return "Call for papers closes today";
    if (info.closingSoon) return "Call for papers closes in " + plural(info.days, "day", "days");
    return "Call for papers open until " + fmt(info.end, { day: "numeric", month: "short" });
  }

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "event";
  }

  function downloadIcs(ev) {
    const blob = new Blob([C.buildIcs(ev, new Date())], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: slug(ev.title) + ".ics" });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------- URL state ---------- */

  function readUrl() {
    const p = new URLSearchParams(location.search);
    if (p.get("tab") === "programs") state.tab = "programs";
    state.q = p.get("q") || "";
    const known = new Set(C.TYPES.map((t) => t.id));
    for (const t of (p.get("type") || "").split(",")) if (known.has(t)) state.types.add(t);
    if (MODES.some((m) => m[0] === p.get("mode"))) state.mode = p.get("mode");
    if (["7", "30", "90"].includes(p.get("when"))) state.range = p.get("when");
    state.cfp = p.get("cfp") === "1";
    state.pq = p.get("pq") || "";
    state.platform = p.get("platform") || "";
    state.bountyOnly = p.get("bounty") === "1";
    if (p.get("sort") === "name") state.sort = "name";
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.tab !== "events") p.set("tab", state.tab);
    if (state.q) p.set("q", state.q);
    if (state.types.size) p.set("type", Array.from(state.types).join(","));
    if (state.mode !== "all") p.set("mode", state.mode);
    if (state.range !== "all") p.set("when", state.range);
    if (state.cfp) p.set("cfp", "1");
    if (state.pq) p.set("pq", state.pq);
    if (state.platform) p.set("platform", state.platform);
    if (state.bountyOnly) p.set("bounty", "1");
    if (state.sort !== "payout") p.set("sort", state.sort);
    const qs = p.toString();
    try {
      history.replaceState(null, "", qs ? "?" + qs : location.pathname);
    } catch (_) { /* some browsers block this on file:// pages */ }
  }

  /* ---------- controls (built once, updated in place so focus is never lost) ---------- */

  function buildControls() {
    const chips = $("#type-chips");
    for (const t of C.TYPES) {
      const n = h("span", { class: "n" }, "0");
      const btn = h("button", {
        type: "button", class: "chip t-" + t.id, "aria-pressed": "false",
        onclick: () => {
          state.types.has(t.id) ? state.types.delete(t.id) : state.types.add(t.id);
          renderEvents();
        },
      }, h("i", { class: "swatch" }), t.label, n);
      chipEls[t.id] = { btn, n };
      chips.append(btn);
    }

    const seg = $("#mode-seg");
    for (const [id, label] of MODES) {
      const btn = h("button", {
        type: "button", "aria-pressed": "false",
        onclick: () => { state.mode = id; renderEvents(); },
      }, label);
      segEls[id] = btn;
      seg.append(btn);
    }

    $("#q").value = state.q;
    $("#q").addEventListener("input", (e) => { state.q = e.target.value; renderEvents(); });
    $("#range").value = state.range;
    $("#range").addEventListener("change", (e) => { state.range = e.target.value; renderEvents(); });
    $("#cfp").checked = state.cfp;
    $("#cfp").addEventListener("change", (e) => { state.cfp = e.target.checked; renderEvents(); });
    $("#clear-events").addEventListener("click", () => {
      Object.assign(state, { q: "", mode: "all", range: "all", cfp: false });
      state.types.clear();
      $("#q").value = "";
      $("#range").value = "all";
      $("#cfp").checked = false;
      renderEvents();
    });

    $("#pq").value = state.pq;
    $("#pq").addEventListener("input", (e) => { state.pq = e.target.value; state.shown = PAGE; renderPrograms(); });
    $("#sort").value = state.sort;
    $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; state.shown = PAGE; renderPrograms(); });
    $("#platform").addEventListener("change", (e) => { state.platform = e.target.value; state.shown = PAGE; renderPrograms(); });
    $("#bounty-only").checked = state.bountyOnly;
    $("#bounty-only").addEventListener("change", (e) => { state.bountyOnly = e.target.checked; state.shown = PAGE; renderPrograms(); });
    $("#more-programs").addEventListener("click", () => { state.shown += PAGE; renderPrograms(); });
    $("#clear-programs").addEventListener("click", () => {
      Object.assign(state, { pq: "", platform: "", bountyOnly: false, shown: PAGE });
      $("#pq").value = "";
      $("#platform").value = "";
      $("#bounty-only").checked = false;
      renderPrograms();
    });

    const tabs = [$("#tab-events"), $("#tab-programs")];
    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => setTab(i === 0 ? "events" : "programs"));
      tab.addEventListener("keydown", (e) => {
        const move = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
        const target = e.key === "Home" ? 0 : e.key === "End" ? 1 : move != null ? (i + move + 2) % 2 : null;
        if (target == null) return;
        e.preventDefault();
        setTab(target === 0 ? "events" : "programs");
        tabs[target].focus();
      });
    });

    setupSubscribe();
    $("#tz-note").textContent =
      "Times are shown in your time zone (" + Intl.DateTimeFormat().resolvedOptions().timeZone +
      "). Conference dates are the calendar days the organisers publish.";
  }

  function setTab(name) {
    state.tab = name;
    const onEvents = name === "events";
    $("#tab-events").setAttribute("aria-selected", String(onEvents));
    $("#tab-events").tabIndex = onEvents ? 0 : -1;
    $("#tab-programs").setAttribute("aria-selected", String(!onEvents));
    $("#tab-programs").tabIndex = onEvents ? -1 : 0;
    $("#panel-events").hidden = !onEvents;
    $("#panel-programs").hidden = onEvents;
    syncUrl();
  }

  function setupSubscribe() {
    const dialog = $("#subscribe-dialog");
    const url = new URL("data/events.ics", location.href).href;
    $("#sub-url").value = url;
    $("#webcal-link").href = url.replace(/^https?:/, "webcal:");
    $("#subscribe-btn").addEventListener("click", () => {
      $("#copy-hint").textContent = "";
      typeof dialog.showModal === "function" ? dialog.showModal() : dialog.setAttribute("open", "");
    });
    $("#sub-url").addEventListener("focus", (e) => e.target.select());
    $("#copy-url").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(url);
        $("#copy-hint").textContent = "Copied. Paste it into your calendar's “add by URL” option.";
      } catch (_) {
        $("#sub-url").select();
        $("#copy-hint").textContent = "Press Ctrl+C (or ⌘C) to copy the selected address.";
      }
    });
  }

  /* ---------- rendering: events ---------- */

  function filters() {
    return { q: state.q, types: state.types, mode: state.mode, range: state.range, cfp: state.cfp };
  }
  const isFiltered = () => !!(state.q || state.types.size || state.mode !== "all" || state.range !== "all" || state.cfp);

  function renderEvents() {
    const f = filters();
    const list = C.filterEvents(events, f, now);
    const counts = C.countByType(events, f, now);

    for (const t of C.TYPES) {
      const { btn, n } = chipEls[t.id];
      btn.setAttribute("aria-pressed", String(state.types.has(t.id)));
      n.textContent = String(counts[t.id] || 0);
    }
    for (const [id] of MODES) segEls[id].setAttribute("aria-pressed", String(state.mode === id));
    $("#clear-events").hidden = !isFiltered();

    const out = $("#results");
    out.replaceChildren();
    const total = events.filter((e) => !C.hasEnded(e, now)).length;

    if (loadError) {
      out.append(emptyState("Events could not be loaded", [
        h("p", {}, loadError),
        h("p", {}, "If you opened this page straight from a file, serve the folder instead: run ",
          h("code", {}, "python3 -m http.server"), " in it and open http://localhost:8000."),
      ]));
      $("#result-count").textContent = "";
    } else if (!list.length) {
      const nothing = total === 0;
      out.append(emptyState(nothing ? "No upcoming events yet" : "Nothing matches these filters", [
        h("p", {}, nothing
          ? "The data refreshes every few hours. If this is a fresh copy, run the “Update event data” workflow once."
          : "Try a wider time range, or remove a type or location filter."),
        nothing ? null : h("button", { type: "button", class: "btn secondary", onclick: () => $("#clear-events").click() }, "Clear filters"),
      ]));
      $("#result-count").textContent = nothing ? "" : "0 of " + total + " events";
    } else {
      for (const g of C.groupEvents(list, now)) {
        out.append(
          h("div", { class: "month" }, h("h2", {}, g.label), h("span", {}, plural(g.items.length, "event", "events"))),
          h("ol", { class: "events" }, g.items.map(eventRow))
        );
      }
      $("#result-count").textContent = isFiltered()
        ? list.length + " of " + plural(total, "event", "events")
        : plural(list.length, "upcoming event", "upcoming events");
    }
    syncUrl();
  }

  function emptyState(title, kids) {
    return h("div", { class: "empty" }, h("h2", {}, title), kids);
  }

  function eventRow(ev) {
    const rel = C.relativeStart(ev, now);
    const live = rel.level === "live";
    const when = live
      ? h("div", { class: "when" }, h("span", { class: "livebadge" }, "Live"), h("span", { class: "dow" }, untilLabel(ev)))
      : h("div", { class: "when" },
          h("span", { class: "day" }, String(ev._start.getDate())),
          h("span", { class: "dow" }, fmt(ev._start, { weekday: "short" })));

    const meta = h("p", { class: "meta" }, h("span", {}, C.formatRange(ev, { now })));
    if (ev.location && ev.mode !== "online") meta.append(h("span", {}, ev.location));

    const tags = h("p", { class: "tags" });
    const typeLabel = C.TYPE_LABEL[ev.type].toLowerCase();
    for (const t of ev.tags || []) if (t.toLowerCase() !== typeLabel) tags.append(h("span", { class: "tag" }, t));
    if (ev.weight) tags.append(h("span", { class: "tag" }, "Rating weight " + ev.weight));
    const cfp = C.cfpInfo(ev, now);
    if (cfp) tags.append(h("a", { class: "tag cfp", href: cfp.url, target: "_blank", rel: "noopener noreferrer" }, cfpLabel(cfp)));
    const src = C.safeUrl(ev.sourceUrl);
    if (src && src !== C.safeUrl(ev.url)) {
      tags.append(h("a", { class: "tag", href: src, target: "_blank", rel: "noopener noreferrer" }, "CTFtime page"));
    }

    return h("li", { class: "ev" + (live ? " live" : "") },
      when,
      h("div", { class: "body" },
        h("h3", { class: "title" }, linkOrText(ev)),
        meta,
        tags.childElementCount ? tags : null),
      h("div", { class: "side" },
        h("div", { class: "kind" },
          h("span", { class: "type t-" + ev.type }, h("i", { class: "swatch" }), C.TYPE_LABEL[ev.type]),
          C.MODE_LABEL[ev.mode] ? h("span", { class: "mode" }, C.MODE_LABEL[ev.mode]) : null),
        h("button", {
          type: "button", class: "cal", "aria-label": "Add " + ev.title + " to your calendar",
          onclick: () => downloadIcs(ev),
        }, "Add to calendar")));
  }

  function renderBoard() {
    const rows = C.boardEvents(events, now, 5);
    $("#board").hidden = !rows.length;
    $("#board-rows").replaceChildren(...rows.map((ev) => {
      const rel = C.relativeStart(ev, now);
      const place = placeLabel(ev);
      return h("li", { class: "brow " + rel.level },
        h("span", { class: "bwhen" }, rel.text),
        h("p", { class: "btitle" }, linkOrText(ev)),
        h("span", { class: "btype t-" + ev.type }, h("i", { class: "swatch" }), C.TYPE_LABEL[ev.type]),
        h("span", { class: "bplace", title: place }, place));
    }));
  }

  /* ---------- rendering: programs ---------- */

  function renderPrograms() {
    const list = C.filterPrograms(programs, {
      q: state.pq, platform: state.platform, bountyOnly: state.bountyOnly, sort: state.sort,
    });
    const shown = list.slice(0, state.shown);
    $("#program-results").replaceChildren(...shown.map(programRow));
    $("#more-programs").hidden = shown.length >= list.length;
    $("#more-programs").textContent = "Show " + Math.min(PAGE, list.length - shown.length) + " more programs";
    $("#clear-programs").hidden = !(state.pq || state.platform || state.bountyOnly);
    $("#program-count").textContent = loadError && !programs.length
      ? ""
      : list.length === programs.length
        ? plural(list.length, "program", "programs")
        : list.length + " of " + plural(programs.length, "program", "programs");
    if (!list.length && programs.length) {
      $("#program-results").append(h("li", {}, emptyState("Nothing matches these filters", [])));
    }
    syncUrl();
  }

  function programRow(p) {
    const sub = h("p", { class: "sub" }, h("span", {}, p.platform));
    if (p.safeHarbor) sub.append(h("span", {}, "Safe harbor: " + p.safeHarbor));
    const payout = C.formatPayout(p);
    return h("li", { class: "pg" },
      h("div", {},
        h("h3", { class: "name" }, h("a", { href: p.url, target: "_blank", rel: "noopener noreferrer" }, p.name)),
        sub),
      h("div", { class: "payout" + (p.max ? "" : " none") }, payout));
  }

  function fillPlatforms() {
    const sel = $("#platform");
    const names = Array.from(new Set(programs.map((p) => p.platform))).sort();
    for (const name of names) sel.append(h("option", { value: name }, name));
    sel.value = names.includes(state.platform) ? state.platform : "";
    state.platform = sel.value;
  }

  /* ---------- header status and notices ---------- */

  function renderStatus() {
    const status = $("#status");
    status.replaceChildren();
    if (loadError) { status.textContent = "Could not load the event data."; return; }
    const upcoming = events.filter((e) => !C.hasEnded(e, now)).length;
    status.append(plural(upcoming, "upcoming event", "upcoming events"));
    if (programs.length) status.append(" and " + plural(programs.length, "bug bounty program", "bug bounty programs"));
    if (eventsMeta.generatedAt) {
      const when = new Date(eventsMeta.generatedAt);
      if (!isNaN(when)) {
        status.append(". Data last changed ",
          h("time", { datetime: eventsMeta.generatedAt, title: fmt(when, { dateStyle: "medium", timeStyle: "short" }) },
            C.timeAgo(eventsMeta.generatedAt, now)));
      }
    }
    status.append(".");
  }

  function renderNotice() {
    const failed = [];
    for (const meta of [eventsMeta, programsMeta]) {
      for (const [name, s] of Object.entries(meta.sources || {})) {
        if (s && s.ok === false) failed.push(SOURCE_NAMES[name] || name.replace(/^ics:/, ""));
      }
    }
    const el = $("#notice");
    el.hidden = !failed.length;
    if (failed.length) {
      el.textContent = "The last update could not reach " + failed.join(", ") +
        ", so entries from " + (failed.length === 1 ? "that source" : "those sources") +
        " may be missing or out of date.";
    }
  }

  /* ---------- start ---------- */

  async function loadJson(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(url + " returned HTTP " + res.status + ".");
    return res.json();
  }

  function renderAll() {
    renderStatus();
    renderNotice();
    renderBoard();
    renderEvents();
    renderPrograms();
    $("#count-events").textContent = events.length ? String(events.filter((e) => !C.hasEnded(e, now)).length) : "";
    $("#count-programs").textContent = programs.length ? String(programs.length) : "";
  }

  async function init() {
    readUrl();
    buildControls();
    setTab(state.tab);
    const [ev, pr] = await Promise.allSettled([loadJson("data/events.json"), loadJson("data/programs.json")]);
    if (ev.status === "fulfilled") {
      eventsMeta = ev.value;
      events = C.prepareEvents(ev.value.events);
    } else {
      loadError = String(ev.reason && ev.reason.message ? ev.reason.message : ev.reason);
    }
    if (pr.status === "fulfilled") {
      programsMeta = pr.value;
      programs = C.preparePrograms(pr.value.programs);
    }
    fillPlatforms();
    now = new Date();
    renderAll();

    // Keep "Live now" and "In 3 days" honest without disturbing keyboard focus.
    setInterval(() => {
      if (document.activeElement && document.activeElement.closest("#results, #board")) return;
      now = new Date();
      renderStatus();
      renderBoard();
      renderEvents();
    }, 5 * 60 * 1000);
  }

  init();
})();
