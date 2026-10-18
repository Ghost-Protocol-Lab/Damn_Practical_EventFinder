// Run:  TZ=Asia/Kolkata node --test tests/core.test.js   (also try TZ=America/Los_Angeles)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../assets/core.js");

// Local-time "now" so results do not depend on the machine's time zone.
const NOW = new Date(2026, 9, 17, 12, 0); // Sat 17 Oct 2026, 12:00 local

const RAW = [
  { id: "c1", title: "Nullcon Goa", type: "conference", mode: "onsite", location: "Goa, India", allDay: true,
    start: "2026-10-28", end: "2026-10-30", url: "https://nullcon.net", tags: [],
    cfpUrl: "https://cfp.test", cfpEnd: "2026-10-20" },
  { id: "t1", title: "Example CTF", type: "ctf", mode: "online", location: "", allDay: false,
    start: new Date(2026, 9, 24, 14, 0).toISOString(), end: new Date(2026, 9, 26, 14, 0).toISOString(),
    url: "https://ctf.test",
    tags: ["Jeopardy", "Open"], organizers: ["Team Example"] },
  { id: "d1", title: "Today only meetup", type: "meetup", mode: "hybrid", location: "Pune", allDay: true,
    start: "2026-10-17", end: "2026-10-17", url: "https://m.test", tags: [] },
  { id: "p1", title: "Already over", type: "ctf", mode: "online", allDay: true,
    start: "2026-10-10", end: "2026-10-12", url: "https://x.test", tags: [] },
  { id: "x1", title: "Broken", type: "ctf", allDay: false, start: "not a date", end: "nope" },
  { id: "n1", title: "November conf", type: "conference", mode: "onsite", location: "Berlin, Germany",
    allDay: true, start: "2026-11-05", end: "2026-11-05", url: "https://n.test", tags: [] },
];
const EVENTS = C.prepareEvents(RAW);
const ids = (list) => list.map((e) => e.id);

test("prepareEvents drops unreadable rows and sorts by start", () => {
  assert.deepEqual(ids(EVENTS), ["p1", "d1", "t1", "c1", "n1"]);
});

test("all-day events cover whole local days (end is exclusive)", () => {
  const c1 = EVENTS.find((e) => e.id === "c1");
  assert.equal(c1._start.getDate(), 28);
  assert.equal(c1._end.getDate(), 31);
  assert.equal(c1._end.getHours(), 0);
});

test("live, ended and relative labels", () => {
  const byId = Object.fromEntries(EVENTS.map((e) => [e.id, e]));
  assert.ok(C.hasEnded(byId.p1, NOW));
  assert.ok(C.isLive(byId.d1, NOW));
  assert.deepEqual(C.relativeStart(byId.d1, NOW), { text: "Live now", level: "live" });
  assert.equal(C.relativeStart(byId.t1, NOW).text, "In 7 days");
  assert.equal(C.relativeStart(byId.c1, NOW).text, "In 11 days");
  assert.equal(C.relativeStart(byId.n1, NOW).text, "In 3 weeks");
  const tomorrow = C.prepareEvents([{ id: "z", title: "z", allDay: true, start: "2026-10-18", end: "2026-10-18" }])[0];
  assert.deepEqual(C.relativeStart(tomorrow, NOW), { text: "Tomorrow", level: "soon" });
  const later = C.prepareEvents([{ id: "z", title: "z", allDay: true, start: "2027-02-15", end: "2027-02-15" }])[0];
  assert.equal(C.relativeStart(later, NOW).text, "In 4 months"); // 121 days
});

test("formatRange", () => {
  const byId = Object.fromEntries(EVENTS.map((e) => [e.id, e]));
  const o = { locale: "en-GB", now: NOW };
  const multi = C.formatRange(byId.c1, o);
  assert.match(multi, /28.{1,3}30 Oct/);
  assert.equal(C.formatRange(byId.n1, o), "Thu 5 Nov");
  assert.match(C.formatRange(byId.t1, o), /^Sat 24 Oct, .+ to .*Mon 26 Oct/);
  const nextYear = C.prepareEvents([{ id: "y", title: "y", allDay: true, start: "2027-02-27", end: "2027-02-28" }])[0];
  assert.match(C.formatRange(nextYear, o), /2027/);
  const sameDayTimed = C.prepareEvents([{ id: "s", title: "s", allDay: false,
    start: new Date(2026, 10, 1, 16, 0).toISOString(), end: new Date(2026, 10, 1, 19, 0).toISOString() }])[0];
  assert.doesNotMatch(C.formatRange(sameDayTimed, o), /Nov.*Nov/);
});

