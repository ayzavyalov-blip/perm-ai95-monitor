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

function hasAi95(text) {
  return /АИ\s*[-]?\s*95|AI\s*[-]?\s*95|95\s*бензин/i.test(String(text || ''));
}

function findAddress(text) {
  const m = String(text || '').match(/((ул\.|улица|шоссе|проспект|пр-т|тракт|дорога|бульвар|переулок)[^,;"']{3,120})/i);
  return m ? clean(m[1]) : null;
}

function findBrand(text) {
  const m = String(text || '').match(/(ЛУКОЙЛ|Газпромнефть|Газпром|Нефтехимпром|Экойл|Ликом|Teboil|Роснефть|Get Petrol|Башнефть|Татнефть)/i);
  return m ? clean(m[1]) : null;
}

function pushObservation(list, item) {
  const key = `${item.station_name || ''}|${item.address || ''}|${item.fuel || ''}`.toLowerCase();
  if (!item.station_name && !item.address) return;
  if (list.some(x => `${x.station_name || ''}|${x.address || ''}|${x.fuel || ''}`.toLowerCase() === key)) return;
  list.push(item);
}

function walkJson(value, out, sourceUrl) {
  if (!value || out.length >= 80) return;

  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, out, sourceUrl);
    return;
  }

  if (typeof value !== 'object') return;

  const text = clean(JSON.stringify(value).slice(0, 5000));
  const stationName =
    value.name || value.title || value.brand || value.stationName || value.gasStationName || value.organizationName;
  const address =
    value.address || value.fullAddress || value.locationAddress || value.addressText || value.subtitle;
  const fuel =
    value.fuel || value.fuelType || value.product || value.mark || value.oilType || (hasAi95(text) ? 'АИ-95' : null);

  const status =
    value.status || value.availability || value.available || value.forecast || value.predict || value.presence || value.hasFuel;

  const updatedAt =
    value.updatedAt || value.updateTime || value.lastTransactionAt || value.lastPaymentAt || value.lastPurchaseAt || value.lastOperationAt;

  const inferredName = stationName || findBrand(text);
  const inferredAddress = address || findAddress(text);

  if ((inferredName || inferredAddress) && (hasAi95(text) || fuel || status !== undefined)) {
    pushObservation(out, {
      station_name: clean(inferredName || 'АЗС'),
      address: inferredAddress ? clean(inferredAddress) : null,
      fuel: fuel ? clean(fuel) : (hasAi95(text) ? 'АИ-95' : 'не указано'),
      status: status === undefined ? 'tbank_public_signal' : clean(String(status)),
      observed_at: updatedAt ? clean(String(updatedAt)) : null,
      confidence: hasAi95(text) ? 0.65 : 0.45,
      source: 'tbank_fuel_public',
      source_url: sourceUrl,
      note: 'Публичная карта Т-Банка: сигнал наличия/активности на основе открытой страницы.'
    });
  }

  for (const v of Object.values(value)) {
    walkJson(v, out, sourceUrl);
  }
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

  for (const selector of selectors) {
    await clickIfVisible(page, selector);
  }
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
      if (await input.isVisible({ timeout: 2000 })) {
        await input.click();
        await input.fill('Пермь АИ-95');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(8000);
        return true;
      }
    } catch (e) {}
  }

  return false;
}

function extractFromDomText(text) {
  const observations = [];
  const chunks = clean(text).split(/(?=АЗС|ЛУКОЙЛ|Газпром|Нефтехимпром|Роснефть|Teboil|Татнефть)/i);
  for (const chunk of chunks) {
    if (chunk.length < 30) continue;
    if (!hasAi95(chunk) && !/есть|налич|последн|транзакц|покуп/i.test(chunk)) continue;

    const brand = findBrand(chunk);
    const address = findAddress(chunk);

    if (!brand && !address) continue;

    pushObservation(observations, {
      station_name: brand || 'АЗС',
      address,
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
    const interestingUrl = /fuel|gas|station|azs|map|availability|toplivo|points|places|geo/i.test(url);

    if (!interestingUrl && !contentType.includes('json')) return;

    try {
      if (contentType.includes('json')) {
        const data = await response.json();
        walkJson(data, observations, url);
        networkNotes.push({ url, content_type: contentType, status: response.status(), parsed: true });
      } else {
        networkNotes.push({ url, content_type: contentType, status: response.status(), parsed: false });
      }
    } catch (e) {
      networkNotes.push({ url, content_type: contentType, status: response.status(), parsed: false, error: String(e.message || e).slice(0, 300) });
    }
  });

  let pageError = null;

  try {
    await page.goto('https://toplivo.tbank.ru/', { waitUntil: 'domcontentloaded', timeout: 80000 });
    await page.waitForTimeout(10000);
    await closePopups(page);
    await trySearchPerm(page);
    await page.waitForTimeout(12000);
    await closePopups(page);

    await page.screenshot({ path: screenshotPath, fullPage: true });

    const text = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    for (const obs of extractFromDomText(text)) {
      pushObservation(observations, obs);
    }
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

  const status = {
    generated_at: new Date().toISOString(),
    url: 'https://toplivo.tbank.ru/',
    screenshot_path: 'screenshots/tbank-public.png',
    ok: observations.length > 0,
    status: observations.length > 0 ? 'parsed_public_site' : 'no_public_station_rows',
    observations_count: observations.length,
    message: observations.length > 0
      ? `Собрано публичных сигналов Т-Банка: ${observations.length}.`
      : 'Публичная страница Т-Банка открыта/проверена, но станционные строки не извлечены. Проверьте screenshots/tbank-public.png и network_notes.',
    page_error: pageError,
    network_notes: networkNotes.slice(0, 80)
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
