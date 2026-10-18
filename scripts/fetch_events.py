#!/usr/bin/env python3
"""Collect cybersecurity events and bug bounty programs into static files.

Writes three files that the GitHub Pages site reads:

    data/events.json    CTFs, conferences, meetups and hand-added events
    data/programs.json  public bug bounty / disclosure programs
    data/events.ics     calendar feed of everything in events.json

Sources
    ctftime     https://ctftime.org/api/             (CTFs, online and on-site)
    confs.tech  tech-conferences/conference-data      (security conferences + CFP deadlines)
    ics         any iCalendar URL listed in data/sources.json (Meetup, Luma, ...)
    manual      data/manual.json                     (anything you add by hand)
    programs    arkadiyt/bounty-targets-data          (HackerOne, Bugcrowd, Intigriti, YesWeHack)

If a source fails, the events it supplied on the previous run are kept (and the
failure is recorded in the file's "sources" block) so one bad day does not empty
the site. Files are only rewritten when their content actually changes, so the
scheduled workflow does not create empty commits.

Standard library only; Python 3.9+.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA_DIR = ROOT / "data"

USER_AGENT = "security-events-hub/1.0 (open-source GitHub Pages aggregator)"
CTFTIME_URL = "https://ctftime.org/api/v1/events/"
CONFS_URL = (
    "https://raw.githubusercontent.com/tech-conferences/conference-data/"
    "main/conferences/{year}/security.json"
)
BOUNTY_URL = (
    "https://raw.githubusercontent.com/arkadiyt/bounty-targets-data/"
    "main/data/{name}_data.json"
)

EVENT_TYPES = {"ctf", "conference", "meetup", "bounty", "other"}
MODES = {"online", "onsite", "hybrid", "unknown"}
UTC = dt.timezone.utc
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ONLINE_HINT = re.compile(
    r"\b(online|virtual|zoom|webinar|teams|google meet|meet\.google|discord|twitch|youtube)\b",
    re.I,
)


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
class FetchError(Exception):
    pass


class NotFound(FetchError):
    pass


def http_get(url: str, *, timeout: int = 30, retries: int = 3) -> bytes:
    """GET with a polite User-Agent and retries on transient errors."""
    last: Exception | None = None
    for attempt in range(retries):
        req = urllib.request.Request(
            url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"}
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise NotFound(url) from exc
            last = exc
            if exc.code not in (429, 500, 502, 503, 504):
                break
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            last = exc
        if attempt < retries - 1:
            time.sleep(2 * 2**attempt)
    raise FetchError(f"{url}: {last}") from last


# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #
def clean(value) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def truncate(text: str, limit: int = 280) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "\u2026"


def safe_http(url) -> str:
    url = clean(url)
    return url if re.match(r"^https?://", url, re.I) else ""


def utc_dt(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(clean(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def iso_z(value: dt.datetime) -> str:
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def check_date(value: str) -> str:
    if not DATE_RE.match(value or ""):
        raise ValueError(f"bad date {value!r}")
    dt.date.fromisoformat(value)
    return value


def short_error(exc: Exception) -> str:
    return truncate(clean(f"{type(exc).__name__}: {exc}"), 200)


def warn(message: str) -> None:
    if os.environ.get("GITHUB_ACTIONS"):
        print(f"::warning title=Security events hub::{message}")
    else:
        print(f"warning: {message}", file=sys.stderr)


def make_event(
    *,
    source: str,
    key: str,
    title: str,
    type_: str,
    start: str,
    end: str,
    all_day: bool,
    mode: str,
    location: str = "",
    url: str = "",
    tags=None,
    description: str = "",
    **extra,
) -> dict:
    if type_ not in EVENT_TYPES:
        type_ = "other"
    if mode not in MODES:
        mode = "unknown"
    title = clean(title)
    if not title:
        raise ValueError("event has no title")
    seen, tag_list = set(), []
    for tag in tags or []:
        tag = clean(tag)
        if tag and tag.lower() not in seen:
            seen.add(tag.lower())
            tag_list.append(tag)
    event = {
        "id": hashlib.sha1(f"{source}|{key}".encode("utf-8")).hexdigest()[:12],
        "title": title,
        "type": type_,
        "source": source,
        "start": start,
        "end": end,
        "allDay": all_day,
        "mode": mode,
        "location": clean(location),
        "url": safe_http(url),
        "tags": tag_list,
        "description": truncate(clean(description)),
    }
    for name, value in extra.items():
        if value not in (None, "", [], 0):
            event[name] = value
    return event


def has_ended(event: dict, now: dt.datetime) -> bool:
    if event["allDay"]:
        return dt.date.fromisoformat(event["end"]) < (now - dt.timedelta(days=1)).date()
    return utc_dt(event["end"]) < now


# --------------------------------------------------------------------------- #
# CTFtime
# --------------------------------------------------------------------------- #
def normalize_ctftime(item: dict) -> dict:
    start = utc_dt(item["start"])
    end = max(utc_dt(item["finish"]), start)
    onsite = bool(item.get("onsite"))
    weight = item.get("weight")
    organizers = [
        clean(o.get("name")) for o in item.get("organizers") or [] if o.get("name")
    ]
    return make_event(
        source="ctftime",
        key=str(item.get("id") or item.get("ctf_id") or item["title"]),
        title=item["title"],
        type_="ctf",
        start=iso_z(start),
        end=iso_z(end),
        all_day=False,
        mode="onsite" if onsite else "online",
        location=item.get("location") if onsite else "",
        url=item.get("url") or item.get("ctftime_url"),
        tags=[item.get("format"), item.get("restrictions")],
        description=item.get("description"),
        weight=float(weight) if isinstance(weight, (int, float)) and weight > 0 else None,
        sourceUrl=safe_http(item.get("ctftime_url")),
        organizers=organizers,
    )


def fetch_ctftime(now: dt.datetime) -> list[dict]:
    start = int((now - dt.timedelta(days=1)).timestamp())
    finish = int((now + dt.timedelta(days=270)).timestamp())
    url = f"{CTFTIME_URL}?limit=1000&start={start}&finish={finish}"
    items = json.loads(http_get(url))
    if not isinstance(items, list):
        raise FetchError("CTFtime returned an unexpected response")
    return normalize_all(items, normalize_ctftime, "ctftime")


# --------------------------------------------------------------------------- #
# confs.tech
# --------------------------------------------------------------------------- #
def normalize_conf(item: dict) -> dict:
    start = check_date(item["startDate"])
    end = check_date(item.get("endDate") or start)
    if end < start:
        end = start
    online = bool(item.get("online"))
    location = ", ".join(x for x in (clean(item.get("city")), clean(item.get("country"))) if x)
    mode = "online" if online else ("onsite" if location else "unknown")
    return make_event(
        source="confs.tech",
        key=f"{item['name']}|{start}",
        title=item["name"],
        type_="conference",
        start=start,
        end=end,
        all_day=True,
        mode=mode,
        location="" if online else location,
        url=item.get("url"),
        cfpUrl=safe_http(item.get("cfpUrl")),
        cfpEnd=check_date(item["cfpEndDate"]) if item.get("cfpEndDate") else None,
    )


def fetch_confs(now: dt.datetime) -> list[dict]:
    items: list[dict] = []
    found = 0
    for year in (now.year, now.year + 1):
        try:
            items += json.loads(http_get(CONFS_URL.format(year=year)))
            found += 1
        except NotFound:
            continue  # next year's file may not exist yet
    if not found:
        raise FetchError("no conference files found")
    return normalize_all(items, normalize_conf, "confs.tech")


# --------------------------------------------------------------------------- #
# iCalendar feeds (Meetup, Luma, any .ics)
# --------------------------------------------------------------------------- #
def unfold_ics(text: str) -> list[str]:
    lines: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        else:
            lines.append(raw)
    return lines


def unescape_ics(value: str) -> str:
    return re.sub(
        r"\\([nN,;\\])", lambda m: "\n" if m.group(1) in "nN" else m.group(1), value
    )


def parse_ics(text: str) -> list[dict]:
    """Return one dict per VEVENT: NAME -> (params, value)."""
    events, current = [], None
    for line in unfold_ics(text):
        if line.upper() == "BEGIN:VEVENT":
            current = {}
        elif line.upper() == "END:VEVENT":
            if current is not None:
                events.append(current)
            current = None
        elif current is not None and ":" in line:
            head, _, value = line.partition(":")
            name, *param_parts = head.split(";")
            params = {}
            for part in param_parts:
                key, _, val = part.partition("=")
                params[key.upper()] = val.strip('"')
            current.setdefault(name.upper(), (params, value))
    return events


def ics_datetime(value: str, params: dict):
    """Return ('date', date) or ('dt', aware datetime in UTC)."""
    value = value.strip()
    if params.get("VALUE") == "DATE" or re.fullmatch(r"\d{8}", value):
        return "date", dt.datetime.strptime(value[:8], "%Y%m%d").date()
    fmt = "%Y%m%dT%H%M%SZ" if value.endswith("Z") else "%Y%m%dT%H%M%S"
    naive = dt.datetime.strptime(value, fmt)
    if value.endswith("Z"):
        return "dt", naive.replace(tzinfo=UTC)
    try:
        zone = ZoneInfo(params["TZID"]) if params.get("TZID") else UTC
    except Exception:
        zone = UTC
    return "dt", naive.replace(tzinfo=zone).astimezone(UTC)


def normalize_ics_event(props: dict, feed: dict) -> dict | None:
    if "SUMMARY" not in props or "DTSTART" not in props:
        return None
    if props.get("STATUS", ({}, ""))[1].strip().upper() == "CANCELLED":
        return None
    kind, start = ics_datetime(props["DTSTART"][1], props["DTSTART"][0])
    end_raw = props.get("DTEND")
    if kind == "date":
        end = start
        if end_raw:
            _, end_val = ics_datetime(end_raw[1], end_raw[0])
            end = end_val - dt.timedelta(days=1)  # DTEND is exclusive for all-day
        end = max(end, start)
        start_s, end_s, all_day = start.isoformat(), end.isoformat(), True
    else:
        end = start + dt.timedelta(hours=2)
        if end_raw:
            _, end = ics_datetime(end_raw[1], end_raw[0])
            end = max(end, start)
        start_s, end_s, all_day = iso_z(start), iso_z(end), False

    summary = unescape_ics(props["SUMMARY"][1])
    location = unescape_ics(props.get("LOCATION", ({}, ""))[1])
    url = props.get("URL", ({}, ""))[1] or next(
        iter(re.findall(r"https?://\S+", unescape_ics(props.get("DESCRIPTION", ({}, ""))[1]))),
        "",
    )
    if feed.get("mode") in MODES:
        mode = feed["mode"]
    elif ONLINE_HINT.search(location) or ONLINE_HINT.search(summary):
        mode = "online"
    else:
        mode = "onsite" if location.strip() else "unknown"
    uid = props.get("UID", ({}, summary))[1]
    return make_event(
        source=f"ics:{feed['name']}",
        key=f"{uid}|{start_s}",
        title=summary,
        type_=feed.get("type", "meetup"),
        start=start_s,
        end=end_s,
        all_day=all_day,
        mode=mode,
        location="" if mode == "online" and re.match(r"^https?://", location) else location,
        url=url,
        tags=[feed["name"], *feed.get("tags", [])],
        description=unescape_ics(props.get("DESCRIPTION", ({}, ""))[1]),
    )


def fetch_ics_feed(feed: dict) -> list[dict]:
    text = http_get(feed["url"]).decode("utf-8", errors="replace")
    events, skipped = [], 0
    for props in parse_ics(text):
        try:
            event = normalize_ics_event(props, feed)
        except (ValueError, KeyError, TypeError, AttributeError):
            skipped += 1
            continue
        if event:
            events.append(event)
    if skipped:
        warn(f"{feed['name']}: skipped {skipped} unreadable calendar entries")
    return events


# --------------------------------------------------------------------------- #
# Manual events
# --------------------------------------------------------------------------- #
def normalize_manual(raw: dict) -> dict:
    title = clean(raw["title"])
    start_raw, end_raw = clean(raw["start"]), clean(raw.get("end"))
    if DATE_RE.match(start_raw):
        start = check_date(start_raw)
        end = check_date(end_raw) if end_raw else start
        if end < start:
            raise ValueError("end is before start")
        all_day = True
    else:
        start_dt = utc_dt(start_raw)
        end_dt = utc_dt(end_raw) if end_raw else start_dt + dt.timedelta(hours=2)
        if end_dt < start_dt:
            raise ValueError("end is before start")
        start, end, all_day = iso_z(start_dt), iso_z(end_dt), False
    return make_event(
        source="manual",
        key=f"{title}|{start}",
        title=title,
        type_=clean(raw.get("type")).lower() or "other",
        start=start,
        end=end,
        all_day=all_day,
        mode=clean(raw.get("mode")).lower() or "unknown",
        location=raw.get("location"),
        url=raw.get("url"),
        tags=raw.get("tags"),
        description=raw.get("description"),
        cfpUrl=safe_http(raw.get("cfpUrl")),
        cfpEnd=check_date(raw["cfpEnd"]) if raw.get("cfpEnd") else None,
    )


def load_manual(path: Path) -> list[dict]:
    if not path.exists():
        return []
    items = json.loads(path.read_text("utf-8") or "[]")
    if not isinstance(items, list):
        raise ValueError("manual.json must contain a list")
    return normalize_all(items, normalize_manual, "manual")


def normalize_all(items, normalizer, label: str) -> list[dict]:
    out, bad = [], 0
    for item in items:
        try:
            out.append(normalizer(item))
        except (KeyError, ValueError, TypeError, AttributeError):
            bad += 1
    if bad:
        warn(f"{label}: skipped {bad} entries that could not be read")
    return out


# --------------------------------------------------------------------------- #
# Merging
# --------------------------------------------------------------------------- #
def norm_title(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()


def dedupe(events: list[dict]) -> list[dict]:
    seen: dict[tuple, dict] = {}
    for event in events:  # earlier sources win
        seen.setdefault((norm_title(event["title"]), event["start"][:10]), event)
    return list(seen.values())


def read_json(path: Path, default):
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return default


def collect_events(now, data_dir: Path, sources_cfg: dict, only: set[str] | None):
    """Run every source; fall back to last run's events for any that fail."""
    prev = read_json(data_dir / "events.json", {})
    prev_events = prev.get("events", [])
    prev_status = prev.get("sources", {})

    jobs = [("manual", lambda: load_manual(data_dir / "manual.json"), "manual"),
            ("ctftime", lambda: fetch_ctftime(now), "ctftime"),
            ("confs.tech", lambda: fetch_confs(now), "confs")]
    for feed in sources_cfg.get("ics_feeds", []):
        if feed.get("url") and feed.get("name"):
            jobs.append((f"ics:{feed['name']}", lambda f=feed: fetch_ics_feed(f), "ics"))

    events, status = [], {}
    for name, job, group in jobs:
        carried = [e for e in prev_events if e["source"] == name and not has_ended(e, now)]
        if only is not None and group not in only:
            events += carried
            status[name] = prev_status.get(name, {"ok": True, "count": len(carried), "error": None})
            continue
        try:
            fresh = [e for e in job() if not has_ended(e, now)]
            events += fresh
            status[name] = {"ok": True, "count": len(fresh), "error": None}
        except Exception as exc:  # one broken source must not stop the others
            events += carried
            status[name] = {"ok": False, "count": len(carried), "error": short_error(exc)}
            warn(f"{name} failed, kept {len(carried)} earlier events: {short_error(exc)}")

    events = dedupe(events)
    events.sort(key=lambda e: (e["start"][:10], e["start"], e["title"].lower()))
    return events, status


