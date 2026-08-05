const app = document.querySelector('#app');
const modalRoot = document.querySelector('#modal-root');
const toastRoot = document.querySelector('#toast-root');
const API_PATH_CHARACTERS = 'abcdefghijklmnopqrstuvwxyz0123456789-';
const API_QUERY_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~%=&+*';

const state = {
  user: null,
  csrfToken: '',
  view: 'discover',
  mode: 'student',
  selectedConversationId: null,
  search: '',
  grade: '',
  availability: 'AVAILABLE',
  gender: null,
  applicationDormitoryId: null,
  dormitorySearch: '',
  adminRoundId: null,
  selectionGroups: [],
};

const labels = {
  cleanliness: {
    BASIC: '乱中有序自由整理，不产生异味或虫害即可',
    TIDY: '大部分时间整齐，物品不过度堆积',
    STRICT: '长期保持整洁，物品及时归位',
  },
  commonSpace: {
    USABLE: '不影响正常使用即可，不需要固定规则',
    RESTORE: '使用后基本恢复原状，保持公共区域基本整洁',
    CLEAN_TOGETHER: '共同制定定期打扫计划，保持较高整洁度',
    NEGOTIABLE: '都可以，愿意与室友具体协商',
  },
  cardStatus: { DRAFT: '草稿', PUBLISHED: '已发布', HIDDEN: '已隐藏' },
  userStatus: { PENDING_ACTIVATION: '待激活', ACTIVE: '正常', SUSPENDED: '已停用', BANNED: '已封禁' },
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
  const [pathname, query, ...extraParts] = typeof path === 'string' ? path.split('?') : [];
  const pathSegments = pathname?.startsWith('/api/') ? pathname.slice(5).split('/') : [];
  const validPath = pathSegments.length > 0 && pathSegments.every((segment) => segment && [...segment].every((character) => API_PATH_CHARACTERS.includes(character)));
  const validQuery = query === undefined || [...query].every((character) => API_QUERY_CHARACTERS.includes(character));
  if (!validPath || !validQuery || extraParts.length) throw new Error('接口地址无效');
  const requestUrl = new URL(path, window.location.origin);
  if (requestUrl.origin !== window.location.origin) throw new Error('接口地址无效');
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.csrfToken && !['GET', 'HEAD'].includes(options.method || 'GET')) headers['X-CSRF-Token'] = state.csrfToken;
  const response = await fetch(requestUrl, { credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && state.user) {
      state.user = null;
      state.csrfToken = '';
      const next = window.location.pathname === '/roommates' ? '/roommates' : '/';
      history.replaceState({}, '', next === '/roommates' ? '/login?next=%2Froommates' : '/login');
      renderLoginPage();
    }
    if (response.status === 403 && state.user && state.mode === 'management') {
      try {
        const refreshed = await fetch('/api/me', { credentials: 'same-origin' });
        if (refreshed.ok) {
          const session = await refreshed.json();
          state.user = session.user;
          state.csrfToken = session.csrfToken;
          if (!state.user.canManage && state.user.accountType === 'USER') {
            state.mode = 'student';
            state.view = 'discover';
          } else if (!visibleAdminNav().some(([view]) => view === state.view)) {
            state.view = 'overview';
          }
          setTimeout(() => navigate(state.view), 0);
        }
      } catch {}
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

function personPickerTools(prefix, groups = state.selectionGroups) {
  return `<div class="person-picker-tools"><div class="search-field">${icon('search')}<input data-person-search="${prefix}" placeholder="按姓名搜索"></div><select data-person-group="${prefix}" aria-label="预设学生群组" ${groups.length ? '' : 'disabled'}><option value="">选择预设群组</option>${groups.map((group) => `<option value="${group.id}">${escapeHtml(group.name)}（${group.members.length} 人）</option>`).join('')}</select><button type="button" class="btn btn-secondary" data-add-person-group="${prefix}" ${groups.length ? '' : 'disabled'}>${icon('user-plus')}一键添加</button></div>`;
}

function bindPersonPicker(form, prefix, groups = state.selectionGroups) {
  form.querySelector(`[data-person-search="${prefix}"]`).addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    form.querySelectorAll(`[data-person-picker="${prefix}"] [data-person-name]`).forEach((candidate) => {
      candidate.hidden = query && !candidate.dataset.personName.includes(query);
    });
  });
  form.querySelector(`[data-add-person-group="${prefix}"]`)?.addEventListener('click', () => {
    const groupId = Number(form.querySelector(`[data-person-group="${prefix}"]`).value);
    const group = groups.find((item) => item.id === groupId);
    if (!group) return toast('请先选择预设群组', 'error');
    const memberIds = new Set(group.members.map((member) => member.id));
    let added = 0;
    form.querySelectorAll(`[data-person-picker="${prefix}"] input[type="checkbox"]`).forEach((input) => {
      if (memberIds.has(Number(input.value)) && !input.checked) {
        input.checked = true;
        added += 1;
      }
    });
    toast(added ? `已添加 ${added} 名学生` : '群组成员已全部选中');
  });
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
  ['history', 'history', '历史结果'],
  ['settings', 'settings', '账号设置'],
];

const adminNav = [
  ['overview', 'layout-dashboard', '数据概览'],
  ['users', 'users', '账号管理'],
  ['cards', 'contact-round', '卡片治理'],
  ['rounds', 'calendar-range', '选宿舍轮次'],
  ['groups', 'bed-double', '宿舍组'],
  ['reports', 'shield-alert', '举报处理'],
  ['audit', 'scroll-text', '审计日志'],
  ['access', 'shield-check', '权限管理'],
];

function hasPermission(code) {
  return Boolean(state.user?.isSuperAdmin || state.user?.permissions?.includes(code));
}

function permissionGradeIds(code, sourceGradeId = null) {
  if (state.user?.isSuperAdmin) return null;
  return [...new Set((state.user?.groups || [])
    .filter((group) => group.permissions.includes(code) && (sourceGradeId == null || group.gradeIds.includes(Number(sourceGradeId))))
    .flatMap((group) => group.gradeIds))];
}

function hasScopedPermission(code, gradeId) {
  const gradeIds = permissionGradeIds(code);
  return gradeIds === null || gradeIds.includes(Number(gradeId));
}

function visibleAdminNav() {
  return adminNav.filter(([key]) => {
    if (key === 'overview') return true;
    if (key === 'users') return hasPermission('USER_READ') || hasPermission('USER_IMPORT') || hasPermission('USER_EXPORT') || hasPermission('USER_LOGIN_IDENTIFIER_UPDATE');
    if (key === 'cards') return hasPermission('CARD_READ');
    if (key === 'groups') return hasPermission('DORMITORY_READ');
    if (key === 'reports') return hasPermission('REPORT_READ');
    if (key === 'audit') return state.user.isSuperAdmin || hasPermission('AUDIT_READ_SCOPED');
    return state.user.isSuperAdmin;
  });
}

const titles = {
  discover: ['找室友', '浏览已发布的室友卡片'],
  profile: ['我的室友卡片', '维护你的生活习惯与室友偏好'],
  messages: ['私信', '与意向室友继续沟通'],
  dorm: ['自由选宿舍', '创建宿舍或申请加入同性别宿舍'],
  history: ['历史选宿舍', '查看每一次选宿舍轮次保留的结果'],
  settings: ['账号设置', '身份字段由管理员统一维护'],
  overview: ['数据概览', '平台当前运行状态'],
  users: ['账号管理', '导入正式账号并维护身份字段'],
  cards: ['卡片治理', '处理公开卡片中的违规内容'],
  rounds: ['选宿舍轮次', '配置参与学生并分别保留每轮结果'],
  groups: ['宿舍组管理', '查看和处理异常宿舍组'],
  reports: ['举报处理', '仅查看用户主动提交的举报快照'],
  audit: ['审计日志', '管理员关键操作留痕'],
  access: ['权限管理', '配置管理员组、权限、成员和年级范围'],
};

function goHome() {
  window.location.assign('/');
}

async function enterRoommateSystem() {
  if (!state.user) {
    if (window.location.pathname === '/roommates') history.replaceState({}, '', '/login?next=%2Froommates');
    else history.pushState({}, '', '/login?next=%2Froommates');
    renderLoginPage();
    return;
  }
  if (window.location.pathname !== '/roommates') history.pushState({}, '', '/roommates');
  state.mode = state.user.isSuperAdmin ? 'management' : 'student';
  state.view = state.mode === 'management' ? 'overview' : 'discover';
  if (state.user.mustChangePassword) {
    renderLoginPage();
    showRequiredPasswordChange(true);
    return;
  }
  await navigate(state.view);
}

function renderShell() {
  const management = state.mode === 'management';
  const nav = management ? visibleAdminNav() : studentNav;
  const [title, subtitle] = titles[state.view] || titles[nav[0][0]];
  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="sidebar-brand"><div class="brand-mark">合</div><div><strong>合住</strong><small>自由双选室友</small></div></div>
        <div class="nav-label">${management ? '管理工作台' : '室友双选'}</div>
        <nav class="nav-list">${nav.map(([key, iconName, label]) => `
          <button class="nav-item ${state.view === key ? 'active' : ''}" data-view="${key}">${icon(iconName)}<span>${label}</span></button>
        `).join('')}</nav>
        <div class="sidebar-user"><strong>${escapeHtml(state.user.name)}</strong><small>${management ? (state.user.isSuperAdmin ? '超级管理员' : '组管理员') : escapeHtml(state.user.grade)}</small></div>
      </aside>
      <main class="main-shell">
        <header class="topbar">
          <div class="topbar-title"><h1>${title}</h1><p>${subtitle}</p></div>
          <div class="topbar-actions">
            <button class="btn btn-secondary" id="home-btn">${icon('home')}<span>首页</span></button>
            ${state.user.accountType === 'USER' && state.user.canManage ? `<button class="btn btn-secondary" id="switch-mode">${icon(management ? 'users-round' : 'layout-dashboard')}<span>${management ? '返回学生端' : '进入管理工作台'}</span></button>` : ''}
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
  document.querySelector('#switch-mode')?.addEventListener('click', async () => {
    state.mode = management ? 'student' : 'management';
    await navigate(state.mode === 'management' ? 'overview' : 'discover');
  });
  document.querySelector('#home-btn').addEventListener('click', goHome);
  document.querySelector('#logout-btn').addEventListener('click', logout);
  refreshIcons();
}

async function navigate(view) {
  state.view = view;
  renderShell();
  try {
    if (state.mode === 'management') await loadAdminView(view);
    else await loadStudentView(view);
  } catch (error) {
    setPage(emptyState('circle-alert', '页面加载失败', error.message, `<button class="btn btn-secondary" id="retry-view">${icon('refresh-cw')}重试</button>`));
    document.querySelector('#retry-view')?.addEventListener('click', () => navigate(view));
  }
}

function renderLoginPage() {
  const continueToSystem = new URLSearchParams(window.location.search).get('next') === '/roommates';
  closeModal();
  app.innerHTML = `
    <main class="login-shell">
      <section class="login-panel">
        <div class="login-logo-band"><img src="/assets/logo/透明底白色字.png" alt="合住"></div>
        <button class="btn btn-quiet login-home" id="login-home">${icon('arrow-left')}返回首页</button>
        <h1>账号登录</h1>
        <p>使用管理员导入的正式账号进入系统。</p>
        <form id="login-form">
          <div class="form-field"><label for="login-id">登录标识</label><input id="login-id" name="loginIdentifier" autocomplete="username" required></div>
          <div class="form-field" style="margin-top:16px"><label for="login-password">密码</label><input id="login-password" name="password" type="password" autocomplete="current-password" required></div>
          <button class="btn btn-primary" style="width:100%;margin-top:20px" type="submit">${icon('log-in')}登录</button>
        </form>
      </section>
    </main>`;
  const form = document.querySelector('#login-form');
  document.querySelector('#login-home').addEventListener('click', goHome);
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
      state.mode = data.user.isSuperAdmin ? 'management' : 'student';
      state.view = state.mode === 'management' ? 'overview' : 'discover';
      if (data.user.mustChangePassword) {
        showRequiredPasswordChange(continueToSystem);
      } else if (continueToSystem) {
        history.replaceState({}, '', '/roommates');
        await enterRoommateSystem();
      } else {
        window.location.replace('/');
      }
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
  state.user = null;
  state.csrfToken = '';
  closeModal();
  goHome();
}

