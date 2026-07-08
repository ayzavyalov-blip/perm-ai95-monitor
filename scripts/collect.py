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
    "PermAI95Monitor/0.2"
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
    price_rub: float | None
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
    s = requests.Session()
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    s.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ru-RU,ru;q=0.9,en;q=0.7",
            "Cache-Control": "no-cache",
        }
    )
    return s


SESSION = make_session()


def fetch(url: str) -> tuple[int | None, str, str | None]:
    try:
        r = SESSION.get(url, timeout=REQUEST_TIMEOUT, allow_redirects=True)
        return r.status_code, r.text, None
    except requests.RequestException as exc:
        return None, "", repr(exc)


def parse_price(value: str) -> float | None:
    if not value:
        return None
    text = value.replace("\xa0", " ")
    candidates = re.findall(r"(?<!\d)(\d{2,3}[,.]\d{1,2}|\d{2,3})(?!\d)", text)
    for c in candidates:
        try:
            v = float(c.replace(",", "."))
        except ValueError:
            continue
        if 30 <= v <= 200:
            return v
    return None


def clean(s: str | None) -> str:
    if not s:
        return ""
    return re.sub(r"\s+", " ", s).strip()


def row_mentions_ai95(text: str) -> bool:
    return bool(re.search(r"(АИ\s*[-]?\s*95|AI\s*[-]?\s*95|бензин\s*95|95\s*бензин)", text, re.I))


def generic_table_extract(source: str, url: str, html: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(html, "html.parser")
    observations: list[dict[str, Any]] = []

    # 1. Обычные таблицы.
    for table in soup.find_all("table"):
        for tr in table.find_all("tr"):
            cells = [clean(td.get_text(" ")) for td in tr.find_all(["td", "th"])]
            if len(cells) < 2:
                continue

            row_text = " | ".join(cells)
            if not row_mentions_ai95(row_text):
                continue

            price = parse_price(row_text)
            station = cells[0] if cells[0] else "АЗС"
            address = None
            for c in cells[1:]:
                if re.search(r"(ул\.|улица|шоссе|проспект|пр-т|тракт|дорога|Перм)", c, re.I):
                    address = c
                    break

            observations.append(
                asdict(
                    Observation(
                        station_name=station,
                        address=address,
                        fuel=FUEL,
                        availability_status="unknown",
                        price_rub=price,
                        limit_text=None,
                        queue_text=None,
                        observed_at_text=None,
                        source=source,
                        source_url=url,
                        confidence=0.25 if price else 0.15,
                        note="Найдена строка с АИ-95 в HTML-таблице. Цена не подтверждает наличие топлива.",
                    )
                )
            )

    # 2. Карточки без table, если сайт отдаёт div/li.
    if observations:
        return observations[:30]

    for node in soup.find_all(["li", "article", "section", "div"]):
        txt = clean(node.get_text(" "))
        if len(txt) < 40 or len(txt) > 1200:
            continue
        if not row_mentions_ai95(txt):
            continue

        price = parse_price(txt)
        address = None
        address_match = re.search(
            r"((ул\.|улица|шоссе|проспект|пр-т|тракт|дорога)[^,;\"']{3,90})",
            txt,
            flags=re.I,
        )
        if address_match:
            address = clean(address_match.group(1))

        station = "АЗС"
        brand_match = re.search(r"(ЛУКОЙЛ|Газпромнефть|Газпром|Нефтехимпром|Экойл|Ликом|Teboil|Роснефть|Get Petrol)", txt, re.I)
        if brand_match:
            station = brand_match.group(1)

        observations.append(
            asdict(
                Observation(
                    station_name=station,
                    address=address,
                    fuel=FUEL,
                    availability_status="unknown",
                    price_rub=price,
                    limit_text=None,
                    queue_text=None,
                    observed_at_text=None,
                    source=source,
                    source_url=url,
                    confidence=0.20 if price else 0.12,
                    note="Найдено упоминание АИ-95 в HTML-блоке. Это слабый сигнал, нужна проверка источника.",
                )
            )
        )

        if len(observations) >= 30:
            break

    return observations


def extract_json_like_ai95(source: str, url: str, html: str) -> list[dict[str, Any]]:
    observations: list[dict[str, Any]] = []

    text = html
    # Частичная нормализация unicode escape для кириллицы.
    try:
        text = bytes(text, "utf-8").decode("unicode_escape", errors="ignore")
    except Exception:
        pass

    seen = set()
    for m in re.finditer(r".{0,450}(АИ\s*[-]?\s*95|AI\s*[-]?\s*95|95).{0,450}", text, flags=re.I | re.S):
        chunk = clean(m.group(0))
        if len(chunk) < 30:
            continue

        key = text_hash(chunk)
        if key in seen:
            continue
        seen.add(key)

        price = parse_price(chunk)

        address = None
        address_match = re.search(
            r"((ул\.|улица|шоссе|проспект|пр-т|тракт|дорога)[^,;\"']{3,90})",
            chunk,
            flags=re.I,
        )
        if address_match:
            address = clean(address_match.group(1))

        brand = "АЗС из HTML/JSON-фрагмента"
        brand_match = re.search(r"(ЛУКОЙЛ|Газпромнефть|Газпром|Нефтехимпром|Экойл|Ликом|Teboil|Роснефть|Get Petrol)", chunk, re.I)
        if brand_match:
            brand = brand_match.group(1)

        observations.append(
            asdict(
                Observation(
                    station_name=brand,
                    address=address,
                    fuel=FUEL,
                    availability_status="unknown",
                    price_rub=price,
                    limit_text=None,
                    queue_text=None,
                    observed_at_text=None,
                    source=source,
                    source_url=url,
                    confidence=0.20 if price else 0.12,
                    note="Найдено упоминание АИ-95 в HTML/JSON-фрагменте. Это слабый сигнал, нужно уточнить структуру источника.",
                )
            )
        )

        if len(observations) >= 20:
            break

    return observations


def parse_gdebenz() -> SourceResult:
    urls = [
        "https://gdebenz.ru/fuel/ai-95/perm",
        "https://www.gdebenz.ru/fuel/ai-95/perm",
        "https://gdebenz.ru/",
        "https://www.gdebenz.ru/",
    ]

    checked_at = now_iso()
    errors = []

    for url in urls:
        http_status, html, error = fetch(url)

        if error:
            errors.append(f"{url}: {error}")
            continue

        soup = BeautifulSoup(html, "html.parser")
        text = clean(soup.get_text(" "))

        observations = generic_table_extract("gdebenz", url, html)
        if not observations:
            observations = extract_json_like_ai95("gdebenz", url, html)

        counts = []
        for pattern in [
            r"(\d+)\s+АЗС\s+на\s+карте",
            r"(\d+)\s+АЗС\s+со\s+свежими\s+отметками",
            r"(\d+)\s+свеж",
            r"АИ\s*[-]?\s*95",
            r"AI\s*[-]?\s*95",
        ]:
            m = re.search(pattern, text, flags=re.I)
            if m:
                counts.append(m.group(0))

        if observations:
            return SourceResult(
                source="gdebenz",
                url=url,
                role="availability",
                ok=True,
                status="parsed_partial",
                checked_at=checked_at,
                http_status=http_status,
                message="Источник доступен, найдены частичные данные по АИ-95. Требуется ручная проверка качества.",
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
                "Нужен скрин, ручная выгрузка или отдельный парсер динамических данных."
                + (" Найден общий текстовый сигнал: " + "; ".join(counts) if counts else "")
            ),
            observations=observations,
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
            "Не удалось открыть gdebenz ни по основному, ни по www-домену. "
            "Вероятная причина: DNS/геодоступность/временная недоступность из GitHub Actions. "
            "Ошибки: " + " | ".join(errors[-4:])
        ),
    )


