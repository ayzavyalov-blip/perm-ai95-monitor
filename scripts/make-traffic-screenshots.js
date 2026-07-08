const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const screenshotsDir = path.join(process.cwd(), 'screenshots');
const statusPath = path.join(screenshotsDir, 'traffic-status.json');

function ensureDir() {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

function rel(p) {
  return p.replace(process.cwd() + path.sep, '').replaceAll('\\', '/');
}

function writeStatus(results) {
  fs.writeFileSync(statusPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    note: 'Скриншоты пробок являются вспомогательным визуальным слоем и не подтверждают наличие АИ-95.',
    results
  }, null, 2), 'utf8');
}

async function closeKnownPopups(page) {
  const candidates = [
    'button:has-text("Понятно")',
    'button:has-text("Хорошо")',
    'button:has-text("Принять")',
    'button:has-text("Согласен")',
    'button:has-text("Разрешить")',
    'button:has-text("Не сейчас")',
    'button:has-text("Закрыть")',
    '[aria-label="Закрыть"]',
    '[aria-label="Close"]'
  ];

  for (const selector of candidates) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.isVisible({ timeout: 1000 })) {
        await locator.click({ timeout: 1000 });
        await page.waitForTimeout(400);
      }
    } catch (e) {}
  }
}

async function writeFallbackImage(browser, item, message) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const html = `
    <!doctype html>
    <html lang="ru">
      <head>
        <meta charset="utf-8">
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
          <p><b>Источник:</b> ${item.name}</p>
          <p><b>URL:</b> <code>${item.url}</code></p>
          <p><b>Ошибка:</b> <code>${String(message).slice(0, 1200)}</code></p>
          <p>Возможны ограничения для GitHub Actions, динамическая карта, баннер, CAPTCHA, таймаут или сетевые ограничения.</p>
        </div>
      </body>
    </html>
  `;
  await page.setContent(html, { waitUntil: 'domcontentloaded' });
  await page.screenshot({ path: item.screenshotPath, fullPage: true });
  await page.close();
}

async function capture(browser, item) {
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
    await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 70000 });
    await page.waitForTimeout(item.waitMs || 25000);
    await closeKnownPopups(page);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: item.screenshotPath, fullPage: true });
    await context.close();

    return {
      source: item.name,
      url: item.url,
      ok: true,
      status: 'screenshot_saved',
      screenshot_path: rel(item.screenshotPath),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      message: 'Скриншот сохранён. Это визуальный слой пробок, не подтверждение наличия АИ-95.'
    };
  } catch (e) {
    await context.close();
    try {
      await writeFallbackImage(browser, item, e.message || String(e));
    } catch (fallbackError) {}

    return {
      source: item.name,
      url: item.url,
      ok: false,
      status: 'screenshot_failed',
      screenshot_path: rel(item.screenshotPath),
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      message: String(e.message || e).slice(0, 1200)
    };
  }
}

async function main() {
  ensureDir();

  const pages = [
    {
      name: 'yandex_maps_traffic',
      url: 'https://yandex.ru/maps/50/perm/probki/',
      screenshotPath: path.join(screenshotsDir, 'yandex-traffic.png'),
      waitMs: 25000
    },
    {
      name: '2gis_traffic',
      url: 'https://2gis.ru/perm?traffic',
      screenshotPath: path.join(screenshotsDir, '2gis-traffic.png'),
      waitMs: 25000
    }
  ];

  let browser;
  const results = [];

  try {
    browser = await chromium.launch({ headless: true });
    for (const item of pages) {
      const result = await capture(browser, item);
      results.push(result);
      writeStatus(results);
    }
    await browser.close();
  } catch (e) {
    if (browser) {
      try { await browser.close(); } catch (closeError) {}
    }

    for (const item of pages) {
      if (!results.find(r => r.source === item.name)) {
        results.push({
          source: item.name,
          url: item.url,
          ok: false,
          status: 'screenshot_failed',
          screenshot_path: rel(item.screenshotPath),
          started_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          message: String(e.message || e).slice(0, 1200)
        });
      }
    }
  }

  writeStatus(results);
  console.log(`Wrote ${rel(statusPath)}`);
}

main().catch(e => {
  ensureDir();
  writeStatus([{
    source: 'traffic_screenshots',
    ok: false,
    status: 'screenshot_failed',
    message: String(e.message || e).slice(0, 1200),
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString()
  }]);
  console.error(e);
  process.exit(0);
});
