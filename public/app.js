const app = document.querySelector('#app');
const modalRoot = document.querySelector('#modal-root');
const toastRoot = document.querySelector('#toast-root');
const API_PATH_CHARACTERS = 'abcdefghijklmnopqrstuvwxyz0123456789-';
const API_QUERY_CHARACTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~%=&+*';
const DEFAULT_AVATAR_URL = '/assets/avatar-1.png';
const AVATAR_CACHE_VERSION = '20260826';
const ACTIVITY_TIME_ZONE = 'Asia/Shanghai';
const activityDateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: ACTIVITY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const activityWeekdayNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const activityShortWeekdayNames = ['一', '二', '三', '四', '五', '六', '日'];

function activityDateParts(value) {
  return Object.fromEntries(
    activityDateTimeFormatter.formatToParts(new Date(value))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
}

function activityDateKey(value) {
  const parts = activityDateParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function activityDateFromKey(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function activityDateTimeInput(value) {
  const parts = activityDateParts(value);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function activityTimestamp(value) {
  return new Date(`${value}:00+08:00`).toISOString();
}

const state = {
  user: null,
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
  treeholeNextCursor: null,
  treeholeAdminReplyCursor: null,
  treeholeAdminContentCursor: null,
  officialDormitorySearch: '',
  officialDormitoryNextCursor: null,
  selectedOfficialDormitoryId: null,
  adminOfficialDormitorySearch: '',
  adminOfficialDormitoryOffset: 0,
  activityView: window.innerWidth < 768 ? 'day' : 'month',
  activityDate: activityDateFromKey(activityDateKey(new Date())),
  activityFilters: { keyword: '', type: 'all', importance: '', registration: 'all' },
  activityFiltersOpen: false,
  activityDetailId: null,
  activityTemplateId: null,
  activityEditId: null,
  activityExpandedSlots: new Set(),
};

let refreshPromise = null;
let modalReturnFocus = null;

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
  treeholeVisibility: { PRIVATE: '私密', PUBLIC: '已公开', WITHDRAWN: '已撤回' },
  treeholeModeration: { NORMAL: '正常', HIDDEN: '已隐藏', DELETED: '已删除' },
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
  const safe = url || DEFAULT_AVATAR_URL;
  const source = safe.startsWith('/api/avatars/') ? `${safe}?v=${AVATAR_CACHE_VERSION}` : safe;
  return `<img class="avatar ${size}" src="${escapeHtml(source)}" alt="${escapeHtml(name)}的头像">`;
}

function replaceBrokenAvatar(event) {
  const image = event.target;
  if (!(image instanceof HTMLImageElement) || !image.classList.contains('avatar')) return;
  if (image.getAttribute('src') !== DEFAULT_AVATAR_URL) image.src = DEFAULT_AVATAR_URL;
}

document.addEventListener('error', replaceBrokenAvatar, true);

function toast(message, kind = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${kind === 'error' ? 'error' : ''}`;
  item.innerHTML = `${icon(kind === 'error' ? 'circle-alert' : 'circle-check')}<span>${escapeHtml(message)}</span>`;
  toastRoot.append(item);
  refreshIcons();
  setTimeout(() => item.remove(), 3200);
}

function readCookie(name) {
  const prefix = `${name}=`;
  const item = document.cookie.split('; ').find((cookie) => cookie.startsWith(prefix));
  return item ? decodeURIComponent(item.slice(prefix.length)) : '';
}

async function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const response = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-CSRF-Token': readCookie('csrf_token') },
      });
      const data = await response.json().catch(() => ({}));
      if (response.status === 409 && data.error?.code === 'REFRESH_ALREADY_ROTATED') return;
      if (!response.ok) {
        const error = new Error(data.error?.message || '登录已过期，请重新登录');
        error.code = data.error?.code;
        error.status = response.status;
        throw error;
      }
    })().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

function apiRequestUrl(path) {
  const [pathname, query, ...extraParts] = typeof path === 'string' ? path.split('?') : [];
  const pathSegments = pathname?.startsWith('/api/') ? pathname.slice(5).split('/') : [];
  const validPath = pathSegments.length > 0 && pathSegments.every((segment) => segment && [...segment].every((character) => API_PATH_CHARACTERS.includes(character)));
  const validQuery = query === undefined || [...query].every((character) => API_QUERY_CHARACTERS.includes(character));
  if (!validPath || !validQuery || extraParts.length) throw new Error('接口地址无效');
  const requestUrl = new URL(path, window.location.origin);
  if (requestUrl.origin !== window.location.origin) throw new Error('接口地址无效');
  return requestUrl;
}

function apiRequestHeaders(options) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const csrfToken = readCookie('csrf_token');
  if (csrfToken && !['GET', 'HEAD'].includes(options.method || 'GET')) headers['X-CSRF-Token'] = csrfToken;
  return headers;
}

function showLoginAfterUnauthorized() {
  state.user = null;
  const currentPath = window.location.pathname;
  const next = ['/roommates', '/shudong', '/sude', '/activities'].includes(currentPath)
    || /^\/sude\/dormitories\/\d+$/.test(currentPath)
    || /^\/activities\/(?:new|\d+)(?:\/edit)?$/.test(currentPath)
    ? currentPath : '';
  history.replaceState({}, '', next ? `/login?next=${encodeURIComponent(next)}` : '/login');
  renderLoginPage();
}

async function refreshManagementProfile() {
  try {
    const refreshed = await fetch('/api/me', { credentials: 'same-origin' });
    if (!refreshed.ok) return;
    const session = await refreshed.json();
    state.user = session.user;
    if (!state.user.canManage && state.user.accountType === 'USER') {
      state.mode = 'student';
      state.view = 'discover';
    } else if (!visibleAdminNav().some(([view]) => view === state.view)) {
      state.view = 'overview';
    }
    setTimeout(() => navigate(state.view), 0);
  } catch {}
}

async function throwApiFailure(response, data) {
  if (response.status === 401 && state.user) showLoginAfterUnauthorized();
  if (response.status === 403 && state.user && state.mode === 'management') await refreshManagementProfile();
  const error = new Error(data.error?.message || '请求失败，请稍后重试');
  error.code = data.error?.code;
  error.status = response.status;
  throw error;
}

async function api(path, options = {}, retryAuthentication = true) {
  const response = await fetch(apiRequestUrl(path), {
    credentials: 'same-origin',
    ...options,
    headers: apiRequestHeaders(options),
  });
  const data = await response.json().catch(() => ({}));
  const accessExpired = response.status === 401 && data.error?.code === 'ACCESS_TOKEN_EXPIRED';
  if (accessExpired && retryAuthentication) {
    try {
      await refreshAccessToken();
      return api(path, options, false);
    } catch {}
  }
  if (!response.ok) await throwApiFailure(response, data);
  return data;
}

function openModal(title, body, { wide = false } = {}) {
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
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
  const modal = modalRoot.querySelector('.modal');
  modal.querySelector('input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button')?.focus();
  return modal;
}

function parseSafeHtml(markup) {
  const documentFragment = new DOMParser().parseFromString(String(markup), 'text/html');
  documentFragment.querySelectorAll('script, iframe, object, embed, link, meta').forEach((node) => node.remove());
  documentFragment.querySelectorAll('*').forEach((node) => {
    [...node.attributes].forEach((attribute) => {
      if (attribute.name.toLowerCase().startsWith('on')) node.removeAttribute(attribute.name);
      if (attribute.name.toLowerCase() === 'href' && /^\s*javascript:/i.test(attribute.value)) node.removeAttribute(attribute.name);
      if (attribute.name.toLowerCase() === 'src' && /^\s*javascript:/i.test(attribute.value)) node.removeAttribute(attribute.name);
    });
  });
  return [...documentFragment.body.childNodes];
}

function closeModal() {
  modalRoot.innerHTML = '';
  if (modalReturnFocus?.isConnected) modalReturnFocus.focus();
  modalReturnFocus = null;
}

function emptyState(iconName, title, text, action = '') {
  return `<div class="empty-state">${icon(iconName)}<h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>${action}</div>`;
}

function personSearchText(person) {
  return [person.name, person.login_identifier, person.grade, person.major].filter(Boolean).join(' ').toLowerCase();
}

function personPickerTools(prefix, groups = state.selectionGroups) {
  const groupOptions = groups.map((group) => `<option value="${group.id}">${escapeHtml(group.name)}（${group.members.length} 人）</option>`).join('');
  const disabled = groups.length ? '' : 'disabled';
  return `<div class="person-picker-tools"><div class="search-field">${icon('search')}<input data-person-search="${prefix}" placeholder="按姓名搜索（也支持登录标识、年级或专业）"></div><select data-person-group="${prefix}" aria-label="预设学生群组" ${disabled}><option value="">选择预设群组</option>${groupOptions}</select><button type="button" class="btn btn-secondary" data-add-person-group="${prefix}" ${disabled}>${icon('user-plus')}一键添加</button><button type="button" class="btn btn-secondary" data-select-visible="${prefix}">全选当前结果</button></div>`;
}

function bindPersonSearch(form, prefix) {
  form.querySelector(`[data-person-search="${prefix}"]`).addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    form.querySelectorAll(`[data-person-picker="${prefix}"] [data-person-search-text]`).forEach((candidate) => {
      candidate.hidden = query && !candidate.dataset.personSearchText.includes(query);
    });
  });
  form.querySelector(`[data-select-visible="${prefix}"]`)?.addEventListener('click', () => {
    const visible = form.querySelectorAll(`[data-person-picker="${prefix}"] [data-person-search-text]:not([hidden]) input[type="checkbox"]`);
    let selected = 0;
    visible.forEach((input) => {
      if (!input.checked && !input.disabled) { input.checked = true; selected += 1; }
    });
    toast(selected ? `已选中 ${selected} 名学生` : '当前搜索结果已全部选中');
  });
}

function bindPersonPicker(form, prefix, groups = state.selectionGroups) {
  bindPersonSearch(form, prefix);
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
  if (page) page.replaceChildren(...parseSafeHtml(content));
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

function treeholeNav() {
  const navigation = [['treehole-public', 'trees', '公开树洞']];
  if (state.user?.accountType === 'USER') navigation.push(['treehole-mine', 'notebook-pen', '我的树洞']);
  return navigation;
}

const officialDormitoryNav = [
  ['official-mine', 'house-heart', '我的宿舍'],
  ['official-visit', 'door-open', '赛博串门'],
];

const activityNav = [
  ['activities-calendar', 'calendar-days', '活动日历'],
  ['activities-groups', 'users-round', '我的群组'],
];

const adminNav = [
  ['overview', 'layout-dashboard', '数据概览'],
  ['users', 'users', '账号管理'],
  ['cards', 'contact-round', '卡片治理'],
  ['treehole-replies', 'messages-square', '树洞回复'],
  ['treehole-content', 'trees', '树洞治理'],
  ['official-dormitories', 'house-heart', '正式宿舍'],
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
    if (key === 'treehole-replies') return hasPermission('TREEHOLE_PRIVATE_REPLY');
    if (key === 'treehole-content') return hasPermission('TREEHOLE_MODERATE') || state.user.isSuperAdmin;
    if (key === 'official-dormitories') return ['OFFICIAL_DORMITORY_READ', 'OFFICIAL_DORMITORY_IMPORT', 'OFFICIAL_DORMITORY_MEMBER_UPDATE', 'OFFICIAL_DORMITORY_MODERATE'].some(hasPermission);
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
  'treehole-public': ['公开树洞', '匿名分享成长记录与建议'],
  'treehole-mine': ['我的树洞', '查看私密交流与公开状态'],
  'treehole-replies': ['树洞回复', '回复授权年级的新生私密帖子'],
  'treehole-content': ['树洞治理', '按授权范围处理帖子和评论'],
  'official-mine': ['我的宿舍', '与舍友共同建设宿舍空间'],
  'official-visit': ['赛博串门', '看看其他宿舍的介绍与公约'],
  'official-detail': ['宿舍详情', '查看宿舍介绍、公约和成员'],
  'official-dormitories': ['正式宿舍', '导入学校名单并管理正式宿舍'],
  'activities-calendar': ['活动广场', '按时间发现和参加校园活动'],
  'activities-detail': ['活动详情', '查看安排、名额与参与者'],
  'activities-form': ['创建活动', '设置时间、容量和目标人群'],
  'activities-groups': ['我的群组', '维护创建活动时使用的学生名单'],
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
  document.title = '合住 · 自由双选室友';
  state.mode = state.user.isSuperAdmin ? 'management' : 'student';
  state.view = state.mode === 'management' ? 'overview' : 'discover';
  if (state.user.mustChangePassword) {
    renderLoginPage();
    showRequiredPasswordChange('/roommates');
    return;
  }
  await navigate(state.view);
}

async function enterTreeholeSystem() {
  if (!state.user) {
    if (window.location.pathname === '/shudong') history.replaceState({}, '', '/login?next=%2Fshudong');
    else history.pushState({}, '', '/login?next=%2Fshudong');
    renderLoginPage();
    return;
  }
  if (window.location.pathname !== '/shudong') history.pushState({}, '', '/shudong');
  document.title = '树洞道理 · 树德岛哩';
  state.mode = 'treehole';
  state.view = 'treehole-public';
  if (state.user.mustChangePassword) {
    renderLoginPage();
    showRequiredPasswordChange('/shudong');
    return;
  }
  await navigate(state.view);
}

async function enterOfficialDormitorySystem() {
  const currentPath = window.location.pathname;
  const requestedPath = currentPath === '/sude' || /^\/sude\/dormitories\/\d+$/.test(currentPath)
    ? currentPath : '/sude';
  if (!state.user) {
    history.replaceState({}, '', `/login?next=${encodeURIComponent(requestedPath)}`);
    renderLoginPage();
    return;
  }
  if (state.user.mustChangePassword) {
    renderLoginPage();
    showRequiredPasswordChange(requestedPath);
    return;
  }
  if (currentPath !== requestedPath) history.pushState({}, '', requestedPath);
  document.title = '宿得道理 · 树德岛哩';
  if (state.user.isSuperAdmin) {
    state.mode = 'management';
    await navigate('official-dormitories');
    return;
  }
  state.mode = 'official-dormitory';
  const detailMatch = /^\/sude\/dormitories\/(\d+)$/.exec(requestedPath);
  state.selectedOfficialDormitoryId = detailMatch ? Number(detailMatch[1]) : null;
  await navigate(detailMatch ? 'official-detail' : 'official-mine');
}

async function enterActivitySystem() {
  const currentPath = window.location.pathname;
  const activityPath = currentPath === '/activities' || /^\/activities\/(?:new|\d+)(?:\/edit)?$/.test(currentPath)
    ? currentPath : '/activities';
  if (!state.user) {
    history.replaceState({}, '', `/login?next=${encodeURIComponent(activityPath)}`);
    renderLoginPage();
    return;
  }
  if (state.user.mustChangePassword) {
    renderLoginPage();
    showRequiredPasswordChange(activityPath);
    return;
  }
  if (currentPath !== activityPath) history.pushState({}, '', activityPath);
  document.title = '活动广场 · 树德岛哩';
  state.mode = 'activities';
  const detailMatch = /^\/activities\/(\d+)$/.exec(activityPath);
  const editMatch = /^\/activities\/(\d+)\/edit$/.exec(activityPath);
  state.activityDetailId = detailMatch ? Number(detailMatch[1]) : null;
  state.activityEditId = editMatch ? Number(editMatch[1]) : null;
  state.activityTemplateId = new URLSearchParams(window.location.search).get('template');
  if (activityPath === '/activities/new' || editMatch) await navigate('activities-form');
  else if (detailMatch) await navigate('activities-detail');
  else await navigate('activities-calendar');
}

function renderShell() { // NOSONAR
  const management = state.mode === 'management';
  const treehole = state.mode === 'treehole';
  const officialDormitory = state.mode === 'official-dormitory';
  const activities = state.mode === 'activities';
  let nav = studentNav;
  let brandSymbol = '合';
  let brandName = '合住';
  let brandDescription = '自由双选室友';
  let navLabel = '室友双选';
  if (management) {
    nav = visibleAdminNav();
    navLabel = '管理工作台';
  } else if (treehole) {
    nav = treeholeNav();
    brandSymbol = '树';
    brandName = '树洞道理';
    brandDescription = '成长记录与交流';
    navLabel = '树洞道理';
  } else if (officialDormitory) {
    nav = officialDormitoryNav;
    brandSymbol = '宿';
    brandName = '宿得道理';
    brandDescription = '共同建设宿舍';
    navLabel = '正式宿舍';
  } else if (activities) {
    nav = activityNav;
    brandSymbol = '活';
    brandName = '活动广场';
    brandDescription = '校园活动日历';
    navLabel = '校园活动';
  }
  const [title, subtitle] = titles[state.view] || titles[nav[0][0]];
  const navItems = nav.map(([key, iconName, label]) => {
    const active = state.view === key || (key === 'activities-calendar' && state.view === 'activities-detail') ? 'active' : '';
    return `<button class="nav-item ${active}" data-view="${key}">${icon(iconName)}<span>${label}</span></button>`;
  }).join('');
  const mobileNavItems = nav.map(([key, iconName, label]) => {
    const active = state.view === key || (key === 'activities-calendar' && state.view === 'activities-detail') ? 'active' : '';
    return `<button class="${active}" data-view="${key}">${icon(iconName)}<span>${label}</span></button>`;
  }).join('');
  let userRole = escapeHtml(state.user.grade);
  if (management) userRole = state.user.isSuperAdmin ? '超级管理员' : '组管理员';
  const systemButtons = [
    state.mode !== 'student' ? `<button class="btn btn-secondary" id="roommate-system-btn">${icon('users-round')}<span>室友双选</span></button>` : '',
    !treehole ? `<button class="btn btn-secondary" id="treehole-system-btn">${icon('trees')}<span>树洞道理</span></button>` : '',
    !officialDormitory ? `<button class="btn btn-secondary" id="official-dormitory-system-btn">${icon('house')}<span>宿得道理</span></button>` : '',
    !activities ? `<button class="btn btn-secondary" id="activity-system-btn">${icon('calendar-days')}<span>活动广场</span></button>` : '',
  ].join('');
  let modeButton = '';
  if (state.user.accountType === 'USER' && state.user.canManage) {
    const modeIcon = management ? 'users-round' : 'layout-dashboard';
    const modeText = management ? '返回学生端' : '进入管理工作台';
    modeButton = `<button class="btn btn-secondary" id="switch-mode">${icon(modeIcon)}<span>${modeText}</span></button>`;
  }
  const treeholeAdminButton = treehole && state.user.isSuperAdmin
    ? `<button class="btn btn-secondary" id="treehole-admin-btn">${icon('layout-dashboard')}<span>管理工作台</span></button>`
    : '';
  const loading = emptyState('loader-circle', '正在加载', '正在读取最新数据');
  app.replaceChildren(...parseSafeHtml(`
    <div class="app-shell ${activities ? 'activity-shell' : ''}">
      <aside class="sidebar">
        <div class="sidebar-brand"><div class="brand-mark">${brandSymbol}</div><div><strong>${brandName}</strong><small>${brandDescription}</small></div></div>
        <div class="nav-label">${navLabel}</div>
        <nav class="nav-list">${navItems}</nav>
        <div class="sidebar-user"><strong>${escapeHtml(state.user.name)}</strong><small>${userRole}</small></div>
      </aside>
      <main class="main-shell">
        <header class="topbar">
          <div class="topbar-title"><h1>${title}</h1><p>${subtitle}</p></div>
          <div class="topbar-actions">
            <button class="btn btn-secondary" id="home-btn">${icon('home')}<span>首页</span></button>
            ${systemButtons}
            ${modeButton}
            ${treeholeAdminButton}
            <button class="btn btn-secondary" id="logout-btn">${icon('log-out')}<span>退出</span></button>
          </div>
        </header>
        <div class="page" id="page-content">${loading}</div>
      </main>
      <nav class="mobile-nav">${mobileNavItems}</nav>
    </div>`));
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.view)));
  document.querySelector('#switch-mode')?.addEventListener('click', async () => {
    if (management) await enterRoommateSystem();
    else {
      state.mode = 'management';
      await navigate('overview');
    }
  });
  document.querySelector('#home-btn').addEventListener('click', goHome);
  document.querySelector('#treehole-system-btn')?.addEventListener('click', enterTreeholeSystem);
  document.querySelector('#roommate-system-btn')?.addEventListener('click', enterRoommateSystem);
  document.querySelector('#official-dormitory-system-btn')?.addEventListener('click', enterOfficialDormitorySystem);
  document.querySelector('#activity-system-btn')?.addEventListener('click', enterActivitySystem);
  document.querySelector('#treehole-admin-btn')?.addEventListener('click', async () => {
    state.mode = 'management';
    await navigate('overview');
  });
  document.querySelector('#logout-btn').addEventListener('click', logout);
  refreshIcons();
}

async function navigate(view) {
  state.view = view;
  renderShell();
  try {
    if (state.mode === 'management') await loadAdminView(view);
    else if (state.mode === 'treehole') await loadTreeholeView(view);
    else if (state.mode === 'official-dormitory') await loadOfficialDormitoryView(view);
    else if (state.mode === 'activities') await loadActivityView(view);
    else await loadStudentView(view);
  } catch (error) {
    setPage(emptyState('circle-alert', '页面加载失败', error.message, `<button class="btn btn-secondary" id="retry-view">${icon('refresh-cw')}重试</button>`));
    document.querySelector('#retry-view')?.addEventListener('click', () => navigate(view));
  }
}

function renderLoginPage() {
  const continuePath = requestedNextPath();
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
      state.mode = data.user.isSuperAdmin ? 'management' : 'student';
      state.view = state.mode === 'management' ? 'overview' : 'discover';
      if (data.user.mustChangePassword) {
        showRequiredPasswordChange(continuePath);
      } else if (continuePath) {
        history.replaceState({}, '', continuePath);
        await enterRequestedPath(continuePath);
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
  closeModal();
  goHome();
}

function requestedNextPath() {
  const next = new URLSearchParams(window.location.search).get('next');
  return ['/roommates', '/shudong', '/sude', '/activities'].includes(next)
    || /^\/sude\/dormitories\/\d+$/.test(next || '')
    || /^\/activities\/(?:new|\d+)(?:\/edit)?$/.test(next || '') ? next : '';
}

async function enterRequestedPath(path) {
  if (path === '/shudong') await enterTreeholeSystem();
  else if (path === '/sude' || /^\/sude\/dormitories\/\d+$/.test(path)) await enterOfficialDormitorySystem();
  else if (path === '/activities' || /^\/activities\/(?:new|\d+)(?:\/edit)?$/.test(path)) await enterActivitySystem();
  else if (path === '/roommates') await enterRoommateSystem();
  else goHome();
}

function showRequiredPasswordChange(continuePath = '/roommates') {
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
      if (continuePath) await enterRequestedPath(continuePath);
      else goHome();
    } catch (error) { toast(error.message, 'error'); }
  });
}

function activityImportanceLabel(level) {
  return ['I · 一般', 'II · 关注', 'III · 重要', 'IV · 很重要', 'V · 必须关注'][level - 1] || `I${level}`;
}

function activityTimeLabel(activity) {
  if (activity.isAllDay) return '全天';
  const start = activityDateParts(activity.startAt);
  const end = activityDateParts(activity.endAt);
  return `${start.hour}:${start.minute}–${end.hour}:${end.minute}`;
}

function activityHeatLevel(score) {
  if (score === 0) return 0;
  if (score <= 3) return 1;
  if (score <= 8) return 2;
  if (score <= 15) return 3;
  if (score <= 24) return 4;
  return 5;
}

function activityStatusBadge(activity) {
  if (activity.status === 'DRAFT') return statusBadge('草稿', 'pending', 'file-pen-line');
  if (activity.status === 'CANCELLED') return statusBadge('已取消', 'closed', 'calendar-x');
  if (new Date(activity.endAt) <= new Date()) return statusBadge('已结束', 'closed', 'circle-stop');
  return statusBadge('报名中', 'active', 'ticket-check');
}

function activitySummaryCard(activity, controls = false) {
  const full = activity.registrationCount >= activity.capacity;
  const percent = Math.min(100, Math.round((activity.registrationCount / activity.capacity) * 100));
  return `<article class="activity-card activity-importance-${activity.importance}" data-activity-open="${activity.id}" tabindex="0">
    <div class="activity-card-badges">${activity.organizerType === 'ADMIN_GROUP' ? '<span class="activity-badge official">官方</span>' : ''}<span class="activity-badge">${activityImportanceLabel(activity.importance)}</span>${activity.registered ? '<span class="activity-badge joined">已报名</span>' : ''}${full ? '<span class="activity-badge full">已满</span>' : ''}</div>
    <h3>${escapeHtml(activity.title)}</h3>
    <p>${icon('clock-3')}${activityTimeLabel(activity)}</p>
    <p>${icon('map-pin')}${escapeHtml(activity.location)} · ${escapeHtml(activity.organizerName)}</p>
    <div class="activity-capacity"><span><i style="width:${percent}%"></i></span><small>${activity.registrationCount} / ${activity.capacity}</small></div>
    ${controls ? `<button class="btn btn-secondary activity-card-action" data-activity-open="${activity.id}">${icon('eye')}查看详情</button>` : ''}
  </article>`;
}

function activityMonthMarkup(data) {
  const selectedMonth = state.activityDate.getUTCMonth();
  const selectedDate = activityDateKey(state.activityDate);
  const weekdays = activityShortWeekdayNames.map((day) => `<span>周${day}</span>`).join('');
  const days = data.days.map((day) => {
    const value = activityDateFromKey(day.date);
    const outside = value.getUTCMonth() !== selectedMonth;
    const summaries = day.activities.map((activity) => `<button data-activity-open="${activity.id}" class="activity-month-event importance-${activity.importance}"><time>${activity.isAllDay ? '全天' : activityTimeLabel(activity).split('–')[0]}</time><span>${escapeHtml(activity.title)}</span></button>`).join('');
    const classes = `activity-month-day ${outside ? 'outside' : ''} ${day.date === selectedDate ? 'selected' : ''} ${day.date === activityDateKey(new Date()) ? 'today' : ''}`;
    const count = day.count ? `${day.count} 个` : '';
    const more = day.count > 3 ? `<button class="activity-more" data-activity-day="${day.date}">另有 ${day.count - 3} 个活动</button>` : '';
    return `<div class="${classes}"><button class="activity-day-number" data-activity-date="${day.date}" aria-label="${value.getUTCMonth() + 1} 月 ${value.getUTCDate()} 日，${day.count} 个活动"><span>${value.getUTCDate()}</span><small>${count}</small></button>${summaries}${more}</div>`;
  }).join('');
  return `<section class="panel activity-month"><div class="activity-weekdays">${weekdays}</div><div class="activity-month-grid">${days}</div></section>`;
}

function activityYearMarkup(data) {
  const byDate = new Map(data.days.map((day) => [day.date, day]));
  const year = state.activityDate.getUTCFullYear();
  const weekdays = activityShortWeekdayNames.map((name) => `<span>${name}</span>`).join('');
  const today = activityDateKey(new Date());
  const months = Array.from({ length: 12 }, (_, month) => {
    const first = new Date(Date.UTC(year, month, 1, 12));
    const offset = (first.getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(year, month + 1, 0, 12)).getUTCDate();
    const cells = Array.from({ length: offset }, () => '<span></span>');
    for (let day = 1; day <= days; day += 1) {
      const key = activityDateKey(new Date(Date.UTC(year, month, day, 12)));
      const aggregate = byDate.get(key) || { count: 0, score: 0 };
      const heat = activityHeatLevel(aggregate.score);
      cells.push(`<button class="heat-${heat} ${key === today ? 'today' : ''}" data-activity-date="${key}" title="${month + 1} 月 ${day} 日 · ${aggregate.count} 个活动">${day}</button>`);
    }
    while (cells.length < 42) cells.push('<span></span>');
    const monthCount = data.days.filter((item) => Number(item.date.slice(5, 7)) - 1 === month).reduce((sum, item) => sum + item.count, 0);
    return `<section class="panel activity-mini-month"><button class="activity-mini-title" data-activity-month="${year}-${month + 1}"><strong>${month + 1} 月</strong><small>${monthCount} 个活动</small></button><div class="activity-mini-weekdays">${weekdays}</div><div class="activity-mini-days">${cells.join('')}</div></section>`;
  }).join('');
  return `<div class="activity-year-grid">${months}</div>`;
}

function activityClusters(activities) {
  const sorted = [...activities].sort((first, second) => new Date(first.startAt) - new Date(second.startAt));
  const clusters = [];
  for (const activity of sorted) {
    const start = new Date(activity.startAt);
    const end = new Date(activity.endAt);
    const current = clusters.at(-1);
    if (!current || start >= current.end) clusters.push({ start, end, activities: [activity] });
    else {
      current.activities.push(activity);
      if (end > current.end) current.end = end;
    }
  }
  return clusters;
}

function activityWeekMarkup(data) {
  const start = activityDateFromKey(data.rangeStart);
  const days = Array.from({ length: 7 }, (_, index) => new Date(start.getTime() + index * 86400000));
  const selectedDate = activityDateKey(state.activityDate);
  const headers = days.map((day, index) => {
    const key = activityDateKey(day);
    return `<button class="${key === selectedDate ? 'selected' : ''}" data-activity-date="${key}"><small>${activityShortWeekdayNames[index]}</small><strong>${day.getUTCDate()}</strong></button>`;
  }).join('');
  const allDayCells = days.map((day) => {
    const key = activityDateKey(day);
    const activities = data.activities.filter((activity) => activity.isAllDay && activityDateKey(activity.startAt) === key);
    const buttons = activities.map((activity) => `<button data-activity-open="${activity.id}">${escapeHtml(activity.title)}</button>`).join('');
    return `<div class="activity-week-all-day-cell">${buttons}</div>`;
  }).join('');
  const allDay = data.activities.some((activity) => activity.isAllDay)
    ? `<div class="activity-week-all-day"><span>全天</span>${allDayCells}</div>` : '';
  const timeAxis = Array.from({ length: 11 }, (_, index) => `<span style="top:${index * 65}px">${String(index * 2 + 6).padStart(2, '0')}:00</span>`).join('');
  const columns = days.map((day) => {
    const key = activityDateKey(day);
    const dayActivities = data.activities.filter((activity) => activityDateKey(activity.startAt) === key && !activity.isAllDay);
    const clusters = activityClusters(dayActivities);
    const clusterMarkup = clusters.map((cluster) => {
      const ordered = [...cluster.activities].sort((first, second) => second.importance - first.importance || second.id - first.id);
      const startParts = activityDateParts(cluster.start);
      const minutes = Math.max(0, Number(startParts.hour) * 60 + Number(startParts.minute) - 360);
      const top = Math.min(620, minutes / 120 * 65);
      const height = Math.max(35, Math.min(125, (cluster.end - cluster.start) / 3600000 / 2 * 65));
      const activities = ordered.slice(0, 2).map((activity) => `<button class="importance-${activity.importance}" data-activity-open="${activity.id}"><time>${activityTimeLabel(activity).split('–')[0]}</time><span>${escapeHtml(activity.title)}</span></button>`).join('');
      const more = ordered.length > 2 ? `<button class="activity-cluster-more" data-activity-slot="${key}">另有 ${ordered.length - 2} 个</button>` : '';
      return `<div class="activity-week-cluster" style="top:${top}px;min-height:${height}px">${activities}${more}</div>`;
    }).join('');
    return `<div class="activity-week-column ${key === selectedDate ? 'selected' : ''}">${clusterMarkup}</div>`;
  }).join('');
  return `<section class="panel activity-week-scroll"><div class="activity-week"><div class="activity-week-head"><span></span>${headers}</div>${allDay}<div class="activity-week-body"><div class="activity-time-axis">${timeAxis}</div>${columns}</div></div></section>`;
}

function activityDayMarkup(data, weekDays) {
  const selectedDate = activityDateFromKey(data.date);
  const weekStart = new Date(selectedDate);
  weekStart.setUTCDate(selectedDate.getUTCDate() - ((selectedDate.getUTCDay() + 6) % 7));
  const counts = new Map(weekDays.map((day) => [day.date, day.count]));
  const strip = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(weekStart.getTime() + index * 86400000);
    const key = activityDateKey(date);
    const count = counts.get(key) || 0;
    return `<button class="activity-day-picker ${key === data.date ? 'active' : ''}" data-activity-date="${key}"><span>${activityShortWeekdayNames[index]}</span><strong>${date.getUTCDate()}</strong><small>${count || ''}</small></button>`;
  }).join('');
  const grouped = new Map();
  data.activities.forEach((activity) => {
    const key = activity.isAllDay ? '全天' : activityTimeLabel(activity).split('–')[0];
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(activity);
  });
  const available = data.activities.filter((activity) => activity.registrationCount < activity.capacity).length;
  const joined = data.activities.filter((activity) => activity.registered).length;
  const groups = data.activities.length ? [...grouped.entries()].map(([slot, activities]) => {
    const key = `${data.date}-${slot}`;
    const expanded = state.activityExpandedSlots.has(key);
    const shown = expanded ? activities : activities.slice(0, 3);
    const cards = shown.map((activity) => activitySummaryCard(activity)).join('');
    const expandLabel = expanded ? `${icon('chevron-up')}收起` : `${icon('chevron-down')}展开其余 ${activities.length - 3} 个`;
    const expand = activities.length > 3 ? `<button class="btn btn-secondary" data-activity-expand="${escapeHtml(key)}">${expandLabel}</button>` : '';
    const actions = expand ? `<div class="activity-time-actions">${expand}</div>` : '';
    return `<section class="activity-time-group"><div class="activity-time-label"><strong>${slot}</strong><span>${activities.length} 个活动</span></div><div class="activity-time-cards">${cards}</div>${actions}</section>`;
  }).join('') : emptyState('calendar-x', '这一天还没有符合条件的活动', '可以清除筛选或创建一个新活动', `<button class="btn btn-primary" data-activity-create>${icon('plus')}创建活动</button>`);
  const list = data.activities.length ? `<section class="panel activity-day-list">${groups}</section>` : groups;
  return `<div class="activity-day-layout"><div class="panel activity-day-strip">${strip}</div><section class="activity-day-stats"><div><strong>${data.total}</strong><span>当天活动</span></div><div><strong>${joined}</strong><span>我已报名</span></div><div><strong>${available}</strong><span>仍有名额</span></div></section>${list}</div>`;
}

async function openActivityDayList(dateValue) {
  const data = await api(`/api/activities/day?date=${dateValue}`);
  const modal = openModal(`${dateValue} 的活动`, `<div class="activity-drawer-stats"><span><strong>${data.total}</strong> 全部活动</span><span><strong>${data.activities.filter((item) => item.registered).length}</strong> 已报名</span><span><strong>${data.activities.filter((item) => item.registrationCount < item.capacity).length}</strong> 有名额</span></div><div class="activity-drawer-list">${data.activities.map((activity) => activitySummaryCard(activity, true)).join('') || '<p class="field-hint">没有符合条件的活动。</p>'}</div>`, { wide: true });
  bindActivityOpeners(modal);
}

function bindActivityOpeners(container = document) {
  container.querySelectorAll('[data-activity-open]').forEach((element) => {
    const open = (event) => {
      event.stopPropagation();
      closeModal();
      state.activityDetailId = Number(element.dataset.activityOpen);
      history.pushState({}, '', `/activities/${state.activityDetailId}`);
      navigate('activities-detail');
    };
    element.addEventListener('click', open);
    element.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') open(event); });
  });
}

async function renderActivityCalendar() {
  const params = new URLSearchParams({ view: state.activityView, date: activityDateKey(state.activityDate) });
  Object.entries(state.activityFilters).forEach(([key, value]) => { if (value && value !== 'all') params.set(key === 'type' ? 'type' : key, value); });
  let title;
  let content;
  if (state.activityView === 'year') {
    const data = await api(`/api/activities/calendar?${params}`);
    title = `${state.activityDate.getUTCFullYear()} 年`;
    content = activityYearMarkup(data);
  } else if (state.activityView === 'month') {
    const data = await api(`/api/activities/calendar?${params}`);
    title = `${state.activityDate.getUTCFullYear()} 年 ${state.activityDate.getUTCMonth() + 1} 月`;
    content = activityMonthMarkup(data);
  } else if (state.activityView === 'week') {
    const data = await api(`/api/activities/calendar?${params}`);
    const start = activityDateFromKey(data.rangeStart);
    const end = activityDateFromKey(data.rangeEnd);
    title = start.getUTCMonth() === end.getUTCMonth()
      ? `${start.getUTCMonth() + 1} 月 ${start.getUTCDate()} 日–${end.getUTCDate()} 日`
      : `${start.getUTCMonth() + 1} 月 ${start.getUTCDate()} 日–${end.getUTCMonth() + 1} 月 ${end.getUTCDate()} 日`;
    content = activityWeekMarkup(data);
  } else {
    const weekParams = new URLSearchParams(params);
    weekParams.set('view', 'week');
    const [day, week] = await Promise.all([
      api(`/api/activities/day?date=${activityDateKey(state.activityDate)}&${params}`),
      api(`/api/activities/calendar?${weekParams}`),
    ]);
    title = `${state.activityDate.getUTCMonth() + 1} 月 ${state.activityDate.getUTCDate()} 日 · ${activityWeekdayNames[state.activityDate.getUTCDay()]}`;
    content = activityDayMarkup(day, week.days);
  }
  const views = [['year', '年'], ['month', '月'], ['week', '周'], ['day', '日']]
    .map(([view, label]) => `<button class="${state.activityView === view ? 'active' : ''}" data-activity-view="${view}">${label}</button>`)
    .join('');
  const importanceOptions = [5, 4, 3, 2, 1]
    .map((level) => `<option value="${level}" ${state.activityFilters.importance === String(level) ? 'selected' : ''}>${activityImportanceLabel(level)}</option>`)
    .join('');
  const heat = [1, 2, 3, 4, 5].map((level) => `<i class="heat-${level}"></i>`).join('');
  setPage(`<div class="activity-toolbar"><div class="activity-date-nav"><button class="btn btn-secondary" data-activity-today>今天</button><button class="btn btn-secondary icon-btn" data-activity-nav="previous" title="上一个时间段">${icon('chevron-left')}</button><button class="btn btn-secondary icon-btn" data-activity-nav="next" title="下一个时间段">${icon('chevron-right')}</button><h2>${escapeHtml(title)}</h2></div><div class="toolbar-spacer"></div><div class="activity-heat-legend" aria-label="活动热力图例"><span>热力</span>${heat}</div><div class="segmented activity-view-switch">${views}</div><button class="btn btn-secondary activity-filter-toggle" data-activity-toggle-filters aria-label="展开筛选" aria-expanded="${state.activityFiltersOpen}">${icon('filter')}</button><button class="btn btn-secondary" data-activity-groups aria-label="管理我的群组">${icon('users-round')}<span>我的群组</span></button><button class="btn btn-primary" data-activity-create aria-label="创建活动">${icon('plus')}<span>创建活动</span></button></div><form class="activity-filters ${state.activityFiltersOpen ? 'open' : ''}" id="activity-filter-form"><label class="activity-search-field"><span class="sr-only">搜索活动、地点或主办者</span>${icon('search')}<input name="keyword" maxlength="80" value="${escapeHtml(state.activityFilters.keyword)}" placeholder="搜索活动、地点或主办者"></label><label><span>活动类型</span><select name="type"><option value="all">全部活动</option><option value="official" ${state.activityFilters.type === 'official' ? 'selected' : ''}>官方活动</option><option value="personal" ${state.activityFilters.type === 'personal' ? 'selected' : ''}>个人活动</option></select></label><label><span>重要程度</span><select name="importance"><option value="">全部重要程度</option>${importanceOptions}</select></label><label><span>报名状态</span><select name="registration"><option value="all">全部报名状态</option><option value="joined" ${state.activityFilters.registration === 'joined' ? 'selected' : ''}>我已报名</option><option value="available" ${state.activityFilters.registration === 'available' ? 'selected' : ''}>仍有名额</option><option value="mine" ${state.activityFilters.registration === 'mine' ? 'selected' : ''}>我创建的</option></select></label><button class="btn btn-quiet" type="button" data-activity-clear>${icon('x')}清除</button></form><div class="activity-calendar-content">${content}</div>`);
  history.replaceState({}, '', `/activities?view=${state.activityView}&date=${activityDateKey(state.activityDate)}`);
  document.querySelectorAll('[data-activity-view]').forEach((button) => button.addEventListener('click', () => { state.activityView = button.dataset.activityView; renderActivityCalendar(); }));
  document.querySelector('[data-activity-today]').addEventListener('click', () => { state.activityDate = activityDateFromKey(activityDateKey(new Date())); renderActivityCalendar(); });
  document.querySelectorAll('[data-activity-nav]').forEach((button) => button.addEventListener('click', () => {
    const amount = button.dataset.activityNav === 'next' ? 1 : -1;
    const next = new Date(state.activityDate);
    if (state.activityView === 'year') next.setUTCFullYear(next.getUTCFullYear() + amount);
    else if (state.activityView === 'month') next.setUTCMonth(next.getUTCMonth() + amount, 1);
    else next.setUTCDate(next.getUTCDate() + amount * (state.activityView === 'week' ? 7 : 1));
    state.activityDate = next;
    renderActivityCalendar();
  }));
  document.querySelectorAll('[data-activity-date]').forEach((button) => button.addEventListener('click', () => { state.activityDate = activityDateFromKey(button.dataset.activityDate); state.activityView = 'day'; renderActivityCalendar(); }));
  document.querySelectorAll('[data-activity-month]').forEach((button) => button.addEventListener('click', () => { const [year, month] = button.dataset.activityMonth.split('-'); state.activityDate = activityDateFromKey(`${year}-${String(month).padStart(2, '0')}-01`); state.activityView = 'month'; renderActivityCalendar(); }));
  document.querySelectorAll('[data-activity-day], [data-activity-slot]').forEach((button) => button.addEventListener('click', () => openActivityDayList(button.dataset.activityDay || button.dataset.activitySlot)));
  document.querySelectorAll('[data-activity-expand]').forEach((button) => button.addEventListener('click', () => { const key = button.dataset.activityExpand; state.activityExpandedSlots.has(key) ? state.activityExpandedSlots.delete(key) : state.activityExpandedSlots.add(key); renderActivityCalendar(); }));
  document.querySelectorAll('[data-activity-create]').forEach((button) => button.addEventListener('click', () => openActivityForm()));
  document.querySelector('[data-activity-groups]').addEventListener('click', () => navigate('activities-groups'));
  document.querySelector('[data-activity-toggle-filters]').addEventListener('click', () => { state.activityFiltersOpen = !state.activityFiltersOpen; renderActivityCalendar(); });
  const form = document.querySelector('#activity-filter-form');
  let searchTimer;
  form.addEventListener('input', (event) => {
    if (event.target.name !== 'keyword') return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.activityFilters[event.target.name] = event.target.value.trim(); renderActivityCalendar(); }, 300);
  });
  form.addEventListener('change', (event) => { state.activityFilters[event.target.name] = event.target.value; renderActivityCalendar(); });
  form.addEventListener('submit', (event) => { event.preventDefault(); state.activityFilters.keyword = form.keyword.value.trim(); renderActivityCalendar(); });
  document.querySelector('[data-activity-clear]').addEventListener('click', () => { state.activityFilters = { keyword: '', type: 'all', importance: '', registration: 'all' }; renderActivityCalendar(); });
  bindActivityOpeners();
}

async function renderActivityDetail() {
  const [{ activity }, participantData] = await Promise.all([
    api(`/api/activities/${state.activityDetailId}`),
    api(`/api/activities/${state.activityDetailId}/participants`),
  ]);
  const percent = Math.min(100, Math.round((activity.registrationCount / activity.capacity) * 100));
  const participants = participantData.participants.map((participant) => `<div class="activity-participant">${avatar(participant.avatarUrl, participant.name)}<div><strong>${escapeHtml(participant.name)}</strong><span>${escapeHtml(participant.grade || '身份已隐藏')} · 校园用户</span></div>${participant.id === state.user.id ? '<span class="activity-badge joined activity-participant-own">我的报名</span>' : ''}</div>`).join('');
  let action;
  if (activity.registered) {
    action = `<button class="btn btn-secondary" data-activity-registration="cancel">${icon('ticket-x')}取消报名</button>`;
  } else {
    const disabled = activity.capabilities.canRegister ? '' : 'disabled';
    const label = activity.registrationCount >= activity.capacity ? '名额已满' : '立即报名';
    action = `<button class="btn btn-primary" data-activity-registration="register" ${disabled}>${icon('ticket-check')}${label}</button>`;
  }
  const editButton = activity.capabilities.canEdit ? `<button class="btn btn-secondary" data-activity-edit>${icon('pencil')}编辑</button>` : '';
  const cancelButton = activity.capabilities.canCancel ? `<button class="btn btn-danger" data-activity-cancel>${icon('calendar-x')}取消活动</button>` : '';
  const organizerBadge = activity.organizerType === 'ADMIN_GROUP' ? '<span class="activity-badge official">官方活动</span>' : '<span class="activity-badge">个人活动</span>';
  const registrationAction = activity.status === 'DRAFT' && activity.capabilities.canPublish ? `<button class="btn btn-primary" data-activity-publish>${icon('send')}发布活动</button>` : action;
  let registrationHint = '活动开始前可取消报名';
  if (activity.status === 'DRAFT') registrationHint = '草稿不会出现在活动日历中';
  else if (new Date(activity.endAt) <= new Date()) registrationHint = '活动已经结束';
  const start = activityDateParts(activity.startAt);
  const startDate = activityDateFromKey(`${start.year}-${start.month}-${start.day}`);
  const dateLabel = `${Number(start.month)} 月 ${Number(start.day)} 日 ${activityWeekdayNames[startDate.getUTCDay()]}`;
  const cancelReason = activity.cancelReason ? `<div class="activity-cancel-reason"><strong>取消原因</strong><p>${escapeHtml(activity.cancelReason)}</p></div>` : '';
  setPage(`<div class="activity-page-actions"><button class="btn btn-secondary" data-activity-back>${icon('arrow-left')}返回活动广场</button><div class="toolbar-spacer"></div><button class="btn btn-secondary" data-activity-template>${icon('copy')}以此为模板</button><button class="btn btn-secondary" data-activity-copy-link>${icon('share-2')}复制链接</button>${editButton}${cancelButton}</div><section class="panel activity-detail-hero"><div><div class="activity-card-badges">${organizerBadge}<span class="activity-badge">${activityImportanceLabel(activity.importance)}</span>${activityStatusBadge(activity)}</div><span class="activity-detail-eyebrow">CAMPUS EVENT</span><h2>${escapeHtml(activity.title)}</h2><p class="activity-detail-summary">${escapeHtml(activity.descriptionSummary)}</p><div class="activity-detail-meta"><span>${icon('calendar-days')}${dateLabel}</span><span>${icon('clock-3')}${activityTimeLabel(activity)}</span><span>${icon('map-pin')}${escapeHtml(activity.location)}</span><span>${icon('user-round-check')}${escapeHtml(activity.organizerName)}</span></div></div><aside class="activity-registration-panel"><div class="activity-capacity-title"><div><span>当前报名</span><br><strong>${activity.registrationCount}</strong><span> / ${activity.capacity} 人</span></div><span>还剩 ${Math.max(0, activity.capacity - activity.registrationCount)} 个名额</span></div><div class="activity-capacity"><span><i style="width:${percent}%"></i></span></div>${registrationAction}<small>${registrationHint}</small></aside></section><div class="activity-detail-grid"><section class="panel activity-description"><h3>${icon('notebook-text')}活动介绍</h3><div class="markdown-body">${activity.descriptionHtml || '<p>暂无介绍</p>'}</div>${cancelReason}</section><aside class="panel activity-participants"><div class="section-heading"><div><h2>${icon('users')}已报名同学</h2><p>仅展示可见的最小身份信息</p></div><span class="activity-badge">${activity.registrationCount} 人</span></div>${participants || '<p class="field-hint">暂时还没有人报名</p>'}</aside></div>`);
  document.querySelector('[data-activity-back]').addEventListener('click', () => { history.pushState({}, '', '/activities'); navigate('activities-calendar'); });
  document.querySelector('[data-activity-template]').addEventListener('click', () => openActivityForm(null, activity.id));
  document.querySelector('[data-activity-copy-link]').addEventListener('click', async () => {
    const text = window.location.href;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        copied = await navigator.clipboard.writeText(text).then(() => true, () => false);
      }
      if (!copied && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
        try {
          const item = new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }) });
          copied = await navigator.clipboard.write([item]).then(() => true, () => false);
        } catch { copied = false; }
      }
      if (!copied) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.append(textarea);
        try {
          textarea.select();
          textarea.setSelectionRange(0, text.length);
          copied = document.execCommand('copy'); // NOSONAR -- fallback when browsers reject the async Clipboard API
        } finally { textarea.remove(); }
      }
      if (!copied) throw new Error('copy failed');
      toast('活动链接已复制');
    } catch { toast('复制链接失败', 'error'); }
  });
  document.querySelector('[data-activity-edit]')?.addEventListener('click', () => openActivityForm(activity.id));
  document.querySelector('[data-activity-publish]')?.addEventListener('click', async () => {
    try { await api(`/api/activities/${activity.id}/publish`, { method: 'POST', body: JSON.stringify({ version: activity.version }) }); toast('活动已发布'); await renderActivityDetail(); } catch (error) { toast(error.message, 'error'); }
  });
  document.querySelector('[data-activity-registration]')?.addEventListener('click', async (event) => {
    const cancel = event.currentTarget.dataset.activityRegistration === 'cancel';
    try { await api(`/api/activities/${activity.id}${cancel ? '/registration' : '/register'}`, { method: cancel ? 'DELETE' : 'POST', body: cancel ? undefined : '{}' }); toast(cancel ? '已取消报名' : '报名成功'); await renderActivityDetail(); } catch (error) { toast(error.message, 'error'); }
  });
  document.querySelector('[data-activity-cancel]')?.addEventListener('click', () => showCancelActivity(activity));
}

function showCancelActivity(activity) {
  const modal = openModal('取消活动', `<form id="activity-cancel-form"><p>取消后活动不能恢复，已有报名记录会保留用于审计。</p><div class="form-field"><label>取消原因</label><textarea name="reason" maxlength="500" ${activity.registrationCount ? 'required' : ''}></textarea></div><label class="checkbox-row"><input type="checkbox" name="confirmed" required>我确认取消该活动</label><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>返回</button><button class="btn btn-danger">${icon('calendar-x')}确认取消</button></div></form>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('#activity-cancel-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api(`/api/activities/${activity.id}/cancel`, { method: 'POST', body: JSON.stringify({ version: activity.version, confirmed: true, reason: event.currentTarget.reason.value }) });
      closeModal(); toast('活动已取消'); await renderActivityDetail();
    } catch (error) { toast(error.message, 'error'); }
  });
}

async function activityFormCatalog() {
  let groups;
  if (state.user.isSuperAdmin) {
    groups = (await api('/api/admin/student-selection-groups')).groups
      .filter((group) => group.owner_type === 'SUPER_ADMIN')
      .map((group) => ({ ...group, owned: group.created_by === state.user.id }));
  } else groups = (await api('/api/student-selection-groups')).groups;
  let organizerGroups = [];
  let grades = state.user.gradeId ? [{ id: state.user.gradeId, name: state.user.grade }] : [];
  if (state.user.isSuperAdmin) {
    const [adminGroups, gradeData] = await Promise.all([api('/api/admin/admin-groups'), api('/api/admin/grades')]);
    organizerGroups = adminGroups.groups.filter((group) => group.status === 'ACTIVE').map((group) => ({ ...group, gradeIds: group.scopes.filter((scope) => scope.scope_type === 'GRADE').map((scope) => Number(scope.scope_value)) }));
    grades = gradeData.grades;
  } else if (state.user.canManage) {
    const gradeData = await api('/api/admin/grades');
    grades = gradeData.grades;
    organizerGroups = state.user.groups.filter((group) => group.permissions.includes('ACTIVITY_PUBLISH'));
  }
  return { groups, organizerGroups, grades };
}

async function openActivityForm(editId = null, templateId = null) {
  state.activityEditId = editId;
  state.activityTemplateId = templateId;
  const templateQuery = templateId ? `?template=${templateId}` : '';
  history.pushState({}, '', editId ? `/activities/${editId}/edit` : `/activities/new${templateQuery}`);
  await navigate('activities-form');
}

async function renderActivityForm() { // NOSONAR
  const catalog = await activityFormCatalog();
  let source = null;
  let templateNotice = '';
  if (state.activityEditId) source = (await api(`/api/activities/${state.activityEditId}`)).activity;
  else if (state.activityTemplateId) {
    source = (await api(`/api/activities/${state.activityTemplateId}/copy`, { method: 'POST', body: '{}' })).template;
    templateNotice = `<div class="activity-template-note">${icon('copy-check')}<div><strong>正在以“${escapeHtml(source.title)}”为模板</strong><p>已复制公开配置；主办者、报名人员和原活动状态不会复制。</p></div><button type="button" class="btn btn-sm btn-secondary" data-activity-clear-template>清除模板</button></div>`;
  }
  const defaultStart = new Date();
  defaultStart.setHours(defaultStart.getHours() + 1, 0, 0, 0);
  const defaultEnd = new Date(defaultStart.getTime() + 90 * 60000);
  const selectedGradeIds = new Set(source?.targetGradeIds || (state.user.gradeId ? [state.user.gradeId] : []));
  const selectedGroupIds = new Set(source?.targetGroupIds || source?.targetGroups?.map((group) => group.source_group_id).filter(Boolean) || []);
  const selectedOrganizer = source?.organizerType === 'ADMIN_GROUP' ? String(source.organizerGroupId || '') : '';
  const canPersonal = state.user.accountType === 'USER';
  const personalOption = canPersonal ? '<option value="">个人活动</option>' : '';
  const organizerGroupOptions = catalog.organizerGroups.map((group) => `<option value="${group.id}" ${String(group.id) === selectedOrganizer ? 'selected' : ''}>官方 · ${escapeHtml(group.name)}</option>`).join('');
  const organizerOptions = personalOption + organizerGroupOptions;
  const gradeTargets = catalog.grades.map((grade) => `<label data-activity-grade="${grade.id}"><input type="checkbox" name="targetGradeIds" value="${grade.id}" ${selectedGradeIds.has(grade.id) ? 'checked' : ''}><span>${escapeHtml(grade.name)}</span></label>`).join('');
  const manageGroupsButton = state.user.accountType === 'USER' ? `<button type="button" class="btn btn-secondary" data-manage-activity-groups>${icon('settings-2')}管理我的群组</button>` : '';
  const groupTargets = catalog.groups.map((group) => `<label><input type="checkbox" name="targetGroupIds" value="${group.id}" ${selectedGroupIds.has(group.id) ? 'checked' : ''}><span><strong>${escapeHtml(group.name)}</strong><small>${group.members.length} 人 · ${group.owned ? '我的群组' : '管理员共享'}</small></span></label>`).join('') || '<p class="field-hint">暂无可用群组</p>';
  const importanceOptions = [1, 2, 3, 4, 5].map((level) => `<label><input type="radio" name="importance" value="${level}" ${level === (source?.importance || 1) ? 'checked' : ''}><span>${['I', 'II', 'III', 'IV', 'V'][level - 1]}</span></label>`).join('');
  const formStatus = source?.status === 'PUBLISHED' ? '编辑活动' : '草稿';
  const publishLabel = source?.status === 'PUBLISHED' ? '保存修改' : '发布活动';
  const draftButton = source?.status !== 'PUBLISHED' ? `<button class="btn btn-secondary" type="submit" name="intent" value="draft">${icon('save')}保存草稿</button>` : '';
  setPage(`<div class="activity-page-actions"><button class="btn btn-secondary" data-activity-form-back>${icon('arrow-left')}返回活动广场</button><div class="toolbar-spacer"></div><span class="status-badge status-pending">${icon('file-pen-line')}${formStatus}</span></div><form id="activity-form" class="activity-form-layout"><section class="panel activity-form-main">${templateNotice}<div class="activity-form-section"><h2>基本信息</h2><div class="form-field"><label>活动名称</label><input name="title" maxlength="80" required value="${escapeHtml(source?.title || '')}" placeholder="例如：新生学习经验分享会"></div><div class="form-field"><label>活动介绍 · 支持 Markdown</label><textarea name="descriptionMarkdown" maxlength="5000" rows="8" placeholder="介绍活动内容和到场须知">${escapeHtml(source?.descriptionMarkdown || '')}</textarea><p class="field-hint">内容将通过服务端安全 Markdown 管线渲染。</p></div></div><div class="activity-form-section"><h2>时间与地点</h2><label class="checkbox-row"><input type="checkbox" name="isAllDay" ${source?.isAllDay ? 'checked' : ''}>全天活动</label><div class="form-grid"><div class="form-field"><label>开始时间</label><input type="datetime-local" name="startAt" required value="${activityDateTimeInput(source?.startAt || defaultStart)}"></div><div class="form-field"><label>结束时间</label><input type="datetime-local" name="endAt" required value="${activityDateTimeInput(source?.endAt || defaultEnd)}"></div><div class="form-field full"><label>活动地点</label><input name="location" maxlength="120" required value="${escapeHtml(source?.location || '')}" placeholder="例如：大学生活动中心 203"></div></div></div><div class="activity-form-section"><h2>主办与目标人群</h2><div class="form-field"><label>活动主办方</label><select name="organizerGroupId" ${state.activityEditId ? 'disabled' : ''}>${organizerOptions}</select></div><div class="form-field"><label>目标年级</label><div class="activity-target-grid" id="activity-grade-targets">${gradeTargets}</div></div><div class="form-field"><div class="section-heading"><div><label>目标群组</label><p>年级与群组成员取并集，发布时固定成员快照</p></div>${manageGroupsButton}</div><div class="activity-target-groups">${groupTargets}</div></div></div><div class="activity-form-section"><h2>报名与展示</h2><div class="form-grid"><div class="form-field"><label>活动容量</label><input type="number" name="capacity" min="1" max="500" required value="${source?.capacity || 60}"><p class="field-hint">1–500 人</p></div><div class="form-field"><label>重要程度</label><div class="activity-importance-options">${importanceOptions}</div><p class="field-hint">可选级别由当前主办方权限决定。</p></div></div></div></section><aside class="panel activity-publish-panel"><h2>发布检查</h2><div class="activity-check-row"><span class="activity-check">✓</span><span>名称和介绍将在提交时校验</span></div><div class="activity-check-row"><span class="activity-check">✓</span><span>结束时间必须晚于开始时间</span></div><div class="activity-check-row"><span class="activity-check">✓</span><span>至少选择一个年级或群组</span></div><div class="activity-check-row"><span class="activity-check">✓</span><span>容量与重要程度符合权限</span></div><button class="btn btn-primary" type="submit" name="intent" value="publish">${icon('send')}${publishLabel}</button>${draftButton}<button type="button" class="btn btn-secondary" data-activity-preview>${icon('eye')}预览</button><p class="field-hint">发布后活动会立即出现在目标人群的活动广场；草稿仅在详情页可见。</p></aside></form>`);
  const form = document.querySelector('#activity-form');
  const updateGradeAvailability = () => {
    const organizerId = Number(form.organizerGroupId.value || 0);
    const organizer = catalog.organizerGroups.find((group) => group.id === organizerId);
    form.querySelectorAll('[data-activity-grade]').forEach((label) => {
      const input = label.querySelector('input');
      const allowed = organizer ? (state.user.isSuperAdmin || organizer.gradeIds.includes(Number(input.value))) : Number(input.value) === state.user.gradeId;
      input.disabled = !allowed;
      if (!allowed) input.checked = false;
      label.classList.toggle('disabled', !allowed);
    });
    let maxImportance = 3;
    if (organizer && (state.user.isSuperAdmin || organizer.permissions?.includes('ACTIVITY_IMPORTANCE_SET'))) maxImportance = 5;
    form.querySelectorAll('[name="importance"]').forEach((input) => { input.disabled = Number(input.value) > maxImportance; if (input.checked && input.disabled) form.querySelector('[name="importance"][value="3"]').checked = true; });
  };
  updateGradeAvailability();
  form.organizerGroupId.addEventListener('change', updateGradeAvailability);
  document.querySelector('[data-activity-form-back]').addEventListener('click', () => { history.pushState({}, '', state.activityEditId ? `/activities/${state.activityEditId}` : '/activities'); state.activityDetailId = state.activityEditId; navigate(state.activityEditId ? 'activities-detail' : 'activities-calendar'); });
  document.querySelector('[data-manage-activity-groups]')?.addEventListener('click', () => navigate('activities-groups'));
  document.querySelector('[data-activity-clear-template]')?.addEventListener('click', () => {
    state.activityTemplateId = null;
    history.replaceState({}, '', '/activities/new');
    renderActivityForm();
  });
  document.querySelector('[data-activity-preview]').addEventListener('click', async () => {
    try { const preview = await api('/api/activities/markdown/preview', { method: 'POST', body: JSON.stringify({ content: form.descriptionMarkdown.value }) }); openModal('活动介绍预览', `<div class="markdown-body">${preview.html || '<p>暂无内容</p>'}</div>`); } catch (error) { toast(error.message, 'error'); }
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const intent = event.submitter?.value || 'draft';
    const organizerGroupId = Number(form.organizerGroupId.value || 0);
    const payload = {
      title: form.title.value,
      descriptionMarkdown: form.descriptionMarkdown.value,
      startAt: activityTimestamp(form.startAt.value),
      endAt: activityTimestamp(form.endAt.value),
      isAllDay: form.isAllDay.checked,
      location: form.location.value,
      capacity: Number(form.capacity.value),
      importance: Number(form.importance.value),
      targetGradeIds: [...form.querySelectorAll('[name="targetGradeIds"]:checked')].map((input) => Number(input.value)),
      targetGroupIds: [...form.querySelectorAll('[name="targetGroupIds"]:checked')].map((input) => Number(input.value)),
      ...(organizerGroupId ? { organizerGroupId } : {}),
    };
    try {
      let activity;
      if (state.activityEditId) {
        const result = await api(`/api/activities/${state.activityEditId}`, { method: 'PATCH', body: JSON.stringify({ ...payload, version: source.version }) });
        activity = result.activity;
      } else {
        activity = (await api('/api/activities', { method: 'POST', body: JSON.stringify(payload) })).activity;
      }
      if (intent === 'publish' && activity.status === 'DRAFT') activity = (await api(`/api/activities/${activity.id}/publish`, { method: 'POST', body: JSON.stringify({ version: activity.version }) })).activity;
      state.activityDetailId = activity.id;
      state.activityEditId = null;
      state.activityTemplateId = null;
      history.pushState({}, '', `/activities/${activity.id}`);
      toast(intent === 'draft' ? '草稿已保存' : '活动已保存');
      await navigate('activities-detail');
    } catch (error) { toast(error.message, 'error'); }
  });
}

async function activityGroupData() {
  if (state.user.isSuperAdmin) {
    const [{ groups }, { users }] = await Promise.all([api('/api/admin/student-selection-groups'), api('/api/admin/users')]);
    return { groups: groups.filter((group) => group.owner_type === 'SUPER_ADMIN').map((group) => ({ ...group, owned: true })), candidates: users.filter((user) => user.account_type === 'USER' && ['ACTIVE', 'PENDING_ACTIVATION'].includes(user.status)), admin: true };
  }
  const [{ groups }, { candidates }] = await Promise.all([api('/api/student-selection-groups'), api('/api/student-selection-groups/candidates')]);
  return { groups, candidates, admin: false };
}

async function renderActivityGroups() {
  const data = await activityGroupData();
  const groups = data.groups.map((group) => {
    const actions = group.owned ? `<div class="cell-actions"><button class="btn btn-secondary" data-edit-activity-group="${group.id}">${icon('pencil')}编辑</button><button class="btn btn-danger" data-delete-activity-group="${group.id}">${icon('trash-2')}删除</button></div>` : '';
    let visibility = '';
    if (data.admin) visibility = group.is_public ? ' · 已公开' : ' · 仅管理员';
    const badge = group.owned ? `可管理${visibility}` : '管理员共享';
    return `<section class="panel activity-group-card"><div><span class="activity-badge ${group.owned ? 'joined' : ''}">${badge}</span><h2>${escapeHtml(group.name)}</h2><p>${escapeHtml(group.description || '暂无说明')}</p><small>${group.members.map((member) => escapeHtml(member.name)).join('、')}</small></div>${actions}</section>`;
  }).join('') || emptyState('users-round', '还没有目标群组', '新建群组后可在活动表单中直接选择');
  setPage(`<div class="toolbar"><div><strong>活动目标群组</strong><div class="field-hint">个人群组仅本人可选择；管理员可决定共享群组是否公开</div></div><div class="toolbar-spacer"></div><button class="btn btn-primary" data-create-activity-group>${icon('plus')}新建群组</button></div><div class="activity-group-list">${groups}</div>`);
  document.querySelector('[data-create-activity-group]').addEventListener('click', () => showActivityGroupEditor(null, data));
  document.querySelectorAll('[data-edit-activity-group]').forEach((button) => button.addEventListener('click', () => showActivityGroupEditor(data.groups.find((group) => group.id === Number(button.dataset.editActivityGroup)), data)));
  document.querySelectorAll('[data-delete-activity-group]').forEach((button) => button.addEventListener('click', async () => {
    const group = data.groups.find((item) => item.id === Number(button.dataset.deleteActivityGroup));
    if (!window.confirm(`删除“${group.name}”？已发布活动的目标快照不会改变。`)) return;
    try {
      const options = data.admin ? { method: 'DELETE', body: JSON.stringify({ reason: '活动目标群组管理' }) } : { method: 'DELETE' };
      await api(`${data.admin ? '/api/admin' : '/api'}/student-selection-groups/${group.id}`, options);
      toast('群组已删除'); await renderActivityGroups();
    } catch (error) { toast(error.message, 'error'); }
  }));
}

function showActivityGroupEditor(group, data) {
  const memberIds = new Set(group?.members.map((member) => member.id) || []);
  if (!group && !data.admin) memberIds.add(state.user.id);
  const candidates = data.candidates.map((candidate) => {
    const currentUser = !data.admin && candidate.id === state.user.id;
    return `<div class="candidate" data-person-search-text="${escapeHtml(personSearchText(candidate))}"><input type="checkbox" name="memberIds" value="${candidate.id}" id="activity-group-member-${candidate.id}" ${memberIds.has(candidate.id) ? 'checked' : ''} ${currentUser ? 'disabled' : ''}><label for="activity-group-member-${candidate.id}">${icon('user-round')}<span>${escapeHtml(candidate.name)}${currentUser ? '（我）' : ''}<small>${escapeHtml(candidate.grade)} · ${escapeHtml(candidate.major || '-')}${currentUser ? ' · 创建者自动加入' : ''}</small></span></label></div>`;
  }).join('');
  const reason = data.admin && group ? '<div class="form-field"><label>变更原因</label><input name="reason" maxlength="200" value="活动目标群组管理" required></div>' : '';
  const publicChecked = group?.is_public ? 'checked' : '';
  const visibility = data.admin ? `<label class="checkbox-row"><input type="checkbox" name="isPublic" ${publicChecked}>公开给所有用户作为活动目标群组</label><p class="field-hint">未公开时仅管理员可维护，普通用户无法选择。</p>` : '<p class="field-hint">个人群组仅你自己可在活动表单中选择。</p>';
  const modal = openModal(group ? '编辑目标群组' : '新建目标群组', `<form id="activity-group-form"><div class="form-grid"><div class="form-field"><label>群组名称</label><input name="name" maxlength="80" required value="${escapeHtml(group?.name || '')}"></div><div class="form-field"><label>说明</label><input name="description" maxlength="500" value="${escapeHtml(group?.description || '')}"></div></div><div class="section"><div class="section-heading"><div><h2>群组成员</h2><p>展示正常或未激活学生的必要身份信息</p></div></div><div class="person-picker-tools"><div class="search-field">${icon('search')}<input data-person-search="activity-group" placeholder="按姓名搜索（也支持登录标识、年级或专业）"></div><button type="button" class="btn btn-secondary" data-select-visible="activity-group">全选当前结果</button></div><div class="candidate-grid" data-person-picker="activity-group" data-activity-group-candidates>${candidates}</div></div>${visibility}${reason}<div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary">${icon('save')}保存群组</button></div></form>`, { wide: true });
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  bindPersonSearch(modal, 'activity-group');
  modal.querySelector('#activity-group-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const memberIds = [...form.querySelectorAll('[name="memberIds"]:checked, [name="memberIds"]:disabled')].map((input) => Number(input.value));
    const body = { name: form.name.value, description: form.description.value, memberIds, ...(data.admin ? { isPublic: form.isPublic.checked } : {}), ...(data.admin && group ? { reason: form.reason.value } : {}) };
    try {
      const base = data.admin ? '/api/admin/student-selection-groups' : '/api/student-selection-groups';
      await api(group ? `${base}/${group.id}` : base, { method: group ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      closeModal(); toast('群组已保存'); await renderActivityGroups();
    } catch (error) { toast(error.message, 'error'); }
  });
}

async function loadActivityView(view) {
  if (view === 'activities-calendar') return renderActivityCalendar();
  if (view === 'activities-detail' && state.activityDetailId) return renderActivityDetail();
  if (view === 'activities-form') return renderActivityForm();
  if (view === 'activities-groups') return renderActivityGroups();
  return navigate('activities-calendar');
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

async function loadTreeholeView(view) {
  if (view === 'treehole-public') return renderTreeholePublic();
  if (view === 'treehole-mine' && state.user.accountType === 'USER') return renderMyTreehole();
  return navigate('treehole-public');
}

async function loadOfficialDormitoryView(view) {
  if (view === 'official-mine') return renderMyOfficialDormitory();
  if (view === 'official-visit') return renderOfficialDormitoryVisit();
  if (view === 'official-detail' && state.selectedOfficialDormitoryId) return renderOfficialDormitoryDetail(state.selectedOfficialDormitoryId);
  return navigate('official-mine');
}

function plainText(value) {
  return escapeHtml(value || '').replace(/\r?\n/g, '<br>');
}

function treeholeStatus(post) {
  const moderation = post.moderationStatus || post.moderation_status;
  if (moderation === 'HIDDEN') return statusBadge('已隐藏', 'hidden', 'eye-off');
  if (moderation === 'DELETED') return statusBadge('已删除', 'hidden', 'trash-2');
  if (post.visibility === 'PUBLIC') return statusBadge('已公开', 'published', 'globe-2');
  if (post.visibility === 'WITHDRAWN') return statusBadge('已撤回', 'closed', 'archive');
  if (post.reviewedAt || post.reviewed_at) return statusBadge('可公开', 'active', 'badge-check');
  return statusBadge('等待回复', 'pending', 'clock-3');
}

function treeholePublicCard(post) {
  const summarySuffix = post.summaryTruncated ? '…' : '';
  return `<article class="treehole-card" data-treehole-post="${post.id}" tabindex="0">
    <div class="treehole-card-head"><span class="treehole-symbol">${icon('trees')}</span><div><h2>${escapeHtml(post.title)}</h2><p>匿名 1 号 · 楼主</p></div></div>
    <p class="treehole-summary">${plainText(post.summary)}${summarySuffix}</p>
    <footer><span>${icon('calendar-days')}${formatDate(post.published_at)}</span><span>${icon('message-circle')}${post.comment_count} 条交流</span></footer>
  </article>`;
}

function bindTreeholeCards(container = document) {
  container.querySelectorAll('[data-treehole-post]').forEach((card) => {
    const open = () => showTreeholeDetail(Number(card.dataset.treeholePost));
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') open(); });
  });
}

async function renderTreeholePublic() {
  const data = await api('/api/treehole/posts');
  state.treeholeNextCursor = data.nextCursor;
  const createButton = data.canCreate
    ? `<button class="btn btn-primary" id="create-treehole-post">${icon('pen-line')}写一篇树洞</button>`
    : '';
  const empty = data.posts.length
    ? ''
    : emptyState('trees', '公开树洞还是空的', '收到回复的新生可以选择把成长记录匿名分享给大家');
  const loadMore = data.nextCursor
    ? `<div class="load-more"><button class="btn btn-secondary" id="load-more-treehole">${icon('chevrons-down')}查看更多</button></div>`
    : '';
  setPage(`<section class="treehole-hero"><div><span class="eyebrow">SHUDONG STORIES</span><h2>有些问题，可以先在这里慢慢说</h2><p>私密记录在收到管理员回复后，由你决定是否匿名公开。</p></div>${createButton}</section>
    <div class="treehole-grid" id="treehole-public-list">${data.posts.map(treeholePublicCard).join('')}</div>
    ${empty}
    ${loadMore}`);
  bindTreeholeCards();
  document.querySelector('#create-treehole-post')?.addEventListener('click', () => showTreeholeEditor());
  document.querySelector('#load-more-treehole')?.addEventListener('click', loadMoreTreeholePosts);
}

async function loadMoreTreeholePosts() {
  if (!state.treeholeNextCursor) return;
  const button = document.querySelector('#load-more-treehole');
  if (button) button.disabled = true;
  try {
    const data = await api(`/api/treehole/posts?cursor=${encodeURIComponent(state.treeholeNextCursor)}`);
    const fragment = document.createElement('div');
    fragment.innerHTML = data.posts.map(treeholePublicCard).join('');
    bindTreeholeCards(fragment);
    document.querySelector('#treehole-public-list').append(...fragment.children);
    state.treeholeNextCursor = data.nextCursor;
    if (!data.nextCursor) button?.remove();
    else if (button) button.disabled = false;
  } catch (error) {
    if (button) button.disabled = false;
    toast(error.message, 'error');
  }
}

async function renderMyTreehole() {
  const [{ posts }, eligibility] = await Promise.all([
    api('/api/treehole/posts/mine'),
    api('/api/treehole/posts?limit=1'),
  ]);
  const createButton = eligibility.canCreate
    ? `<button class="btn btn-primary" id="create-treehole-post">${icon('pen-line')}写一篇树洞</button>`
    : '';
  let content;
  if (posts.length) {
    content = `<div class="treehole-mine-list">${posts.map(treeholeMineCard).join('')}</div>`;
  } else {
    const title = eligibility.canCreate ? '还没有写过树洞' : '当前年级暂未开放发帖';
    const description = eligibility.canCreate ? '你的帖子会先以私密状态与管理员交流' : '仍然可以浏览和参与公开树洞';
    content = emptyState('notebook-pen', title, description);
  }
  setPage(`<div class="toolbar"><div class="field-hint">首次管理员正式回复前可以修改原文；公开后仍可撤回。</div><div class="toolbar-spacer"></div>${createButton}</div>${content}`);
  bindTreeholeCards();
  document.querySelector('#create-treehole-post')?.addEventListener('click', () => showTreeholeEditor());
}

function treeholeMineCard(post) {
  const moderationReason = post.moderation_reason ? ` · ${escapeHtml(post.moderation_reason)}` : '';
  return `<article class="panel treehole-mine-item" data-treehole-post="${post.id}" tabindex="0"><div><div class="treehole-item-status">${treeholeStatus(post)}<span>${formatDate(post.updated_at)}</span></div><h2>${escapeHtml(post.title)}</h2><p>${post.comment_count} 条交流${moderationReason}</p></div>${icon('chevron-right')}</article>`;
}

function treeholeCommentControls(comment, canReply) {
  const controls = [];
  if (canReply) {
    controls.push(
      `<button class="btn btn-quiet btn-sm" data-treehole-reply="${comment.id}">${icon('reply')}回复</button>`,
      `<button class="btn btn-quiet btn-sm" data-treehole-report-comment="${comment.id}">${icon('flag')}举报</button>`,
    );
  }
  if (comment.canDelete) {
    controls.push(`<button class="btn btn-quiet btn-sm" data-treehole-delete-comment="${comment.id}">${icon('trash-2')}删除</button>`);
  }
  return controls.join('');
}

function treeholeReplyMarkup(reply) {
  const unavailable = reply.moderationStatus !== 'NORMAL';
  const officialClass = reply.isOfficial ? 'official' : '';
  const landlord = reply.aliasNumber === 1 ? ' · 楼主' : '';
  const officialLabel = reply.isOfficial ? '<span class="official-label">管理员</span>' : '';
  const content = unavailable ? '<span class="field-hint">该内容已不可见</span>' : plainText(reply.content);
  const canReply = state.user.accountType === 'USER' && !unavailable;
  const controls = treeholeCommentControls(reply, canReply);
  return `<article class="treehole-comment ${officialClass}"><header><strong>匿名 ${reply.aliasNumber} 号${landlord}</strong>${officialLabel}<span class="reply-target">回复匿名 ${reply.replyToAliasNumber} 号</span><time>${formatDate(reply.createdAt)}</time></header><p>${content}</p><div class="treehole-comment-actions">${controls}</div></article>`;
}

function treeholeCommentMarkup(comment, replies) {
  const unavailable = comment.moderationStatus !== 'NORMAL';
  const officialClass = comment.isOfficial ? 'official' : '';
  const landlord = comment.aliasNumber === 1 ? ' · 楼主' : '';
  const officialLabel = comment.isOfficial ? '<span class="official-label">管理员</span>' : '';
  const content = unavailable ? '<span class="field-hint">该内容已不可见</span>' : plainText(comment.content);
  const canReply = state.user.accountType === 'USER' && !unavailable;
  const controls = treeholeCommentControls(comment, canReply);
  const replyList = replies.length ? `<div class="treehole-replies">${replies.map(treeholeReplyMarkup).join('')}</div>` : '';
  return `<article class="treehole-comment ${officialClass}">
    <header><strong>匿名 ${comment.aliasNumber} 号${landlord}</strong>${officialLabel}<time>${formatDate(comment.createdAt)}</time></header>
    <p>${content}</p><div class="treehole-comment-actions">${controls}</div>
    ${replyList}
  </article>`;
}

function treeholeDiscussion(post) {
  const roots = post.comments.filter((comment) => !comment.parentCommentId);
  return roots.map((comment) => treeholeCommentMarkup(
    comment,
    post.comments.filter((reply) => reply.parentCommentId === comment.id),
  )).join('');
}

async function showTreeholeDetail(postId) {
  try {
    const { post } = await api(`/api/treehole/posts/${postId}`);
    const canComment = state.user.accountType === 'USER' && post.moderationStatus === 'NORMAL' && post.visibility !== 'WITHDRAWN';
    const actions = [];
    if (post.canEdit) actions.push(`<button class="btn btn-secondary" data-treehole-edit>${icon('pencil')}编辑</button>`);
    if (post.canPublish) actions.push(`<button class="btn btn-primary" data-treehole-publish>${icon('globe-2')}匿名公开</button>`);
    if (post.canWithdraw) actions.push(`<button class="btn btn-secondary" data-treehole-withdraw>${icon('archive')}撤回</button>`);
    if (state.user.accountType === 'USER' && post.moderationStatus === 'NORMAL') {
      actions.push(`<button class="btn btn-quiet" data-treehole-report-post>${icon('flag')}举报</button>`);
    }
    const postContent = post.contentHtml == null
      ? `<div class="treehole-unavailable">${icon('eye-off')}<p>${escapeHtml(post.moderationReason || '该内容当前不可见')}</p></div>`
      : `<div class="treehole-body">${post.contentHtml}</div>`;
    const discussion = treeholeDiscussion(post) || '<p class="field-hint">还没有交流内容</p>';
    const commentForm = canComment
      ? `<form id="treehole-comment-form" class="treehole-comment-form"><label for="treehole-comment-content">写下你的想法</label><textarea id="treehole-comment-content" name="content" maxlength="2000" required></textarea><button class="btn btn-primary">${icon('send')}发表评论</button></form>`
      : '';
    const detail = `<article class="treehole-detail"><header><div>${treeholeStatus(post)}<span class="treehole-author">匿名 1 号 · 楼主</span></div><time>${formatDate(post.createdAt)}</time></header>${postContent}<div class="detail-actions">${actions.join('')}</div></article>`;
    const discussionSection = `<section class="treehole-discussion"><div class="section-heading"><div><h2>交流</h2><p>${post.comments.length} 条评论与回复</p></div></div>${discussion}${commentForm}</section>`;
    const modal = openModal(post.title || '树洞帖子', detail + discussionSection, { wide: true });
    modal.querySelector('[data-treehole-edit]')?.addEventListener('click', () => showTreeholeEditor(post));
    modal.querySelector('[data-treehole-publish]')?.addEventListener('click', async () => {
      if (!window.confirm('公开后，正文和已有交流会一起匿名展示。确定公开吗？')) return;
      try { await api(`/api/treehole/posts/${postId}/publish`, { method: 'POST', body: '{}' }); closeModal(); toast('帖子已匿名公开'); await navigate(state.view); } catch (error) { toast(error.message, 'error'); }
    });
    modal.querySelector('[data-treehole-withdraw]')?.addEventListener('click', async () => {
      if (!window.confirm('撤回后帖子会从公开树洞消失，但已经公开过的内容可能已被阅读。确定撤回吗？')) return;
      try { await api(`/api/treehole/posts/${postId}/withdraw`, { method: 'POST', body: '{}' }); closeModal(); toast('帖子已撤回'); await navigate(state.view); } catch (error) { toast(error.message, 'error'); }
    });
    modal.querySelector('[data-treehole-report-post]')?.addEventListener('click', () => showReportModal('TREEHOLE_POST', postId));
    modal.querySelector('#treehole-comment-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      try { await api(`/api/treehole/posts/${postId}/comments`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); await showTreeholeDetail(postId); toast('评论已发布'); } catch (error) { toast(error.message, 'error'); }
    });
    modal.querySelectorAll('[data-treehole-reply]').forEach((button) => button.addEventListener('click', () => showTreeholeReply(Number(button.dataset.treeholeReply), postId)));
    modal.querySelectorAll('[data-treehole-report-comment]').forEach((button) => button.addEventListener('click', () => showReportModal('TREEHOLE_COMMENT', Number(button.dataset.treeholeReportComment))));
    modal.querySelectorAll('[data-treehole-delete-comment]').forEach((button) => button.addEventListener('click', async () => {
      if (!window.confirm('删除后原文不能恢复，确定删除吗？')) return;
      try { await api(`/api/treehole/comments/${button.dataset.treeholeDeleteComment}`, { method: 'DELETE' }); await showTreeholeDetail(postId); toast('评论已删除'); } catch (error) { toast(error.message, 'error'); }
    }));
  } catch (error) { toast(error.message, 'error'); }
}

function showTreeholeReply(commentId, postId) {
  const modal = openModal('回复匿名参与者', `<form id="treehole-reply-form"><div class="form-field"><label>回复内容</label><textarea name="content" maxlength="2000" required></textarea></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary">${icon('send')}发布回复</button></div></form>`);
  modal.querySelector('[data-cancel]').addEventListener('click', () => showTreeholeDetail(postId));
  modal.querySelector('#treehole-reply-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await api(`/api/treehole/comments/${commentId}/replies`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); await showTreeholeDetail(postId); toast('回复已发布'); } catch (error) { toast(error.message, 'error'); }
  });
}

function showTreeholeEditor(post = null) {
  const modal = openModal(post ? '编辑树洞' : '写一篇树洞', `<form id="treehole-editor"><div class="form-grid"><div class="form-field full"><label>标题</label><input name="title" minlength="2" maxlength="80" value="${escapeHtml(post?.title || '')}" required></div><div class="form-field full"><div class="field-label-row"><label for="treehole-editor-content">正文</label><button type="button" class="btn btn-quiet btn-sm" data-treehole-preview>${icon('eye')}预览</button></div><textarea id="treehole-editor-content" name="content" minlength="10" maxlength="5000" rows="10" required>${escapeHtml(post?.content || '')}</textarea><div class="treehole-body treehole-markdown-preview" data-treehole-preview-area hidden></div><span class="field-hint">支持常用 Markdown（标题、列表、引用、表格、代码和链接），不会执行 HTML 或图片。请不要填写姓名、联系方式等可识别身份的信息。帖子会先以私密状态与管理员交流。</span></div></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary">${icon('save')}${post ? '保存修改' : '发布私密帖'}</button></div></form>`, { wide: true });
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  const editor = modal.querySelector('#treehole-editor');
  const contentInput = editor.querySelector('[name="content"]');
  const previewButton = editor.querySelector('[data-treehole-preview]');
  const previewArea = editor.querySelector('[data-treehole-preview-area]');
  previewButton.addEventListener('click', () => {
    if (previewButton.dataset.previewing === 'true') {
      previewArea.hidden = true;
      contentInput.hidden = false;
      previewButton.innerHTML = `${icon('eye')}预览`;
      previewButton.dataset.previewing = 'false';
      return;
    }
    previewButton.disabled = true;
    api('/api/treehole/markdown/preview', { method: 'POST', body: JSON.stringify({ content: contentInput.value }) })
      .then(({ html }) => {
        previewArea.innerHTML = html;
        previewArea.hidden = false;
        contentInput.hidden = true;
        previewButton.innerHTML = `${icon('pencil')}返回编辑`;
        previewButton.dataset.previewing = 'true';
      })
      .catch((error) => toast(error.message, 'error'))
      .finally(() => { previewButton.disabled = false; });
  });
  editor.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const target = post ? `/api/treehole/posts/${post.id}` : '/api/treehole/posts';
      await api(target, { method: post ? 'PATCH' : 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      closeModal(); toast(post ? '帖子已更新' : '私密帖已发布'); await navigate('treehole-mine');
    } catch (error) { toast(error.message, 'error'); }
  });
}

