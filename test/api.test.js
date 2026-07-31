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

  const presetMembers = users.data.users.filter((item) => ['2026002', '2026004'].includes(item.login_identifier));
  const createdSelectionGroup = await request(admin, '/api/admin/student-selection-groups', {
    method: 'POST', body: JSON.stringify({
      name: '第一批测试学生', description: '用于重复选人', memberIds: presetMembers.map((item) => item.id),
    }),
  });
  assert.equal(createdSelectionGroup.response.status, 201);
  assert.deepEqual(new Set(createdSelectionGroup.data.group.members.map((item) => item.login_identifier)), new Set(['2026002', '2026004']));
  const duplicateSelectionGroup = await request(admin, '/api/admin/student-selection-groups', {
    method: 'POST', body: JSON.stringify({ name: '第一批测试学生', memberIds: [presetMembers[0].id] }),
  });
  assert.equal(duplicateSelectionGroup.response.status, 409);
  assert.equal(duplicateSelectionGroup.data.error.code, 'DUPLICATE_SELECTION_GROUP_NAME');
  const updatedSelectionGroup = await request(admin, `/api/admin/student-selection-groups/${createdSelectionGroup.data.group.id}`, {
    method: 'PATCH', body: JSON.stringify({
      name: '第一批测试学生', description: '更新后的预设群组', memberIds: [presetMembers[0].id], reason: '测试更新群组',
    }),
  });
  assert.equal(updatedSelectionGroup.response.status, 200);
  assert.equal(updatedSelectionGroup.data.group.members.length, 1);
  const selectionGroups = await request(admin, '/api/admin/student-selection-groups');
  assert.equal(selectionGroups.response.status, 200);
  assert.equal(selectionGroups.data.groups.find((item) => item.name === '第一批测试学生').members[0].name, presetMembers[0].name);

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
  assert.match(exportResponse.headers.get('content-disposition'), /^attachment; filename="dormitories-LEGACY_INITIAL-\d{4}-\d{2}-\d{2}\.xlsx"$/);
  const workbook = Buffer.from(await exportResponse.arrayBuffer());
  assert.equal(workbook.readUInt32LE(0), 0x04034b50);
  assert.ok(workbook.includes(Buffer.from('[Content_Types].xml')));
  assert.ok(workbook.includes(Buffer.from('宿舍列表')));
  assert.ok(workbook.includes(Buffer.from('北苑 3 号楼')));

  const studentExport = await fetch(`${baseUrl}/api/admin/dormitories/export`, {
    headers: { Cookie: student.cookie },
  });
  assert.equal(studentExport.status, 403);

  const rounds = await request(admin, '/api/admin/dormitory-rounds');
  const firstRound = rounds.data.rounds.find((round) => round.code === 'LEGACY_INITIAL');
  assert.equal(firstRound.status, 'OPEN');
  const stageClosed = await request(admin, `/api/admin/dormitory-rounds/${firstRound.id}/close`, {
    method: 'POST', body: JSON.stringify({ reason: '测试截止第一轮' }),
  });
  assert.equal(stageClosed.response.status, 200);
  assert.equal(stageClosed.data.round.status, 'CLOSED');

  const otherStudent = await login('2026003', 'Student123!');
  const forbidden = await request(otherStudent, '/api/dormitories', {
    method: 'POST', body: JSON.stringify({ name: '不应创建', capacity: 4 }),
  });
  assert.equal(forbidden.response.status, 403);
  assert.equal(forbidden.data.error.code, 'DORMITORY_SELECTION_CLOSED');

  const leaveForbidden = await request(student, '/api/me/dormitory/leave', { method: 'POST', body: '{}' });
  assert.equal(leaveForbidden.response.status, 403);
  assert.equal(leaveForbidden.data.error.code, 'DORMITORY_SELECTION_CLOSED');

  const archived = await request(admin, `/api/admin/dormitory-rounds/${firstRound.id}/archive`, {
    method: 'POST', body: JSON.stringify({ reason: '保留第一轮宿舍结果' }),
  });
  assert.equal(archived.response.status, 200);
  assert.equal(archived.data.round.status, 'ARCHIVED');
  assert.equal(archived.data.snapshotCount, 1);

  const firstRoundResults = await request(student, `/api/dormitory-rounds/${firstRound.id}/results`);
  assert.equal(firstRoundResults.response.status, 200);
  assert.equal(firstRoundResults.data.dormitories[0].name, '阶段测试宿舍');
  assert.equal(firstRoundResults.data.dormitories[0].building, '北苑 3 号楼');
  assert.equal(firstRoundResults.data.dormitories[0].members[0].login_identifier, '2026002');

  const participantIds = users.data.users
    .filter((item) => item.account_type === 'USER' && item.login_identifier !== '2026003')
    .map((item) => item.id);
  const createdSecondRound = await request(admin, '/api/admin/dormitory-rounds', {
    method: 'POST',
    body: JSON.stringify({
      code: 'SECOND_ROUND', name: '第二轮选宿舍', description: '同一批学生再次选宿舍', participantIds,
    }),
  });
  assert.equal(createdSecondRound.response.status, 201);
  const secondRoundId = createdSecondRound.data.round.id;
  const openedSecondRound = await request(admin, `/api/admin/dormitory-rounds/${secondRoundId}/open`, {
    method: 'POST', body: JSON.stringify({ reason: '开始第二轮测试' }),
  });
  assert.equal(openedSecondRound.response.status, 200);
  assert.equal(openedSecondRound.data.round.status, 'OPEN');

  const secondRoundDormitory = await request(student, '/api/dormitories', {
    method: 'POST', body: JSON.stringify({ name: '第二轮测试宿舍' }),
  });
  assert.equal(secondRoundDormitory.response.status, 201);
  assert.equal(secondRoundDormitory.data.dormitory.selection_round_id, secondRoundId);
  const duplicateInSecondRound = await request(student, '/api/dormitories', {
    method: 'POST', body: JSON.stringify({ name: '同一轮不应重复创建' }),
  });
  assert.equal(duplicateInSecondRound.response.status, 409);
  assert.equal(duplicateInSecondRound.data.error.code, 'ALREADY_IN_DORMITORY');

  const nonParticipant = await request(otherStudent, '/api/dormitories', {
    method: 'POST', body: JSON.stringify({ name: '未参与本轮' }),
  });
  assert.equal(nonParticipant.response.status, 403);
  assert.equal(nonParticipant.data.error.code, 'ROUND_PARTICIPATION_REQUIRED');

  const anotherDraft = await request(admin, '/api/admin/dormitory-rounds', {
    method: 'POST', body: JSON.stringify({ code: 'FUTURE_ROUND', name: '后续轮次', participantIds }),
  });
  assert.equal(anotherDraft.response.status, 201);
  const simultaneousOpen = await request(admin, `/api/admin/dormitory-rounds/${anotherDraft.data.round.id}/open`, {
    method: 'POST', body: JSON.stringify({ reason: '不应同时开放两轮' }),
  });
  assert.equal(simultaneousOpen.response.status, 409);
  assert.equal(simultaneousOpen.data.error.code, 'ROUND_ALREADY_OPEN');

  const retainedFirstRoundResults = await request(student, `/api/dormitory-rounds/${firstRound.id}/results`);
  assert.equal(retainedFirstRoundResults.data.dormitories[0].name, '阶段测试宿舍');
  const secondRoundResults = await request(student, `/api/dormitory-rounds/${secondRoundId}/results`);
  assert.equal(secondRoundResults.data.dormitories[0].name, '第二轮测试宿舍');
  const deletedSelectionGroup = await request(admin, `/api/admin/student-selection-groups/${createdSelectionGroup.data.group.id}`, {
    method: 'DELETE', body: JSON.stringify({ reason: '完成预设群组删除验收' }),
  });
  assert.equal(deletedSelectionGroup.response.status, 200);
  const selectionGroupsAfterDelete = await request(admin, '/api/admin/student-selection-groups');
  assert.equal(selectionGroupsAfterDelete.data.groups.some((item) => item.id === createdSelectionGroup.data.group.id), false);
});

