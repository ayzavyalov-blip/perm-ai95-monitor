from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, asdict, field
from datetime import datetime, timezone, timedelta
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
    "PermAI95Monitor/0.7"
)

REQUEST_TIMEOUT = 25
TBANK_FRESH_HOURS = 6


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
    address: str | None
    fuel: str
    source: str
    source_url: str
    signal_type: str
    status: str
    observed_at: str | None
    amount_rub: float | None
    confidence: float
    note: str


def now_dt() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    return now_dt().isoformat()


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="ignore")).hexdigest()[:16]


def clean(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", value).strip()


def normalize(value: str | None) -> str:
    text = clean(value).lower().replace("ё", "е")
    text = re.sub(r"[^a-zа-я0-9]+", " ", text)
    stop = {"азс", "пермь", "г", "город", "ул", "улица", "проспект", "пр", "шоссе", "дорога", "трасса"}
    words = [w for w in text.split() if w not in stop]
    return " ".join(words)


def parse_dt(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        text = str(value).strip()
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        d = datetime.fromisoformat(text)
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d.astimezone(timezone.utc)
    except Exception:
        return None


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

        brand = None
        brand_match = re.search(
            r"(ЛУКОЙЛ|Газпромнефть|Газпром|Нефтехимпром|Экойл|Ликом|Teboil|Роснефть|Get Petrol|Башнефть)",
            text,
            re.I,
        )
        if brand_match:
            brand = brand_match.group(1)

        address = None
        address_match = re.search(
            r"((ул\.|улица|шоссе|проспект|пр-т|тракт|дорога|бульвар|переулок)[^,;\"']{3,120})",
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

        if not any([brand, address, observed_at_text, queue_text, limit_text]):
            continue

        station_name = brand or "АЗС"
        key = text_hash((station_name or "") + "|" + (address or "") + "|" + text[:260])
        if key in seen:
            continue
        seen.add(key)

        confidence = 0.25
        if address:
            confidence += 0.10
        if observed_at_text:
            confidence += 0.10
        if queue_text or limit_text:
            confidence += 0.05
        confidence = min(confidence, 0.50)

        signals.append(
            asdict(
                StationSignal(
                    station_name=station_name,
                    address=address,
                    fuel=FUEL,
                    source=source,
                    source_url=url,
                    signal_type="people_availability_report",
                    status="unknown",
                    observed_at=None,
                    amount_rub=None,
                    confidence=confidence,
                    note="gdebenz: найдено частичное станционное упоминание АИ-95. Нужна проверка свежести и конкретной точки.",
                )
            )
        )

        if len(signals) >= 20:
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
                    "Далее они сопоставляются с публичной картой Т-Банка."
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
    cutoff = now_dt() - timedelta(hours=TBANK_FRESH_HOURS)

    for item in raw:
        if not isinstance(item, dict):
            continue

        station_name = clean(item.get("station_name")) or "АЗС"
        address = clean(item.get("address")) or None
        observed_at = parse_dt(item.get("observed_at") or item.get("last_transaction_at") or item.get("updated_at"))
        fuel = clean(item.get("fuel")) or FUEL
        status = clean(item.get("status")) or "tbank_public_signal"

        is_fresh = observed_at is not None and observed_at >= cutoff

        confidence = float(item.get("confidence") or 0.35)
        if is_fresh:
            confidence += 0.15
        if address:
            confidence += 0.10
        if row_mentions_ai95(fuel):
            confidence += 0.10
        confidence = min(confidence, 0.85)

        observations.append(
            asdict(
                StationSignal(
                    station_name=station_name,
                    address=address,
                    fuel=fuel,
                    source="tbank_fuel",
                    source_url="https://toplivo.tbank.ru/",
                    signal_type="tbank_public_transaction_forecast",
                    status=status,
                    observed_at=observed_at.isoformat() if observed_at else None,
                    amount_rub=None,
                    confidence=confidence,
                    note=item.get("note") or "Т-Банк: публичный сигнал наличия/активности на основе карты. Это сильнее цены, но всё равно требует сверки с конкретной АЗС.",
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


def match_score(a: dict[str, Any], b: dict[str, Any]) -> float:
    a_name = normalize(a.get("station_name"))
    a_addr = normalize(a.get("address"))
    b_name = normalize(b.get("station_name"))
    b_addr = normalize(b.get("address"))

    score = 0.0

    if a_addr and b_addr:
        a_words = set(a_addr.split())
        b_words = set(b_addr.split())
        if a_words and b_words:
            overlap = len(a_words & b_words) / max(len(a_words | b_words), 1)
            score += overlap * 0.70

    if a_name and b_name:
        a_words = set(a_name.split())
        b_words = set(b_name.split())
        if a_words & b_words:
            score += 0.30

    if a_addr and b_addr and (a_addr in b_addr or b_addr in a_addr):
        score += 0.25

    return min(score, 1.0)


def build_candidates(gdebenz_result: SourceResult, tbank_result: SourceResult) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    gdebenz_rows = gdebenz_result.observations or []
    tbank_rows = tbank_result.observations or []

    for g in gdebenz_rows:
        best_t = None
        best_score = 0.0

        for t in tbank_rows:
            s = match_score(g, t)
            if s > best_score:
                best_score = s
                best_t = t

        if best_t and best_score >= 0.25:
            confidence = min(
                0.95,
                0.25 + float(g.get("confidence") or 0) * 0.45 + float(best_t.get("confidence") or 0) * 0.45 + best_score * 0.20,
            )

            station_name = g.get("station_name") if g.get("station_name") != "АЗС" else best_t.get("station_name")
            address = g.get("address") or best_t.get("address")
            label = " / ".join([v for v in [station_name, address] if v])
            station_id = text_hash(label or json.dumps(g, ensure_ascii=False))

            candidates.append(
                {
                    "station_id": station_id,
                    "station_name": station_name or "АЗС",
                    "address": address,
                    "fuel": FUEL,
                    "status": "candidate_needs_final_check",
                    "confidence": round(confidence, 3),
                    "match_score": round(best_score, 3),
                    "gdebenz_signal": g,
                    "tbank_signal": best_t,
                    "sources": ["gdebenz", "tbank_fuel"],
                    "action": "Проверить карту/пробку и, если сигнал старше 60 минут, позвонить перед выездом.",
                    "map_query": f"{station_name or ''} {address or ''} Пермь АЗС".strip(),
                    "note": "Кандидат появился потому, что есть сигнал людей на gdebenz и публичный сигнал Т-Банка.",
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


def main() -> int:
    OUT_DIR.mkdir(exist_ok=True)
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)

    gdebenz_result = parse_gdebenz()
    tbank_result = load_tbank_public()
    candidates = build_candidates(gdebenz_result, tbank_result)

    source_results = [
        gdebenz_result,
        tbank_result,
        external_source(
            "yandex_maps_traffic",
            "https://yandex.ru/maps/50/perm/probki/",
            "traffic",
            "Яндекс Карты используются после отбора АЗС: по каждой кандидатной АЗС создаётся отдельный скриншот пробок.",
        ),
        external_source(
            "2gis_traffic",
            "https://2gis.ru/perm?traffic",
            "traffic",
            "2ГИС используется после отбора АЗС: по каждой кандидатной АЗС создаётся отдельный скриншот пробок/карточки.",
        ),
    ]

    traffic_targets = []
    for c in candidates:
        traffic_targets.append(
            {
                "station_id": c["station_id"],
                "label": " / ".join([v for v in [c.get("station_name"), c.get("address")] if v]) or c["station_id"],
                "query": c.get("map_query") or c.get("station_name") or "АЗС АИ-95 Пермь",
                "confidence": c.get("confidence"),
                "sources": c.get("sources"),
            }
        )

    if not traffic_targets:
        traffic_targets = [{
            "station_id": "perm-general",
            "label": "Пермь: общий обзор АЗС АИ-95",
            "query": "АЗС АИ-95 Пермь",
            "confidence": None,
            "sources": []
        }]

    generated_at = now_iso()

    payload = {
        "schema_version": "0.7",
        "city": CITY,
        "fuel": FUEL,
        "generated_at": generated_at,
        "pipeline": [
            "1. gdebenz: народные отметки о наличии АИ-95",
            "2. tbank_fuel: публичная карта Т-Банка на основе транзакционных сигналов",
            "3. yandex_maps_traffic / 2gis_traffic: карта и пробки только по отобранным АЗС",
        ],
        "interpretation_rules": {
            "price_sources_removed": True,
            "price_is_not_used": True,
            "tbank_public_signal_is_transaction_based_availability_forecast": True,
            "traffic_is_auxiliary_signal_only": True,
            "do_not_recommend_without_gdebenz_and_tbank_match": True,
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
            "note": "Скриншоты создаются только по отобранным АЗС. Если кандидатов нет, создаётся общий диагностический скрин Перми.",
        },
        "operator_message": (
            "Логика обновлена: gdebenz -> публичная карта Т-Банка -> карты/пробки по отобранным АЗС. "
            "Авторизация и отдельный API для Т-Банка не используются: сбор идёт через открытую страницу toplivo.tbank.ru."
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