function officialDormitoryMember(member) { // NOSONAR
  if (!member.visible) {
    return `<article class="official-member-card unavailable ${member.role === 'LEADER' ? 'leader' : ''}">${icon('user-round-x')}<strong>${member.leaderPending ? '宿舍长待管理员处理' : '成员信息暂不可见'}</strong>${member.role === 'LEADER' && !member.leaderPending ? '<span>宿舍长</span>' : ''}</article>`;
  }
  let genderClass = '';
  if (member.gender === 'FEMALE') genderClass = 'gender-female';
  else if (member.gender === 'MALE') genderClass = 'gender-male';
  const cardAttribute = member.cardId ? `data-card-id="${member.cardId}" tabindex="0"` : '';
  const cardStatus = member.cardId ? escapeHtml(member.introduction || '查看室友卡片') : '尚未发布卡片';
  return `<article class="official-member-card ${genderClass} ${member.role === 'LEADER' ? 'leader' : ''}" ${cardAttribute}>
    <div class="official-member-head">${avatar(member.avatarUrl, member.name)}<div><h3>${escapeHtml(member.name)}</h3><p>${escapeHtml(member.grade)} · ${escapeHtml(member.major || '-')}</p></div></div>
    <p>${escapeHtml(cardStatus)}</p>
    <footer>${member.role === 'LEADER' ? statusBadge('宿舍长', 'active', 'crown') : statusBadge('宿舍成员', 'open', 'user-round')}${member.isOwnCard ? statusBadge('我的卡片', 'published', 'contact-round') : ''}</footer>
  </article>`;
}

