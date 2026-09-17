const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright-core');

const browserExecutable = process.env.BROWSER_EXECUTABLE
  || String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`;
const source = path.join(__dirname, 'activity-plaza-mockups.html');
const output = path.join(__dirname, '..', 'assets', 'activity-plaza');

const screens = [
  ['month', 'activity-plaza-month-desktop.png', { width: 1440, height: 900 }],
  ['week', 'activity-plaza-week-crowded-desktop.png', { width: 1440, height: 900 }],
  ['detail', 'activity-plaza-detail-desktop.png', { width: 1440, height: 900 }],
  ['create', 'activity-plaza-create-desktop.png', { width: 1440, height: 900 }],
  ['mobile', 'activity-plaza-day-mobile.png', { width: 390, height: 844 }],
];

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
  try {
    for (const [screen, filename, viewport] of screens) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
      await page.goto(`${pathToFileURL(source).href}?screen=${screen}`, { waitUntil: 'load' });
      await page.screenshot({ path: path.join(output, filename) });
      await page.close();
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
