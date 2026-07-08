from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry


CITY = "Пермь"
FUEL = "АИ-95"

OUT_DIR = Path("data")
HISTORY_DIR = OUT_DIR / "history"
TBANK_PUBLIC_PATH = OUT_DIR / "tbank_observations.json"
TBANK_PUBLIC_STATUS_PATH = OUT_DIR / "tbank_public_status.json"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 "
    "PermAI95Monitor/0.8"
)

REQUEST_TIMEOUT = 25
MIN_MATCH_SCORE = 0.45


@dataclass
class SourceResult:
    source: str
    url: str
    role: str
    ok: bool
    status: str
    checked_at: str
    http_status: Optional[int] = None
    message: str = ""
    observations: list[dict[str, Any]] = field(default_factory=list)
    raw_hash: Optional[str] = None


@dataclass
class StationSignal:
    station_name: str
    network: str | None
    address: str | None
    house: str | None
    lat: float | None
    lon: float | None
    address_quality: str
    is_precise: bool
    fuel: str
    source: str
    source_url: str
    signal_type: str
    status: str
    observed_at: str | None
    amount_rub: float | None
    confidence: float
    note: str


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()[:16]


def clean(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", value).strip()


def normalize(value: str | None) -> str:
    text = clean(value).lower().replace("ё", "е")
    text = re.sub(r"[^a-zа-я0-9]+", " ", text)
    stop = {"азс", "пермь", "г", "город", "ул", "улица", "проспект", "пр", "шоссе", "дорога", "трасса", "дом"}
    words = [w for w in text.split() if w not in stop]
    return " ".join(words)


def find_house(value: str | None) -> str | None:
    m = re.search(r"\b(\d{1,4}[а-яa-z]?([\/-]\d{1,4}[а-яa-z]?)?)\b", value or "", flags=re.I)
    return clean(m.group(1)) if m else None


def has_house(value: str | None) -> bool:
    return find_house(value) is not None


def valid_coord(lat: Any, lon: Any) -> bool:
    try:
        lat_f = float(lat)
        lon_f = float(lon)
    except Exception:
        return False
    return 57.4 < lat_f < 58.6 and 55.3 < lon_f < 57.2


def address_quality(address: str | None, lat: Any = None, lon: Any = None) -> tuple[str, bool]:
    if valid_coord(lat, lon):
        return "coordinate", True
    if address and has_house(address):
        return "house", True
    if address:
        return "street_only", False
    return "unknown", False


def brand_from_text(value: str | None) -> str | None:
    m = re.search(
        r"(ЛУКОЙЛ|Лукойл|Газпромнефть|Газпром|Нефтехимпром|Экойл|Ликом|Teboil|Роснефть|Get Petrol|Башнефть|Татнефть)",
        value or "",
        flags=re.I,
    )
    if not m:
        return None
    raw = clean(m.group(1))
    if re.search("лукойл", raw, flags=re.I):
        return "ЛУКОЙЛ"
    return raw


def make_session() -> requests.Session:
    retry = Retry(
        total=3,
        connect=3,
        read=2,
        backoff_factor=1.2,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=("GET", "HEAD"),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session = requests.Session()
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.7",
            "Cache-Control": "no-cache",
        }
    )
    return session


SESSION = make_session()


