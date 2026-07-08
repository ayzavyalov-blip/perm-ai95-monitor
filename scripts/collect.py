from __future__ import annotations

import hashlib
import json
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

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 "
    "PermAI95Monitor/0.4"
)

REQUEST_TIMEOUT = 25


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
class Observation:
    station_name: str
    address: str | None
    fuel: str
    availability_status: str
    limit_text: str | None
    queue_text: str | None
    observed_at_text: str | None
    source: str
    source_url: str
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


def generic_ai95_extract(source: str, url: str, html: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    observations: list[dict[str, Any]] = []

    selectors = ["table tr", "li", "article", "section", "div"]
    seen: set[str] = set()

    for selector in selectors:
        for node in soup.select(selector):
            text = clean(node.get_text(" "))
            if len(text) < 20 or len(text) > 1500:
                continue
            if not row_mentions_ai95(text):
                continue

            key = text_hash(text)
            if key in seen:
                continue
            seen.add(key)

            address = None
            address_match = re.search(
                r"((ул\.|улица|шоссе|проспект|пр-т|тракт|дорога|бульвар|переулок)[^,;\"']{3,100})",
                text,
                flags=re.I,
            )
            if address_match:
                address = clean(address_match.group(1))

            station = "АЗС"
            brand_match = re.search(
                r"(ЛУКОЙЛ|Газпромнефть|Газпром|Нефтехимпром|Экойл|Ликом|Teboil|Роснефть|Get Petrol|Башнефть)",
                text,
                re.I,
            )
            if brand_match:
                station = brand_match.group(1)

            queue_text = None
            queue_match = re.search(r"очеред[ьи][^.;,]{0,80}", text, re.I)
            if queue_match:
                queue_text = clean(queue_match.group(0))

            limit_text = None
            limit_match = re.search(r"лимит[^.;,]{0,80}|\d{1,3}\s*л\b", text, re.I)
            if limit_match:
                limit_text = clean(limit_match.group(0))

            observed_at_text = None
            time_match = re.search(r"(\d{1,2}\s*(мин|час)[а-я]*\s*назад|только что|сегодня[^.;,]{0,30})", text, re.I)
            if time_match:
                observed_at_text = clean(time_match.group(0))

            observations.append(
                asdict(
                    Observation(
                        station_name=station,
                        address=address,
                        fuel=FUEL,
                        availability_status="unknown",
                        limit_text=limit_text,
                        queue_text=queue_text,
                        observed_at_text=observed_at_text,
                        source=source,
                        source_url=url,
                        confidence=0.25 if observed_at_text else 0.15,
                        note="Найдено упоминание АИ-95 в HTML. Это слабый сигнал, нужна проверка свежести и конкретной АЗС.",
                    )
                )
            )

            if len(observations) >= 30:
                return observations

    return observations


def parse_gdebenz() -> SourceResult:
    # Старый URL /fuel/ai-95/perm заменён на публичные страницы, которые видны в поиске:
    # /perm и /fuel/ai-95. Это исправляет ошибку маршрута, но не гарантирует решение DNS-сбоя GitHub Actions.
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

        observations = generic_ai95_extract("gdebenz", url, html)

        counts = []
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
                counts.append(match.group(0))

        if observations:
            return SourceResult(
                source="gdebenz",
                url=url,
                role="availability",
                ok=True,
                status="parsed_partial",
                checked_at=checked_at,
                http_status=http_status,
                message=(
                    "Источник доступен, найдены частичные упоминания АИ-95. "
                    "Для рекомендации нужна ручная проверка конкретной точки на карте."
                    + (" Общий сигнал: " + "; ".join(counts) if counts else "")
                ),
                observations=observations,
                raw_hash=text_hash(text[:200000]),
            )

        return SourceResult(
            source="gdebenz",
            url=url,
            role="availability",
            ok=True,
            status="map_dynamic_no_station_rows",
            checked_at=checked_at,
            http_status=http_status,
            message=(
                "Источник доступен, но конкретные АЗС не извлечены из HTML. "
                "Вероятно, данные карты подгружаются динамически. "
                "Нужен визуальный скрин или отдельный парсер динамических данных."
                + (" Общий сигнал: " + "; ".join(counts) if counts else "")
            ),
            observations=[],
            raw_hash=text_hash(text[:200000]),
        )

    return SourceResult(
        source="gdebenz",
        url=urls[0],
        role="availability",
        ok=False,
        status="source_unavailable",
        checked_at=checked_at,
        http_status=None,
        message=(
            "Не удалось открыть gdebenz. Workflow сначала пробует обычный DNS, затем публичные DNS и /etc/hosts. "
            "Если ошибка остаётся, причина не в вашем локальном VPN, а в доступности домена из GitHub Actions. "
            "Ошибки: " + " | ".join(errors[-6:])
        ),
    )


def external_source(name: str, url: str, role: str, message: str) -> SourceResult:
    return SourceResult(
        source=name,
        url=url,
        role=role,
        ok=False,
        status="manual_or_app_required",
        checked_at=now_iso(),
        message=message,
    )


def compute_recommendations(source_results: list[SourceResult]) -> list[dict[str, Any]]:
    # Рекомендации оставляем только по фактическим наблюдениям gdebenz.
    # Т-Банк, Яндекс/2ГИС здесь не дают машинного подтверждения наличия.
    observations: list[dict[str, Any]] = []
    for src in source_results:
        if src.source == "gdebenz":
            observations.extend(src.observations)

    if not observations:
        return []

    rows = []
    for obs in observations:
        rows.append(
            {
                "station_name": obs.get("station_name"),
                "address": obs.get("address"),
                "fuel": FUEL,
                "status": obs.get("availability_status", "unknown"),
                "confidence": obs.get("confidence", 0),
                "sources": [obs.get("source")],
                "action": "Не ехать без свежего подтверждения на карте или звонка.",
                "notes": [obs.get("note")],
            }
        )

    rows.sort(key=lambda item: float(item.get("confidence") or 0), reverse=True)
    return rows[:20]


def main() -> int:
    OUT_DIR.mkdir(exist_ok=True)
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)

    source_results = [
        parse_gdebenz(),
        external_source(
            "tbank_fuel",
            "https://toplivo.tbank.ru/",
            "availability_payment",
            "Т-Банк Топливо оставлен как ручной источник наличия и оплаты. Для автоматической проверки нужен доступ к приложению, скрин или разрешённый API.",
        ),
        external_source(
            "yandex_maps_traffic",
            "https://yandex.ru/maps/50/perm/probki/",
            "traffic",
            "Яндекс Карты используются только для пробок и возможной очереди у въезда на АЗС. Скриншот сохраняется в screenshots/yandex-traffic.png.",
        ),
        external_source(
            "2gis_traffic",
            "https://2gis.ru/perm?traffic",
            "traffic",
            "2ГИС используется только для пробок, маршрута, карточек и телефонов АЗС. Скриншот сохраняется в screenshots/2gis-traffic.png.",
        ),
    ]

    generated_at = now_iso()

    payload = {
        "schema_version": "0.4",
        "city": CITY,
        "fuel": FUEL,
        "generated_at": generated_at,
        "interpretation_rules": {
            "price_sources_removed": True,
            "price_is_not_used": True,
            "traffic_is_auxiliary_signal_only": True,
            "freshness_threshold_minutes": {
                "strong": 20,
                "medium": 60,
                "stale": 180,
            },
        },
        "traffic_screenshots": {
            "mode": "playwright_screenshot",
            "yandex_maps": {
                "url": "https://yandex.ru/maps/50/perm/probki/",
                "screenshot_path": "screenshots/yandex-traffic.png",
                "status_path": "screenshots/traffic-status.json",
            },
            "2gis": {
                "url": "https://2gis.ru/perm?traffic",
                "screenshot_path": "screenshots/2gis-traffic.png",
                "status_path": "screenshots/traffic-status.json",
            },
            "note": "Скриншоты пробок являются визуальным вспомогательным слоем. Они не подтверждают наличие АИ-95.",
        },
        "source_results": [asdict(src) for src in source_results],
        "recommendations": compute_recommendations(source_results),
        "operator_message": (
            "Оставлены только 4 источника: gdebenz, tbank_fuel, yandex_maps_traffic, 2gis_traffic. "
            "Ценовые источники удалены. Если gdebenz недоступен из GitHub Actions, проверьте шаг DNS diagnostics и Try to fix gdebenz DNS. "
            "Локальный VPN пользователя не влияет на GitHub Actions runner."
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
