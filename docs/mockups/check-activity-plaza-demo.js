const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright-core');

const browserExecutable = process.env.BROWSER_EXECUTABLE
  || String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`;
const demoUrl = process.env.DEMO_URL || pathToFileURL(path.join(__dirname, 'activity-plaza-demo.html')).href;
const output = path.join(__dirname, '..', '..', 'artifacts');

(async () => {
  const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
  const errors = [];
  try {
    fs.mkdirSync(output, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(demoUrl, { waitUntil: 'load' });
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: 'load' });

    assert.match(await page.locator('#range-title').textContent(), /2026 年 9 月/);
    assert.equal(await page.locator('.month-grid').count(), 1);
    await page.locator('[data-manage-groups]:visible').click();
    assert.match(await page.locator('#group-manager-title').textContent(), /管理我的群组/);
    await page.locator('#group-name').fill('周末运动搭子');
    await page.locator('#group-form input[name="members"]').first().check();
    await page.locator('#group-form button[type="submit"]').click();
    assert.match(await page.locator('.group-manager-list').textContent(), /周末运动搭子/);
    await page.locator('[data-close-modal]').first().click();
    await page.screenshot({ path: path.join(output, 'activity-demo-month.png') });

    await page.locator('[data-view="year"]:visible').click();
    assert.equal(await page.locator('.mini-month').count(), 12);
    await page.locator('[data-view="week"]:visible').click();
    assert.ok(await page.locator('.week-cluster').count() >= 1);
    assert.match(await page.locator('.week-cluster').first().textContent(), /18 个/);
    await page.screenshot({ path: path.join(output, 'activity-demo-week.png') });
    await page.locator('[data-nav="previous"]').click();
    assert.match(await page.locator('.week-all-day').textContent(), /社团招新周/);
    await page.locator('[data-nav="next"]').click();
    await page.locator('[data-view="day"]:visible').click();
    assert.ok(await page.locator('.time-group').count() >= 2);
    await page.locator('[data-view="month"]:visible').click();

    await page.locator('[data-open-day="2026-09-17"]').click();
    await page.locator('#activity-drawer.open').waitFor();
    assert.match(await page.locator('#activity-drawer').textContent(), /23 个活动/);
    await page.locator('#activity-drawer [data-event="1"]').first().click();
    await page.locator('#detail-page:not([hidden])').waitFor();
    assert.match(await page.locator('#detail-page h2').textContent(), /新生安全教育/);

    await page.locator('[data-join="1"]:visible').click();
    assert.match(await page.locator('[data-join="1"]:visible').textContent(), /取消报名/);
    await page.locator('[data-template="1"]').click();
    await page.locator('#activity-form').waitFor();
    assert.match(await page.locator('.template-note').textContent(), /调整为 III 级/);
    assert.ok(await page.locator('input[name="targetGroups"]').count() >= 3);
    await page.locator('[data-preview-form]').click();
    await page.locator('.modal').waitFor();
    await page.locator('[data-close-modal]').first().click();
    await page.locator('#activity-title').fill('交互 Demo 测试活动');
    await page.locator('#activity-form button[value="publish"]').click();
    await page.locator('#detail-page:not([hidden])').waitFor();
    assert.match(await page.locator('#detail-page h2').textContent(), /交互 Demo 测试活动/);

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    mobile.on('pageerror', (error) => errors.push(error.message));
    await mobile.goto(demoUrl, { waitUntil: 'load' });
    assert.equal(await mobile.locator('.bottom-nav').evaluate((element) => getComputedStyle(element).display), 'grid');
    assert.equal(await mobile.locator('#activity-filters').evaluate((element) => getComputedStyle(element).display), 'none');
    await mobile.locator('[data-toggle-filters]').click();
    assert.equal(await mobile.locator('#activity-filters').evaluate((element) => getComputedStyle(element).display), 'grid');
    await mobile.locator('[data-toggle-filters]').click();
    assert.equal(await mobile.locator('.day-strip').count(), 1);
    assert.match(await mobile.locator('.time-group').filter({ hasText: '20 个重叠活动' }).textContent(), /展开其余 17 个/);
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await mobile.screenshot({ path: path.join(output, 'activity-demo-mobile.png') });

    assert.deepEqual(errors, []);
    console.log('Activity plaza demo browser checks passed.');
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