test("filters: type, mode, range, search, call for papers", () => {
  const f = (over) => ids(C.filterEvents(EVENTS, Object.assign({ q: "", types: new Set(), mode: "all", range: "all", cfp: false }, over), NOW));
  assert.deepEqual(f({}), ["d1", "t1", "c1", "n1"]);                     // ended event hidden
  assert.deepEqual(f({ types: new Set(["ctf"]) }), ["t1"]);
  assert.deepEqual(f({ types: new Set(["ctf", "meetup"]) }), ["d1", "t1"]);
  assert.deepEqual(f({ mode: "online" }), ["d1", "t1"]);                  // hybrid counts as online...
  assert.deepEqual(f({ mode: "onsite" }), ["d1", "c1", "n1"]);            // ...and as on-site
  assert.deepEqual(f({ range: "7" }), ["d1"]);                            // CTF starts 7 days 2h out: just outside
  assert.deepEqual(f({ range: "30" }), ["d1", "t1", "c1", "n1"]);
  const late = C.prepareEvents([{ id: "late", title: "Late", type: "other", mode: "onsite", allDay: true,
    start: "2027-03-01", end: "2027-03-01" }]);
  const withLate = (range) => ids(C.filterEvents(EVENTS.concat(late), { q: "", types: new Set(), mode: "all", range, cfp: false }, NOW));
  assert.deepEqual(withLate("90"), ["d1", "t1", "c1", "n1"]);            // 135 days away: outside 90
  assert.deepEqual(withLate("all"), ["d1", "t1", "c1", "n1", "late"]);
  assert.deepEqual(f({ q: "goa" }), ["c1"]);
  assert.deepEqual(f({ q: "jeopardy team" }), ["t1"]);                    // tags and organizers are searchable
  assert.deepEqual(f({ q: "GERMANY conf" }), ["n1"]);                     // case-insensitive, all terms
  assert.deepEqual(f({ cfp: true }), ["c1"]);
  assert.deepEqual(f({ q: "zzz" }), []);
});

test("call for papers closes at the end of its last day", () => {
  const c1 = EVENTS.find((e) => e.id === "c1");
  assert.equal(C.cfpInfo(c1, new Date(2026, 9, 20, 23, 59)).days, 0);
  assert.equal(C.cfpInfo(c1, new Date(2026, 9, 21, 0, 1)), null);
  assert.equal(C.cfpInfo(c1, NOW).closingSoon, true);
  assert.equal(C.cfpInfo(Object.assign({}, c1, { cfpUrl: "javascript:alert(1)" }), NOW), null);
});

test("type counts ignore the type filter but respect the others", () => {
  const counts = C.countByType(EVENTS, { q: "", types: new Set(["ctf"]), mode: "onsite", range: "all", cfp: false }, NOW);
  assert.deepEqual(counts, { meetup: 1, conference: 2 });
});

test("grouping: happening now first, then months", () => {
  const groups = C.groupEvents(C.filterEvents(EVENTS, { types: new Set() }, NOW), NOW, "en-GB");
  assert.deepEqual(groups.map((g) => g.label), ["Happening now", "October 2026", "November 2026"]);
  assert.deepEqual(groups.map((g) => ids(g.items)), [["d1"], ["t1", "c1"], ["n1"]]);
});

test("board shows live events first, then the next to start", () => {
  assert.deepEqual(ids(C.boardEvents(EVENTS, NOW, 3)), ["d1", "t1", "c1"]);
  assert.deepEqual(ids(C.boardEvents(EVENTS, NOW, 10)), ["d1", "t1", "c1", "n1"]);
});