def parse_russiabase() -> SourceResult:
    url = "https://russiabase.ru/prices?city=154336&mark=ai95"
    checked_at = now_iso()
    http_status, html, error = fetch(url)

    if error:
        return SourceResult(
            source="russiabase",
            url=url,
            role="availability_price_limits",
            ok=False,
            status="source_unavailable",
            checked_at=checked_at,
            http_status=http_status,
            message=f"Ошибка запроса: {error}",
        )

    observations = generic_table_extract("russiabase", url, html)
    if not observations:
        observations = extract_json_like_ai95("russiabase", url, html)

    soup = BeautifulSoup(html, "html.parser")
    text = clean(soup.get_text(" "))

    if observations:
        status = "parsed_partial"
        message = (
            "Найдены частичные строки/фрагменты с АИ-95. "
            "Проверьте, какие поля соответствуют цене, наличию и ограничениям, затем уточните парсер."
        )
    else:
        status = "no_station_rows"
        message = (
            "Источник доступен, но конкретные строки АЗС по АИ-95 не извлечены. "
            "Возможны динамическая загрузка, защита, изменение HTML или отсутствие данных в статическом ответе."
        )

    return SourceResult(
        source="russiabase",
        url=url,
        role="availability_price_limits",
        ok=True,
        status=status,
        checked_at=checked_at,
        http_status=http_status,
        message=message,
        observations=observations,
        raw_hash=text_hash(text[:200000]),
    )


