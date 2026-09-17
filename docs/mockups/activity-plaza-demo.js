const DEMO_NOW = new Date(2026, 8, 17, 9, 0);
const STORAGE_KEY = 'openshude-activity-plaza-demo-v2';
const weekNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const shortWeekNames = ['一', '二', '三', '四', '五', '六', '日'];

const baseActivities = [
  {
    id: 1, title: '新生安全教育与校园生活说明会', description: '本次说明会将介绍校园安全、宿舍生活、实验室规范和紧急联络方式，并现场解答新生常见问题。\n\n请携带校园卡，并按照学院指引分区就座。',
    start: '2026-09-17T14:00', end: '2026-09-17T15:30', location: '大学生活动中心礼堂', organizer: '学生工作处', type: 'official', importance: 5, capacity: 500, participants: 386, people: ['江晚', '叶澜', '苏晴', '唐宁', '程屿'], owner: false, status: 'PUBLISHED', targetGrade: '2026级',
  },
  {
    id: 2, title: 'AI 创作沙龙', description: '一起交流生成式 AI 在学习、设计和内容创作中的实际使用经验。',
    start: '2026-09-17T14:00', end: '2026-09-17T16:00', location: '创新工坊 A201', organizer: '计算机协会', type: 'personal', importance: 3, capacity: 60, participants: 42, people: ['林夏', '阮川', '江晚'], owner: false, status: 'PUBLISHED', targetGrade: '2026级',
  },
  {
    id: 3, title: '秋季摄影外拍', description: '从东门出发，用镜头记录初秋校园。请自备相机或手机。',
    start: '2026-09-17T14:00', end: '2026-09-17T17:30', location: '东门广场集合', organizer: '叶澜', type: 'personal', importance: 3, capacity: 20, participants: 18, people: ['林夏', '唐宁', '苏晴'], owner: false, status: 'PUBLISHED', targetGrade: '2026级',
  },
  {
    id: 4, title: '英语角特别场', description: '围绕校园生活进行轻松的英文交流，新手也可以参加。',
    start: '2026-09-17T19:00', end: '2026-09-17T20:30', location: '图书馆研讨室', organizer: '外语社', type: 'personal', importance: 3, capacity: 40, participants: 26, people: ['林夏', '程屿'], owner: false, status: 'PUBLISHED', targetGrade: '2026级',
  },
  ...[
    ['城市速写练习', '艺术楼中庭', '美术社', 25, 12],
    ['飞盘体验课', '东区操场', '飞盘社', 36, 21],
    ['桌游新手局', '学生活动室 3', '桌游社', 16, 14],
    ['模拟联合国说明会', '博学楼 205', '模联协会', 80, 45],
    ['新生辩论体验', '人文楼 102', '辩论队', 32, 19],
    ['咖啡手冲入门', '生活工坊', '生活社', 20, 20],
    ['开源项目结对', '创新工坊 B103', '开源社区', 50, 28],
    ['校园植物观察', '图书馆南门', '自然社', 24, 9],
    ['街舞公开课', '体育馆镜厅', '街舞社', 40, 37],
    ['心理健康工作坊', '学生活动中心 305', '心理中心', 30, 23],
    ['法语零基础体验', '外语楼 208', '法语社', 35, 17],
    ['乐高机器人体验', '工程训练中心', '机器人队', 28, 24],
    ['诗歌朗读会', '图书馆一楼', '文学社', 45, 13],
    ['排球新生训练', '西区球场', '排球社', 30, 29],
    ['志愿服务宣讲', '明德楼报告厅', '青年志愿者协会', 120, 88],
    ['手语体验活动', '学生活动室 1', '手语社', 25, 16],
    ['生涯探索小组', '职业发展中心', '生涯中心', 18, 11],
  ].map(([title, location, organizer, capacity, participants], index) => {
    let importance = 1;
    if (index === 14) importance = 4;
    else if (index % 5 === 0) importance = 2;
    return {
      id: index + 5, title, description: `${title}的活动介绍。欢迎感兴趣的同学报名参加。`,
      start: index % 4 === 3 ? '2026-09-17T14:30' : '2026-09-17T14:00',
      end: index % 3 === 0 ? '2026-09-17T16:30' : '2026-09-17T16:00',
      location, organizer, type: index === 14 ? 'official' : 'personal', importance,
      capacity, participants, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级',
    };
  }),
  { id: 22, title: '校园广播站开放参观', description: '参观校园广播站并体验节目制作。', start: '2026-09-17T10:00', end: '2026-09-17T11:00', location: '大学生活动中心 401', organizer: '校园广播站', type: 'personal', importance: 1, capacity: 25, participants: 17, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级' },
  { id: 23, title: '夜跑小组', description: '以轻松配速完成校园夜跑。', start: '2026-09-17T20:30', end: '2026-09-17T21:30', location: '东区操场', organizer: '跑步社', type: 'personal', importance: 1, capacity: 40, participants: 22, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级' },
  { id: 30, title: '摄影夜拍', description: '校园夜景拍摄交流。', start: '2026-09-02T19:00', end: '2026-09-02T21:00', location: '钟楼广场', organizer: '摄影社', type: 'personal', importance: 1, capacity: 30, participants: 16, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级' },
  { id: 31, title: '社团招新周', description: '在活动中心集中了解校园社团。', start: '2026-09-07T00:00', end: '2026-09-12T00:00', location: '学生活动中心', organizer: '校团委', type: 'official', importance: 4, capacity: 500, participants: 308, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级', allDay: true },
  { id: 32, title: '电影分享会', description: '一起观看和讨论经典电影片段。', start: '2026-09-08T19:30', end: '2026-09-08T21:00', location: '人文楼 104', organizer: '电影社', type: 'personal', importance: 1, capacity: 45, participants: 31, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级' },
  { id: 33, title: '飞盘体验会', description: '零基础飞盘体验。', start: '2026-09-10T18:30', end: '2026-09-10T20:00', location: '东区操场', organizer: '飞盘社', type: 'personal', importance: 2, capacity: 36, participants: 24, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级' },
  { id: 34, title: '城市漫步', description: '从校园南门出发观察城市街区。', start: '2026-09-14T16:00', end: '2026-09-14T18:00', location: '南门集合', organizer: '地理兴趣组', type: 'personal', importance: 1, capacity: 20, participants: 15, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级' },
  { id: 35, title: '开源入门工作坊', description: '从第一个 Issue 开始参与开源。', start: '2026-09-15T19:00', end: '2026-09-15T21:00', location: '创新工坊', organizer: '开源社区', type: 'personal', importance: 3, capacity: 50, participants: 38, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级' },
  { id: 36, title: '院系开放日', description: '了解不同院系的培养方向和实验室。', start: '2026-09-18T10:00', end: '2026-09-18T12:00', location: '明德楼报告厅', organizer: '教务处', type: 'official', importance: 5, capacity: 300, participants: 214, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级' },
  { id: 37, title: '乐队排练开放场', description: '观看校乐队排练并与乐手交流。', start: '2026-09-18T19:00', end: '2026-09-18T21:00', location: '音乐教室', organizer: '校乐队', type: 'personal', importance: 1, capacity: 40, participants: 29, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级' },
  { id: 38, title: '校园定向赛', description: '以小队形式完成校园定向挑战。', start: '2026-09-20T08:00', end: '2026-09-20T11:00', location: '东区操场', organizer: '体育部', type: 'official', importance: 4, capacity: 180, participants: 132, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级' },
  { id: 39, title: '读书分享夜', description: '分享最近读过的一本好书。', start: '2026-09-22T19:00', end: '2026-09-22T20:30', location: '图书馆研讨室', organizer: '读书会', type: 'personal', importance: 1, capacity: 30, participants: 22, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级' },
  { id: 40, title: '手作工坊', description: '制作简单的植物拓印书签。', start: '2026-09-24T18:30', end: '2026-09-24T20:00', location: '生活工坊', organizer: '林夏', type: 'personal', importance: 1, capacity: 24, participants: 12, people: [], owner: true, status: 'PUBLISHED', targetGrade: '2026级' },
  { id: 41, title: '篮球友谊赛', description: '面向新生的篮球友谊赛。', start: '2026-09-26T15:00', end: '2026-09-26T17:00', location: '西区篮球场', organizer: '篮球社', type: 'personal', importance: 3, capacity: 30, participants: 26, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级' },
  { id: 42, title: '英语角', description: '每月一次的英语交流活动。', start: '2026-09-29T19:00', end: '2026-09-29T20:30', location: '外语楼中庭', organizer: '外语社', type: 'personal', importance: 1, capacity: 40, participants: 25, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级' },
  { id: 43, title: '职业规划讲座', description: '从大学第一年开始认识职业方向。', start: '2026-09-30T14:00', end: '2026-09-30T16:00', location: '明德楼报告厅', organizer: '职业发展中心', type: 'official', importance: 5, capacity: 260, participants: 198, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级' },
  { id: 44, title: '元旦校园音乐会', description: '新年音乐会。', start: '2026-01-01T19:00', end: '2026-01-01T21:00', location: '大学生活动中心礼堂', organizer: '校团委', type: 'official', importance: 5, capacity: 500, participants: 450, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级' },
  { id: 45, title: '春季社团开放日', description: '春季社团集中展示。', start: '2026-03-14T09:00', end: '2026-03-14T17:00', location: '中心广场', organizer: '校团委', type: 'official', importance: 4, capacity: 500, participants: 372, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级' },
  { id: 46, title: '毕业季跳蚤市场', description: '闲置物品交换。', start: '2026-06-06T10:00', end: '2026-06-06T17:00', location: '中心广场', organizer: '生活社', type: 'personal', importance: 2, capacity: 200, participants: 126, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级' },
  { id: 47, title: '冬至包饺子', description: '一起包饺子迎接冬至。', start: '2026-12-21T17:00', end: '2026-12-21T20:00', location: '生活工坊', organizer: '后勤学生会', type: 'personal', importance: 2, capacity: 80, participants: 63, people: [], owner: false, status: 'PUBLISHED', targetGrade: '2026级' },
];

const sharedGroups = [
  { id: 'shared-1', name: '2026 级志愿服务队', description: '管理员共享群组', members: ['江晚', '叶澜', '苏晴'], owned: false },
  { id: 'shared-2', name: '新生班委联络组', description: '管理员共享群组', members: ['唐宁', '程屿'], owned: false },
];
const initialOwnGroups = [
  { id: 'own-1', name: 'AI 学习搭子', description: '一起参加技术交流活动', members: ['江晚', '阮川'], owned: true },
];
const groupCandidates = ['江晚', '阮川', '叶澜', '苏晴', '唐宁', '程屿'];

const stored = loadStoredState();
let customActivities = stored.customActivities || [];
let customGroups = stored.customGroups || initialOwnGroups.map((group) => ({ ...group, members: [...group.members] }));
let joinedIds = new Set(stored.joinedIds || [2, 3, 4, 6]);
let participantDeltas = stored.participantDeltas || {};
let state = {
  page: 'calendar', view: window.innerWidth < 768 ? 'day' : 'month', date: new Date(DEMO_NOW), detailId: null, templateId: null,
  drawer: null, filtersOpen: false, expandedSlots: new Set(), filters: { search: '', type: 'all', importance: 'all', registration: 'all' },
};

function loadStoredState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; }
}

function saveStoredState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ customActivities, customGroups, joinedIds: [...joinedIds], participantDeltas }));
}

function parseDate(value) {
  if (value instanceof Date) return new Date(value);
  const [datePart, timePart = '00:00'] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  return new Date(year, month - 1, day, hour || 0, minute || 0);
}

function dateKey(value) {
  const date = parseDate(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateTimeValue(value) {
  const date = parseDate(value);
  return `${dateKey(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function addDays(value, amount) { const date = parseDate(value); date.setDate(date.getDate() + amount); return date; }
function startOfWeek(value) { const date = parseDate(value); const weekday = (date.getDay() + 6) % 7; return addDays(date, -weekday); }
function startOfMonth(value) { const date = parseDate(value); return new Date(date.getFullYear(), date.getMonth(), 1); }
function allActivities() { return [...baseActivities, ...customActivities]; }
function allGroups() { return [...customGroups, ...sharedGroups]; }
function findActivity(id) { return allActivities().find((activity) => String(activity.id) === String(id)); }
function participantCount(activity) { return activity.participants + (participantDeltas[activity.id] || 0); }
function isJoined(activity) { return joinedIds.has(Number(activity.id)) || joinedIds.has(String(activity.id)); }
function isEnded(activity) { return parseDate(activity.end) <= DEMO_NOW; }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

function icon(name) { return `<i data-lucide="${name}"></i>`; }

function importanceLabel(level) {
  return ({ 1: 'I · 一般', 2: 'II · 关注', 3: 'III · 重要', 4: 'IV · 很重要', 5: 'V · 必须关注' })[level];
}

function timeLabel(activity) {
  if (activity.allDay) return '全天';
  const start = parseDate(activity.start);
  const end = parseDate(activity.end);
  return `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}–${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
}

function activityOverlapsDay(activity, value) {
  const dayStart = parseDate(dateKey(value));
  const dayEnd = addDays(dayStart, 1);
  return parseDate(activity.start) < dayEnd && parseDate(activity.end) > dayStart;
}

function filteredActivities() {
  const query = state.filters.search.trim().toLocaleLowerCase('zh-CN');
  return allActivities().filter((activity) => {
    if (activity.status !== 'PUBLISHED') return false;
    if (query && ![activity.title, activity.description, activity.location, activity.organizer].some((value) => value.toLocaleLowerCase('zh-CN').includes(query))) return false;
    if (state.filters.type !== 'all' && activity.type !== state.filters.type) return false;
    if (state.filters.importance !== 'all' && activity.importance !== Number(state.filters.importance)) return false;
    if (state.filters.registration === 'joined' && !isJoined(activity)) return false;
    if (state.filters.registration === 'available' && participantCount(activity) >= activity.capacity) return false;
    if (state.filters.registration === 'mine' && !activity.owner) return false;
    return true;
  });
}

function eventsForDay(value) {
  return filteredActivities().filter((activity) => activityOverlapsDay(activity, value)).sort((left, right) => {
    if (left.allDay !== right.allDay) return left.allDay ? -1 : 1;
    return parseDate(left.start) - parseDate(right.start) || right.importance - left.importance || String(right.id).localeCompare(String(left.id));
  });
}

function groupOverlappingActivities(events) {
  const groups = [];
  const sorted = [...events].sort((left, right) => parseDate(left.start) - parseDate(right.start));
  for (const activity of sorted) {
    const start = parseDate(activity.start);
    const end = parseDate(activity.end);
    const current = groups.at(-1);
    if (!current || start >= current.end) groups.push({ start, end, events: [activity] });
    else {
      current.events.push(activity);
      if (end > current.end) current.end = end;
    }
  }
  return groups;
}

function heatLevel(events) {
  const score = events.reduce((total, activity) => total + activity.importance, 0);
  if (!score) return 0;
  if (score <= 3) return 1;
  if (score <= 8) return 2;
  if (score <= 15) return 3;
  if (score <= 24) return 4;
  return 5;
}

function refreshIcons() { if (window.lucide) window.lucide.createIcons(); }

function render() {
  document.querySelector('#calendar-page').hidden = state.page !== 'calendar';
  document.querySelector('#detail-page').hidden = state.page !== 'detail';
  document.querySelector('#form-page').hidden = state.page !== 'form';
  const titles = {
    calendar: ['活动广场', '按时间发现和参加校园活动'],
    detail: ['活动详情', '查看活动安排与报名信息'],
    form: ['创建活动', '完善信息后保存草稿或发布'],
  };
  document.querySelector('#page-title').textContent = titles[state.page][0];
  document.querySelector('#page-subtitle').textContent = titles[state.page][1];
  if (state.page === 'calendar') renderCalendar();
  if (state.page === 'detail') renderDetail();
  if (state.page === 'form') renderForm();
  renderDrawer();
  refreshIcons();
}

function renderCalendar() {
  document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view));
  document.querySelector('#activity-filters').classList.toggle('open', state.filtersOpen);
  document.querySelector('[data-toggle-filters]').setAttribute('aria-expanded', String(state.filtersOpen));
  document.querySelector('#filter-search').value = state.filters.search;
  document.querySelector('#filter-type').value = state.filters.type;
  document.querySelector('#filter-importance').value = state.filters.importance;
  document.querySelector('#filter-registration').value = state.filters.registration;
  document.querySelector('#range-title').textContent = rangeTitle();
  const content = document.querySelector('#calendar-content');
  if (state.view === 'year') content.innerHTML = renderYear();
  if (state.view === 'month') content.innerHTML = renderMonth();
  if (state.view === 'week') content.innerHTML = renderWeek();
  if (state.view === 'day') content.innerHTML = renderDay();
}

function rangeTitle() {
  if (state.view === 'year') return `${state.date.getFullYear()} 年`;
  if (state.view === 'month') return `${state.date.getFullYear()} 年 ${state.date.getMonth() + 1} 月`;
  if (state.view === 'day') return `${state.date.getMonth() + 1} 月 ${state.date.getDate()} 日 · ${weekNames[state.date.getDay()]}`;
  const start = startOfWeek(state.date);
  const end = addDays(start, 6);
  return start.getMonth() === end.getMonth()
    ? `${start.getMonth() + 1} 月 ${start.getDate()} 日–${end.getDate()} 日`
    : `${start.getMonth() + 1} 月 ${start.getDate()} 日–${end.getMonth() + 1} 月 ${end.getDate()} 日`;
}

function renderYear() {
  const year = state.date.getFullYear();
  return `<div class="year-grid">${Array.from({ length: 12 }, (_, month) => renderMiniMonth(year, month)).join('')}</div>`;
}

function renderMiniMonth(year, month) {
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const count = new Date(year, month + 1, 0).getDate();
  const monthEvents = filteredActivities().filter((activity) => {
    const monthStart = new Date(year, month, 1);
    const monthEnd = new Date(year, month + 1, 1);
    return parseDate(activity.start) < monthEnd && parseDate(activity.end) > monthStart;
  });
  const cells = Array.from({ length: 42 }, (_, index) => {
    const day = index - offset + 1;
    if (day < 1 || day > count) return '<span class="mini-day outside"></span>';
    const date = new Date(year, month, day);
    const events = eventsForDay(date);
    const today = dateKey(date) === dateKey(DEMO_NOW) ? 'today' : '';
    return `<button class="mini-day heat-${heatLevel(events)} ${today}" data-date="${dateKey(date)}" data-open-view="day" aria-label="${month + 1} 月 ${day} 日，${events.length} 个活动">${day}</button>`;
  }).join('');
  return `<section class="mini-month"><div class="mini-month-head"><button data-month="${year}-${String(month + 1).padStart(2, '0')}">${month + 1} 月</button><span>${monthEvents.length} 个活动</span></div><div class="mini-weekdays">${shortWeekNames.map((name) => `<span>${name}</span>`).join('')}</div><div class="mini-days">${cells}</div></section>`;
}

function renderMonth() {
  const first = startOfMonth(state.date);
  const offset = (first.getDay() + 6) % 7;
  const gridStart = addDays(first, -offset);
  const cells = Array.from({ length: 42 }, (_, index) => {
    const date = addDays(gridStart, index);
    const events = eventsForDay(date);
    const outside = date.getMonth() !== state.date.getMonth();
    const classes = ['month-day', outside ? 'outside' : '', dateKey(date) === dateKey(state.date) ? 'selected' : '', dateKey(date) === dateKey(DEMO_NOW) ? 'today' : ''].filter(Boolean).join(' ');
    const count = events.length ? `<span class="day-total">${events.length} 个</span>` : '';
    const eventMarkup = events.slice(0, 3).map((activity) => `<div class="month-event importance-${activity.importance}"><time>${activity.allDay ? '全天' : timeLabel(activity).slice(0, 5)}</time><span>${escapeHtml(activity.title)}</span></div>`).join('');
    const more = events.length > 3 ? `<div class="month-more" data-count="${events.length}">另有 ${events.length - 3} 个活动</div>` : '';
    return `<div class="${classes}" role="button" tabindex="0" data-open-day="${dateKey(date)}" aria-label="${date.getMonth() + 1} 月 ${date.getDate()} 日，${events.length} 个活动"><div class="month-day-head"><span class="month-day-number">${date.getDate()}</span>${count}</div>${eventMarkup}${more}</div>`;
  }).join('');
  const weekdays = ['周一','周二','周三','周四','周五','周六','周日'].map((name) => `<span>${name}</span>`).join('');
  return `<section class="panel calendar-panel"><div class="calendar-weekdays">${weekdays}</div><div class="month-grid">${cells}</div></section>`;
}

function renderWeek() {
  const weekStart = startOfWeek(state.date);
  const days = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));
  const header = days.map((date) => `<div class="${dateKey(date) === dateKey(state.date) ? 'selected' : ''}"><button class="plain-button" data-date="${dateKey(date)}" data-open-view="day">${shortWeekNames[(date.getDay() + 6) % 7]}<strong>${date.getDate()}</strong></button></div>`).join('');
  const allDayByDate = days.map((date) => eventsForDay(date).filter((activity) => activity.allDay));
  const allDayRow = allDayByDate.some((events) => events.length)
    ? `<div class="week-all-day"><span>全天</span>${allDayByDate.map((events) => `<div class="all-day-cell">${events.map((activity) => `<button class="all-day-event" data-event="${activity.id}">${escapeHtml(activity.title)}</button>`).join('')}</div>`).join('')}</div>`
    : '';
  const times = Array.from({ length: 11 }, (_, index) => `<span style="top:${index * 65}px">${String(index * 2 + 6).padStart(2, '0')}:00</span>`).join('');
  const columns = days.map((date) => renderWeekColumn(date)).join('');
  return `<div class="week-scroll"><section class="panel week-calendar"><div class="week-header"><div></div>${header}</div>${allDayRow}<div class="week-body"><div class="week-times">${times}</div>${columns}</div></section></div>`;
}

function renderWeekColumn(date) {
  const groups = groupOverlappingActivities(eventsForDay(date).filter((activity) => !activity.allDay));
  let content = '';
  for (const group of groups) {
    group.events.sort((left, right) => right.importance - left.importance || parseDate(left.start) - parseDate(right.start) || String(right.id).localeCompare(String(left.id)));
    const start = group.start;
    const minutes = Math.max(0, start.getHours() * 60 + start.getMinutes() - 360);
    const top = Math.min(620, minutes / 120 * 65);
    const duration = Math.max(35, Math.min(125, (group.end - start) / 60000 / 120 * 65));
    const visible = group.events.slice(0, 2);
    content += visible.map((activity, index) => `<button class="week-event importance-${activity.importance} ${group.events.length === 1 ? 'single' : `lane-${index + 1}`}" style="top:${top}px;height:${duration}px" data-event="${activity.id}"><strong>${timeLabel(activity).slice(0, 5)} ${escapeHtml(activity.title)}</strong>${escapeHtml(activity.location)}</button>`).join('');
    if (group.events.length > 2) {
      const startTime = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
      const endTime = `${String(group.end.getHours()).padStart(2, '0')}:${String(group.end.getMinutes()).padStart(2, '0')}`;
      content += `<button class="week-cluster" style="top:${Math.min(610, top + Math.min(duration, 78) + 4)}px" data-open-slot="${dateKey(date)}|${startTime}|${endTime}">还有 ${group.events.length - 2} 个<br>同时段活动</button>`;
    }
  }
  return `<div class="week-column ${dateKey(date) === dateKey(state.date) ? 'selected' : ''}">${content}</div>`;
}

function renderDay() {
  const weekStart = startOfWeek(state.date);
  const strip = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(weekStart, index);
    return `<button class="day-picker ${dateKey(date) === dateKey(state.date) ? 'active' : ''}" data-date="${dateKey(date)}" data-open-view="day"><span>${shortWeekNames[index]}</span><strong>${date.getDate()}</strong><small>${eventsForDay(date).length || ''}</small></button>`;
  }).join('');
  const events = eventsForDay(state.date);
  const joined = events.filter(isJoined).length;
  const available = events.filter((activity) => participantCount(activity) < activity.capacity).length;
  if (!events.length) return `<div class="day-strip panel">${strip}</div><section class="panel empty-state">${icon('calendar-x')}<h3>这一天还没有符合条件的活动</h3><p>可以清除筛选或创建一个新活动。</p><button class="btn btn-primary" data-create>${icon('plus')}创建活动</button></section>`;
  const allDay = events.filter((activity) => activity.allDay);
  const groups = groupOverlappingActivities(events.filter((activity) => !activity.allDay));
  if (allDay.length) groups.unshift({ start: null, end: null, events: allDay, allDay: true });
  const groupMarkup = groups.map((group) => {
    group.events.sort((left, right) => right.importance - left.importance || parseDate(left.start) - parseDate(right.start));
    const time = group.allDay ? '全天' : `${String(group.start.getHours()).padStart(2, '0')}:${String(group.start.getMinutes()).padStart(2, '0')}`;
    const slotKey = `${dateKey(state.date)}|${time}`;
    const expanded = state.expandedSlots.has(slotKey);
    const visible = expanded ? group.events : group.events.slice(0, 3);
    const overlap = group.events.length > 1 && !group.allDay ? '重叠' : '';
    const cards = visible.map((activity) => renderActivityCard(activity)).join('');
    const expandLabel = expanded ? '收起' : `展开其余 ${group.events.length - 3} 个`;
    const actions = group.events.length > 3 ? `<div class="time-group-actions"><button class="btn btn-soft btn-sm" data-expand-slot="${slotKey}">${expandLabel}</button></div>` : '';
    return `<section class="time-group"><div class="time-label"><strong>${time}</strong><span>${group.events.length} 个${overlap}活动</span></div><div class="time-events">${cards}</div>${actions}</section>`;
  }).join('');
  return `<div class="day-strip panel">${strip}</div><div class="day-overview"><div class="day-stat"><strong>${events.length}</strong><span>当天活动</span></div><div class="day-stat"><strong>${joined}</strong><span>我已报名</span></div><div class="day-stat"><strong>${available}</strong><span>仍有名额</span></div></div><section class="panel day-list">${groupMarkup}</section>`;
}

function renderActivityCard(activity, controls = false) {
  const count = participantCount(activity);
  const joined = isJoined(activity);
  const percent = Math.min(100, Math.round(count / activity.capacity * 100));
  const actions = controls ? `<div class="drawer-actions"><button class="btn btn-sm" data-event="${activity.id}">${icon('eye')}详情</button><button class="btn btn-sm ${joined ? '' : 'btn-primary'}" data-join="${activity.id}" ${!joined && count >= activity.capacity ? 'disabled' : ''}>${joined ? '取消报名' : '报名'}</button></div>` : '';
  return `<article class="activity-card importance-${activity.importance}" role="button" tabindex="0" data-event="${activity.id}"><div class="card-top">${activity.type === 'official' ? '<span class="badge badge-official">官方</span>' : ''}<span class="badge">${importanceLabel(activity.importance)}</span>${joined ? '<span class="badge badge-success">已报名</span>' : ''}${count >= activity.capacity ? '<span class="badge badge-warning">已满</span>' : ''}</div><h3>${escapeHtml(activity.title)}</h3><p>${icon('clock-3')}${timeLabel(activity)}</p><p>${icon('map-pin')}${escapeHtml(activity.location)} · ${escapeHtml(activity.organizer)}</p><div class="capacity-row"><div class="progress"><span style="width:${percent}%"></span></div><small>${count} / ${activity.capacity}</small></div>${actions}</article>`;
}

function renderDrawer() {
  const drawer = document.querySelector('#activity-drawer');
  if (!state.drawer || state.page !== 'calendar') {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.innerHTML = '';
    return;
  }
  const date = parseDate(state.drawer.date);
  let events = eventsForDay(date);
  let title = `${date.getMonth() + 1} 月 ${date.getDate()} 日 · ${weekNames[date.getDay()]}`;
  if (state.drawer.startTime) {
    const slotStart = parseDate(`${state.drawer.date}T${state.drawer.startTime}`);
    const slotEnd = parseDate(`${state.drawer.date}T${state.drawer.endTime}`);
    events = events.filter((activity) => parseDate(activity.start) < slotEnd && parseDate(activity.end) > slotStart);
    title = `${title} · ${state.drawer.startTime}–${state.drawer.endTime}`;
  }
  const score = events.reduce((total, activity) => total + activity.importance, 0);
  const list = events.length ? events.map((activity) => renderActivityCard(activity, true)).join('') : '<p class="hint">没有符合当前筛选的活动。</p>';
  drawer.innerHTML = `<div class="drawer-head"><div><h2>${title}</h2><p>共 ${events.length} 个活动 · 热力 ${score}</p></div><button class="btn btn-icon" data-close-drawer aria-label="关闭">${icon('x')}</button></div><div class="drawer-stats"><div class="drawer-stat"><strong>${events.length}</strong><span>全部活动</span></div><div class="drawer-stat"><strong>${events.filter(isJoined).length}</strong><span>我已报名</span></div><div class="drawer-stat"><strong>${events.filter((activity) => participantCount(activity) < activity.capacity).length}</strong><span>仍有名额</span></div></div><div class="drawer-list">${list}</div>`;
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
}

function renderDetail() {
  const activity = findActivity(state.detailId);
  if (!activity) { goCalendar(); return; }
  const count = participantCount(activity);
  const joined = isJoined(activity);
  const percent = Math.min(100, Math.round(count / activity.capacity * 100));
  let statusLabel = '报名中';
  if (activity.status === 'DRAFT') statusLabel = '草稿';
  else if (isEnded(activity)) statusLabel = '已结束';
  const people = [...(activity.people || [])];
  if (joined && !people.includes('林夏')) people.unshift('林夏');
  const organizerBadge = activity.type === 'official' ? '<span class="badge badge-official">官方活动</span>' : '<span class="badge">个人活动</span>';
  const statusClass = activity.status === 'DRAFT' ? 'badge-warning' : 'badge-success';
  const joinLabel = joined ? `${icon('ticket-x')}取消报名` : `${icon('ticket-check')}立即报名`;
  const registrationAction = activity.status === 'DRAFT' ? `<button class="btn btn-primary" data-publish="${activity.id}">${icon('send')}发布活动</button>` : `<button class="btn ${joined ? '' : 'btn-primary'}" data-join="${activity.id}" ${!joined && (count >= activity.capacity || isEnded(activity)) ? 'disabled' : ''}>${joinLabel}</button>`;
  let registrationHint = '活动开始前可取消报名';
  if (activity.status === 'DRAFT') registrationHint = '草稿不会出现在活动日历中';
  else if (isEnded(activity)) registrationHint = '活动已经结束';
  const description = activity.description.split('\n').filter(Boolean).map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('');
  const participants = people.slice(0, 6).map((name) => {
    const ownBadge = name === '林夏' ? '<span class="badge badge-success" style="margin-left:auto">我的报名</span>' : '';
    return `<div class="participant"><div class="avatar">${escapeHtml(name.slice(0, 1))}</div><div><strong>${escapeHtml(name)}</strong><span>2026级 · 校园用户</span></div>${ownBadge}</div>`;
  }).join('') || '<p class="hint">暂未展示参与者</p>';
  document.querySelector('#detail-page').innerHTML = `<div class="page-actions"><button class="btn" data-go-calendar>${icon('arrow-left')}返回活动广场</button><button class="btn push" data-template="${activity.id}">${icon('copy')}以此为模板</button><button class="btn" data-copy-link>${icon('share-2')}复制链接</button></div><section class="panel detail-hero"><div><div class="card-top">${organizerBadge}<span class="badge">${importanceLabel(activity.importance)}</span><span class="badge ${statusClass}">${statusLabel}</span></div><span class="eyebrow">CAMPUS EVENT</span><h2>${escapeHtml(activity.title)}</h2><p class="summary">${escapeHtml(activity.description.split('\n')[0])}</p><div class="hero-meta"><span>${icon('calendar-days')}${parseDate(activity.start).getMonth() + 1} 月 ${parseDate(activity.start).getDate()} 日 ${weekNames[parseDate(activity.start).getDay()]}</span><span>${icon('clock-3')}${timeLabel(activity)}</span><span>${icon('map-pin')}${escapeHtml(activity.location)}</span><span>${icon('building-2')}${escapeHtml(activity.organizer)}</span></div></div><aside class="registration-card"><div class="capacity-title"><div><span>当前报名</span><br><strong>${count}</strong><span> / ${activity.capacity} 人</span></div><span>还剩 ${Math.max(0, activity.capacity - count)} 个名额</span></div><div class="progress"><span style="width:${percent}%"></span></div>${registrationAction}<small>${registrationHint}</small></aside></section><div class="detail-grid"><section class="panel detail-panel"><h3>${icon('notebook-text')}活动介绍</h3><div class="detail-copy">${description}</div></section><aside class="panel detail-panel"><div class="section-heading"><h3>${icon('users')}已报名同学</h3><span class="badge">${count} 人</span></div><p class="hint">仅展示可见的最小身份信息</p>${participants}<button class="btn btn-soft" style="width:100%;margin-top:14px" data-show-participants>查看全部参与者</button></aside></div>`;
}

function renderForm() {
  const template = state.templateId ? findActivity(state.templateId) : null;
  const start = template ? nextTemplateStart(template) : new Date(2026, 8, 24, 19, 0);
  const duration = template ? parseDate(template.end) - parseDate(template.start) : 90 * 60000;
  const end = new Date(start.getTime() + duration);
  const adjustment = template?.importance > 3 ? `原活动 ${importanceLabel(template.importance)} 已按你的权限调整为 III 级。` : '';
  const templateNotice = template ? `<div class="template-note">${icon('copy-check')}<div><strong>正在以“${escapeHtml(template.title)}”为模板</strong><p>已复制公开配置；主办者、报名人员和原活动时间不会复制。${adjustment}</p></div><button type="button" class="btn btn-sm" data-clear-template>清除模板</button></div>` : '';
  const importanceOptions = [1,2,3,4,5].map((level) => `<label class="${level > 3 ? 'disabled' : ''}"><input type="radio" name="importance" value="${level}" ${level === Math.min(template?.importance || 1, 3) ? 'checked' : ''} ${level > 3 ? 'disabled' : ''}>${['I','II','III','IV','V'][level - 1]}</label>`).join('');
  document.querySelector('#form-page').innerHTML = `<div class="page-actions"><button class="btn" data-go-calendar>${icon('arrow-left')}返回活动广场</button><span class="badge badge-warning push">草稿未保存</span></div><form id="activity-form" class="form-layout"><section class="panel form-panel">${templateNotice}<div class="form-section"><h3>基本信息</h3><div class="input-group"><label for="activity-title">活动名称</label><input class="input" id="activity-title" name="title" maxlength="80" required value="${escapeHtml(template?.title || '')}" placeholder="例如：新生学习经验分享会"></div><div class="input-group"><label for="activity-description">活动介绍 · 支持 Markdown</label><textarea class="input" id="activity-description" name="description" maxlength="5000" placeholder="介绍活动内容和到场须知">${escapeHtml(template?.description || '')}</textarea><p class="hint">演示预览按纯文本处理；正式实现使用服务端安全 Markdown 管线。</p></div></div><div class="form-section"><h3>时间与地点</h3><label class="toggle-row"><input type="checkbox" name="allDay" ${template?.allDay ? 'checked' : ''}>全天活动</label><div class="form-row"><div class="input-group"><label for="activity-start">开始时间</label><input class="input" type="datetime-local" id="activity-start" name="start" required value="${dateTimeValue(start)}"></div><div class="input-group"><label for="activity-end">结束时间</label><input class="input" type="datetime-local" id="activity-end" name="end" required value="${dateTimeValue(end)}"></div></div><div class="input-group"><label for="activity-location">活动地点</label><input class="input" id="activity-location" name="location" maxlength="120" required value="${escapeHtml(template?.location || '')}" placeholder="例如：大学生活动中心 203"></div></div><div class="form-section"><h3>报名与展示</h3><div class="form-row"><div class="input-group"><label for="activity-capacity">活动容量</label><input class="input" type="number" id="activity-capacity" name="capacity" min="1" max="500" required value="${template?.capacity || 60}"><p class="hint">1–500 人</p></div><div class="input-group"><label for="activity-grade">目标年级</label><input class="input" id="activity-grade" name="targetGrade" value="2026级" readonly><p class="hint">个人活动只能选择自己的年级</p></div></div><div class="input-group"><label>重要程度</label><div class="importance-options">${importanceOptions}</div><p class="hint warning">个人活动最高可设为 III 级；IV–V 级仅限有权限的官方活动。</p></div></div></section><aside><section class="panel publish-card"><h3>发布检查</h3><div class="check-row"><span class="check">✓</span><span>名称和介绍将在提交时校验</span></div><div class="check-row"><span class="check">✓</span><span>结束时间必须晚于开始时间</span></div><div class="check-row"><span class="check">✓</span><span>容量限制为 1–500 人</span></div><div class="check-row"><span class="check">✓</span><span>重要程度符合当前权限</span></div><button class="btn btn-primary" type="submit" name="intent" value="publish">${icon('send')}发布活动</button><button class="btn" type="submit" name="intent" value="draft">${icon('save')}保存草稿</button><button class="btn" type="button" data-preview-form>${icon('eye')}预览</button><p class="hint">发布后活动会立即出现在 2026 级活动广场。草稿仅在详情页可见。</p></section></aside></form>`;
  renderGroupTargets(template);
}

function renderGroupTargets(template) {
  const row = document.querySelector('#activity-grade')?.closest('.form-row');
  if (!row) return;
  const selected = new Set(template?.targetGroups || ['own-1']);
  const groups = allGroups().map((group) => `<label class="group-option"><input type="checkbox" name="targetGroups" value="${escapeHtml(group.id)}" ${selected.has(group.id) ? 'checked' : ''}><span><strong>${escapeHtml(group.name)}</strong><br><small>${escapeHtml(group.description)} · ${group.members.length} 人</small></span><span class="badge ${group.owned ? 'badge-success' : ''}">${group.owned ? '我的' : '管理员共享'}</span></label>`).join('');
  row.insertAdjacentHTML('afterend', `<div class="input-group"><div class="section-heading"><label>目标群组</label><button type="button" class="btn btn-sm" data-manage-groups>${icon('settings-2')}管理我的群组</button></div><div class="group-picker">${groups}</div><p class="hint">目标年级与群组成员取并集；发布时固定成员快照。</p></div>`);
}

function openGroupManager() {
  const modal = document.querySelector('#modal-root');
  const groups = allGroups().map((group) => {
    const action = group.owned ? `<button class="btn btn-sm" data-delete-group="${escapeHtml(group.id)}">${icon('trash-2')}删除</button>` : '<span class="badge">只读</span>';
    return `<div class="group-manager-row"><div><strong>${escapeHtml(group.name)}</strong><p>${escapeHtml(group.description)} · ${group.members.join('、') || '暂无成员'} · ${group.owned ? '由我创建' : '管理员共享'}</p></div>${action}</div>`;
  }).join('');
  const candidates = groupCandidates.map((name) => `<label><input type="checkbox" name="members" value="${escapeHtml(name)}">${escapeHtml(name)}<small>2026级</small></label>`).join('');
  modal.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="group-manager-title"><div class="modal-head"><div><span class="badge">共享学生群组</span><h2 id="group-manager-title">管理我的群组</h2></div><button class="btn btn-icon" data-close-modal aria-label="关闭">${icon('x')}</button></div><p class="hint">你创建的群组和管理员预设群组使用同一套数据，可直接作为活动目标。</p><div class="group-manager-list">${groups}</div><form id="group-form"><h3>新建群组</h3><div class="input-group"><label for="group-name">群组名称</label><input class="input" id="group-name" name="name" maxlength="80" required placeholder="例如：周末运动搭子"></div><div class="input-group"><label for="group-description">用途说明</label><input class="input" id="group-description" name="description" maxlength="200" placeholder="简要说明群组用途"></div><div class="input-group"><label>选择成员</label><div class="candidate-grid">${candidates}</div></div><div class="modal-actions"><button type="button" class="btn" data-close-modal>取消</button><button class="btn btn-primary" type="submit">${icon('plus')}创建群组</button></div></form></section></div>`;
  refreshIcons();
}

function createGroup(form) {
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  const nameValue = data.get('name');
  const descriptionValue = data.get('description');
  const name = (typeof nameValue === 'string' ? nameValue : '').trim();
  if (allGroups().some((group) => group.owned && group.name === name)) return showToast('你已经创建过同名群组');
  const description = (typeof descriptionValue === 'string' ? descriptionValue : '').trim() || '我的活动目标群组';
  customGroups.push({ id: `own-${Date.now()}`, name, description, members: data.getAll('members'), owned: true });
  saveStoredState();
  openGroupManager();
  showToast(`已创建群组“${name}”`);
}

function deleteGroup(id) {
  const group = customGroups.find((item) => item.id === id);
  if (!group || !window.confirm(`删除群组“${group.name}”？已发布活动的目标快照不受影响。`)) return;
  customGroups = customGroups.filter((item) => item.id !== id);
  saveStoredState();
  openGroupManager();
  showToast('群组已删除');
}

function nextTemplateStart(activity) {
  const result = new Date(2026, 8, 24, parseDate(activity.start).getHours(), parseDate(activity.start).getMinutes());
  if (result <= DEMO_NOW) result.setDate(result.getDate() + 7);
  return result;
}

function navigatePeriod(direction) {
  const amount = direction === 'next' ? 1 : -1;
  const date = new Date(state.date);
  if (state.view === 'year') date.setFullYear(date.getFullYear() + amount);
  if (state.view === 'month') date.setMonth(date.getMonth() + amount, 1);
  if (state.view === 'week') date.setDate(date.getDate() + amount * 7);
  if (state.view === 'day') date.setDate(date.getDate() + amount);
  state.date = date;
  state.drawer = null;
  render();
}

function goCalendar() {
  state.page = 'calendar';
  state.drawer = null;
  render();
}

function openDetail(id) {
  if (!findActivity(id)) return;
  state.page = 'detail';
  state.detailId = id;
  state.drawer = null;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  render();
}

function openForm(templateId = null) {
  state.page = 'form';
  state.templateId = templateId;
  state.drawer = null;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  render();
}

function toggleRegistration(id) {
  const activity = findActivity(id);
  if (activity?.status !== 'PUBLISHED') return;
  const key = typeof activity.id === 'number' ? activity.id : String(activity.id);
  if (isJoined(activity)) {
    joinedIds.delete(key);
    joinedIds.delete(Number(key));
    participantDeltas[activity.id] = (participantDeltas[activity.id] || 0) - 1;
    showToast(`已取消报名“${activity.title}”`);
  } else {
    if (participantCount(activity) >= activity.capacity) return showToast('活动名额已满');
    joinedIds.add(key);
    participantDeltas[activity.id] = (participantDeltas[activity.id] || 0) + 1;
    showToast(`已报名“${activity.title}”`);
  }
  saveStoredState();
  render();
}

function publishDraft(id) {
  const activity = customActivities.find((item) => String(item.id) === String(id));
  if (!activity) return;
  activity.status = 'PUBLISHED';
  saveStoredState();
  showToast('活动已发布并加入日历');
  render();
}

function showPreview() {
  const form = document.querySelector('#activity-form');
  if (!form) return;
  const values = Object.fromEntries(new FormData(form));
  const modal = document.querySelector('#modal-root');
  modal.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="preview-title"><div class="modal-head"><div><span class="badge">预览</span><h2 id="preview-title">活动发布效果</h2></div><button class="btn btn-icon" data-close-modal aria-label="关闭">${icon('x')}</button></div><div class="preview-body"><span class="badge">${importanceLabel(Number(values.importance || 1))}</span><h3>${escapeHtml(values.title || '未填写活动名称')}</h3><p>${icon('calendar-days')}${escapeHtml(values.start || '未填写时间')} 至 ${escapeHtml(values.end || '')}</p><p>${icon('map-pin')}${escapeHtml(values.location || '未填写地点')} · 林夏</p><hr><p>${escapeHtml(values.description || '暂未填写活动介绍')}</p><div class="capacity-row"><div class="progress"><span style="width:0%"></span></div><small>0 / ${escapeHtml(values.capacity || '0')}</small></div></div><div class="modal-actions"><button class="btn" data-close-modal>继续编辑</button></div></section></div>`;
  refreshIcons();
}

function closeModal() { document.querySelector('#modal-root').innerHTML = ''; }

function saveActivity(form, intent) {
  if (!form.reportValidity()) return;
  const formData = new FormData(form);
  const values = Object.fromEntries(formData);
  const start = parseDate(values.start);
  const end = parseDate(values.end);
  if (end <= start) return showToast('结束时间必须晚于开始时间');
  const activity = {
    id: `custom-${Date.now()}`, title: values.title.trim(), description: values.description.trim(), start: dateTimeValue(start), end: dateTimeValue(end),
    location: values.location.trim(), organizer: '林夏', type: 'personal', importance: Number(values.importance), capacity: Number(values.capacity), participants: 0, allDay: values.allDay === 'on',
    people: [], owner: true, status: intent === 'draft' ? 'DRAFT' : 'PUBLISHED', targetGrade: '2026级', targetGroups: formData.getAll('targetGroups'),
  };
  customActivities.push(activity);
  saveStoredState();
  state.detailId = activity.id;
  state.page = 'detail';
  state.date = parseDate(activity.start);
  state.templateId = null;
  showToast(intent === 'draft' ? '草稿已保存到当前浏览器' : '活动已发布到日历');
  render();
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.querySelector('#toast-root').append(toast);
  window.setTimeout(() => toast.remove(), 2600);
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('button, [role="button"]');
  if (!target) return;
  if (target.matches('[data-reset-demo]')) {
    if (window.confirm('重置报名和你创建的演示活动？')) {
      localStorage.removeItem(STORAGE_KEY);
      customActivities = [];
      customGroups = initialOwnGroups.map((group) => ({ ...group, members: [...group.members] }));
      joinedIds = new Set([2, 3, 4, 6]);
      participantDeltas = {};
      state = { page: 'calendar', view: window.innerWidth < 768 ? 'day' : 'month', date: new Date(DEMO_NOW), detailId: null, templateId: null, drawer: null, filtersOpen: false, expandedSlots: new Set(), filters: { search: '', type: 'all', importance: 'all', registration: 'all' } };
      showToast('演示数据已重置');
      render();
    }
    return;
  }
  if (target.matches('[data-go-calendar]')) return goCalendar();
  if (target.matches('[data-manage-groups]')) return openGroupManager();
  if (target.matches('[data-delete-group]')) return deleteGroup(target.dataset.deleteGroup);
  if (target.matches('[data-create]')) return openForm();
  if (target.matches('[data-toggle-filters]')) { state.filtersOpen = !state.filtersOpen; return render(); }
  if (target.matches('[data-view]')) { state.view = target.dataset.view; state.drawer = null; return render(); }
  if (target.matches('[data-nav="today"]')) { state.date = new Date(DEMO_NOW); state.drawer = null; return render(); }
  if (target.matches('[data-nav="previous"]')) return navigatePeriod('previous');
  if (target.matches('[data-nav="next"]')) return navigatePeriod('next');
  if (target.matches('[data-month]')) { const [year, month] = target.dataset.month.split('-').map(Number); state.date = new Date(year, month - 1, 1); state.view = 'month'; return render(); }
  if (target.matches('[data-date]')) { state.date = parseDate(target.dataset.date); state.view = target.dataset.openView || state.view; state.drawer = null; return render(); }
  if (target.matches('[data-open-day]')) { state.date = parseDate(target.dataset.openDay); state.drawer = { date: target.dataset.openDay }; return render(); }
  if (target.matches('[data-open-slot]')) { const [date, startTime, endTime] = target.dataset.openSlot.split('|'); state.drawer = { date, startTime, endTime }; return render(); }
  if (target.matches('[data-close-drawer]')) { state.drawer = null; return renderDrawer(); }
  if (target.matches('[data-join]')) { event.stopPropagation(); return toggleRegistration(target.dataset.join); }
  if (target.matches('[data-event]')) { event.stopPropagation(); return openDetail(target.dataset.event); }
  if (target.matches('[data-template]')) return openForm(target.dataset.template);
  if (target.matches('[data-clear-template]')) { state.templateId = null; return render(); }
  if (target.matches('[data-preview-form]')) return showPreview();
  if (target.matches('[data-close-modal]') || target.classList.contains('modal-backdrop')) return closeModal();
  if (target.matches('[data-clear-filters]')) { state.filters = { search: '', type: 'all', importance: 'all', registration: 'all' }; return render(); }
  if (target.matches('[data-expand-slot]')) { const key = target.dataset.expandSlot; state.expandedSlots.has(key) ? state.expandedSlots.delete(key) : state.expandedSlots.add(key); return render(); }
  if (target.matches('[data-publish]')) return publishDraft(target.dataset.publish);
  if (target.matches('[data-copy-link]')) { navigator.clipboard?.writeText(`activity-demo:${state.detailId}`); return showToast('演示链接已复制'); }
  if (target.matches('[data-show-participants]')) return showToast('Demo 仅展示前 6 位参与者');
  if (target.matches('.top-link, .nav-item:not(.active), .bottom-nav button:not(.active)')) showToast('该入口不属于本次活动广场 Demo');
});

document.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[role="button"]')) {
    event.preventDefault();
    event.target.click();
  }
  if (event.key === 'Escape') {
    if (document.querySelector('.modal-backdrop')) closeModal();
    else if (state.drawer) { state.drawer = null; renderDrawer(); }
  }
});

document.querySelector('#filter-search').addEventListener('input', (event) => {
  state.filters.search = event.target.value;
  renderCalendar();
  renderDrawer();
  refreshIcons();
});

for (const [id, key] of [['#filter-type', 'type'], ['#filter-importance', 'importance'], ['#filter-registration', 'registration']]) {
  document.querySelector(id).addEventListener('change', (event) => {
    state.filters[key] = event.target.value;
    renderCalendar();
    renderDrawer();
    refreshIcons();
  });
}

document.addEventListener('submit', (event) => {
  if (event.target.matches('#activity-filters')) event.preventDefault();
  if (event.target.matches('#activity-form')) {
    event.preventDefault();
    saveActivity(event.target, event.submitter?.value || 'publish');
  }
  if (event.target.matches('#group-form')) {
    event.preventDefault();
    createGroup(event.target);
  }
});

render();
