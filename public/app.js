const app = document.querySelector('#app');
const modalRoot = document.querySelector('#modal-root');
const toastRoot = document.querySelector('#toast-root');
const demoAccounts = [
  ['admin', '管理员', 'Admin123!'],
  ['2026001', '林夏', 'Student123!'],
  ['2026002', '陈遇', 'Student123!'],
  ['2026003', '苏晴', 'Student123!'],
  ['2026004', '周屿', 'Student123!'],
  ['2026005', '沈知行', 'Student123!'],
  ['2026006', '江晚', 'Student123!'],
  ['2026007', '许舟', 'Student123!'],
  ['2026008', '唐宁', 'Student123!'],
  ['2026009', '顾言', 'Student123!'],
  ['2026010', '叶澜', 'Student123!'],
  ['2026011', '陆川', 'Student123!'],
  ['2026012', '温然', 'Student123!'],
];

const state = {
  user: null,
  csrfToken: '',
  view: 'discover',
  selectedConversationId: null,
  search: '',
  grade: '',
  availability: 'AVAILABLE',
  gender: null,
  applicationDormitoryId: null,
};

const labels = {
  cleanliness: { RELAXED: '宽松', NORMAL: '一般', STRICT: '严格' },
  gaming: { FREQUENT: '经常游戏', OCCASIONAL: '偶尔游戏', RARELY: '基本不玩' },
  tolerance: { TOLERATE: '不介意', CONDITIONAL: '分时段', MIND: '介意' },
  cardStatus: { DRAFT: '草稿', PUBLISHED: '已发布', HIDDEN: '已隐藏' },
  userStatus: { PENDING_ACTIVATION: '待激活', ACTIVE: '正常', SUSPENDED: '已停用', BANNED: '已封禁', DEACTIVATED: '已注销' },
  dormitoryStatus: { OPEN: '可申请', FULL: '已满员', CLOSED: '已关闭' },
  applicationStatus: { PENDING: '待审核', APPROVED: '已通过', REJECTED: '已拒绝', CANCELLED: '已取消' },
  reportStatus: { PENDING: '待处理', RESOLVED: '已处理', REJECTED: '不成立' },
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

function icon(name) {
  return `<i data-lucide="${name}" aria-hidden="true"></i>`;
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons();
}

function formatDate(value, withTime = true) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', withTime
    ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: 'numeric', day: 'numeric' }).format(new Date(value));
}

function statusBadge(text, type, iconName = 'circle-dot') {
  return `<span class="status-badge status-${type.toLowerCase()}">${icon(iconName)}${escapeHtml(text)}</span>`;
}

function avatar(url, name, size = '') {
  const safe = url || '/assets/avatar-1.png';
  return `<img class="avatar ${size}" src="${escapeHtml(safe)}" alt="${escapeHtml(name)}的头像">`;
}

function toast(message, kind = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${kind === 'error' ? 'error' : ''}`;
  item.innerHTML = `${icon(kind === 'error' ? 'circle-alert' : 'circle-check')}<span>${escapeHtml(message)}</span>`;
  toastRoot.append(item);
  refreshIcons();
  setTimeout(() => item.remove(), 3200);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.csrfToken && !['GET', 'HEAD'].includes(options.method || 'GET')) headers['X-CSRF-Token'] = state.csrfToken;
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.user) {
      state.user = null;
      renderLogin();
    }
    const error = new Error(data.error?.message || '请求失败，请稍后重试');
    error.code = data.error?.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

function openModal(title, body, { wide = false } = {}) {
  modalRoot.innerHTML = `
    <div class="modal-backdrop">
      <section class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <header class="modal-head">
          <h2>${escapeHtml(title)}</h2>
          <button class="btn btn-quiet icon-btn" data-close title="关闭">${icon('x')}</button>
        </header>
        <div class="modal-body">${body}</div>
      </section>
    </div>`;
  modalRoot.querySelector('[data-close]').addEventListener('click', closeModal);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (event) => {
    if (event.target.classList.contains('modal-backdrop')) closeModal();
  });
  refreshIcons();
  return modalRoot.querySelector('.modal');
}

function closeModal() {
  modalRoot.innerHTML = '';
}

function emptyState(iconName, title, text, action = '') {
  return `<div class="empty-state">${icon(iconName)}<h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>${action}</div>`;
}

function setPage(content) {
  const page = document.querySelector('#page-content');
  if (page) page.innerHTML = content;
  refreshIcons();
}

const studentNav = [
  ['discover', 'users-round', '找室友'],
  ['profile', 'contact-round', '我的卡片'],
  ['messages', 'messages-square', '私信'],
  ['dorm', 'bed-double', '宿舍组'],
  ['settings', 'settings', '账号设置'],
];

const adminNav = [
  ['overview', 'layout-dashboard', '数据概览'],
  ['users', 'users', '账号管理'],
  ['cards', 'contact-round', '卡片治理'],
  ['groups', 'bed-double', '宿舍组'],
  ['reports', 'shield-alert', '举报处理'],
  ['audit', 'scroll-text', '审计日志'],
];

const titles = {
  discover: ['找室友', '浏览已发布的室友卡片'],
  profile: ['我的室友卡片', '维护你的生活习惯与室友偏好'],
  messages: ['私信', '与意向室友继续沟通'],
  dorm: ['自由选宿舍', '创建宿舍或申请加入同性别宿舍'],
  settings: ['账号设置', '身份字段由管理员统一维护'],
  overview: ['数据概览', '平台当前运行状态'],
  users: ['账号管理', '导入正式账号并维护身份字段'],
  cards: ['卡片治理', '处理公开卡片中的违规内容'],
  groups: ['宿舍组管理', '查看和处理异常宿舍组'],
  reports: ['举报处理', '仅查看用户主动提交的举报快照'],
  audit: ['审计日志', '管理员关键操作留痕'],
};

function renderShell() {
  const nav = state.user.role === 'ADMIN' ? adminNav : studentNav;
  const [title, subtitle] = titles[state.view] || titles[nav[0][0]];
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-brand"><div class="brand-mark">合</div><div><strong>合住</strong><small>自由双选室友</small></div></div>
        <div class="nav-label">${state.user.role === 'ADMIN' ? '管理工作台' : '室友双选'}</div>
        <nav class="nav-list">${nav.map(([key, iconName, label]) => `
          <button class="nav-item ${state.view === key ? 'active' : ''}" data-view="${key}">${icon(iconName)}<span>${label}</span></button>
        `).join('')}</nav>
        <div class="sidebar-user"><strong>${escapeHtml(state.user.name)}</strong><small>${state.user.role === 'ADMIN' ? '管理员' : escapeHtml(state.user.grade)}</small></div>
      </aside>
      <main class="main-shell">
        <header class="topbar">
          <div class="topbar-title"><h1>${title}</h1><p>${subtitle}</p></div>
          <div class="topbar-actions">
            <button class="btn btn-secondary" id="logout-btn">${icon('log-out')}<span>退出</span></button>
          </div>
        </header>
        <div class="page" id="page-content">${emptyState('loader-circle', '正在加载', '正在读取最新数据')}</div>
      </main>
      <nav class="mobile-nav">${nav.map(([key, iconName, label]) => `
        <button class="${state.view === key ? 'active' : ''}" data-view="${key}">${icon(iconName)}<span>${label}</span></button>
      `).join('')}</nav>
    </div>`;
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.view)));
  document.querySelector('#logout-btn').addEventListener('click', logout);
  refreshIcons();
}

async function navigate(view) {
  state.view = view;
  renderShell();
  try {
    if (state.user.role === 'ADMIN') await loadAdminView(view);
    else await loadStudentView(view);
  } catch (error) {
    setPage(emptyState('circle-alert', '页面加载失败', error.message, `<button class="btn btn-secondary" id="retry-view">${icon('refresh-cw')}重试</button>`));
    document.querySelector('#retry-view')?.addEventListener('click', () => navigate(view));
  }
}