function showRequiredPasswordChange(continueToSystem = true) {
  const modal = openModal('修改初始密码', `<p>这是首次登录。设置你自己的密码后才能继续使用系统。</p><form id="required-password-form" class="form-grid"><div class="form-field full"><label>当前初始密码</label><input name="currentPassword" type="password" autocomplete="current-password" required></div><div class="form-field full"><label>新密码</label><input name="newPassword" type="password" minlength="8" autocomplete="new-password" required></div><div class="form-actions"><button type="button" class="btn btn-secondary" data-logout>退出登录</button><button class="btn btn-primary">${icon('key-round')}设置新密码</button></div></form>`);
  modal.querySelector('[data-close]').remove();
  modal.querySelector('[data-logout]').addEventListener('click', logout);
  modal.querySelector('#required-password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/me/password', { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      state.user.mustChangePassword = false;
      closeModal();
      toast('密码已更新');
      if (continueToSystem) await enterRoommateSystem();
      else goHome();
    } catch (error) { toast(error.message, 'error'); }
  });
}

async function loadStudentView(view) {
  if (view === 'discover') return renderDiscover();
  if (view === 'profile') return renderProfile();
  if (view === 'messages') return renderMessages();
  if (view === 'dorm') return renderDorm();
  if (view === 'history') return renderDormitoryHistory();
  if (view === 'settings') return renderSettings();
  return navigate('discover');
}

function roommateCard(card) {
  const own = card.is_own || card.user_id === state.user.id;
  const genderClass = card.gender === 'FEMALE' ? 'gender-female' : card.gender === 'MALE' ? 'gender-male' : '';
  const teamLabel = card.team_member_count >= 4 ? '室友组队已完成'
    : card.team_member_count === 3 ? '三缺一' : card.team_member_count === 2 ? '二缺二' : '一缺三';
  return `
    <article class="roommate-card ${genderClass}" data-card-id="${card.id}" tabindex="0">
      <div class="card-head">
        ${avatar(card.avatar_url, card.name)}
        <div class="card-title"><h3>${escapeHtml(card.name)}</h3><p>${escapeHtml(card.grade)} · ${escapeHtml(card.major || '-')}</p></div>
        ${own ? statusBadge('我的卡片', 'open', 'user-round') : ''}
      </div>
      <p class="card-city">${icon('map-pin')}${escapeHtml(card.origin_city || '城市未填写')}</p>
      <p class="card-note">${escapeHtml(card.one_sentence_intro || '-')}</p>
      <div class="card-team">${statusBadge(teamLabel, card.team_member_count >= 4 ? 'published' : 'open', 'users')}</div>
    </article>`;
}

function cardDetailMarkup(card, actions = '') {
  return `
    <div class="section">
      <div class="detail-header">${avatar(card.avatar_url, card.name, 'avatar-lg')}<div><h2>${escapeHtml(card.name)}</h2><p>${escapeHtml(card.grade)} · ${escapeHtml(card.major || '-')} · ${escapeHtml([card.origin_province, card.origin_city].filter(Boolean).join(' ') || '-')}</p></div>${actions}</div>
    </div>
    <div class="section"><div class="section-heading"><h2>个人信息</h2></div><dl class="detail-grid">
      <div class="detail-item"><dt>姓名</dt><dd>${escapeHtml(card.name)}</dd></div>
      <div class="detail-item"><dt>年级 / 性别</dt><dd>${escapeHtml(card.grade)} / ${card.gender === 'MALE' ? '男' : '女'}</dd></div>
      <div class="detail-item"><dt>专业</dt><dd>${escapeHtml(card.major || '-')}</dd></div>
      <div class="detail-item"><dt>来自地区</dt><dd>${escapeHtml([card.origin_province, card.origin_city].filter(Boolean).join(' ') || '-')}</dd></div>
      ${card.clothing_size !== undefined ? `<div class="detail-item"><dt>院服尺码</dt><dd>${escapeHtml(card.clothing_size || '-')}</dd></div>` : ''}
    </dl></div>
    <div class="section"><div class="section-heading"><h2>性格与兴趣</h2></div><dl class="detail-grid">
      <div class="detail-item"><dt>用一句话介绍自己</dt><dd>${escapeHtml(card.one_sentence_intro || '-')}</dd></div>
      <div class="detail-item"><dt>个人性格</dt><dd>${escapeHtml(card.personality_text || '-')}</dd></div>
      <div class="detail-item"><dt>期望室友的性格</dt><dd>${escapeHtml(card.roommate_personality_text || '-')}</dd></div>
      <div class="detail-item"><dt>兴趣爱好、喜欢的运动等</dt><dd>${escapeHtml(card.interests_text || '-')}</dd></div>
      <div class="detail-item"><dt>自认为的一个缺点</dt><dd>${escapeHtml(card.self_acknowledged_shortcoming || '-')}</dd></div>
    </dl></div>
    <div class="section"><div class="section-heading"><h2>生活节奏与空调</h2></div><dl class="detail-grid">
      <div class="detail-item"><dt>夏季 / 冬季空调</dt><dd>${card.summer_temp_min ?? '-'}–${card.summer_temp_max ?? '-'}°C / ${card.winter_temp_min ?? '-'}–${card.winter_temp_max ?? '-'}°C</dd></div>
      <div class="detail-item"><dt>早上起床</dt><dd>${escapeHtml(card.wake_up_time || '-')}</dd></div>
      <div class="detail-item"><dt>晚上睡觉</dt><dd>${escapeHtml(card.sleep_time || '-')}</dd></div>
      <div class="detail-item"><dt>午休习惯</dt><dd>${escapeHtml(card.nap_habit || '-')}</dd></div>
    </dl></div>
    <div class="section"><div class="section-heading"><h2>卫生与公共空间</h2></div><dl class="detail-grid">
      <div class="detail-item"><dt>本人宿舍整理习惯</dt><dd>${escapeHtml(labels.cleanliness[card.personal_cleanliness] || '-')}</dd></div>
      <div class="detail-item"><dt>对室友卫生的最低要求</dt><dd>${escapeHtml(labels.cleanliness[card.roommate_cleanliness] || '-')}</dd></div>
      <div class="detail-item"><dt>公共空间维护方式</dt><dd>${escapeHtml(labels.commonSpace[card.common_space_maintenance] || '-')}</dd></div>
      <div class="detail-item"><dt>不太能接受的卫生情况</dt><dd>${escapeHtml(card.unacceptable_hygiene || '-')}</dd></div>
    </dl></div>
    <div class="section"><div class="section-heading"><h2>游戏、声音与相处边界</h2></div><dl class="detail-grid">
      <div class="detail-item"><dt>对自己打游戏的要求</dt><dd>${escapeHtml(card.gaming_self || '-')}</dd></div>
      <div class="detail-item"><dt>对室友打游戏的要求</dt><dd>${escapeHtml(card.gaming_roommate || '-')}</dd></div>
      <div class="detail-item"><dt>鼠标键盘等声音</dt><dd>${escapeHtml(card.keyboard_noise_text || '-')}</dd></div>
      <div class="detail-item"><dt>游戏 / 视频声音外放</dt><dd>${escapeHtml(card.media_noise_text || '-')}</dd></div>
    </dl></div>
    <div class="section"><div class="section-heading"><h2>还想要对大家说</h2></div><p class="detail-message">${escapeHtml(card.additional_note || '-')}</p></div>`;
}

async function renderDiscover() {
  const params = new URLSearchParams({ availability: state.availability });
  state.gender ||= state.user.gender === 'MALE' ? 'MALE' : 'FEMALE';
  params.set('gender', state.gender);
  if (state.search) params.set('search', state.search);
  if (state.grade) params.set('grade', state.grade);
  const firstPage = await api(`/api/roommate-cards?${params}`);
  const cards = firstPage.cards;
  let total = firstPage.total;
  const grades = firstPage.grades;
  setPage(`
    <div class="toolbar">
      <div class="segmented" aria-label="性别分页"><button data-gender="FEMALE" class="${state.gender === 'FEMALE' ? 'active' : ''}">女生</button><button data-gender="MALE" class="${state.gender === 'MALE' ? 'active' : ''}">男生</button></div>
      <form class="search-field" id="search-form">${icon('search')}<input name="search" value="${escapeHtml(state.search)}" placeholder="搜索姓名"></form>
      <select id="grade-filter" aria-label="年级筛选"><option value="">全部年级</option>${grades.map((grade) => `<option ${state.grade === grade ? 'selected' : ''}>${escapeHtml(grade)}</option>`).join('')}</select>
      <div class="segmented"><button data-availability="AVAILABLE" class="${state.availability === 'AVAILABLE' ? 'active' : ''}">可组队</button><button data-availability="ALL" class="${state.availability === 'ALL' ? 'active' : ''}">全部</button></div>
    </div>
    ${cards.length ? `<div class="roommate-grid">${cards.map(roommateCard).join('')}</div>${cards.length < total ? `<div class="load-more"><button class="btn btn-secondary" id="load-more-cards">${icon('chevrons-down')}查看更多</button></div>` : ''}` : emptyState('users-round', '没有匹配的室友卡片', '调整筛选条件后再试试')}`);
  document.querySelector('#search-form').addEventListener('submit', (event) => {
    event.preventDefault(); state.search = new FormData(event.currentTarget).get('search').trim(); renderDiscover();
  });
  document.querySelector('#grade-filter').addEventListener('change', (event) => { state.grade = event.target.value; renderDiscover(); });
  document.querySelectorAll('[data-gender]').forEach((button) => button.addEventListener('click', () => {
    state.gender = button.dataset.gender; state.grade = ''; renderDiscover();
  }));
  document.querySelectorAll('[data-availability]').forEach((button) => button.addEventListener('click', () => { state.availability = button.dataset.availability; renderDiscover(); }));
  const grid = document.querySelector('.roommate-grid');
  grid?.addEventListener('click', (event) => {
    const card = event.target.closest('[data-card-id]');
    if (card) showCardDetail(Number(card.dataset.cardId));
  });
  grid?.addEventListener('keydown', (event) => {
    const card = event.target.closest('[data-card-id]');
    if (card && event.key === 'Enter') showCardDetail(Number(card.dataset.cardId));
  });
  document.querySelector('#load-more-cards')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.innerHTML = `${icon('loader-circle')}加载中`;
    refreshIcons();
    try {
      params.set('offset', String(cards.length));
      const nextPage = await api(`/api/roommate-cards?${params}`);
      cards.push(...nextPage.cards);
      total = nextPage.total;
      grid.insertAdjacentHTML('beforeend', nextPage.cards.map(roommateCard).join(''));
      refreshIcons();
      if (!nextPage.cards.length || cards.length >= total) button.closest('.load-more').remove();
      else button.innerHTML = `${icon('chevrons-down')}查看更多`;
    } catch (error) {
      button.innerHTML = `${icon('chevrons-down')}查看更多`;
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
      refreshIcons();
    }
  });
}

