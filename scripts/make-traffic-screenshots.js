const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const screenshotsDir = path.join(process.cwd(), 'screenshots');
const stationScreenshotsDir = path.join(screenshotsDir, 'stations');
const statusPath = path.join(screenshotsDir, 'traffic-status.json');

function ensureDir() {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  fs.mkdirSync(stationScreenshotsDir, { recursive: true });
}

function rel(p) {
  return p.replace(process.cwd() + path.sep, '').replaceAll('\\', '/');
}

function safeId(value) {
  return String(value || 'target')
    .toLowerCase()
    .replace(/[^a-z0-9а-я_-]+/gi, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function readLatest() {
  const latestPath = path.join(process.cwd(), 'data', 'latest.json');
  if (!fs.existsSync(latestPath)) {
    return { traffic_targets: [] };
  }
  return JSON.parse(fs.readFileSync(latestPath, 'utf8'));
}

function buildTargets() {
  const latest = readLatest();
  const inputTargets = Array.isArray(latest.traffic_targets) ? latest.traffic_targets : [];

  if (inputTargets.length > 0) {
    return inputTargets.map((t, index) => ({
      station_id: safeId(t.station_id || `station-${index + 1}`),
      label: t.label || t.query || `АЗС ${index + 1}`,
      query: t.query || t.label || 'АЗС АИ-95 Пермь',
      confidence: t.confidence,
      sources: t.sources || [],
      is_fallback: t.station_id === 'perm-general'
    }));
  }

  return [{
    station_id: 'perm-general',
    label: 'Пермь: общий диагностический обзор',
    query: 'АЗС АИ-95 Пермь',
    confidence: null,
    sources: [],
    is_fallback: true
  }];
}

function yandexUrl(query) {
  return `https://yandex.ru/maps/50/perm/search/${encodeURIComponent(query)}/?ll=56.2502%2C58.0105&z=14&traffic=1`;
}

function gisUrl(query) {
  return `https://2gis.ru/perm/search/${encodeURIComponent(query)}?traffic`;
}

function writeStatus(payload) {
  fs.writeFileSync(statusPath, JSON.stringify(payload, null, 2), 'utf8');
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

async function closeYandexPopups(page) {
  const selectors = [
    'button:has-text("Allow all")',
    'button:has-text("Allow essential cookies")',
    'button:has-text("Принять")',
    'button:has-text("Понятно")',
    'button:has-text("Хорошо")',
    'button:has-text("Закрыть")',
    '[aria-label="Закрыть"]',
    '[aria-label="Close"]'
  ];

  for (const selector of selectors) {
    await clickIfVisible(page, selector);
  }
}

async function pass2gisBrowserWarning(page) {
  const selectors = [
    'button:has-text("Пропустить обновление браузера")',
    'a:has-text("Пропустить обновление браузера")',
    'text=Пропустить обновление браузера',
    'button:has-text("перейти в 2ГИС")',
    'a:has-text("перейти в 2ГИС")'
  ];

  for (const selector of selectors) {
    const clicked = await clickIfVisible(page, selector, 2500);
    if (clicked) {
      await page.waitForTimeout(7000);
      return true;
    }
  }
  return false;
}

async function writeFallbackImage(browser, source, target, screenshotPath, message) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const html = `
    <!doctype html>
    <html lang="ru">
      <head><meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; padding: 32px; background: #f8fafc; color: #1f2937; }
          .box { max-width: 1000px; border: 1px solid #e2e8f0; background: white; border-radius: 14px; padding: 24px; }
          h1 { color: #991b1b; }
          code { background: #f1f5f9; padding: 2px 4px; border-radius: 4px; }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>Скриншот не получен</h1>
          <p><b>Источник:</b> ${source}</p>
          <p><b>АЗС:</b> ${target.label}</p>
          <p><b>Запрос:</b> <code>${target.query}</code></p>
          <p><b>Ошибка:</b> <code>${String(message).slice(0, 1200)}</code></p>
          <p>Это не подтверждает и не опровергает наличие АИ-95. Проверьте карту вручную.</p>
        </div>
      </body>
    </html>
  `;
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.close();
}

async function capture(browser, source, target, url, screenshotPath) {
  const startedAt = new Date().toISOString();
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
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 70000 });
    await page.waitForTimeout(8000);

    if (source === 'yandex_maps_traffic') {
      await closeYandexPopups(page);
      await page.waitForTimeout(12000);
    }

    if (source === '2gis_traffic') {
      await pass2gisBrowserWarning(page);
      await page.waitForTimeout(15000);
    }

    await page.screenshot({ path: screenshotPath, fullPage: true });
    await context.close();

    return {
      source,
      target_id: target.station_id,
      target_label: target.label,
      query: target.query,
      url,
      ok: true,
      status: 'screenshot_saved',
      screenshot_path: rel(screenshotPath),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      message: 'Скриншот сохранён. Это визуальный слой пробок, не подтверждение наличия АИ-95.'
    };
  } catch (e) {
    await context.close();

    try {
      await writeFallbackImage(browser, source, target, screenshotPath, e.message || String(e));
    } catch (fallbackError) {}

    return {
      source,
      target_id: target.station_id,
      target_label: target.label,
      query: target.query,
      url,
      ok: false,
      status: 'screenshot_failed',
      screenshot_path: rel(screenshotPath),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      message: String(e.message || e).slice(0, 1200)
    };
  }
}

async function main() {
  ensureDir();

  const targets = buildTargets();
  const results = [];
  const browser = await chromium.launch({ headless: true });

  for (const target of targets) {
    const id = safeId(target.station_id);

    const yandexPath = path.join(stationScreenshotsDir, `${id}-yandex.png`);
    const gisPath = path.join(stationScreenshotsDir, `${id}-2gis.png`);

    const yandexResult = await capture(browser, 'yandex_maps_traffic', target, yandexUrl(target.query), yandexPath);
    results.push(yandexResult);

    const gisResult = await capture(browser, '2gis_traffic', target, gisUrl(target.query), gisPath);
    results.push(gisResult);

    if (results.length === 2) {
      try { fs.copyFileSync(yandexPath, path.join(screenshotsDir, 'yandex-traffic.png')); } catch (e) {}
      try { fs.copyFileSync(gisPath, path.join(screenshotsDir, '2gis-traffic.png')); } catch (e) {}
    }

    writeStatus({
      generated_at: new Date().toISOString(),
      mode: 'station_specific',
      note: 'Скриншоты пробок являются вспомогательным визуальным слоем и не подтверждают наличие АИ-95.',
      targets,
      results
    });
  }

  await browser.close();

  writeStatus({
    generated_at: new Date().toISOString(),
    mode: 'station_specific',
    note: 'Скриншоты пробок являются вспомогательным визуальным слоем и не подтверждают наличие АИ-95.',
    targets,
    results
  });

  console.log(`Wrote ${rel(statusPath)}`);
}

main().catch(e => {
  ensureDir();
  writeStatus({
    generated_at: new Date().toISOString(),
    mode: 'station_specific',
    note: 'Traffic screenshot script failed before completing.',
    targets: [],
    results: [{
      source: 'traffic_screenshots',
      ok: false,
      status: 'screenshot_failed',
      message: String(e.message || e).slice(0, 1200),
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString()
    }]
  });
  console.error(e);
  process.exit(0);
});