function officialDormitoryContentCard(title, iconName, summary, truncated, hidden) { // NOSONAR
  const content = hidden // NOSONAR
    ? `<div class="official-content-hidden">${icon('eye-off')}<span>该内容暂不可见</span></div>`
    : `<p class="official-content-summary ${summary ? '' : 'field-hint'}">${escapeHtml(summary || '还没有填写内容')}${truncated ? '…' : ''}</p>`;
  return `<article class="official-content-card panel" data-official-content="${title}" role="button" tabindex="0"><header>${icon(iconName)}<h2>${title}</h2></header>${content}</article>`;
}

function officialDormitoryDetailMarkup(dormitory, showBack = false) { // NOSONAR
  const actions = dormitory.canEdit
    ? `<button class="btn btn-primary" data-edit-official-dormitory>${icon('pencil')}共同编辑</button>${dormitory.canTransferLeader ? `<button class="btn btn-secondary" data-transfer-official-leader>${icon('crown')}转让宿舍长</button>` : ''}` // NOSONAR
    : '';
  return `${showBack ? `<button class="btn btn-quiet official-back" data-official-back>${icon('arrow-left')}返回宿舍列表</button>` : ''}
    <section class="official-dormitory-hero panel"><div><span class="eyebrow">OFFICIAL DORMITORY</span><h2>${escapeHtml(dormitory.displayName)}</h2><p>${dormitory.memberCount} 名正式成员 · 最近更新于 ${formatDate(dormitory.updatedAt)}</p></div><div class="detail-actions">${dormitory.isMine ? statusBadge('我的宿舍', 'published', 'house-heart') : ''}${actions}</div></section>
    <div class="official-content-grid">
      ${officialDormitoryContentCard('宿舍简介', 'notebook-text', dormitory.descriptionSummary, dormitory.descriptionSummaryTruncated, dormitory.descriptionHidden)}
      ${officialDormitoryContentCard('宿舍公约', 'scroll-text', dormitory.rulesSummary, dormitory.rulesSummaryTruncated, dormitory.rulesHidden)}
    </div>
    <section class="section official-member-section"><div class="section-heading"><div><h2>宿舍成员</h2><p>宿舍长以皇冠和深色卡片标识</p></div></div><div class="official-member-grid">${dormitory.members.map(officialDormitoryMember).join('')}</div></section>
    <section class="official-garden panel"><div>${icon('sprout')}<div><h2>后花园</h2><p>每个宿舍自己的静态主页将在后续开放</p></div></div><button class="btn btn-secondary" disabled>建设中</button></section>`;
}