async function showCardDetail(cardId) {
  try {
    const { card } = await api(`/api/roommate-cards/${cardId}`);
    const own = card.user_id === state.user.id;
    const actions = `<div class="detail-actions">${own ? `<button class="btn btn-primary" data-edit-own>${icon('pencil')}编辑</button>` : `<button class="btn btn-primary" data-message>${icon('message-circle')}发私信</button><button class="btn btn-secondary" data-report>${icon('flag')}举报</button><button class="btn btn-quiet" data-block title="拉黑用户">${icon('user-x')}</button>`}</div>`;
    const modal = openModal(`${card.name}的室友卡片`, cardDetailMarkup(card, actions), { wide: true });
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

function value(card, key) { return escapeHtml(card?.[key] ?? ''); }

async function renderProfile() {
  const { card } = await api('/api/me/roommate-card');
  const current = card || {};
  setPage(`
    <div class="profile-layout">
      <form class="profile-form" id="profile-form" novalidate>
        <div class="section">
          <div class="section-heading"><div><h2>身份信息</h2><p>以下字段由管理员导入和维护，学生不能修改</p></div>${card ? statusBadge(labels.cardStatus[card.status], card.status === 'PUBLISHED' ? 'published' : card.status.toLowerCase()) : statusBadge('未创建', 'draft')}</div>
          <div class="form-grid">
            <div class="form-field"><label>姓名</label><input value="${escapeHtml(state.user.name)}" disabled></div>
            <div class="form-field"><label>年级</label><input value="${escapeHtml(state.user.grade)}" disabled></div>
            <div class="form-field"><label>性别</label><input value="${state.user.gender === 'MALE' ? '男' : '女'}" disabled></div>
            <div class="form-field"><label>专业</label><input value="${escapeHtml(state.user.major || '')}" disabled></div>
          </div>
        </div>
        <div class="section">
          <div class="section-heading"><div><h2>个人信息</h2><p>填写地区、院服尺码并上传头像</p></div></div>
          <div class="form-grid">
            <div class="form-field"><label class="required">来自省份</label><input name="origin_province" maxlength="30" value="${value(current, 'origin_province')}" placeholder="例如：浙江" required></div>
            <div class="form-field"><label class="required">来自城市</label><input name="origin_city" maxlength="30" value="${value(current, 'origin_city')}" placeholder="例如：杭州" required></div>
            <div class="form-field"><label class="required">院服尺码</label><select name="clothing_size" required><option value="">请选择</option>${['S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL'].map((size) => `<option value="${size}" ${current.clothing_size === size ? 'selected' : ''}>${size}</option>`).join('')}</select></div>
            <div class="form-field full"><details class="size-guide"><summary>查看院服尺码表</summary><div class="size-table-wrap"><table class="size-table"><thead><tr><th>尺码</th><th>衣长</th><th>胸围 1/2</th><th>肩宽</th><th>建议身高</th><th>建议体重</th></tr></thead><tbody>${[
              ['S', 64, 47, 43, '155-160', '80-90'], ['M', 66, 49, 44, '160-165', '90-100'], ['L', 68, 51, 45, '165-170', '100-120'], ['XL', 70, 53, 46, '170-175', '120-140'], ['XXL', 72, 55, 47, '175-180', '140-160'], ['XXXL', 74, 57, 48, '180-185', '160-180'], ['XXXXL', 76, 59, 49, '185-190', '180-200'],
            ].map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div></details></div>
            <div class="form-field full"><label class="required">头像</label><div class="avatar-upload">${avatar(current.avatar_url, state.user.name, 'avatar-lg')}<label class="btn btn-secondary" for="avatar-file">${icon('upload')}上传头像</label><input id="avatar-file" type="file" accept="image/png,image/jpeg,image/webp"><input type="hidden" name="avatar_url" value="${value(current, 'avatar_url')}"></div><span class="field-hint">PNG、JPG 或 WebP，建议使用正方形图片，文件不超过 2 MB</span></div>
          </div>
        </div>
        <div class="section">
          <div class="section-heading"><div><h2>生活节奏与空调</h2><p>请用具体时间描述你的日常作息</p></div></div>
          <div class="form-grid">
            <div class="form-field full"><label class="required">适宜的空调温度</label><div class="temperature-grid"><span>夏季</span><input type="number" name="summer_temp_min" min="10" max="35" value="${value(current, 'summer_temp_min')}" placeholder="下限" required><b>至</b><input type="number" name="summer_temp_max" min="10" max="35" value="${value(current, 'summer_temp_max')}" placeholder="上限" required><span>冬季</span><input type="number" name="winter_temp_min" min="10" max="35" value="${value(current, 'winter_temp_min')}" placeholder="下限" required><b>至</b><input type="number" name="winter_temp_max" min="10" max="35" value="${value(current, 'winter_temp_max')}" placeholder="上限" required></div></div>
            <div class="form-field"><label class="required">早上起床</label><input name="wake_up_time" maxlength="120" value="${value(current, 'wake_up_time')}" placeholder="例如：工作日 7:00，周末 8:30" required></div>
            <div class="form-field"><label class="required">晚上睡觉</label><input name="sleep_time" maxlength="120" value="${value(current, 'sleep_time')}" placeholder="例如：23:30 左右" required></div>
            <div class="form-field full"><label class="required">午休习惯</label><input name="nap_habit" maxlength="120" value="${value(current, 'nap_habit')}" placeholder="例如：有午休习惯，通常 30 分钟" required></div>
          </div>
        </div>
        <div class="section">
          <div class="section-heading"><div><h2>卫生与公共空间</h2><p>分别说明自己的习惯和对室友的最低要求</p></div></div>
          <div class="form-grid">
            <div class="form-field full"><label class="required">平时的宿舍整理习惯</label><select name="personal_cleanliness" required><option value="">请选择</option>${Object.entries(labels.cleanliness).map(([key, label]) => `<option value="${key}" ${current.personal_cleanliness === key ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></div>
            <div class="form-field full"><label class="required">对室友宿舍卫生的最低要求</label><select name="roommate_cleanliness" required><option value="">请选择</option>${Object.entries(labels.cleanliness).map(([key, label]) => `<option value="${key}" ${current.roommate_cleanliness === key ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></div>
            <div class="form-field full"><label class="required">希望如何维护宿舍公共空间</label><select name="common_space_maintenance" required><option value="">请选择</option>${Object.entries(labels.commonSpace).map(([key, label]) => `<option value="${key}" ${current.common_space_maintenance === key ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></div>
            <div class="form-field full"><label>不太能接受的卫生情况</label><textarea name="unacceptable_hygiene" maxlength="300" placeholder="例如：长期不倒垃圾、在宿舍吸烟">${value(current, 'unacceptable_hygiene')}</textarea></div>
          </div>
        </div>
        <div class="section">
          <div class="section-heading"><div><h2>性格与兴趣</h2><p>用自己的语言介绍，不限制为预设标签</p></div></div>
          <div class="form-grid">
            <div class="form-field full"><label class="required">用一句话介绍自己</label><input name="one_sentence_intro" maxlength="100" value="${value(current, 'one_sentence_intro')}" placeholder="这句话会展示在卡片预览中" required></div>
            <div class="form-field full"><label class="required">个人性格</label><textarea name="personality_text" maxlength="300" required>${value(current, 'personality_text')}</textarea></div>
            <div class="form-field full"><label class="required">期望室友的性格</label><textarea name="roommate_personality_text" maxlength="300" required>${value(current, 'roommate_personality_text')}</textarea></div>
            <div class="form-field full"><label class="required">兴趣爱好、喜欢的运动等</label><textarea name="interests_text" maxlength="400" required>${value(current, 'interests_text')}</textarea></div>
            <div class="form-field full"><label class="required">自认为的一个缺点</label><textarea name="self_acknowledged_shortcoming" maxlength="200" required>${value(current, 'self_acknowledged_shortcoming')}</textarea></div>
          </div>
        </div>
        <div class="section">
          <div class="section-heading"><div><h2>游戏、声音与相处边界</h2><p>说明你可以接受的具体情况</p></div></div>
          <div class="form-grid">
            <div class="form-field full"><label class="required">对自己打游戏的要求</label><textarea name="gaming_self" maxlength="300" required>${value(current, 'gaming_self')}</textarea></div>
            <div class="form-field full"><label class="required">对室友打游戏的要求</label><textarea name="gaming_roommate" maxlength="300" required>${value(current, 'gaming_roommate')}</textarea></div>
            <div class="form-field full"><label class="required">是否介意点击鼠标键盘等声音</label><textarea name="keyboard_noise_text" maxlength="300" required>${value(current, 'keyboard_noise_text')}</textarea></div>
            <div class="form-field full"><label class="required">是否介意游戏 / 视频声音外放</label><textarea name="media_noise_text" maxlength="300" required>${value(current, 'media_noise_text')}</textarea></div>
          </div>
        </div>
        <div class="section">
          <div class="section-heading"><div><h2>还想要对大家说</h2><p>可以补充任何希望未来室友提前了解的内容</p></div></div>
          <div class="form-grid">
            <div class="form-field full"><textarea name="additional_note" maxlength="500" aria-label="还想要对大家说">${value(current, 'additional_note')}</textarea></div>
          </div>
        </div>
        ${card?.status === 'HIDDEN' ? `<div class="panel" style="background:var(--danger-soft);color:var(--danger)"><strong>卡片已隐藏</strong><p>${escapeHtml(card.hidden_reason)}</p></div>` : ''}
        <div class="form-actions">
          <button class="btn ${card && card.status !== 'DRAFT' ? 'btn-primary' : 'btn-secondary'}" type="submit">${icon('save')}${card && card.status !== 'DRAFT' ? '更新卡片' : '保存草稿'}</button>
          ${!card || ['DRAFT'].includes(card.status) ? `<button class="btn btn-primary" type="button" data-publish>${icon('send')}发布卡片</button>` : ''}
        </div>
      </form>
      <aside class="preview-panel"><h3>卡片预览</h3>${card ? roommateCard(card).replace('data-card-id', 'data-preview-id') : `<p class="field-hint">保存后将在这里显示卡片预览。</p>`}</aside>
    </div>`);
  const form = document.querySelector('#profile-form');
  document.querySelector('#avatar-file').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return toast('头像不能超过 2 MB', 'error');
    const reader = new FileReader();
    reader.onload = () => { form.avatar_url.value = reader.result; form.querySelector('.avatar-lg').src = reader.result; };
    reader.readAsDataURL(file);
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await saveProfile(form); toast(card && card.status !== 'DRAFT' ? '室友卡片已更新' : '草稿已保存'); await renderProfile(); }
    catch (error) { toast(error.message, 'error'); }
  });
  form.querySelector('[data-publish]')?.addEventListener('click', async () => {
    if (!form.reportValidity()) return;
    try { await saveProfile(form); await api('/api/me/roommate-card/publish', { method: 'POST', body: '{}' }); toast('卡片已发布'); await renderProfile(); }
    catch (error) { toast(error.message, 'error'); }
  });
}

async function saveProfile(form) {
  const data = Object.fromEntries(new FormData(form));
  return api('/api/me/roommate-card', { method: 'PUT', body: JSON.stringify(data) });
}

async function renderMessages() {
  const { conversations } = await api('/api/conversations');
  const selectedExists = conversations.some((conversation) => conversation.id === state.selectedConversationId);
  if (!selectedExists) {
    state.selectedConversationId = conversations[0]?.id || null;
    state.applicationDormitoryId = null;
  }
  document.querySelector('#page-content')?.classList.add('message-page');
  setPage(`<div class="message-workspace ${state.selectedConversationId ? 'chat-open' : ''}">
    <aside class="conversation-list"><div class="conversation-list-head"><strong>全部会话</strong><div class="search-field">${icon('search')}<input id="conversation-search" placeholder="按姓名搜索"></div></div>${conversations.length ? conversations.map((item) => `
      <button class="conversation-item ${state.selectedConversationId === item.id ? 'active' : ''}" data-conversation="${item.id}" data-person-name="${escapeHtml(item.other_name.toLowerCase())}">
        ${avatar(item.other_avatar, item.other_name, 'avatar-sm')}<div class="conversation-copy"><strong>${escapeHtml(item.other_name)}</strong><p>${escapeHtml(item.last_message || '尚未发送消息')}</p></div>${item.unread_count ? `<span class="unread">${item.unread_count}</span>` : ''}
      </button>`).join('') : emptyState('message-circle', '还没有私信', '从室友卡片进入详情后发起联系')}</aside>
    <section class="chat" id="chat-panel">${state.selectedConversationId ? await chatMarkup(state.selectedConversationId, conversations) : emptyState('messages-square', '选择一段会话', '查看消息并继续沟通')}</section>
  </div>`);
  document.querySelectorAll('[data-conversation]').forEach((button) => button.addEventListener('click', async () => {
    state.selectedConversationId = Number(button.dataset.conversation);
    state.applicationDormitoryId = null;
    await renderMessages();
  }));
  document.querySelector('#conversation-search')?.addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll('.conversation-item[data-person-name]').forEach((item) => {
      item.hidden = query && !item.dataset.personName.includes(query);
    });
  });
  bindChat();
}

async function chatMarkup(conversationId, conversations) {
  const conversation = conversations.find((item) => item.id === conversationId);
  if (!conversation) return emptyState('message-circle', '会话不存在', '请选择其他会话');
  let messagePage;
  try {
    messagePage = await api(`/api/conversations/${conversationId}/messages`);
    const lastMessageId = messagePage.messages[messagePage.messages.length - 1]?.id;
    if (lastMessageId) await api(`/api/conversations/${conversationId}/read`, { method: 'POST', body: JSON.stringify({ lastMessageId }) });
  } catch (error) {
    if (error.code === 'CONVERSATION_NOT_FOUND' || error.status === 404) {
      state.selectedConversationId = null;
      state.applicationDormitoryId = null;
      return emptyState('message-circle', '会话已失效', '返回会话列表后将自动刷新');
    }
    throw error;
  }
  const { messages, hasMore, nextBeforeId } = messagePage;
  return `
    <header class="chat-head"><button class="btn btn-quiet icon-btn only-mobile" data-chat-back>${icon('arrow-left')}</button>${avatar(conversation.other_avatar, conversation.other_name, 'avatar-sm')}<div><strong>${escapeHtml(conversation.other_name)}</strong><div class="field-hint">${escapeHtml(conversation.other_grade)}</div></div></header>
    <div class="chat-messages" id="chat-messages">${hasMore ? `<button class="btn btn-quiet btn-sm" data-load-earlier data-before-id="${nextBeforeId}">加载更早消息</button>` : ''}${state.applicationDormitoryId ? `<div class="application-compose"><div><strong>申请加入宿舍</strong><span>申请将以卡片形式发送给宿舍发起人</span></div><button class="btn btn-primary btn-sm" data-send-application>${icon('send')}填写申请</button></div>` : ''}${messages.length ? messages.map(messageMarkup).join('') : emptyState('message-circle', '开始交流', '说说你的作息习惯或对宿舍生活的期待')}</div>
    <form class="chat-compose" id="message-form"><textarea name="body" maxlength="2000" placeholder="输入消息" required></textarea><button class="btn btn-primary icon-btn" title="发送消息">${icon('send')}</button></form>`;
}

function messageMarkup(message) {
  if (message.message_type === 'DORMITORY_APPLICATION') {
    const applicationStatus = message.application_status || 'CANCELLED';
    const pending = applicationStatus === 'PENDING';
    const canReview = pending && message.sender_id !== state.user.id && message.selection_round_status === 'OPEN';
    return `<div class="application-card ${message.sender_id === state.user.id ? 'mine' : ''}">
      <div class="application-card-head">${icon('bed-double')}<div><strong>加入宿舍申请</strong><span>${escapeHtml(message.selection_round_name || '历史轮次')} · ${escapeHtml(message.dormitory_name || '原宿舍')} · ${escapeHtml(message.dormitory_code || '已失效')}</span></div>${statusBadge(labels.applicationStatus[applicationStatus], applicationStatus.toLowerCase())}</div>
      <p>${escapeHtml(message.application_note || message.body)}</p>
      <div class="application-card-foot"><span>${message.dormitory_member_count}/${message.dormitory_capacity} 人 · ${formatDate(message.created_at)}</span>${canReview ? `<div><button class="btn btn-secondary btn-sm" data-review-application="${message.application_id}" data-action="reject">拒绝</button><button class="btn btn-primary btn-sm" data-review-application="${message.application_id}" data-action="approve">通过</button></div>` : ''}</div>
    </div>`;
  }
  return `<div class="message ${message.sender_id === state.user.id ? 'mine' : ''}">${escapeHtml(message.body)}<span class="message-time">${formatDate(message.created_at)}</span></div>`;
}

function bindChat() {
  const messages = document.querySelector('#chat-messages');
  if (messages) messages.scrollTop = messages.scrollHeight;
  document.querySelector('[data-load-earlier]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const previousHeight = messages.scrollHeight;
    try {
      const page = await api(`/api/conversations/${state.selectedConversationId}/messages?beforeId=${button.dataset.beforeId}`);
      button.insertAdjacentHTML('afterend', page.messages.map(messageMarkup).join(''));
      if (page.hasMore) button.dataset.beforeId = page.nextBeforeId;
      else button.remove();
      messages.scrollTop += messages.scrollHeight - previousHeight;
      refreshIcons();
    } catch (error) { toast(error.message, 'error'); }
  });
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

function dormitoryActionMarkup(item, mine, currentDormitory, open) {
  if (mine) return `<button class="btn btn-danger" data-leave-dorm ${open ? '' : 'disabled'}>${icon('log-out')}退出宿舍</button>`;
  if (currentDormitory) return `<button class="btn btn-secondary" disabled>${icon('check')}已加入其他宿舍</button>`;
  if (item.status === 'FULL') return `<button class="btn btn-secondary" disabled>${icon('users')}已满员</button>`;
  return `<button class="btn btn-primary" data-apply-dorm="${item.id}" data-initiator-id="${item.initiator_id}" ${open ? '' : 'disabled'}>${icon('message-circle')}联系并申请</button>`;
}

function dormitoryMemberMarkup(member, isInitiator, open) {
  let removeAction = '';
  if (isInitiator && member.user_id !== state.user.id && open) {
    removeAction = `<button class="btn btn-danger btn-sm" data-remove-member="${member.user_id}">${icon('user-minus')}移除</button>`;
  }
  const role = member.role === 'INITIATOR' ? ' · 发起人' : '';
  return `<div class="dormitory-member">${avatar(member.avatar_url, member.name, 'avatar-sm')}<div><b>${escapeHtml(member.name)}${role}</b><span>${escapeHtml(member.grade)}</span></div>${removeAction}</div>`;
}

function dormitoryCardMarkup(item, currentDormitory, open) {
  const mine = item.id === currentDormitory?.id;
  const isInitiator = mine && item.current_user_role === 'INITIATOR';
  const action = dormitoryActionMarkup(item, mine, currentDormitory, open);
  const members = item.members.map((member) => dormitoryMemberMarkup(member, isInitiator, open)).join('');
  return `<article class="dormitory-card ${mine ? 'current' : ''}" data-dorm-id="${item.id}" data-dorm-status="${item.status}">
      <div class="dormitory-card-head"><div><span>${escapeHtml(item.dormitory_code)}</span><h2>${escapeHtml(item.name)}</h2></div><div class="dormitory-badges">${mine ? statusBadge('我的宿舍', 'open', 'home') : ''}${statusBadge(`${item.member_count}/4 人`, item.status.toLowerCase(), 'users')}</div></div>
      <p>${item.building && item.room_number ? `${escapeHtml(item.building)} ${escapeHtml(item.room_number)}` : '等待管理员分配房间'}</p>
      <div class="dormitory-owner">${icon('crown')}发起人：${escapeHtml(item.initiator_name)}</div>
      <div class="dormitory-members"><strong>已加入成员</strong>${members}</div>
      <div class="dormitory-card-action">${action}</div>
    </article>`;
}

function dormitoryListMarkup(dormitories, currentDormitory, open) {
  if (!dormitories.length) return emptyState('bed-double', '暂无宿舍', open ? '可以新建一个宿舍并成为发起人' : '当前阶段没有可展示的宿舍');
  return `<div class="dormitory-grid">${dormitories.map((item) => dormitoryCardMarkup(item, currentDormitory, open)).join('')}</div>`;
}

function bindDormitoryCardActions(root, currentDormitory) {
  root.querySelectorAll('[data-remove-member]').forEach((button) => button.addEventListener('click', async () => {
    try { await api(`/api/dormitories/${currentDormitory.id}/members/${button.dataset.removeMember}`, { method: 'DELETE', body: '{}' }); toast('成员已移除'); await renderDorm(); }
    catch (error) { toast(error.message, 'error'); }
  }));
  root.querySelector('[data-leave-dorm]')?.addEventListener('click', async () => {
    try { await api('/api/me/dormitory/leave', { method: 'POST', body: '{}' }); toast('已退出宿舍'); await renderDorm(); }
    catch (error) { toast(error.message, 'error'); }
  });
  root.querySelectorAll('[data-apply-dorm]').forEach((button) => button.addEventListener('click', async () => {
    try {
      const result = await api(`/api/users/${button.dataset.initiatorId}/conversations`, { method: 'POST', body: '{}' });
      state.selectedConversationId = result.conversation.id;
      state.applicationDormitoryId = Number(button.dataset.applyDorm);
      await navigate('messages');
    } catch (error) { toast(error.message, 'error'); }
  }));
}

function dormitoryStageLabel(open, status) {
  if (open) return '进行中';
  if (status === 'ARCHIVED') return '已归档';
  return '已截止';
}

function pendingReviewMarkup(dormitory) {
  if (dormitory?.current_user_role !== 'INITIATOR') return '';
  const applications = dormitory.pending_applications.map((application) => `<div class="member-row">${avatar(application.applicant_avatar, application.applicant_name, 'avatar-sm')}<div class="member-copy"><strong>${escapeHtml(application.applicant_name)}</strong><span>${escapeHtml(application.note || '未填写申请说明')}</span></div><button class="btn btn-secondary btn-sm" data-review-dorm="${application.id}" data-action="reject">拒绝</button><button class="btn btn-primary btn-sm" data-review-dorm="${application.id}" data-action="approve">通过</button></div>`).join('');
  const content = applications || '<p class="field-hint">暂无待审核申请</p>';
  return `<div class="panel dorm-applications"><div class="section-heading"><div><h2>待审核申请</h2><p>也可以直接在私信申请卡片中处理</p></div></div>${content}</div>`;
}

function ownApplicationsMarkup(dormitory, applications) {
  if (dormitory) return '';
  const pending = applications.filter((item) => item.status === 'PENDING');
  if (!pending.length) return '';
  const items = pending.map((item) => `<p class="field-hint">${escapeHtml(item.dormitory_name)} · ${formatDate(item.created_at)}</p>`).join('');
  return `<div class="panel"><strong>待审核申请</strong>${items}</div>`;
}

function dormitoryToolbarAction(dormitory, open) {
  if (dormitory) return '<span class="field-hint">你的宿舍已置顶展示</span>';
  return `<button class="btn btn-primary" id="create-dorm" ${open ? '' : 'disabled'}>${icon('plus')}新建宿舍并加入</button>`;
}

function bindDormitorySearch() {
  document.querySelector('#dormitory-search-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    state.dormitorySearch = new FormData(event.currentTarget).get('search').trim();
    renderDorm();
  });
}

function bindDormitoryReviews() {
  document.querySelectorAll('[data-review-dorm]').forEach((button) => button.addEventListener('click', async () => {
    try {
      await api(`/api/dormitory-applications/${button.dataset.reviewDorm}/${button.dataset.action}`, { method: 'POST', body: '{}' });
      toast(button.dataset.action === 'approve' ? '申请已通过' : '申请已拒绝');
      await renderDorm();
    } catch (error) { toast(error.message, 'error'); }
  }));
}

async function loadMoreDormitories(button, params, dormitories, total, currentDormitory, open) {
  button.disabled = true;
  button.innerHTML = `${icon('loader-circle')}加载中`;
  try {
    params.set('offset', String(dormitories.length));
    const nextPage = await api(`/api/dormitories?${params}`);
    dormitories.push(...nextPage.dormitories);
    const template = document.createElement('template');
    template.innerHTML = nextPage.dormitories.map((item) => dormitoryCardMarkup(item, currentDormitory, open)).join('');
    bindDormitoryCardActions(template.content, currentDormitory);
    document.querySelector('.dormitory-grid').append(template.content);
    refreshIcons();
    if (!nextPage.dormitories.length || dormitories.length >= nextPage.total) button.closest('.load-more').remove();
    else button.innerHTML = `${icon('chevrons-down')}查看更多`;
  } catch (error) {
    button.innerHTML = `${icon('chevrons-down')}查看更多`;
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
    refreshIcons();
  }
}

function bindDormitoryPagination(params, dormitories, total, currentDormitory, open) {
  document.querySelector('#load-more-dormitories')?.addEventListener('click', (event) => loadMoreDormitories(event.currentTarget, params, dormitories, total, currentDormitory, open));
}

async function renderDorm() {
  const params = new URLSearchParams({ limit: '15' });
  if (state.dormitorySearch) params.set('search', state.dormitorySearch);
  const [{ dormitory, applications, open, round }, firstPage] = await Promise.all([
    api('/api/me/dormitory'), api(`/api/dormitories?${params}`),
  ]);
  if (!round) {
    return setPage(emptyState('calendar-x', '当前没有可参与的选宿舍轮次', '管理员将你加入新的选宿舍轮次后，可在这里组建宿舍'));
  }
  const dormitories = firstPage.dormitories;
  const total = firstPage.total;
  const stageLabel = dormitoryStageLabel(open, round.status);
  const stageBanner = `<div class="stage-banner ${open ? 'open' : 'closed'}">${icon(open ? 'door-open' : 'lock-keyhole')}<div><strong>${escapeHtml(round.name)} · ${stageLabel}</strong><span>${open ? '可以创建宿舍、发送加入申请或退出当前宿舍' : '本轮已停止学生变更；历史结果可在“历史结果”中查看'}</span></div></div>`;
  const pendingReview = pendingReviewMarkup(dormitory);
  const ownApplications = ownApplicationsMarkup(dormitory, applications);
  const toolbarAction = dormitoryToolbarAction(dormitory, open);
  const loadMore = dormitories.length < total ? `<div class="load-more"><button class="btn btn-secondary" id="load-more-dormitories">${icon('chevrons-down')}查看更多</button></div>` : '';
  setPage(`${stageBanner}<div class="toolbar"><form class="search-field" id="dormitory-search-form">${icon('search')}<input name="search" value="${escapeHtml(state.dormitorySearch)}" placeholder="按宿舍成员姓名搜索"></form><div class="toolbar-spacer"></div>${toolbarAction}</div>${pendingReview}${ownApplications}${dormitoryListMarkup(dormitories, dormitory, open)}${loadMore}`);
  bindDormitorySearch();
  bindDormitoryReviews();
  document.querySelector('#create-dorm')?.addEventListener('click', showCreateDormitoryModal);
  bindDormitoryCardActions(document, dormitory);
  bindDormitoryPagination(params, dormitories, total, dormitory, open);
}

async function renderDormitoryHistory() {
  const { rounds } = await api('/api/dormitory-rounds');
  if (!rounds.length) return setPage(emptyState('history', '暂无历史轮次', '参与过的选宿舍轮次会保留在这里'));
  setPage(`<div class="round-history-list">${rounds.map((round) => `<section class="panel round-history-item"><div><strong>${escapeHtml(round.name)}</strong><p>${escapeHtml(round.code)} · ${round.status === 'OPEN' ? '进行中' : round.status === 'CLOSED' ? '已截止，待归档' : '已归档'}</p></div><button class="btn btn-secondary" data-view-round-result="${round.id}">${icon('eye')}查看结果</button></section>`).join('')}</div><div id="round-result"></div>`);
  document.querySelectorAll('[data-view-round-result]').forEach((button) => button.addEventListener('click', async () => {
    try {
      const { round, dormitories } = await api(`/api/dormitory-rounds/${button.dataset.viewRoundResult}/results`);
      const ownDormitory = dormitories[0] || null;
      const target = document.querySelector('#round-result');
      target.innerHTML = `<div class="section-heading history-result-heading"><div><h2>${escapeHtml(round.name)}的结果</h2><p>${round.status === 'ARCHIVED' ? '以下内容来自归档时生成的不可变快照' : '该轮次尚未归档，展示当前结果'}</p></div></div>${ownDormitory ? dormitoryListMarkup([ownDormitory], ownDormitory, false) : emptyState('bed-double', '本轮没有宿舍结果', '你在该轮次中没有加入宿舍')}`;
      refreshIcons();
    } catch (error) { toast(error.message, 'error'); }
  }));
  document.querySelector('[data-view-round-result]')?.click();
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
    <section class="panel"><div class="section-heading"><div><h2>身份信息</h2><p>如需更正，请联系管理员</p></div></div><div class="form-grid"><div class="form-field"><label>姓名</label><input value="${escapeHtml(state.user.name)}" disabled></div><div class="form-field"><label>年级</label><input value="${escapeHtml(state.user.grade)}" disabled></div><div class="form-field"><label>性别</label><input value="${state.user.gender === 'MALE' ? '男' : '女'}" disabled></div><div class="form-field"><label>专业</label><input value="${escapeHtml(state.user.major || '')}" disabled></div><div class="form-field full"><label>登录标识</label><input value="${escapeHtml(state.user.loginIdentifier)}" disabled></div></div></section>
    <section class="panel"><div class="section-heading"><div><h2>修改密码</h2><p>新密码至少 8 位</p></div></div><form id="password-form" class="form-grid"><div class="form-field"><label>当前密码</label><input name="currentPassword" type="password" required></div><div class="form-field"><label>新密码</label><input name="newPassword" type="password" minlength="8" required></div><div class="full"><button class="btn btn-primary">${icon('key-round')}更新密码</button></div></form></section>
    <section class="panel"><div class="section-heading"><div><h2>拉黑列表</h2><p>解除后可以重新查看对方卡片</p></div></div>${blocks.length ? `<div class="search-field inline-person-search">${icon('search')}<input id="block-search" placeholder="按姓名搜索"></div><div class="member-list">${blocks.map((item) => `<div class="member-row" data-person-name="${escapeHtml(item.name.toLowerCase())}">${avatar(item.avatar_url, item.name, 'avatar-sm')}<div class="member-copy"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.grade)}</span></div><button class="btn btn-secondary btn-sm" data-unblock="${item.user_id}">解除</button></div>`).join('')}</div>` : `<p class="field-hint">暂无拉黑用户</p>`}</section>
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
  document.querySelector('#block-search')?.addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll('.member-row[data-person-name]').forEach((item) => {
      item.hidden = query && !item.dataset.personName.includes(query);
    });
  });
}

async function loadAdminView(view) {
  if (view === 'overview') return renderAdminOverview();
  if (view === 'users') return renderAdminUsers();
  if (view === 'cards') return renderAdminCards();
  if (view === 'rounds') return renderAdminRounds();
  if (view === 'groups') return renderAdminGroups();
  if (view === 'reports') return renderAdminReports();
  if (view === 'audit') return renderAdminAudit();
  if (view === 'access') return renderAdminAccess();
  return navigate('overview');
}

async function renderAdminOverview() {
  const { counts } = await api('/api/admin/overview');
  setPage(`<div class="stats-grid"><div class="stat"><span>正式学生账号</span><strong>${counts.students}</strong></div><div class="stat"><span>正常账号</span><strong>${counts.activeStudents}</strong></div><div class="stat"><span>公开卡片</span><strong>${counts.publishedCards}</strong></div><div class="stat"><span>待处理举报</span><strong>${counts.pendingReports}</strong></div></div>
    <section class="panel"><div class="section-heading"><div><h2>${escapeHtml(counts.currentRound?.name || '当前没有选宿舍轮次')}</h2><p>${counts.currentRound ? `${escapeHtml(counts.currentRound.code)} · ${counts.currentRound.status === 'OPEN' ? '进行中' : counts.currentRound.status === 'CLOSED' ? '已截止' : '已归档'}` : '由超级管理员新建并开启轮次'}</p></div>${counts.currentRound ? statusBadge(counts.currentRound.status === 'OPEN' ? '进行中' : counts.currentRound.status === 'CLOSED' ? '已截止' : '已归档', counts.currentRound.status === 'OPEN' ? 'open' : 'closed', counts.currentRound.status === 'OPEN' ? 'door-open' : 'archive') : ''}</div><div class="detail-header"><div class="brand-mark" style="background:var(--accent)">${counts.dormitories}</div><div><strong>本轮有效宿舍</strong><p class="field-hint">当前结果包含 ${counts.dormitoryMembers} 名学生</p></div>${state.user.isSuperAdmin ? `<div class="detail-actions"><button class="btn btn-primary" id="manage-rounds">${icon('calendar-range')}管理轮次</button></div>` : ''}</div></section>`);
  document.querySelector('#manage-rounds')?.addEventListener('click', () => navigate('rounds'));
}

async function renderAdminUsers() {
  const [{ users }, { grades }] = await Promise.all([
    hasPermission('USER_READ') ? api('/api/admin/users') : Promise.resolve({ users: [] }),
    api('/api/admin/grades'),
  ]);
  state.adminGrades = grades;
  setPage(`<div class="toolbar"><div class="search-field">${icon('search')}<input id="admin-user-search" placeholder="按姓名搜索（也支持登录标识、年级或专业）"></div><div class="toolbar-spacer"></div>${state.user.isSuperAdmin ? `<button class="btn btn-secondary" id="manage-selection-groups">${icon('users-round')}预设学生群组</button>` : ''}${hasPermission('USER_LOGIN_IDENTIFIER_UPDATE') ? `<button class="btn btn-secondary" id="update-login-identifiers">${icon('replace')}批量换登录标识</button>` : ''}${hasPermission('USER_EXPORT') ? `<button class="btn btn-secondary" id="export-users">${icon('file-spreadsheet')}导出用户 Excel</button>` : ''}${hasPermission('USER_IMPORT') ? `<button class="btn btn-primary" id="import-users">${icon('upload')}导入账号</button>` : ''}</div>
    <div class="table-wrap"><table class="data-table"><thead><tr><th>学生</th><th>性别</th><th>专业</th><th>登录标识</th><th>状态</th><th>卡片</th><th>最近登录</th><th></th></tr></thead><tbody id="user-rows">${users.map(userRow).join('')}</tbody></table></div>`);
  bindAdminUserRows(users);
  document.querySelector('#admin-user-search').addEventListener('input', (event) => {
    const query = event.target.value.toLowerCase();
    document.querySelector('#user-rows').innerHTML = users.filter((item) => [item.name, item.grade, item.major, item.login_identifier].join(' ').toLowerCase().includes(query)).map(userRow).join('');
    bindAdminUserRows(users);
    refreshIcons();
  });
  document.querySelector('#import-users')?.addEventListener('click', showImportModal);
  document.querySelector('#update-login-identifiers')?.addEventListener('click', showLoginIdentifierBatchModal);
  document.querySelector('#export-users')?.addEventListener('click', downloadUserExport);
  document.querySelector('#manage-selection-groups')?.addEventListener('click', openSelectionGroupManager);
}

async function downloadUserExport() {
  try {
    const response = await fetch('/api/admin/users/export', { credentials: 'same-origin' });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error?.message || '导出失败，请稍后重试');
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || 'users.xlsx';
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
    toast('用户信息已导出');
  } catch (error) { toast(error.message, 'error'); }
}

function userRow(user) {
  const type = user.status === 'ACTIVE' ? 'active' : user.status.toLowerCase();
  const protectedAccount = !state.user.isSuperAdmin && (user.id === state.user.id || user.is_group_admin || user.account_type === 'SUPER_ADMIN');
  return `<tr><td><strong>${escapeHtml(user.name)}</strong><div class="field-hint">${escapeHtml(user.grade)}${user.account_type === 'SUPER_ADMIN' ? ' · 超级管理员' : user.is_group_admin ? ' · 组管理员' : ''}</div></td><td>${user.gender === 'MALE' ? '男' : user.gender === 'FEMALE' ? '女' : '-'}</td><td>${escapeHtml(user.major || '-')}</td><td>${escapeHtml(user.login_identifier)}</td><td>${statusBadge(labels.userStatus[user.status], type)}</td><td>${user.card_status ? statusBadge(labels.cardStatus[user.card_status], user.card_status === 'PUBLISHED' ? 'published' : user.card_status.toLowerCase()) : '-'}</td><td>${formatDate(user.last_login_at)}</td><td><div class="cell-actions">${!protectedAccount && user.account_type === 'USER' && hasScopedPermission('USER_IDENTITY_UPDATE', user.grade_id) ? `<button class="btn btn-secondary btn-sm" data-edit-user="${user.id}">${icon('pencil')}身份</button>` : ''}${!protectedAccount && hasScopedPermission('USER_STATUS_UPDATE', user.grade_id) ? `<button class="btn btn-secondary btn-sm" data-status-user="${user.id}">${icon('shield')}状态</button>` : ''}${!protectedAccount && user.id !== state.user.id && hasScopedPermission('USER_PASSWORD_RESET', user.grade_id) ? `<button class="btn btn-secondary icon-btn btn-sm" data-reset-password="${user.id}" title="重置密码" aria-label="重置${escapeHtml(user.name)}的密码">${icon('key-round')}</button>` : ''}${state.user.isSuperAdmin && user.id !== state.user.id ? `<button class="btn btn-secondary btn-sm" data-account-type-user="${user.id}">${icon(user.account_type === 'USER' ? 'badge-check' : 'user-round')}${user.account_type === 'USER' ? '设为超管' : '降为普通用户'}</button><button class="btn btn-quiet icon-btn btn-sm" data-delete-user="${user.id}" title="永久删除">${icon('trash-2')}</button>` : ''}</div></td></tr>`;
}

function bindAdminUserRows(users) {
  document.querySelectorAll('[data-edit-user]').forEach((button) => button.addEventListener('click', () => showEditIdentity(users.find((item) => item.id === Number(button.dataset.editUser)))));
  document.querySelectorAll('[data-status-user]').forEach((button) => button.addEventListener('click', () => showStatusModal(users.find((item) => item.id === Number(button.dataset.statusUser)))));
  document.querySelectorAll('[data-reset-password]').forEach((button) => button.addEventListener('click', () => showPasswordResetModal(users.find((item) => item.id === Number(button.dataset.resetPassword)))));
  document.querySelectorAll('[data-delete-user]').forEach((button) => button.addEventListener('click', () => showDeleteUser(users.find((item) => item.id === Number(button.dataset.deleteUser)))));
  document.querySelectorAll('[data-account-type-user]').forEach((button) => button.addEventListener('click', () => showAccountTypeModal(users.find((item) => item.id === Number(button.dataset.accountTypeUser)))));
}

function showPasswordResetModal(user) {
  const modal = openModal('重置账号密码', `<p>将 ${escapeHtml(user.name)} 的临时密码重置为当前登录标识：</p><p><code>${escapeHtml(user.login_identifier)}</code></p><p class="field-hint">该账号的现有会话将全部退出，下次登录后必须立即修改密码。</p><div class="form-field"><label>操作原因</label><textarea id="password-reset-reason" maxlength="200" required></textarea></div><div class="modal-actions"><button class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-danger" data-confirm>${icon('key-round')}确认重置</button></div>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('[data-confirm]').addEventListener('click', async () => {
    try {
      await api(`/api/admin/users/${user.id}/password-reset`, { method: 'POST', body: JSON.stringify({ reason: modal.querySelector('#password-reset-reason').value }) });
      closeModal(); toast('密码已重置，账号需要重新登录并修改密码'); await renderAdminUsers();
    } catch (error) { toast(error.message, 'error'); }
  });
}

function showAccountTypeModal(user) {
  const promote = user.account_type === 'USER';
  const accountType = promote ? 'SUPER_ADMIN' : 'USER';
  const modal = openModal(promote ? '设为超级管理员' : '降为普通用户', `<p>${promote ? '超级管理员拥有不受年级范围限制的全部管理权限，且只使用管理工作台。' : '降级后账号恢复学生端，并只保留之后通过管理员组获得的管理权限。'}</p><div class="form-field"><label>操作原因</label><textarea id="account-type-reason" required></textarea></div><div class="modal-actions"><button class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-danger" data-confirm>确认${promote ? '设为超级管理员' : '降为普通用户'}</button></div>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('[data-confirm]').addEventListener('click', async () => {
    try {
      await api(`/api/admin/users/${user.id}/account-type`, { method: 'PATCH', body: JSON.stringify({ accountType, reason: modal.querySelector('#account-type-reason').value }) });
      closeModal(); toast(promote ? '账号已设为超级管理员' : '账号已降为普通用户'); await renderAdminUsers();
    } catch (error) { toast(error.message, 'error'); }
  });
}

function showImportModal() {
  const importGradeIds = permissionGradeIds('USER_IMPORT');
  const importGrades = (state.adminGrades || []).filter((grade) => importGradeIds === null || importGradeIds.includes(grade.id));
  const modal = openModal('导入正式账号', `<form id="import-form"><div class="form-field"><label>账号数据</label><textarea name="rows" rows="8" placeholder="每行填写：登录标识,姓名,年级,性别,专业&#10;例如：2026013,张同学,2026级,女,计算机科学与技术" required></textarea><span class="field-hint">性别填写“男”或“女”。可用年级：${escapeHtml(importGrades.map((grade) => grade.name).join('、') || '无')}。初始密码与登录标识相同，首次登录后必须修改。姓名、年级、性别和专业导入后仅管理员可修改。</span></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary" type="submit">${icon('upload')}开始导入</button></div></form>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('#import-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const accounts = event.currentTarget.rows.value.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
      const [loginIdentifier, name, grade, genderText, major] = line.split(/[,，\t]/).map((part) => part.trim());
      const gender = genderText === '男' ? 'MALE' : genderText === '女' ? 'FEMALE' : genderText;
      return { loginIdentifier, name, grade, gender, major };
    });
    try {
      const result = await api('/api/admin/users/import', { method: 'POST', body: JSON.stringify({ accounts }) });
      modal.querySelector('.modal-body').innerHTML = `<div class="section-heading"><div><h2>导入完成</h2><p>成功 ${result.created.length} 条，失败 ${result.failed.length} 条</p></div></div>${result.created.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>登录标识</th><th>姓名</th><th>年级</th><th>性别</th><th>专业</th><th>初始密码</th></tr></thead><tbody>${result.created.map((item) => `<tr><td>${escapeHtml(item.loginIdentifier)}</td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.grade)}</td><td>${item.gender === 'MALE' ? '男' : '女'}</td><td>${escapeHtml(item.major)}</td><td><code>${escapeHtml(item.initialPassword)}</code></td></tr>`).join('')}</tbody></table></div>` : ''}${result.failed.length ? `<div class="panel" style="margin-top:12px"><strong>失败明细</strong>${result.failed.map((item) => `<p class="field-hint">第 ${item.row} 行：${escapeHtml(item.reason)}</p>`).join('')}</div>` : ''}<div class="modal-actions"><button class="btn btn-primary" data-done>完成</button></div>`;
      modal.querySelector('[data-done]').addEventListener('click', async () => { closeModal(); await renderAdminUsers(); });
    } catch (error) { toast(error.message, 'error'); }
  });
}

function showLoginIdentifierBatchModal() {
  const modal = openModal('批量换登录标识', `<form id="login-identifier-batch-form"><div class="form-field"><label>换号数据</label><textarea name="rows" rows="8" placeholder="每行填写：原登录标识,新登录标识&#10;例如：TEMP001,202601001" required></textarea><span class="field-hint">整批校验并更新；任何一行冲突时均不会修改。用户需要使用新登录标识重新登录。</span></div><div class="form-field"><label>操作原因</label><input name="reason" maxlength="200" required></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary" type="submit">${icon('replace')}确认批量修改</button></div></form>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('#login-identifier-batch-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const changes = event.currentTarget.rows.value.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
      const [oldLoginIdentifier, newLoginIdentifier] = line.split(/[,，\t]/).map((part) => part.trim());
      return { oldLoginIdentifier, newLoginIdentifier };
    });
    try {
      const result = await api('/api/admin/users/login-identifiers', { method: 'PATCH', body: JSON.stringify({ changes, reason: event.currentTarget.reason.value }) });
      closeModal();
      toast(`已修改 ${result.updated.length} 个登录标识`);
      await renderAdminUsers();
    } catch (error) { toast(error.message, 'error'); }
  });
}

