const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const dataDir = path.join(process.cwd(), 'data');
const screenshotsDir = path.join(process.cwd(), 'screenshots');
const stepDir = path.join(screenshotsDir, 'gdebenz');
const outPath = path.join(dataDir, 'gdebenz_observations.json');
const statusPath = path.join(dataDir, 'gdebenz_public_status.json');
const screenshotPath = path.join(screenshotsDir, 'gdebenz-public.png');

function ensureDirs() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(screenshotsDir, { recursive: true });
  fs.mkdirSync(stepDir, { recursive: true });
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
  const m = String(text || '').match(/((ул\.|улица|шоссе|проспект|пр-т|тракт|дорога|бульвар|переулок|посёлок|поселок|микрорайон|км|километр|ш\.)[^,;"']{3,180})/i);
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
    /большая\s+очередь/i,
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
    normalize(item.queue || ''),
    normalize(item.raw_text || '').slice(0, 80)
  ].join('|');

  if (!item.station_name && !item.address && !item.raw_text) return;
  if (list.some(x => [
    normalize(x.network || x.station_name),
    normalize(x.address),
    x.lat ? Number(x.lat).toFixed(5) : '',
    x.lon ? Number(x.lon).toFixed(5) : '',
    normalize(x.queue || ''),
    normalize(x.raw_text || '').slice(0, 80)
  ].join('|') === key)) return;

  list.push({
    station_name: item.station_name || item.network || 'АЗС',
    network: item.network || findBrand(item.station_name) || findBrand(item.raw_text) || null,
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
    raw_text: item.raw_text || null,
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
    `label:has-text("${text}")`,
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

async function saveStep(page, name) {
  try {
    await page.screenshot({ path: path.join(stepDir, `${name}.png`), fullPage: true });
  } catch (e) {}
}

async function closeNonCityPopups(page) {
  const selectors = [
    '[aria-label="Закрыть"]',
    '[aria-label="Close"]',
    'button:has-text("Пока пропустить")',
    'button:has-text("Не сейчас")',
    'button:has-text("Понятно")',
    'button:has-text("Хорошо")',
    'button:has-text("Закрыть")',
    'button:has-text("Понятно, спасибо")',
    'text=Пока пропустить',
    'text=Не сейчас'
  ];

  for (const selector of selectors) {
    await clickIfVisible(page, selector, 1000);
  }

  await page.evaluate(() => {
    const killTexts = [
      'Добавить ГдеБЕНЗ на экран',
      'Друзья, ВАЖНО',
      'Поддержать',
      'Установить приложение',
      'Иконка на экране телефона'
    ];

    for (const el of Array.from(document.querySelectorAll('div, section, aside'))) {
      const txt = (el.innerText || '').trim();
      if (!txt) continue;
      if (killTexts.some(t => txt.includes(t))) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 220 && rect.height > 70) {
          el.style.display = 'none';
        }
      }
    }
  }).catch(() => {});
}

async function setCityPerm(page) {
  await saveStep(page, '01-open');

  // Иногда /perm сразу выставляет город. Если видим Пермь, город засчитываем.
  let text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  if (/Пермь/i.test(text) && !/Покажем заправки рядом/i.test(text)) return true;

  // Если стартовая модалка геолокации.
  await clickText(page, 'Указать свой город', 4000);
  await page.waitForTimeout(1000);
  await saveStep(page, '02-city-dialog');

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
        await page.waitForTimeout(1800);

        let clickedPerm = false;
        const permLocators = [
          'button:has-text("Пермь")',
          'div:has-text("Пермь")',
          'span:has-text("Пермь")',
          'text=Пермь'
        ];
        for (const permSelector of permLocators) {
          clickedPerm = await clickIfVisible(page, permSelector, 2000);
          if (clickedPerm) break;
        }

        if (!clickedPerm) {
          await page.keyboard.press('Enter');
        }

        await page.waitForTimeout(5000);
        await saveStep(page, '03-city-set');
        text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
        return /Пермь/i.test(text);
      }
    } catch (e) {}
  }

  text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  return /Пермь/i.test(text);
}

