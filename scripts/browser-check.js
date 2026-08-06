const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const browserExecutable = process.env.BROWSER_EXECUTABLE
  || (process.platform === 'win32'
    ? String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`
    : '/usr/bin/google-chrome');
const baseUrl = process.env.APP_URL || 'http://127.0.0.1:4173';
const outputDir = path.join(__dirname, '..', 'artifacts');
fs.mkdirSync(outputDir, { recursive: true });

async function login(page, identifier, password) {
  await page.goto(`${baseUrl}/roommates`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#login-form');
  assert.equal(new URL(page.url()).pathname, '/login');
  assert.equal(new URL(page.url()).searchParams.get('next'), '/roommates');
  assert.equal(await page.locator('.modal').count(), 0);
  assert.equal(await page.locator('[data-demo-id]').count(), 0);
  await page.locator('#login-id').fill(identifier);
  await page.locator('#login-password').fill(password);
  await page.locator('#login-form button[type="submit"]').click();
  await page.waitForSelector('.app-shell');
}

let browser;

(async () => {
  browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
  const errors = [];

  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  desktop.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(`desktop console: ${message.text()}`); });
  desktop.on('pageerror', (error) => errors.push(`desktop page: ${error.message}`));
  const anonymousSessionResponse = desktop.waitForResponse((response) => response.url() === `${baseUrl}/api/me`);
  await desktop.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  assert.equal((await anonymousSessionResponse).status(), 401);
  await desktop.waitForSelector('.public-shell');
  assert.equal(await desktop.locator('.site-logo img').getAttribute('src'), '/assets/logo/透明底白色字.png');
  assert.ok(await desktop.locator('.site-logo img').evaluate((image) => image.complete && image.naturalWidth > 0));
  assert.equal(await desktop.locator('.markdown-article h1').count(), 1);
  assert.equal(await desktop.locator('#site-login').count(), 1);
  assert.equal(await desktop.locator('#site-login').textContent(), '登录');
  assert.equal(await desktop.locator('#site-login').getAttribute('href'), '/login');
  const repositoryLink = desktop.locator('.site-footer a');
  assert.equal(await repositoryLink.getAttribute('href'), 'https://github.com/Crab-Dave/OpenShude');
  assert.equal(await repositoryLink.getAttribute('target'), '_blank');
  assert.equal(await repositoryLink.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(await repositoryLink.locator('svg').count(), 1);
  assert.match(await repositoryLink.textContent(), /Crab-Dave\/OpenShude/);
  await desktop.screenshot({ path: path.join(outputDir, 'homepage-desktop.png'), fullPage: true });
  await desktop.locator('#site-login').click();
  await desktop.waitForSelector('.login-shell');
  assert.equal(new URL(desktop.url()).pathname, '/login');
  assert.equal(await desktop.locator('.modal').count(), 0);
  await desktop.screenshot({ path: path.join(outputDir, 'login-desktop.png'), fullPage: true });
  await desktop.locator('#login-home').click();
  await desktop.waitForSelector('.public-shell');

  await login(desktop, '2026001', 'Student123!');
  await desktop.waitForSelector('.roommate-card');
  const loggedInSessionResponse = desktop.waitForResponse((response) => response.url() === `${baseUrl}/api/me`);
  await desktop.locator('#home-btn').click();
  assert.equal((await loggedInSessionResponse).status(), 200);
  await desktop.waitForSelector('.public-shell');
  assert.equal(await desktop.locator('#site-login').textContent(), '进入系统');
  assert.equal(await desktop.locator('#site-login').getAttribute('href'), '/roommates');
  await desktop.locator('.site-nav a[href="/roommates"]').click();
  await desktop.waitForSelector('.app-shell');
  await desktop.waitForSelector('.roommate-card');
  assert.equal(await desktop.evaluate(async () => {
    try {
      await api('https://example.com/api/users');
      return false;
    } catch (error) {
      return error.message === '接口地址无效';
    }
  }), true);
  assert.equal(await desktop.locator('.roommate-card').count(), 15);
  assert.equal(await desktop.locator('[data-gender]').count(), 2);
  assert.match(await desktop.locator('[data-gender="FEMALE"]').getAttribute('class'), /active/);
  assert.equal(await desktop.locator('.sidebar-brand strong').textContent(), '合住');
  assert.equal(await desktop.locator('.roommate-card.gender-female').count(), 15);
  assert.equal(await desktop.locator('.roommate-card').first().evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(255, 246, 250)');
  assert.equal(await desktop.locator('#search-form input').getAttribute('placeholder'), '搜索姓名');
  assert.equal(await desktop.locator('.roommate-card .card-city').count(), 15);
  assert.equal(await desktop.locator('.roommate-card .card-note').count(), 15);
  assert.equal(await desktop.locator('.roommate-card .card-team').count(), 15);
  assert.equal(await desktop.locator('.roommate-card .card-metrics').count(), 0);
  const ownCard = desktop.locator('.roommate-card').filter({ hasText: '我的卡片' });
  assert.equal(await ownCard.count(), 1);
  assert.match(await ownCard.textContent(), /杭州/);
  assert.match(await ownCard.textContent(), /一缺三/);
  assert.match(await ownCard.textContent(), /我是一个开朗、直接/);
  assert.equal(await desktop.locator('#load-more-cards').count(), 1);
  await desktop.locator('#load-more-cards').click();
  await desktop.waitForFunction(() => document.querySelectorAll('.roommate-card').length === 16);
  assert.equal(await desktop.locator('#load-more-cards').count(), 0);
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
  assert.match(await desktop.locator('.modal').textContent(), /院服尺码/);
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

  await desktop.locator('[data-view="settings"]').first().click();
  await desktop.waitForSelector('#password-form');
  assert.equal(await desktop.locator('#deactivate-btn').count(), 0);

  await desktop.locator('[data-view="dorm"]').first().click();
  await desktop.waitForSelector('.stage-banner');
  assert.match(await desktop.locator('.stage-banner').textContent(), /默认选宿舍轮次/);
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
  assert.doesNotMatch(await desktop.locator('.modal').textContent(), /院服尺码/);
  await desktop.locator('[data-message]').click();
  await desktop.waitForSelector('#chat-messages');
  const chatLayout = await desktop.locator('.message-workspace').evaluate((workspace) => {
    const messages = workspace.querySelector('#chat-messages');
    const compose = workspace.querySelector('#message-form');
    for (let index = 0; index < 80; index += 1) {
      const message = document.createElement('div');
      message.className = `message ${index % 2 ? 'mine' : ''}`;
      message.textContent = `布局验收消息 ${index + 1}：${'较长内容'.repeat(12)}`;
      messages.append(message);
    }
    messages.scrollTop = messages.scrollHeight;
    const workspaceBox = workspace.getBoundingClientRect();
    const composeBox = compose.getBoundingClientRect();
    return {
      bodyFitsViewport: document.documentElement.scrollHeight <= window.innerHeight + 1,
      composeVisible: composeBox.top >= workspaceBox.top && composeBox.bottom <= workspaceBox.bottom + 1,
      messagesScrollable: messages.scrollHeight > messages.clientHeight && messages.scrollTop > 0,
      messagesOverflow: getComputedStyle(messages).overflowY,
    };
  });
  assert.equal(chatLayout.bodyFitsViewport, true);
  assert.equal(chatLayout.composeVisible, true);
  assert.equal(chatLayout.messagesScrollable, true);
  assert.equal(chatLayout.messagesOverflow, 'auto');
  const loggedOutSessionResponse = desktop.waitForResponse((response) => response.url() === `${baseUrl}/api/me`);
  await desktop.locator('#logout-btn').click();
  assert.equal((await loggedOutSessionResponse).status(), 401);
  await desktop.waitForSelector('.public-shell');
  assert.equal(await desktop.locator('#site-login').textContent(), '登录');
  assert.equal(await desktop.locator('#site-login').getAttribute('href'), '/login');
  await login(desktop, '2026002', 'Student123!');
  await desktop.locator('[data-view="messages"]').first().click();
  await desktop.waitForSelector('.message-workspace');
  assert.equal(await desktop.getByText('页面加载失败').count(), 0);

  const admin = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  admin.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(`admin console: ${message.text()}`); });
  admin.on('pageerror', (error) => errors.push(`admin page: ${error.message}`));
  await login(admin, 'admin', 'Admin123!');
  await admin.waitForSelector('.stats-grid');
  assert.equal(await admin.locator('.stat').count(), 4);
  assert.match(await admin.locator('.panel').textContent(), /默认选宿舍轮次/);
  assert.equal(await admin.locator('[data-view="rounds"]').count() > 0, true);
  await admin.screenshot({ path: path.join(outputDir, 'admin-desktop.png'), fullPage: true });
  await admin.locator('[data-view="users"]').first().click();
  await admin.waitForSelector('#export-users');
  await admin.locator('#admin-user-search').fill('分页同学01');
  assert.equal(await admin.locator('[data-reset-password]').count(), 1);
  await admin.locator('[data-reset-password]').click();
  assert.match(await admin.locator('.modal').textContent(), /临时密码重置为当前登录标识/);
  assert.match(await admin.locator('.modal code').textContent(), /browser-page-01/);
  await admin.locator('#password-reset-reason').fill('浏览器验收密码重置');
  await admin.locator('.modal [data-confirm]').click();
  await admin.locator('.modal').waitFor({ state: 'detached' });
  await admin.waitForSelector('#export-users');
  const userDownloadPromise = admin.waitForEvent('download');
  await admin.locator('#export-users').click();
  const userDownload = await userDownloadPromise;
  assert.match(userDownload.suggestedFilename(), /^users-\d{4}-\d{2}-\d{2}\.xlsx$/);
  await admin.waitForSelector('#update-login-identifiers');
  await admin.locator('#update-login-identifiers').click();
  await admin.waitForSelector('#login-identifier-batch-form');
  assert.match(await admin.locator('#login-identifier-batch-form').textContent(), /整批校验并更新/);
  await admin.locator('#login-identifier-batch-form [data-cancel]').click();
  assert.equal(await admin.locator('[data-view="homepage"]').count(), 0);
  await admin.locator('[data-view="rounds"]').first().click();
  await admin.waitForSelector('#create-round');
  await admin.locator('#manage-selection-groups').click();
  await admin.waitForSelector('#create-selection-group');
  await admin.locator('#create-selection-group').click();
  await admin.waitForSelector('#selection-group-form');
  await admin.locator('#selection-group-form [name="name"]').fill('浏览器验收学生群组');
  await admin.locator('#selection-group-member-search').fill('沈知行');
  assert.equal(await admin.locator('#selection-group-candidates .candidate:visible').count(), 1);
  await admin.locator('#selection-group-member-search').fill('');
  await admin.locator('#selection-group-candidates .candidate', { hasText: '林夏' }).locator('input').check();
  await admin.locator('#selection-group-candidates .candidate', { hasText: '沈知行' }).locator('input').check();
  await admin.locator('#selection-group-form .modal-actions .btn-primary').click();
  await admin.locator('.selection-group-item', { hasText: '浏览器验收学生群组' }).waitFor();
  await admin.locator('.modal [data-close]').click();
  await admin.locator('#create-round').click();
  await admin.waitForSelector('#round-form');
  await admin.locator('#round-form [name="code"]').fill(`BROWSER_ROUND_${Date.now()}`);
  await admin.locator('#round-form [name="name"]').fill('浏览器验收轮次');
  await admin.locator('#round-form [data-person-search="round"]').fill('林夏');
  assert.equal(await admin.locator('#round-form [data-person-picker="round"] .candidate:visible').count(), 1);
  await admin.locator('#round-form [data-person-search="round"]').fill('');
  const roundSelectionGroupValue = await admin.locator('#round-form [data-person-group="round"] option', { hasText: '浏览器验收学生群组' }).getAttribute('value');
  await admin.locator('#round-form [data-person-group="round"]').selectOption(roundSelectionGroupValue);
  await admin.locator('#round-form [data-add-person-group="round"]').click();
  assert.equal(await admin.locator('#round-form [name="participantIds"]:checked').count(), 2);
  await admin.locator('#round-form .modal-actions .btn-primary').click();
  await admin.waitForSelector('.modal', { state: 'detached' });
  const browserRound = admin.locator('.round-admin-card', { hasText: '浏览器验收轮次' });
  await browserRound.waitFor();
  assert.equal(await browserRound.count(), 1);
  assert.equal(await browserRound.locator('[data-edit-round]').count(), 1);
  assert.equal(await browserRound.locator('[data-round-action="open"]').count(), 1);
  await admin.locator('[data-view="access"]').first().click();
  await admin.waitForSelector('#create-admin-group');
  assert.match(await admin.locator('#page-content').textContent(), /权限和年级范围必须由同一个组提供/);
  await admin.locator('#create-admin-group').click();
  await admin.locator('#create-group-form [name="code"]').fill(`BROWSER_${Date.now()}`);
  await admin.locator('#create-group-form [name="name"]').fill('浏览器验收管理员组');
  await admin.locator('#create-group-form [name="description"]').fill('验证组管理员工作台切换和动态菜单');
  await admin.locator('#create-group-form .btn-primary').click();
  await admin.waitForSelector('.access-card');
  await admin.locator('.access-card', { hasText: '浏览器验收管理员组' }).locator('[data-configure-group]').click();
  await admin.waitForSelector('#configure-group-form');
  const gradeInputId = await admin.locator('#configure-group-form label[for^="grade-"]', { hasText: /^2026级$/ }).getAttribute('for');
  for (const selector of [`#${gradeInputId}`, '#permission-USER_READ', '#permission-DORMITORY_READ']) {
    await admin.locator(selector).evaluate((element) => { element.checked = true; });
  }
  await admin.locator('#configure-group-form [data-person-search="admin-member"]').fill('沈知行');
  assert.equal(await admin.locator('#configure-group-form [data-person-picker="admin-member"] .candidate:visible').count(), 1);
  await admin.locator('#configure-group-form [data-person-search="admin-member"]').fill('');
  const adminSelectionGroupValue = await admin.locator('#configure-group-form [data-person-group="admin-member"] option', { hasText: '浏览器验收学生群组' }).getAttribute('value');
  await admin.locator('#configure-group-form [data-person-group="admin-member"]').selectOption(adminSelectionGroupValue);
  await admin.locator('#configure-group-form [data-add-person-group="admin-member"]').click();
  await admin.locator('#configure-group-form [name="reason"]').fill('浏览器权限验收');
  await admin.locator('#configure-group-form .btn-primary').click();
  await admin.waitForSelector('.modal', { state: 'detached' });
  const configuredGroup = admin.locator('.access-card', { hasText: '浏览器验收管理员组' });
  await configuredGroup.filter({ hasText: '沈知行' }).waitFor();
  assert.match(await configuredGroup.textContent(), /沈知行/);
  assert.match(await configuredGroup.textContent(), /2026级/);
  assert.match(await configuredGroup.textContent(), /查看用户/);
  await admin.locator('[data-view="groups"]').first().click();
  await admin.waitForSelector('#export-dormitories');
  assert.equal(await admin.locator('#admin-round-select').count(), 1);
  const downloadPromise = admin.waitForEvent('download');
  await admin.locator('#export-dormitories').click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^dormitories-LEGACY_INITIAL-\d{4}-\d{2}-\d{2}\.xlsx$/);

  const groupAdmin = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
  groupAdmin.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(`group admin console: ${message.text()}`); });
  groupAdmin.on('pageerror', (error) => errors.push(`group admin page: ${error.message}`));
  await login(groupAdmin, '2026005', 'Student123!');
  await groupAdmin.waitForSelector('.roommate-card');
  assert.equal(await groupAdmin.locator('#switch-mode').count(), 1);
  assert.match(await groupAdmin.locator('#switch-mode').textContent(), /进入管理工作台/);
  await groupAdmin.locator('#switch-mode').click();
  await groupAdmin.waitForSelector('.stats-grid');
  assert.equal(await groupAdmin.locator('[data-view="users"]').count() > 0, true);
  assert.equal(await groupAdmin.locator('[data-view="groups"]').count() > 0, true);
  assert.equal(await groupAdmin.locator('[data-view="rounds"]').count(), 0);
  assert.equal(await groupAdmin.locator('[data-view="cards"]').count(), 0);
  assert.equal(await groupAdmin.locator('[data-view="access"]').count(), 0);
  assert.equal(await groupAdmin.locator('[data-view="homepage"]').count(), 0);
  assert.match(await groupAdmin.locator('#switch-mode').textContent(), /返回学生端/);
  await groupAdmin.close();

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  mobile.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) errors.push(`mobile console: ${message.text()}`); });
  mobile.on('pageerror', (error) => errors.push(`mobile page: ${error.message}`));
  const mobileSessionResponse = mobile.waitForResponse((response) => response.url() === `${baseUrl}/api/me`);
  await mobile.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  assert.equal((await mobileSessionResponse).status(), 401);
  await mobile.waitForSelector('.public-shell');
  assert.ok(await mobile.locator('.site-logo img').evaluate((image) => image.complete && image.naturalWidth > 0));
  assert.equal(await mobile.locator('.site-footer a').count(), 1);
  const homepageBodyWidth = await mobile.locator('body').evaluate((element) => element.scrollWidth);
  assert.ok(homepageBodyWidth <= 390, `mobile homepage overflows: ${homepageBodyWidth}px`);
  await mobile.screenshot({ path: path.join(outputDir, 'homepage-mobile.png'), fullPage: true });
  await login(mobile, '2026005', 'Student123!');
  await mobile.waitForSelector('.roommate-card');
  assert.equal(await mobile.locator('.mobile-nav').evaluate((element) => getComputedStyle(element).display), 'grid');
  const bodyWidth = await mobile.locator('body').evaluate((element) => element.scrollWidth);
  assert.ok(bodyWidth <= 390, `mobile body overflows: ${bodyWidth}px`);
  await mobile.locator('.roommate-card').first().click();
  const cardModal = mobile.locator('.modal');
  const closeCardButton = cardModal.locator('[data-close]');
  await closeCardButton.waitFor();
  const closeCardButtonBox = await closeCardButton.boundingBox();
  assert.ok(closeCardButtonBox && closeCardButtonBox.x >= 0 && closeCardButtonBox.y >= 0);
  assert.ok(closeCardButtonBox.x + closeCardButtonBox.width <= 390);
  assert.ok(closeCardButtonBox.y + closeCardButtonBox.height <= 844);
  await closeCardButton.click();
  await assert.rejects(() => cardModal.waitFor({ state: 'visible', timeout: 250 }));
  await mobile.screenshot({ path: path.join(outputDir, 'student-mobile.png'), fullPage: true });
  await mobile.locator('[data-view="dorm"]').last().click();
  await mobile.waitForSelector('.stage-banner');
  const dormBodyWidth = await mobile.locator('body').evaluate((element) => element.scrollWidth);
  assert.ok(dormBodyWidth <= 390, `mobile dormitory page overflows: ${dormBodyWidth}px`);
  await mobile.screenshot({ path: path.join(outputDir, 'dormitory-mobile.png'), fullPage: true });

  await browser.close();
  browser = null;
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: static homepage, cards, permissions, dormitories, export, and mobile layouts.');
})().catch(async (error) => {
  if (browser) await browser.close();
  console.error(error);
  process.exitCode = 1;
});