function bindOfficialDormitoryDetail(dormitory) {
  document.querySelectorAll('.official-member-card[data-card-id]').forEach((card) => {
    const open = () => showCardDetail(Number(card.dataset.cardId));
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') open(); });
  });
  document.querySelectorAll('[data-official-content]').forEach((card) => {
    const open = () => {
      const title = card.dataset.officialContent;
      const hidden = title === '宿舍简介' ? dormitory.descriptionHidden : dormitory.rulesHidden;
      const html = title === '宿舍简介' ? dormitory.descriptionHtml : dormitory.rulesHtml;
      openModal(title, hidden ? `<div class="official-content-hidden">${icon('eye-off')}该内容暂不可见</div>` : `<div class="treehole-body">${html || '<p class="field-hint">还没有填写内容</p>'}</div>`, { wide: true }); // NOSONAR
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') open(); });
  });
  document.querySelector('[data-edit-official-dormitory]')?.addEventListener('click', () => showOfficialDormitoryEditor(dormitory));
  document.querySelector('[data-transfer-official-leader]')?.addEventListener('click', () => showOfficialLeaderTransfer(dormitory));
}

async function renderMyOfficialDormitory() { // NOSONAR
  const { dormitories } = await api('/api/official-dormitories/mine');
  if (!dormitories.length) {
    setPage(`<section class="official-dormitory-hero panel"><div><span class="eyebrow">SUDE STORIES</span><h2>共同建设我们的宿舍</h2><p>学校正式宿舍名单导入后，这里会出现你的宿舍。</p></div></section>${emptyState('house-heart', '还没有正式宿舍', '你仍然可以去赛博串门看看其他宿舍', `<button class="btn btn-primary" data-go-official-visit>${icon('door-open')}去串门</button>`)}`);
    document.querySelector('[data-go-official-visit]').addEventListener('click', () => navigate('official-visit'));
    return;
  }
  const savedId = Number(localStorage.getItem('official-dormitory-id'));
  let selectedId = dormitories[0].id;
  if (dormitories.some((item) => item.id === savedId)) selectedId = savedId;
  if (state.selectedOfficialDormitoryId && dormitories.some((item) => item.id === state.selectedOfficialDormitoryId)) {
    selectedId = state.selectedOfficialDormitoryId;
  }
  state.selectedOfficialDormitoryId = selectedId;
  localStorage.setItem('official-dormitory-id', String(selectedId));
  const { dormitory } = await api(`/api/official-dormitories/${selectedId}`);
  const selector = dormitories.length > 1
    ? `<label class="official-dormitory-selector">切换我的宿舍<select id="official-dormitory-selector">${dormitories.map((item) => `<option value="${item.id}" ${item.id === selectedId ? 'selected' : ''}>${escapeHtml(item.displayName)}</option>`).join('')}</select></label>` // NOSONAR
    : '';
  setPage(`${selector}${officialDormitoryDetailMarkup(dormitory)}`);
  document.querySelector('#official-dormitory-selector')?.addEventListener('change', (event) => {
    state.selectedOfficialDormitoryId = Number(event.target.value);
    renderMyOfficialDormitory();
  });
  bindOfficialDormitoryDetail(dormitory);
}

function officialDormitoryVisitCard(dormitory) {
  const memberAvatars = dormitory.members.map((member) => member.visible
    ? avatar(member.avatarUrl, member.name, 'avatar-sm')
    : `<span class="avatar avatar-sm official-hidden-avatar">${icon('user-round-x')}</span>`).join('');
  const suffix = dormitory.descriptionSummaryTruncated ? '…' : '';
  return `<article class="official-visit-card panel" data-official-dormitory-id="${dormitory.id}" tabindex="0"><header><div><span>${escapeHtml(dormitory.dormitoryCode)}</span><h2>${escapeHtml(dormitory.displayName)}</h2></div>${dormitory.isMine ? statusBadge('我的宿舍', 'published', 'house-heart') : ''}</header><p>${escapeHtml(dormitory.descriptionSummary || '这个宿舍还没有填写简介')}${suffix}</p><footer><div class="official-member-avatars">${memberAvatars}</div><span>${dormitory.memberCount} 名成员</span></footer></article>`;
}

function bindOfficialVisitCards(root = document) {
  root.querySelectorAll('[data-official-dormitory-id]').forEach((card) => {
    const open = () => {
      state.selectedOfficialDormitoryId = Number(card.dataset.officialDormitoryId);
      history.pushState({}, '', `/sude/dormitories/${state.selectedOfficialDormitoryId}`);
      navigate('official-detail');
    };
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') open(); });
  });
}

async function renderOfficialDormitoryVisit() {
  const params = new URLSearchParams();
  if (state.officialDormitorySearch) params.set('search', state.officialDormitorySearch);
  const data = await api(`/api/official-dormitories?${params}`);
  state.officialDormitoryNextCursor = data.nextCursor;
  const loadMore = data.nextCursor ? `<div class="load-more"><button class="btn btn-secondary" data-load-more-official>${icon('chevrons-down')}查看更多</button></div>` : '';
  setPage(`<section class="treehole-hero"><div><span class="eyebrow">CYBER VISITING</span><h2>去其他宿舍串个门</h2><p>这里只展示成员愿意在站内公开的资料。</p></div></section><div class="toolbar"><form class="search-field" id="official-dormitory-search">${icon('search')}<input name="search" maxlength="80" value="${escapeHtml(state.officialDormitorySearch)}" placeholder="搜索宿舍编号、昵称或成员姓名"></form></div>${data.dormitories.length ? `<div class="official-visit-grid" id="official-visit-grid">${data.dormitories.map(officialDormitoryVisitCard).join('')}</div>${loadMore}` : emptyState('door-closed', '没有匹配的宿舍', '换一个关键词再试试')}`); // NOSONAR
  document.querySelector('#official-dormitory-search').addEventListener('submit', (event) => {
    event.preventDefault();
    state.officialDormitorySearch = new FormData(event.currentTarget).get('search').trim();
    renderOfficialDormitoryVisit();
  });
  bindOfficialVisitCards();
  document.querySelector('[data-load-more-official]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const originalLabel = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `${icon('loader-circle')}加载中`;
    refreshIcons();
    try {
      params.set('cursor', state.officialDormitoryNextCursor);
      const next = await api(`/api/official-dormitories?${params}`);
      const container = document.querySelector('#official-visit-grid');
      container.insertAdjacentHTML('beforeend', next.dormitories.map(officialDormitoryVisitCard).join(''));
      bindOfficialVisitCards(container);
      state.officialDormitoryNextCursor = next.nextCursor;
      if (!next.nextCursor) button.closest('.load-more').remove();
      else { button.disabled = false; button.innerHTML = originalLabel; refreshIcons(); }
    } catch (error) { button.disabled = false; button.innerHTML = originalLabel; refreshIcons(); toast(error.message, 'error'); }
  });
}