async function applyGdebenzFilters(page) {
  await closeNonCityPopups(page);
  await saveStep(page, '04-before-filters');

  let opened = false;
  const filterSelectors = [
    'button:has-text("Фильтры")',
    'a:has-text("Фильтры")',
    'div:has-text("Фильтры")',
    'text=Фильтры'
  ];

  for (const selector of filterSelectors) {
    opened = await clickIfVisible(page, selector, 2500);
    if (opened) break;
  }

  await page.waitForTimeout(1500);
  await saveStep(page, '05-filter-opened');

  const beforeText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');

  // Если не открылось через текст, кликаем примерную область кнопки фильтров в левом блоке.
  if (!/Где есть топливо|Тип топлива|Топливо|Готово/i.test(beforeText)) {
    await page.mouse.click(110, 310).catch(() => {});
    await page.waitForTimeout(1500);
  }

  await clickText(page, 'Где есть топливо', 2500);
  await page.waitForTimeout(500);

  // Выбор 95. Кликаем все видимые короткие chip, содержащие 95.
  try {
    const handles = await page.locator('button, label, div, span').all();
    let clicked95 = false;
    for (const h of handles.slice(0, 800)) {
      if (clicked95) break;
      try {
        const txt = clean(await h.innerText({ timeout: 200 }));
        if (!txt) continue;
        if (/^(АИ[-\s]?95|95)$/.test(txt) || /есть\s*95/i.test(txt)) {
          if (await h.isVisible({ timeout: 200 })) {
            await h.click({ timeout: 700 });
            clicked95 = true;
            await page.waitForTimeout(500);
          }
        }
      } catch (e) {}
    }
  } catch (e) {}

  await clickText(page, 'ВСЕ', 1000);
  await clickText(page, 'Все', 1000);

  await saveStep(page, '06-filter-selected');

  const done = await clickText(page, 'Готово', 3000);
  if (!done) {
    await page.keyboard.press('Escape');
  }

  await page.waitForTimeout(7000);
  await closeNonCityPopups(page);
  await saveStep(page, '07-after-filters');

  const afterText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  return /есть\s*95|АИ[-\s]?95|Ближайшие АЗС|метк[аи]/i.test(afterText);
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
  if (/есть\s+топливо|есть\s*95|АИ[-\s]?95/i.test(t)) status = 'has_ai95_or_fuel';
  if (/очеред/i.test(t)) status = 'has_ai95_queue_possible';

  let confidence = 0.45;
  if (network) confidence += 0.10;
  if (address) confidence += 0.10;
  if (hasHouseNumber(address)) confidence += 0.10;
  if (/есть\s*95|АИ[-\s]?95/i.test(t)) confidence += 0.15;
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
    raw_text: t.slice(0, 1800)
  };
}

async function getCardsByDom(page) {
  return await page.evaluate(() => {
    function visible(el) {
      const r = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return r.width > 80 && r.height > 20 && style.visibility !== 'hidden' && style.display !== 'none';
    }

    const brandRe = /(ЛУКОЙЛ|Лукойл|Газпромнефть|Газпром|Нефтехимпром|Экойл|Ликом|Teboil|Роснефть|Get Petrol|Башнефть|Татнефть|V&V)/i;
    const fuelRe = /(есть\s*95|АИ\s*[-]?\s*95|\b95\b|очеред|метк[аи]|есть\s+топливо)/i;

    const candidates = [];

    for (const el of Array.from(document.querySelectorAll('button, a, div, article, section, li'))) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      if (text.length < 12 || text.length > 1200) continue;
      if (!brandRe.test(text) && !fuelRe.test(text)) continue;
      if (r.left > 520 && !brandRe.test(text)) continue;

      candidates.push({
        text,
        x: r.left + r.width / 2,
        y: r.top + Math.min(r.height / 2, 80),
        top: r.top,
        left: r.left,
        width: r.width,
        height: r.height
      });
    }

    const unique = [];
    const seen = new Set();

    for (const item of candidates.sort((a, b) => (a.left - b.left) || (a.top - b.top))) {
      const key = item.text.slice(0, 220);
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }

    return unique.slice(0, 40);
  });
}