function renderLogin() {
  state.user = null;
  state.csrfToken = '';
  state.selectedConversationId = null;
  state.applicationDormitoryId = null;
  app.innerHTML = `
    <main class="login-shell">
      <section class="login-panel">
        <div class="login-brand"><div class="brand-mark">合</div><div><strong>合住</strong><span>内部室友双选系统</span></div></div>
        <h1>账号登录</h1>
        <p>使用管理员导入的正式账号进入系统。</p>
        <form id="login-form">
          <div class="form-field"><label for="login-id">登录标识</label><input id="login-id" name="loginIdentifier" autocomplete="username" required></div>
          <div class="form-field" style="margin-top:16px"><label for="login-password">密码</label><input id="login-password" name="password" type="password" autocomplete="current-password" required></div>
          <button class="btn btn-primary" style="width:100%;margin-top:20px" type="submit">${icon('log-in')}登录</button>
        </form>
        <div class="login-accounts"><p>演示账号</p><div class="account-chips">${demoAccounts.map(([identifier, name]) => `<button class="btn btn-secondary btn-sm" data-demo-id="${identifier}">${escapeHtml(name)} · ${identifier}</button>`).join('')}</div></div>
      </section>
    </main>`;
  const form = document.querySelector('#login-form');
  document.querySelectorAll('[data-demo-id]').forEach((button) => button.addEventListener('click', () => {
    const account = demoAccounts.find(([identifier]) => identifier === button.dataset.demoId);
    form.loginIdentifier.value = account[0]; form.password.value = account[2];
  }));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const data = await api('/api/auth/login', {
        method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      state.user = data.user;
      state.gender = data.user.gender === 'MALE' ? 'MALE' : 'FEMALE';
      state.csrfToken = data.csrfToken;
      state.view = data.user.role === 'ADMIN' ? 'overview' : 'discover';
      await navigate(state.view);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  });
  refreshIcons();
}

async function logout() {
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch {}
  renderLogin();
}

async function loadStudentView(view) {
  if (view === 'discover') return renderDiscover();
  if (view === 'profile') return renderProfile();
  if (view === 'messages') return renderMessages();
  if (view === 'dorm') return renderDorm();
  if (view === 'settings') return renderSettings();
  return navigate('discover');
}

function roommateCard(card) {
  const own = card.is_own || card.user_id === state.user.id;
  const genderClass = card.gender === 'FEMALE' ? 'gender-female' : card.gender === 'MALE' ? 'gender-male' : '';
  return `
    <article class="roommate-card ${genderClass}" data-card-id="${card.id}" tabindex="0">
      <div class="card-head">
        ${avatar(card.avatar_url, card.name)}
        <div class="card-title"><h3>${escapeHtml(card.name)}</h3><p>${escapeHtml(card.grade)} · ${escapeHtml(card.department || card.campus)}</p></div>
        ${own ? statusBadge('我的卡片', 'open', 'user-round') : ''}
      </div>
      <div class="card-metrics">
        <div class="metric"><span>作息</span><strong>${escapeHtml(card.sleep_preferences.join(' · ') || '-')}</strong></div>
        <div class="metric"><span>整洁要求</span><strong>${escapeHtml(labels.cleanliness[card.cleanliness_level] || '-')}</strong></div>
        <div class="metric"><span>夏季空调</span><strong>${card.summer_temp_min ?? '-'}–${card.summer_temp_max ?? '-'}°C</strong></div>
        <div class="metric"><span>游戏习惯</span><strong>${escapeHtml(labels.gaming[card.gaming_frequency] || '-')}</strong></div>
      </div>
      <div class="tag-row">${[...card.personality_tags, ...card.hobbies].slice(0, 5).map((tag, index) => `<span class="tag ${index > 2 ? 'accent' : ''}">${escapeHtml(tag)}</span>`).join('')}</div>
      <p class="card-note">${escapeHtml(card.additional_note || card.self_acknowledged_shortcoming)}</p>
    </article>`;
}

async function renderDiscover() {
  const params = new URLSearchParams({ availability: state.availability });
  state.gender ||= state.user.gender === 'MALE' ? 'MALE' : 'FEMALE';
  params.set('gender', state.gender);
  if (state.search) params.set('search', state.search);
  if (state.grade) params.set('grade', state.grade);
  const { cards } = await api(`/api/roommate-cards?${params}`);
  const grades = [...new Set(cards.map((card) => card.grade))];
  setPage(`
    <div class="toolbar">
      <div class="segmented" aria-label="性别分页"><button data-gender="FEMALE" class="${state.gender === 'FEMALE' ? 'active' : ''}">女生</button><button data-gender="MALE" class="${state.gender === 'MALE' ? 'active' : ''}">男生</button></div>
      <form class="search-field" id="search-form">${icon('search')}<input name="search" value="${escapeHtml(state.search)}" placeholder="搜索姓名、性格或兴趣"></form>
      <select id="grade-filter" aria-label="年级筛选"><option value="">全部年级</option>${grades.map((grade) => `<option ${state.grade === grade ? 'selected' : ''}>${escapeHtml(grade)}</option>`).join('')}</select>
      <div class="segmented"><button data-availability="AVAILABLE" class="${state.availability === 'AVAILABLE' ? 'active' : ''}">可组队</button><button data-availability="ALL" class="${state.availability === 'ALL' ? 'active' : ''}">全部</button></div>
    </div>
    ${cards.length ? `<div class="roommate-grid">${cards.map(roommateCard).join('')}</div>` : emptyState('users-round', '没有匹配的室友卡片', '调整筛选条件后再试试')}`);
  document.querySelector('#search-form').addEventListener('submit', (event) => {
    event.preventDefault(); state.search = new FormData(event.currentTarget).get('search').trim(); renderDiscover();
  });
  document.querySelector('#grade-filter').addEventListener('change', (event) => { state.grade = event.target.value; renderDiscover(); });
  document.querySelectorAll('[data-gender]').forEach((button) => button.addEventListener('click', () => {
    state.gender = button.dataset.gender; state.grade = ''; renderDiscover();
  }));
  document.querySelectorAll('[data-availability]').forEach((button) => button.addEventListener('click', () => { state.availability = button.dataset.availability; renderDiscover(); }));
  document.querySelectorAll('[data-card-id]').forEach((card) => {
    const open = () => showCardDetail(Number(card.dataset.cardId));
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter') open(); });
  });
}

async function showCardDetail(cardId) {
  try {
    const { card } = await api(`/api/roommate-cards/${cardId}`);
    const own = card.user_id === state.user.id;
    const modal = openModal(`${card.name}的室友卡片`, `
      <div class="section">
        <div class="detail-header">${avatar(card.avatar_url, card.name, 'avatar-lg')}<div><h2>${escapeHtml(card.name)}</h2><p>${escapeHtml(card.grade)} · ${escapeHtml(card.school)} ${escapeHtml(card.campus)}</p></div>
          <div class="detail-actions">${own ? `<button class="btn btn-primary" data-edit-own>${icon('pencil')}编辑</button>` : `<button class="btn btn-primary" data-message>${icon('message-circle')}发私信</button><button class="btn btn-secondary" data-report>${icon('flag')}举报</button><button class="btn btn-quiet" data-block title="拉黑用户">${icon('user-x')}</button>`}</div>
        </div>
      </div>
      <div class="section"><div class="section-heading"><h2>生活节奏</h2></div><dl class="detail-grid">
        <div class="detail-item"><dt>夏季 / 冬季空调</dt><dd>${card.summer_temp_min}–${card.summer_temp_max}°C / ${card.winter_temp_min}–${card.winter_temp_max}°C</dd></div>
        <div class="detail-item"><dt>作息偏好</dt><dd>${escapeHtml(card.sleep_preferences.join('、'))}${card.sleep_schedule_note ? ` · ${escapeHtml(card.sleep_schedule_note)}` : ''}</dd></div>
        <div class="detail-item"><dt>整洁要求</dt><dd>${escapeHtml(labels.cleanliness[card.cleanliness_level])}${card.cleanliness_note ? ` · ${escapeHtml(card.cleanliness_note)}` : ''}</dd></div>
        <div class="detail-item"><dt>鼠标键盘 / 外放</dt><dd>${escapeHtml(labels.tolerance[card.keyboard_noise_tolerance])} / ${escapeHtml(labels.tolerance[card.media_noise_tolerance])}</dd></div>
        <div class="detail-item"><dt>游戏习惯</dt><dd>${escapeHtml(labels.gaming[card.gaming_frequency])}${card.gaming_time_note ? ` · ${escapeHtml(card.gaming_time_note)}` : ''}</dd></div>
        <div class="detail-item"><dt>兴趣与运动</dt><dd>${escapeHtml([...card.hobbies, ...card.sports].join('、') || '-')}</dd></div>
      </dl></div>
      <div class="section"><div class="section-heading"><h2>相处方式</h2></div><dl class="detail-grid">
        <div class="detail-item"><dt>个人性格</dt><dd>${escapeHtml(card.personality_tags.join('、'))}${card.personality_note ? ` · ${escapeHtml(card.personality_note)}` : ''}</dd></div>
        <div class="detail-item"><dt>期望室友</dt><dd>${escapeHtml(card.roommate_personality_tags.join('、'))}${card.roommate_personality_note ? ` · ${escapeHtml(card.roommate_personality_note)}` : ''}</dd></div>
        <div class="detail-item"><dt>自认为的缺点</dt><dd>${escapeHtml(card.self_acknowledged_shortcoming)}</dd></div>
        <div class="detail-item"><dt>还想说的话</dt><dd>${escapeHtml(card.additional_note || '-')}</dd></div>
      </dl></div>`, { wide: true });
    modal.querySelector('[data-edit-own]')?.addEventListener('click', async () => { closeModal(); await navigate('profile'); });
    modal.querySelector('[data-message]')?.addEventListener('click', async () => {
      try {
        const result = await api(`/api/roommate-cards/${card.id}/conversations`, { method: 'POST', body: '{}' });
        state.selectedConversationId = result.conversation.id; closeModal(); await navigate('messages');
      } catch (error) { toast(error.message, 'error'); }
    });
    modal.querySelector('[data-report]')?.addEventListener('click', () => showReportModal('ROOMMATE_CARD', card.id));
    modal.querySelector('[data-block]')?.addEventListener('click', () => showBlockModal(card.user_id, card.name));
  } catch (error) { toast(error.message, 'error'); }
}