async function renderOfficialDormitoryDetail(dormitoryId) {
  const { dormitory } = await api(`/api/official-dormitories/${dormitoryId}`);
  setPage(officialDormitoryDetailMarkup(dormitory, true));
  bindOfficialDormitoryDetail(dormitory);
  document.querySelector('[data-official-back]').addEventListener('click', () => {
    history.pushState({}, '', '/sude');
    navigate(dormitory.isMine ? 'official-mine' : 'official-visit');
  });
}

function showOfficialDormitoryEditor(dormitory) {
  const modal = openModal('共同编辑宿舍', `<form id="official-dormitory-editor"><div class="form-grid"><div class="form-field full"><label>宿舍昵称</label><input name="nickname" maxlength="20" value="${escapeHtml(dormitory.nickname || '')}" ${dormitory.nicknameHidden ? 'disabled' : ''}></div><div class="form-field full"><div class="field-label-row"><label>宿舍简介</label><button type="button" class="btn btn-quiet btn-sm" data-preview-official="description">${icon('eye')}预览</button></div><textarea name="description" maxlength="2000" rows="7" ${dormitory.descriptionHidden ? 'disabled' : ''}>${escapeHtml(dormitory.descriptionMarkdown || '')}</textarea><div class="treehole-body treehole-markdown-preview" data-official-preview-area="description" hidden></div></div><div class="form-field full"><div class="field-label-row"><label>宿舍公约</label><button type="button" class="btn btn-quiet btn-sm" data-preview-official="rules">${icon('eye')}预览</button></div><textarea name="rules" maxlength="5000" rows="9" ${dormitory.rulesHidden ? 'disabled' : ''}>${escapeHtml(dormitory.rulesMarkdown || '')}</textarea><div class="treehole-body treehole-markdown-preview" data-official-preview-area="rules" hidden></div></div><div class="field-hint full">简介和公约支持安全 Markdown；原始 HTML 和图片不会渲染。若内容被管理员隐藏，需要管理员恢复后才能修改。</div></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary">${icon('save')}保存修改</button></div></form>`, { wide: true }); // NOSONAR
  const form = modal.querySelector('#official-dormitory-editor');
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelectorAll('[data-preview-official]').forEach((button) => button.addEventListener('click', async () => {
    const field = button.dataset.previewOfficial;
    const input = form.elements[field];
    const preview = form.querySelector(`[data-official-preview-area="${field}"]`);
    if (!preview.hidden) {
      preview.hidden = true; input.hidden = false; button.innerHTML = `${icon('eye')}预览`; refreshIcons(); return;
    }
    button.disabled = true;
    try {
      const result = await api('/api/official-dormitories/markdown/preview', { method: 'POST', body: JSON.stringify({ field, content: input.value }) });
      preview.innerHTML = result.html;
      preview.hidden = false; input.hidden = true; button.innerHTML = `${icon('pencil')}返回编辑`;
    } catch (error) { toast(error.message, 'error'); }
    finally { button.disabled = false; refreshIcons(); }
  }));
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = { version: dormitory.version };
    for (const field of ['nickname', 'description', 'rules']) if (!form.elements[field].disabled) body[field] = form.elements[field].value;
    try {
      await api(`/api/official-dormitories/${dormitory.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      closeModal(); toast('宿舍内容已更新');
      if (state.view === 'official-detail') await renderOfficialDormitoryDetail(dormitory.id);
      else await renderMyOfficialDormitory();
    } catch (error) { toast(error.message, 'error'); }
  });
}

function showOfficialLeaderTransfer(dormitory) { // NOSONAR
  const candidates = dormitory.members.filter((member) => member.visible && member.memberId && !member.isOwnCard);
  const modal = openModal('转让宿舍长', `<form id="official-leader-transfer"><p>转让成功后，你会立即失去宿舍长身份。请选择新的宿舍长：</p><div class="form-field"><select name="targetMemberId" required><option value="">请选择舍友</option>${candidates.map((member) => `<option value="${member.memberId}">${escapeHtml(member.name)}</option>`).join('')}</select></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary">${icon('crown')}确认转让</button></div></form>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('#official-leader-transfer').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!window.confirm('确定要立即转让宿舍长身份吗？')) return;
    try {
      await api(`/api/official-dormitories/${dormitory.id}/leader-transfer`, { method: 'POST', body: JSON.stringify({ targetMemberId: Number(event.currentTarget.targetMemberId.value), version: dormitory.version }) });
      closeModal(); toast('宿舍长已转让'); await renderMyOfficialDormitory();
    } catch (error) { toast(error.message, 'error'); }
  });
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
  let nextOffset = cards.length;
  const loadedCardIds = new Set(cards.map((card) => card.id));
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
      params.set('offset', String(nextOffset));
      const nextPage = await api(`/api/roommate-cards?${params}`);
      nextOffset += nextPage.cards.length;
      total = nextPage.total;
      const newCards = nextPage.cards.filter((card) => !loadedCardIds.has(card.id));
      newCards.forEach((card) => loadedCardIds.add(card.id));
      cards.push(...newCards);
      grid.insertAdjacentHTML('beforeend', newCards.map(roommateCard).join(''));
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
      <div class="form-field full"><label>举报原因</label><select name="reason" required><option value="">请选择</option><option>人身攻击</option><option>隐私泄露</option><option>不当内容</option><option>广告或诈骗</option><option>骚扰行为</option><option>身份信息异常</option><option>其他</option></select></div>
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

async function renderMessages({ preserveSelection = false } = {}) {
  const { conversations } = await api('/api/conversations');
  const selectedExists = conversations.some((conversation) => conversation.id === state.selectedConversationId);
  if (!selectedExists && !preserveSelection) {
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
  document.querySelector('[data-chat-back]')?.addEventListener('click', async () => {
    state.selectedConversationId = null;
    state.applicationDormitoryId = null;
    await renderMessages({ preserveSelection: true });
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

function adminOfficialDormitoryRows(dormitories, selectable) {
  return dormitories.map((dormitory) => {
    const memberNames = dormitory.members.map((member) => `${member.role === 'LEADER' ? '宿舍长：' : ''}${member.name}${member.leaderPending ? '（待管理员处理）' : ''}`).join('、');
    const checkbox = selectable ? `<td><input type="checkbox" data-official-select="${dormitory.id}" aria-label="选择宿舍 ${escapeHtml(dormitory.dormitory_code)}"></td>` : '';
    return `<tr>${checkbox}<td><strong>${escapeHtml(dormitory.dormitory_code)}</strong><div class="field-hint">${escapeHtml(dormitory.nickname || '尚未设置昵称')}</div></td><td>${escapeHtml(dormitory.management_grade)}</td><td>${escapeHtml(memberNames)}<div class="field-hint">${dormitory.member_count}/4 人</div></td><td>${formatDate(dormitory.updated_at)}</td><td><button class="btn btn-secondary btn-sm" data-admin-official-detail="${dormitory.id}">${icon('eye')}查看</button></td></tr>`;
  }).join('');
}

async function renderAdminOfficialDormitories(search = state.adminOfficialDormitorySearch, offset = state.adminOfficialDormitoryOffset) { // NOSONAR
  const canRead = hasPermission('OFFICIAL_DORMITORY_READ');
  const canImport = hasPermission('OFFICIAL_DORMITORY_IMPORT');
  state.adminOfficialDormitorySearch = search;
  state.adminOfficialDormitoryOffset = Math.max(0, offset);
  let list = canImport
    ? emptyState('shield-check', '当前仅开放导入功能', '如需查看正式宿舍，请为管理员组授予正式宿舍读取权限')
    : emptyState('shield-alert', '缺少正式宿舍读取权限', '成员纠正和内容治理需要与正式宿舍读取权限一同授予');
  let total = 0;
  if (canRead) {
    const query = new URLSearchParams({ search, offset: String(state.adminOfficialDormitoryOffset), limit: '30' });
    const data = await api(`/api/admin/official-dormitories?${query}`);
    total = data.total;
    if (data.dormitories.length) {
      const selectAll = state.user.isSuperAdmin ? '<th><input type="checkbox" id="select-all-official-dormitories" aria-label="选择本页全部宿舍"></th>' : '';
      list = `<div class="table-wrap"><table class="data-table"><thead><tr>${selectAll}<th>宿舍</th><th>管理年级</th><th>成员</th><th>更新时间</th><th></th></tr></thead><tbody>${adminOfficialDormitoryRows(data.dormitories, state.user.isSuperAdmin)}</tbody></table></div><div class="admin-pagination"><button class="btn btn-secondary" data-admin-official-page="previous" ${state.adminOfficialDormitoryOffset ? '' : 'disabled'}>${icon('chevron-left')}上一页</button><span>第 ${state.adminOfficialDormitoryOffset + 1}–${Math.min(state.adminOfficialDormitoryOffset + data.dormitories.length, total)} 条，共 ${total} 条</span><button class="btn btn-secondary" data-admin-official-page="next" ${state.adminOfficialDormitoryOffset + data.dormitories.length < total ? '' : 'disabled'}>下一页${icon('chevron-right')}</button></div>`;
    } else {
      list = emptyState('house-heart', '没有匹配的正式宿舍', search ? '换一个关键词再试试' : '导入学校确认的正式宿舍名单后会显示在这里');
    }
    state.adminOfficialDormitories = data.dormitories;
  }
  const batchDelete = canRead && state.user.isSuperAdmin && total ? `<button class="btn btn-danger" id="batch-delete-official-dormitories" disabled>${icon('trash-2')}<span>批量删除</span></button>` : '';
  const searchForm = canRead ? `<form class="search-field" id="admin-official-search">${icon('search')}<input name="search" maxlength="80" value="${escapeHtml(search)}" placeholder="搜索宿舍编号、昵称或成员姓名"></form>` : '';
  const importButton = canImport ? `<button class="btn btn-primary" id="import-official-dormitories">${icon('file-up')}导入正式宿舍</button>` : '';
  setPage(`<div class="toolbar">${searchForm}<div class="toolbar-spacer"></div>${batchDelete}${importButton}</div>${list}`);
  document.querySelector('#admin-official-search')?.addEventListener('submit', (event) => {
    event.preventDefault();
    renderAdminOfficialDormitories(new FormData(event.currentTarget).get('search').trim(), 0);
  });
  document.querySelector('#import-official-dormitories')?.addEventListener('click', showOfficialDormitoryImport);
  const selectedInputs = [...document.querySelectorAll('[data-official-select]')];
  const selectAll = document.querySelector('#select-all-official-dormitories');
  const batchDeleteButton = document.querySelector('#batch-delete-official-dormitories');
  const updateBatchSelection = () => {
    const selectedCount = selectedInputs.filter((input) => input.checked).length;
    const selectedCountLabel = selectedCount ? `（${selectedCount}）` : '';
    batchDeleteButton.disabled = selectedCount === 0;
    batchDeleteButton.querySelector('span').textContent = `批量删除${selectedCountLabel}`;
    selectAll.checked = selectedCount === selectedInputs.length;
    selectAll.indeterminate = selectedCount > 0 && selectedCount < selectedInputs.length;
  };
  selectedInputs.forEach((input) => input.addEventListener('change', updateBatchSelection));
  selectAll?.addEventListener('change', () => {
    selectedInputs.forEach((input) => { input.checked = selectAll.checked; });
    updateBatchSelection();
  });
  batchDeleteButton?.addEventListener('click', () => {
    const selectedIds = selectedInputs.filter((input) => input.checked).map((input) => Number(input.dataset.officialSelect));
    showOfficialDormitoryBatchDeletion(selectedIds, state.adminOfficialDormitories);
  });
  document.querySelectorAll('[data-admin-official-detail]').forEach((button) => button.addEventListener('click', () => showAdminOfficialDormitoryDetail(Number(button.dataset.adminOfficialDetail))));
  document.querySelectorAll('[data-admin-official-page]').forEach((button) => button.addEventListener('click', () => {
    const nextOffset = button.dataset.adminOfficialPage === 'next'
      ? state.adminOfficialDormitoryOffset + 30 : Math.max(0, state.adminOfficialDormitoryOffset - 30);
    renderAdminOfficialDormitories(state.adminOfficialDormitorySearch, nextOffset);
  }));
}

function showOfficialDormitoryBatchDeletion(dormitoryIds, dormitories) {
  const selected = dormitories.filter((dormitory) => dormitoryIds.includes(dormitory.id));
  const codes = selected.map((dormitory) => dormitory.dormitory_code).join('、');
  const modal = openModal(`批量删除 ${dormitoryIds.length} 个正式宿舍`, `<form id="batch-delete-official-dormitories-form"><p>将永久删除以下正式宿舍、成员关系和内容修订：${escapeHtml(codes)}</p><p class="field-hint">该操作在一个事务内完成，不会影响自由选宿舍数据。</p><div class="form-field"><label>输入“批量删除”确认</label><input name="confirmation" autocomplete="off" required></div><div class="form-field"><label>删除原因</label><textarea name="reason" maxlength="200" required></textarea></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-danger">${icon('trash-2')}永久删除 ${dormitoryIds.length} 个宿舍</button></div></form>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try {
      const result = await api('/api/admin/official-dormitories/batch-delete', { method: 'POST', body: JSON.stringify({ dormitoryIds, ...values }) });
      closeModal(); toast(`已永久删除 ${result.deleted} 个正式宿舍`);
      const nextOffset = dormitoryIds.length === dormitories.length && state.adminOfficialDormitoryOffset
        ? Math.max(0, state.adminOfficialDormitoryOffset - 30) : state.adminOfficialDormitoryOffset;
      await renderAdminOfficialDormitories(state.adminOfficialDormitorySearch, nextOffset);
    } catch (error) { toast(error.message, 'error'); }
  });
}

function showOfficialDormitoryImport() {
  const modal = openModal('导入正式宿舍名单', `<form id="official-dormitory-import"><div class="form-field"><label>Excel 名单</label><input type="file" name="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required><span class="field-hint">仅接受不超过 2 MiB 的 .xlsx。固定表头依次为：宿舍编号、成员1登录标识（宿舍长）、成员2登录标识、成员3登录标识、成员4登录标识。所有单元格须为文本。</span></div><div id="official-import-preview"></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary" type="submit">${icon('scan-search')}预检名单</button></div></form>`, { wide: true });
  const form = modal.querySelector('#official-dormitory-import');
  form.querySelector('[data-cancel]').addEventListener('click', closeModal);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = form.elements.file.files[0];
    if (!file) return;
    const bytes = await file.arrayBuffer();
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const preview = await api('/api/admin/official-dormitories/import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-File-Name': 'official-dormitories.xlsx' },
        body: bytes,
      });
      form.querySelector('#official-import-preview').innerHTML = `<section class="official-import-preview"><div class="round-metrics"><span>有效行 <strong>${preview.rowCount}</strong></span><span>将创建 <strong>${preview.createCount}</strong></span><span>幂等跳过 <strong>${preview.skipCount}</strong></span></div><div class="table-wrap"><table class="data-table"><thead><tr><th>行</th><th>宿舍</th><th>年级</th><th>成员</th><th>动作</th></tr></thead><tbody>${preview.rows.map((row) => `<tr><td>${row.rowNumber}</td><td>${escapeHtml(row.dormitoryCode)}</td><td>${escapeHtml(row.grade)}</td><td>${escapeHtml(row.members.join('、'))}</td><td>${row.action === 'CREATE' ? statusBadge('创建', 'open', 'plus') : statusBadge('跳过', 'pending', 'check')}</td></tr>`).join('')}</tbody></table></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-reselect>重新选择</button><button type="button" class="btn btn-primary" data-confirm-import>${icon('upload')}确认导入</button></div></section>`;
      form.querySelector(':scope > .modal-actions').hidden = true;
      form.querySelector('[data-reselect]').addEventListener('click', () => {
        form.querySelector('#official-import-preview').innerHTML = '';
        form.querySelector(':scope > .modal-actions').hidden = false;
        submit.disabled = false;
      });
      form.querySelector('[data-confirm-import]').addEventListener('click', async (event) => {
        event.currentTarget.disabled = true;
        try {
          const result = await api('/api/admin/official-dormitories/import/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-File-Name': 'official-dormitories.xlsx', 'X-File-SHA256': preview.sha256 },
            body: bytes,
          });
          closeModal();
          toast(`导入完成：创建 ${result.created} 个，跳过 ${result.skipped} 个`);
          if (hasPermission('OFFICIAL_DORMITORY_READ')) await renderAdminOfficialDormitories('', 0);
        } catch (error) { toast(error.message, 'error'); event.currentTarget.disabled = false; }
      });
      refreshIcons();
    } catch (error) { toast(error.message, 'error'); submit.disabled = false; }
  });
}

function officialModerationControls(dormitory) { // NOSONAR
  if (!hasScopedPermission('OFFICIAL_DORMITORY_MODERATE', dormitory.management_grade_id)) return '';
  const fields = [['nickname', '宿舍昵称'], ['description', '宿舍简介'], ['rules', '宿舍公约']];
  return `<section class="section"><div class="section-heading"><div><h2>内容治理</h2><p>隐藏可恢复原内容，重置会清空内容并保留修订记录</p></div></div><div class="official-moderation-grid">${fields.map(([field, label]) => {
    const hidden = dormitory[`${field}_status`] === 'HIDDEN';
    return `<div><strong>${label}</strong>${statusBadge(hidden ? '已隐藏' : '正常', hidden ? 'closed' : 'active')}<div class="cell-actions"><button class="btn btn-secondary btn-sm" data-official-moderate="${field}:${hidden ? 'RESTORE' : 'HIDE'}">${icon(hidden ? 'eye' : 'eye-off')}${hidden ? '恢复' : '隐藏'}</button><button class="btn btn-danger btn-sm" data-official-moderate="${field}:RESET">${icon('eraser')}重置</button></div></div>`;
  }).join('')}</div></section>`;
}

async function showAdminOfficialDormitoryDetail(dormitoryId) { // NOSONAR
  const { dormitory } = await api(`/api/admin/official-dormitories/${dormitoryId}`);
  const canUpdate = hasScopedPermission('OFFICIAL_DORMITORY_MEMBER_UPDATE', dormitory.management_grade_id);
  const revisions = dormitory.revisions.length
    ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>字段</th><th>版本</th><th>编辑者</th><th>时间</th></tr></thead><tbody>${dormitory.revisions.map((item) => `<tr><td>${escapeHtml(item.field_name)}</td><td>${item.from_version} → ${item.to_version}</td><td>${escapeHtml(item.editor_name_snapshot)}</td><td>${formatDate(item.created_at)}</td></tr>`).join('')}</tbody></table></div>`
    : '<p class="field-hint">暂无内容修订记录</p>';
  const modal = openModal(`正式宿舍 ${dormitory.dormitory_code}`, `<div class="official-admin-detail"><div class="detail-header"><div><h2>${escapeHtml(dormitory.dormitory_code)}${dormitory.nickname ? ` · ${escapeHtml(dormitory.nickname)}` : ''}</h2><p>${escapeHtml(dormitory.members[0]?.grade || '')} · 版本 ${dormitory.version}</p></div><div class="detail-actions">${canUpdate ? `<button class="btn btn-secondary" data-correct-official-members>${icon('users')}纠正成员</button>` : ''}${state.user.isSuperAdmin ? `<button class="btn btn-danger" data-delete-official>${icon('trash-2')}永久删除</button>` : ''}</div></div><section class="section"><div class="section-heading"><h2>正式成员</h2></div><div class="member-list">${dormitory.members.map((member) => `<div class="member-row"><div><strong>${escapeHtml(member.name)}</strong><span>${escapeHtml(member.grade)} · ${escapeHtml(member.major || '-')} · ${escapeHtml(member.loginIdentifier)}${member.importedLoginIdentifier !== member.loginIdentifier ? ` · 导入时：${escapeHtml(member.importedLoginIdentifier)}` : ''}</span></div>${member.leaderPending ? statusBadge('宿舍长待处理', 'pending', 'triangle-alert') : member.role === 'LEADER' ? statusBadge('宿舍长', 'published', 'crown') : ''}</div>`).join('')}</div></section><section class="section"><div class="section-heading"><h2>宿舍简介</h2></div><div class="treehole-body">${dormitory.descriptionHtml || '<p class="field-hint">尚未填写</p>'}</div></section><section class="section"><div class="section-heading"><h2>宿舍公约</h2></div><div class="treehole-body">${dormitory.rulesHtml || '<p class="field-hint">尚未填写</p>'}</div></section>${officialModerationControls(dormitory)}<section class="section"><div class="section-heading"><h2>内容修订</h2></div>${revisions}</section></div>`, { wide: true });
  modal.querySelector('[data-correct-official-members]')?.addEventListener('click', () => showOfficialMemberCorrection(dormitory));
  modal.querySelector('[data-delete-official]')?.addEventListener('click', () => showOfficialDormitoryDeletion(dormitory));
  modal.querySelectorAll('[data-official-moderate]').forEach((button) => button.addEventListener('click', () => {
    const [field, action] = button.dataset.officialModerate.split(':');
    showOfficialContentModeration(dormitory, field, action);
  }));
}

function showOfficialMemberCorrection(dormitory) { // NOSONAR
  const modal = openModal(`纠正 ${dormitory.dormitory_code} 的成员`, `<form id="official-member-correction" class="form-grid"><div class="form-field full"><label>成员登录标识（第一位为宿舍长）</label><textarea name="identifiers" rows="5" required>${escapeHtml(dormitory.members.map((member) => member.loginIdentifier).join('\n'))}</textarea><span class="field-hint">每行一个登录标识，共 1–4 人。提交后会替换完整成员名单。</span></div><div class="form-field"><label>输入宿舍编号确认</label><input name="confirmation" autocomplete="off" required></div><div class="form-field"><label>纠正原因</label><input name="reason" maxlength="200" required></div><div class="form-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-danger">${icon('users')}确认替换成员</button></div></form>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const loginIdentifiers = values.identifiers.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    try {
      await api(`/api/admin/official-dormitories/${dormitory.id}/members`, { method: 'PUT', body: JSON.stringify({ loginIdentifiers, confirmation: values.confirmation, reason: values.reason, version: dormitory.version }) });
      closeModal(); toast('正式宿舍成员已更新'); await renderAdminOfficialDormitories();
    } catch (error) { toast(error.message, 'error'); }
  });
}

function showOfficialContentModeration(dormitory, field, action) { // NOSONAR
  const fieldLabels = { nickname: '宿舍昵称', description: '宿舍简介', rules: '宿舍公约' };
  const actionLabels = { HIDE: '隐藏', RESTORE: '恢复', RESET: '重置' };
  const modal = openModal(`${actionLabels[action]}${fieldLabels[field]}`, `<form id="official-content-moderation"><p>${action === 'RESET' ? '重置会清空当前内容，此操作不能通过“恢复”撤销。' : `${actionLabels[action]}后将立即影响学生端展示。`}</p><div class="form-field"><label>操作原因</label><textarea name="reason" maxlength="200" required></textarea></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn ${action === 'RESET' ? 'btn-danger' : 'btn-primary'}">确认${actionLabels[action]}</button></div></form>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api(`/api/admin/official-dormitories/${dormitory.id}/content-moderation`, { method: 'POST', body: JSON.stringify({ field, action, reason: new FormData(event.currentTarget).get('reason') }) });
      closeModal(); toast(`已${actionLabels[action]}${fieldLabels[field]}`); await renderAdminOfficialDormitories();
    } catch (error) { toast(error.message, 'error'); }
  });
}

function showOfficialDormitoryDeletion(dormitory) {
  const modal = openModal(`永久删除 ${dormitory.dormitory_code}`, `<form id="delete-official-dormitory"><p>将永久删除正式宿舍、成员关系和内容修订。该操作不会影响自由选宿舍数据。</p><div class="form-field"><label>输入宿舍编号确认</label><input name="confirmation" autocomplete="off" required></div><div class="form-field"><label>删除原因</label><textarea name="reason" maxlength="200" required></textarea></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-danger">${icon('trash-2')}永久删除</button></div></form>`);
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api(`/api/admin/official-dormitories/${dormitory.id}`, { method: 'DELETE', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
      closeModal(); toast('正式宿舍已永久删除'); await renderAdminOfficialDormitories();
    } catch (error) { toast(error.message, 'error'); }
  });
}

async function loadAdminView(view) {
  if (view === 'overview') return renderAdminOverview();
  if (view === 'users') return renderAdminUsers();
  if (view === 'cards') return renderAdminCards();
  if (view === 'treehole-replies') return renderAdminTreeholeReplies();
  if (view === 'treehole-content') return renderAdminTreeholeContent();
  if (view === 'official-dormitories') return renderAdminOfficialDormitories();
  if (view === 'rounds') return renderAdminRounds();
  if (view === 'groups') return renderAdminGroups();
  if (view === 'reports') return renderAdminReports();
  if (view === 'audit') return renderAdminAudit();
  if (view === 'access') return renderAdminAccess();
  return navigate('overview');
}

function adminTreeholeReplyCard(post) {
  const status = post.reviewed_at
    ? statusBadge('已回复', 'active', 'badge-check')
    : statusBadge('等待回复', 'pending', 'clock-3');
  const summarySuffix = post.summaryTruncated ? '…' : '';
  return `<article class="panel treehole-admin-item" data-admin-treehole-post="${post.id}" tabindex="0"><div class="treehole-item-status">${status}<span>${escapeHtml(post.author_name)} · ${escapeHtml(post.author_grade)} · ${formatDate(post.created_at)}</span></div><h2>${escapeHtml(post.title)}</h2><p>${escapeHtml(post.summary || '')}${summarySuffix}</p><footer>${post.comment_count} 条交流</footer></article>`;
}

function treeholeGradeOptions(grades, selectedGradeId) {
  const options = grades.map((grade) => {
    const selected = selectedGradeId === grade.id ? 'selected' : '';
    return `<option value="${grade.id}" ${selected}>${escapeHtml(grade.name)}</option>`;
  }).join('');
  return '<option value="0">全部授权年级</option>' + options;
}

async function renderAdminTreeholeReplies(status = 'WAITING', gradeId = 0) {
  const [{ posts, nextBeforeId }, { grades }] = await Promise.all([
    api(`/api/admin/treehole/private-posts?status=${status}&grade_id=${gradeId}`),
    api('/api/admin/grades'),
  ]);
  state.treeholeAdminReplyCursor = nextBeforeId;
  const statusOptions = [
    ['ALL', '全部私密帖'],
    ['WAITING', '等待首次回复'],
    ['REVIEWED', '已回复'],
  ].map(([value, label]) => {
    const selected = status === value ? 'selected' : '';
    return `<option value="${value}" ${selected}>${label}</option>`;
  }).join('');
  const gradeOptions = treeholeGradeOptions(grades, gradeId);
  let content = emptyState('messages-square', '没有待回复的私密树洞', '这里只展示当前权限覆盖年级的帖子');
  if (posts.length) {
    const loadMore = nextBeforeId
      ? `<div class="load-more"><button class="btn btn-secondary" id="load-more-treehole-replies">${icon('chevrons-down')}查看更多</button></div>`
      : '';
    content = `<div class="treehole-admin-list" id="treehole-admin-reply-list">${posts.map(adminTreeholeReplyCard).join('')}</div>${loadMore}`;
  }
  setPage(`<div class="toolbar"><select id="treehole-reply-status">${statusOptions}</select><select id="treehole-reply-grade">${gradeOptions}</select></div>${content}`);
  const rerender = () => renderAdminTreeholeReplies(
    document.querySelector('#treehole-reply-status').value,
    Number(document.querySelector('#treehole-reply-grade').value),
  );
  document.querySelector('#treehole-reply-status').addEventListener('change', rerender);
  document.querySelector('#treehole-reply-grade').addEventListener('change', rerender);
  document.querySelector('#load-more-treehole-replies')?.addEventListener('click', () => loadMoreAdminTreeholeReplies(status, gradeId));
  bindAdminTreeholeCards();
}

async function loadMoreAdminTreeholeReplies(status, gradeId) {
  const button = document.querySelector('#load-more-treehole-replies');
  button.disabled = true;
  try {
    const { posts, nextBeforeId } = await api(`/api/admin/treehole/private-posts?status=${status}&grade_id=${gradeId}&before_id=${state.treeholeAdminReplyCursor}`);
    document.querySelector('#treehole-admin-reply-list').insertAdjacentHTML('beforeend', posts.map(adminTreeholeReplyCard).join(''));
    state.treeholeAdminReplyCursor = nextBeforeId;
    bindAdminTreeholeCards();
    if (!nextBeforeId) button.remove();
    else button.disabled = false;
  } catch (error) { button.disabled = false; toast(error.message, 'error'); }
}

function adminTreeholeContentCard(post) {
  const status = post.content_type === 'COMMENT'
    ? statusBadge(labels.treeholeModeration[post.moderation_status], post.moderation_status.toLowerCase(), 'message-circle')
    : treeholeStatus(post);
  const title = post.content_type === 'COMMENT' ? `评论 #${post.id} · ${post.title}` : post.title;
  const summarySuffix = post.summaryTruncated ? '…' : '';
  const moderationReason = post.moderation_reason ? `<footer>${escapeHtml(post.moderation_reason)}</footer>` : '';
  return `<article class="panel treehole-admin-item" data-admin-treehole-post="${post.post_id || post.id}" tabindex="0"><div class="treehole-item-status">${status}<span>${escapeHtml(post.author_name || '已删除账号')} · ${escapeHtml(post.author_grade || '-')} · ${formatDate(post.updated_at)}</span></div><h2>${escapeHtml(title || '[已删除]')}</h2><p>${escapeHtml(post.summary || '')}${summarySuffix}</p>${moderationReason}</article>`;
}

function treeholeFilterOptions(entries, selectedValue) {
  return entries.map(([value, text]) => {
    const selected = selectedValue === value ? 'selected' : '';
    return `<option value="${value}" ${selected}>${text}</option>`;
  }).join('');
}

async function renderAdminTreeholeContent(filters = {}) {
  const current = { visibility: 'ALL', moderationStatus: 'ALL', contentType: 'POST', gradeId: 0, dateFrom: '', dateTo: '', ...filters };
  const query = `visibility=${current.visibility}&moderation_status=${current.moderationStatus}&content_type=${current.contentType}&grade_id=${current.gradeId}&date_from=${current.dateFrom}&date_to=${current.dateTo}`;
  const [{ posts, nextBeforeId }, { grades }] = await Promise.all([
    api(`/api/admin/treehole/content?${query}`),
    api('/api/admin/grades'),
  ]);
  state.treeholeAdminContentCursor = nextBeforeId;
  const typeOptions = treeholeFilterOptions([['POST', '帖子'], ['COMMENT', '评论与回复']], current.contentType);
  const visibilityOptions = '<option value="ALL">全部可见性</option>'
    + treeholeFilterOptions(Object.entries(labels.treeholeVisibility), current.visibility);
  const moderationOptions = '<option value="ALL">全部治理状态</option>'
    + treeholeFilterOptions(Object.entries(labels.treeholeModeration), current.moderationStatus);
  const gradeOptions = treeholeGradeOptions(grades, current.gradeId);
  const configureButton = state.user.isSuperAdmin
    ? `<button class="btn btn-secondary" id="configure-treehole-grades">${icon('graduation-cap')}配置发帖年级</button>`
    : '';
  let content = emptyState('shield-check', '没有符合条件的树洞内容', '可以调整可见性和治理状态筛选');
  if (posts.length) {
    const loadMore = nextBeforeId
      ? `<div class="load-more"><button class="btn btn-secondary" id="load-more-treehole-content">${icon('chevrons-down')}查看更多</button></div>`
      : '';
    content = `<div class="treehole-admin-list" id="treehole-admin-content-list">${posts.map(adminTreeholeContentCard).join('')}</div>${loadMore}`;
  }
  setPage(`<div class="toolbar"><select id="treehole-content-type">${typeOptions}</select><select id="treehole-content-visibility">${visibilityOptions}</select><select id="treehole-content-moderation">${moderationOptions}</select><select id="treehole-content-grade">${gradeOptions}</select><label class="compact-date">起始日期<input type="date" id="treehole-content-from" value="${current.dateFrom}"></label><label class="compact-date">结束日期<input type="date" id="treehole-content-to" value="${current.dateTo}"></label><div class="toolbar-spacer"></div>${configureButton}</div>${content}`);
  const rerender = () => renderAdminTreeholeContent({
    contentType: document.querySelector('#treehole-content-type').value,
    visibility: document.querySelector('#treehole-content-visibility').value,
    moderationStatus: document.querySelector('#treehole-content-moderation').value,
    gradeId: Number(document.querySelector('#treehole-content-grade').value),
    dateFrom: document.querySelector('#treehole-content-from').value,
    dateTo: document.querySelector('#treehole-content-to').value,
  });
  document.querySelectorAll('#treehole-content-type,#treehole-content-visibility,#treehole-content-moderation,#treehole-content-grade,#treehole-content-from,#treehole-content-to').forEach((element) => element.addEventListener('change', rerender));
  document.querySelector('#configure-treehole-grades')?.addEventListener('click', showTreeholeGradeConfiguration);
  document.querySelector('#load-more-treehole-content')?.addEventListener('click', () => loadMoreAdminTreeholeContent(query));
  bindAdminTreeholeCards();
}

async function loadMoreAdminTreeholeContent(query) {
  const button = document.querySelector('#load-more-treehole-content');
  button.disabled = true;
  try {
    const { posts, nextBeforeId } = await api(`/api/admin/treehole/content?${query}&before_id=${state.treeholeAdminContentCursor}`);
    document.querySelector('#treehole-admin-content-list').insertAdjacentHTML('beforeend', posts.map(adminTreeholeContentCard).join(''));
    state.treeholeAdminContentCursor = nextBeforeId;
    bindAdminTreeholeCards();
    if (!nextBeforeId) button.remove();
    else button.disabled = false;
  } catch (error) { button.disabled = false; toast(error.message, 'error'); }
}

function bindAdminTreeholeCards() {
  document.querySelectorAll('[data-admin-treehole-post]').forEach((card) => {
    const open = () => showAdminTreeholeDetail(Number(card.dataset.adminTreeholePost));
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') open(); });
  });
}

function adminTreeholeComment(comment, canModerate) {
  let moderationAction = '';
  if (comment.moderationStatus === 'NORMAL') moderationAction = 'hide';
  else if (comment.moderationStatus === 'HIDDEN') moderationAction = 'restore';
  const officialClass = comment.isOfficial ? 'official' : '';
  const officialLabel = comment.isOfficial ? '<span class="official-label">管理员</span>' : '';
  const replyTarget = comment.replyToAliasNumber
    ? `<span class="reply-target">回复匿名 ${comment.replyToAliasNumber} 号</span>`
    : '';
  const content = comment.content ? plainText(comment.content) : '<span class="field-hint">该内容已删除</span>';
  const moderationReason = comment.moderationReason
    ? `<div class="field-hint">治理原因：${escapeHtml(comment.moderationReason)}</div>`
    : '';
  const actions = [];
  if (canModerate && moderationAction) {
    const actionIcon = moderationAction === 'hide' ? 'eye-off' : 'rotate-ccw';
    const actionText = moderationAction === 'hide' ? '隐藏' : '恢复';
    actions.push(`<button class="btn btn-secondary btn-sm" data-admin-comment-action="${moderationAction}" data-comment-id="${comment.id}">${icon(actionIcon)}${actionText}</button>`);
  }
  if (canModerate && comment.moderationStatus !== 'DELETED') {
    actions.push(`<button class="btn btn-danger btn-sm" data-admin-comment-action="delete" data-comment-id="${comment.id}">${icon('trash-2')}删除</button>`);
  }
  return `<article class="treehole-comment ${officialClass}"><header><strong>匿名 ${comment.aliasNumber} 号 · ${escapeHtml(comment.authorName)}</strong>${officialLabel}${replyTarget}<time>${formatDate(comment.createdAt)}</time></header><p>${content}</p>${moderationReason}<div class="treehole-comment-actions">${actions.join('')}</div></article>`;
}

function adminTreeholePostActions(post, canModerate) {
  if (!canModerate) return '';
  let postAction = '';
  if (post.moderationStatus === 'NORMAL') postAction = 'hide';
  else if (post.moderationStatus === 'HIDDEN') postAction = 'restore';
  let actions = '';
  if (postAction) {
    const actionIcon = postAction === 'hide' ? 'eye-off' : 'rotate-ccw';
    const actionText = postAction === 'hide' ? '隐藏帖子' : '恢复帖子';
    actions += `<button class="btn btn-secondary" data-admin-post-action="${postAction}">${icon(actionIcon)}${actionText}</button>`;
  }
  if (post.visibility === 'WITHDRAWN' && post.moderationStatus === 'NORMAL') {
    actions += `<button class="btn btn-secondary" data-admin-post-action="restore-withdrawn">${icon('undo-2')}恢复为私密</button>`;
  }
  if (post.moderationStatus !== 'DELETED') {
    actions += `<button class="btn btn-danger" data-admin-post-action="delete">${icon('trash-2')}删除帖子</button>`;
  }
  return actions;
}

async function showAdminTreeholeDetail(postId) {
  try {
    const { post } = await api(`/api/admin/treehole/posts/${postId}`);
    const canReply = hasScopedPermission('TREEHOLE_PRIVATE_REPLY', post.managementGradeId)
      && post.moderationStatus === 'NORMAL' && post.visibility !== 'WITHDRAWN';
    const canModerate = hasScopedPermission('TREEHOLE_MODERATE', post.managementGradeId);
    const postContent = post.contentHtml || '<span class="field-hint">正文已删除</span>';
    const moderationReason = post.moderationReason
      ? `<p class="field-hint">治理原因：${escapeHtml(post.moderationReason)}</p>`
      : '';
    const actions = adminTreeholePostActions(post, canModerate);
    const comments = post.comments.map((comment) => adminTreeholeComment(comment, canModerate)).join('')
      || '<p class="field-hint">暂无交流</p>';
    const replyForm = canReply
      ? `<form id="official-treehole-reply" class="treehole-comment-form"><label>正式管理员回复</label><textarea name="content" maxlength="2000" required></textarea><button class="btn btn-primary">${icon('send')}提交正式回复</button></form>`
      : '';
    const detail = `<article class="treehole-detail admin"><header><div>${treeholeStatus(post)}<span class="treehole-author">${escapeHtml(post.author.name)} · ${escapeHtml(post.author.grade)}</span></div><time>${formatDate(post.createdAt)}</time></header><div class="treehole-body">${postContent}</div>${moderationReason}<div class="detail-actions">${actions}</div></article>`;
    const discussion = `<section class="treehole-discussion"><div class="section-heading"><div><h2>交流记录</h2><p>管理员真实身份不会在公开树洞显示</p></div></div>${comments}${replyForm}</section>`;
    const modal = openModal(post.title || '[已删除]', detail + discussion, { wide: true });
    modal.querySelector('#official-treehole-reply')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      try { await api(`/api/admin/treehole/posts/${postId}/comments`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); await showAdminTreeholeDetail(postId); toast('正式回复已提交'); } catch (error) { toast(error.message, 'error'); }
    });
    modal.querySelectorAll('[data-admin-post-action]').forEach((button) => button.addEventListener('click', () => showTreeholeModeration('posts', postId, button.dataset.adminPostAction, postId)));
    modal.querySelectorAll('[data-admin-comment-action]').forEach((button) => button.addEventListener('click', () => showTreeholeModeration('comments', Number(button.dataset.commentId), button.dataset.adminCommentAction, postId)));
  } catch (error) { toast(error.message, 'error'); }
}

function showTreeholeModeration(targetType, targetId, action, postId) {
  const actionName = { hide: '隐藏', restore: '恢复', delete: '删除', 'restore-withdrawn': '恢复撤回状态' }[action];
  const guidance = action === 'delete' ? '删除后正文不能通过管理界面恢复。' : '操作会立即影响学生端可见状态。';
  const buttonClass = action === 'delete' ? 'btn-danger' : 'btn-primary';
  const form = `<form id="treehole-moderation-form"><p>${guidance}</p><div class="form-field"><label>操作原因</label><textarea name="reason" maxlength="200" required></textarea></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn ${buttonClass}">确认${actionName}</button></div></form>`;
  const modal = openModal(`${actionName}树洞内容`, form);
  modal.querySelector('[data-cancel]').addEventListener('click', () => showAdminTreeholeDetail(postId));
  modal.querySelector('#treehole-moderation-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await api(`/api/admin/treehole/${targetType}/${targetId}/moderation`, { method: 'POST', body: JSON.stringify({ action, reason: event.currentTarget.reason.value }) }); toast(`内容已${actionName}`); await showAdminTreeholeDetail(postId); } catch (error) { toast(error.message, 'error'); }
  });
}

