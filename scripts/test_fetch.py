"""Offline tests for fetch_events.py. Run: python -m unittest discover -s scripts -v"""
import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_events as fe  # noqa: E402

NOW = dt.datetime(2026, 10, 17, 12, 0, tzinfo=dt.timezone.utc)

# Shaped like https://ctftime.org/api/v1/events/ responses.
CTFTIME_ITEM = {
    "id": 2901, "ctf_id": 1337, "title": "  Example   CTF 2026 ",
    "start": "2026-10-24T14:00:00+00:00", "finish": "2026-10-26T14:00:00+00:00",
    "url": "https://example-ctf.test/", "ctftime_url": "https://ctftime.org/event/2901/",
    "format": "Jeopardy", "restrictions": "Open", "onsite": False, "location": "",
    "weight": 24.5, "description": "Jeopardy CTF.\nOpen to all.",
    "organizers": [{"id": 1, "name": "Team Example"}],
}

ICS = """BEGIN:VCALENDAR\r
BEGIN:VEVENT\r
UID:abc@meetup.test\r
SUMMARY:null Mumbai\\, monthly meet\r
DTSTART;TZID=Asia/Kolkata:20261101T160000\r
DTEND;TZID=Asia/Kolkata:20261101T190000\r
LOCATION:Some Office\\, Powai\\, Mumbai\r
DESCRIPTION:Talks and demos. RSVP at https://meetup.test/e/1 and a very long\r
  line that was folded by the sender.\r
URL:https://meetup.test/e/1\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:def@meetup.test\r
SUMMARY:Intro to web hacking (online)\r
DTSTART:20261105T133000Z\r
LOCATION:https://zoom.test/j/123\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:ghi@meetup.test\r
SUMMARY:Two day workshop\r
DTSTART;VALUE=DATE:20261120\r
DTEND;VALUE=DATE:20261122\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:jkl@meetup.test\r
SUMMARY:Cancelled thing\r
DTSTART:20261201T100000Z\r
STATUS:CANCELLED\r
END:VEVENT\r
END:VCALENDAR\r
"""
FEED = {"name": "Test group", "url": "https://x.test/cal.ics", "type": "meetup"}


class CtftimeTests(unittest.TestCase):
    def test_normalizes_fields(self):
        e = fe.normalize_ctftime(CTFTIME_ITEM)
        self.assertEqual(e["title"], "Example CTF 2026")
        self.assertEqual((e["type"], e["mode"], e["allDay"]), ("ctf", "online", False))
        self.assertEqual((e["start"], e["end"]), ("2026-10-24T14:00:00Z", "2026-10-26T14:00:00Z"))
        self.assertEqual(e["tags"], ["Jeopardy", "Open"])
        self.assertEqual(e["weight"], 24.5)
        self.assertEqual(e["organizers"], ["Team Example"])
        self.assertEqual(e["url"], "https://example-ctf.test/")

    def test_onsite_keeps_location_and_falls_back_to_ctftime_url(self):
        item = dict(CTFTIME_ITEM, onsite=True, location="Goa, India", url="", weight=0)
        e = fe.normalize_ctftime(item)
        self.assertEqual((e["mode"], e["location"]), ("onsite", "Goa, India"))
        self.assertEqual(e["url"], "https://ctftime.org/event/2901/")
        self.assertNotIn("weight", e)

    def test_javascript_urls_are_dropped(self):
        e = fe.normalize_ctftime(dict(CTFTIME_ITEM, url="javascript:alert(1)", ctftime_url=""))
        self.assertEqual(e["url"], "")

    def test_bad_entries_are_skipped_not_fatal(self):
        out = fe.normalize_all([CTFTIME_ITEM, {"title": "no dates"}], fe.normalize_ctftime, "t")
        self.assertEqual(len(out), 1)


class ConfTests(unittest.TestCase):
    def test_conference_with_cfp(self):
        e = fe.normalize_conf({
            "name": "Nullcon Goa", "url": "https://nullcon.net", "startDate": "2027-02-27",
            "endDate": "2027-02-28", "city": "Goa", "country": "India", "online": False,
            "cfpUrl": "https://cfp.test", "cfpEndDate": "2026-11-20"})
        self.assertEqual((e["type"], e["allDay"], e["mode"]), ("conference", True, "onsite"))
        self.assertEqual(e["location"], "Goa, India")
        self.assertEqual((e["cfpUrl"], e["cfpEnd"]), ("https://cfp.test", "2026-11-20"))

    def test_online_conference_has_no_location_and_end_defaults_to_start(self):
        e = fe.normalize_conf({"name": "Web Camp", "url": "https://w.test",
                               "startDate": "2026-12-01", "online": True, "city": "Berlin"})
        self.assertEqual((e["mode"], e["location"], e["end"]), ("online", "", "2026-12-01"))

    def test_bad_date_raises(self):
        with self.assertRaises(ValueError):
            fe.normalize_conf({"name": "x", "startDate": "soon"})