function showEditIdentity(user) {
  const editableGradeIds = permissionGradeIds('USER_IDENTITY_UPDATE', user.grade_id);
  const gradeOptions = (state.adminGrades || []).filter((grade) => editableGradeIds === null || editableGradeIds.includes(grade.id)).map((grade) => `<option value="${escapeHtml(grade.name)}" ${grade.id === user.grade_id ? 'selected' : ''}>${escapeHtml(grade.name)}</option>`).join('');
  const modal = openModal('修改身份字段', `<form id="identity-form" class="form-grid"><div class="form-field"><label>姓名</label><input name="name" value="${escapeHtml(user.name)}" required></div><div class="form-field"><label>年级</label><select name="grade" required>${gradeOptions}</select></div><div class="form-field"><label>性别</label><select name="gender" required><option value="FEMALE" ${user.gender === 'FEMALE' ? 'selected' : ''}>女</option><option value="MALE" ${user.gender === 'MALE' ? 'selected' : ''}>男</option></select></div><div class="form-field"><label>专业</label><input name="major" value="${escapeHtml(user.major || '')}" required></div><div class="form-field full"><label>修改原因</label><input name="reason" required></div><div class="form-actions"><button class="btn btn-secondary" type="button" data-cancel>取消</button><button class="btn btn-primary">${icon('save')}保存</button></div></form>`);
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
  setPage(`<div class="toolbar"><div class="search-field">${icon('search')}<input id="admin-card-search" placeholder="按姓名搜索"></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>学生</th><th>地区</th><th>起床 / 睡觉</th><th>本人整理习惯</th><th>状态</th><th>更新时间</th><th></th></tr></thead><tbody>${cards.map((card) => `<tr data-person-name="${escapeHtml(card.name.toLowerCase())}"><td><div class="cell-user">${avatar(card.avatar_url, card.name, 'avatar-sm')}<div><strong>${escapeHtml(card.name)}</strong><div class="field-hint">${escapeHtml(card.grade)} · ${escapeHtml(card.major || '-')}</div></div></div></td><td>${escapeHtml([card.origin_province, card.origin_city].filter(Boolean).join(' ') || '-')}</td><td>${escapeHtml(card.wake_up_time || '-')} / ${escapeHtml(card.sleep_time || '-')}</td><td>${escapeHtml(labels.cleanliness[card.personal_cleanliness] || '-')}</td><td>${statusBadge(labels.cardStatus[card.status], card.status === 'PUBLISHED' ? 'published' : card.status.toLowerCase())}</td><td>${formatDate(card.updated_at)}</td><td><div class="cell-actions"><button class="btn btn-secondary btn-sm" data-view-card="${card.id}">${icon('eye')}查看</button>${hasScopedPermission('CARD_MODERATE', card.grade_id) ? (card.status === 'HIDDEN' ? `<button class="btn btn-secondary btn-sm" data-card-action="restore" data-id="${card.id}">${icon('rotate-ccw')}恢复</button>` : `<button class="btn btn-danger btn-sm" data-card-action="hide" data-id="${card.id}">${icon('eye-off')}隐藏</button>`) : ''}</div></td></tr>`).join('')}</tbody></table></div>`);
  document.querySelector('#admin-card-search').addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll('tr[data-person-name]').forEach((row) => { row.hidden = query && !row.dataset.personName.includes(query); });
  });
  document.querySelectorAll('[data-view-card]').forEach((button) => button.addEventListener('click', () => showAdminCardDetail(cards.find((card) => card.id === Number(button.dataset.viewCard)))));
  document.querySelectorAll('[data-card-action]').forEach((button) => button.addEventListener('click', () => showCardAction(Number(button.dataset.id), button.dataset.cardAction)));
}