async function showTreeholeGradeConfiguration() {
  try {
    const { grades } = await api('/api/admin/treehole/author-grades');
    const candidates = grades.map((grade) => {
      const checked = grade.selected ? 'checked' : '';
      const disabled = grade.status !== 'ACTIVE' ? 'disabled' : '';
      const status = grade.status === 'ACTIVE' ? '有效年级' : '已停用';
      return `<div class="candidate"><input type="checkbox" name="gradeIds" value="${grade.id}" id="treehole-grade-${grade.id}" ${checked} ${disabled}><label for="treehole-grade-${grade.id}">${icon('graduation-cap')}<span>${escapeHtml(grade.name)}<small>${status}</small></span></label></div>`;
    }).join('');
    const form = `<form id="treehole-grade-form"><p class="field-hint">配置变化只影响后续创建资格，不改变历史帖子的管理范围。</p><div class="candidate-grid">${candidates}</div><div class="form-field"><label>操作原因</label><textarea name="reason" maxlength="200" required></textarea></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary">${icon('save')}保存配置</button></div></form>`;
    const modal = openModal('配置新生发帖年级', form, { wide: true });
    modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
    modal.querySelector('#treehole-grade-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const gradeIds = [...form.querySelectorAll('input[name="gradeIds"]:checked')].map((input) => Number(input.value));
      try { await api('/api/admin/treehole/author-grades', { method: 'PUT', body: JSON.stringify({ gradeIds, reason: form.reason.value }) }); closeModal(); toast('发帖年级配置已更新'); } catch (error) { toast(error.message, 'error'); }
    });
  } catch (error) { toast(error.message, 'error'); }
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