class IcsTests(unittest.TestCase):
    def setUp(self):
        self.events = [fe.normalize_ics_event(p, FEED) for p in fe.parse_ics(ICS)]

    def test_cancelled_events_are_dropped(self):
        self.assertEqual([e["title"] for e in self.events if e],
                         ["null Mumbai, monthly meet", "Intro to web hacking (online)", "Two day workshop"])

    def test_timezone_conversion_escapes_and_folding(self):
        e = self.events[0]
        self.assertEqual((e["start"], e["end"]), ("2026-11-01T10:30:00Z", "2026-11-01T13:30:00Z"))
        self.assertEqual((e["mode"], e["location"]), ("onsite", "Some Office, Powai, Mumbai"))
        self.assertEqual(e["url"], "https://meetup.test/e/1")
        self.assertIn("a very long line", e["description"])

    def test_online_detection_hides_meeting_link_as_location(self):
        e = self.events[1]
        self.assertEqual((e["mode"], e["location"], e["end"]), ("online", "", "2026-11-05T15:30:00Z"))

    def test_all_day_end_is_made_inclusive(self):
        e = self.events[2]
        self.assertEqual((e["allDay"], e["start"], e["end"]), (True, "2026-11-20", "2026-11-21"))

    def test_feed_mode_override(self):
        e = fe.normalize_ics_event(fe.parse_ics(ICS)[0], dict(FEED, mode="hybrid"))
        self.assertEqual(e["mode"], "hybrid")


class ManualTests(unittest.TestCase):
    def test_all_day_and_timed(self):
        a = fe.normalize_manual({"title": "BSides X", "start": "2026-12-05", "type": "Conference",
                                 "mode": "onsite", "location": "Pune", "url": "https://b.test"})
        self.assertEqual((a["allDay"], a["end"], a["type"]), (True, "2026-12-05", "conference"))
        b = fe.normalize_manual({"title": "Live hack", "start": "2026-12-05T10:00:00+05:30", "type": "bounty"})
        self.assertEqual((b["start"], b["end"]), ("2026-12-05T04:30:00Z", "2026-12-05T06:30:00Z"))

    def test_unknown_type_becomes_other_and_end_before_start_fails(self):
        self.assertEqual(fe.normalize_manual({"title": "t", "start": "2026-12-05", "type": "party"})["type"], "other")
        with self.assertRaises(ValueError):
            fe.normalize_manual({"title": "t", "start": "2026-12-05", "end": "2026-12-01"})


class ProgramTests(unittest.TestCase):
    def test_each_platform_maps_to_name_url_and_payout(self):
        h1 = fe.normalize_programs("HackerOne", [
            {"name": "Acme", "url": "https://hackerone.com/acme", "submission_state": "open", "offers_bounties": True},
            {"name": "Shut", "url": "https://hackerone.com/shut", "submission_state": "closed"}])
        self.assertEqual([(p["name"], p["bounty"]) for p in h1], [("Acme", True)])
        bc = fe.normalize_programs("Bugcrowd", [{"name": "B", "url": "https://bugcrowd.com/b", "max_payout": 7500,
                                                  "safe_harbor": "full"}])
        self.assertEqual((bc[0]["max"], bc[0]["currency"], bc[0]["safeHarbor"]), (7500, "USD", "full"))
        it = fe.normalize_programs("Intigriti", [
            {"name": "I", "url": "https://www.intigriti.com/programs/x/y/detail", "status": "open",
             "confidentiality_level": "public", "max_bounty": {"value": 0, "currency": "EUR"}},
            {"name": "Private", "url": "https://www.intigriti.com/p", "status": "open",
             "confidentiality_level": "application", "max_bounty": {"value": 5, "currency": "EUR"}}])
        self.assertEqual([(p["name"], p["bounty"]) for p in it], [("I", False)])
        yw = fe.normalize_programs("YesWeHack", [{"id": "outscale", "name": "3DS OUTSCALE", "public": True,
                                                   "disabled": False, "max_bounty": 5000}])
        self.assertEqual((yw[0]["url"], yw[0]["max"], yw[0]["currency"]),
                         ("https://yeswehack.com/programs/outscale", 5000, "EUR"))


class MergeTests(unittest.TestCase):
    def test_has_ended(self):
        timed = fe.normalize_ctftime(CTFTIME_ITEM)
        self.assertFalse(fe.has_ended(timed, NOW))
        self.assertTrue(fe.has_ended(timed, NOW + dt.timedelta(days=30)))
        allday = fe.normalize_conf({"name": "c", "startDate": "2026-10-15", "endDate": "2026-10-16"})
        self.assertFalse(fe.has_ended(allday, NOW))          # ended yesterday UTC: grace day
        self.assertTrue(fe.has_ended(allday, NOW + dt.timedelta(days=2)))

    def test_dedupe_keeps_first_source(self):
        a = fe.make_event(source="manual", key="1", title="Nullcon  Goa!", type_="conference",
                          start="2027-02-27", end="2027-02-28", all_day=True, mode="onsite")
        b = fe.make_event(source="confs.tech", key="2", title="nullcon goa", type_="conference",
                          start="2027-02-27", end="2027-02-28", all_day=True, mode="onsite")
        self.assertEqual(fe.dedupe([a, b]), [a])


