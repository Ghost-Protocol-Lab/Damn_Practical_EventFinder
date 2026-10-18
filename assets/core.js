/* Pure logic for the events page: dates, filtering, grouping, calendar export.
   No DOM access here, so it can be tested in Node (see tests/core.test.js). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.EventsCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DAY = 86400000;

  const TYPES = [
    { id: "ctf", label: "CTF" },
    { id: "conference", label: "Conference" },
    { id: "meetup", label: "Meetup" },
    { id: "bounty", label: "Bug bounty" },
    { id: "other", label: "Other" },
  ];
  const TYPE_LABEL = Object.fromEntries(TYPES.map((t) => [t.id, t.label]));
  const MODE_LABEL = { online: "Online", onsite: "On-site", hybrid: "Hybrid", unknown: "" };

  /* ---------- dates ---------- */

  function dateOnly(s) {
    const [y, m, d] = String(s).split("-").map(Number);
    return new Date(y, m - 1, d); // local midnight
  }
  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  function dayDiff(a, b) {
    return Math.round((startOfDay(a) - startOfDay(b)) / DAY);
  }

  function safeUrl(u) {
    return typeof u === "string" && /^https?:\/\//i.test(u) ? u : "";
  }

  /* Attach real Date objects and a search string; drop unreadable rows; sort by start. */
  function prepareEvents(raw) {
    const out = [];
    for (const ev of raw || []) {
      let start, end;
      if (ev.allDay) {
        start = dateOnly(ev.start);
        end = dateOnly(ev.end || ev.start);
        end.setDate(end.getDate() + 1); // exclusive
      } else {
        start = new Date(ev.start);
        end = ev.end ? new Date(ev.end) : new Date(start.getTime() + 2 * 3600e3);
      }
      if (isNaN(start) || isNaN(end) || !ev.title) continue;
      const hay = [
        ev.title, ev.location, TYPE_LABEL[ev.type], MODE_LABEL[ev.mode],
        (ev.tags || []).join(" "), (ev.organizers || []).join(" "),
      ].join(" ").toLowerCase();
      out.push(Object.assign({}, ev, {
        type: TYPE_LABEL[ev.type] ? ev.type : "other",
        mode: ev.mode in MODE_LABEL ? ev.mode : "unknown",
        _start: start, _end: end, _hay: hay,
      }));
    }
    return out.sort((a, b) => a._start - b._start || a.title.localeCompare(b.title));
  }

  const isLive = (ev, now) => ev._start <= now && now < ev._end;
  const hasEnded = (ev, now) => ev._end <= now;

  function relativeStart(ev, now) {
    if (isLive(ev, now)) return { text: "Live now", level: "live" };
    const days = dayDiff(ev._start, now);
    if (days <= 0) return { text: "Today", level: "soon" };
    if (days === 1) return { text: "Tomorrow", level: "soon" };
    if (days < 14) return { text: "In " + days + " days", level: "later" };
    if (days < 70) return { text: "In " + Math.round(days / 7) + " weeks", level: "later" };
    return { text: "In " + Math.round(days / 30) + " months", level: "later" };
  }

  /* "24-26 Oct", "Sat 24 Oct, 5:30 pm to 9:30 pm", in the viewer's own time zone. */
  function formatRange(ev, o) {
    o = o || {};
    const loc = o.locale;
    const now = o.now || new Date();
    const fmt = (d, opts) =>
      new Intl.DateTimeFormat(loc, Object.assign({ timeZone: o.timeZone }, opts)).format(d);
    const s = ev._start;
    const e = new Date(ev._end.getTime() - 1); // last moment of the event
    const showYear = s.getFullYear() !== now.getFullYear() || e.getFullYear() !== now.getFullYear();
    const year = showYear ? { year: "numeric" } : {};

    if (ev.allDay) {
      if (dayDiff(e, s) === 0) {
        return fmt(s, Object.assign({ weekday: "short", day: "numeric", month: "short" }, year));
      }
      const dm = Object.assign({ day: "numeric", month: "short" }, year);
      const f = new Intl.DateTimeFormat(loc, Object.assign({ timeZone: o.timeZone }, dm));
      return typeof f.formatRange === "function" ? f.formatRange(s, e) : fmt(s, dm) + " to " + fmt(e, dm);
    }

    const time = { hour: "numeric", minute: "2-digit" };
    const first = fmt(s, Object.assign({ weekday: "short", day: "numeric", month: "short" }, year, time));
    if (dayDiff(e, s) === 0) return first + " to " + fmt(e, time);
    return first + " to " + fmt(e, Object.assign({ weekday: "short", day: "numeric", month: "short" }, year, time));
  }

  function cfpInfo(ev, now) {
    if (!safeUrl(ev.cfpUrl) || !ev.cfpEnd) return null;
    const last = dateOnly(ev.cfpEnd);
    const closes = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
    if (closes <= now) return null;
    const days = dayDiff(last, now);
    return { url: ev.cfpUrl, end: last, days: days, closingSoon: days <= 14 };
  }

  /* ---------- filtering and grouping ---------- */

  function terms(q) {
    return String(q || "").toLowerCase().split(/\s+/).filter(Boolean);
  }

  /* f: { q, types:Set, mode:'all'|'online'|'onsite', range:'all'|'7'|'30'|'90', cfp:boolean } */
  function filterEvents(events, f, now) {
    const t = terms(f.q);
    const limit = f.range && f.range !== "all" ? now.getTime() + Number(f.range) * DAY : null;
    return events.filter((ev) => {
      if (hasEnded(ev, now)) return false;
      if (f.types && f.types.size && !f.types.has(ev.type)) return false;
      if (f.mode === "online" && ev.mode !== "online" && ev.mode !== "hybrid") return false;
      if (f.mode === "onsite" && ev.mode !== "onsite" && ev.mode !== "hybrid") return false;
      if (limit !== null && ev._start.getTime() > limit) return false;
      if (f.cfp && !cfpInfo(ev, now)) return false;
      return t.every((x) => ev._hay.includes(x));
    });
  }

  function countByType(events, f, now) {
    const counts = {};
    for (const ev of filterEvents(events, Object.assign({}, f, { types: new Set() }), now)) {
      counts[ev.type] = (counts[ev.type] || 0) + 1;
    }
    return counts;
  }

  /* "Happening now" first, then one group per month of the start date. */
  function groupEvents(list, now, locale) {
    const groups = [];
    const live = list.filter((e) => isLive(e, now));
    if (live.length) groups.push({ key: "live", label: "Happening now", items: live });
    const months = new Map();
    for (const ev of list) {
      if (isLive(ev, now)) continue;
      const key = ev._start.getFullYear() * 100 + ev._start.getMonth();
      if (!months.has(key)) {
        months.set(key, {
          key: String(key),
          label: new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(ev._start),
          items: [],
        });
      }
      months.get(key).items.push(ev);
    }
    return groups.concat(Array.from(months.values()));
  }

  /* The "Starting soon" board: up to 2 live events (ending soonest), then what starts next. */
  function boardEvents(events, now, size) {
    size = size || 5;
    const open = events.filter((e) => !hasEnded(e, now));
    const live = open.filter((e) => isLive(e, now)).sort((a, b) => a._end - b._end).slice(0, 2);
    const next = open.filter((e) => e._start > now);
    return live.concat(next).slice(0, size);
  }

  /* ---------- bug bounty programs ---------- */

  function preparePrograms(raw) {
    return (raw || [])
      .filter((p) => p && p.name && safeUrl(p.url))
      .map((p) => Object.assign({}, p, { _hay: (p.name + " " + p.platform).toLowerCase() }));
  }

  /* f: { q, platform, bountyOnly, sort:'payout'|'name' } */
  function filterPrograms(programs, f) {
    const t = terms(f.q);
    const out = programs.filter(
      (p) => (!f.platform || p.platform === f.platform) && (!f.bountyOnly || p.bounty) && t.every((x) => p._hay.includes(x))
    );
    const byName = (a, b) => a.name.localeCompare(b.name);
    if (f.sort === "name") return out.sort(byName);
    return out.sort((a, b) => (b.max || 0) - (a.max || 0) || Number(b.bounty) - Number(a.bounty) || byName(a, b));
  }

  function formatPayout(p, locale) {
    if (!p.max) return p.bounty ? "Pays bounties" : "No cash rewards";
    try {
      return "Up to " + new Intl.NumberFormat(locale, {
        style: "currency", currency: p.currency || "USD", maximumFractionDigits: 0,
      }).format(p.max);
    } catch (_) {
      return "Up to " + p.max + " " + (p.currency || "");
    }
  }

  /* ---------- misc ---------- */

  function timeAgo(iso, now, locale) {
    const then = new Date(iso);
    if (isNaN(then)) return "";
    const secs = Math.round((then - now) / 1000);
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    const abs = Math.abs(secs);
    if (abs < 3600) return rtf.format(Math.round(secs / 60), "minute");
    if (abs < 86400) return rtf.format(Math.round(secs / 3600), "hour");
    return rtf.format(Math.round(secs / 86400), "day");
  }

  /* ---------- single-event calendar file ---------- */

  const pad = (n) => String(n).padStart(2, "0");
  const icsUtc = (d) =>
    d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "T" +
    pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "Z";
  const icsDate = (d) => d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
  const icsEscape = (s) =>
    String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

  function fold(line) { // 75 octets per line, never splitting a character
    const enc = new TextEncoder();
    const out = [];
    let cur = "", bytes = 0, limit = 75;
    for (const ch of line) {
      const n = enc.encode(ch).length;
      if (bytes + n > limit) { out.push(cur); cur = ""; bytes = 0; limit = 74; }
      cur += ch;
      bytes += n;
    }
    out.push(cur);
    return out.join("\r\n ");
  }

  function buildIcs(ev, now) {
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//security-events-hub//EN", "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      "UID:" + ev.id + "@security-events-hub",
      "DTSTAMP:" + icsUtc(now || new Date()),
    ];
    if (ev.allDay) {
      lines.push("DTSTART;VALUE=DATE:" + icsDate(ev._start), "DTEND;VALUE=DATE:" + icsDate(ev._end));
    } else {
      lines.push("DTSTART:" + icsUtc(ev._start), "DTEND:" + icsUtc(ev._end));
    }
    lines.push("SUMMARY:" + icsEscape(ev.title));
    if (ev.location) lines.push("LOCATION:" + icsEscape(ev.location));
    else if (ev.mode === "online") lines.push("LOCATION:Online");
    const url = safeUrl(ev.url);
    if (url) lines.push("URL:" + url);
    const note = [ev.description, url].filter(Boolean).join(" ");
    if (note) lines.push("DESCRIPTION:" + icsEscape(note));
    lines.push("CATEGORIES:" + (TYPE_LABEL[ev.type] || "Other"), "END:VEVENT", "END:VCALENDAR");
    return lines.map(fold).join("\r\n") + "\r\n";
  }

  return {
    TYPES, TYPE_LABEL, MODE_LABEL,
    safeUrl, prepareEvents, isLive, hasEnded, relativeStart, formatRange, cfpInfo,
    filterEvents, countByType, groupEvents, boardEvents,
    preparePrograms, filterPrograms, formatPayout, timeAgo, buildIcs,
  };
});