# --------------------------------------------------------------------------- #
# Bug bounty programs
# --------------------------------------------------------------------------- #
def number(value):
    return int(value) if isinstance(value, (int, float)) and value > 0 else None


def normalize_programs(platform: str, raw: list) -> list[dict]:
    out = []
    for p in raw:
        if platform == "HackerOne":
            if p.get("submission_state") != "open":
                continue
            row = {"bounty": bool(p.get("offers_bounties")), "max": None, "currency": None, "safeHarbor": None}
        elif platform == "Bugcrowd":
            maximum = number(p.get("max_payout"))
            row = {"bounty": bool(maximum), "max": maximum, "currency": "USD" if maximum else None,
                   "safeHarbor": p.get("safe_harbor")}
        elif platform == "Intigriti":
            if p.get("status") != "open" or p.get("confidentiality_level") != "public":
                continue
            top = p.get("max_bounty") or {}
            maximum = number(top.get("value"))
            row = {"bounty": bool(maximum), "max": maximum, "currency": top.get("currency") if maximum else None,
                   "safeHarbor": None}
        elif platform == "YesWeHack":
            if p.get("disabled") or not p.get("public"):
                continue
            maximum = number(p.get("max_bounty"))
            row = {"bounty": bool(maximum), "max": maximum, "currency": "EUR" if maximum else None,
                   "safeHarbor": None}
            # YesWeHack records carry only a slug, not a URL
            p = dict(p, url=f"https://yeswehack.com/programs/{clean(p.get('id'))}" if p.get("id") else "")
        else:
            continue
        name, url = clean(p.get("name")), safe_http(p.get("url"))
        if name and url:
            out.append({"platform": platform, "name": name, "url": url, **row})
    return out


