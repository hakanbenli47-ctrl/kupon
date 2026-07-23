from __future__ import annotations

import hashlib
import html
import json
import re
import time
import urllib.request
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pdfplumber


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "imports" / "official-domestic-2026-27.generated.json"
PDF_DIR = ROOT / "tmp" / "pdfs"
PDF_PATH = PDF_DIR / "laliga-2026-27.pdf"
CHECKED_AT = datetime.now(tz=ZoneInfo("UTC")).isoformat().replace("+00:00", "Z")

PL_URL = "https://www.premierleague.com/en/news/4675097/all-380-fixtures-for-202627-premier-league-season/"
LL_URL = "https://rfef.es/sites/default/files/2026-06/Campeonato_de_Primera_Division_0.pdf"
LL_PAGE = "https://rfef.es/es/noticias/calendario-completo-primera-division-temporada-202627"
TFF_URL = "https://www.tff.org/Default.aspx?hafta={week}&pageId=198"

TEAM_MAP_LL = {
    "Deportivo Alavés": "Alavés",
    "Athletic Club": "Athletic Club",
    "Club Atlético de Madrid": "Atlético Madrid",
    "RC Celta de Vigo": "Celta Vigo",
    "RC Deportivo": "Deportivo La Coruña",
    "RCD Espanyol de Barcelona": "Espanyol",
    "FC Barcelona": "Barcelona",
    "Real Racing Club de Santander": "Racing Santander",
    "Real Madrid CF": "Real Madrid",
    "Real Sociedad de Fútbol": "Real Sociedad",
    "Sevilla FC": "Sevilla",
    "Valencia CF": "Valencia",
    "Villarreal CF": "Villarreal",
    "Getafe CF": "Getafe",
    "Málaga CF": "Málaga",
    "Club Atlético Osasuna": "Osasuna",
    "Rayo Vallecano de Madrid": "Rayo Vallecano",
    "Real Betis Balompié": "Real Betis",
    "Elche CF": "Elche",
    "Levante UD": "Levante",
}

TEAM_MAP_TFF = {
    "GALATASARAY A.Ş.": "Galatasaray",
    "ÇORUM FK": "Çorum FK",
    "KONYASPOR": "Konyaspor",
    "ÇAYKUR RİZESPOR A.Ş.": "Çaykur Rizespor",
    "KASIMPAŞA A.Ş.": "Kasımpaşa",
    "TRABZONSPOR A.Ş.": "Trabzonspor",
    "GAZİANTEP FUTBOL KULÜBÜ A.Ş.": "Gaziantep FK",
    "CORENDON ALANYASPOR": "Alanyaspor",
    "GENÇLERBİRLİĞİ": "Gençlerbirliği",
    "FENERBAHÇE A.Ş.": "Fenerbahçe",
    "İSTANBUL BAŞAKŞEHİR FK": "Başakşehir",
    "KOCAELİSPOR": "Kocaelispor",
    "AMED SPORTİF FAALİYETLER": "Amed SK",
    "ERZURUMSPOR FK": "Erzurumspor FK",
    "BEŞİKTAŞ A.Ş.": "Beşiktaş",
    "EYÜPSPOR": "Eyüpspor",
    "SAMSUNSPOR A.Ş.": "Samsunspor",
    "GÖZTEPE A.Ş.": "Göztepe",
}