class CalendarOutputTests(unittest.TestCase):
    def test_ics_has_crlf_folds_long_lines_and_exclusive_all_day_end(self):
        long_title = "Ünïcödé " * 30
        events = [
            fe.make_event(source="m", key="1", title=long_title, type_="ctf", start="2026-10-24T14:00:00Z",
                          end="2026-10-24T16:00:00Z", all_day=False, mode="online", url="https://a.test"),
            fe.make_event(source="m", key="2", title="Conf, with; chars", type_="conference",
                          start="2026-11-20", end="2026-11-21", all_day=True, mode="onsite", location="Goa"),
        ]
        text = fe.build_ics(events, "2026-10-17T12:00:00Z")
        self.assertTrue(text.startswith("BEGIN:VCALENDAR\r\n") and text.endswith("END:VCALENDAR\r\n"))
        self.assertIn("DTEND;VALUE=DATE:20261122", text)
        self.assertIn("SUMMARY:Conf\\, with\\; chars", text)
        self.assertIn("LOCATION:Online", text)
        for line in text.split("\r\n"):
            self.assertLessEqual(len(line.encode("utf-8")), 75)
        unfolded = text.replace("\r\n ", "")
        self.assertIn(long_title.strip().replace(",", "\\,"), unfolded)  # nothing lost or split mid-character


class RunTests(unittest.TestCase):
    def fake_http(self, calls):
        def get(url, **_):
            calls.append(url)
            if "ctftime.org" in url:
                return json.dumps([CTFTIME_ITEM]).encode()
            if "conference-data" in url:
                if "/2027/" in url:
                    raise fe.NotFound(url)
                return json.dumps([{"name": "Conf A", "url": "https://a.test", "startDate": "2026-11-10",
                                    "endDate": "2026-11-11", "city": "Pune", "country": "India"}]).encode()
            if "bounty-targets-data" in url:
                if "hackerone" in url:
                    return json.dumps([{"name": "Acme", "url": "https://hackerone.com/acme",
                                        "submission_state": "open", "offers_bounties": True},
                                       {"name": "Gone", "url": "https://hackerone.com/gone",
                                        "submission_state": "closed"}]).encode()
                return b"[]"
            if url == FEED["url"]:
                return ICS.encode()
            raise AssertionError(url)
        return get

    def test_full_run_then_idempotent_then_survives_outage(self):
        with tempfile.TemporaryDirectory() as tmp:
            data = Path(tmp)
            (data / "sources.json").write_text(json.dumps({"ics_feeds": [FEED]}))
            (data / "manual.json").write_text(json.dumps(
                [{"title": "Hand added", "start": "2026-12-01", "type": "meetup", "url": "https://h.test"}]))

            with mock.patch.object(fe, "http_get", self.fake_http([])):
                self.assertEqual(fe.run(data, None, NOW), 0)
            events = json.loads((data / "events.json").read_text())
            titles = [e["title"] for e in events["events"]]
            # Sorted by start date: Oct 24 CTF, Nov 1 and 5 meetups, Nov 10 conference,
            # Nov 20 workshop, Dec 1 manual entry.
            self.assertEqual(titles, ["Example CTF 2026", "null Mumbai, monthly meet",
                                      "Intro to web hacking (online)", "Conf A",
                                      "Two day workshop", "Hand added"])
            programs = json.loads((data / "programs.json").read_text())
            self.assertEqual([p["name"] for p in programs["programs"]], ["Acme"])
            self.assertTrue((data / "events.ics").read_bytes().startswith(b"BEGIN:VCALENDAR\r\n"))

            # Same inputs later the same day: nothing is rewritten.
            before = {p.name: p.read_bytes() for p in data.iterdir()}
            with mock.patch.object(fe, "http_get", self.fake_http([])):
                fe.run(data, None, NOW + dt.timedelta(hours=6))
            self.assertEqual(before, {p.name: p.read_bytes() for p in data.iterdir()})

            # CTFtime goes down: its earlier events stay, failure is recorded, exit code still 0.
            def outage(url, **kw):
                if "ctftime.org" in url:
                    raise fe.FetchError("blocked")
                return self.fake_http([])(url, **kw)
            with mock.patch.object(fe, "http_get", outage):
                self.assertEqual(fe.run(data, None, NOW + dt.timedelta(days=1)), 0)
            after = json.loads((data / "events.json").read_text())
            self.assertIn("Example CTF 2026", [e["title"] for e in after["events"]])
            self.assertFalse(after["sources"]["ctftime"]["ok"])
            self.assertTrue(after["sources"]["confs.tech"]["ok"])

    def test_exit_code_is_1_when_both_network_sources_fail(self):
        with tempfile.TemporaryDirectory() as tmp:
            def down(url, **_):
                raise fe.FetchError("offline")
            with mock.patch.object(fe, "http_get", down):
                self.assertEqual(fe.run(Path(tmp), None, NOW), 1)


if __name__ == "__main__":
    unittest.main()