PROGRAM_FILES = {"HackerOne": "hackerone", "Bugcrowd": "bugcrowd",
                 "Intigriti": "intigriti", "YesWeHack": "yeswehack"}


def collect_programs(data_dir: Path, skip: bool):
    prev = read_json(data_dir / "programs.json", {})
    prev_programs = prev.get("programs", [])
    prev_status = prev.get("sources", {})
    programs, status = [], {}
    for platform, file_name in PROGRAM_FILES.items():
        carried = [p for p in prev_programs if p["platform"] == platform]
        if skip:
            programs += carried
            status[platform] = prev_status.get(platform, {"ok": True, "count": len(carried), "error": None})
            continue
        try:
            raw = json.loads(http_get(BOUNTY_URL.format(name=file_name), timeout=120))
            fresh = normalize_programs(platform, raw)
            programs += fresh
            status[platform] = {"ok": True, "count": len(fresh), "error": None}
        except Exception as exc:
            programs += carried
            status[platform] = {"ok": False, "count": len(carried), "error": short_error(exc)}
            warn(f"{platform} programs failed, kept {len(carried)} earlier entries: {short_error(exc)}")
    programs.sort(key=lambda p: (p["platform"], p["name"].lower()))
    return programs, status


# --------------------------------------------------------------------------- #
# Output
# --------------------------------------------------------------------------- #
def pretty(payload: dict) -> str:
    """JSON with one list item per line, so git diffs stay readable."""
    compact = {"ensure_ascii": False, "separators": (",", ":")}
    lines, keys = ["{"], list(payload)
    for i, key in enumerate(keys):
        comma = "," if i < len(keys) - 1 else ""
        value = payload[key]
        if isinstance(value, list):
            lines.append(f"{json.dumps(key)}: [")
            for j, item in enumerate(value):
                lines.append("  " + json.dumps(item, **compact) + ("," if j < len(value) - 1 else ""))
            lines.append("]" + comma)
        else:
            lines.append(f"{json.dumps(key)}: {json.dumps(value, **compact)}{comma}")
    lines.append("}")
    return "\n".join(lines) + "\n"