function showAdminCardDetail(card) {
  openModal(`${card.name}的室友卡片`, cardDetailMarkup(card), { wide: true });
}

function showCardAction(cardId, action) {
  const modal = openModal(action === 'hide' ? '隐藏室友卡片' : '恢复室友卡片', `<div class="form-field"><label>操作原因</label><textarea id="card-action-reason" ${action === 'hide' ? 'required' : ''}></textarea></div><div class="modal-actions"><button class="btn btn-secondary" data-cancel>取消</button><button class="btn ${action === 'hide' ? 'btn-danger' : 'btn-primary'}" data-confirm>确认</button></div>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('[data-confirm]').addEventListener('click', async () => {
    try { await api(`/api/admin/roommate-cards/${cardId}/${action}`, { method: 'POST', body: JSON.stringify({ reason: modal.querySelector('#card-action-reason').value }) }); closeModal(); toast(action === 'hide' ? '卡片已隐藏' : '卡片已恢复'); await renderAdminCards(); }
    catch (error) { toast(error.message, 'error'); }
  });
}

async function renderAdminRounds() {
  const [{ rounds }, { users }, { groups }] = await Promise.all([
    api('/api/admin/dormitory-rounds'), api('/api/admin/users'), api('/api/admin/student-selection-groups'),
  ]);
  state.roundParticipantCandidates = users.filter((user) => user.account_type === 'USER' && ['ACTIVE', 'PENDING_ACTIVATION'].includes(user.status));
  state.selectionGroups = groups;
  const statusText = { DRAFT: '草稿', OPEN: '进行中', CLOSED: '已截止', ARCHIVED: '已归档' };
  setPage(`<div class="toolbar"><div><strong>选宿舍轮次</strong><div class="field-hint">同一时间只开放一轮，归档后生成不可变结果快照</div></div><div class="toolbar-spacer"></div><button class="btn btn-secondary" id="manage-selection-groups">${icon('users-round')}预设学生群组</button><button class="btn btn-primary" id="create-round">${icon('plus')}新建轮次</button></div>${rounds.length ? `<div class="round-admin-grid">${rounds.map((round) => `<section class="panel round-admin-card"><div class="section-heading"><div><h2>${escapeHtml(round.name)}</h2><p><code>${escapeHtml(round.code)}</code> · ${escapeHtml(round.description || '暂无说明')}</p></div>${statusBadge(statusText[round.status], round.status === 'OPEN' ? 'open' : round.status === 'DRAFT' ? 'pending' : 'closed')}</div><div class="round-metrics"><span>参与学生 <strong>${round.participant_count}</strong></span><span>宿舍 <strong>${round.dormitory_count}</strong></span><span>归档结果 <strong>${round.result_count}</strong></span></div><div class="cell-actions">${round.status === 'DRAFT' ? `<button class="btn btn-secondary" data-edit-round="${round.id}">${icon('pencil')}配置</button><button class="btn btn-primary" data-round-action="open" data-id="${round.id}">${icon('door-open')}开放</button>` : round.status === 'OPEN' ? `<button class="btn btn-danger" data-round-action="close" data-id="${round.id}">${icon('lock-keyhole')}截止</button>` : round.status === 'CLOSED' ? `<button class="btn btn-primary" data-round-action="archive" data-id="${round.id}">${icon('archive')}生成快照并归档</button>` : `<span class="field-hint">结果已锁定</span>`}</div></section>`).join('')}</div>` : emptyState('calendar-range', '暂无选宿舍轮次', '创建轮次并配置参与学生后即可开放')}`);
  document.querySelector('#create-round').addEventListener('click', () => showDormitoryRoundForm());
  document.querySelector('#manage-selection-groups').addEventListener('click', showSelectionGroups);
  document.querySelectorAll('[data-edit-round]').forEach((button) => button.addEventListener('click', () => showDormitoryRoundForm(rounds.find((round) => round.id === Number(button.dataset.editRound)))));
  document.querySelectorAll('[data-round-action]').forEach((button) => button.addEventListener('click', () => showDormitoryRoundAction(rounds.find((round) => round.id === Number(button.dataset.id)), button.dataset.roundAction)));
}

function showDormitoryRoundForm(round = null) {
  const participants = new Set(round?.participantIds || []);
  const modal = openModal(round ? '配置选宿舍轮次' : '新建选宿舍轮次', `<form id="round-form"><div class="form-grid"><div class="form-field"><label>轮次编码</label><input name="code" maxlength="40" value="${escapeHtml(round?.code || '')}" placeholder="例如 2026_SECOND" ${round ? 'disabled' : 'required'}></div><div class="form-field"><label>轮次名称</label><input name="name" maxlength="80" value="${escapeHtml(round?.name || '')}" required></div><div class="form-field"><label>计划开始时间</label><input name="startsAt" type="datetime-local" value="${escapeHtml(round?.starts_at?.slice(0, 16) || '')}"></div><div class="form-field"><label>计划截止时间</label><input name="endsAt" type="datetime-local" value="${escapeHtml(round?.ends_at?.slice(0, 16) || '')}"></div><div class="form-field full"><label>说明</label><textarea name="description" maxlength="500">${escapeHtml(round?.description || '')}</textarea></div><div class="form-field full"><label>操作原因</label><input name="reason" maxlength="200" ${round ? 'required' : ''}></div></div><div class="section"><div class="section-heading"><div><h2>参与学生</h2><p>只有名单内学生可以在本轮创建或加入宿舍</p></div></div>${personPickerTools('round')}<div class="candidate-grid" data-person-picker="round">${state.roundParticipantCandidates.map((user) => `<div class="candidate" data-person-name="${escapeHtml(user.name.toLowerCase())}"><input type="checkbox" name="participantIds" value="${user.id}" id="round-user-${user.id}" ${participants.has(user.id) ? 'checked' : ''}><label for="round-user-${user.id}">${icon('user-round')}<span>${escapeHtml(user.name)}<small>${escapeHtml(user.grade)} · ${escapeHtml(user.login_identifier)}</small></span></label></div>`).join('')}</div></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary">${icon('save')}${round ? '保存配置' : '创建草稿'}</button></div></form>`, { wide: true });
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  bindPersonPicker(modal, 'round');
  modal.querySelector('#round-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = {
      code: form.code?.value,
      name: form.name.value,
      description: form.description.value,
      startsAt: form.startsAt.value,
      endsAt: form.endsAt.value,
      reason: form.reason.value,
      participantIds: [...form.querySelectorAll('[name="participantIds"]:checked')].map((input) => Number(input.value)),
    };
    try {
      await api(round ? `/api/admin/dormitory-rounds/${round.id}` : '/api/admin/dormitory-rounds', { method: round ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      closeModal(); toast(round ? '轮次配置已更新' : '轮次草稿已创建'); await renderAdminRounds();
    } catch (error) { toast(error.message, 'error'); }
  });
}

async function openSelectionGroupManager() {
  try {
    const [{ users }, { groups }] = await Promise.all([api('/api/admin/users'), api('/api/admin/student-selection-groups')]);
    state.selectionGroupCandidates = users.filter((user) => user.account_type === 'USER' && ['ACTIVE', 'PENDING_ACTIVATION'].includes(user.status));
    state.selectionGroups = groups;
    showSelectionGroups();
  } catch (error) { toast(error.message, 'error'); }
}

function showSelectionGroups() {
  const groups = state.selectionGroups;
  const modal = openModal('预设学生群组', `<div class="toolbar"><div class="search-field">${icon('search')}<input id="selection-group-search" placeholder="按成员姓名搜索"></div><div class="toolbar-spacer"></div><button class="btn btn-primary" id="create-selection-group">${icon('plus')}新建群组</button></div><div class="selection-group-list">${groups.length ? groups.map((group) => `<section class="selection-group-item" data-selection-group-card="${group.id}"><div><strong>${escapeHtml(group.name)}</strong><p>${escapeHtml(group.description || '暂无说明')}</p><span>${group.members.map((member) => escapeHtml(member.name)).join('、')}</span></div><div class="cell-actions"><button class="btn btn-secondary btn-sm" data-edit-selection-group="${group.id}">${icon('pencil')}编辑</button><button class="btn btn-danger btn-sm" data-delete-selection-group="${group.id}">${icon('trash-2')}删除</button></div></section>`).join('') : emptyState('users-round', '暂无预设群组', '新建群组后，可在选人界面一键添加成员')}</div>`, { wide: true });
  modal.querySelector('#selection-group-search').addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    modal.querySelectorAll('[data-selection-group-card]').forEach((card) => {
      const group = groups.find((item) => item.id === Number(card.dataset.selectionGroupCard));
      card.hidden = query && !group.members.some((member) => member.name.toLowerCase().includes(query));
    });
  });
  modal.querySelector('#create-selection-group').addEventListener('click', () => showSelectionGroupForm());
  modal.querySelectorAll('[data-edit-selection-group]').forEach((button) => button.addEventListener('click', () => showSelectionGroupForm(groups.find((group) => group.id === Number(button.dataset.editSelectionGroup)))));
  modal.querySelectorAll('[data-delete-selection-group]').forEach((button) => button.addEventListener('click', () => showDeleteSelectionGroup(groups.find((group) => group.id === Number(button.dataset.deleteSelectionGroup)))));
}