async function getCardsByLines(page) {
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const lines = bodyText.split('\n').map(clean).filter(Boolean);
  const cards = [];
  const brandRe = /(ЛУКОЙЛ|Лукойл|Газпромнефть|Газпром|Нефтехимпром|Экойл|Ликом|Teboil|Роснефть|Get Petrol|Башнефть|Татнефть|V&V)/i;

  for (let i = 0; i < lines.length; i++) {
    if (!brandRe.test(lines[i])) continue;
    const chunk = lines.slice(i, Math.min(lines.length, i + 8)).join(' ');
    if (!/95|топливо|очеред|метк[аи]/i.test(chunk)) continue;
    cards.push({ text: chunk, x: 200, y: 150 + cards.length * 90, top: 0, left: 0, width: 0, height: 0 });
  }

  return cards.slice(0, 30);
}

async function extractDetailAfterClick(page, card, idx) {
  const base = parseCardText(card.text);

  try {
    if (card.x && card.y) {
      await page.mouse.click(card.x, card.y);
      await page.waitForTimeout(2500);
      await saveStep(page, `08-card-${String(idx + 1).padStart(2, '0')}`);
    }
  } catch (e) {}

  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const detail = parseCardText(bodyText);

  return {
    ...base,
    network: detail.network || base.network,
    station_name: detail.network || base.network || detail.station_name || base.station_name,
    address: detail.address || base.address,
    house: detail.house || base.house,
    queue: detail.queue || base.queue,
    status: detail.status && detail.status !== 'gdebenz_filtered_card' ? detail.status : base.status,
    confidence: Math.max(base.confidence || 0, detail.confidence || 0),
    raw_text: `${base.raw_text}\n---DETAIL---\n${clean(bodyText).slice(0, 2200)}`
  };
}

async function main() {
  ensureDirs();

  const observations = [];
  let pageError = null;
  let citySet = false;
  let filtersApplied = false;
  let cardsFoundDom = 0;
  let cardsFoundLines = 0;

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
    // /perm чаще сразу выставляет город и обходит стартовую модалку.
    await page.goto('https://gdebenz.ru/perm', { waitUntil: 'domcontentloaded', timeout: 80000 });
    await page.waitForTimeout(7000);

    citySet = await setCityPerm(page);
    await closeNonCityPopups(page);

    filtersApplied = await applyGdebenzFilters(page);

    await page.screenshot({ path: screenshotPath, fullPage: true });

    const domCards = await getCardsByDom(page);
    const lineCards = await getCardsByLines(page);
    cardsFoundDom = domCards.length;
    cardsFoundLines = lineCards.length;

    const cards = [...domCards, ...lineCards];
    const seen = new Set();
    const uniqueCards = [];

    for (const card of cards) {
      const key = clean(card.text).slice(0, 180);
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueCards.push(card);
    }

    for (const [idx, card] of uniqueCards.slice(0, 14).entries()) {
      const item = await extractDetailAfterClick(page, card, idx);
      if (item.status === 'no_fuel') continue;
      if (!hasAi95(item.raw_text) && !/есть\s+топливо|очеред|метк[аи]/i.test(item.raw_text)) continue;
      pushObservation(observations, item);
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
    url: 'https://gdebenz.ru/perm',
    screenshot_path: 'screenshots/gdebenz-public.png',
    step_screenshots_dir: 'screenshots/gdebenz/',
    ok: observations.length > 0,
    status: observations.length > 0 ? 'parsed_public_ui' : 'no_station_rows_from_ui',
    city_set: citySet,
    filters_applied: filtersApplied,
    cards_found_dom: cardsFoundDom,
    cards_found_lines: cardsFoundLines,
    observations_count: observations.length,
    precise_count: preciseCount,
    house_count: houseCount,
    street_only_count: streetOnlyCount,
    message: observations.length > 0
      ? `ГдеБЕНЗ UI: собрано ${observations.length} карточек; DOM-карт: ${cardsFoundDom}; line-карт: ${cardsFoundLines}; точных: ${preciseCount}; с домом: ${houseCount}; только улица: ${streetOnlyCount}.`
      : `ГдеБЕНЗ UI открыт, но карточки не извлечены. city_set=${citySet}; filters_applied=${filtersApplied}; DOM=${cardsFoundDom}; lines=${cardsFoundLines}. Проверьте screenshots/gdebenz/*.png.`,
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
    url: 'https://gdebenz.ru/perm',
    ok: false,
    status: 'collector_failed',
    observations_count: 0,
    message: String(e.message || e).slice(0, 1200)
  }, null, 2), 'utf8');
  console.error(e);
  process.exit(0);
});