function downloadUserExport(event) {
  return downloadExport('/api/admin/users/export', 'users.xlsx', '用户信息已导出', event.currentTarget);
}

async function downloadExport(requestUrl, fallbackFilename, successMessage, button, options = {}) {
  button.disabled = true;
  try {
    const response = await fetch(apiRequestUrl(requestUrl), {
      credentials: 'same-origin',
      ...options,
      headers: apiRequestHeaders(options),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error?.message || '导出失败，请稍后重试');
    }
    const disposition = response.headers.get('content-disposition') || '';
    const encodedFilename = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    const headerFilename = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
    const filename = encodedFilename ? decodeURIComponent(encodedFilename) : headerFilename || fallbackFilename;
    const objectUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    toast(successMessage);
    return true;
  } catch (error) {
    toast(error.message, 'error');
    return false;
  } finally {
    button.disabled = false;
  }
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
  const [{ cards }, { groups }] = await Promise.all([
    api('/api/admin/roommate-cards'),
    state.user.isSuperAdmin ? api('/api/admin/student-selection-groups') : Promise.resolve({ groups: [] }),
  ]);
  const exportButton = state.user.isSuperAdmin ? `<button class="btn btn-primary" id="export-group-cards">${icon('file-spreadsheet')}导出群组卡片</button>` : '';
  const cardRows = cards.map(adminCardRow).join('');
  setPage(`<div class="toolbar"><div class="search-field">${icon('search')}<input id="admin-card-search" placeholder="按姓名搜索"></div><div class="toolbar-spacer"></div>${exportButton}</div><div class="table-wrap"><table class="data-table"><thead><tr><th>学生</th><th>地区</th><th>起床 / 睡觉</th><th>本人整理习惯</th><th>状态</th><th>更新时间</th><th></th></tr></thead><tbody>${cardRows}</tbody></table></div>`);
  document.querySelector('#admin-card-search').addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll('tr[data-person-name]').forEach((row) => { row.hidden = query && !row.dataset.personName.includes(query); });
  });
  document.querySelector('#export-group-cards')?.addEventListener('click', () => showGroupCardExport(groups));
  document.querySelectorAll('[data-view-card]').forEach((button) => button.addEventListener('click', () => showAdminCardDetail(cards.find((card) => card.id === Number(button.dataset.viewCard)))));
  document.querySelectorAll('[data-card-action]').forEach((button) => button.addEventListener('click', () => showCardAction(Number(button.dataset.id), button.dataset.cardAction)));
}