function showSelectionGroupForm(group = null) {
  const candidates = state.selectionGroupCandidates || state.roundParticipantCandidates || [];
  const memberIds = new Set(group?.members.map((member) => member.id) || []);
  const modal = openModal(group ? '编辑预设学生群组' : '新建预设学生群组', `<form id="selection-group-form"><div class="form-grid"><div class="form-field"><label>群组名称</label><input name="name" maxlength="80" value="${escapeHtml(group?.name || '')}" required></div><div class="form-field"><label>操作原因</label><input name="reason" maxlength="200" ${group ? 'required' : ''}></div><div class="form-field full"><label>说明</label><textarea name="description" maxlength="500">${escapeHtml(group?.description || '')}</textarea></div></div><div class="section"><div class="section-heading"><div><h2>群组成员</h2><p>群组只保存学生名单，不会随使用它创建的轮次自动变化</p></div></div><div class="person-picker-tools"><div class="search-field">${icon('search')}<input id="selection-group-member-search" placeholder="按姓名搜索"></div></div><div class="candidate-grid" id="selection-group-candidates">${candidates.map((user) => `<div class="candidate" data-person-name="${escapeHtml(user.name.toLowerCase())}"><input type="checkbox" name="memberIds" value="${user.id}" id="selection-user-${user.id}" ${memberIds.has(user.id) ? 'checked' : ''}><label for="selection-user-${user.id}">${icon('user-round')}<span>${escapeHtml(user.name)}<small>${escapeHtml(user.grade)} · ${escapeHtml(user.login_identifier)}</small></span></label></div>`).join('')}</div></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>返回</button><button class="btn btn-primary">${icon('save')}${group ? '保存群组' : '创建群组'}</button></div></form>`, { wide: true });
  modal.querySelector('[data-cancel]').addEventListener('click', showSelectionGroups);
  modal.querySelector('#selection-group-member-search').addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    modal.querySelectorAll('#selection-group-candidates [data-person-name]').forEach((candidate) => {
      candidate.hidden = query && !candidate.dataset.personName.includes(query);
    });
  });
  modal.querySelector('#selection-group-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = {
      name: form.name.value,
      description: form.description.value,
      reason: form.reason.value,
      memberIds: [...form.querySelectorAll('[name="memberIds"]:checked')].map((input) => Number(input.value)),
    };
    try {
      await api(group ? `/api/admin/student-selection-groups/${group.id}` : '/api/admin/student-selection-groups', { method: group ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      const result = await api('/api/admin/student-selection-groups');
      state.selectionGroups = result.groups;
      toast(group ? '预设群组已更新' : '预设群组已创建');
      showSelectionGroups();
    } catch (error) { toast(error.message, 'error'); }
  });
}