def fetch(url: str) -> tuple[int | None, str, str | None]:
    try:
        response = SESSION.get(url, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        return response.status_code, response.text, None
    except requests.RequestException as exc:
        return None, "", repr(exc)


def row_mentions_ai95(text: str) -> bool:
    return bool(re.search(r"(АИ\s*[-]?\s*95|AI\s*[-]?\s*95|бензин\s*95|95\s*бензин)", text, re.I))


def extract_station_signals_from_gdebenz(source: str, url: str, html: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    signals: list[dict[str, Any]] = []
    seen: set[str] = set()

    for node in soup.select("table tr, li, article, section, div"):
        text = clean(node.get_text(" "))
        if len(text) < 30 or len(text) > 1600:
            continue
        if not row_mentions_ai95(text):
            continue

        network = brand_from_text(text)

        address = None
        address_match = re.search(
            r"((ул\.|улица|шоссе|проспект|пр-т|тракт|дорога|бульвар|переулок|посёлок|поселок|микрорайон)[^,;\"']{3,140})",
            text,
            flags=re.I,
        )
        if address_match:
            address = clean(address_match.group(1))

        queue_text = None
        queue_match = re.search(r"очеред[ьи][^.;,]{0,100}", text, re.I)
        if queue_match:
            queue_text = clean(queue_match.group(0))

        limit_text = None
        limit_match = re.search(r"лимит[^.;,]{0,100}|\d{1,3}\s*л\b", text, re.I)
        if limit_match:
            limit_text = clean(limit_match.group(0))

        observed_at_text = None
        time_match = re.search(r"(\d{1,2}\s*(мин|час)[а-я]*\s*назад|только что|сегодня[^.;,]{0,40})", text, re.I)
        if time_match:
            observed_at_text = clean(time_match.group(0))

        if not any([network, address, observed_at_text, queue_text, limit_text]):
            continue

        q, precise = address_quality(address)
        station_name = network or "АЗС"
        key = text_hash((station_name or "") + "|" + (address or "") + "|" + text[:260])
        if key in seen:
            continue
        seen.add(key)

        confidence = 0.25
        if network:
            confidence += 0.10
        if address:
            confidence += 0.10
        if precise:
            confidence += 0.10
        if observed_at_text:
            confidence += 0.10
        if queue_text or limit_text:
            confidence += 0.05
        confidence = min(confidence, 0.60)

        signals.append(
            asdict(
                StationSignal(
                    station_name=station_name,
                    network=network,
                    address=address,
                    house=find_house(address),
                    lat=None,
                    lon=None,
                    address_quality=q,
                    is_precise=precise,
                    fuel=FUEL,
                    source=source,
                    source_url=url,
                    signal_type="people_availability_report",
                    status="unknown",
                    observed_at=None,
                    amount_rub=None,
                    confidence=confidence,
                    note="gdebenz: частичное станционное упоминание АИ-95.",
                )
            )
        )

        if len(signals) >= 30:
            break

    return signals


def extract_general_signals(text: str) -> list[str]:
    signals = []
    for pattern in [
        r"(\d+)\s+АЗС\s+на\s+карте",
        r"(\d+)\s+АЗС\s+со\s+свежими\s+отметками",
        r"(\d+)\s+заправок\s+в\s+Перми",
        r"(\d+)\s+со\s+свежими\s+отметками",
        r"АИ\s*[-]?\s*95",
        r"AI\s*[-]?\s*95",
    ]:
        match = re.search(pattern, text, flags=re.I)
        if match:
            value = match.group(0)
            if value not in signals:
                signals.append(value)
    return signals[:8]


def parse_gdebenz() -> SourceResult:
    urls = [
        "https://gdebenz.ru/perm",
        "https://gdebenz.ru/fuel/ai-95",
        "https://gdebenz.ru/",
        "https://www.gdebenz.ru/perm",
        "https://www.gdebenz.ru/fuel/ai-95",
        "https://www.gdebenz.ru/",
    ]

    checked_at = now_iso()
    errors: list[str] = []

    for url in urls:
        http_status, html, error = fetch(url)

        if error:
            errors.append(f"{url}: {error}")
            continue

        soup = BeautifulSoup(html, "html.parser")
        text = clean(soup.get_text(" "))
        observations = extract_station_signals_from_gdebenz("gdebenz", url, html)
        signals = extract_general_signals(text)

        if observations:
            return SourceResult(
                source="gdebenz",
                url=url,
                role="people_availability",
                ok=True,
                status="parsed_partial",
                checked_at=checked_at,
                http_status=http_status,
                message=(
                    "Источник доступен, найдены частичные станционные упоминания АИ-95. "
                    "Кандидаты допускаются только при точном совпадении с Т-Банком."
                    + (" Общий сигнал: " + "; ".join(signals) if signals else "")
                ),
                observations=observations,
                raw_hash=text_hash(text[:200000]),
            )

        return SourceResult(
            source="gdebenz",
            url=url,
            role="people_availability",
            ok=True,
            status="map_dynamic_no_station_rows",
            checked_at=checked_at,
            http_status=http_status,
            message=(
                "Источник доступен, но конкретные АЗС не извлечены из HTML. "
                "Вероятно, данные карты подгружаются динамически."
                + (" Общий сигнал: " + "; ".join(signals) if signals else "")
            ),
            observations=[],
            raw_hash=text_hash(text[:200000]),
        )

    short_errors = " | ".join(errors[-3:])
    if len(short_errors) > 700:
        short_errors = short_errors[:700] + "..."

    return SourceResult(
        source="gdebenz",
        url=urls[0],
        role="people_availability",
        ok=False,
        status="source_unavailable",
        checked_at=checked_at,
        http_status=None,
        message="Не удалось открыть gdebenz из GitHub Actions. Кратко: " + short_errors,
    )


def load_tbank_public() -> SourceResult:
    checked_at = now_iso()
    status_payload: dict[str, Any] = {}

    if TBANK_PUBLIC_STATUS_PATH.exists():
        try:
            status_payload = json.loads(TBANK_PUBLIC_STATUS_PATH.read_text(encoding="utf-8"))
        except Exception:
            status_payload = {}

    if not TBANK_PUBLIC_PATH.exists():
        return SourceResult(
            source="tbank_fuel",
            url="https://toplivo.tbank.ru/",
            role="transaction_availability_forecast",
            ok=False,
            status="public_site_not_collected",
            checked_at=checked_at,
            message="Публичная страница Т-Банка не была собрана. Проверьте шаг Collect TBank public fuel signals.",
            observations=[],
        )

    try:
        raw = json.loads(TBANK_PUBLIC_PATH.read_text(encoding="utf-8"))
        if not isinstance(raw, list):
            raise ValueError("Root JSON must be an array")
    except Exception as exc:
        return SourceResult(
            source="tbank_fuel",
            url="https://toplivo.tbank.ru/",
            role="transaction_availability_forecast",
            ok=False,
            status="public_site_parse_error",
            checked_at=checked_at,
            message=f"Не удалось прочитать data/tbank_observations.json: {exc}",
            observations=[],
        )

    observations: list[dict[str, Any]] = []

    for item in raw:
        if not isinstance(item, dict):
            continue

        address = clean(item.get("address")) or None
        lat = item.get("lat")
        lon = item.get("lon")
        q, precise = address_quality(address, lat, lon)

        network = clean(item.get("network")) or brand_from_text(item.get("station_name")) or brand_from_text(address) or None
        station_name = clean(item.get("station_name")) or network or "АЗС"
        fuel = clean(item.get("fuel")) or FUEL

        try:
            confidence = float(item.get("confidence") or 0.40)
        except Exception:
            confidence = 0.40

        if network:
            confidence += 0.05
        if row_mentions_ai95(fuel):
            confidence += 0.10
        if q == "coordinate":
            confidence += 0.20
        elif q == "house":
            confidence += 0.15
        elif q == "street_only":
            confidence += 0.03

        confidence = min(confidence, 0.90)

        observations.append(
            asdict(
                StationSignal(
                    station_name=station_name,
                    network=network,
                    address=address,
                    house=clean(item.get("house")) or find_house(address),
                    lat=float(lat) if valid_coord(lat, lon) else None,
                    lon=float(lon) if valid_coord(lat, lon) else None,
                    address_quality=q,
                    is_precise=precise,
                    fuel=fuel,
                    source="tbank_fuel",
                    source_url="https://toplivo.tbank.ru/",
                    signal_type="tbank_public_transaction_forecast",
                    status=clean(item.get("status")) or "tbank_public_signal",
                    observed_at=clean(item.get("observed_at")) or None,
                    amount_rub=None,
                    confidence=confidence,
                    note=item.get("note") or "Т-Банк: публичный транзакционный сигнал наличия/активности.",
                )
            )
        )

    status = "parsed_public_site" if observations else "no_public_station_rows"
    message = status_payload.get("message") or f"Собрано публичных сигналов Т-Банка: {len(observations)}."

    return SourceResult(
        source="tbank_fuel",
        url="https://toplivo.tbank.ru/",
        role="transaction_availability_forecast",
        ok=bool(observations),
        status=status,
        checked_at=checked_at,
        message=message,
        observations=observations,
        raw_hash=text_hash(json.dumps(raw, ensure_ascii=False)[:200000]),
    )


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371000
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def token_overlap(a: str, b: str) -> float:
    aw = set(normalize(a).split())
    bw = set(normalize(b).split())
    if not aw or not bw:
        return 0.0
    return len(aw & bw) / max(len(aw | bw), 1)


def match_score(g: dict[str, Any], t: dict[str, Any]) -> tuple[float, list[str]]:
    reasons: list[str] = []
    score = 0.0

    g_network = normalize(g.get("network") or g.get("station_name"))
    t_network = normalize(t.get("network") or t.get("station_name"))

    if g_network and t_network:
        overlap = token_overlap(g_network, t_network)
        if overlap > 0:
            score += 0.25
            reasons.append("сеть совпала")

    g_addr = g.get("address") or ""
    t_addr = t.get("address") or ""
    addr_overlap = token_overlap(g_addr, t_addr)

    if addr_overlap:
        score += addr_overlap * 0.35
        reasons.append(f"адресное совпадение {round(addr_overlap * 100)}%")

    g_house = g.get("house") or find_house(g_addr)
    t_house = t.get("house") or find_house(t_addr)

    if g_house and t_house and normalize(g_house) == normalize(t_house):
        score += 0.20
        reasons.append("номер дома совпал")
    elif g_house or t_house:
        score -= 0.05

    if valid_coord(g.get("lat"), g.get("lon")) and valid_coord(t.get("lat"), t.get("lon")):
        dist = haversine_m(float(g["lat"]), float(g["lon"]), float(t["lat"]), float(t["lon"]))
        if dist <= 120:
            score += 0.40
            reasons.append(f"координаты близко: {round(dist)} м")
        elif dist <= 350:
            score += 0.20
            reasons.append(f"координаты рядом: {round(dist)} м")
        else:
            score -= 0.25
            reasons.append(f"координаты далеко: {round(dist)} м")

    return max(0.0, min(score, 1.0)), reasons


def candidate_precision(g: dict[str, Any], t: dict[str, Any]) -> tuple[str, bool]:
    if valid_coord(t.get("lat"), t.get("lon")):
        return "coordinate", True
    if valid_coord(g.get("lat"), g.get("lon")):
        return "coordinate", True
    address = t.get("address") or g.get("address")
    return address_quality(address)


def build_candidates(gdebenz_result: SourceResult, tbank_result: SourceResult) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    gdebenz_rows = gdebenz_result.observations or []
    tbank_rows = tbank_result.observations or []

    for g in gdebenz_rows:
        best_t = None
        best_score = 0.0
        best_reasons: list[str] = []

        for t in tbank_rows:
            s, reasons = match_score(g, t)
            if s > best_score:
                best_score = s
                best_t = t
                best_reasons = reasons

        if not best_t:
            continue

        precision, map_ready = candidate_precision(g, best_t)

        # Важное: street_only больше не является достаточным основанием для рекомендации.
        if best_score < MIN_MATCH_SCORE or not map_ready:
            continue

        network = best_t.get("network") or g.get("network") or best_t.get("station_name") or g.get("station_name")
        station_name = network or "АЗС"
        address = best_t.get("address") or g.get("address")

        lat = best_t.get("lat") if valid_coord(best_t.get("lat"), best_t.get("lon")) else g.get("lat")
        lon = best_t.get("lon") if valid_coord(best_t.get("lat"), best_t.get("lon")) else g.get("lon")

        label_parts = [station_name]
        if address:
            label_parts.append(address)
        label = " / ".join(label_parts)
        station_id = text_hash(label + "|" + str(lat) + "|" + str(lon))

        confidence = min(
            0.95,
            0.20 + float(g.get("confidence") or 0) * 0.35 + float(best_t.get("confidence") or 0) * 0.35 + best_score * 0.30,
        )

        query_parts = [station_name, address, "Пермь", "АЗС"]
        map_query = " ".join([clean(x) for x in query_parts if clean(x)])

        candidates.append(
            {
                "station_id": station_id,
                "station_name": station_name,
                "network": network,
                "address": address,
                "house": best_t.get("house") or g.get("house") or find_house(address),
                "lat": lat,
                "lon": lon,
                "address_quality": precision,
                "map_ready": map_ready,
                "fuel": FUEL,
                "status": "candidate_needs_final_check",
                "confidence": round(confidence, 3),
                "match_score": round(best_score, 3),
                "match_reasons": best_reasons,
                "gdebenz_signal": g,
                "tbank_signal": best_t,
                "sources": ["gdebenz", "tbank_fuel"],
                "action": "Проверить карту/пробку у въезда. Если сигнал старше 60 минут или адрес не совпадает, позвонить перед выездом.",
                "map_query": map_query,
                "note": "Кандидат прошёл фильтр: сеть/адрес/координаты достаточно совпали в gdebenz и Т-Банке.",
            }
        )

    candidates.sort(key=lambda item: item.get("confidence", 0), reverse=True)
    return candidates[:10]


def external_source(name: str, url: str, role: str, message: str) -> SourceResult:
    return SourceResult(
        source=name,
        url=url,
        role=role,
        ok=False,
        status="map_after_selection",
        checked_at=now_iso(),
        message=message,
    )


def make_traffic_targets(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    targets = []
    for c in candidates:
        targets.append(
            {
                "station_id": c["station_id"],
                "label": " / ".join([v for v in [c.get("network") or c.get("station_name"), c.get("address")] if v]) or c["station_id"],
                "query": c.get("map_query") or c.get("station_name") or "АЗС АИ-95 Пермь",
                "lat": c.get("lat"),
                "lon": c.get("lon"),
                "address_quality": c.get("address_quality"),
                "map_ready": c.get("map_ready"),
                "confidence": c.get("confidence"),
                "sources": c.get("sources"),
            }
        )

    if not targets:
        targets = [{
            "station_id": "perm-general",
            "label": "Пермь: общий обзор АЗС АИ-95",
            "query": "АЗС АИ-95 Пермь",
            "lat": None,
            "lon": None,
            "address_quality": "diagnostic",
            "map_ready": False,
            "confidence": None,
            "sources": []
        }]

    return targets


def main() -> int:
    OUT_DIR.mkdir(exist_ok=True)
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)

    gdebenz_result = parse_gdebenz()
    tbank_result = load_tbank_public()
    candidates = build_candidates(gdebenz_result, tbank_result)
    traffic_targets = make_traffic_targets(candidates)

    source_results = [
        gdebenz_result,
        tbank_result,
        external_source(
            "yandex_maps_traffic",
            "https://yandex.ru/maps/50/perm/probki/",
            "traffic",
            "Яндекс Карты используются после отбора АЗС. В URL принудительно включается слой l=map,trf.",
        ),
        external_source(
            "2gis_traffic",
            "https://2gis.ru/perm?traffic",
            "traffic",
            "2ГИС используется после отбора АЗС. По возможности карта центрируется на координатах.",
        ),
    ]

    generated_at = now_iso()

    payload = {
        "schema_version": "0.8",
        "city": CITY,
        "fuel": FUEL,
        "generated_at": generated_at,
        "pipeline": [
            "1. gdebenz: народные отметки о наличии АИ-95",
            "2. tbank_fuel: публичная карта Т-Банка на основе транзакционных сигналов",
            "3. match: допускается только сеть + точный адрес/координаты; street_only не считается достаточным",
            "4. yandex_maps_traffic / 2gis_traffic: карта и пробки по отобранным АЗС",
        ],
        "interpretation_rules": {
            "price_sources_removed": True,
            "price_is_not_used": True,
            "tbank_public_signal_is_transaction_based_availability_forecast": True,
            "traffic_is_auxiliary_signal_only": True,
            "do_not_recommend_without_precise_address_or_coordinates": True,
            "minimum_match_score": MIN_MATCH_SCORE,
            "street_only_is_not_enough": True,
            "freshness_threshold_minutes": {
                "strong": 20,
                "medium": 60,
                "stale": 180,
            },
        },
        "source_results": [asdict(src) for src in source_results],
        "matched_candidates": candidates,
        "recommendations": candidates,
        "traffic_targets": traffic_targets,
        "traffic_screenshots": {
            "mode": "station_specific_playwright_screenshot",
            "status_path": "screenshots/traffic-status.json",
            "note": "Скриншоты создаются по точным кандидатам. Если точных кандидатов нет, создаётся общий диагностический скрин Перми.",
        },
        "operator_message": (
            "Логика уточнена: сеть и адрес обязательны. Кандидат с адресом только до улицы больше не должен считаться достаточным. "
            "Для карт используются координаты или полный адрес с домом; Яндекс открывается с l=map,trf."
        ),
    }

    latest_path = OUT_DIR / "latest.json"
    latest_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    history_path = HISTORY_DIR / f"{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    history_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Wrote {latest_path} and {history_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