def write_if_changed(path: Path, payload: dict, stamp: str) -> bool:
    """Write payload only if its content differs from the file already there.

    generatedAt is the time the content last changed, so unchanged runs leave the
    file byte-identical and the workflow makes no commit.
    """
    old = read_json(path, None)
    strip = lambda d: {k: v for k, v in d.items() if k != "generatedAt"}
    if isinstance(old, dict) and json.dumps(strip(old), sort_keys=True) == json.dumps(
        strip(payload), sort_keys=True
    ):
        payload["generatedAt"] = old.get("generatedAt", stamp)
        return False
    payload["generatedAt"] = stamp
    path.write_text(pretty(payload), "utf-8")
    return True


def ics_escape(text: str) -> str:
    return (text.replace("\\", "\\\\").replace(";", "\\;")
            .replace(",", "\\,").replace("\r", "").replace("\n", "\\n"))


def fold(line: str) -> str:
    raw, parts, limit = line.encode("utf-8"), [], 75
    while len(raw) > limit:
        cut = limit
        while cut > 0 and (raw[cut] & 0xC0) == 0x80:  # never split a multi-byte character
            cut -= 1
        parts.append(raw[:cut].decode("utf-8"))
        raw, limit = raw[cut:], 74
    parts.append(raw.decode("utf-8"))
    return "\r\n ".join(parts)