function showDeleteSelectionGroup(group) {
  const modal = openModal('删除预设学生群组', `<p>删除“${escapeHtml(group.name)}”不会改变已经保存的轮次或管理员组成员。</p><div class="form-field"><label>操作原因</label><textarea id="delete-selection-group-reason" required></textarea></div><div class="modal-actions"><button class="btn btn-secondary" data-cancel>返回</button><button class="btn btn-danger" data-confirm>${icon('trash-2')}确认删除</button></div>`);
  modal.querySelector('[data-cancel]').addEventListener('click', showSelectionGroups);
  modal.querySelector('[data-confirm]').addEventListener('click', async () => {
    try {
      await api(`/api/admin/student-selection-groups/${group.id}`, { method: 'DELETE', body: JSON.stringify({ reason: modal.querySelector('#delete-selection-group-reason').value }) });
      state.selectionGroups = state.selectionGroups.filter((item) => item.id !== group.id);
      toast('预设群组已删除');
      showSelectionGroups();
    } catch (error) { toast(error.message, 'error'); }
  });
}

function showDormitoryRoundAction(round, action) {
  const labels = {
    open: ['开放轮次', '开放后，参与学生可以开始创建宿舍和发送申请。', '确认开放'],
    close: ['截止轮次', '截止后学生不能再变更宿舍，管理员仍可检查和修正宿舍位置。', '确认截止'],
    archive: ['归档轮次', '系统将生成不可变结果快照。归档后不能再修改本轮宿舍。', '生成快照并归档'],
  }[action];
  const modal = openModal(labels[0], `<p>${escapeHtml(round.name)}：${labels[1]}</p><div class="form-field"><label>操作原因</label><textarea id="round-action-reason" required></textarea></div><div class="modal-actions"><button class="btn btn-secondary" data-cancel>取消</button><button class="btn ${action === 'close' ? 'btn-danger' : 'btn-primary'}" data-confirm>${labels[2]}</button></div>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('[data-confirm]').addEventListener('click', async () => {
    try {
      await api(`/api/admin/dormitory-rounds/${round.id}/${action}`, { method: 'POST', body: JSON.stringify({ reason: modal.querySelector('#round-action-reason').value }) });
      closeModal(); toast(labels[0] + '成功'); await renderAdminRounds();
    } catch (error) { toast(error.message, 'error'); }
  });
}

async function renderAdminGroups(selectedRoundId = state.adminRoundId) {
  const { rounds } = await api('/api/admin/dormitory-rounds');
  const availableRounds = rounds.filter((round) => round.status !== 'DRAFT');
  const roundId = selectedRoundId && availableRounds.some((round) => round.id === Number(selectedRoundId)) ? Number(selectedRoundId) : availableRounds[0]?.id;
  state.adminRoundId = roundId;
  if (!roundId) return setPage(emptyState('calendar-range', '暂无可查看轮次', '超级管理员创建并开放选宿舍轮次后将在这里显示'));
  const { dormitories, open, round } = await api(`/api/admin/dormitories?roundId=${roundId}`);
  const statusText = { OPEN: '进行中', CLOSED: '已截止', ARCHIVED: '已归档' };
  const readOnly = round.status === 'ARCHIVED';
  setPage(`<div class="toolbar"><div class="form-field toolbar-select"><label for="admin-round-select">查看轮次</label><select id="admin-round-select">${availableRounds.map((item) => `<option value="${item.id}" ${item.id === round.id ? 'selected' : ''}>${escapeHtml(item.name)}（${statusText[item.status]}）</option>`).join('')}</select></div><div class="search-field">${icon('search')}<input id="admin-dormitory-person-search" placeholder="按成员姓名搜索"></div><div class="toolbar-spacer"></div>${hasPermission('DORMITORY_EXPORT') ? `<button class="btn btn-primary" id="export-dormitories">${icon('file-spreadsheet')}导出本轮 Excel</button>` : ''}</div><div class="stage-banner ${open ? 'open' : 'closed'}">${icon(open ? 'door-open' : readOnly ? 'archive' : 'lock-keyhole')}<div><strong>${escapeHtml(round.name)} · ${statusText[round.status]}</strong><span>${open ? '学生可以创建、申请、审核和退出宿舍' : readOnly ? '当前展示归档时生成的不可变结果快照' : '学生变更已停止，管理员仍可检查并分配房间'}</span></div></div>${dormitories.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>宿舍</th><th>发起人</th><th>成员</th><th>状态</th><th>创建时间</th><th></th></tr></thead><tbody>${dormitories.map((dormitory) => `<tr data-person-names="${escapeHtml(dormitory.members.map((member) => member.name.toLowerCase()).join('|'))}"><td><strong>${escapeHtml(dormitory.name)}</strong><div class="field-hint">${escapeHtml(dormitory.dormitory_code)} · ${dormitory.building && dormitory.room_number ? `${escapeHtml(dormitory.building)} ${escapeHtml(dormitory.room_number)}` : '待分配房间'}</div></td><td>${escapeHtml(dormitory.initiator_name)}</td><td>${dormitory.members.map((member) => escapeHtml(member.name)).join('、')}<div class="field-hint">${dormitory.member_count}/4 人</div></td><td>${statusBadge(labels.dormitoryStatus[dormitory.status], dormitory.status.toLowerCase())}</td><td>${formatDate(dormitory.created_at || dormitory.generated_at)}</td><td><div class="cell-actions">${!readOnly && hasScopedPermission('DORMITORY_LOCATION_ASSIGN', dormitory.management_grade_id) ? `<button class="btn btn-secondary btn-sm" data-assign-dorm="${dormitory.id}">${icon('map-pin')}分配房间</button>` : ''}${!readOnly && hasScopedPermission('DORMITORY_CLOSE', dormitory.management_grade_id) && dormitory.status !== 'CLOSED' ? `<button class="btn btn-danger btn-sm" data-close-dorm="${dormitory.id}">${icon('lock-keyhole')}关闭宿舍</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div>` : emptyState('bed-double', '本轮暂无宿舍', '本轮学生尚未创建宿舍')}`);
  document.querySelector('#admin-round-select').addEventListener('change', (event) => renderAdminGroups(event.target.value));
  document.querySelector('#admin-dormitory-person-search').addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll('tr[data-person-names]').forEach((row) => { row.hidden = query && !row.dataset.personNames.includes(query); });
  });
  document.querySelector('#export-dormitories')?.addEventListener('click', downloadDormitoryExport);
  document.querySelectorAll('[data-assign-dorm]').forEach((button) => button.addEventListener('click', () => showAssignDormitory(dormitories.find((item) => item.id === Number(button.dataset.assignDorm)))));
  document.querySelectorAll('[data-close-dorm]').forEach((button) => button.addEventListener('click', () => showCloseDormitory(Number(button.dataset.closeDorm))));
}

async function downloadDormitoryExport(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch(`/api/admin/dormitories/export?roundId=${state.adminRoundId}`, { credentials: 'same-origin' });
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
    try { await api(`/api/admin/dormitories/${dormitory.id}/location`, { method: 'PATCH', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); closeModal(); toast('宿舍房间已分配'); await renderAdminGroups(state.adminRoundId); }
    catch (error) { toast(error.message, 'error'); }
  });
}

