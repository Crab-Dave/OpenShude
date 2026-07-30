const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const databasePath = path.join(__dirname, 'api-test.db');
fs.rmSync(databasePath, { force: true });
process.env.DB_PATH = databasePath;

const { server, db } = require('../server');

let baseUrl;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(databasePath, { force: true });
});

async function login(loginIdentifier, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginIdentifier, password }),
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  return {
    user: data.user,
    csrf: data.csrfToken,
    cookie: response.headers.get('set-cookie').split(';')[0],
  };
}

async function request(session, pathname, options = {}) {
  const headers = { Cookie: session.cookie, ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (!['GET', 'HEAD'].includes(options.method || 'GET')) headers['X-CSRF-Token'] = session.csrf;
  const response = await fetch(`${baseUrl}${pathname}`, { ...options, headers });
  const data = await response.json();
  return { response, data };
}

test('health endpoint reports application and database readiness', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('students maintain cards using the documented fields while identity stays read-only', async () => {
  const student = await login('2026001', 'Student123!');
  assert.equal(student.user.major, '计算机科学与技术');

  const immutable = await request(student, '/api/me/roommate-card', {
    method: 'PUT', body: JSON.stringify({ major: '不可修改' }),
  });
  assert.equal(immutable.response.status, 403);
  assert.equal(immutable.data.error.code, 'IDENTITY_FIELDS_READ_ONLY');

  const invalidSize = await request(student, '/api/me/roommate-card', {
    method: 'PUT', body: JSON.stringify({ clothing_size: 'XS' }),
  });
  assert.equal(invalidSize.response.status, 400);
  assert.equal(invalidSize.data.error.code, 'INVALID_CLOTHING_SIZE');

  const input = {
    avatar_url: '/assets/avatar-1.png',
    origin_province: '浙江', origin_city: '杭州', clothing_size: 'L',
    summer_temp_min: 24, summer_temp_max: 26, winter_temp_min: 20, winter_temp_max: 23,
    wake_up_time: '工作日 7:00', sleep_time: '23:30 左右', nap_habit: '午休 30 分钟',
    personal_cleanliness: 'TIDY', roommate_cleanliness: 'BASIC', common_space_maintenance: 'CLEAN_TOGETHER',
    unacceptable_hygiene: '长期不倒垃圾',
    one_sentence_intro: '爱摄影也爱运动，期待认识真诚的室友。',
    personality_text: '开朗，愿意主动沟通', roommate_personality_text: '尊重边界，好沟通',
    interests_text: '摄影、羽毛球', gaming_self: '偶尔玩，休息时间戴耳机', gaming_roommate: '可以玩，休息时保持安静',
    keyboard_noise_text: '白天不介意，睡觉时介意', media_noise_text: '介意外放，请使用耳机',
    self_acknowledged_shortcoming: '整理东西时有些慢', additional_note: '希望提前沟通值日安排',
  };
  const invalidCleanliness = await request(student, '/api/me/roommate-card', {
    method: 'PUT', body: JSON.stringify({ ...input, personal_cleanliness: 'UNKNOWN' }),
  });
  assert.equal(invalidCleanliness.response.status, 400);
  assert.equal(invalidCleanliness.data.error.code, 'INVALID_CLEANLINESS');

  const invalidTemperature = await request(student, '/api/me/roommate-card', {
    method: 'PUT', body: JSON.stringify({ ...input, summer_temp_min: 36 }),
  });
  assert.equal(invalidTemperature.response.status, 400);
  assert.equal(invalidTemperature.data.error.code, 'INVALID_TEMPERATURE');

  const saved = await request(student, '/api/me/roommate-card', {
    method: 'PUT', body: JSON.stringify(input),
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.card.clothing_size, 'L');
  assert.equal(saved.data.card.common_space_maintenance, 'CLEAN_TOGETHER');
  assert.equal(saved.data.card.one_sentence_intro, '爱摄影也爱运动，期待认识真诚的室友。');
  assert.equal(saved.data.card.major, '计算机科学与技术');

  const published = await request(student, '/api/me/roommate-card/publish', { method: 'POST', body: '{}' });
  assert.equal(published.response.status, 200);
  assert.equal(published.data.card.status, 'PUBLISHED');

  const unpublish = await request(student, '/api/me/roommate-card/unpublish', { method: 'POST', body: '{}' });
  assert.equal(unpublish.response.status, 409);
  assert.equal(unpublish.data.error.code, 'CARD_PUBLICATION_PERMANENT');

  const nameSearch = await request(student, '/api/roommate-cards?gender=FEMALE&search=林夏');
  assert.equal(nameSearch.data.cards.length, 1);
  assert.equal(nameSearch.data.cards[0].name, '林夏');
  const nonNameSearch = await request(student, '/api/roommate-cards?gender=FEMALE&search=摄影');
  assert.equal(nonNameSearch.data.cards.length, 0);

  const incompletePublishedEdit = await request(student, '/api/me/roommate-card', {
    method: 'PUT', body: JSON.stringify({ clothing_size: 'M' }),
  });
  assert.equal(incompletePublishedEdit.response.status, 400);
  const unchanged = await request(student, '/api/me/roommate-card');
  assert.equal(unchanged.data.card.clothing_size, 'L');
});

test('same-gender students form a full dormitory and can leave while selection is open', async () => {
  const initiator = await login('2026002', 'Student123!');
  const members = await Promise.all(['2026004', '2026005', '2026007'].map((id) => login(id, 'Student123!')));
  const extra = await login('2026009', 'Student123!');
  const otherInitiator = await login('2026011', 'Student123!');
  const female = await login('2026001', 'Student123!');

  const immutable = await request(initiator, '/api/me/roommate-card', {
    method: 'PUT', body: JSON.stringify({ name: '不可修改' }),
  });
  assert.equal(immutable.response.status, 403);
  assert.equal(immutable.data.error.code, 'IDENTITY_FIELDS_READ_ONLY');

  const created = await request(initiator, '/api/dormitories', {
    method: 'POST', body: JSON.stringify({ name: '北苑测试宿舍' }),
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.dormitory.current_user_role, 'INITIATOR');
  assert.equal(created.data.dormitory.capacity, 4);
  assert.equal(created.data.dormitory.building, '');
  assert.equal(created.data.dormitory.room_number, '');
  const dormitoryId = created.data.dormitory.id;

  const maleCards = await request(female, '/api/roommate-cards?gender=MALE');
  const femaleCards = await request(female, '/api/roommate-cards?gender=FEMALE');
  assert.ok(maleCards.data.cards.every((card) => card.gender === 'MALE'));
  assert.ok(femaleCards.data.cards.every((card) => card.gender === 'FEMALE'));
  assert.ok(femaleCards.data.cards.some((card) => card.is_own));

  const initiatorCard = maleCards.data.cards.find((card) => card.user_id === initiator.user.id);
  assert.ok(initiatorCard);
  const crossGenderConversation = await request(female, `/api/roommate-cards/${initiatorCard.id}/conversations`, {
    method: 'POST', body: '{}',
  });
  const crossGenderApplication = await request(female, `/api/conversations/${crossGenderConversation.data.conversation.id}/dormitory-applications`, {
    method: 'POST', body: JSON.stringify({ dormitoryId }),
  });
  assert.equal(crossGenderApplication.response.status, 403);
  assert.equal(crossGenderApplication.data.error.code, 'SAME_GENDER_REQUIRED');

  async function applyAndApprove(applicant) {
    const cardsResult = await request(applicant, '/api/roommate-cards?gender=MALE');
    const card = cardsResult.data.cards.find((item) => item.user_id === initiator.user.id);
    const conversation = await request(applicant, `/api/roommate-cards/${card.id}/conversations`, {
      method: 'POST', body: '{}',
    });
    const application = await request(applicant, `/api/conversations/${conversation.data.conversation.id}/dormitory-applications`, {
      method: 'POST', body: JSON.stringify({ dormitoryId, note: '希望加入，作息规律。' }),
    });
    assert.equal(application.response.status, 201);
    const approved = await request(initiator, `/api/dormitory-applications/${application.data.application.id}/approve`, {
      method: 'POST', body: '{}',
    });
    assert.equal(approved.response.status, 200);
    return { conversation, application, approved };
  }

  const firstJoin = await applyAndApprove(members[0]);
  const messages = await request(initiator, `/api/conversations/${firstJoin.conversation.data.conversation.id}/messages`);
  assert.equal(messages.data.messages.at(-1).message_type, 'DORMITORY_APPLICATION');
  assert.equal(messages.data.messages.at(-1).application_status, 'APPROVED');
  await applyAndApprove(members[1]);
  const fullResult = await applyAndApprove(members[2]);
  assert.equal(fullResult.approved.data.dormitory.member_count, 4);
  assert.equal(fullResult.approved.data.dormitory.status, 'FULL');

  const otherDormitory = await request(otherInitiator, '/api/dormitories', {
    method: 'POST', body: JSON.stringify({ name: '另一个测试宿舍' }),
  });
  assert.equal(otherDormitory.response.status, 201);
  const initiatorDormitories = await request(initiator, '/api/dormitories');
  assert.equal(initiatorDormitories.data.dormitories[0].id, dormitoryId);
  assert.equal(initiatorDormitories.data.dormitories[0].current_user_role, 'INITIATOR');
  assert.equal(initiatorDormitories.data.dormitories[0].members.length, 4);
  assert.ok(initiatorDormitories.data.dormitories.every((item) => Array.isArray(item.members)));
  const otherDormitories = await request(otherInitiator, '/api/dormitories');
  assert.equal(otherDormitories.data.dormitories[0].id, otherDormitory.data.dormitory.id);
  await request(otherInitiator, '/api/me/dormitory/leave', { method: 'POST', body: '{}' });

  const listed = await request(extra, '/api/dormitories');
  const listedDormitory = listed.data.dormitories.find((item) => item.id === dormitoryId);
  assert.equal(listedDormitory.status, 'FULL');
  assert.equal(listedDormitory.member_count, 4);

  const extraCards = await request(extra, '/api/roommate-cards?gender=MALE');
  const extraInitiatorCard = extraCards.data.cards.find((card) => card.user_id === initiator.user.id);
  assert.equal(extraInitiatorCard.team_member_count, 4);
  const availableCards = await request(extra, '/api/roommate-cards?gender=MALE&availability=AVAILABLE');
  assert.equal(availableCards.data.cards.some((card) => card.user_id === initiator.user.id), false);
  const extraConversation = await request(extra, `/api/roommate-cards/${extraInitiatorCard.id}/conversations`, {
    method: 'POST', body: '{}',
  });
  const fullApplication = await request(extra, `/api/conversations/${extraConversation.data.conversation.id}/dormitory-applications`, {
    method: 'POST', body: JSON.stringify({ dormitoryId }),
  });
  assert.equal(fullApplication.response.status, 409);
  assert.equal(fullApplication.data.error.code, 'DORMITORY_UNAVAILABLE');

  const secondDormitory = await request(members[0], '/api/dormitories', {
    method: 'POST', body: JSON.stringify({ name: '不应创建' }),
  });
  assert.equal(secondDormitory.response.status, 409);
  assert.equal(secondDormitory.data.error.code, 'ALREADY_IN_DORMITORY');

  const leftFullDormitory = await request(members[0], '/api/me/dormitory/leave', { method: 'POST', body: '{}' });
  assert.equal(leftFullDormitory.response.status, 200);
  const reopened = await request(initiator, `/api/dormitories/${dormitoryId}`);
  assert.equal(reopened.data.dormitory.status, 'OPEN');
  assert.equal(reopened.data.dormitory.member_count, 3);

  for (const session of [initiator, members[1], members[2]]) {
    const left = await request(session, '/api/me/dormitory/leave', { method: 'POST', body: '{}' });
    assert.equal(left.response.status, 200);
  }
  const deletedDormitory = await request(initiator, `/api/dormitories/${dormitoryId}`);
  assert.equal(deletedDormitory.response.status, 404);
});

test('administrator imports accounts and exclusively updates identity fields', async () => {
  const admin = await login('admin', 'Admin123!');
  const imported = await request(admin, '/api/admin/users/import', {
    method: 'POST',
    body: JSON.stringify({ accounts: [{ loginIdentifier: '2026999', name: '测试学生', grade: '2026级', gender: 'FEMALE', major: '数据科学' }] }),
  });
  assert.equal(imported.response.status, 200);
  assert.equal(imported.data.created.length, 1);
  assert.ok(imported.data.created[0].initialPassword.length >= 8);

  const userId = imported.data.created[0].id;
  const updated = await request(admin, `/api/admin/users/${userId}/identity`, {
    method: 'PATCH', body: JSON.stringify({ name: '更正姓名', grade: '2027级', gender: 'MALE', major: '人工智能', reason: '测试身份更正' }),
  });
  assert.equal(updated.response.status, 200);

  const users = await request(admin, '/api/admin/users');
  const user = users.data.users.find((item) => item.id === userId);
  assert.equal(user.name, '更正姓名');
  assert.equal(user.grade, '2027级');
  assert.equal(user.gender, 'MALE');
  assert.equal(user.major, '人工智能');
  assert.equal(user.status, 'PENDING_ACTIVATION');

  const student = await login('2026002', 'Student123!');
  const stageDormitory = await request(student, '/api/dormitories', {
    method: 'POST', body: JSON.stringify({ name: '阶段测试宿舍', capacity: 8, building: '学生不可设置' }),
  });
  assert.equal(stageDormitory.response.status, 201);
  assert.equal(stageDormitory.data.dormitory.capacity, 4);
  assert.equal(stageDormitory.data.dormitory.building, '');

  const assigned = await request(admin, `/api/admin/dormitories/${stageDormitory.data.dormitory.id}/location`, {
    method: 'PATCH', body: JSON.stringify({ building: '北苑 3 号楼', roomNumber: '301', reason: '测试统一分配' }),
  });
  assert.equal(assigned.response.status, 200);
  assert.equal(assigned.data.dormitory.building, '北苑 3 号楼');
  assert.equal(assigned.data.dormitory.room_number, '301');

  const exportResponse = await fetch(`${baseUrl}/api/admin/dormitories/export`, {
    headers: { Cookie: admin.cookie },
  });
  assert.equal(exportResponse.status, 200);
  assert.equal(exportResponse.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(exportResponse.headers.get('content-disposition'), /^attachment; filename="dormitories-\d{4}-\d{2}-\d{2}\.xlsx"$/);
  const workbook = Buffer.from(await exportResponse.arrayBuffer());
  assert.equal(workbook.readUInt32LE(0), 0x04034b50);
  assert.ok(workbook.includes(Buffer.from('[Content_Types].xml')));
  assert.ok(workbook.includes(Buffer.from('宿舍列表')));
  assert.ok(workbook.includes(Buffer.from('北苑 3 号楼')));

  const studentExport = await fetch(`${baseUrl}/api/admin/dormitories/export`, {
    headers: { Cookie: student.cookie },
  });
  assert.equal(studentExport.status, 403);

  const stageClosed = await request(admin, '/api/admin/settings/dormitory-selection', {
    method: 'PATCH', body: JSON.stringify({ open: false, reason: '测试关闭阶段' }),
  });
  assert.equal(stageClosed.response.status, 200);
  assert.equal(stageClosed.data.open, false);

  const otherStudent = await login('2026003', 'Student123!');
  const forbidden = await request(otherStudent, '/api/dormitories', {
    method: 'POST', body: JSON.stringify({ name: '不应创建', capacity: 4 }),
  });
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.data.error.code, 'DORMITORY_SELECTION_CLOSED');

  const leaveForbidden = await request(student, '/api/me/dormitory/leave', { method: 'POST', body: '{}' });
  assert.equal(leaveForbidden.response.status, 403);
  assert.equal(leaveForbidden.data.error.code, 'DORMITORY_SELECTION_CLOSED');
});