TYPE_LABEL = {"ctf": "CTF", "conference": "Conference", "meetup": "Meetup",
              "bounty": "Bug bounty", "other": "Other"}


def build_ics(events: list[dict], generated_at: str) -> str:
    stamp = utc_dt(generated_at).strftime("%Y%m%dT%H%M%SZ")
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//security-events-hub//EN",
             "CALSCALE:GREGORIAN", "X-WR-CALNAME:Security events",
             "X-WR-CALDESC:CTFs, conferences, meetups and bug bounty events"]
    for e in events:
        lines += ["BEGIN:VEVENT", f"UID:{e['id']}@security-events-hub", f"DTSTAMP:{stamp}"]
        if e["allDay"]:
            end = dt.date.fromisoformat(e["end"]) + dt.timedelta(days=1)
            lines += [f"DTSTART;VALUE=DATE:{e['start'].replace('-', '')}",
                      f"DTEND;VALUE=DATE:{end.strftime('%Y%m%d')}"]
        else:
            for tag, key in (("DTSTART", "start"), ("DTEND", "end")):
                lines.append(f"{tag}:{utc_dt(e[key]).strftime('%Y%m%dT%H%M%SZ')}")
        lines.append(f"SUMMARY:{ics_escape(e['title'])}")
        if e["location"]:
            lines.append(f"LOCATION:{ics_escape(e['location'])}")
        elif e["mode"] == "online":
            lines.append("LOCATION:Online")
        if e["url"]:
            lines.append(f"URL:{e['url']}")
        note = " ".join(x for x in (e["description"], e["url"]) if x)
        if note:
            lines.append(f"DESCRIPTION:{ics_escape(note)}")
        lines += [f"CATEGORIES:{TYPE_LABEL.get(e['type'], 'Other')}", "END:VEVENT"]
    lines.append("END:VCALENDAR")
    return "\r\n".join(fold(line) for line in lines) + "\r\n"


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def run(data_dir: Path, only: set[str] | None, now: dt.datetime | None = None) -> int:
    now = now or dt.datetime.now(UTC)
    data_dir.mkdir(parents=True, exist_ok=True)
    stamp = iso_z(now)
    sources_cfg = read_json(data_dir / "sources.json", {})

    events, ev_status = collect_events(now, data_dir, sources_cfg, only)
    programs, pr_status = collect_programs(data_dir, skip=only is not None and "programs" not in only)

    events_payload = {"generatedAt": stamp, "sources": ev_status, "events": events}
    changed = write_if_changed(data_dir / "events.json", events_payload, stamp)
    ics_path = data_dir / "events.ics"
    if changed or not ics_path.exists():
        # newline="" keeps the CRLF line endings the iCalendar spec requires
        with open(ics_path, "w", encoding="utf-8", newline="") as fh:
            fh.write(build_ics(events, events_payload["generatedAt"]))

    programs_payload = {"generatedAt": stamp, "sources": pr_status, "programs": programs}
    write_if_changed(data_dir / "programs.json", programs_payload, stamp)

    by_type: dict[str, int] = {}
    for e in events:
        by_type[e["type"]] = by_type.get(e["type"], 0) + 1
    print(f"events: {len(events)} {by_type or ''}  programs: {len(programs)}")
    for name, s in {**ev_status, **pr_status}.items():
        print(f"  {'ok  ' if s['ok'] else 'FAIL'} {name:<24} {s['count']:>5}  {s['error'] or ''}")

    network = [s for n, s in ev_status.items() if n in ("ctftime", "confs.tech")]
    return 1 if network and not any(s["ok"] for s in network) else 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR))
    parser.add_argument("--only", help="comma list of: manual,ctftime,confs,ics,programs "
                                       "(others keep their previous data)")
    args = parser.parse_args(argv)
    only = {x.strip() for x in args.only.split(",")} if args.only else None
    return run(Path(args.data_dir), only)


if __name__ == "__main__":
    sys.exit(main())