function showCloseDormitory(dormitoryId) {
  const modal = openModal('关闭宿舍', `<p>关闭后宿舍不再接受申请，已有成员关系保留。</p><div class="form-field"><label>关闭原因</label><textarea id="close-dorm-reason" required></textarea></div><div class="modal-actions"><button class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-danger" data-confirm>${icon('lock-keyhole')}确认关闭</button></div>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('[data-confirm]').addEventListener('click', async () => {
    try { await api(`/api/admin/dormitories/${dormitoryId}/close`, { method: 'POST', body: JSON.stringify({ reason: modal.querySelector('#close-dorm-reason').value }) }); closeModal(); toast('宿舍已关闭'); await renderAdminGroups(state.adminRoundId); }
    catch (error) { toast(error.message, 'error'); }
  });
}

async function renderAdminReports() {
  const { reports } = await api('/api/admin/reports');
  setPage(reports.length ? `<div class="toolbar"><div class="search-field">${icon('search')}<input id="report-person-search" placeholder="按举报人姓名搜索"></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>举报人</th><th>对象</th><th>原因</th><th>提交时间</th><th>状态</th><th></th></tr></thead><tbody>${reports.map((report) => `<tr data-person-name="${escapeHtml(report.reporter_name.toLowerCase())}"><td>${escapeHtml(report.reporter_name)}</td><td>${report.target_type === 'ROOMMATE_CARD' ? '室友卡片' : '私信消息'} #${report.target_id}</td><td><strong>${escapeHtml(report.reason)}</strong><div class="field-hint">${escapeHtml(report.description)}</div></td><td>${formatDate(report.created_at)}</td><td>${statusBadge(labels.reportStatus[report.status], report.status.toLowerCase())}</td><td>${hasScopedPermission('REPORT_RESOLVE', report.target_grade_id) && report.status === 'PENDING' ? `<button class="btn btn-primary btn-sm" data-resolve="${report.id}">${icon('check')}处理</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : emptyState('shield-check', '没有待处理举报', '当前没有用户提交的举报记录'));
  document.querySelector('#report-person-search')?.addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll('tr[data-person-name]').forEach((row) => { row.hidden = query && !row.dataset.personName.includes(query); });
  });
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
  setPage(logs.length ? `<div class="toolbar"><div class="search-field">${icon('search')}<input id="audit-person-search" placeholder="按管理员姓名搜索"></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>管理员</th><th>操作</th><th>对象</th><th>原因</th><th>时间</th></tr></thead><tbody>${logs.map((log) => `<tr data-person-name="${escapeHtml((log.admin_name || '系统').toLowerCase())}"><td>${escapeHtml(log.admin_name || '系统')}</td><td><strong>${escapeHtml(log.action)}</strong></td><td>${escapeHtml(log.target_type)} #${escapeHtml(log.target_id)}</td><td>${escapeHtml(log.reason || '-')}</td><td>${formatDate(log.created_at)}</td></tr>`).join('')}</tbody></table></div>` : emptyState('scroll-text', '暂无审计记录', '管理员关键操作将在这里留痕'));
  document.querySelector('#audit-person-search')?.addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll('tr[data-person-name]').forEach((row) => { row.hidden = query && !row.dataset.personName.includes(query); });
  });
}

async function renderAdminAccess() {
  const [{ groups }, { permissions }, { grades }, { users }, { groups: selectionGroups }] = await Promise.all([
    api('/api/admin/admin-groups'), api('/api/admin/permissions'), api('/api/admin/grades'), api('/api/admin/users'), api('/api/admin/student-selection-groups'),
  ]);
  state.selectionGroups = selectionGroups;
  state.accessCatalog = { permissions, grades, users: users.filter((user) => user.account_type === 'USER') };
  setPage(`<div class="toolbar"><div class="search-field">${icon('search')}<input id="admin-group-member-search" placeholder="按成员姓名搜索管理员组"></div><div class="toolbar-spacer"></div><button class="btn btn-secondary" id="manage-selection-groups">${icon('users-round')}预设学生群组</button><button class="btn btn-primary" id="create-admin-group">${icon('plus')}新建管理员组</button></div><div class="field-hint toolbar-note">按年级授权时，权限和年级范围必须由同一个组提供；首页更新是全局权限，不使用年级范围。</div>
    ${groups.length ? `<div class="access-grid">${groups.map((group) => `<section class="panel access-card"><div class="section-heading"><div><h2>${escapeHtml(group.name)}</h2><p><code>${escapeHtml(group.code)}</code> · ${escapeHtml(group.description || '暂无说明')}</p></div>${statusBadge(group.status === 'ACTIVE' ? '有效' : '已停用', group.status === 'ACTIVE' ? 'active' : 'closed')}</div><dl class="access-summary"><div><dt>成员</dt><dd>${group.members.map((member) => escapeHtml(member.name)).join('、') || '未配置'}</dd></div><div><dt>年级范围</dt><dd>${group.scopes.map((scope) => escapeHtml(scope.grade_name || scope.scope_value)).join('、') || '未配置'}</dd></div><div><dt>权限</dt><dd>${group.permissions.map((code) => escapeHtml(permissions.find((item) => item.code === code)?.name || code)).join('、') || '未配置'}</dd></div></dl><button class="btn btn-secondary" data-configure-group="${group.id}">${icon('settings')}配置管理员组</button></section>`).join('')}</div>` : emptyState('shield-check', '暂无管理员组', '新建管理员组后配置成员、权限和年级范围')}`);
  document.querySelector('#create-admin-group').addEventListener('click', showCreateAdminGroup);
  document.querySelector('#manage-selection-groups').addEventListener('click', openSelectionGroupManager);
  document.querySelector('#admin-group-member-search').addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll('.access-card').forEach((card, index) => {
      card.hidden = query && !groups[index].members.some((member) => member.name.toLowerCase().includes(query));
    });
  });
  document.querySelectorAll('[data-configure-group]').forEach((button) => button.addEventListener('click', () => showConfigureAdminGroup(groups.find((group) => group.id === Number(button.dataset.configureGroup)))));
}

function showCreateAdminGroup() {
  const modal = openModal('新建管理员组', `<form id="create-group-form" class="form-grid"><div class="form-field"><label>唯一编码</label><input name="code" maxlength="40" placeholder="例如 GRADE_2026_ADMIN" required></div><div class="form-field"><label>名称</label><input name="name" maxlength="80" required></div><div class="form-field full"><label>说明</label><textarea name="description" maxlength="500"></textarea></div><div class="form-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary">${icon('plus')}创建</button></div></form>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('#create-group-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await api('/api/admin/admin-groups', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); closeModal(); toast('管理员组已创建'); await renderAdminAccess(); }
    catch (error) { toast(error.message, 'error'); }
  });
}

function showConfigureAdminGroup(group) {
  const { permissions, grades, users } = state.accessCatalog;
  const memberIds = new Set(group.members.map((item) => item.id));
  const gradeIds = new Set(group.scopes.filter((item) => item.scope_type === 'GRADE').map((item) => Number(item.scope_value)));
  const permissionCodes = new Set(group.permissions);
  const modal = openModal('配置管理员组', `<form id="configure-group-form"><div class="form-grid"><div class="form-field"><label>组编码</label><input value="${escapeHtml(group.code)}" disabled></div><div class="form-field"><label>状态</label><select name="status"><option value="ACTIVE" ${group.status === 'ACTIVE' ? 'selected' : ''}>有效</option><option value="DISABLED" ${group.status === 'DISABLED' ? 'selected' : ''}>停用</option></select></div><div class="form-field"><label>名称</label><input name="name" value="${escapeHtml(group.name)}" maxlength="80" required></div><div class="form-field"><label>变更原因</label><input name="reason" maxlength="200" required></div><div class="form-field full"><label>说明</label><textarea name="description" maxlength="500">${escapeHtml(group.description)}</textarea></div></div><div class="section"><div class="section-heading"><div><h2>年级范围</h2><p>权限只能作用于这里选择的年级</p></div></div><div class="candidate-grid">${grades.map((grade) => `<div class="candidate"><input type="checkbox" name="gradeIds" value="${grade.id}" id="grade-${grade.id}" ${gradeIds.has(grade.id) ? 'checked' : ''}><label for="grade-${grade.id}">${icon('graduation-cap')}<span>${escapeHtml(grade.name)}</span></label></div>`).join('')}</div></div><div class="section"><div class="section-heading"><div><h2>权限</h2><p>只授予完成职责所需的权限</p></div></div><div class="candidate-grid">${permissions.map((permission) => `<div class="candidate"><input type="checkbox" name="permissions" value="${permission.code}" id="permission-${permission.code}" ${permissionCodes.has(permission.code) ? 'checked' : ''}><label for="permission-${permission.code}">${icon('key-round')}<span>${escapeHtml(permission.name)}<small>${escapeHtml(permission.code)}</small></span></label></div>`).join('')}</div></div><div class="section"><div class="section-heading"><div><h2>成员</h2><p>成员仍可使用学生端，并可切换到管理工作台</p></div></div>${personPickerTools('admin-member')}<div class="candidate-grid" data-person-picker="admin-member">${users.map((user) => `<div class="candidate" data-person-name="${escapeHtml(user.name.toLowerCase())}"><input type="checkbox" name="userIds" value="${user.id}" id="member-${user.id}" ${memberIds.has(user.id) ? 'checked' : ''}><label for="member-${user.id}">${icon('user-round')}<span>${escapeHtml(user.name)}<small>${escapeHtml(user.grade)} · ${escapeHtml(user.login_identifier)}</small></span></label></div>`).join('')}</div></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary">${icon('save')}保存全部配置</button></div></form>`, { wide: true });
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  bindPersonPicker(modal, 'admin-member');
  modal.querySelector('#configure-group-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const reason = form.reason.value;
    const selected = (name) => [...form.querySelectorAll(`[name="${name}"]:checked`)].map((item) => item.value);
    try {
      await api(`/api/admin/admin-groups/${group.id}`, { method: 'PUT', body: JSON.stringify({
        name: form.name.value,
        description: form.description.value,
        status: form.status.value,
        gradeIds: selected('gradeIds').map(Number),
        permissions: selected('permissions'),
        userIds: selected('userIds').map(Number),
        reason,
      }) });
      closeModal(); toast('管理员组配置已更新'); await renderAdminAccess();
    } catch (error) { toast(error.message, 'error'); }
  });
}

async function init() {
  try {
    const data = await api('/api/me');
    state.user = data.user;
    state.gender = data.user.gender === 'MALE' ? 'MALE' : 'FEMALE';
    state.csrfToken = data.csrfToken;
  } catch (error) {
    if (error.status !== 401) toast(error.message, 'error');
  }
  if (window.location.pathname === '/roommates') await enterRoommateSystem();
  else if (window.location.pathname === '/login') {
    const continueToSystem = new URLSearchParams(window.location.search).get('next') === '/roommates';
    if (!state.user) renderLoginPage();
    else if (continueToSystem) {
      history.replaceState({}, '', '/roommates');
      await enterRoommateSystem();
    } else {
      window.location.replace('/');
    }
  } else {
    window.location.replace('/');
  }
}

window.addEventListener('popstate', () => {
  if (window.location.pathname === '/roommates') enterRoommateSystem();
  else if (window.location.pathname === '/login') {
    const continueToSystem = new URLSearchParams(window.location.search).get('next') === '/roommates';
    if (!state.user) renderLoginPage();
    else if (continueToSystem) {
      history.replaceState({}, '', '/roommates');
      enterRoommateSystem();
    } else {
      window.location.replace('/');
    }
  } else window.location.replace('/');
});

init();
