const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const dataDir = path.join(process.cwd(), 'data');
const screenshotsDir = path.join(process.cwd(), 'screenshots');
const outPath = path.join(dataDir, 'tbank_observations.json');
const statusPath = path.join(dataDir, 'tbank_public_status.json');
const screenshotPath = path.join(screenshotsDir, 'tbank-public.png');

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
  return /АИ\s*[-]?\s*95|AI\s*[-]?\s*95|95\s*бензин|бензин\s*95/i.test(String(text || ''));
}

function findAddress(text) {
  const m = String(text || '').match(/((ул\.|улица|шоссе|проспект|пр-т|тракт|дорога|бульвар|переулок|посёлок|поселок|микрорайон)[^,;"']{3,140})/i);
  return m ? clean(m[1]) : null;
}

function findHouse(text) {
  const m = String(text || '').match(/\b(\d{1,4}[а-яa-z]?([\/-]\d{1,4}[а-яa-z]?)?)\b/i);
  return m ? clean(m[1]) : null;
}

function hasHouseNumber(address) {
  return /\b\d{1,4}[а-яa-z]?([\/-]\d{1,4}[а-яa-z]?)?\b/i.test(String(address || ''));
}

function findBrand(text) {
  const m = String(text || '').match(/(ЛУКОЙЛ|Лукойл|Газпромнефть|Газпром|Нефтехимпром|Экойл|Ликом|Teboil|Роснефть|Get Petrol|Башнефть|Татнефть)/i);
  if (!m) return null;
  const value = clean(m[1]);
  if (/лукойл/i.test(value)) return 'ЛУКОЙЛ';
  return value;
}

function parseNumber(value) {
  if (value === null || value === undefined) return null;
  const num = Number(String(value).replace(',', '.'));
  return Number.isFinite(num) ? num : null;
}

function validPermLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat > 57.4 && lat < 58.6 && lon > 55.3 && lon < 57.2;
}

function extractLatLon(obj) {
  if (!obj || typeof obj !== 'object') return null;

  const keyPairs = [
    ['lat', 'lon'], ['lat', 'lng'],
    ['latitude', 'longitude'],
    ['geoLat', 'geoLon'], ['geo_lat', 'geo_lon'],
    ['y', 'x']
  ];

  for (const [latKey, lonKey] of keyPairs) {
    if (obj[latKey] !== undefined && obj[lonKey] !== undefined) {
      const lat = parseNumber(obj[latKey]);
      const lon = parseNumber(obj[lonKey]);
      if (validPermLatLon(lat, lon)) return { lat, lon };
      if (validPermLatLon(lon, lat)) return { lat: lon, lon: lat };
    }
  }

  for (const containerKey of ['location', 'geo', 'geometry', 'point', 'position', 'coordinates']) {
    const v = obj[containerKey];
    if (!v) continue;

    if (Array.isArray(v) && v.length >= 2) {
      const a = parseNumber(v[0]);
      const b = parseNumber(v[1]);
      if (validPermLatLon(a, b)) return { lat: a, lon: b };
      if (validPermLatLon(b, a)) return { lat: b, lon: a };
    }

    if (typeof v === 'object') {
      const nested = extractLatLon(v);
      if (nested) return nested;
    }
  }

  return null;
}

function addressQuality(address, lat, lon) {
  if (validPermLatLon(lat, lon)) return 'coordinate';
  if (address && hasHouseNumber(address)) return 'house';
  if (address) return 'street_only';
  return 'unknown';
}

function pushObservation(list, item) {
  const quality = addressQuality(item.address, item.lat, item.lon);

  // Отбрасываем совсем пустые строки.
  if (!item.station_name && !item.address && !item.lat) return;

  const key = [
    normalize(item.network || item.station_name),
    normalize(item.address),
    item.lat ? Number(item.lat).toFixed(5) : '',
    item.lon ? Number(item.lon).toFixed(5) : ''
  ].join('|');

  if (list.some(x => [
    normalize(x.network || x.station_name),
    normalize(x.address),
    x.lat ? Number(x.lat).toFixed(5) : '',
    x.lon ? Number(x.lon).toFixed(5) : ''
  ].join('|') === key)) return;

  list.push({
    ...item,
    address_quality: quality,
    is_precise: quality === 'coordinate' || quality === 'house'
  });
}

function looksLikeStationObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const text = normalize(JSON.stringify(value).slice(0, 6000));
  return (
    /азс|fuel|gas|station|топлив|бензин|аи[-\s]?95|лукойл|газпром|роснефть|нефтехимпром/.test(text)
  );
}

function walkJson(value, out, sourceUrl, depth = 0) {
  if (!value || out.length >= 120 || depth > 12) return;

  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, out, sourceUrl, depth + 1);
    return;
  }

  if (typeof value !== 'object') return;

  if (looksLikeStationObject(value)) {
    const text = clean(JSON.stringify(value).slice(0, 7000));
    const coords = extractLatLon(value) || {};

    const rawName =
      value.name || value.title || value.brand || value.stationName || value.gasStationName ||
      value.organizationName || value.shortName || value.companyName;

    const rawAddress =
      value.address || value.fullAddress || value.locationAddress || value.addressText ||
      value.subtitle || value.description;

    const network = findBrand(rawName) || findBrand(text);
    const stationName = clean(rawName || network || 'АЗС');
    const address = clean(rawAddress || findAddress(text) || '');

    const fuel =
      value.fuel || value.fuelType || value.product || value.mark || value.oilType ||
      (hasAi95(text) ? 'АИ-95' : 'не указано');

    const status =
      value.status || value.availability || value.available || value.forecast || value.predict ||
      value.presence || value.hasFuel || value.isAvailable || 'tbank_public_signal';

    const updatedAt =
      value.updatedAt || value.updateTime || value.lastTransactionAt || value.lastPaymentAt ||
      value.lastPurchaseAt || value.lastOperationAt || value.lastTransactionDate;

    const quality = addressQuality(address, coords.lat, coords.lon);

    let confidence = 0.40;
    if (hasAi95(text) || hasAi95(fuel)) confidence += 0.15;
    if (network) confidence += 0.10;
    if (quality === 'coordinate') confidence += 0.20;
    if (quality === 'house') confidence += 0.15;
    if (quality === 'street_only') confidence += 0.05;
    confidence = Math.min(confidence, 0.90);

    pushObservation(out, {
      station_name: stationName,
      network: network || stationName,
      address: address || null,
      house: address ? findHouse(address) : null,
      lat: coords.lat || null,
      lon: coords.lon || null,
      fuel: clean(fuel),
      status: clean(String(status)),
      observed_at: updatedAt ? clean(String(updatedAt)) : null,
      confidence,
      source: 'tbank_fuel_public',
      source_url: sourceUrl,
      note: 'Публичная карта Т-Банка: сигнал наличия/активности на основе открытой страницы.'
    });
  }

  for (const v of Object.values(value)) walkJson(v, out, sourceUrl, depth + 1);
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