test("programs: filter and sort", () => {
  const programs = C.preparePrograms([
    { platform: "HackerOne", name: "Acme", url: "https://h.test/a", bounty: true, max: null },
    { platform: "Bugcrowd", name: "Big Bank", url: "https://b.test/b", bounty: true, max: 50000, currency: "USD" },
    { platform: "YesWeHack", name: "Zed", url: "https://y.test/z", bounty: true, max: 5000, currency: "EUR" },
    { platform: "HackerOne", name: "VDP only", url: "https://h.test/v", bounty: false, max: null },
    { platform: "HackerOne", name: "Bad link", url: "javascript:alert(1)", bounty: true },
  ]);
  const names = (f) => C.filterPrograms(programs, f).map((p) => p.name);
  assert.deepEqual(names({ sort: "payout" }), ["Big Bank", "Zed", "Acme", "VDP only"]);
  assert.deepEqual(names({ sort: "name" }), ["Acme", "Big Bank", "VDP only", "Zed"]);
  assert.deepEqual(names({ platform: "HackerOne", sort: "name" }), ["Acme", "VDP only"]);
  assert.deepEqual(names({ bountyOnly: true, sort: "name" }), ["Acme", "Big Bank", "Zed"]);
  assert.deepEqual(names({ q: "bank", sort: "name" }), ["Big Bank"]);
  assert.equal(C.formatPayout(programs[1], "en-US"), "Up to $50,000");
  assert.match(C.formatPayout(programs[2], "en-US"), /€5,000/);
  assert.equal(C.formatPayout(programs[0]), "Pays bounties");
  assert.equal(C.formatPayout({ bounty: false }), "No cash rewards");
});

test("buildIcs: valid structure, escaping, folding, exclusive all-day end", () => {
  const byId = Object.fromEntries(EVENTS.map((e) => [e.id, e]));
  const conf = Object.assign({}, byId.c1, { title: "Ünïcödé, conf; with " + "long ".repeat(30), description: "Line one\nLine two" });
  const text = C.buildIcs(conf, NOW);
  assert.ok(text.startsWith("BEGIN:VCALENDAR\r\n") && text.endsWith("END:VCALENDAR\r\n"));
  assert.match(text, /DTSTART;VALUE=DATE:20261028\r\n/);
  assert.match(text, /DTEND;VALUE=DATE:20261031\r\n/);
  for (const line of text.split("\r\n")) assert.ok(Buffer.byteLength(line) <= 75, line);
  const unfolded = text.replace(/\r\n /g, "");
  assert.match(unfolded, /SUMMARY:Ünïcödé\\, conf\\; with long/);
  assert.match(unfolded, /DESCRIPTION:Line one\\nLine two/);

  const utcCtf = C.prepareEvents([{ id: "u", title: "UTC CTF", type: "ctf", mode: "online", allDay: false,
    start: "2026-10-24T14:00:00Z", end: "2026-10-26T14:00:00Z" }])[0];
  const ctf = C.buildIcs(utcCtf, NOW);
  assert.match(ctf, /DTSTART:20261024T140000Z\r\n/);
  assert.match(ctf, /DTEND:20261026T140000Z\r\n/);
  assert.match(ctf, /LOCATION:Online\r\n/);
});

test("safeUrl only allows http(s)", () => {
  assert.equal(C.safeUrl("https://a.test"), "https://a.test");
  assert.equal(C.safeUrl("javascript:alert(1)"), "");
  assert.equal(C.safeUrl("data:text/html,x"), "");
  assert.equal(C.safeUrl(undefined), "");
});

test("timeAgo", () => {
  assert.match(C.timeAgo(new Date(NOW - 3 * 3600e3).toISOString(), NOW, "en-US"), /3 hours ago/);
  assert.match(C.timeAgo(new Date(NOW - 2 * 86400e3).toISOString(), NOW, "en-US"), /2 days ago/);
});

test("generated data files load without dropping any rows", () => {
  const dir = path.join(__dirname, "..", "data");
  const ev = JSON.parse(fs.readFileSync(path.join(dir, "events.json"), "utf8"));
  assert.equal(C.prepareEvents(ev.events).length, ev.events.length);
  const pr = JSON.parse(fs.readFileSync(path.join(dir, "programs.json"), "utf8"));
  assert.equal(C.preparePrograms(pr.programs).length, pr.programs.length);
});