function adminCardRow(card) {
  let moderationButton = '';
  if (hasScopedPermission('CARD_MODERATE', card.grade_id)) {
    if (card.status === 'HIDDEN') {
      moderationButton = `<button class="btn btn-secondary btn-sm" data-card-action="restore" data-id="${card.id}">${icon('rotate-ccw')}恢复</button>`;
    } else {
      moderationButton = `<button class="btn btn-danger btn-sm" data-card-action="hide" data-id="${card.id}">${icon('eye-off')}隐藏</button>`;
    }
  }
  const region = [card.origin_province, card.origin_city].filter(Boolean).join(' ') || '-';
  const statusType = card.status === 'PUBLISHED' ? 'published' : card.status.toLowerCase();
  return `<tr data-person-name="${escapeHtml(card.name.toLowerCase())}"><td><div class="cell-user">${avatar(card.avatar_url, card.name, 'avatar-sm')}<div><strong>${escapeHtml(card.name)}</strong><div class="field-hint">${escapeHtml(card.grade)} · ${escapeHtml(card.major || '-')}</div></div></div></td><td>${escapeHtml(region)}</td><td>${escapeHtml(card.wake_up_time || '-')} / ${escapeHtml(card.sleep_time || '-')}</td><td>${escapeHtml(labels.cleanliness[card.personal_cleanliness] || '-')}</td><td>${statusBadge(labels.cardStatus[card.status], statusType)}</td><td>${formatDate(card.updated_at)}</td><td><div class="cell-actions"><button class="btn btn-secondary btn-sm" data-view-card="${card.id}">${icon('eye')}查看</button>${moderationButton}</div></td></tr>`;
}

function showGroupCardExport(groups) {
  const groupOptions = groups.length ? groups.map((group) => `<div class="candidate"><input type="checkbox" name="groupIds" value="${group.id}" id="export-group-${group.id}"><label for="export-group-${group.id}">${icon('users-round')}<span>${escapeHtml(group.name)}<small>${group.members.length} 名成员</small></span></label></div>`).join('') : emptyState('users-round', '暂无预设学生群组', '请先在选宿舍轮次页面创建预设学生群组');
  const modal = openModal('导出群组卡片', `<form id="group-card-export-form"><p class="field-hint">选择需要导出的预设学生群组。重叠成员只导出一次，并注明其所属群组。</p><div class="candidate-grid">${groupOptions}</div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary" ${groups.length ? '' : 'disabled'}>${icon('file-spreadsheet')}导出 Excel</button></div></form>`, { wide: true });
  modal.querySelector('[data-cancel]').addEventListener('click', closeModal);
  modal.querySelector('#group-card-export-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const groupIds = [...form.querySelectorAll('[name="groupIds"]:checked')].map((input) => Number(input.value));
    if (!groupIds.length) {
      toast('请至少选择一个预设学生群组', 'error');
      return;
    }
    const success = await downloadExport('/api/admin/roommate-cards/export', 'selected-group-cards.xlsx', '群组卡片已导出', form.querySelector('.btn-primary'), {
      method: 'POST', body: JSON.stringify({ groupIds }),
    });
    if (success) closeModal();
  });
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
  const roundCandidates = state.roundParticipantCandidates.map((user) => `<div class="candidate" data-person-search-text="${escapeHtml(personSearchText(user))}"><input type="checkbox" name="participantIds" value="${user.id}" id="round-user-${user.id}" ${participants.has(user.id) ? 'checked' : ''}><label for="round-user-${user.id}">${icon('user-round')}<span>${escapeHtml(user.name)}<small>${escapeHtml(user.grade)} · ${escapeHtml(user.major || '-')} · ${escapeHtml(user.login_identifier)}</small></span></label></div>`).join('');
  const modal = openModal(round ? '配置选宿舍轮次' : '新建选宿舍轮次', `<form id="round-form"><div class="form-grid"><div class="form-field"><label>轮次编码</label><input name="code" maxlength="40" value="${escapeHtml(round?.code || '')}" placeholder="例如 2026_SECOND" ${round ? 'disabled' : 'required'}></div><div class="form-field"><label>轮次名称</label><input name="name" maxlength="80" value="${escapeHtml(round?.name || '')}" required></div><div class="form-field"><label>计划开始时间</label><input name="startsAt" type="datetime-local" value="${escapeHtml(round?.starts_at?.slice(0, 16) || '')}"></div><div class="form-field"><label>计划截止时间</label><input name="endsAt" type="datetime-local" value="${escapeHtml(round?.ends_at?.slice(0, 16) || '')}"></div><div class="form-field full"><label>说明</label><textarea name="description" maxlength="500">${escapeHtml(round?.description || '')}</textarea></div><div class="form-field full"><label>操作原因</label><input name="reason" maxlength="200" ${round ? 'required' : ''}></div></div><div class="section"><div class="section-heading"><div><h2>参与学生</h2><p>只有名单内学生可以在本轮创建或加入宿舍</p></div></div>${personPickerTools('round')}<div class="candidate-grid" data-person-picker="round">${roundCandidates}</div></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary">${icon('save')}${round ? '保存配置' : '创建草稿'}</button></div></form>`, { wide: true });
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
  let groupList = emptyState('users-round', '暂无预设群组', '新建群组后，可在选人界面一键添加成员');
  if (groups.length) {
    groupList = groups.map((group) => {
      let visibility = '用户个人群组';
      if (group.owner_type === 'SUPER_ADMIN') visibility = group.is_public ? '已公开共享' : '仅管理员';
      return `<section class="selection-group-item" data-selection-group-card="${group.id}"><div><strong>${escapeHtml(group.name)}</strong><span class="activity-badge">${visibility}</span><p>${escapeHtml(group.description || '暂无说明')}</p><span>${group.members.map((member) => escapeHtml(member.name)).join('、')}</span></div><div class="cell-actions"><button class="btn btn-secondary btn-sm" data-edit-selection-group="${group.id}">${icon('pencil')}编辑</button><button class="btn btn-danger btn-sm" data-delete-selection-group="${group.id}">${icon('trash-2')}删除</button></div></section>`;
    }).join('');
  }
  const modal = openModal('预设学生群组', `<div class="toolbar"><div class="search-field">${icon('search')}<input id="selection-group-search" placeholder="按成员姓名搜索（也支持登录标识、年级或专业）"></div><div class="toolbar-spacer"></div><button class="btn btn-primary" id="create-selection-group">${icon('plus')}新建群组</button></div><div class="selection-group-list">${groupList}</div>`, { wide: true });
  modal.querySelector('#selection-group-search').addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    modal.querySelectorAll('[data-selection-group-card]').forEach((card) => {
      const group = groups.find((item) => item.id === Number(card.dataset.selectionGroupCard));
      card.hidden = query && !group.members.some((member) => personSearchText(member).includes(query));
    });
  });
  modal.querySelector('#create-selection-group').addEventListener('click', () => showSelectionGroupForm());
  modal.querySelectorAll('[data-edit-selection-group]').forEach((button) => button.addEventListener('click', () => showSelectionGroupForm(groups.find((group) => group.id === Number(button.dataset.editSelectionGroup)))));
  modal.querySelectorAll('[data-delete-selection-group]').forEach((button) => button.addEventListener('click', () => showDeleteSelectionGroup(groups.find((group) => group.id === Number(button.dataset.deleteSelectionGroup)))));
}

function showSelectionGroupForm(group = null) {
  const candidates = state.selectionGroupCandidates || state.roundParticipantCandidates || [];
  const memberIds = new Set(group?.members.map((member) => member.id) || []);
  const canPublish = !group || group.owner_type === 'SUPER_ADMIN';
  const publicChecked = group?.is_public ? 'checked' : '';
  const visibility = canPublish ? `<label class="checkbox-row"><input type="checkbox" name="isPublic" ${publicChecked}>公开给所有用户作为活动目标群组</label><p class="field-hint">未公开时仅管理员可在活动中选择。</p>` : '<p class="field-hint">这是用户个人群组，只能由创建者在活动表单中选择。</p>';
  const candidateMarkup = candidates.map((user) => `<div class="candidate" data-person-search-text="${escapeHtml(personSearchText(user))}"><input type="checkbox" name="memberIds" value="${user.id}" id="selection-user-${user.id}" ${memberIds.has(user.id) ? 'checked' : ''}><label for="selection-user-${user.id}">${icon('user-round')}<span>${escapeHtml(user.name)}<small>${escapeHtml(user.grade)} · ${escapeHtml(user.major || '-')} · ${escapeHtml(user.login_identifier)}</small></span></label></div>`).join('');
  const modal = openModal(group ? '编辑预设学生群组' : '新建预设学生群组', `<form id="selection-group-form"><div class="form-grid"><div class="form-field"><label>群组名称</label><input name="name" maxlength="80" value="${escapeHtml(group?.name || '')}" required></div><div class="form-field"><label>操作原因</label><input name="reason" maxlength="200" ${group ? 'required' : ''}></div><div class="form-field full"><label>说明</label><textarea name="description" maxlength="500">${escapeHtml(group?.description || '')}</textarea></div></div><div class="section"><div class="section-heading"><div><h2>群组成员</h2><p>群组只保存学生名单，不会随使用它创建的轮次自动变化</p></div></div><div class="person-picker-tools"><div class="search-field">${icon('search')}<input data-person-search="selection-group" placeholder="按姓名搜索（也支持登录标识、年级或专业）"></div><button type="button" class="btn btn-secondary" data-select-visible="selection-group">全选当前结果</button></div><div class="candidate-grid" data-person-picker="selection-group" id="selection-group-candidates">${candidateMarkup}</div></div>${visibility}<div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>返回</button><button class="btn btn-primary">${icon('save')}${group ? '保存群组' : '创建群组'}</button></div></form>`, { wide: true });
  modal.querySelector('[data-cancel]').addEventListener('click', showSelectionGroups);
  bindPersonSearch(modal, 'selection-group');
  modal.querySelector('#selection-group-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const body = {
      name: form.name.value,
      description: form.description.value,
      reason: form.reason.value,
      memberIds: [...form.querySelectorAll('[name="memberIds"]:checked')].map((input) => Number(input.value)),
      ...(canPublish ? { isPublic: form.isPublic.checked } : {}),
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

function downloadDormitoryExport(event) {
  return downloadExport(`/api/admin/dormitories/export?roundId=${state.adminRoundId}`, 'dormitories.xlsx', '宿舍列表已导出', event.currentTarget);
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

function adminReportRow(report, targetLabels) {
  const targetLabel = targetLabels[report.target_type] || report.target_type;
  const canResolve = hasScopedPermission('REPORT_RESOLVE', report.target_grade_id) && report.status === 'PENDING';
  const resolveButton = canResolve
    ? `<button class="btn btn-primary btn-sm" data-resolve="${report.id}">${icon('check')}处理</button>`
    : '';
  return `<tr data-person-name="${escapeHtml(report.reporter_name.toLowerCase())}"><td>${escapeHtml(report.reporter_name)}</td><td>${escapeHtml(targetLabel)} #${report.target_id}</td><td><strong>${escapeHtml(report.reason)}</strong><div class="field-hint">${escapeHtml(report.description)}</div></td><td>${formatDate(report.created_at)}</td><td>${statusBadge(labels.reportStatus[report.status], report.status.toLowerCase())}</td><td>${resolveButton}</td></tr>`;
}

async function renderAdminReports() {
  const { reports } = await api('/api/admin/reports');
  const targetLabels = { ROOMMATE_CARD: '室友卡片', MESSAGE: '私信消息', TREEHOLE_POST: '树洞帖子', TREEHOLE_COMMENT: '树洞评论' };
  let content = emptyState('shield-check', '没有待处理举报', '当前没有用户提交的举报记录');
  if (reports.length) {
    const rows = reports.map((report) => adminReportRow(report, targetLabels)).join('');
    content = `<div class="toolbar"><div class="search-field">${icon('search')}<input id="report-person-search" placeholder="按举报人姓名搜索"></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>举报人</th><th>对象</th><th>原因</th><th>提交时间</th><th>状态</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  setPage(content);
  document.querySelector('#report-person-search')?.addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll('tr[data-person-name]').forEach((row) => { row.hidden = query && !row.dataset.personName.includes(query); });
  });
  document.querySelectorAll('[data-resolve]').forEach((button) => button.addEventListener('click', () => showResolveReport(reports.find((report) => report.id === Number(button.dataset.resolve)))));
}

function showResolveReport(report) {
  const snapshot = Object.entries(report.snapshot || {}).map(([key, value]) => {
    const displayValue = typeof value === 'object' ? JSON.stringify(value) : value;
    return `<div class="detail-item"><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(displayValue)}</dd></div>`;
  }).join('');
  const snapshotContent = snapshot || '<div class="field-hint">无可用快照</div>';
  const content = `<div class="section"><div class="section-heading"><div><h2>举报快照</h2><p>仅展示用户主动提交的被举报内容</p></div></div><dl class="detail-grid">${snapshotContent}</dl></div><form id="resolve-form" class="form-grid"><div class="form-field full"><label>处理结论</label><select name="status"><option value="RESOLVED">举报成立</option><option value="REJECTED">举报不成立</option></select></div><div class="form-field full"><label>处理说明</label><textarea name="resolution" required></textarea></div><div class="form-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary">${icon('check')}完成处理</button></div></form>`;
  const modal = openModal('处理举报', content, { wide: true });
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
  setPage(`<div class="toolbar"><div class="search-field">${icon('search')}<input id="admin-group-member-search" placeholder="按成员姓名搜索（也支持登录标识、年级或专业）"></div><div class="toolbar-spacer"></div><button class="btn btn-secondary" id="manage-selection-groups">${icon('users-round')}预设学生群组</button><button class="btn btn-primary" id="create-admin-group">${icon('plus')}新建管理员组</button></div><div class="field-hint toolbar-note">按年级授权时，权限和年级范围必须由同一个组提供；首页更新是全局权限，不使用年级范围。</div>
    ${groups.length ? `<div class="access-grid">${groups.map((group) => `<section class="panel access-card"><div class="section-heading"><div><h2>${escapeHtml(group.name)}</h2><p><code>${escapeHtml(group.code)}</code> · ${escapeHtml(group.description || '暂无说明')}</p></div>${statusBadge(group.status === 'ACTIVE' ? '有效' : '已停用', group.status === 'ACTIVE' ? 'active' : 'closed')}</div><dl class="access-summary"><div><dt>成员</dt><dd>${group.members.map((member) => escapeHtml(member.name)).join('、') || '未配置'}</dd></div><div><dt>年级范围</dt><dd>${group.scopes.map((scope) => escapeHtml(scope.grade_name || scope.scope_value)).join('、') || '未配置'}</dd></div><div><dt>权限</dt><dd>${group.permissions.map((code) => escapeHtml(permissions.find((item) => item.code === code)?.name || code)).join('、') || '未配置'}</dd></div></dl><button class="btn btn-secondary" data-configure-group="${group.id}">${icon('settings')}配置管理员组</button></section>`).join('')}</div>` : emptyState('shield-check', '暂无管理员组', '新建管理员组后配置成员、权限和年级范围')}`);
  document.querySelector('#create-admin-group').addEventListener('click', showCreateAdminGroup);
  document.querySelector('#manage-selection-groups').addEventListener('click', openSelectionGroupManager);
  document.querySelector('#admin-group-member-search').addEventListener('input', (event) => {
    const query = event.target.value.trim().toLowerCase();
    document.querySelectorAll('.access-card').forEach((card, index) => {
      card.hidden = query && !groups[index].members.some((member) => personSearchText(member).includes(query));
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
  const adminMemberCandidates = users.map((user) => `<div class="candidate" data-person-search-text="${escapeHtml(personSearchText(user))}"><input type="checkbox" name="userIds" value="${user.id}" id="member-${user.id}" ${memberIds.has(user.id) ? 'checked' : ''}><label for="member-${user.id}">${icon('user-round')}<span>${escapeHtml(user.name)}<small>${escapeHtml(user.grade)} · ${escapeHtml(user.major || '-')} · ${escapeHtml(user.login_identifier)}</small></span></label></div>`).join('');
  const gradeCandidates = grades.map((grade) => `<div class="candidate"><input type="checkbox" name="gradeIds" value="${grade.id}" id="grade-${grade.id}" ${gradeIds.has(grade.id) ? 'checked' : ''}><label for="grade-${grade.id}">${icon('graduation-cap')}<span>${escapeHtml(grade.name)}</span></label></div>`).join('');
  const permissionCandidates = permissions.map((permission) => `<div class="candidate"><input type="checkbox" name="permissions" value="${permission.code}" id="permission-${permission.code}" ${permissionCodes.has(permission.code) ? 'checked' : ''}><label for="permission-${permission.code}">${icon('key-round')}<span>${escapeHtml(permission.name)}<small>${escapeHtml(permission.code)}</small></span></label></div>`).join('');
  const modal = openModal('配置管理员组', `<form id="configure-group-form"><div class="form-grid"><div class="form-field"><label>组编码</label><input value="${escapeHtml(group.code)}" disabled></div><div class="form-field"><label>状态</label><select name="status"><option value="ACTIVE" ${group.status === 'ACTIVE' ? 'selected' : ''}>有效</option><option value="DISABLED" ${group.status === 'DISABLED' ? 'selected' : ''}>停用</option></select></div><div class="form-field"><label>名称</label><input name="name" value="${escapeHtml(group.name)}" maxlength="80" required></div><div class="form-field"><label>变更原因</label><input name="reason" maxlength="200" required></div><div class="form-field full"><label>说明</label><textarea name="description" maxlength="500">${escapeHtml(group.description)}</textarea></div></div><div class="section"><div class="section-heading"><div><h2>年级范围</h2><p>权限只能作用于这里选择的年级</p></div></div><div class="candidate-grid">${gradeCandidates}</div></div><div class="section"><div class="section-heading"><div><h2>权限</h2><p>只授予完成职责所需的权限</p></div></div><div class="candidate-grid">${permissionCandidates}</div></div><div class="section"><div class="section-heading"><div><h2>成员</h2><p>成员仍可使用学生端，并可切换到管理工作台</p></div></div>${personPickerTools('admin-member')}<div class="candidate-grid" data-person-picker="admin-member">${adminMemberCandidates}</div></div><div class="modal-actions"><button type="button" class="btn btn-secondary" data-cancel>取消</button><button class="btn btn-primary">${icon('save')}保存全部配置</button></div></form>`, { wide: true });
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
  } catch (error) {
    if (error.status !== 401) toast(error.message, 'error');
  }
  if (window.location.pathname === '/roommates') await enterRoommateSystem();
  else if (window.location.pathname === '/shudong') await enterTreeholeSystem();
  else if (window.location.pathname === '/sude' || /^\/sude\/dormitories\/\d+$/.test(window.location.pathname)) await enterOfficialDormitorySystem();
  else if (window.location.pathname === '/activities' || /^\/activities\/(?:new|\d+)(?:\/edit)?$/.test(window.location.pathname)) await enterActivitySystem();
  else if (window.location.pathname === '/login') {
    const continuePath = requestedNextPath();
    if (!state.user) renderLoginPage();
    else if (continuePath) {
      history.replaceState({}, '', continuePath);
      await enterRequestedPath(continuePath);
    } else {
      window.location.replace('/');
    }
  } else {
    window.location.replace('/');
  }
}

window.addEventListener('popstate', () => {
  if (window.location.pathname === '/roommates') enterRoommateSystem();
  else if (window.location.pathname === '/shudong') enterTreeholeSystem();
  else if (window.location.pathname === '/sude' || /^\/sude\/dormitories\/\d+$/.test(window.location.pathname)) enterOfficialDormitorySystem();
  else if (window.location.pathname === '/activities' || /^\/activities\/(?:new|\d+)(?:\/edit)?$/.test(window.location.pathname)) enterActivitySystem();
  else if (window.location.pathname === '/login') {
    const continuePath = requestedNextPath();
    if (!state.user) renderLoginPage();
    else if (continuePath) {
      history.replaceState({}, '', continuePath);
      enterRequestedPath(continuePath);
    } else {
      window.location.replace('/');
    }
  } else window.location.replace('/');
});

init();