async function closePopups(page) {
  const selectors = [
    'button:has-text("Понятно")',
    'button:has-text("Хорошо")',
    'button:has-text("Принять")',
    'button:has-text("Разрешить")',
    'button:has-text("Не сейчас")',
    'button:has-text("Закрыть")',
    '[aria-label="Закрыть"]',
    '[aria-label="Close"]'
  ];

  for (const selector of selectors) await clickIfVisible(page, selector);
}

async function trySearchPerm(page) {
  const selectors = [
    'input[placeholder*="Поиск"]',
    'input[placeholder*="поиск"]',
    'input[type="search"]',
    'input'
  ];

  for (const selector of selectors) {
    try {
      const input = page.locator(selector).first();
      if (await input.isVisible({ timeout: 2500 })) {
        await input.click();
        await input.fill('Пермь АИ-95');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(9000);
        return true;
      }
    } catch (e) {}
  }

  return false;
}

function extractFromDomText(text) {
  const observations = [];
  const chunks = clean(text).split(/(?=АЗС|ЛУКОЙЛ|Лукойл|Газпром|Нефтехимпром|Роснефть|Teboil|Татнефть)/i);

  for (const chunk of chunks) {
    if (chunk.length < 30) continue;
    if (!hasAi95(chunk) && !/есть|налич|последн|транзакц|покуп/i.test(chunk)) continue;

    const network = findBrand(chunk);
    const address = findAddress(chunk);

    if (!network && !address) continue;

    pushObservation(observations, {
      station_name: network || 'АЗС',
      network: network || null,
      address,
      house: address ? findHouse(address) : null,
      lat: null,
      lon: null,
      fuel: hasAi95(chunk) ? 'АИ-95' : 'не указано',
      status: /есть|налич/i.test(chunk) ? 'tbank_public_presence_text' : 'tbank_public_activity_text',
      observed_at: null,
      confidence: hasAi95(chunk) ? 0.55 : 0.40,
      source: 'tbank_fuel_public_dom',
      source_url: 'https://toplivo.tbank.ru/',
      note: 'Извлечено из текста публичной страницы Т-Банка.'
    });
  }

  return observations;
}