test('administrator groups enforce permission and grade scope from the same group', async () => {
  const superAdmin = await login('admin', 'Admin123!');
  assert.equal(superAdmin.user.accountType, 'SUPER_ADMIN');
  assert.equal(superAdmin.user.isSuperAdmin, true);
  assert.equal(superAdmin.user.canManage, true);

  const gradesResult = await request(superAdmin, '/api/admin/grades');
  const grade2025 = gradesResult.data.grades.find((grade) => grade.name === '2025级');
  const grade2026 = gradesResult.data.grades.find((grade) => grade.name === '2026级');
  assert.ok(grade2025?.id);
  assert.ok(grade2026?.id);

  const usersResult = await request(superAdmin, '/api/admin/users');
  const groupAdminUser = usersResult.data.users.find((user) => user.login_identifier === '2026001');
  const protectedGroupAdmin = usersResult.data.users.find((user) => user.login_identifier === '2026003');
  const grade2026Target = usersResult.data.users.find((user) => user.login_identifier === '2026005');
  const grade2025Target = usersResult.data.users.find((user) => user.login_identifier === '2026004');

  async function createGroup(code, permissions, gradeIds, userIds) {
    const created = await request(superAdmin, '/api/admin/admin-groups', {
      method: 'POST', body: JSON.stringify({ code, name: code, description: '权限边界测试' }),
    });
    assert.equal(created.response.status, 201);
    const groupId = created.data.group.id;
    for (const [section, body] of [
      ['permissions', { permissions }], ['scopes', { gradeIds }], ['members', { userIds }],
    ]) {
      const configured = await request(superAdmin, `/api/admin/admin-groups/${groupId}/${section}`, {
        method: 'PUT', body: JSON.stringify({ ...body, reason: '自动化权限测试' }),
      });
      assert.equal(configured.response.status, 200);
    }
    return groupId;
  }

  const identityGroupId = await createGroup(
    'IDENTITY_2026', ['USER_IDENTITY_UPDATE', 'USER_STATUS_UPDATE'], [grade2026.id], [groupAdminUser.id],
  );
  const readGroupId = await createGroup(
    'READ_2025', ['USER_READ', 'AUDIT_READ_SCOPED'], [grade2025.id], [groupAdminUser.id, protectedGroupAdmin.id],
  );
  const dormitoryGroupId = await createGroup(
    'DORMITORY_2026',
    ['DORMITORY_READ', 'DORMITORY_LOCATION_ASSIGN', 'DORMITORY_CLOSE', 'DORMITORY_EXPORT'],
    [grade2026.id], [groupAdminUser.id],
  );

  const groupAdmin = await login('2026001', 'Student123!');
  assert.equal(groupAdmin.user.accountType, 'USER');
  assert.equal(groupAdmin.user.canManage, true);
  assert.equal(groupAdmin.user.isSuperAdmin, false);
  assert.ok(groupAdmin.user.permissions.includes('USER_READ'));
  assert.ok(groupAdmin.user.permissions.includes('USER_IDENTITY_UPDATE'));

  const disabledIdentityGroup = await request(superAdmin, `/api/admin/admin-groups/${identityGroupId}`, {
    method: 'PATCH', body: JSON.stringify({ name: 'IDENTITY_2026', description: '权限边界测试', status: 'DISABLED', reason: '验证停用立即生效' }),
  });
  assert.equal(disabledIdentityGroup.response.status, 200);
  const disabledPermission = await request(groupAdmin, `/api/admin/users/${grade2026Target.id}/identity`, {
    method: 'PATCH', body: JSON.stringify({
      name: grade2026Target.name, grade: grade2026Target.grade, gender: grade2026Target.gender,
      major: grade2026Target.major, reason: '停用组后不应继续生效',
    }),
  });
  assert.equal(disabledPermission.response.status, 403);
  await request(superAdmin, `/api/admin/admin-groups/${identityGroupId}`, {
    method: 'PATCH', body: JSON.stringify({ name: 'IDENTITY_2026', description: '权限边界测试', status: 'ACTIVE', reason: '继续后续验收' }),
  });
  await request(superAdmin, `/api/admin/admin-groups/${readGroupId}/permissions`, {
    method: 'PUT', body: JSON.stringify({ permissions: ['AUDIT_READ_SCOPED'], reason: '验证撤销权限立即生效' }),
  });
  const revokedReadPermission = await request(groupAdmin, '/api/admin/users');
  assert.equal(revokedReadPermission.response.status, 403);
  await request(superAdmin, `/api/admin/admin-groups/${readGroupId}/permissions`, {
    method: 'PUT', body: JSON.stringify({ permissions: ['USER_READ', 'AUDIT_READ_SCOPED'], reason: '继续后续验收' }),
  });

  const grade2025Student = await login('2026004', 'Student123!');
  const outOfScopeDormitory = await request(grade2025Student, '/api/dormitories', {
    method: 'POST', body: JSON.stringify({ name: '2025范围外宿舍' }),
  });
  assert.equal(outOfScopeDormitory.response.status, 201);
  const scopedDormitories = await request(groupAdmin, '/api/admin/dormitories');
  assert.equal(scopedDormitories.response.status, 200);
  assert.ok(scopedDormitories.data.dormitories.length > 0);
  assert.ok(scopedDormitories.data.dormitories.every((dormitory) => dormitory.management_grade_id === grade2026.id));
  assert.equal(scopedDormitories.data.dormitories.some((dormitory) => dormitory.id === outOfScopeDormitory.data.dormitory.id), false);
  const outOfScopeLocation = await request(groupAdmin, `/api/admin/dormitories/${outOfScopeDormitory.data.dormitory.id}/location`, {
    method: 'PATCH', body: JSON.stringify({ building: '越权楼栋', roomNumber: '999', reason: '不应允许跨年级分配' }),
  });
  assert.equal(outOfScopeLocation.response.status, 404);
  const scopedExportResponse = await fetch(`${baseUrl}/api/admin/dormitories/export`, { headers: { Cookie: groupAdmin.cookie } });
  assert.equal(scopedExportResponse.status, 200);
  const scopedWorkbook = Buffer.from(await scopedExportResponse.arrayBuffer());
  assert.ok(scopedWorkbook.includes(Buffer.from('第二轮测试宿舍')));
  assert.equal(scopedWorkbook.includes(Buffer.from('2025范围外宿舍')), false);

  const scopedUsers = await request(groupAdmin, '/api/admin/users');
  assert.equal(scopedUsers.response.status, 200);
  assert.ok(scopedUsers.data.users.length > 0);
  assert.ok(scopedUsers.data.users.every((user) => user.grade_id === grade2025.id));

  const crossGroupEscalation = await request(groupAdmin, `/api/admin/users/${grade2025Target.id}/identity`, {
    method: 'PATCH', body: JSON.stringify({
      name: grade2025Target.name, grade: '2025级', gender: grade2025Target.gender,
      major: grade2025Target.major, reason: '不应允许跨组拼接授权',
    }),
  });
  assert.equal(crossGroupEscalation.response.status, 404);
  assert.equal(crossGroupEscalation.data.error.code, 'RESOURCE_NOT_FOUND');

  const moveOutOfScope = await request(groupAdmin, `/api/admin/users/${grade2026Target.id}/identity`, {
    method: 'PATCH', body: JSON.stringify({
      name: grade2026Target.name, grade: '2025级', gender: grade2026Target.gender,
      major: grade2026Target.major, reason: '原目标年级必须由同组覆盖',
    }),
  });
  assert.equal(moveOutOfScope.response.status, 404);

  const expandedScope = await request(superAdmin, `/api/admin/admin-groups/${identityGroupId}/scopes`, {
    method: 'PUT', body: JSON.stringify({ gradeIds: [grade2025.id, grade2026.id], reason: '验证同组覆盖两个年级' }),
  });
  assert.equal(expandedScope.response.status, 200);
  const authorizedMove = await request(groupAdmin, `/api/admin/users/${grade2026Target.id}/identity`, {
    method: 'PATCH', body: JSON.stringify({
      name: grade2026Target.name, grade: '2025级', gender: grade2026Target.gender,
      major: grade2026Target.major, reason: '同一组同时覆盖原年级和目标年级',
    }),
  });
  assert.equal(authorizedMove.response.status, 200);

  const selfManagement = await request(groupAdmin, `/api/admin/users/${groupAdminUser.id}/identity`, {
    method: 'PATCH', body: JSON.stringify({
      name: groupAdminUser.name, grade: groupAdminUser.grade, gender: groupAdminUser.gender,
      major: groupAdminUser.major, reason: '不应允许管理自己',
    }),
  });
  assert.equal(selfManagement.response.status, 403);
  assert.equal(selfManagement.data.error.code, 'PROTECTED_ADMIN_ACCOUNT');

  const otherAdminManagement = await request(groupAdmin, `/api/admin/users/${protectedGroupAdmin.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'SUSPENDED', reason: '不应允许管理其他组管理员' }),
  });
  assert.equal(otherAdminManagement.response.status, 403);
  assert.equal(otherAdminManagement.data.error.code, 'PROTECTED_ADMIN_ACCOUNT');

  const globalSetting = await request(groupAdmin, '/api/admin/dormitory-rounds', {
    method: 'POST', body: JSON.stringify({ code: 'UNAUTHORIZED', name: '组管理员不应创建轮次', participantIds: [groupAdminUser.id] }),
  });
  assert.equal(globalSetting.response.status, 403);
  assert.equal(globalSetting.data.error.code, 'SUPER_ADMIN_ONLY');
  const selectionGroupForbidden = await request(groupAdmin, '/api/admin/student-selection-groups');
  assert.equal(selectionGroupForbidden.response.status, 403);
  assert.equal(selectionGroupForbidden.data.error.code, 'SUPER_ADMIN_ONLY');

  const promoted = await request(superAdmin, `/api/admin/users/${grade2025Target.id}/account-type`, {
    method: 'PATCH', body: JSON.stringify({ accountType: 'SUPER_ADMIN', reason: '验证超级管理员账号管理' }),
  });
  assert.equal(promoted.response.status, 200);
  const demoted = await request(superAdmin, `/api/admin/users/${grade2025Target.id}/account-type`, {
    method: 'PATCH', body: JSON.stringify({ accountType: 'USER', reason: '恢复普通用户' }),
  });
  assert.equal(demoted.response.status, 200);

  const auditResult = await request(superAdmin, '/api/admin/audit-logs');
  const identityAudit = auditResult.data.logs.find((log) => log.action === 'UPDATE_IDENTITY' && log.target_id === String(grade2026Target.id));
  assert.ok(identityAudit);
  assert.equal(identityAudit.permission_code, 'USER_IDENTITY_UPDATE');
  assert.equal(identityAudit.grant_group_id, identityGroupId);
  assert.equal(identityAudit.scope_type, 'GRADE');
  assert.deepEqual(new Set(identityAudit.scope_value.split(',').map(Number)), new Set([grade2025.id, grade2026.id]));
  const scopedAudit = await request(groupAdmin, '/api/admin/audit-logs');
  assert.equal(scopedAudit.response.status, 200);
  assert.ok(scopedAudit.data.logs.some((log) => log.id === identityAudit.id));
  assert.ok(scopedAudit.data.logs.every((log) => log.scope_type === 'GRADE' && log.scope_value.split(',').map(Number).includes(grade2025.id)));
  const groupAudit = auditResult.data.logs.find((log) => log.action === 'UPDATE_ADMIN_GROUP_MEMBERS' && log.target_id === String(readGroupId));
  assert.ok(groupAudit);
  assert.equal(groupAudit.permission_code, 'SUPER_ADMIN');
  assert.ok(groupAudit.request_id);

  const lastSuperAdmin = await request(superAdmin, `/api/admin/users/${superAdmin.user.id}/status`, {
    method: 'PATCH', body: JSON.stringify({ status: 'SUSPENDED', reason: '验证最后一个超级管理员保护' }),
  });
  assert.equal(lastSuperAdmin.response.status, 409);
  assert.equal(lastSuperAdmin.data.error.code, 'LAST_SUPER_ADMIN');
  const lastSuperAdminDowngrade = await request(superAdmin, `/api/admin/users/${superAdmin.user.id}/account-type`, {
    method: 'PATCH', body: JSON.stringify({ accountType: 'USER', reason: '验证最后一个超级管理员降级保护' }),
  });
  assert.equal(lastSuperAdminDowngrade.response.status, 409);
  assert.equal(lastSuperAdminDowngrade.data.error.code, 'LAST_SUPER_ADMIN');
  const lastSuperAdminDelete = await request(superAdmin, `/api/admin/users/${superAdmin.user.id}`, {
    method: 'DELETE', body: JSON.stringify({ confirmation: 'admin', reason: '验证最后一个超级管理员删除保护' }),
  });
  assert.equal(lastSuperAdminDelete.response.status, 409);
  assert.equal(lastSuperAdminDelete.data.error.code, 'LAST_SUPER_ADMIN');

  for (const groupId of [identityGroupId, readGroupId, dormitoryGroupId]) {
    const revoked = await request(superAdmin, `/api/admin/admin-groups/${groupId}/members`, {
      method: 'PUT', body: JSON.stringify({ userIds: groupId === readGroupId ? [protectedGroupAdmin.id] : [], reason: '验证权限即时失效' }),
    });
    assert.equal(revoked.response.status, 200);
  }
  const revokedImmediately = await request(groupAdmin, '/api/admin/overview');
  assert.equal(revokedImmediately.response.status, 403);
  assert.equal(revokedImmediately.data.error.code, 'MANAGEMENT_FORBIDDEN');
  const studentSideStillAvailable = await request(groupAdmin, '/api/me/roommate-card');
  assert.equal(studentSideStillAvailable.response.status, 200);

  const roundList = await request(superAdmin, '/api/admin/dormitory-rounds');
  const secondRound = roundList.data.rounds.find((round) => round.code === 'SECOND_ROUND');
  const closedSecondRound = await request(superAdmin, `/api/admin/dormitory-rounds/${secondRound.id}/close`, {
    method: 'POST', body: JSON.stringify({ reason: '验证归档快照' }),
  });
  assert.equal(closedSecondRound.response.status, 200);
  const deleteBeforeArchive = await request(superAdmin, `/api/admin/users/${grade2025Target.id}`, {
    method: 'DELETE', body: JSON.stringify({ confirmation: grade2025Target.login_identifier, reason: '未归档前不应删除结果成员' }),
  });
  assert.equal(deleteBeforeArchive.response.status, 409);
  assert.equal(deleteBeforeArchive.data.error.code, 'UNARCHIVED_DORMITORY_RESULT');
  const archivedSecondRound = await request(superAdmin, `/api/admin/dormitory-rounds/${secondRound.id}/archive`, {
    method: 'POST', body: JSON.stringify({ reason: '生成第二轮不可变结果' }),
  });
  assert.equal(archivedSecondRound.response.status, 200);
  const deletedSnapshotMember = await request(superAdmin, `/api/admin/users/${grade2025Target.id}`, {
    method: 'DELETE', body: JSON.stringify({ confirmation: grade2025Target.login_identifier, reason: '验证归档后删除账号仍保留结果' }),
  });
  assert.equal(deletedSnapshotMember.response.status, 200);
  const resultViewer = await login('2026002', 'Student123!');
  const resultsAfterDelete = await request(resultViewer, `/api/dormitory-rounds/${secondRound.id}/results`);
  const preservedDormitory = resultsAfterDelete.data.dormitories.find((item) => item.name === '2025范围外宿舍');
  assert.ok(preservedDormitory);
  assert.equal(preservedDormitory.initiator_name, grade2025Target.name);
  assert.equal(preservedDormitory.members[0].login_identifier, grade2025Target.login_identifier);
  assert.equal(preservedDormitory.members[0].user_id, null);

  const deletedFormerAdmin = await request(superAdmin, `/api/admin/users/${groupAdminUser.id}`, {
    method: 'DELETE', body: JSON.stringify({ confirmation: groupAdminUser.login_identifier, reason: '验证永久删除保留审计记录' }),
  });
  assert.equal(deletedFormerAdmin.response.status, 200);
  const auditAfterDelete = await request(superAdmin, '/api/admin/audit-logs');
  const preservedAudit = auditAfterDelete.data.logs.find((log) => log.id === identityAudit.id);
  assert.ok(preservedAudit);
  assert.equal(preservedAudit.admin_id, null);
  assert.equal(preservedAudit.admin_name, groupAdminUser.name);
});