def fetch(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "KuponAnaliz/1.2 verified-schedule-import"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def iso_utc(value: datetime) -> str:
    return value.astimezone(ZoneInfo("UTC")).isoformat(timespec="seconds").replace("+00:00", "Z")


def fixture_id(prefix: str, *parts: object) -> str:
    digest = hashlib.sha1("|".join(str(part) for part in parts).encode("utf-8")).hexdigest()[:20]
    return f"official-{prefix}-{digest}"


def import_premier_league() -> list[dict]:
    raw = fetch(PL_URL).decode("utf-8")
    text = re.sub(r"<(br|/p|/h[1-6]|/li|/div)[^>]*>", "\n", raw, flags=re.I)
    text = html.unescape(re.sub(r"<[^>]+>", "", text))
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
    lines = [line for line in lines if line]
    start = lines.index("Friday 21 August 2026")
    lines = lines[start:]

    date_pattern = re.compile(
        r"^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) "
        r"(\d{1,2}) ([A-Za-z]+)(?: (\d{4}))?$"
    )
    match_pattern = re.compile(r"^(?:(\d{2}:\d{2}) )?(.+?) v (.+?)(?: \([^)]*\))?\**$")
    current_date: datetime | None = None
    current_year = 2026
    fixtures: list[dict] = []
    for line in lines:
        if line in {"Related Content", "Latest News"}:
            break
        date_match = date_pattern.match(line)
        if date_match:
            current_year = int(date_match.group(4) or current_year)
            current_date = datetime.strptime(
                f"{date_match.group(2)} {date_match.group(3)} {current_year}", "%d %B %Y"
            )
            continue
        if line.startswith("*") or current_date is None:
            continue
        match = match_pattern.match(line)
        if not match:
            continue
        time_value = match.group(1) or "15:00"
        home = match.group(2).strip()
        away = match.group(3).strip()
        kickoff = datetime.strptime(
            f"{current_date:%Y-%m-%d} {time_value}", "%Y-%m-%d %H:%M"
        ).replace(tzinfo=ZoneInfo("Europe/London"))
        fixtures.append({
            "external_id": fixture_id("PL", current_date.date(), home, away),
            "competition_code": "PL",
            "season": "2026-2027",
            "stage": "Premier League 2026/27",
            "kickoff_utc": iso_utc(kickoff),
            "home_team": home,
            "away_team": away,
            "status": "TIMED",
            "home_goals": None,
            "away_goals": None,
            "source_name": "Premier League",
            "source_url": PL_URL,
            "source_checked_at": CHECKED_AT,
        })
    return fixtures


def grouped_words(page) -> list[list[dict]]:
    rows: dict[int, list[dict]] = defaultdict(list)
    for word in page.extract_words():
        rows[round(word["top"])].append(word)
    return [sorted(rows[key], key=lambda item: item["x0"]) for key in sorted(rows)]


def import_laliga() -> list[dict]:
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    if not PDF_PATH.exists():
        PDF_PATH.write_bytes(fetch(LL_URL))
    fixtures: list[dict] = []
    round_number = 0
    round_date: datetime | None = None
    with pdfplumber.open(PDF_PATH) as pdf:
        for page in pdf.pages:
            for words in grouped_words(page):
                line = " ".join(word["text"] for word in words)
                round_match = re.search(r"Jornada\s+(\d+)\s+\((\d{2}/\d{2}/\d{4})\)", line)
                if round_match:
                    round_number = int(round_match.group(1))
                    round_date = datetime.strptime(round_match.group(2), "%d/%m/%Y")
                    continue
                if round_date is None:
                    continue
                left = " ".join(word["text"] for word in words if 40 <= word["x0"] < 250).strip()
                right = " ".join(word["text"] for word in words if word["x0"] >= 250).strip()
                if left not in TEAM_MAP_LL or right not in TEAM_MAP_LL:
                    continue
                home = TEAM_MAP_LL[left]
                away = TEAM_MAP_LL[right]
                kickoff = round_date.replace(hour=12, tzinfo=ZoneInfo("Europe/Madrid"))
                fixtures.append({
                    "external_id": fixture_id("LL", round_number, home, away),
                    "competition_code": "LL",
                    "season": "2026-2027",
                    "stage": f"La Liga 2026/27 - Hafta {round_number}",
                    "kickoff_utc": iso_utc(kickoff),
                    "home_team": home,
                    "away_team": away,
                    "status": "TBC",
                    "home_goals": None,
                    "away_goals": None,
                    "source_name": "RFEF",
                    "source_url": LL_PAGE,
                    "source_checked_at": CHECKED_AT,
                })
    return fixtures


def import_super_lig() -> list[dict]:
    row_pattern = re.compile(
        r'<tr class="haftaninMaclariTr">.*?lblTarih">(?P<date>[^<]*)</span>'
        r'.*?lblSaat"[^>]*>(?P<time>[^<]*)</span>'
        r'.*?Label4">(?P<home>[^<]+)</span>.*?macId=(?P<id>\d+)'
        r'.*?Label1">(?P<away>[^<]+)</span>',
        re.S,
    )
    fixtures: list[dict] = []
    seen: set[str] = set()
    for week in range(1, 35):
        url = TFF_URL.format(week=week)
        raw = fetch(url)
        page = raw.decode("windows-1254", errors="replace")
        for match in row_pattern.finditer(page):
            match_id = match.group("id")
            if match_id in seen:
                continue
            seen.add(match_id)
            home_source = html.unescape(match.group("home")).strip()
            away_source = html.unescape(match.group("away")).strip()
            if home_source not in TEAM_MAP_TFF or away_source not in TEAM_MAP_TFF:
                raise RuntimeError(f"TFF takım eşlemesi eksik: {home_source} / {away_source}")
            date_value = datetime.strptime(match.group("date").strip(), "%d.%m.%Y")
            time_text = match.group("time").strip()
            kickoff = date_value.replace(
                hour=int(time_text[:2]) if time_text else 12,
                minute=int(time_text[3:]) if time_text else 0,
                tzinfo=ZoneInfo("Europe/Istanbul"),
            )
            fixtures.append({
                "external_id": f"official-TSL-{match_id}",
                "competition_code": "TSL",
                "season": "2026-2027",
                "stage": f"Süper Lig 2026/27 - Hafta {week}",
                "kickoff_utc": iso_utc(kickoff),
                "home_team": TEAM_MAP_TFF[home_source],
                "away_team": TEAM_MAP_TFF[away_source],
                "status": "TIMED" if time_text else "TBC",
                "home_goals": None,
                "away_goals": None,
                "source_name": "TFF",
                "source_url": f"https://www.tff.org/Default.aspx?pageId=29&macId={match_id}",
                "source_checked_at": CHECKED_AT,
            })
        time.sleep(0.05)
    return fixtures


def main() -> None:
    fixtures = import_premier_league() + import_laliga() + import_super_lig()
    counts = defaultdict(int)
    for fixture in fixtures:
        counts[fixture["competition_code"]] += 1
    expected = {"PL": 380, "LL": 380, "TSL": 306}
    if dict(counts) != expected:
        raise RuntimeError(f"Eksik fikstür: beklenen={expected}, bulunan={dict(counts)}")
    fixtures.sort(key=lambda item: (item["kickoff_utc"], item["competition_code"], item["home_team"]))
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps({"fixtures": fixtures}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "counts": dict(counts), "total": len(fixtures), "output": str(OUTPUT)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