def parse_price_source(name: str, url: str) -> SourceResult:
    checked_at = now_iso()
    http_status, html, error = fetch(url)

    if error:
        return SourceResult(
            source=name,
            url=url,
            role="price_only",
            ok=False,
            status="source_unavailable",
            checked_at=checked_at,
            http_status=http_status,
            message=f"Ошибка запроса: {error}",
        )

    observations = generic_table_extract(name, url, html)
    if not observations:
        observations = extract_json_like_ai95(name, url, html)

    soup = BeautifulSoup(html, "html.parser")
    text = clean(soup.get_text(" "))

    return SourceResult(
        source=name,
        url=url,
        role="price_only",
        ok=True,
        status="parsed_partial" if observations else "no_station_rows",
        checked_at=checked_at,
        http_status=http_status,
        message=(
            "Ценовой источник. Даже если цена найдена, она не подтверждает фактическое наличие АИ-95."
            if observations
            else "Ценовой источник доступен, но строки АИ-95 не извлечены универсальным парсером."
        ),
        observations=observations,
        raw_hash=text_hash(text[:200000]),
    )


def external_only_source(name: str, url: str, role: str, message: str) -> SourceResult:
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
    observations: list[dict[str, Any]] = []
    for src in source_results:
        observations.extend(src.observations)

    if not observations:
        return []

    grouped: dict[str, dict[str, Any]] = {}
    for obs in observations:
        key = clean((obs.get("station_name") or "") + " " + (obs.get("address") or "")).lower()
        if not key:
            key = obs.get("source", "unknown") + str(len(grouped))

        cur = grouped.setdefault(
            key,
            {
                "station_name": obs.get("station_name"),
                "address": obs.get("address"),
                "fuel": FUEL,
                "status": "unknown",
                "price_rub": obs.get("price_rub"),
                "confidence": 0.0,
                "sources": [],
                "action": "Не ехать без свежего подтверждения наличия.",
                "notes": [],
            },
        )

        cur["confidence"] = max(float(cur["confidence"]), float(obs.get("confidence") or 0))
        src = obs.get("source")
        if src and src not in cur["sources"]:
            cur["sources"].append(src)

        if obs.get("price_rub") and not cur.get("price_rub"):
            cur["price_rub"] = obs.get("price_rub")

        if obs.get("note") and obs["note"] not in cur["notes"]:
            cur["notes"].append(obs["note"])

    rows = list(grouped.values())
    rows.sort(key=lambda x: x["confidence"], reverse=True)
    return rows[:20]


def main() -> int:
    OUT_DIR.mkdir(exist_ok=True)
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)

    source_results = [
        parse_gdebenz(),
        parse_russiabase(),
        external_only_source(
            "tbank_fuel",
            "https://toplivo.tbank.ru/",
            "availability_payment",
            "Публичная страница может не отдавать данные по АЗС в машинном виде. Для точной проверки нужен скрин или доступ к приложению.",
        ),
        external_only_source(
            "yandex_zapravki",
            "https://zapravki.yandex.ru/",
            "availability_payment",
            "Данные по выбору АЗС, колонки и топлива чаще доступны в приложении. Для точной проверки нужен скрин или официальный API.",
        ),
        external_only_source(
            "yandex_maps_traffic",
            "https://yandex.ru/maps/50/perm/probki/",
            "traffic",
            "Слой пробок полезен как косвенный сигнал очереди у АЗС, но не подтверждает наличие АИ-95. Для автоматизации нужен официальный доступ к API или скрин.",
        ),
        external_only_source(
            "2gis_traffic",
            "https://2gis.ru/perm?traffic",
            "traffic",
            "2ГИС полезен для телефонов, маршрутов и пробок. В этом каркасе используется как ручной проверочный источник.",
        ),
        parse_price_source("fuelprice", "https://fuelprice.ru/perm"),
        parse_price_source("benzin_price", "https://www.benzin-price.ru/price.php?region_id=59"),
        parse_price_source("multigo", "https://multigo.ru/benzin/58.0053%3B56.2468/11"),
        parse_price_source("benzup", "https://benzup.ru/index-region"),
    ]

    generated_at = now_iso()
    payload = {
        "schema_version": "0.2",
        "city": CITY,
        "fuel": FUEL,
        "generated_at": generated_at,
        "interpretation_rules": {
            "price_is_not_availability": True,
            "traffic_is_auxiliary_signal_only": True,
            "freshness_threshold_minutes": {
                "strong": 20,
                "medium": 60,
                "stale": 180,
            },
        },
        "source_results": [asdict(src) for src in source_results],
        "recommendations": compute_recommendations(source_results),
        "operator_message": (
            "Если recommendations пустой или все статусы unknown, агент не должен рекомендовать конкретную АЗС. "
            "Нужен скрин gdebenz/russiabase/Т-Банк/Яндекс Заправки или доработка парсера под фактический HTML/API."
        ),
    }

    latest_path = OUT_DIR / "latest.json"
    latest_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    hist_name = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ.json")
    (HISTORY_DIR / hist_name).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"Wrote {latest_path} and history/{hist_name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
