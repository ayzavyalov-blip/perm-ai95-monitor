const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const dataDir = path.join(process.cwd(), 'data');
const screenshotsDir = path.join(process.cwd(), 'screenshots');
const outPath = path.join(dataDir, 'gdebenz_observations.json');
const statusPath = path.join(dataDir, 'gdebenz_public_status.json');
const screenshotPath = path.join(screenshotsDir, 'gdebenz-public.png');

function ensureDirs() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  return clean(value).toLowerCase().replace(/ё/g, 'е');
}

function hasAi95(text) {
  return /АИ\s*[-]?\s*95|AI\s*[-]?\s*95|есть\s*95|\b95\b/i.test(String(text || ''));
}

function findBrand(text) {
  const m = String(text || '').match(/(ЛУКОЙЛ|Лукойл|Газпромнефть|Газпром|Нефтехимпром|Экойл|Ликом|Teboil|Роснефть|Get Petrol|Башнефть|Татнефть|V&V|V\s*&\s*V)/i);
  if (!m) return null;
  const raw = clean(m[1]);
  if (/лукойл/i.test(raw)) return 'ЛУКОЙЛ';
  if (/v\s*&\s*v/i.test(raw)) return 'V&V';
  return raw;
}

function findAddress(text) {
  const m = String(text || '').match(/((ул\.|улица|шоссе|проспект|пр-т|тракт|дорога|бульвар|переулок|посёлок|поселок|микрорайон|км|километр)[^,;"']{3,160})/i);
  return m ? clean(m[1]) : null;
}

function findHouse(text) {
  const m = String(text || '').match(/\b(\d{1,4}[а-яa-z]?([\/-]\d{1,4}[а-яa-z]?)?)\b/i);
  return m ? clean(m[1]) : null;
}

function hasHouseNumber(address) {
  return /\b\d{1,4}[а-яa-z]?([\/-]\d{1,4}[а-яa-z]?)?\b/i.test(String(address || ''));
}

function parseDistance(text) {
  const m = String(text || '').match(/(\d+[,.]?\d*)\s*км/i);
  return m ? Number(m[1].replace(',', '.')) : null;
}

function parseMarks(text) {
  const m = String(text || '').match(/(\d+)\s*метк[аи]?\s*за\s*(\d+)\s*ч/i);
  if (!m) return null;
  return { count: Number(m[1]), hours: Number(m[2]) };
}

function parseQueue(text) {
  const patterns = [
    /очеред[ьи][^.\n,;]{0,80}/i,
    /≈\s*\d+\+?\s*машин/i,
    /~\s*\d+\+?\s*машин/i,
    /\d+\s*-\s*\d+\s*машин/i
  ];
  for (const p of patterns) {
    const m = String(text || '').match(p);
    if (m) return clean(m[0]);
  }
  return null;
}

function addressQuality(address, lat, lon) {
  if (Number.isFinite(lat) && Number.isFinite(lon) && lat > 57.4 && lat < 58.6 && lon > 55.3 && lon < 57.2) return 'coordinate';
  if (address && hasHouseNumber(address)) return 'house';
  if (address) return 'street_only';
  return 'unknown';
}

function pushObservation(list, item) {
  const quality = addressQuality(item.address, item.lat, item.lon);
  const key = [
    normalize(item.network || item.station_name),
    normalize(item.address),
    item.lat ? Number(item.lat).toFixed(5) : '',
    item.lon ? Number(item.lon).toFixed(5) : '',
    normalize(item.queue || '')
  ].join('|');

  if (!item.station_name && !item.address && !item.lat) return;
  if (list.some(x => [
    normalize(x.network || x.station_name),
    normalize(x.address),
    x.lat ? Number(x.lat).toFixed(5) : '',
    x.lon ? Number(x.lon).toFixed(5) : '',
    normalize(x.queue || '')
  ].join('|') === key)) return;

  list.push({
    station_name: item.station_name || item.network || 'АЗС',
    network: item.network || findBrand(item.station_name) || null,
    address: item.address || null,
    house: item.house || findHouse(item.address) || null,
    lat: Number.isFinite(item.lat) ? item.lat : null,
    lon: Number.isFinite(item.lon) ? item.lon : null,
    address_quality: quality,
    is_precise: quality === 'coordinate' || quality === 'house',
    fuel: item.fuel || 'АИ-95',
    status: item.status || 'gdebenz_public_signal',
    queue: item.queue || null,
    distance_km: item.distance_km || null,
    marks_count: item.marks_count || null,
    marks_hours: item.marks_hours || null,
    confidence: item.confidence || 0.50,
    source: 'gdebenz',
    source_url: 'https://gdebenz.ru/',
    note: item.note || 'ГдеБЕНЗ: карточка после фильтра город=Пермь, есть топливо, 95, все.'
  });
}

async function clickIfVisible(page, selector, timeout = 1500) {
  try {
    const locator = page.locator(selector).first();
    if (await locator.isVisible({ timeout })) {
      await locator.click({ timeout });
      await page.waitForTimeout(700);
      return true;
    }
  } catch (e) {}
  return false;
}

async function clickText(page, text, timeout = 1500) {
  const selectors = [
    `button:has-text("${text}")`,
    `a:has-text("${text}")`,
    `div:has-text("${text}")`,
    `span:has-text("${text}")`,
    `text=${text}`
  ];

  for (const selector of selectors) {
    const clicked = await clickIfVisible(page, selector, timeout);
    if (clicked) return true;
  }

  return false;
}

async function closeNonCityPopups(page) {
  const selectors = [
    '[aria-label="Закрыть"]',
    '[aria-label="Close"]',
    'button:has-text("Не сейчас")',
    'button:has-text("Понятно")',
    'button:has-text("Хорошо")',
    'button:has-text("Закрыть")',
    'button:has-text("Понятно, спасибо")',
    'button:has-text("Добавить") + button',
    'text=Не сейчас'
  ];

  for (const selector of selectors) {
    await clickIfVisible(page, selector, 1000);
  }

  // Удаляем PWA/подписочные баннеры, которые перекрывают карту.
  await page.evaluate(() => {
    const killTexts = [
      'Добавить ГдеБЕНЗ на экран',
      'Друзья, ВАЖНО',
      'Поддержать',
      'Установить приложение'
    ];

    for (const el of Array.from(document.querySelectorAll('div, section, aside'))) {
      const txt = (el.innerText || '').trim();
      if (!txt) continue;
      if (killTexts.some(t => txt.includes(t))) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 250 && rect.height > 80) {
          el.style.display = 'none';
        }
      }
    }
  }).catch(() => {});
}

async function setCityPerm(page) {
  // Если видим стартовую модалку геолокации, выбираем ручной город.
  await clickText(page, 'Указать свой город', 4000);

  await page.waitForTimeout(1000);

  const inputs = [
    'input[placeholder*="город"]',
    'input[placeholder*="Город"]',
    'input[placeholder*="Поиск"]',
    'input[placeholder*="поиск"]',
    'input[type="search"]',
    'input'
  ];

  for (const selector of inputs) {
    try {
      const input = page.locator(selector).first();
      if (await input.isVisible({ timeout: 2000 })) {
        await input.click();
        await input.fill('пермь');
        await page.waitForTimeout(1500);

        // Кликаем результат "Пермь", если он виден.
        const clickedPerm = await clickText(page, 'Пермь', 2500);
        if (!clickedPerm) {
          await page.keyboard.press('Enter');
        }

        await page.waitForTimeout(4500);
        return true;
      }
    } catch (e) {}
  }

  // Если город уже выбран или есть кнопка с городом.
  const pageText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  return /Пермь/i.test(pageText);
}

async function applyGdebenzFilters(page) {
  await closeNonCityPopups(page);

  // Открываем фильтры. На кнопке может быть "Фильтры", "Фильтры • 95" и т.п.
  const filterSelectors = [
    'button:has-text("Фильтры")',
    'div:has-text("Фильтры")',
    'text=Фильтры'
  ];

  let opened = false;
  for (const selector of filterSelectors) {
    opened = await clickIfVisible(page, selector, 2500);
    if (opened) break;
  }

  await page.waitForTimeout(1500);

  // Выбираем "Где есть топливо".
  await clickText(page, 'Где есть топливо', 2500);
  await page.waitForTimeout(500);

  // Выбираем 95. Иногда это chip/button с текстом "95" или "АИ-95".
  const fuelSelectors = [
    'button:has-text("95")',
    'div:has-text("95")',
    'span:has-text("95")',
    'label:has-text("95")',
    'text=95',
    'button:has-text("АИ-95")',
    'label:has-text("АИ-95")'
  ];

  for (const selector of fuelSelectors) {
    try {
      const candidates = await page.locator(selector).all();
      for (const loc of candidates.slice(0, 6)) {
        if (await loc.isVisible({ timeout: 700 })) {
          await loc.click({ timeout: 1000 });
          await page.waitForTimeout(350);
          break;
        }
      }
    } catch (e) {}
  }

  // "Все" для сетей/условий, если такой chip есть.
  await clickText(page, 'ВСЕ', 1000);
  await clickText(page, 'Все', 1000);

  // Готово.
  const done = await clickText(page, 'Готово', 3000);
  if (!done) {
    await page.keyboard.press('Escape');
  }

  await page.waitForTimeout(6000);
  await closeNonCityPopups(page);
}

function parseCardText(text) {
  const t = clean(text);
  const network = findBrand(t);
  const address = findAddress(t);
  const queue = parseQueue(t);
  const distance = parseDistance(t);
  const marks = parseMarks(t);

  let status = 'gdebenz_filtered_card';
  if (/нет\s+топлива|нет\s+95/i.test(t)) status = 'no_fuel';
  if (/есть\s+топливо|есть\s*95/i.test(t)) status = 'has_ai95_or_fuel';
  if (/очеред/i.test(t)) status = 'has_ai95_queue_possible';

  let confidence = 0.45;
  if (network) confidence += 0.10;
  if (address) confidence += 0.10;
  if (hasHouseNumber(address)) confidence += 0.10;
  if (/есть\s*95/i.test(t)) confidence += 0.15;
  if (marks && marks.count >= 4) confidence += 0.05;
  confidence = Math.min(confidence, 0.85);

  return {
    station_name: network || 'АЗС',
    network,
    address,
    house: address ? findHouse(address) : null,
    fuel: 'АИ-95',
    status,
    queue,
    distance_km: distance,
    marks_count: marks ? marks.count : null,
    marks_hours: marks ? marks.hours : null,
    confidence,
    raw_text: t.slice(0, 1200)
  };
}

async function getLeftPanelCards(page) {
  return await page.evaluate(() => {
    function visible(el) {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return r.width > 120 && r.height > 50 && style.visibility !== 'hidden' && style.display !== 'none';
    }

    const brandRe = /(ЛУКОЙЛ|Лукойл|Газпромнефть|Газпром|Нефтехимпром|Экойл|Ликом|Teboil|Роснефть|Get Petrol|Башнефть|Татнефть|V&V)/i;
    const fuelRe = /(есть\s*95|АИ\s*[-]?\s*95|\b95\b|очеред|метк[аи])/i;

    const items = [];
    for (const el of Array.from(document.querySelectorAll('button, a, div'))) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.left > 430 || r.top < 80) continue;

      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (text.length < 20 || text.length > 900) continue;
      if (!brandRe.test(text) && !fuelRe.test(text)) continue;
      if (!fuelRe.test(text)) continue;

      items.push({
        text,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        top: r.top,
        height: r.height
      });
    }

    const unique = [];
    const seen = new Set();
    for (const item of items.sort((a, b) => a.top - b.top)) {
      const key = item.text.slice(0, 180);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }

    return unique.slice(0, 20);
  });
}