function showReportModal(targetType, targetId) {
  const modal = openModal('提交举报', `
    <form id="report-form" class="form-grid">
      <div class="form-field full"><label>举报原因</label><select name="reason" required><option value="">请选择</option><option>不当内容</option><option>骚扰行为</option><option>身份信息异常</option><option>其他</option></select></div>
      <div class="form-field full"><label>补充说明</label><textarea name="description" maxlength="500" placeholder="请描述具体情况"></textarea></div>
      <div class="form-actions"><button type="button" class="btn btn-secondary" data-close-form>取消</button><button class="btn btn-primary" type="submit">${icon('send')}提交举报</button></div>
    </form>`);
  modal.querySelector('[data-close-form]').addEventListener('click', closeModal);
  modal.querySelector('#report-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const body = Object.fromEntries(new FormData(event.currentTarget));
      await api('/api/reports', { method: 'POST', body: JSON.stringify({ ...body, targetType, targetId }) });
      closeModal(); toast('举报已提交');
    } catch (error) { toast(error.message, 'error'); }
  });
}

function showBlockModal(userId, name) {
  const modal = openModal('拉黑用户', `<p>拉黑后，你和 ${escapeHtml(name)} 将不能互相查看卡片或继续发送私信。</p><div class="modal-actions"><button class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-danger" data-confirm>${icon('user-x')}确认拉黑</button></div>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('[data-confirm]').addEventListener('click', async () => {
    try { await api(`/api/users/${userId}/blocks`, { method: 'POST', body: '{}' }); closeModal(); toast('已拉黑该用户'); renderDiscover(); }
    catch (error) { toast(error.message, 'error'); }
  });
}

function choice(name, value, label, selected, type = 'checkbox') {
  return `<label class="choice"><input type="${type}" name="${name}" value="${escapeHtml(value)}" ${selected ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>`;
}

function value(card, key) { return escapeHtml(card?.[key] ?? ''); }

async function renderProfile() {
  const { card } = await api('/api/me/roommate-card');
  const current = card || {};
  setPage(`
    <div class="profile-layout">
      <form class="profile-form" id="profile-form">
        <div class="section">
          <div class="section-heading"><div><h2>身份信息</h2><p>姓名和年级由管理员导入，学生不能修改</p></div>${card ? statusBadge(labels.cardStatus[card.status], card.status === 'PUBLISHED' ? 'published' : card.status.toLowerCase()) : statusBadge('未创建', 'draft')}</div>
          <div class="form-grid">
            <div class="form-field"><label>姓名</label><input value="${escapeHtml(state.user.name)}" disabled></div>
            <div class="form-field"><label>年级</label><input value="${escapeHtml(state.user.grade)}" disabled></div>
            <div class="form-field"><label>性别</label><input value="${state.user.gender === 'MALE' ? '男' : '女'}" disabled></div>
            <div class="form-field"><label class="required">学校</label><input name="school" value="${value(current, 'school')}" required></div>
            <div class="form-field"><label>校区</label><input name="campus" value="${value(current, 'campus')}"></div>
            <div class="form-field full"><label>院系 / 专业</label><input name="department" value="${value(current, 'department')}"></div>
            <div class="form-field full"><label class="required">头像</label><div class="avatar-upload">${avatar(current.avatar_url, state.user.name, 'avatar-lg')}<label class="btn btn-secondary" for="avatar-file">${icon('upload')}上传头像</label><input id="avatar-file" type="file" accept="image/png,image/jpeg,image/webp"><input type="hidden" name="avatar_url" value="${value(current, 'avatar_url')}"></div><span class="field-hint">PNG、JPG 或 WebP，建议使用正方形图片</span></div>
          </div>
        </div>
        <div class="section">
          <div class="section-heading"><div><h2>生活节奏</h2><p>这些信息会直接展示在室友卡片上</p></div></div>
          <div class="form-grid">
            <div class="form-field full"><label class="required">适宜的空调温度</label><div class="temperature-grid"><span>夏季</span><input type="number" name="summer_temp_min" min="10" max="35" value="${value(current, 'summer_temp_min')}" placeholder="下限"><b>至</b><input type="number" name="summer_temp_max" min="10" max="35" value="${value(current, 'summer_temp_max')}" placeholder="上限"><span>冬季</span><input type="number" name="winter_temp_min" min="10" max="35" value="${value(current, 'winter_temp_min')}" placeholder="下限"><b>至</b><input type="number" name="winter_temp_max" min="10" max="35" value="${value(current, 'winter_temp_max')}" placeholder="上限"></div></div>
            <div class="form-field full"><label class="required">作息偏好</label><div class="choice-row">${['早起','晚睡','午休'].map((item) => choice('sleep_preferences', item, item, current.sleep_preferences?.includes(item))).join('')}</div><input name="sleep_schedule_note" value="${value(current, 'sleep_schedule_note')}" placeholder="补充具体时间，例如 23:30 前休息"></div>
            <div class="form-field"><label class="required">整洁程度要求</label><select name="cleanliness_level"><option value="">请选择</option>${Object.entries(labels.cleanliness).map(([key, label]) => `<option value="${key}" ${current.cleanliness_level === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
            <div class="form-field"><label>整洁要求补充</label><input name="cleanliness_note" value="${value(current, 'cleanliness_note')}" placeholder="例如每周共同打扫一次"></div>
            <div class="form-field"><label class="required">打游戏情况</label><select name="gaming_frequency"><option value="">请选择</option>${Object.entries(labels.gaming).map(([key, label]) => `<option value="${key}" ${current.gaming_frequency === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
            <div class="form-field"><label>游戏时段补充</label><input name="gaming_time_note" value="${value(current, 'gaming_time_note')}" placeholder="例如只在周末玩"></div>
            <div class="form-field"><label class="required">鼠标键盘声音</label><select name="keyboard_noise_tolerance"><option value="">请选择</option>${Object.entries(labels.tolerance).map(([key, label]) => `<option value="${key}" ${current.keyboard_noise_tolerance === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
            <div class="form-field"><label class="required">游戏 / 视频外放</label><select name="media_noise_tolerance"><option value="">请选择</option>${Object.entries(labels.tolerance).map(([key, label]) => `<option value="${key}" ${current.media_noise_tolerance === key ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
          </div>
        </div>
        <div class="section">
          <div class="section-heading"><div><h2>性格与兴趣</h2><p>用简短标签帮助他人快速了解你</p></div></div>
          <div class="form-grid">
            <div class="form-field full"><label class="required">个人性格</label><div class="choice-row">${['开朗','安静','慢热','自律','随和','独立','直接','细腻'].map((item) => choice('personality_tags', item, item, current.personality_tags?.includes(item))).join('')}</div><input name="personality_note" value="${value(current, 'personality_note')}" placeholder="补充说明"></div>
            <div class="form-field full"><label class="required">期望室友的性格</label><div class="choice-row">${['好沟通','整洁','守时','坦诚','包容','有边界感','尊重隐私','友善'].map((item) => choice('roommate_personality_tags', item, item, current.roommate_personality_tags?.includes(item))).join('')}</div><input name="roommate_personality_note" value="${value(current, 'roommate_personality_note')}" placeholder="补充说明"></div>
            <div class="form-field"><label>兴趣爱好</label><input name="hobbies" value="${escapeHtml((current.hobbies || []).join('、'))}" placeholder="用顿号分隔"></div>
            <div class="form-field"><label>喜欢的运动</label><input name="sports" value="${escapeHtml((current.sports || []).join('、'))}" placeholder="用顿号分隔"></div>
            <div class="form-field full"><label>兴趣补充</label><input name="hobbies_note" value="${value(current, 'hobbies_note')}"></div>
            <div class="form-field full"><label class="required">自认为的一个缺点</label><textarea name="self_acknowledged_shortcoming" maxlength="200">${value(current, 'self_acknowledged_shortcoming')}</textarea></div>
            <div class="form-field full"><label>还想要说的话</label><textarea name="additional_note" maxlength="500">${value(current, 'additional_note')}</textarea></div>
          </div>
        </div>
        ${card?.status === 'HIDDEN' ? `<div class="panel" style="background:var(--danger-soft);color:var(--danger)"><strong>卡片已隐藏</strong><p>${escapeHtml(card.hidden_reason)}</p></div>` : ''}
        <div class="form-actions">
          ${card && ['PUBLISHED'].includes(card.status) ? `<button class="btn btn-secondary" type="button" data-unpublish>${icon('eye-off')}取消发布</button>` : ''}
          <button class="btn btn-secondary" type="submit">${icon('save')}保存草稿</button>
          ${!card || ['DRAFT'].includes(card.status) ? `<button class="btn btn-primary" type="button" data-publish>${icon('send')}发布卡片</button>` : ''}
        </div>
      </form>
      <aside class="preview-panel"><h3>卡片预览</h3>${card ? roommateCard(card).replace('data-card-id', 'data-preview-id') : `<p class="field-hint">保存后将在这里显示卡片预览。</p>`}</aside>
    </div>`);
  const form = document.querySelector('#profile-form');
  document.querySelector('#avatar-file').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 2.5 * 1024 * 1024) return toast('头像不能超过 2.5 MB', 'error');
    const reader = new FileReader();
    reader.onload = () => { form.avatar_url.value = reader.result; form.querySelector('.avatar-lg').src = reader.result; };
    reader.readAsDataURL(file);
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await saveProfile(form); toast('室友卡片已保存'); await renderProfile(); }
    catch (error) { toast(error.message, 'error'); }
  });
  form.querySelector('[data-publish]')?.addEventListener('click', async () => {
    try { await saveProfile(form); await api('/api/me/roommate-card/publish', { method: 'POST', body: '{}' }); toast('卡片已发布'); await renderProfile(); }
    catch (error) { toast(error.message, 'error'); }
  });
  form.querySelector('[data-unpublish]')?.addEventListener('click', async () => {
    try { await api('/api/me/roommate-card/unpublish', { method: 'POST', body: '{}' }); toast('已取消发布'); await renderProfile(); }
    catch (error) { toast(error.message, 'error'); }
  });
}

async function saveProfile(form) {
  const data = Object.fromEntries(new FormData(form));
  data.sleep_preferences = new FormData(form).getAll('sleep_preferences');
  data.personality_tags = new FormData(form).getAll('personality_tags');
  data.roommate_personality_tags = new FormData(form).getAll('roommate_personality_tags');
  data.hobbies = String(data.hobbies || '').split(/[、,，]/).map((item) => item.trim()).filter(Boolean);
  data.sports = String(data.sports || '').split(/[、,，]/).map((item) => item.trim()).filter(Boolean);
  return api('/api/me/roommate-card', { method: 'PUT', body: JSON.stringify(data) });
}

async function renderMessages() {
  const { conversations } = await api('/api/conversations');
  const selectedExists = conversations.some((conversation) => conversation.id === state.selectedConversationId);
  if (!selectedExists) {
    state.selectedConversationId = conversations[0]?.id || null;
    state.applicationDormitoryId = null;
  }
  setPage(`<div class="message-workspace ${state.selectedConversationId ? 'chat-open' : ''}">
    <aside class="conversation-list"><div class="conversation-list-head">全部会话</div>${conversations.length ? conversations.map((item) => `
      <button class="conversation-item ${state.selectedConversationId === item.id ? 'active' : ''}" data-conversation="${item.id}">
        ${avatar(item.other_avatar, item.other_name, 'avatar-sm')}<div class="conversation-copy"><strong>${escapeHtml(item.other_name)}</strong><p>${escapeHtml(item.last_message || '尚未发送消息')}</p></div>${item.unread_count ? `<span class="unread">${item.unread_count}</span>` : ''}
      </button>`).join('') : emptyState('message-circle', '还没有私信', '从室友卡片进入详情后发起联系')}</aside>
    <section class="chat" id="chat-panel">${state.selectedConversationId ? await chatMarkup(state.selectedConversationId, conversations) : emptyState('messages-square', '选择一段会话', '查看消息并继续沟通')}</section>
  </div>`);
  document.querySelectorAll('[data-conversation]').forEach((button) => button.addEventListener('click', async () => {
    state.selectedConversationId = Number(button.dataset.conversation);
    state.applicationDormitoryId = null;
    await renderMessages();
  }));
  bindChat();
}

async function chatMarkup(conversationId, conversations) {
  const conversation = conversations.find((item) => item.id === conversationId);
  if (!conversation) return emptyState('message-circle', '会话不存在', '请选择其他会话');
  let messages;
  try {
    ({ messages } = await api(`/api/conversations/${conversationId}/messages`));
    await api(`/api/conversations/${conversationId}/read`, { method: 'POST', body: '{}' });
  } catch (error) {
    if (error.code === 'CONVERSATION_NOT_FOUND' || error.status === 404) {
      state.selectedConversationId = null;
      state.applicationDormitoryId = null;
      return emptyState('message-circle', '会话已失效', '返回会话列表后将自动刷新');
    }
    throw error;
  }
  return `
    <header class="chat-head"><button class="btn btn-quiet icon-btn only-mobile" data-chat-back>${icon('arrow-left')}</button>${avatar(conversation.other_avatar, conversation.other_name, 'avatar-sm')}<div><strong>${escapeHtml(conversation.other_name)}</strong><div class="field-hint">${escapeHtml(conversation.other_grade)}</div></div></header>
    <div class="chat-messages" id="chat-messages">${state.applicationDormitoryId ? `<div class="application-compose"><div><strong>申请加入宿舍</strong><span>申请将以卡片形式发送给宿舍发起人</span></div><button class="btn btn-primary btn-sm" data-send-application>${icon('send')}填写申请</button></div>` : ''}${messages.length ? messages.map(messageMarkup).join('') : emptyState('message-circle', '开始交流', '说说你的作息习惯或对宿舍生活的期待')}</div>
    <form class="chat-compose" id="message-form"><textarea name="body" maxlength="2000" placeholder="输入消息" required></textarea><button class="btn btn-primary icon-btn" title="发送消息">${icon('send')}</button></form>`;
}

function messageMarkup(message) {
  if (message.message_type === 'DORMITORY_APPLICATION') {
    const applicationStatus = message.application_status || 'CANCELLED';
    const pending = applicationStatus === 'PENDING';
    const canReview = pending && message.sender_id !== state.user.id;
    return `<div class="application-card ${message.sender_id === state.user.id ? 'mine' : ''}">
      <div class="application-card-head">${icon('bed-double')}<div><strong>加入宿舍申请</strong><span>${escapeHtml(message.dormitory_name || '原宿舍')} · ${escapeHtml(message.dormitory_code || '已失效')}</span></div>${statusBadge(labels.applicationStatus[applicationStatus], applicationStatus.toLowerCase())}</div>
      <p>${escapeHtml(message.application_note || message.body)}</p>
      <div class="application-card-foot"><span>${message.dormitory_member_count}/${message.dormitory_capacity} 人 · ${formatDate(message.created_at)}</span>${canReview ? `<div><button class="btn btn-secondary btn-sm" data-review-application="${message.application_id}" data-action="reject">拒绝</button><button class="btn btn-primary btn-sm" data-review-application="${message.application_id}" data-action="approve">通过</button></div>` : ''}</div>
    </div>`;
  }
  return `<div class="message ${message.sender_id === state.user.id ? 'mine' : ''}">${escapeHtml(message.body)}<span class="message-time">${formatDate(message.created_at)}</span></div>`;
}

function bindChat() {
  const messages = document.querySelector('#chat-messages');
  if (messages) messages.scrollTop = messages.scrollHeight;
  document.querySelector('[data-chat-back]')?.addEventListener('click', () => {
    state.selectedConversationId = null;
    state.applicationDormitoryId = null;
    renderMessages();
  });
  document.querySelector('#message-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await api(`/api/conversations/${state.selectedConversationId}/messages`, { method: 'POST', body: JSON.stringify({ body: form.body.value }) });
      form.reset(); await renderMessages();
    } catch (error) { toast(error.message, 'error'); }
  });
  document.querySelector('[data-send-application]')?.addEventListener('click', () => showApplicationModal());
  document.querySelectorAll('[data-review-application]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/dormitory-applications/${button.dataset.reviewApplication}/${button.dataset.action}`, { method: 'POST', body: '{}' });
      toast(button.dataset.action === 'approve' ? '申请已通过' : '申请已拒绝');
      await renderMessages();
    } catch (error) { toast(error.message, 'error'); }
  }));
}

function showApplicationModal() {
  const modal = openModal('发送加入申请', `<form id="application-form"><div class="form-field"><label>申请说明</label><textarea name="note" maxlength="300" placeholder="介绍你的作息习惯或加入原因"></textarea></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary">${icon('send')}发送申请卡片</button></div></form>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('#application-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api(`/api/conversations/${state.selectedConversationId}/dormitory-applications`, {
        method: 'POST',
        body: JSON.stringify({ dormitoryId: state.applicationDormitoryId, note: new FormData(event.currentTarget).get('note') }),
      });
      state.applicationDormitoryId = null;
      closeModal(); toast('加入申请已发送'); await renderMessages();
    } catch (error) { toast(error.message, 'error'); }
  });
}

async function renderDorm() {
  const [{ dormitory, applications, open }, { dormitories }] = await Promise.all([
    api('/api/me/dormitory'), api('/api/dormitories'),
  ]);
  const stageBanner = `<div class="stage-banner ${open ? 'open' : 'closed'}">${icon(open ? 'door-open' : 'lock-keyhole')}<div><strong>自由选宿舍阶段${open ? '进行中' : '已关闭'}</strong><span>${open ? '可以创建宿舍、发送加入申请或退出当前宿舍' : '管理员已暂停所有宿舍变更操作'}</span></div></div>`;

  if (dormitory) {
    const isInitiator = dormitory.current_user_role === 'INITIATOR';
    setPage(`${stageBanner}<div class="dorm-panel">
      <div class="dorm-code"><div><span class="field-hint">我的宿舍</span><strong>${escapeHtml(dormitory.name)}</strong><p class="field-hint">${escapeHtml(dormitory.dormitory_code)} · ${dormitory.building && dormitory.room_number ? `${escapeHtml(dormitory.building)} ${escapeHtml(dormitory.room_number)}` : '等待管理员分配房间'}</p></div>${statusBadge(labels.dormitoryStatus[dormitory.status], dormitory.status.toLowerCase(), dormitory.status === 'FULL' ? 'badge-check' : 'door-open')}</div>
      <div class="section"><div class="section-heading"><div><h2>当前成员</h2><p>${dormitory.member_count} / ${dormitory.capacity} 人</p></div></div><div class="member-list">${dormitory.members.map((member) => `<div class="member-row">${avatar(member.avatar_url, member.name, 'avatar-sm')}<div class="member-copy"><strong>${escapeHtml(member.name)} ${member.role === 'INITIATOR' ? '<span class="tag">发起人</span>' : ''}</strong><span>${escapeHtml(member.grade)} · ${formatDate(member.joined_at)}</span></div>${isInitiator && member.user_id !== state.user.id && open ? `<button class="btn btn-danger btn-sm" data-remove-member="${member.user_id}">${icon('user-minus')}移除</button>` : ''}</div>`).join('')}</div></div>
      ${isInitiator ? `<div class="section"><div class="section-heading"><div><h2>待审核申请</h2><p>也可以直接在私信申请卡片中处理</p></div></div>${dormitory.pending_applications.length ? `<div class="member-list">${dormitory.pending_applications.map((application) => `<div class="member-row">${avatar(application.applicant_avatar, application.applicant_name, 'avatar-sm')}<div class="member-copy"><strong>${escapeHtml(application.applicant_name)}</strong><span>${escapeHtml(application.note || '未填写申请说明')}</span></div><button class="btn btn-secondary btn-sm" data-review-dorm="${application.id}" data-action="reject">拒绝</button><button class="btn btn-primary btn-sm" data-review-dorm="${application.id}" data-action="approve">通过</button></div>`).join('')}</div>` : '<p class="field-hint">暂无待审核申请</p>'}</div>` : ''}
      <div class="form-actions"><span class="field-hint">${isInitiator ? '退出后，最早加入的成员将成为新发起人' : '退出后可以重新创建或申请其他宿舍'}</span><button class="btn btn-danger" data-leave-dorm ${open ? '' : 'disabled'}>${icon('log-out')}退出宿舍</button></div>
    </div>`);
    document.querySelectorAll('[data-review-dorm]').forEach((button) => button.addEventListener('click', async () => {
      try { await api(`/api/dormitory-applications/${button.dataset.reviewDorm}/${button.dataset.action}`, { method: 'POST', body: '{}' }); toast(button.dataset.action === 'approve' ? '申请已通过' : '申请已拒绝'); await renderDorm(); }
      catch (error) { toast(error.message, 'error'); }
    }));
    document.querySelectorAll('[data-remove-member]').forEach((button) => button.addEventListener('click', async () => {
      try { await api(`/api/dormitories/${dormitory.id}/members/${button.dataset.removeMember}`, { method: 'DELETE', body: '{}' }); toast('成员已移除'); await renderDorm(); }
      catch (error) { toast(error.message, 'error'); }
    }));
    document.querySelector('[data-leave-dorm]')?.addEventListener('click', async () => {
      try { await api('/api/me/dormitory/leave', { method: 'POST', body: '{}' }); toast('已退出宿舍'); await renderDorm(); }
      catch (error) { toast(error.message, 'error'); }
    });
    return;
  }

  setPage(`${stageBanner}<div class="toolbar"><div class="segmented"><button class="active">同性别宿舍</button></div><div class="toolbar-spacer"></div><button class="btn btn-primary" id="create-dorm" ${open ? '' : 'disabled'}>${icon('plus')}新建宿舍并加入</button></div>
    ${applications.some((item) => item.status === 'PENDING') ? `<div class="panel"><strong>待审核申请</strong>${applications.filter((item) => item.status === 'PENDING').map((item) => `<p class="field-hint">${escapeHtml(item.dormitory_name)} · ${formatDate(item.created_at)}</p>`).join('')}</div>` : ''}
    ${dormitories.length ? `<div class="dormitory-grid">${dormitories.map((item) => `<article class="dormitory-card" data-dorm-status="${item.status}"><div class="dormitory-card-head"><div><span>${escapeHtml(item.dormitory_code)}</span><h2>${escapeHtml(item.name)}</h2></div>${statusBadge(`${item.member_count}/4 人`, item.status.toLowerCase(), 'users')}</div><p>${item.building && item.room_number ? `${escapeHtml(item.building)} ${escapeHtml(item.room_number)}` : '等待管理员分配房间'}</p><div class="dormitory-owner">${icon('crown')}发起人：${escapeHtml(item.initiator_name)}</div>${item.status === 'FULL' ? `<button class="btn btn-secondary" disabled>${icon('users')}已满员</button>` : `<button class="btn btn-primary" data-apply-dorm="${item.id}" data-initiator-id="${item.initiator_id}" ${open ? '' : 'disabled'}>${icon('message-circle')}联系并申请</button>`}</article>`).join('')}</div>` : emptyState('bed-double', '暂无宿舍', open ? '可以新建一个宿舍并成为发起人' : '自由选宿舍阶段关闭后不能创建宿舍')}`);
  document.querySelector('#create-dorm')?.addEventListener('click', showCreateDormitoryModal);
  document.querySelectorAll('[data-apply-dorm]').forEach((button) => button.addEventListener('click', async () => {
    try {
      const result = await api(`/api/users/${button.dataset.initiatorId}/conversations`, { method: 'POST', body: '{}' });
      state.selectedConversationId = result.conversation.id;
      state.applicationDormitoryId = Number(button.dataset.applyDorm);
      await navigate('messages');
    } catch (error) { toast(error.message, 'error'); }
  }));
}

function showCreateDormitoryModal() {
  const modal = openModal('新建宿舍并加入', `<form id="create-dorm-form" class="form-grid"><div class="form-field full"><label>宿舍名称</label><input name="name" maxlength="40" placeholder="例如：一起早睡寝室" required><span class="field-hint">宿舍固定为 4 人间，楼栋和房间号由管理员统一分配。</span></div><div class="form-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary">${icon('plus')}创建并加入</button></div></form>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('#create-dorm-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await api('/api/dormitories', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); closeModal(); toast('宿舍已创建，你已成为发起人'); await renderDorm(); }
    catch (error) { toast(error.message, 'error'); }
  });
}

async function renderSettings() {
  const { blocks } = await api('/api/blocks');
  setPage(`<div class="page narrow" style="padding:0">
    <section class="panel"><div class="section-heading"><div><h2>身份信息</h2><p>如需更正，请联系管理员</p></div></div><div class="form-grid"><div class="form-field"><label>姓名</label><input value="${escapeHtml(state.user.name)}" disabled></div><div class="form-field"><label>年级</label><input value="${escapeHtml(state.user.grade)}" disabled></div><div class="form-field"><label>性别</label><input value="${state.user.gender === 'MALE' ? '男' : '女'}" disabled></div><div class="form-field full"><label>登录标识</label><input value="${escapeHtml(state.user.loginIdentifier)}" disabled></div></div></section>
    <section class="panel"><div class="section-heading"><div><h2>修改密码</h2><p>新密码至少 8 位</p></div></div><form id="password-form" class="form-grid"><div class="form-field"><label>当前密码</label><input name="currentPassword" type="password" required></div><div class="form-field"><label>新密码</label><input name="newPassword" type="password" minlength="8" required></div><div class="full"><button class="btn btn-primary">${icon('key-round')}更新密码</button></div></form></section>
    <section class="panel"><div class="section-heading"><div><h2>拉黑列表</h2><p>解除后可以重新查看对方卡片</p></div></div>${blocks.length ? `<div class="member-list">${blocks.map((item) => `<div class="member-row">${avatar(item.avatar_url, item.name, 'avatar-sm')}<div class="member-copy"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.grade)}</span></div><button class="btn btn-secondary btn-sm" data-unblock="${item.user_id}">解除</button></div>`).join('')}</div>` : `<p class="field-hint">暂无拉黑用户</p>`}</section>
    <section class="panel" style="border-color:#eccaca"><div class="section-heading"><div><h2>注销账号</h2><p>注销后不能登录，卡片停止展示，但历史资源会继续保留</p></div></div><button class="btn btn-danger" id="deactivate-btn">${icon('user-minus')}注销账号</button></section>
  </div>`);
  document.querySelector('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await api('/api/me/password', { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); event.currentTarget.reset(); toast('密码已更新'); }
    catch (error) { toast(error.message, 'error'); }
  });
  document.querySelectorAll('[data-unblock]').forEach((button) => button.addEventListener('click', async () => {
    try { await api(`/api/users/${button.dataset.unblock}/blocks`, { method: 'DELETE', body: '{}' }); toast('已解除拉黑'); await renderSettings(); }
    catch (error) { toast(error.message, 'error'); }
  }));
  document.querySelector('#deactivate-btn').addEventListener('click', showDeactivateModal);
}

function showDeactivateModal() {
  const modal = openModal('注销账号', `<p>账号注销后将无法登录，室友卡片停止展示，当前宿舍组会解散。已有资源继续保留，除非管理员永久删除。</p><div class="form-field"><label>输入“注销账号”确认</label><input id="deactivate-confirm"></div><div class="modal-actions"><button class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-danger" data-confirm>${icon('user-minus')}确认注销</button></div>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('[data-confirm]').addEventListener('click', async () => {
    try { await api('/api/me/deactivate', { method: 'POST', body: JSON.stringify({ confirmation: modal.querySelector('#deactivate-confirm').value }) }); closeModal(); renderLogin(); }
    catch (error) { toast(error.message, 'error'); }
  });
}

async function loadAdminView(view) {
  if (view === 'overview') return renderAdminOverview();
  if (view === 'users') return renderAdminUsers();
  if (view === 'cards') return renderAdminCards();
  if (view === 'groups') return renderAdminGroups();
  if (view === 'reports') return renderAdminReports();
  if (view === 'audit') return renderAdminAudit();
  return navigate('overview');
}

async function renderAdminOverview() {
  const { counts } = await api('/api/admin/overview');
  setPage(`<div class="stats-grid"><div class="stat"><span>正式学生账号</span><strong>${counts.students}</strong></div><div class="stat"><span>正常账号</span><strong>${counts.activeStudents}</strong></div><div class="stat"><span>公开卡片</span><strong>${counts.publishedCards}</strong></div><div class="stat"><span>待处理举报</span><strong>${counts.pendingReports}</strong></div></div>
    <section class="panel"><div class="section-heading"><div><h2>自由选宿舍阶段</h2><p>关闭后，学生不能创建、申请、审批、移除或退出宿舍</p></div>${statusBadge(counts.dormitorySelectionOpen ? '已开启' : '已关闭', counts.dormitorySelectionOpen ? 'open' : 'closed', counts.dormitorySelectionOpen ? 'door-open' : 'lock-keyhole')}</div><div class="detail-header"><div class="brand-mark" style="background:var(--accent)">${counts.dormitories}</div><div><strong>有效宿舍</strong><p class="field-hint">当前已有 ${counts.dormitoryMembers} 名学生加入宿舍</p></div><div class="detail-actions"><button class="btn ${counts.dormitorySelectionOpen ? 'btn-danger' : 'btn-primary'}" id="toggle-dorm-stage">${icon(counts.dormitorySelectionOpen ? 'lock-keyhole' : 'door-open')}${counts.dormitorySelectionOpen ? '关闭阶段' : '开启阶段'}</button></div></div></section>`);
  document.querySelector('#toggle-dorm-stage').addEventListener('click', () => showDormitoryStageModal(!counts.dormitorySelectionOpen));
}

function showDormitoryStageModal(open) {
  const modal = openModal(open ? '开启自由选宿舍' : '关闭自由选宿舍', `<p>${open ? '开启后，学生可以创建宿舍、发送和审核加入申请、移除成员以及退出宿舍。' : '关闭后，所有学生的宿舍变更操作将立即停止，现有宿舍和申请数据不会删除。'}</p><div class="form-field"><label>操作原因</label><textarea id="stage-reason" required></textarea></div><div class="modal-actions"><button class="btn btn-secondary" data-cancel>取消</button><button class="btn ${open ? 'btn-primary' : 'btn-danger'}" data-confirm>确认${open ? '开启' : '关闭'}</button></div>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('[data-confirm]').addEventListener('click', async () => {
    try { await api('/api/admin/settings/dormitory-selection', { method: 'PATCH', body: JSON.stringify({ open, reason: modal.querySelector('#stage-reason').value }) }); closeModal(); toast(`自由选宿舍阶段已${open ? '开启' : '关闭'}`); await renderAdminOverview(); }
    catch (error) { toast(error.message, 'error'); }
  });
}

async function renderAdminUsers() {
  const { users } = await api('/api/admin/users');
  setPage(`<div class="toolbar"><div class="search-field">${icon('search')}<input id="admin-user-search" placeholder="搜索登录标识、姓名或年级"></div><div class="toolbar-spacer"></div><button class="btn btn-primary" id="import-users">${icon('upload')}导入账号</button></div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>学生</th><th>性别</th><th>登录标识</th><th>状态</th><th>卡片</th><th>最近登录</th><th></th></tr></thead><tbody id="user-rows">${users.map(userRow).join('')}</tbody></table></div>`);
  bindAdminUserRows(users);
  document.querySelector('#admin-user-search').addEventListener('input', (event) => {
    const query = event.target.value.toLowerCase();
    document.querySelector('#user-rows').innerHTML = users.filter((item) => [item.name, item.grade, item.login_identifier].join(' ').toLowerCase().includes(query)).map(userRow).join('');
    bindAdminUserRows(users);
    refreshIcons();
  });
  document.querySelector('#import-users').addEventListener('click', showImportModal);
}

function userRow(user) {
  const type = user.status === 'ACTIVE' ? 'active' : user.status.toLowerCase();
  return `<tr><td><strong>${escapeHtml(user.name)}</strong><div class="field-hint">${escapeHtml(user.grade)}</div></td><td>${user.gender === 'MALE' ? '男' : '女'}</td><td>${escapeHtml(user.login_identifier)}</td><td>${statusBadge(labels.userStatus[user.status], type)}</td><td>${user.card_status ? statusBadge(labels.cardStatus[user.card_status], user.card_status === 'PUBLISHED' ? 'published' : user.card_status.toLowerCase()) : '-'}</td><td>${formatDate(user.last_login_at)}</td><td><div class="cell-actions"><button class="btn btn-secondary btn-sm" data-edit-user="${user.id}">${icon('pencil')}身份</button><button class="btn btn-secondary btn-sm" data-status-user="${user.id}">${icon('shield')}状态</button><button class="btn btn-quiet icon-btn btn-sm" data-delete-user="${user.id}" title="永久删除">${icon('trash-2')}</button></div></td></tr>`;
}

function bindAdminUserRows(users) {
  document.querySelectorAll('[data-edit-user]').forEach((button) => button.addEventListener('click', () => showEditIdentity(users.find((item) => item.id === Number(button.dataset.editUser)))));
  document.querySelectorAll('[data-status-user]').forEach((button) => button.addEventListener('click', () => showStatusModal(users.find((item) => item.id === Number(button.dataset.statusUser)))));
  document.querySelectorAll('[data-delete-user]').forEach((button) => button.addEventListener('click', () => showDeleteUser(users.find((item) => item.id === Number(button.dataset.deleteUser)))));
}

function showImportModal() {
  const modal = openModal('导入正式账号', `<form id="import-form"><div class="form-field"><label>账号数据</label><textarea name="rows" rows="8" placeholder="每行填写：登录标识,姓名,年级,性别&#10;例如：2026013,张同学,2026级,女" required></textarea><span class="field-hint">性别填写“男”或“女”。姓名、年级和性别导入后仅管理员可修改。</span></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary" type="submit">${icon('upload')}开始导入</button></div></form>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('#import-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const accounts = event.currentTarget.rows.value.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
      const [loginIdentifier, name, grade, genderText] = line.split(/[,，\t]/).map((part) => part.trim());
      const gender = genderText === '男' ? 'MALE' : genderText === '女' ? 'FEMALE' : genderText;
      return { loginIdentifier, name, grade, gender };
    });
    try {
      const result = await api('/api/admin/users/import', { method: 'POST', body: JSON.stringify({ accounts }) });
      modal.querySelector('.modal-body').innerHTML = `<div class="section-heading"><div><h2>导入完成</h2><p>成功 ${result.created.length} 条，失败 ${result.failed.length} 条</p></div></div>${result.created.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>登录标识</th><th>姓名</th><th>年级</th><th>性别</th><th>初始密码</th></tr></thead><tbody>${result.created.map((item) => `<tr><td>${escapeHtml(item.loginIdentifier)}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.grade)}</td><td>${item.gender === 'MALE' ? '男' : '女'}</td><td><code>${escapeHtml(item.initialPassword)}</code></td></tr>`).join('')}</tbody></table></div>` : ''}${result.failed.length ? `<div class="panel" style="margin-top:12px"><strong>失败明细</strong>${result.failed.map((item) => `<p class="field-hint">第 ${item.row} 行：${escapeHtml(item.reason)}</p>`).join('')}</div>` : ''}<div class="modal-actions"><button class="btn btn-primary" data-done>完成</button></div>`;
      modal.querySelector('[data-done]').addEventListener('click', async () => { closeModal(); await renderAdminUsers(); });
    } catch (error) { toast(error.message, 'error'); }
  });
}

function showEditIdentity(user) {
  const modal = openModal('修改身份字段', `<form id="identity-form" class="form-grid"><div class="form-field"><label>姓名</label><input name="name" value="${escapeHtml(user.name)}" required></div><div class="form-field"><label>年级</label><input name="grade" value="${escapeHtml(user.grade)}" required></div><div class="form-field"><label>性别</label><select name="gender" required><option value="FEMALE" ${user.gender === 'FEMALE' ? 'selected' : ''}>女</option><option value="MALE" ${user.gender === 'MALE' ? 'selected' : ''}>男</option></select></div><div class="form-field full"><label>修改原因</label><input name="reason" required></div><div class="form-actions"><button class="btn btn-secondary" type="button" data-cancel>取消</button><button class="btn btn-primary">${icon('save')}保存</button></div></form>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('#identity-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await api(`/api/admin/users/${user.id}/identity`, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); closeModal(); toast('身份字段已更新'); await renderAdminUsers(); }
    catch (error) { toast(error.message, 'error'); }
  });
}

function showStatusModal(user) {
  const modal = openModal('调整账号状态', `<form id="status-form" class="form-grid"><div class="form-field full"><label>账号状态</label><select name="status"><option value="ACTIVE">正常</option><option value="SUSPENDED">停用</option><option value="BANNED">封禁</option></select></div><div class="form-field full"><label>操作原因</label><textarea name="reason" required></textarea></div><div class="form-actions"><button class="btn btn-secondary" type="button" data-cancel>取消</button><button class="btn btn-primary">${icon('shield-check')}确认</button></div></form>`);
  modal.querySelector('[name="status"]').value = ['ACTIVE','SUSPENDED','BANNED'].includes(user.status) ? user.status : 'ACTIVE';
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('#status-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await api(`/api/admin/users/${user.id}/status`, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); closeModal(); toast('账号状态已更新'); await renderAdminUsers(); }
    catch (error) { toast(error.message, 'error'); }
  });
}

function showDeleteUser(user) {
  const modal = openModal('永久删除账号', `<p>此操作会永久删除 ${escapeHtml(user.name)} 的账号及关联资源，无法撤销。</p><div class="form-field"><label>输入登录标识 ${escapeHtml(user.login_identifier)} 确认</label><input id="delete-confirm"></div><div class="form-field" style="margin-top:14px"><label>删除原因</label><textarea id="delete-reason"></textarea></div><div class="modal-actions"><button class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-danger" data-confirm>${icon('trash-2')}永久删除</button></div>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('[data-confirm]').addEventListener('click', async () => {
    try { await api(`/api/admin/users/${user.id}`, { method: 'DELETE', body: JSON.stringify({ confirmation: modal.querySelector('#delete-confirm').value, reason: modal.querySelector('#delete-reason').value }) }); closeModal(); toast('账号及资源已删除'); await renderAdminUsers(); }
    catch (error) { toast(error.message, 'error'); }
  });
}

async function renderAdminCards() {
  const { cards } = await api('/api/admin/roommate-cards');
  setPage(`<div class="table-wrap"><table class="data-table"><thead><tr><th>学生</th><th>作息</th><th>整洁要求</th><th>状态</th><th>更新时间</th><th></th></tr></thead><tbody>${cards.map((card) => `<tr><td><div class="cell-user">${avatar(card.avatar_url, card.name, 'avatar-sm')}<div><strong>${escapeHtml(card.name)}</strong><div class="field-hint">${escapeHtml(card.grade)} · ${escapeHtml(card.department)}</div></div></div></td><td>${escapeHtml(card.sleep_preferences.join('、'))}</td><td>${escapeHtml(labels.cleanliness[card.cleanliness_level] || '-')}</td><td>${statusBadge(labels.cardStatus[card.status], card.status === 'PUBLISHED' ? 'published' : card.status.toLowerCase())}</td><td>${formatDate(card.updated_at)}</td><td><div class="cell-actions"><button class="btn btn-secondary btn-sm" data-view-card="${card.id}">${icon('eye')}查看</button>${card.status === 'HIDDEN' ? `<button class="btn btn-secondary btn-sm" data-card-action="restore" data-id="${card.id}">${icon('rotate-ccw')}恢复</button>` : `<button class="btn btn-danger btn-sm" data-card-action="hide" data-id="${card.id}">${icon('eye-off')}隐藏</button>`}</div></td></tr>`).join('')}</tbody></table></div>`);
  document.querySelectorAll('[data-view-card]').forEach((button) => button.addEventListener('click', () => showAdminCardDetail(cards.find((card) => card.id === Number(button.dataset.viewCard)))));
  document.querySelectorAll('[data-card-action]').forEach((button) => button.addEventListener('click', () => showCardAction(Number(button.dataset.id), button.dataset.cardAction)));
}

function showAdminCardDetail(card) {
  openModal(`${card.name}的室友卡片`, `<div class="detail-header">${avatar(card.avatar_url, card.name, 'avatar-lg')}<div><h2>${escapeHtml(card.name)}</h2><p>${escapeHtml(card.grade)} · ${escapeHtml(card.school)} ${escapeHtml(card.campus)}</p></div></div><div class="section"><dl class="detail-grid"><div class="detail-item"><dt>作息偏好</dt><dd>${escapeHtml(card.sleep_preferences.join('、'))}</dd></div><div class="detail-item"><dt>空调温度</dt><dd>夏 ${card.summer_temp_min}–${card.summer_temp_max}°C / 冬 ${card.winter_temp_min}–${card.winter_temp_max}°C</dd></div><div class="detail-item"><dt>个人性格</dt><dd>${escapeHtml(card.personality_tags.join('、'))}</dd></div><div class="detail-item"><dt>期望室友</dt><dd>${escapeHtml(card.roommate_personality_tags.join('、'))}</dd></div><div class="detail-item"><dt>自认为的缺点</dt><dd>${escapeHtml(card.self_acknowledged_shortcoming)}</dd></div><div class="detail-item"><dt>还想说的话</dt><dd>${escapeHtml(card.additional_note || '-')}</dd></div></dl></div>`, { wide: true });
}

function showCardAction(cardId, action) {
  const modal = openModal(action === 'hide' ? '隐藏室友卡片' : '恢复室友卡片', `<div class="form-field"><label>操作原因</label><textarea id="card-action-reason" ${action === 'hide' ? 'required' : ''}></textarea></div><div class="modal-actions"><button class="btn btn-secondary" data-cancel>取消</button><button class="btn ${action === 'hide' ? 'btn-danger' : 'btn-primary'}" data-confirm>确认</button></div>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('[data-confirm]').addEventListener('click', async () => {
    try { await api(`/api/admin/roommate-cards/${cardId}/${action}`, { method: 'POST', body: JSON.stringify({ reason: modal.querySelector('#card-action-reason').value }) }); closeModal(); toast(action === 'hide' ? '卡片已隐藏' : '卡片已恢复'); await renderAdminCards(); }
    catch (error) { toast(error.message, 'error'); }
  });
}

async function renderAdminGroups() {
  const { dormitories, open } = await api('/api/admin/dormitories');
  setPage(`<div class="toolbar"><div class="toolbar-spacer"></div><button class="btn btn-primary" id="export-dormitories">${icon('file-spreadsheet')}导出 Excel</button></div><div class="stage-banner ${open ? 'open' : 'closed'}">${icon(open ? 'door-open' : 'lock-keyhole')}<div><strong>自由选宿舍阶段${open ? '进行中' : '已关闭'}</strong><span>阶段开关可在数据概览中调整</span></div></div>${dormitories.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>宿舍</th><th>发起人</th><th>成员</th><th>状态</th><th>创建时间</th><th></th></tr></thead><tbody>${dormitories.map((dormitory) => `<tr><td><strong>${escapeHtml(dormitory.name)}</strong><div class="field-hint">${escapeHtml(dormitory.dormitory_code)} · ${dormitory.building && dormitory.room_number ? `${escapeHtml(dormitory.building)} ${escapeHtml(dormitory.room_number)}` : '待分配房间'}</div></td><td>${escapeHtml(dormitory.initiator_name)}</td><td>${dormitory.members.map((member) => escapeHtml(member.name)).join('、')}<div class="field-hint">${dormitory.member_count}/4 人</div></td><td>${statusBadge(labels.dormitoryStatus[dormitory.status], dormitory.status.toLowerCase())}</td><td>${formatDate(dormitory.created_at)}</td><td><div class="cell-actions"><button class="btn btn-secondary btn-sm" data-assign-dorm="${dormitory.id}">${icon('map-pin')}分配房间</button>${dormitory.status !== 'CLOSED' ? `<button class="btn btn-danger btn-sm" data-close-dorm="${dormitory.id}">${icon('lock-keyhole')}关闭宿舍</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>` : emptyState('bed-double', '暂无宿舍', '学生创建宿舍后将在这里显示')}`);
  document.querySelector('#export-dormitories').addEventListener('click', downloadDormitoryExport);
  document.querySelectorAll('[data-assign-dorm]').forEach((button) => button.addEventListener('click', () => showAssignDormitory(dormitories.find((item) => item.id === Number(button.dataset.assignDorm)))));
  document.querySelectorAll('[data-close-dorm]').forEach((button) => button.addEventListener('click', () => showCloseDormitory(Number(button.dataset.closeDorm))));
}

async function downloadDormitoryExport(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch('/api/admin/dormitories/export', { credentials: 'same-origin' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error?.message || '导出失败，请稍后重试');
    }
    const filename = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] || 'dormitories.xlsx';
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    toast('宿舍列表已导出');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

function showAssignDormitory(dormitory) {
  const modal = openModal('分配楼栋和房间', `<form id="assign-dorm-form" class="form-grid"><div class="form-field"><label>楼栋</label><input name="building" maxlength="40" value="${escapeHtml(dormitory.building)}" placeholder="例如：北苑 3 号楼" required></div><div class="form-field"><label>房间号</label><input name="roomNumber" maxlength="20" value="${escapeHtml(dormitory.room_number)}" placeholder="例如：301" required></div><div class="form-field full"><label>分配说明</label><input name="reason" maxlength="200" placeholder="例如：第一批统一分配" required></div><div class="form-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary">${icon('map-pin')}确认分配</button></div></form>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('#assign-dorm-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await api(`/api/admin/dormitories/${dormitory.id}/location`, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); closeModal(); toast('宿舍房间已分配'); await renderAdminGroups(); }
    catch (error) { toast(error.message, 'error'); }
  });
}

function showCloseDormitory(dormitoryId) {
  const modal = openModal('关闭宿舍', `<p>关闭后宿舍不再接受申请，已有成员关系保留。</p><div class="form-field"><label>关闭原因</label><textarea id="close-dorm-reason" required></textarea></div><div class="modal-actions"><button class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-danger" data-confirm>${icon('lock-keyhole')}确认关闭</button></div>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('[data-confirm]').addEventListener('click', async () => {
    try { await api(`/api/admin/dormitories/${dormitoryId}/close`, { method: 'POST', body: JSON.stringify({ reason: modal.querySelector('#close-dorm-reason').value }) }); closeModal(); toast('宿舍已关闭'); await renderAdminGroups(); }
    catch (error) { toast(error.message, 'error'); }
  });
}

async function renderAdminReports() {
  const { reports } = await api('/api/admin/reports');
  setPage(reports.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>举报人</th><th>对象</th><th>原因</th><th>提交时间</th><th>状态</th><th></th></tr></thead><tbody>${reports.map((report) => `<tr><td>${escapeHtml(report.reporter_name)}</td><td>${report.target_type === 'ROOMMATE_CARD' ? '室友卡片' : '私信消息'} #${report.target_id}</td><td><strong>${escapeHtml(report.reason)}</strong><div class="field-hint">${escapeHtml(report.description)}</div></td><td>${formatDate(report.created_at)}</td><td>${statusBadge(labels.reportStatus[report.status], report.status.toLowerCase())}</td><td>${report.status === 'PENDING' ? `<button class="btn btn-primary btn-sm" data-resolve="${report.id}">${icon('check')}处理</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : emptyState('shield-check', '没有待处理举报', '当前没有用户提交的举报记录'));
  document.querySelectorAll('[data-resolve]').forEach((button) => button.addEventListener('click', () => showResolveReport(reports.find((report) => report.id === Number(button.dataset.resolve)))));
}

function showResolveReport(report) {
  const snapshot = Object.entries(report.snapshot || {}).map(([key, value]) => `<div class="detail-item"><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(typeof value === 'object' ? JSON.stringify(value) : value)}</dd></div>`).join('');
  const modal = openModal('处理举报', `<div class="section"><div class="section-heading"><div><h2>举报快照</h2><p>仅展示用户主动提交的被举报内容</p></div></div><dl class="detail-grid">${snapshot || '<div class="field-hint">无可用快照</div>'}</dl></div><form id="resolve-form" class="form-grid"><div class="form-field full"><label>处理结论</label><select name="status"><option value="RESOLVED">举报成立</option><option value="REJECTED">举报不成立</option></select></div><div class="form-field full"><label>处理说明</label><textarea name="resolution" required></textarea></div><div class="form-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary">${icon('check')}完成处理</button></div></form>`, { wide: true });
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('#resolve-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await api(`/api/admin/reports/${report.id}/resolve`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); closeModal(); toast('举报已处理'); await renderAdminReports(); }
    catch (error) { toast(error.message, 'error'); }
  });
}

async function renderAdminAudit() {
  const { logs } = await api('/api/admin/audit-logs');
  setPage(logs.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>管理员</th><th>操作</th><th>对象</th><th>原因</th><th>时间</th></tr></thead><tbody>${logs.map((log) => `<tr><td>${escapeHtml(log.admin_name || '系统')}</td><td><strong>${escapeHtml(log.action)}</strong></td><td>${escapeHtml(log.target_type)} #${escapeHtml(log.target_id)}</td><td>${escapeHtml(log.reason || '-')}</td><td>${formatDate(log.created_at)}</td></tr>`).join('')}</tbody></table></div>` : emptyState('scroll-text', '暂无审计记录', '管理员关键操作将在这里留痕'));
}

async function init() {
  try {
    const data = await api('/api/me');
    state.user = data.user;
    state.gender = data.user.gender === 'MALE' ? 'MALE' : 'FEMALE';
    state.csrfToken = data.csrfToken;
    state.view = data.user.role === 'ADMIN' ? 'overview' : 'discover';
    await navigate(state.view);
  } catch {
    renderLogin();
  }
}

init();
