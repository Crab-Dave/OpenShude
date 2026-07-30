const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const baseUrl = process.env.APP_URL || 'http://127.0.0.1:4173';
const outputDir = path.join(__dirname, '..', 'artifacts');
fs.mkdirSync(outputDir, { recursive: true });

async function login(page, identifier, password) {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('[data-demo-id]').count(), 13);
  await page.locator('#login-id').fill(identifier);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForSelector('.app-shell');
}

let browser;

(async () => {
  browser = await chromium.launch({ executablePath: edge, headless: true });
  const errors = [];

  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  desktop.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(`desktop console: ${message.text()}`); });
  desktop.on('pageerror', (error) => errors.push(`desktop page: ${error.message}`));
  await login(desktop, '2026001', 'Student123!');
  await desktop.waitForSelector('.roommate-card');
  assert.equal(await desktop.locator('.roommate-card').count(), 6);
  assert.equal(await desktop.locator('[data-gender]').count(), 2);
  assert.match(await desktop.locator('[data-gender="FEMALE"]').getAttribute('class'), /active/);
  assert.equal(await desktop.locator('.sidebar-brand strong').textContent(), '合住');
  assert.equal(await desktop.locator('.roommate-card.gender-female').count(), 6);
  assert.equal(await desktop.locator('.roommate-card').first().evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(255, 246, 250)');
  assert.equal(await desktop.locator('#search-form input').getAttribute('placeholder'), '搜索姓名');
  assert.equal(await desktop.locator('.roommate-card .card-city').count(), 6);
  assert.equal(await desktop.locator('.roommate-card .card-note').count(), 6);
  assert.equal(await desktop.locator('.roommate-card .card-team').count(), 6);
  assert.equal(await desktop.locator('.roommate-card .card-metrics').count(), 0);
  const ownCard = desktop.locator('.roommate-card').filter({ hasText: '我的卡片' });
  assert.equal(await ownCard.count(), 1);
  assert.match(await ownCard.textContent(), /杭州/);
  assert.match(await ownCard.textContent(), /一缺三/);
  assert.match(await ownCard.textContent(), /我是一个开朗、直接/);
  await desktop.locator('[data-gender="MALE"]').click();
  await desktop.waitForFunction(() => document.querySelector('[data-gender="MALE"]')?.classList.contains('active'));
  await desktop.locator('.roommate-card h3', { hasText: '陈遇' }).waitFor();
  assert.equal(await desktop.locator('.roommate-card').count(), 6);
  assert.equal(await desktop.locator('.roommate-card.gender-male').count(), 6);
  assert.equal(await desktop.locator('.roommate-card').first().evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(245, 249, 255)');
  assert.equal(await desktop.locator('.roommate-card').filter({ hasText: '我的卡片' }).count(), 0);
  await desktop.locator('[data-gender="FEMALE"]').click();
  await desktop.waitForFunction(() => document.querySelector('[data-gender="FEMALE"]')?.classList.contains('active'));
  await desktop.locator('.roommate-card h3', { hasText: '林夏' }).waitFor();
  assert.equal(await desktop.locator('.roommate-card').filter({ hasText: '我的卡片' }).count(), 1);
  await desktop.screenshot({ path: path.join(outputDir, 'student-desktop.png'), fullPage: true });

  await ownCard.click();
  await desktop.waitForSelector('.modal');
  assert.match(await desktop.locator('.modal').textContent(), /个人信息/);
  assert.match(await desktop.locator('.modal').textContent(), /生活节奏与空调/);
  assert.match(await desktop.locator('.modal').textContent(), /卫生与公共空间/);
  assert.match(await desktop.locator('.modal').textContent(), /游戏、声音与相处边界/);
  assert.match(await desktop.locator('.modal').textContent(), /用一句话介绍自己/);
  const detailText = await desktop.locator('.modal').textContent();
  assert.ok(detailText.indexOf('性格与兴趣') < detailText.indexOf('生活节奏与空调'));
  assert.equal((await desktop.locator('.modal .section-heading h2').allTextContents()).at(-1), '还想要对大家说');
  assert.equal(await desktop.locator('[data-edit-own]').count(), 1);
  await desktop.screenshot({ path: path.join(outputDir, 'card-detail.png'), fullPage: true });
  await desktop.locator('[data-edit-own]').click();

  await desktop.waitForSelector('#profile-form');
  assert.equal(await desktop.locator('#profile-form input:disabled').count(), 4);
  assert.equal(await desktop.locator('.size-guide').count(), 1);
  await desktop.locator('.size-guide summary').click();
  assert.equal(await desktop.locator('.size-table tbody tr').count(), 7);
  assert.equal(await desktop.locator('[name="clothing_size"] option').count(), 8);
  assert.equal(await desktop.locator('[name="personal_cleanliness"] option').count(), 4);
  assert.equal(await desktop.locator('[name="common_space_maintenance"] option').count(), 5);
  assert.equal(await desktop.locator('[name="one_sentence_intro"]').count(), 1);
  assert.equal(await desktop.locator('[data-unpublish]').count(), 0);
  assert.equal(await desktop.locator('#profile-form button[type="submit"]').textContent(), '更新卡片');
  assert.equal(await desktop.locator('[data-publish]').count(), 0);
  const personalitySection = desktop.locator('#profile-form .section').filter({ hasText: '性格与兴趣' });
  assert.equal(await personalitySection.locator('[name="self_acknowledged_shortcoming"]').count(), 1);
  assert.equal((await desktop.locator('#profile-form .section-heading h2').allTextContents()).at(-1), '还想要对大家说');
  assert.equal(await desktop.locator('#profile-form').getAttribute('data-overflow'), null);

  await desktop.locator('[data-view="dorm"]').first().click();
  await desktop.waitForSelector('.stage-banner');
  assert.match(await desktop.locator('.stage-banner').textContent(), /自由选宿舍阶段/);
  if (await desktop.locator('#create-dorm').count()) {
    await desktop.locator('#create-dorm').click();
    await desktop.waitForSelector('#create-dorm-form');
    assert.match(await desktop.locator('.modal').textContent(), /新建宿舍并加入/);
    assert.equal(await desktop.locator('#create-dorm-form [name="building"]').count(), 0);
    assert.equal(await desktop.locator('#create-dorm-form [name="roomNumber"]').count(), 0);
    assert.equal(await desktop.locator('#create-dorm-form [name="capacity"]').count(), 0);
    await desktop.locator('#create-dorm-form [name="name"]').fill('浏览器验收宿舍');
    await desktop.locator('#create-dorm-form .btn-primary').click();
    await desktop.waitForSelector('.dormitory-card.current');
  }
  assert.equal(await desktop.locator('.dormitory-card.current').count(), 1);
  assert.match(await desktop.locator('.dormitory-card').first().getAttribute('class'), /current/);
  assert.equal(await desktop.locator('.dormitory-card').count(), await desktop.locator('.dormitory-members').count());
  assert.match(await desktop.locator('.dormitory-card.current').textContent(), /林夏/);
  assert.equal(await desktop.locator('.dormitory-card.current [data-leave-dorm]').count(), 1);
  await desktop.screenshot({ path: path.join(outputDir, 'dormitory-desktop.png'), fullPage: true });

  await desktop.locator('[data-view="discover"]').first().click();
  await desktop.waitForSelector('.roommate-card');
  await desktop.locator('.roommate-card').filter({ hasText: '苏晴' }).click();
  await desktop.locator('[data-message]').click();
  await desktop.waitForSelector('.message-workspace');
  await desktop.locator('#logout-btn').click();
  await desktop.waitForSelector('#login-form');
  await desktop.locator('#login-id').fill('2026002');
  await desktop.locator('#login-password').fill('Student123!');
  await desktop.locator('#login-form button[type="submit"]').click();
  await desktop.waitForSelector('.app-shell');
  await desktop.locator('[data-view="messages"]').first().click();
  await desktop.waitForSelector('.message-workspace');
  assert.equal(await desktop.getByText('页面加载失败').count(), 0);

  const admin = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  admin.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(`admin console: ${message.text()}`); });
  admin.on('pageerror', (error) => errors.push(`admin page: ${error.message}`));
  await login(admin, 'admin', 'Admin123!');
  await admin.waitForSelector('.stats-grid');
  assert.equal(await admin.locator('.stat').count(), 4);
  assert.match(await admin.locator('.panel').textContent(), /自由选宿舍阶段/);
  assert.equal(await admin.locator('#toggle-dorm-stage').count(), 1);
  await admin.screenshot({ path: path.join(outputDir, 'admin-desktop.png'), fullPage: true });
  await admin.locator('[data-view="groups"]').first().click();
  await admin.waitForSelector('#export-dormitories');
  const downloadPromise = admin.waitForEvent('download');
  await admin.locator('#export-dormitories').click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^dormitories-\d{4}-\d{2}-\d{2}\.xlsx$/);

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  mobile.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(`mobile console: ${message.text()}`); });
  mobile.on('pageerror', (error) => errors.push(`mobile page: ${error.message}`));
  await login(mobile, '2026005', 'Student123!');
  await mobile.waitForSelector('.roommate-card');
  assert.equal(await mobile.locator('.mobile-nav').evaluate((element) => getComputedStyle(element).display), 'grid');
  const bodyWidth = await mobile.locator('body').evaluate((element) => element.scrollWidth);
  assert.ok(bodyWidth <= 390, `mobile body overflows: ${bodyWidth}px`);
  await mobile.screenshot({ path: path.join(outputDir, 'student-mobile.png'), fullPage: true });
  await mobile.locator('[data-view="dorm"]').last().click();
  await mobile.waitForSelector('.stage-banner');
  const dormBodyWidth = await mobile.locator('body').evaluate((element) => element.scrollWidth);
  assert.ok(dormBodyWidth <= 390, `mobile dormitory page overflows: ${dormBodyWidth}px`);
  await mobile.screenshot({ path: path.join(outputDir, 'dormitory-mobile.png'), fullPage: true });

  await browser.close();
  browser = null;
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: documented card fields, purple theme, gender cards, Excel export, dormitory selection, and mobile layouts.');
})().catch(async (error) => {
  if (browser) await browser.close();
  console.error(error);
  process.exitCode = 1;
});