async function extractDetailAfterClick(page, card) {
  try {
    await page.mouse.click(card.x, card.y);
    await page.waitForTimeout(2500);
  } catch (e) {}

  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const detail = parseCardText(bodyText);

  // Если детальная карточка не дала полезный адрес, оставляем карточку из списка.
  const base = parseCardText(card.text);

  return {
    ...base,
    network: detail.network || base.network,
    station_name: detail.network || base.network || detail.station_name || base.station_name,
    address: detail.address || base.address,
    house: detail.house || base.house,
    queue: detail.queue || base.queue,
    status: detail.status && detail.status !== 'gdebenz_filtered_card' ? detail.status : base.status,
    confidence: Math.max(base.confidence || 0, detail.confidence || 0),
    raw_text: `${base.raw_text}\n---DETAIL---\n${clean(bodyText).slice(0, 1800)}`
  };
}

async function main() {
  ensureDirs();

  const observations = [];
  let pageError = null;
  let citySet = false;
  let filtersApplied = false;
  let cardsFound = 0;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'ru-RU',
    timezoneId: 'Asia/Yekaterinburg',
    viewport: { width: 1500, height: 1000 },
    geolocation: { latitude: 58.0105, longitude: 56.2502 },
    permissions: ['geolocation'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {
    await page.goto('https://gdebenz.ru/', { waitUntil: 'domcontentloaded', timeout: 80000 });
    await page.waitForTimeout(6000);

    citySet = await setCityPerm(page);
    await closeNonCityPopups(page);

    filtersApplied = true;
    await applyGdebenzFilters(page);

    await page.screenshot({ path: screenshotPath, fullPage: true });

    const cards = await getLeftPanelCards(page);
    cardsFound = cards.length;

    for (const card of cards.slice(0, 12)) {
      const item = await extractDetailAfterClick(page, card);
      if (item.status === 'no_fuel') continue;
      if (!hasAi95(item.raw_text) && !/есть\s+топливо/i.test(item.raw_text)) continue;
      pushObservation(observations, item);
    }

    // Резерв: если карточки не нашлись через DOM, парсим весь текст левой панели.
    if (!observations.length) {
      const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
      const chunks = clean(bodyText).split(/(?=ЛУКОЙЛ|Лукойл|Газпромнефть|Газпром|Нефтехимпром|Teboil|V&V|Татнефть|Роснефть)/i);
      for (const chunk of chunks) {
        if (chunk.length < 25) continue;
        if (!hasAi95(chunk) && !/есть\s+топливо|очеред|метк[аи]/i.test(chunk)) continue;
        const item = parseCardText(chunk);
        if (item.status !== 'no_fuel') pushObservation(observations, item);
      }
    }
  } catch (e) {
    pageError = String(e.message || e);
    try {
      await page.setContent(`
        <html><body style="font-family:Arial;padding:30px">
          <h1>ГдеБЕНЗ: не удалось собрать публичную карту</h1>
          <p>${pageError}</p>
        </body></html>
      `);
      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch (ignore) {}
  }

  await context.close();
  await browser.close();

  fs.writeFileSync(outPath, JSON.stringify(observations, null, 2), 'utf8');

  const preciseCount = observations.filter(x => x.is_precise).length;
  const houseCount = observations.filter(x => x.address_quality === 'house').length;
  const streetOnlyCount = observations.filter(x => x.address_quality === 'street_only').length;

  const status = {
    generated_at: new Date().toISOString(),
    url: 'https://gdebenz.ru/',
    screenshot_path: 'screenshots/gdebenz-public.png',
    ok: observations.length > 0,
    status: observations.length > 0 ? 'parsed_public_ui' : 'no_station_rows_from_ui',
    city_set: citySet,
    filters_applied: filtersApplied,
    cards_found: cardsFound,
    observations_count: observations.length,
    precise_count: preciseCount,
    house_count: houseCount,
    street_only_count: streetOnlyCount,
    message: observations.length > 0
      ? `ГдеБЕНЗ UI: собрано ${observations.length} карточек; точных: ${preciseCount}; с домом: ${houseCount}; только улица: ${streetOnlyCount}.`
      : 'ГдеБЕНЗ UI открыт, но карточки после фильтра не извлечены. Проверьте screenshots/gdebenz-public.png.',
    page_error: pageError
  };

  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2), 'utf8');

  console.log(`Wrote data/gdebenz_observations.json with ${observations.length} rows`);
  console.log(`Wrote data/gdebenz_public_status.json`);
}

main().catch(e => {
  ensureDirs();
  fs.writeFileSync(outPath, JSON.stringify([], null, 2), 'utf8');
  fs.writeFileSync(statusPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    url: 'https://gdebenz.ru/',
    ok: false,
    status: 'collector_failed',
    observations_count: 0,
    message: String(e.message || e).slice(0, 1200)
  }, null, 2), 'utf8');
  console.error(e);
  process.exit(0);
});