async function main() {
  ensureDirs();

  const observations = [];
  const networkNotes = [];

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

  page.on('response', async response => {
    const url = response.url();
    const contentType = response.headers()['content-type'] || '';
    const interestingUrl = /fuel|gas|station|azs|map|availability|toplivo|points|places|geo|poi|merchant/i.test(url);

    if (!interestingUrl && !contentType.includes('json')) return;

    try {
      if (contentType.includes('json')) {
        const data = await response.json();
        const before = observations.length;
        walkJson(data, observations, url);
        networkNotes.push({
          url,
          content_type: contentType,
          status: response.status(),
          parsed: observations.length > before,
          added: observations.length - before
        });
      } else {
        networkNotes.push({ url, content_type: contentType, status: response.status(), parsed: false });
      }
    } catch (e) {
      networkNotes.push({
        url,
        content_type: contentType,
        status: response.status(),
        parsed: false,
        error: String(e.message || e).slice(0, 300)
      });
    }
  });

  let pageError = null;

  try {
    await page.goto('https://toplivo.tbank.ru/', { waitUntil: 'domcontentloaded', timeout: 80000 });
    await page.waitForTimeout(12000);
    await closePopups(page);
    await trySearchPerm(page);
    await page.waitForTimeout(15000);
    await closePopups(page);

    await page.screenshot({ path: screenshotPath, fullPage: true });

    const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    for (const obs of extractFromDomText(text)) pushObservation(observations, obs);
  } catch (e) {
    pageError = String(e.message || e);
    try {
      await page.setContent(`
        <html><body style="font-family:Arial;padding:30px">
          <h1>Т-Банк: не удалось открыть публичную карту</h1>
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
  const coordinateCount = observations.filter(x => x.address_quality === 'coordinate').length;
  const houseCount = observations.filter(x => x.address_quality === 'house').length;
  const streetOnlyCount = observations.filter(x => x.address_quality === 'street_only').length;

  const status = {
    generated_at: new Date().toISOString(),
    url: 'https://toplivo.tbank.ru/',
    screenshot_path: 'screenshots/tbank-public.png',
    ok: observations.length > 0,
    status: observations.length > 0 ? 'parsed_public_site' : 'no_public_station_rows',
    observations_count: observations.length,
    precise_count: preciseCount,
    coordinate_count: coordinateCount,
    house_count: houseCount,
    street_only_count: streetOnlyCount,
    message: observations.length > 0
      ? `Собрано публичных сигналов Т-Банка: ${observations.length}; точных: ${preciseCount}; с координатами: ${coordinateCount}; с домом: ${houseCount}; только улица: ${streetOnlyCount}.`
      : 'Публичная страница Т-Банка открыта/проверена, но станционные строки не извлечены. Проверьте screenshots/tbank-public.png и network_notes.',
    page_error: pageError,
    network_notes: networkNotes.slice(0, 120)
  };

  fs.writeFileSync(statusPath, JSON.stringify(status, null, 2), 'utf8');

  console.log(`Wrote data/tbank_observations.json with ${observations.length} rows`);
  console.log(`Wrote data/tbank_public_status.json`);
}

main().catch(e => {
  ensureDirs();
  fs.writeFileSync(outPath, JSON.stringify([], null, 2), 'utf8');
  fs.writeFileSync(statusPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    url: 'https://toplivo.tbank.ru/',
    ok: false,
    status: 'collector_failed',
    observations_count: 0,
    message: String(e.message || e).slice(0, 1200)
  }, null, 2), 'utf8');
  console.error(e);
  process.exit(0);
});
