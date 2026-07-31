const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase, hashPassword } = require('./db');
const { createDormitoryWorkbook } = require('./xlsx');

const db = openDatabase();
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const APP_VERSION = process.env.APP_VERSION || '';
const SESSION_DAYS = 7;
const PERMISSIONS = Object.freeze({
  USER_READ: '查看用户',
  USER_IMPORT: '导入普通用户',
  USER_IDENTITY_UPDATE: '修改用户身份信息',
  USER_STATUS_UPDATE: '修改用户状态',
  CARD_READ: '查看卡片',
  CARD_MODERATE: '隐藏或恢复卡片',
  DORMITORY_READ: '查看宿舍',
  DORMITORY_LOCATION_ASSIGN: '分配宿舍位置',
  DORMITORY_CLOSE: '关闭宿舍',
  DORMITORY_EXPORT: '导出宿舍列表',
  REPORT_READ: '查看举报',
  REPORT_RESOLVE: '处理举报',
  AUDIT_READ_SCOPED: '查看范围内审计日志',
});

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function now() {
  return new Date().toISOString();
}

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index > -1) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1));
  }
  return cookies;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        reject(new HttpError(413, 'BODY_TOO_LARGE', '请求内容过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'INVALID_JSON', '请求内容不是有效的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function authenticate(req, requireCsrf = false) {
  const token = parseCookies(req).session;
  if (!token) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
  const session = db.prepare(`
    SELECT s.token_hash, s.csrf_token, s.expires_at,
           u.id, u.login_identifier, u.account_type, u.authorization_version,
           u.must_change_password, u.name, u.grade, u.grade_id, u.gender, u.major, u.status
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ?
  `).get(tokenHash(token));
  if (!session || session.expires_at <= now()) throw new HttpError(401, 'SESSION_EXPIRED', '登录已过期');
  if (!['ACTIVE', 'PENDING_ACTIVATION'].includes(session.status)) {
    throw new HttpError(403, 'ACCOUNT_UNAVAILABLE', '账号当前不可用');
  }
  if (requireCsrf && req.headers['x-csrf-token'] !== session.csrf_token) {
    throw new HttpError(403, 'INVALID_CSRF_TOKEN', '请求校验失败，请刷新后重试');
  }
  return session;
}

function requireUser(user) {
  if (user.account_type !== 'USER') throw new HttpError(403, 'USER_ONLY', '仅普通用户可执行此操作');
}

function activeAdminGroups(userId) {
  const rows = db.prepare(`
    SELECT g.id, g.code, g.name, g.description
    FROM admin_groups g JOIN admin_group_members m ON m.group_id = g.id
    WHERE m.user_id = ? AND g.status = 'ACTIVE' ORDER BY g.id
  `).all(userId);
  return rows.map((group) => ({
    ...group,
    permissions: db.prepare('SELECT permission_code FROM admin_group_permissions WHERE group_id = ? ORDER BY permission_code')
      .all(group.id).map((item) => item.permission_code),
    gradeIds: db.prepare("SELECT scope_value FROM admin_group_scopes WHERE group_id = ? AND scope_type = 'GRADE' ORDER BY scope_value")
      .all(group.id).map((item) => Number(item.scope_value)),
  }));
}

function managementProfile(user) {
  const superAdmin = user.account_type === 'SUPER_ADMIN';
  const groups = superAdmin ? [] : activeAdminGroups(user.id);
  return {
    isSuperAdmin: superAdmin,
    canManage: superAdmin || groups.length > 0,
    permissions: superAdmin ? Object.keys(PERMISSIONS) : [...new Set(groups.flatMap((group) => group.permissions))],
    groups,
  };
}

function requireManagement(user) {
  if (!managementProfile(user).canManage) throw new HttpError(403, 'MANAGEMENT_FORBIDDEN', '当前账号没有管理权限');
}

function requireSuperAdmin(user) {
  if (user.account_type !== 'SUPER_ADMIN') {
    throw new HttpError(403, 'SUPER_ADMIN_ONLY', '仅超级管理员可执行此操作');
  }
  return { permissionCode: 'SUPER_ADMIN', groupId: null, scopeType: '', scopeValue: '' };
}

function authorize(user, permissionCode, gradeIds) {
  if (!Object.hasOwn(PERMISSIONS, permissionCode)) throw new Error(`Unknown permission: ${permissionCode}`);
  const targetGradeIds = [...new Set((Array.isArray(gradeIds) ? gradeIds : [gradeIds]).map(Number).filter(Number.isInteger))];
  if (user.account_type === 'SUPER_ADMIN') {
    return {
      permissionCode, groupId: null,
      scopeType: targetGradeIds.length ? 'GRADE' : '', scopeValue: targetGradeIds.join(','),
    };
  }
  const groups = activeAdminGroups(user.id);
  const candidates = groups.filter((group) => group.permissions.includes(permissionCode));
  if (!candidates.length) throw new HttpError(403, 'PERMISSION_DENIED', '当前账号缺少所需管理权限');
  const group = candidates.find((item) => targetGradeIds.length > 0 && targetGradeIds.every((gradeId) => item.gradeIds.includes(gradeId)));
  if (!group) throw new HttpError(404, 'RESOURCE_NOT_FOUND', '资源不存在');
  return { permissionCode, groupId: group.id, scopeType: 'GRADE', scopeValue: targetGradeIds.join(',') };
}

function authorizedGradeIds(user, permissionCode) {
  if (user.account_type === 'SUPER_ADMIN') return null;
  return [...new Set(activeAdminGroups(user.id)
    .filter((group) => group.permissions.includes(permissionCode))
    .flatMap((group) => group.gradeIds))];
}

function isEffectiveGroupAdmin(userId) {
  return Boolean(db.prepare(`
    SELECT 1 FROM admin_group_members m JOIN admin_groups g ON g.id = m.group_id
    WHERE m.user_id = ? AND g.status = 'ACTIVE' LIMIT 1
  `).get(userId));
}

function gradeByText(value, create = false) {
  const text = cleanText(value, 20, true);
  let grade = db.prepare('SELECT * FROM grades WHERE code = ? OR name = ?').get(text, text);
  if (!grade && create) {
    const timestamp = now();
    const id = Number(db.prepare(`INSERT INTO grades (code, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
      .run(text, text, timestamp, timestamp).lastInsertRowid);
    grade = db.prepare('SELECT * FROM grades WHERE id = ?').get(id);
  }
  return grade;
}

function audit(admin, req, action, targetType, targetId, reason = '', metadata = {}, grant = {}, snapshots = {}) {
  db.prepare(`
    INSERT INTO audit_logs (
      admin_id, admin_name_snapshot, action, target_type, target_id, reason, metadata, ip_address, user_agent,
      request_id, permission_code, grant_group_id, scope_type, scope_value, result,
      before_snapshot, after_snapshot, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    admin.id, admin.name || '', action, targetType, String(targetId), reason, JSON.stringify(metadata),
    req.socket.remoteAddress || '', req.headers['user-agent'] || '', req.headers['x-request-id'] || crypto.randomUUID(),
    grant.permissionCode || '', grant.groupId || null, grant.scopeType || '', grant.scopeValue || '',
    snapshots.result || 'SUCCESS', JSON.stringify(snapshots.before || {}), JSON.stringify(snapshots.after || {}), now(),
  );
}

function transaction(callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function cardFromRow(row) {
  return row || null;
}

const CARD_SELECT = `
  SELECT c.id, c.user_id, c.avatar_url,
    c.origin_province, c.origin_city, c.clothing_size,
    c.summer_temp_min, c.summer_temp_max, c.winter_temp_min, c.winter_temp_max,
    c.wake_up_time, c.sleep_time, c.nap_habit,
    c.personal_cleanliness, c.roommate_cleanliness, c.common_space_maintenance, c.unacceptable_hygiene,
    c.one_sentence_intro, c.personality_text, c.roommate_personality_text, c.interests_text,
    c.gaming_self, c.gaming_roommate, c.keyboard_noise_text, c.media_noise_text,
    c.self_acknowledged_shortcoming, c.additional_note,
    c.status, c.hidden_reason, c.published_at, c.created_at, c.updated_at,
    u.name, u.grade, u.grade_id, u.gender, u.major, u.status AS user_status,
    MAX(1, (
      SELECT COUNT(*) FROM dormitory_members peers
      WHERE peers.dormitory_id = (
        SELECT own.dormitory_id FROM dormitory_members own
        WHERE own.user_id = c.user_id AND own.selection_round_id = (
          SELECT id FROM dormitory_selection_rounds WHERE status = 'OPEN' ORDER BY id DESC LIMIT 1
        ) LIMIT 1
      )
    )) AS team_member_count
  FROM roommate_cards c JOIN users u ON u.id = c.user_id
`;

function getCardByUser(userId) {
  return cardFromRow(db.prepare(`${CARD_SELECT} WHERE c.user_id = ?`).get(userId));
}

function getCard(cardId) {
  return cardFromRow(db.prepare(`${CARD_SELECT} WHERE c.id = ?`).get(cardId));
}

function hasBlock(userA, userB) {
  return Boolean(db.prepare(`
    SELECT 1 FROM blocks
    WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)
  `).get(userA, userB, userB, userA));
}

function getConversation(conversationId, userId) {
  const conversation = db.prepare(`
    SELECT * FROM conversations
    WHERE id = ? AND (student_a_id = ? OR student_b_id = ?)
  `).get(conversationId, userId, userId);
  if (!conversation) throw new HttpError(404, 'CONVERSATION_NOT_FOUND', '会话不存在');
  return conversation;
}

function activeDormitoryRound() {
  return db.prepare(`
    SELECT r.*, (SELECT COUNT(*) FROM dormitory_round_participants WHERE round_id = r.id) AS participant_count
    FROM dormitory_selection_rounds r WHERE r.status = 'OPEN' ORDER BY r.id DESC LIMIT 1
  `).get() || null;
}

function requireDormitorySelectionOpen(userId = null) {
  const round = activeDormitoryRound();
  if (!round) {
    throw new HttpError(403, 'DORMITORY_SELECTION_CLOSED', '自由选宿舍阶段已关闭');
  }
  if (userId && !db.prepare('SELECT 1 FROM dormitory_round_participants WHERE round_id = ? AND user_id = ?').get(round.id, userId)) {
    throw new HttpError(403, 'ROUND_PARTICIPATION_REQUIRED', '你不在当前选宿舍轮次的参与名单中');
  }
  return round;
}

function studentDormitoryRound(userId, requestedRoundId = null, required = true) {
  const round = requestedRoundId
    ? db.prepare(`
        SELECT r.* FROM dormitory_selection_rounds r
        JOIN dormitory_round_participants p ON p.round_id = r.id
        WHERE r.id = ? AND p.user_id = ? AND r.status != 'DRAFT'
      `).get(requestedRoundId, userId)
    : db.prepare(`
        SELECT r.* FROM dormitory_selection_rounds r
        JOIN dormitory_round_participants p ON p.round_id = r.id
        WHERE p.user_id = ? AND r.status != 'DRAFT'
        ORDER BY CASE r.status WHEN 'OPEN' THEN 0 WHEN 'CLOSED' THEN 1 ELSE 2 END, r.id DESC LIMIT 1
      `).get(userId);
  if (!round && required) throw new HttpError(404, 'DORMITORY_ROUND_NOT_FOUND', '选宿舍轮次不存在');
  return round;
}

function currentDormitoryForUser(userId, roundId = activeDormitoryRound()?.id) {
  if (!roundId) return null;
  return db.prepare(`
    SELECT d.*, dm.role AS current_user_role, dm.joined_at
    FROM dormitories d JOIN dormitory_members dm ON dm.dormitory_id = d.id
    WHERE dm.user_id = ? AND dm.selection_round_id = ?
    LIMIT 1
  `).get(userId, roundId);
}

function dormitoryDetails(dormitoryId, viewerId = null) {
  const dormitory = db.prepare(`
    SELECT d.*, u.name AS initiator_name,
      (SELECT COUNT(*) FROM dormitory_members WHERE dormitory_id = d.id) AS member_count
    FROM dormitories d JOIN users u ON u.id = d.initiator_id
    WHERE d.id = ?
  `).get(dormitoryId);
  if (!dormitory) return null;
  dormitory.members = db.prepare(`
    SELECT dm.user_id, dm.role, dm.joined_at, u.name, u.grade, c.avatar_url
    FROM dormitory_members dm JOIN users u ON u.id = dm.user_id
    LEFT JOIN roommate_cards c ON c.user_id = u.id
    WHERE dm.dormitory_id = ? ORDER BY dm.joined_at, dm.user_id
  `).all(dormitoryId);
  dormitory.current_user_role = viewerId
    ? dormitory.members.find((member) => member.user_id === viewerId)?.role || null
    : null;
  dormitory.pending_applications = viewerId === dormitory.initiator_id ? db.prepare(`
    SELECT a.*, u.name AS applicant_name, u.grade AS applicant_grade, c.avatar_url AS applicant_avatar
    FROM dormitory_applications a JOIN users u ON u.id = a.applicant_id
    LEFT JOIN roommate_cards c ON c.user_id = u.id
    WHERE a.dormitory_id = ? AND a.status = 'PENDING' ORDER BY a.created_at
  `).all(dormitoryId) : [];
  return dormitory;
}

function archivedDormitoryResults(roundId) {
  return db.prepare(`
    SELECT s.*, s.id AS snapshot_id, s.source_dormitory_id AS id,
      s.dormitory_name AS name, s.dormitory_status AS status,
      s.initiator_name_snapshot AS initiator_name,
      (SELECT COUNT(*) FROM dormitory_result_members WHERE snapshot_id = s.id) AS member_count
    FROM dormitory_result_snapshots s WHERE s.selection_round_id = ? ORDER BY s.id
  `).all(roundId).map((dormitory) => ({
    ...dormitory,
    members: db.prepare(`
      SELECT source_user_id AS user_id, login_identifier_snapshot AS login_identifier,
        name_snapshot AS name, grade_snapshot AS grade, gender_snapshot AS gender,
        major_snapshot AS major, member_role AS role, joined_at
      FROM dormitory_result_members WHERE snapshot_id = ? ORDER BY joined_at, login_identifier_snapshot
    `).all(dormitory.snapshot_id),
  }));
}

function generateDormitoryRoundSnapshot(roundId) {
  const generatedAt = now();
  db.prepare('DELETE FROM dormitory_result_snapshots WHERE selection_round_id = ?').run(roundId);
  const dormitories = db.prepare(`
    SELECT d.*, u.name AS initiator_name FROM dormitories d
    JOIN users u ON u.id = d.initiator_id WHERE d.selection_round_id = ? ORDER BY d.id
  `).all(roundId);
  const insertSnapshot = db.prepare(`
    INSERT INTO dormitory_result_snapshots (
      selection_round_id, source_dormitory_id, dormitory_code, dormitory_name,
      building, room_number, capacity, dormitory_status, management_grade_id,
      gender, initiator_user_id, initiator_name_snapshot, generated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMember = db.prepare(`
    INSERT INTO dormitory_result_members (
      snapshot_id, source_user_id, login_identifier_snapshot, name_snapshot,
      grade_snapshot, gender_snapshot, major_snapshot, member_role, joined_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const dormitory of dormitories) {
    const snapshotId = Number(insertSnapshot.run(
      roundId, dormitory.id, dormitory.dormitory_code, dormitory.name,
      dormitory.building, dormitory.room_number, dormitory.capacity, dormitory.status,
      dormitory.management_grade_id, dormitory.gender, dormitory.initiator_id,
      dormitory.initiator_name, generatedAt,
    ).lastInsertRowid);
    const members = db.prepare(`
      SELECT dm.user_id, dm.role, dm.joined_at, u.login_identifier, u.name, u.grade, u.gender, u.major
      FROM dormitory_members dm JOIN users u ON u.id = dm.user_id
      WHERE dm.dormitory_id = ? ORDER BY dm.joined_at, dm.user_id
    `).all(dormitory.id);
    for (const member of members) {
      insertMember.run(
        snapshotId, member.user_id, member.login_identifier, member.name, member.grade,
        member.gender, member.major, member.role, member.joined_at,
      );
    }
  }
  return dormitories.length;
}

function refreshDormitoryStatus(dormitoryId) {
  const dormitory = db.prepare(`
    SELECT d.capacity, d.status, (SELECT COUNT(*) FROM dormitory_members WHERE dormitory_id = d.id) AS member_count
    FROM dormitories d WHERE d.id = ?
  `).get(dormitoryId);
  if (!dormitory || dormitory.status === 'CLOSED') return;
  db.prepare(`UPDATE dormitories SET status = ?, updated_at = ? WHERE id = ?`)
    .run(dormitory.member_count >= dormitory.capacity ? 'FULL' : 'OPEN', now(), dormitoryId);
}

function leaveDormitory(userId, roundId = activeDormitoryRound()?.id, reason = '成员退出宿舍') {
  const dormitory = currentDormitoryForUser(userId, roundId);
  if (!dormitory) return null;
  const membership = db.prepare(`SELECT role FROM dormitory_members WHERE dormitory_id = ? AND user_id = ?`).get(dormitory.id, userId);
  db.prepare(`DELETE FROM dormitory_members WHERE dormitory_id = ? AND user_id = ?`).run(dormitory.id, userId);
  if (membership.role === 'INITIATOR') {
    const successor = db.prepare(`
      SELECT user_id FROM dormitory_members WHERE dormitory_id = ? ORDER BY joined_at, user_id LIMIT 1
    `).get(dormitory.id);
    if (successor) {
      db.prepare(`UPDATE dormitory_members SET role = 'INITIATOR' WHERE dormitory_id = ? AND user_id = ?`).run(dormitory.id, successor.user_id);
      db.prepare(`UPDATE dormitories SET initiator_id = ?, updated_at = ? WHERE id = ?`).run(successor.user_id, now(), dormitory.id);
    } else {
      db.prepare(`
        UPDATE messages SET message_type = 'TEXT', application_id = NULL,
          body = '原宿舍已删除 · ' || body
        WHERE application_id IN (SELECT id FROM dormitory_applications WHERE dormitory_id = ?)
      `).run(dormitory.id);
      db.prepare(`DELETE FROM dormitories WHERE id = ?`).run(dormitory.id);
      return { dormitoryId: dormitory.id, reason, deleted: true };
    }
  }
  db.prepare(`
    UPDATE dormitory_applications SET status = 'CANCELLED', updated_at = ?, reviewed_at = ?
    WHERE applicant_id = ? AND status = 'PENDING'
  `).run(now(), now(), userId);
  refreshDormitoryStatus(dormitory.id);
  return { dormitoryId: dormitory.id, reason };
}

function cleanText(value, maxLength, required = false) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new HttpError(400, 'FIELD_REQUIRED', '请完整填写必填信息');
  if (text.length > maxLength) throw new HttpError(400, 'FIELD_TOO_LONG', `内容不能超过 ${maxLength} 个字`);
  return text;
}

function cardInput(body) {
  if (['name', 'grade', 'gender', 'major'].some((field) => Object.hasOwn(body, field))) {
    throw new HttpError(403, 'IDENTITY_FIELDS_READ_ONLY', '姓名、年级、性别和专业只能由管理员修改');
  }
  const number = (value) => (value !== '' && value != null && Number.isFinite(Number(value)) ? Number(value) : null);
  const avatar = cleanText(body.avatar_url, 3_000_000);
  if (avatar && !avatar.startsWith('/assets/') && !/^data:image\/(png|jpeg|webp);base64,/i.test(avatar)) {
    throw new HttpError(400, 'INVALID_AVATAR', '头像格式不受支持');
  }
  const clothingSize = cleanText(body.clothing_size, 8);
  if (clothingSize && !['S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL'].includes(clothingSize)) {
    throw new HttpError(400, 'INVALID_CLOTHING_SIZE', '院服尺码无效');
  }
  const cleanlinessValues = ['BASIC', 'TIDY', 'STRICT'];
  const personalCleanliness = cleanText(body.personal_cleanliness, 20);
  const roommateCleanliness = cleanText(body.roommate_cleanliness, 20);
  if ((personalCleanliness && !cleanlinessValues.includes(personalCleanliness)) ||
      (roommateCleanliness && !cleanlinessValues.includes(roommateCleanliness))) {
    throw new HttpError(400, 'INVALID_CLEANLINESS', '宿舍整洁选项无效');
  }
  const commonSpace = cleanText(body.common_space_maintenance, 20);
  if (commonSpace && !['USABLE', 'RESTORE', 'CLEAN_TOGETHER', 'NEGOTIABLE'].includes(commonSpace)) {
    throw new HttpError(400, 'INVALID_COMMON_SPACE_MAINTENANCE', '公共空间维护选项无效');
  }
  return {
    avatar_url: avatar,
    origin_province: cleanText(body.origin_province, 30),
    origin_city: cleanText(body.origin_city, 30),
    clothing_size: clothingSize,
    summer_temp_min: number(body.summer_temp_min),
    summer_temp_max: number(body.summer_temp_max),
    winter_temp_min: number(body.winter_temp_min),
    winter_temp_max: number(body.winter_temp_max),
    wake_up_time: cleanText(body.wake_up_time, 120),
    sleep_time: cleanText(body.sleep_time, 120),
    nap_habit: cleanText(body.nap_habit, 120),
    personal_cleanliness: personalCleanliness,
    roommate_cleanliness: roommateCleanliness,
    common_space_maintenance: commonSpace,
    unacceptable_hygiene: cleanText(body.unacceptable_hygiene, 300),
    one_sentence_intro: cleanText(body.one_sentence_intro, 100),
    personality_text: cleanText(body.personality_text, 300),
    roommate_personality_text: cleanText(body.roommate_personality_text, 300),
    interests_text: cleanText(body.interests_text, 400),
    gaming_self: cleanText(body.gaming_self, 300),
    gaming_roommate: cleanText(body.gaming_roommate, 300),
    keyboard_noise_text: cleanText(body.keyboard_noise_text, 300),
    media_noise_text: cleanText(body.media_noise_text, 300),
    self_acknowledged_shortcoming: cleanText(body.self_acknowledged_shortcoming, 200),
    additional_note: cleanText(body.additional_note, 500),
  };
}

function validatePublish(card) {
  const temperatures = [
    card.summer_temp_min, card.summer_temp_max, card.winter_temp_min, card.winter_temp_max,
  ];
  if (temperatures.some((value) => !Number.isFinite(value) || value < 10 || value > 35)) {
    throw new HttpError(400, 'INVALID_TEMPERATURE', '空调温度需填写 10 至 35°C 的有效范围');
  }
  if (card.summer_temp_min > card.summer_temp_max || card.winter_temp_min > card.winter_temp_max) {
    throw new HttpError(400, 'INVALID_TEMPERATURE_RANGE', '温度下限不能高于上限');
  }
  if (!card.major || !card.avatar_url || !card.origin_province || !card.origin_city || !card.clothing_size ||
      !card.wake_up_time || !card.sleep_time || !card.nap_habit ||
      !card.personal_cleanliness || !card.roommate_cleanliness || !card.common_space_maintenance ||
      !card.one_sentence_intro || !card.personality_text || !card.roommate_personality_text || !card.interests_text ||
      !card.gaming_self || !card.gaming_roommate || !card.keyboard_noise_text || !card.media_noise_text ||
      !card.self_acknowledged_shortcoming) {
    throw new HttpError(400, 'CARD_INCOMPLETE', '请完整填写所有必填字段后再发布');
  }
}

async function handleApi(req, res, url) {
  const method = req.method;
  const pathname = url.pathname;
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method);

  if (method === 'GET' && pathname === '/api/health') {
    db.prepare('SELECT 1').get();
    return json(res, 200, { status: 'ok', ...(APP_VERSION ? { version: APP_VERSION } : {}) });
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    const body = await readBody(req);
    const identifier = cleanText(body.loginIdentifier, 100, true);
    const password = typeof body.password === 'string' ? body.password : '';
    const user = db.prepare('SELECT * FROM users WHERE login_identifier = ?').get(identifier);
    if (!user) throw new HttpError(401, 'INVALID_CREDENTIALS', '账号或密码错误');
    const candidate = hashPassword(password, user.password_salt).hash;
    if (!crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(user.password_hash, 'hex'))) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', '账号或密码错误');
    }
    if (!['ACTIVE', 'PENDING_ACTIVATION'].includes(user.status)) {
      throw new HttpError(403, 'ACCOUNT_UNAVAILABLE', '账号当前不可用，请联系管理员');
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    const timestamp = now();
    const expires = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    db.prepare(`
      INSERT INTO sessions (token_hash, csrf_token, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(tokenHash(token), csrf, user.id, expires, timestamp);
    db.prepare(`
      UPDATE users SET status = 'ACTIVE', last_login_at = ?, updated_at = ? WHERE id = ?
    `).run(timestamp, timestamp, user.id);
    return json(res, 200, {
      user: {
        id: user.id, accountType: user.account_type, name: user.name, grade: user.grade,
        gradeId: user.grade_id, gender: user.gender, major: user.major, status: 'ACTIVE',
        mustChangePassword: Boolean(user.must_change_password), ...managementProfile(user),
      },
      csrfToken: csrf,
    }, { 'Set-Cookie': `session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}` });
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    const user = authenticate(req, true);
    const token = parseCookies(req).session;
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
    return json(res, 200, { ok: true, userId: user.id }, {
      'Set-Cookie': 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
    });
  }

  const user = authenticate(req, write);

  if (method === 'GET' && pathname === '/api/me') {
    return json(res, 200, {
      user: {
        id: user.id, loginIdentifier: user.login_identifier, accountType: user.account_type,
        name: user.name, grade: user.grade, gradeId: user.grade_id,
        gender: user.gender, major: user.major, status: user.status,
        mustChangePassword: Boolean(user.must_change_password), ...managementProfile(user),
      },
      csrfToken: user.csrf_token,
    });
  }

  if (method === 'PATCH' && pathname === '/api/me/password') {
    const body = await readBody(req);
    const current = cleanText(body.currentPassword, 200, true);
    const next = cleanText(body.newPassword, 200, true);
    if (next.length < 8) throw new HttpError(400, 'WEAK_PASSWORD', '新密码至少需要 8 位');
    const account = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (hashPassword(current, account.password_salt).hash !== account.password_hash) {
      throw new HttpError(400, 'INVALID_CURRENT_PASSWORD', '当前密码不正确');
    }
    const password = hashPassword(next);
    db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, must_change_password = 0, updated_at = ? WHERE id = ?')
      .run(password.hash, password.salt, now(), user.id);
    return json(res, 200, { ok: true });
  }

  if (user.must_change_password) {
    throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', '首次登录后必须先修改初始密码');
  }

  if (method === 'POST' && pathname === '/api/me/deactivate') {
    requireUser(user);
    const body = await readBody(req);
    if (body.confirmation !== '注销账号') throw new HttpError(400, 'CONFIRMATION_REQUIRED', '请输入“注销账号”确认');
    transaction(() => {
      leaveDormitory(user.id, undefined, '成员注销账号');
      db.prepare(`UPDATE users SET status = 'DEACTIVATED', deactivated_at = ?, updated_at = ? WHERE id = ?`)
        .run(now(), now(), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    });
    return json(res, 200, { ok: true }, {
      'Set-Cookie': 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
    });
  }

  if (pathname.startsWith('/api/admin/')) {
    requireManagement(user);
    return handleAdminApi(req, res, url, user);
  }

  requireUser(user);

  if (method === 'GET' && pathname === '/api/me/roommate-card') {
    return json(res, 200, { card: getCardByUser(user.id) });
  }

  if (method === 'PUT' && pathname === '/api/me/roommate-card') {
    const body = await readBody(req);
    const input = cardInput(body);
    const existing = db.prepare('SELECT * FROM roommate_cards WHERE user_id = ?').get(user.id);
    if (existing?.status === 'PUBLISHED') validatePublish({ ...input, major: user.major });
    const timestamp = now();
    const fields = Object.keys(input);
    if (existing) {
      db.prepare(`UPDATE roommate_cards SET ${fields.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE user_id = ?`)
        .run(...fields.map((key) => input[key]), timestamp, user.id);
    } else {
      db.prepare(`
        INSERT INTO roommate_cards (user_id, ${fields.join(', ')}, status, created_at, updated_at)
        VALUES (?, ${fields.map(() => '?').join(', ')}, 'DRAFT', ?, ?)
      `).run(user.id, ...fields.map((key) => input[key]), timestamp, timestamp);
    }
    return json(res, 200, { card: getCardByUser(user.id) });
  }

  if (method === 'POST' && pathname === '/api/me/roommate-card/publish') {
    const card = getCardByUser(user.id);
    if (!card) throw new HttpError(400, 'CARD_NOT_FOUND', '请先填写室友卡片');
    if (card.status === 'HIDDEN') throw new HttpError(403, 'CARD_HIDDEN', '卡片已被管理员隐藏');
    validatePublish(card);
    db.prepare('UPDATE roommate_cards SET status = ?, published_at = ?, updated_at = ? WHERE user_id = ?')
      .run('PUBLISHED', now(), now(), user.id);
    return json(res, 200, { card: getCardByUser(user.id) });
  }

  if (method === 'POST' && pathname === '/api/me/roommate-card/unpublish') {
    throw new HttpError(409, 'CARD_PUBLICATION_PERMANENT', '卡片首次发布后不能取消发布，只能继续修改');
  }

  if (method === 'GET' && pathname === '/api/roommate-cards') {
    const search = (url.searchParams.get('search') || '').trim().toLowerCase();
    const grade = url.searchParams.get('grade') || '';
    const availability = url.searchParams.get('availability') || '';
    const gender = ['MALE', 'FEMALE'].includes(url.searchParams.get('gender')) ? url.searchParams.get('gender') : user.gender;
    let cards = db.prepare(`${CARD_SELECT}
      WHERE u.status = 'ACTIVE' AND u.gender = ?
        AND c.status = 'PUBLISHED'
        AND NOT EXISTS (
          SELECT 1 FROM blocks b
          WHERE (b.blocker_id = ? AND b.blocked_id = u.id)
             OR (b.blocker_id = u.id AND b.blocked_id = ?)
        )
      ORDER BY c.updated_at DESC
    `).all(gender, user.id, user.id).map(cardFromRow).map((card) => ({ ...card, is_own: card.user_id === user.id }));
    if (search) cards = cards.filter((card) => card.name.toLowerCase().includes(search));
    if (grade) cards = cards.filter((card) => card.grade === grade);
    if (availability === 'AVAILABLE') cards = cards.filter((card) => card.team_member_count < 4);
    return json(res, 200, { cards, total: cards.length });
  }

  let match = pathname.match(/^\/api\/roommate-cards\/(\d+)$/);
  if (method === 'GET' && match) {
    const card = getCard(Number(match[1]));
    if (!card || card.user_status !== 'ACTIVE' || card.status !== 'PUBLISHED') {
      throw new HttpError(404, 'CARD_NOT_FOUND', '室友卡片不存在');
    }
    if (hasBlock(user.id, card.user_id)) throw new HttpError(403, 'USER_BLOCKED', '无法查看该用户');
    return json(res, 200, { card });
  }

  match = pathname.match(/^\/api\/roommate-cards\/(\d+)\/conversations$/);
  if (method === 'POST' && match) {
    const card = getCard(Number(match[1]));
    if (!card || card.user_id === user.id || card.user_status !== 'ACTIVE') {
      throw new HttpError(404, 'CARD_NOT_FOUND', '室友卡片不存在');
    }
    if (hasBlock(user.id, card.user_id)) throw new HttpError(403, 'USER_BLOCKED', '无法与该用户联系');
    const [a, b] = [user.id, card.user_id].sort((x, y) => x - y);
    let conversation = db.prepare('SELECT * FROM conversations WHERE student_a_id = ? AND student_b_id = ?').get(a, b);
    if (!conversation) {
      const id = Number(db.prepare(`
        INSERT INTO conversations (student_a_id, student_b_id, created_at) VALUES (?, ?, ?)
      `).run(a, b, now()).lastInsertRowid);
      conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    }
    return json(res, 200, { conversation });
  }

  match = pathname.match(/^\/api\/users\/(\d+)\/conversations$/);
  if (method === 'POST' && match) {
    const other = db.prepare(`SELECT id, status, account_type FROM users WHERE id = ?`).get(Number(match[1]));
    if (!other || other.account_type !== 'USER' || other.status !== 'ACTIVE' || other.id === user.id) {
      throw new HttpError(404, 'USER_NOT_FOUND', '学生账号不存在');
    }
    if (hasBlock(user.id, other.id)) throw new HttpError(403, 'USER_BLOCKED', '无法与该用户联系');
    const [studentA, studentB] = [user.id, other.id].sort((a, b) => a - b);
    let conversation = db.prepare(`SELECT * FROM conversations WHERE student_a_id = ? AND student_b_id = ?`).get(studentA, studentB);
    if (!conversation) {
      const id = Number(db.prepare(`INSERT INTO conversations (student_a_id, student_b_id, created_at) VALUES (?, ?, ?)`)
        .run(studentA, studentB, now()).lastInsertRowid);
      conversation = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id);
    }
    return json(res, 200, { conversation });
  }

  if (method === 'GET' && pathname === '/api/conversations') {
    const conversations = db.prepare(`
      SELECT co.*,
             CASE WHEN co.student_a_id = ? THEN co.student_b_id ELSE co.student_a_id END AS other_user_id,
             u.name AS other_name, u.grade AS other_grade, u.status AS other_status,
             rc.avatar_url AS other_avatar,
             (SELECT body FROM messages WHERE conversation_id = co.id ORDER BY id DESC LIMIT 1) AS last_message,
             (SELECT COUNT(*) FROM messages m
                WHERE m.conversation_id = co.id AND m.sender_id != ?
                  AND m.id > COALESCE((SELECT last_read_message_id FROM conversation_reads
                    WHERE conversation_id = co.id AND user_id = ?), 0)) AS unread_count
      FROM conversations co
      JOIN users u ON u.id = CASE WHEN co.student_a_id = ? THEN co.student_b_id ELSE co.student_a_id END
      LEFT JOIN roommate_cards rc ON rc.user_id = u.id
      WHERE co.student_a_id = ? OR co.student_b_id = ?
      ORDER BY COALESCE(co.last_message_at, co.created_at) DESC
    `).all(user.id, user.id, user.id, user.id, user.id, user.id);
    return json(res, 200, { conversations });
  }

  match = pathname.match(/^\/api\/conversations\/(\d+)\/messages$/);
  if (match && method === 'GET') {
    const conversation = getConversation(Number(match[1]), user.id);
    const messages = db.prepare(`
      SELECT m.*, u.name AS sender_name,
             a.status AS application_status, a.note AS application_note,
             d.id AS dormitory_id, d.name AS dormitory_name, d.dormitory_code,
             d.capacity AS dormitory_capacity, r.name AS selection_round_name, r.status AS selection_round_status,
             (SELECT COUNT(*) FROM dormitory_members WHERE dormitory_id = d.id) AS dormitory_member_count
      FROM messages m JOIN users u ON u.id = m.sender_id
      LEFT JOIN dormitory_applications a ON a.id = m.application_id
      LEFT JOIN dormitories d ON d.id = a.dormitory_id
      LEFT JOIN dormitory_selection_rounds r ON r.id = a.selection_round_id
      WHERE m.conversation_id = ? ORDER BY m.id ASC LIMIT 200
    `).all(conversation.id);
    return json(res, 200, { conversation, messages });
  }

  if (match && method === 'POST') {
    const conversation = getConversation(Number(match[1]), user.id);
    const otherId = conversation.student_a_id === user.id ? conversation.student_b_id : conversation.student_a_id;
    if (hasBlock(user.id, otherId)) throw new HttpError(403, 'USER_BLOCKED', '当前无法发送消息');
    const body = await readBody(req);
    const messageBody = cleanText(body.body, 2000, true);
    const timestamp = now();
    const messageId = Number(db.prepare(`
      INSERT INTO messages (conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)
    `).run(conversation.id, user.id, messageBody, timestamp).lastInsertRowid);
    db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(timestamp, conversation.id);
    return json(res, 201, { message: { id: messageId, conversation_id: conversation.id, sender_id: user.id, body: messageBody, created_at: timestamp } });
  }

  match = pathname.match(/^\/api\/conversations\/(\d+)\/read$/);
  if (match && method === 'POST') {
    const conversation = getConversation(Number(match[1]), user.id);
    const last = db.prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?').get(conversation.id).id || 0;
    db.prepare(`
      INSERT INTO conversation_reads (conversation_id, user_id, last_read_message_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(conversation_id, user_id) DO UPDATE SET last_read_message_id = excluded.last_read_message_id, updated_at = excluded.updated_at
    `).run(conversation.id, user.id, last, now());
    return json(res, 200, { ok: true });
  }

  match = pathname.match(/^\/api\/users\/(\d+)\/blocks$/);
  if (match && method === 'POST') {
    const blockedId = Number(match[1]);
    if (blockedId === user.id) throw new HttpError(400, 'INVALID_TARGET', '不能拉黑自己');
    transaction(() => {
      db.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)')
        .run(user.id, blockedId, now());
      db.prepare(`
        UPDATE dormitory_applications SET status = 'CANCELLED', updated_at = ?
        WHERE status = 'PENDING' AND (
          (applicant_id = ? AND dormitory_id IN (SELECT id FROM dormitories WHERE initiator_id = ?))
          OR (applicant_id = ? AND dormitory_id IN (SELECT id FROM dormitories WHERE initiator_id = ?))
        )
      `).run(now(), user.id, blockedId, blockedId, user.id);
    });
    return json(res, 200, { ok: true });
  }

  if (match && method === 'DELETE') {
    db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(user.id, Number(match[1]));
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/blocks') {
    const blocks = db.prepare(`
      SELECT b.blocked_id AS user_id, b.created_at, u.name, u.grade, c.avatar_url
      FROM blocks b JOIN users u ON u.id = b.blocked_id
      LEFT JOIN roommate_cards c ON c.user_id = u.id
      WHERE b.blocker_id = ? ORDER BY b.created_at DESC
    `).all(user.id);
    return json(res, 200, { blocks });
  }

  if (method === 'POST' && pathname === '/api/reports') {
    const body = await readBody(req);
    const targetType = body.targetType;
    const targetId = Number(body.targetId);
    if (!['ROOMMATE_CARD', 'MESSAGE'].includes(targetType) || !targetId) {
      throw new HttpError(400, 'INVALID_REPORT_TARGET', '举报对象无效');
    }
    let snapshot;
    if (targetType === 'ROOMMATE_CARD') {
      const card = getCard(targetId);
      if (!card) throw new HttpError(404, 'CARD_NOT_FOUND', '室友卡片不存在');
      snapshot = { name: card.name, additional_note: card.additional_note, personality_note: card.personality_note };
    } else {
      const message = db.prepare(`
        SELECT m.id, m.body, m.sender_id, m.conversation_id FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = ? AND (c.student_a_id = ? OR c.student_b_id = ?)
      `).get(targetId, user.id, user.id);
      if (!message) throw new HttpError(404, 'MESSAGE_NOT_FOUND', '消息不存在');
      snapshot = message;
    }
    const id = Number(db.prepare(`
      INSERT INTO reports (reporter_id, target_type, target_id, reason, description, snapshot, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(user.id, targetType, targetId, cleanText(body.reason, 50, true), cleanText(body.description, 500), JSON.stringify(snapshot), now()).lastInsertRowid);
    return json(res, 201, { reportId: id });
  }

  if (method === 'GET' && pathname === '/api/dormitory-selection') {
    const round = activeDormitoryRound();
    const participating = Boolean(round && db.prepare(`
      SELECT 1 FROM dormitory_round_participants WHERE round_id = ? AND user_id = ?
    `).get(round.id, user.id));
    return json(res, 200, { open: participating, round, participating });
  }

  if (method === 'GET' && pathname === '/api/dormitory-rounds') {
    const rounds = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM dormitory_result_snapshots WHERE selection_round_id = r.id) AS result_count
      FROM dormitory_selection_rounds r
      JOIN dormitory_round_participants p ON p.round_id = r.id
      WHERE p.user_id = ? AND r.status != 'DRAFT'
      ORDER BY r.id DESC
    `).all(user.id);
    return json(res, 200, { rounds });
  }

  let roundMatch = pathname.match(/^\/api\/dormitory-rounds\/(\d+)\/results$/);
  if (roundMatch && method === 'GET') {
    const round = studentDormitoryRound(user.id, Number(roundMatch[1]));
    const dormitories = round.status === 'ARCHIVED'
      ? archivedDormitoryResults(round.id)
      : db.prepare('SELECT id FROM dormitories WHERE selection_round_id = ? ORDER BY id').all(round.id)
          .map((item) => dormitoryDetails(item.id, user.id));
    return json(res, 200, { round, dormitories });
  }

  if (method === 'GET' && pathname === '/api/dormitories') {
    const round = studentDormitoryRound(user.id, url.searchParams.get('roundId') ? Number(url.searchParams.get('roundId')) : null, false);
    if (!round) return json(res, 200, { open: false, round: null, dormitories: [] });
    const dormitories = db.prepare(`
      SELECT d.id FROM dormitories d
      WHERE d.selection_round_id = ? AND d.gender = ? AND d.status IN ('OPEN', 'FULL', 'CLOSED')
      ORDER BY d.created_at DESC
    `).all(round.id, user.gender)
      .map((item) => dormitoryDetails(item.id, user.id))
      .sort((left, right) => Number(Boolean(right.current_user_role)) - Number(Boolean(left.current_user_role)));
    return json(res, 200, { open: round.status === 'OPEN', round, dormitories });
  }

  if (method === 'GET' && pathname === '/api/me/dormitory') {
    const round = studentDormitoryRound(user.id, url.searchParams.get('roundId') ? Number(url.searchParams.get('roundId')) : null, false);
    if (!round) return json(res, 200, { open: false, round: null, dormitory: null, applications: [] });
    const dormitory = currentDormitoryForUser(user.id, round.id);
    const applications = db.prepare(`
      SELECT a.*, d.name AS dormitory_name, d.dormitory_code, r.name AS selection_round_name
      FROM dormitory_applications a JOIN dormitories d ON d.id = a.dormitory_id
      JOIN dormitory_selection_rounds r ON r.id = a.selection_round_id
      WHERE a.applicant_id = ? AND a.selection_round_id = ? ORDER BY a.created_at DESC
    `).all(user.id, round.id);
    return json(res, 200, {
      open: round.status === 'OPEN', round,
      dormitory: dormitory ? dormitoryDetails(dormitory.id, user.id) : null,
      applications,
    });
  }

  if (method === 'POST' && pathname === '/api/dormitories') {
    const round = requireDormitorySelectionOpen(user.id);
    if (currentDormitoryForUser(user.id, round.id)) throw new HttpError(409, 'ALREADY_IN_DORMITORY', '你在本轮已经加入一个宿舍');
    const body = await readBody(req);
    const name = cleanText(body.name, 40, true);
    if (!['MALE', 'FEMALE'].includes(user.gender)) throw new HttpError(409, 'GENDER_REQUIRED', '请联系管理员补充性别信息');
    const dormitoryId = transaction(() => {
      const timestamp = now();
      const code = `R${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const id = Number(db.prepare(`
        INSERT INTO dormitories (
          selection_round_id, dormitory_code, name, building, room_number, capacity, initiator_id,
          management_grade_id, gender, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(round.id, code, name, '', '', 4, user.id, user.grade_id, user.gender, timestamp, timestamp).lastInsertRowid);
      db.prepare(`
        INSERT INTO dormitory_members (selection_round_id, dormitory_id, user_id, role, joined_at)
        VALUES (?, ?, ?, 'INITIATOR', ?)
      `).run(round.id, id, user.id, timestamp);
      return id;
    });
    return json(res, 201, { dormitory: dormitoryDetails(dormitoryId, user.id) });
  }

  let dormMatch = pathname.match(/^\/api\/dormitories\/(\d+)$/);
  if (dormMatch && method === 'GET') {
    const dormitory = dormitoryDetails(Number(dormMatch[1]), user.id);
    if (!dormitory) throw new HttpError(404, 'DORMITORY_NOT_FOUND', '宿舍不存在');
    const round = studentDormitoryRound(user.id, dormitory.selection_round_id);
    return json(res, 200, { open: round.status === 'OPEN', round, dormitory });
  }

  dormMatch = pathname.match(/^\/api\/conversations\/(\d+)\/dormitory-applications$/);
  if (dormMatch && method === 'POST') {
    const round = requireDormitorySelectionOpen(user.id);
    if (currentDormitoryForUser(user.id, round.id)) throw new HttpError(409, 'ALREADY_IN_DORMITORY', '你在本轮已经加入一个宿舍');
    const conversation = getConversation(Number(dormMatch[1]), user.id);
    const body = await readBody(req);
    const dormitory = dormitoryDetails(Number(body.dormitoryId), user.id);
    if (!dormitory || dormitory.selection_round_id !== round.id || dormitory.status !== 'OPEN' || dormitory.member_count >= dormitory.capacity) {
      throw new HttpError(409, 'DORMITORY_UNAVAILABLE', '宿舍当前不可申请');
    }
    if (dormitory.gender !== user.gender) throw new HttpError(403, 'SAME_GENDER_REQUIRED', '只能申请加入同性别宿舍');
    const otherId = conversation.student_a_id === user.id ? conversation.student_b_id : conversation.student_a_id;
    if (otherId !== dormitory.initiator_id) {
      throw new HttpError(403, 'INITIATOR_CONVERSATION_REQUIRED', '申请必须发送给宿舍发起人');
    }
    if (hasBlock(user.id, otherId)) throw new HttpError(403, 'USER_BLOCKED', '当前无法发送申请');
    if (db.prepare(`SELECT 1 FROM dormitory_applications WHERE dormitory_id = ? AND applicant_id = ? AND status = 'PENDING'`).get(dormitory.id, user.id)) {
      throw new HttpError(409, 'APPLICATION_EXISTS', '你已提交过待审核申请');
    }
    const note = cleanText(body.note, 300);
    const applicationId = transaction(() => {
      const timestamp = now();
      const id = Number(db.prepare(`
        INSERT INTO dormitory_applications
          (selection_round_id, dormitory_id, applicant_id, conversation_id, note, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)
      `).run(round.id, dormitory.id, user.id, conversation.id, note, timestamp, timestamp).lastInsertRowid);
      const messageId = Number(db.prepare(`
        INSERT INTO messages (conversation_id, sender_id, body, message_type, application_id, created_at)
        VALUES (?, ?, ?, 'DORMITORY_APPLICATION', ?, ?)
      `).run(conversation.id, user.id, note || `申请加入 ${dormitory.name}`, id, timestamp).lastInsertRowid);
      db.prepare(`UPDATE dormitory_applications SET message_id = ? WHERE id = ?`).run(messageId, id);
      db.prepare(`UPDATE conversations SET last_message_at = ? WHERE id = ?`).run(timestamp, conversation.id);
      return id;
    });
    return json(res, 201, { application: db.prepare(`SELECT * FROM dormitory_applications WHERE id = ?`).get(applicationId) });
  }

  dormMatch = pathname.match(/^\/api\/dormitory-applications\/(\d+)\/(approve|reject)$/);
  if (dormMatch && method === 'POST') {
    const round = requireDormitorySelectionOpen(user.id);
    const applicationId = Number(dormMatch[1]);
    const action = dormMatch[2];
    const application = db.prepare(`
      SELECT a.*, d.initiator_id, d.capacity, d.status AS dormitory_status,
        d.gender AS dormitory_gender, applicant.gender AS applicant_gender,
        (SELECT COUNT(*) FROM dormitory_members WHERE dormitory_id = d.id) AS member_count
      FROM dormitory_applications a JOIN dormitories d ON d.id = a.dormitory_id
      JOIN users applicant ON applicant.id = a.applicant_id WHERE a.id = ?
    `).get(applicationId);
    if (!application || application.initiator_id !== user.id) throw new HttpError(403, 'INITIATOR_ONLY', '仅宿舍发起人可以审核申请');
    if (application.selection_round_id !== round.id) throw new HttpError(409, 'ROUND_NOT_OPEN', '该申请所属轮次已经结束');
    if (application.status !== 'PENDING') throw new HttpError(409, 'APPLICATION_REVIEWED', '申请已处理');
    transaction(() => {
      if (action === 'approve') {
        if (application.dormitory_status !== 'OPEN' || application.member_count >= application.capacity) throw new HttpError(409, 'DORMITORY_FULL', '宿舍已满员');
        if (!db.prepare('SELECT 1 FROM dormitory_round_participants WHERE round_id = ? AND user_id = ?').get(round.id, application.applicant_id)) {
          throw new HttpError(409, 'APPLICANT_NOT_PARTICIPATING', '申请人不在本轮参与名单中');
        }
        if (currentDormitoryForUser(application.applicant_id, round.id)) throw new HttpError(409, 'APPLICANT_JOINED_OTHER', '申请人已加入其他宿舍');
        if (application.applicant_gender !== application.dormitory_gender) throw new HttpError(409, 'SAME_GENDER_REQUIRED', '申请人与宿舍性别不一致');
        db.prepare(`
          INSERT INTO dormitory_members (selection_round_id, dormitory_id, user_id, role, joined_at)
          VALUES (?, ?, ?, 'MEMBER', ?)
        `).run(round.id, application.dormitory_id, application.applicant_id, now());
        db.prepare(`
          UPDATE dormitory_applications SET status = 'CANCELLED', updated_at = ?
          WHERE selection_round_id = ? AND applicant_id = ? AND status = 'PENDING' AND id != ?
        `).run(now(), round.id, application.applicant_id, applicationId);
      }
      db.prepare(`
        UPDATE dormitory_applications SET status = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?
      `).run(action === 'approve' ? 'APPROVED' : 'REJECTED', user.id, now(), now(), applicationId);
      refreshDormitoryStatus(application.dormitory_id);
    });
    return json(res, 200, { dormitory: dormitoryDetails(application.dormitory_id, user.id) });
  }

  dormMatch = pathname.match(/^\/api\/dormitories\/(\d+)\/members\/(\d+)$/);
  if (dormMatch && method === 'DELETE') {
    const round = requireDormitorySelectionOpen(user.id);
    const dormitoryId = Number(dormMatch[1]);
    const memberId = Number(dormMatch[2]);
    const dormitory = dormitoryDetails(dormitoryId, user.id);
    if (!dormitory || dormitory.initiator_id !== user.id) throw new HttpError(403, 'INITIATOR_ONLY', '仅宿舍发起人可以移除成员');
    if (dormitory.selection_round_id !== round.id) throw new HttpError(409, 'ROUND_NOT_OPEN', '该宿舍所属轮次已经结束');
    if (memberId === user.id) throw new HttpError(400, 'USE_LEAVE_ENDPOINT', '发起人请使用退出宿舍');
    const result = db.prepare(`DELETE FROM dormitory_members WHERE dormitory_id = ? AND user_id = ?`).run(dormitoryId, memberId);
    if (!result.changes) throw new HttpError(404, 'MEMBER_NOT_FOUND', '宿舍成员不存在');
    refreshDormitoryStatus(dormitoryId);
    return json(res, 200, { dormitory: dormitoryDetails(dormitoryId, user.id) });
  }

  if (method === 'POST' && pathname === '/api/me/dormitory/leave') {
    const round = requireDormitorySelectionOpen(user.id);
    const result = transaction(() => leaveDormitory(user.id, round.id));
    if (!result) throw new HttpError(404, 'DORMITORY_NOT_FOUND', '你尚未加入宿舍');
    return json(res, 200, { ok: true });
  }

  throw new HttpError(404, 'NOT_FOUND', '接口不存在');
}

async function handleAdminApi(req, res, url, admin) {
  const { method } = req;
  const pathname = url.pathname;
  const superGrant = () => requireSuperAdmin(admin);
  const gradeFilter = (rows, permission, field = 'grade_id') => {
    const gradeIds = authorizedGradeIds(admin, permission);
    if (gradeIds === null) return rows;
    if (!gradeIds.length) throw new HttpError(403, 'PERMISSION_DENIED', '当前账号缺少所需管理权限');
    return rows.filter((row) => gradeIds.includes(Number(row[field])));
  };
  const reportRows = () => db.prepare(`
    SELECT r.*, reporter.name AS reporter_name, handler.name AS handler_name,
      CASE r.target_type
        WHEN 'ROOMMATE_CARD' THEN (
          SELECT u.grade_id FROM roommate_cards c JOIN users u ON u.id = c.user_id WHERE c.id = r.target_id
        )
        WHEN 'MESSAGE' THEN (
          SELECT u.grade_id FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = r.target_id
        )
      END AS target_grade_id
    FROM reports r JOIN users reporter ON reporter.id = r.reporter_id
    LEFT JOIN users handler ON handler.id = r.handled_by
    ORDER BY CASE r.status WHEN 'PENDING' THEN 0 ELSE 1 END, r.id DESC
  `).all();
  const groupDetails = (group) => ({
    ...group,
    permissions: db.prepare('SELECT permission_code FROM admin_group_permissions WHERE group_id = ? ORDER BY permission_code')
      .all(group.id).map((item) => item.permission_code),
    scopes: db.prepare(`
      SELECT s.scope_type, s.scope_value, g.name AS grade_name
      FROM admin_group_scopes s LEFT JOIN grades g ON s.scope_type = 'GRADE' AND g.id = CAST(s.scope_value AS INTEGER)
      WHERE s.group_id = ? ORDER BY s.scope_type, s.scope_value
    `).all(group.id),
    members: db.prepare(`
      SELECT u.id, u.login_identifier, u.name, u.grade, u.status
      FROM admin_group_members m JOIN users u ON u.id = m.user_id
      WHERE m.group_id = ? ORDER BY u.name, u.id
    `).all(group.id),
  });
  const selectionGroupDetails = (group) => ({
    ...group,
    members: db.prepare(`
      SELECT u.id, u.login_identifier, u.name, u.grade, u.status
      FROM student_selection_group_members m JOIN users u ON u.id = m.user_id
      WHERE m.group_id = ? ORDER BY u.name, u.id
    `).all(group.id),
  });

  if (method === 'GET' && pathname === '/api/admin/overview') {
    const overviewFilter = (rows, permission, field = 'grade_id') => {
      const gradeIds = authorizedGradeIds(admin, permission);
      if (gradeIds === null) return rows;
      return rows.filter((row) => gradeIds.includes(Number(row[field])));
    };
    const scopedCount = (permission, query, field = 'grade_id') => overviewFilter(db.prepare(query).all(), permission, field).length;
    const currentRound = activeDormitoryRound() || db.prepare(`
      SELECT * FROM dormitory_selection_rounds WHERE status != 'DRAFT' ORDER BY id DESC LIMIT 1
    `).get() || null;
    const roundId = currentRound?.id || -1;
    const counts = {
      students: scopedCount('USER_READ', "SELECT grade_id FROM users WHERE account_type = 'USER'"),
      activeStudents: scopedCount('USER_READ', "SELECT grade_id FROM users WHERE account_type = 'USER' AND status = 'ACTIVE'"),
      publishedCards: scopedCount('CARD_READ', "SELECT u.grade_id FROM roommate_cards c JOIN users u ON u.id = c.user_id WHERE c.status = 'PUBLISHED'"),
      pendingReports: overviewFilter(reportRows().filter((item) => item.status === 'PENDING'), 'REPORT_READ', 'target_grade_id').length,
      dormitories: scopedCount('DORMITORY_READ', `SELECT management_grade_id FROM dormitories WHERE selection_round_id = ${roundId} AND status IN ('OPEN', 'FULL')`, 'management_grade_id'),
      dormitoryMembers: overviewFilter(db.prepare(`
        SELECT d.management_grade_id FROM dormitory_members m JOIN dormitories d ON d.id = m.dormitory_id
        WHERE d.selection_round_id = ?
      `).all(roundId), 'DORMITORY_READ', 'management_grade_id').length,
      dormitorySelectionOpen: currentRound?.status === 'OPEN',
      currentRound,
    };
    return json(res, 200, { counts });
  }

  if (method === 'GET' && pathname === '/api/admin/permissions') {
    superGrant();
    return json(res, 200, { permissions: Object.entries(PERMISSIONS).map(([code, name]) => ({ code, name })) });
  }

  if (method === 'GET' && pathname === '/api/admin/grades') {
    const grades = db.prepare("SELECT id, code, name, status FROM grades WHERE status = 'ACTIVE' ORDER BY code").all();
    if (admin.account_type === 'SUPER_ADMIN') return json(res, 200, { grades });
    const allowed = new Set(activeAdminGroups(admin.id).flatMap((group) => group.gradeIds));
    return json(res, 200, { grades: grades.filter((grade) => allowed.has(grade.id)) });
  }

  if (method === 'GET' && pathname === '/api/admin/admin-groups') {
    superGrant();
    const groups = db.prepare(`
      SELECT g.*, creator.name AS created_by_name FROM admin_groups g
      LEFT JOIN users creator ON creator.id = g.created_by ORDER BY g.id DESC
    `).all().map(groupDetails);
    return json(res, 200, { groups });
  }

  if (method === 'POST' && pathname === '/api/admin/admin-groups') {
    const grant = superGrant();
    const body = await readBody(req);
    const code = cleanText(body.code, 40, true).toUpperCase();
    const name = cleanText(body.name, 80, true);
    const description = cleanText(body.description, 500);
    if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(code)) throw new HttpError(400, 'INVALID_GROUP_CODE', '组编码只能使用大写字母、数字和下划线');
    if (db.prepare('SELECT 1 FROM admin_groups WHERE code = ?').get(code)) throw new HttpError(409, 'DUPLICATE_GROUP_CODE', '管理员组编码已存在');
    const timestamp = now();
    const id = Number(db.prepare(`
      INSERT INTO admin_groups (code, name, description, status, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)
    `).run(code, name, description, admin.id, timestamp, timestamp).lastInsertRowid);
    audit(admin, req, 'CREATE_ADMIN_GROUP', 'ADMIN_GROUP', id, '', {}, grant, { after: { code, name, description, status: 'ACTIVE' } });
    return json(res, 201, { group: groupDetails(db.prepare('SELECT * FROM admin_groups WHERE id = ?').get(id)) });
  }

  let match = pathname.match(/^\/api\/admin\/admin-groups\/(\d+)$/);
  if (match && method === 'PATCH') {
    const grant = superGrant();
    const groupId = Number(match[1]);
    const before = db.prepare('SELECT * FROM admin_groups WHERE id = ?').get(groupId);
    if (!before) throw new HttpError(404, 'ADMIN_GROUP_NOT_FOUND', '管理员组不存在');
    const body = await readBody(req);
    const name = cleanText(body.name, 80, true);
    const description = cleanText(body.description, 500);
    const status = body.status;
    if (!['ACTIVE', 'DISABLED'].includes(status)) throw new HttpError(400, 'INVALID_GROUP_STATUS', '管理员组状态无效');
    db.prepare('UPDATE admin_groups SET name = ?, description = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(name, description, status, now(), groupId);
    db.prepare(`
      UPDATE users SET authorization_version = authorization_version + 1
      WHERE id IN (SELECT user_id FROM admin_group_members WHERE group_id = ?)
    `).run(groupId);
    const after = db.prepare('SELECT * FROM admin_groups WHERE id = ?').get(groupId);
    audit(admin, req, 'UPDATE_ADMIN_GROUP', 'ADMIN_GROUP', groupId, cleanText(body.reason, 200), {}, grant, { before, after });
    return json(res, 200, { group: groupDetails(after) });
  }

  match = pathname.match(/^\/api\/admin\/admin-groups\/(\d+)\/(permissions|scopes|members)$/);
  if (match && method === 'PUT') {
    const grant = superGrant();
    const groupId = Number(match[1]);
    const section = match[2];
    const group = db.prepare('SELECT * FROM admin_groups WHERE id = ?').get(groupId);
    if (!group) throw new HttpError(404, 'ADMIN_GROUP_NOT_FOUND', '管理员组不存在');
    const body = await readBody(req);
    let before;
    let after;
    transaction(() => {
      if (section === 'permissions') {
        const values = [...new Set(Array.isArray(body.permissions) ? body.permissions : [])];
        if (values.some((value) => !Object.hasOwn(PERMISSIONS, value))) throw new HttpError(400, 'INVALID_PERMISSION', '包含不受支持的权限编码');
        before = db.prepare('SELECT permission_code FROM admin_group_permissions WHERE group_id = ? ORDER BY permission_code').all(groupId).map((item) => item.permission_code);
        db.prepare('DELETE FROM admin_group_permissions WHERE group_id = ?').run(groupId);
        const insert = db.prepare('INSERT INTO admin_group_permissions (group_id, permission_code, created_by, created_at) VALUES (?, ?, ?, ?)');
        for (const value of values) insert.run(groupId, value, admin.id, now());
        after = values;
      } else if (section === 'scopes') {
        const values = [...new Set((Array.isArray(body.gradeIds) ? body.gradeIds : []).map(Number))];
        if (values.some((value) => !Number.isInteger(value) || !db.prepare("SELECT 1 FROM grades WHERE id = ? AND status = 'ACTIVE'").get(value))) {
          throw new HttpError(400, 'INVALID_GRADE_SCOPE', '包含无效的年级范围');
        }
        before = db.prepare("SELECT scope_value FROM admin_group_scopes WHERE group_id = ? AND scope_type = 'GRADE' ORDER BY scope_value").all(groupId).map((item) => Number(item.scope_value));
        db.prepare('DELETE FROM admin_group_scopes WHERE group_id = ?').run(groupId);
        const insert = db.prepare("INSERT INTO admin_group_scopes (group_id, scope_type, scope_value, created_by, created_at) VALUES (?, 'GRADE', ?, ?, ?)");
        for (const value of values) insert.run(groupId, String(value), admin.id, now());
        after = values;
      } else {
        const values = [...new Set((Array.isArray(body.userIds) ? body.userIds : []).map(Number))];
        if (values.some((value) => !Number.isInteger(value) || !db.prepare("SELECT 1 FROM users WHERE id = ? AND account_type = 'USER'").get(value))) {
          throw new HttpError(400, 'INVALID_GROUP_MEMBER', '管理员组成员必须是普通用户');
        }
        before = db.prepare('SELECT user_id FROM admin_group_members WHERE group_id = ? ORDER BY user_id').all(groupId).map((item) => item.user_id);
        db.prepare('DELETE FROM admin_group_members WHERE group_id = ?').run(groupId);
        const insert = db.prepare('INSERT INTO admin_group_members (group_id, user_id, created_by, created_at) VALUES (?, ?, ?, ?)');
        for (const value of values) insert.run(groupId, value, admin.id, now());
        const affected = [...new Set([...before, ...values])];
        for (const value of affected) db.prepare('UPDATE users SET authorization_version = authorization_version + 1 WHERE id = ?').run(value);
        after = values;
      }
      if (section !== 'members') {
        db.prepare(`
          UPDATE users SET authorization_version = authorization_version + 1
          WHERE id IN (SELECT user_id FROM admin_group_members WHERE group_id = ?)
        `).run(groupId);
      }
    });
    audit(admin, req, `UPDATE_ADMIN_GROUP_${section.toUpperCase()}`, 'ADMIN_GROUP', groupId, cleanText(body.reason, 200), {}, grant, { before, after });
    return json(res, 200, { group: groupDetails(db.prepare('SELECT * FROM admin_groups WHERE id = ?').get(groupId)) });
  }

  if (method === 'GET' && pathname === '/api/admin/users') {
    let users = db.prepare(`
      SELECT u.id, u.login_identifier, u.account_type, u.name, u.grade, u.grade_id, u.gender, u.major,
             u.email, u.status, u.last_login_at, u.created_at, c.status AS card_status
      FROM users u LEFT JOIN roommate_cards c ON c.user_id = u.id
      ORDER BY u.id DESC
    `).all();
    if (admin.account_type !== 'SUPER_ADMIN') {
      users = gradeFilter(users.filter((item) => item.account_type === 'USER'), 'USER_READ');
    }
    return json(res, 200, { users: users.map((item) => ({
      ...item,
      is_group_admin: item.account_type === 'USER' && isEffectiveGroupAdmin(item.id),
    })) });
  }

  if (method === 'POST' && pathname === '/api/admin/users/import') {
    const body = await readBody(req);
    const accounts = Array.isArray(body.accounts) ? body.accounts.slice(0, 200) : [];
    if (!accounts.length) throw new HttpError(400, 'EMPTY_IMPORT', '没有可导入的账号');
    const created = [];
    const failed = [];
    for (let index = 0; index < accounts.length; index += 1) {
      const item = accounts[index] || {};
      try {
        const login = cleanText(item.loginIdentifier, 100, true);
        const name = cleanText(item.name, 40, true);
        const gradeText = cleanText(item.grade, 20, true);
        const grade = gradeByText(gradeText, admin.account_type === 'SUPER_ADMIN');
        if (!grade) throw new HttpError(404, 'GRADE_NOT_FOUND', '年级不在授权范围内');
        const grant = authorize(admin, 'USER_IMPORT', grade.id);
        const major = cleanText(item.major, 80, true);
        const gender = item.gender;
        if (!['MALE', 'FEMALE'].includes(gender)) {
          throw new HttpError(400, 'INVALID_GENDER', '性别必须为男或女');
        }
        if (db.prepare('SELECT 1 FROM users WHERE login_identifier = ?').get(login)) {
          throw new HttpError(409, 'DUPLICATE_LOGIN', '登录标识已存在');
        }
        const initialPassword = `Temp-${crypto.randomBytes(6).toString('base64url')}`;
        const password = hashPassword(initialPassword);
        const timestamp = now();
        const id = Number(db.prepare(`
          INSERT INTO users
            (login_identifier, password_hash, password_salt, role, account_type, name, grade, grade_id,
             gender, major, status, imported_by, created_at, updated_at)
          VALUES (?, ?, ?, 'STUDENT', 'USER', ?, ?, ?, ?, ?, 'PENDING_ACTIVATION', ?, ?, ?)
        `).run(login, password.hash, password.salt, name, grade.name, grade.id, gender, major, admin.id, timestamp, timestamp).lastInsertRowid);
        created.push({ id, loginIdentifier: login, name, grade: grade.name, gender, major, initialPassword });
        audit(admin, req, 'IMPORT_USER', 'USER', id, '', {}, grant, { after: { loginIdentifier: login, name, grade: grade.name, gender, major } });
      } catch (error) {
        failed.push({ row: index + 1, loginIdentifier: item.loginIdentifier || '', reason: error.message });
      }
    }
    return json(res, 200, { created, failed });
  }

  match = pathname.match(/^\/api\/admin\/users\/(\d+)\/identity$/);
  if (match && method === 'PATCH') {
    const body = await readBody(req);
    const userId = Number(match[1]);
    const name = cleanText(body.name, 40, true);
    const targetGrade = gradeByText(body.grade, admin.account_type === 'SUPER_ADMIN');
    if (!targetGrade) throw new HttpError(404, 'GRADE_NOT_FOUND', '年级不在授权范围内');
    const major = cleanText(body.major, 80, true);
    const gender = body.gender;
    if (!['MALE', 'FEMALE'].includes(gender)) {
      throw new HttpError(400, 'INVALID_GENDER', '性别必须为男或女');
    }
    const account = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!account) throw new HttpError(404, 'USER_NOT_FOUND', '用户账号不存在');
    if (admin.account_type !== 'SUPER_ADMIN' && (userId === admin.id || account.account_type !== 'USER' || isEffectiveGroupAdmin(userId))) {
      throw new HttpError(403, 'PROTECTED_ADMIN_ACCOUNT', '组管理员不能修改自己或其他管理员账号');
    }
    const grant = admin.account_type === 'SUPER_ADMIN'
      ? superGrant()
      : authorize(admin, 'USER_IDENTITY_UPDATE', [account.grade_id, targetGrade.id]);
    if (account.gender !== gender && currentDormitoryForUser(userId)) {
      throw new HttpError(409, 'USER_IN_DORMITORY', '该学生已加入宿舍，请退出后再修改性别');
    }
    db.prepare(`UPDATE users SET name = ?, grade = ?, grade_id = ?, gender = ?, major = ?, updated_at = ? WHERE id = ?`)
      .run(name, targetGrade.name, targetGrade.id, gender, major, now(), userId);
    const after = { name, grade: targetGrade.name, grade_id: targetGrade.id, gender, major };
    audit(admin, req, 'UPDATE_IDENTITY', 'USER', userId, cleanText(body.reason, 200), {}, grant, {
      before: { name: account.name, grade: account.grade, grade_id: account.grade_id, gender: account.gender, major: account.major },
      after,
    });
    return json(res, 200, { ok: true });
  }

  match = pathname.match(/^\/api\/admin\/users\/(\d+)\/status$/);
  if (match && method === 'PATCH') {
    const body = await readBody(req);
    const userId = Number(match[1]);
    const status = body.status;
    if (!['ACTIVE', 'SUSPENDED', 'BANNED'].includes(status)) {
      throw new HttpError(400, 'INVALID_STATUS', '账号状态无效');
    }
    const account = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!account) throw new HttpError(404, 'USER_NOT_FOUND', '用户账号不存在');
    if (admin.account_type !== 'SUPER_ADMIN' && (userId === admin.id || account.account_type !== 'USER' || isEffectiveGroupAdmin(userId))) {
      throw new HttpError(403, 'PROTECTED_ADMIN_ACCOUNT', '组管理员不能修改自己或其他管理员账号');
    }
    const grant = admin.account_type === 'SUPER_ADMIN' ? superGrant() : authorize(admin, 'USER_STATUS_UPDATE', account.grade_id);
    if (account.account_type === 'SUPER_ADMIN' && ['ACTIVE', 'PENDING_ACTIVATION'].includes(account.status) && status !== 'ACTIVE') {
      const effectiveSuperAdmins = db.prepare(`
        SELECT COUNT(*) AS count FROM users WHERE account_type = 'SUPER_ADMIN' AND status IN ('ACTIVE', 'PENDING_ACTIVATION')
      `).get().count;
      if (effectiveSuperAdmins <= 1) throw new HttpError(409, 'LAST_SUPER_ADMIN', '不能停用最后一个有效超级管理员');
    }
    transaction(() => {
      if (status !== 'ACTIVE') leaveDormitory(userId, undefined, `账号状态变更为 ${status}`);
      db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), userId);
      if (status !== 'ACTIVE') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    });
    audit(admin, req, 'UPDATE_USER_STATUS', 'USER', userId, cleanText(body.reason, 200, true), {}, grant, { before: { status: account.status }, after: { status } });
    return json(res, 200, { ok: true });
  }

  match = pathname.match(/^\/api\/admin\/users\/(\d+)\/account-type$/);
  if (match && method === 'PATCH') {
    const grant = superGrant();
    const body = await readBody(req);
    const userId = Number(match[1]);
    const accountType = body.accountType;
    if (!['USER', 'SUPER_ADMIN'].includes(accountType)) throw new HttpError(400, 'INVALID_ACCOUNT_TYPE', '账号类型无效');
    const account = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!account) throw new HttpError(404, 'USER_NOT_FOUND', '用户账号不存在');
    if (account.account_type === 'SUPER_ADMIN' && accountType === 'USER') {
      const count = db.prepare("SELECT COUNT(*) AS count FROM users WHERE account_type = 'SUPER_ADMIN' AND status IN ('ACTIVE', 'PENDING_ACTIVATION')").get().count;
      if (count <= 1 && ['ACTIVE', 'PENDING_ACTIVATION'].includes(account.status)) throw new HttpError(409, 'LAST_SUPER_ADMIN', '不能降级最后一个有效超级管理员');
      if (!account.grade_id) throw new HttpError(409, 'GRADE_REQUIRED', '降级前必须为账号设置年级');
    }
    transaction(() => {
      db.prepare('UPDATE users SET account_type = ?, authorization_version = authorization_version + 1, updated_at = ? WHERE id = ?')
        .run(accountType, now(), userId);
      if (accountType === 'SUPER_ADMIN') db.prepare('DELETE FROM admin_group_members WHERE user_id = ?').run(userId);
    });
    audit(admin, req, 'UPDATE_ACCOUNT_TYPE', 'USER', userId, cleanText(body.reason, 200, true), {}, grant, { before: { accountType: account.account_type }, after: { accountType } });
    return json(res, 200, { ok: true });
  }

  match = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (match && method === 'DELETE') {
    const grant = superGrant();
    const body = await readBody(req);
    const userId = Number(match[1]);
    const account = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!account) throw new HttpError(404, 'USER_NOT_FOUND', '用户账号不存在');
    if (account.account_type === 'SUPER_ADMIN') {
      const count = db.prepare("SELECT COUNT(*) AS count FROM users WHERE account_type = 'SUPER_ADMIN' AND status IN ('ACTIVE', 'PENDING_ACTIVATION')").get().count;
      if (count <= 1 && ['ACTIVE', 'PENDING_ACTIVATION'].includes(account.status)) throw new HttpError(409, 'LAST_SUPER_ADMIN', '不能删除最后一个有效超级管理员');
    }
    if (body.confirmation !== account.login_identifier) {
      throw new HttpError(400, 'CONFIRMATION_REQUIRED', '请输入该账号的登录标识确认删除');
    }
    if (db.prepare(`
      SELECT 1 FROM dormitory_members m JOIN dormitory_selection_rounds r ON r.id = m.selection_round_id
      WHERE m.user_id = ? AND r.status = 'CLOSED' LIMIT 1
    `).get(userId)) {
      throw new HttpError(409, 'UNARCHIVED_DORMITORY_RESULT', '该用户存在尚未归档的宿舍结果，请先归档对应轮次');
    }
    const reason = cleanText(body.reason, 200, true);
    transaction(() => {
      audit(admin, req, 'DELETE_USER_PERMANENTLY', 'USER', userId, reason, {}, grant, { before: { loginIdentifier: account.login_identifier, name: account.name, accountType: account.account_type } });
      leaveDormitory(userId, undefined, '管理员永久删除账号');
      for (const [table, column] of [
        ['users', 'imported_by'], ['system_settings', 'updated_by'], ['admin_groups', 'created_by'],
        ['admin_group_members', 'created_by'], ['admin_group_permissions', 'created_by'],
        ['admin_group_scopes', 'created_by'], ['reports', 'handled_by'], ['dormitory_applications', 'reviewed_by'],
        ['dormitory_selection_rounds', 'created_by'], ['dormitory_round_participants', 'added_by'],
        ['audit_logs', 'admin_id'],
      ]) {
        db.prepare(`UPDATE ${table} SET ${column} = NULL WHERE ${column} = ?`).run(userId);
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    });
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/admin/roommate-cards') {
    const cards = gradeFilter(db.prepare(`${CARD_SELECT} ORDER BY c.updated_at DESC`).all(), 'CARD_READ').map(cardFromRow);
    return json(res, 200, { cards });
  }

  match = pathname.match(/^\/api\/admin\/roommate-cards\/(\d+)\/(hide|restore)$/);
  if (match && method === 'POST') {
    const cardId = Number(match[1]);
    const action = match[2];
    const body = await readBody(req);
    const card = getCard(cardId);
    if (!card) throw new HttpError(404, 'CARD_NOT_FOUND', '室友卡片不存在');
    const grant = authorize(admin, 'CARD_MODERATE', card.grade_id);
    const reason = action === 'hide' ? cleanText(body.reason, 200, true) : cleanText(body.reason, 200);
    transaction(() => {
      if (action === 'hide') {
        db.prepare(`UPDATE roommate_cards SET status = 'HIDDEN', hidden_reason = ?, updated_at = ? WHERE id = ?`)
          .run(reason, now(), cardId);
      } else {
        db.prepare(`UPDATE roommate_cards SET status = 'PUBLISHED', hidden_reason = NULL, updated_at = ? WHERE id = ?`)
          .run(now(), cardId);
      }
    });
    audit(admin, req, action === 'hide' ? 'HIDE_CARD' : 'RESTORE_CARD', 'ROOMMATE_CARD', cardId, reason, {}, grant, { before: { status: card.status }, after: { status: action === 'hide' ? 'HIDDEN' : 'PUBLISHED' } });
    return json(res, 200, { card: getCard(cardId) });
  }

  if (method === 'GET' && pathname === '/api/admin/student-selection-groups') {
    superGrant();
    const groups = db.prepare('SELECT * FROM student_selection_groups ORDER BY name, id').all().map(selectionGroupDetails);
    return json(res, 200, { groups });
  }

  if (method === 'POST' && pathname === '/api/admin/student-selection-groups') {
    const grant = superGrant();
    const body = await readBody(req);
    const name = cleanText(body.name, 80, true);
    const description = cleanText(body.description, 500);
    const memberIds = [...new Set((Array.isArray(body.memberIds) ? body.memberIds : []).map(Number))];
    if (!memberIds.length) throw new HttpError(400, 'SELECTION_GROUP_MEMBERS_REQUIRED', '请至少选择一名学生');
    if (memberIds.some((id) => !Number.isInteger(id) || !db.prepare("SELECT 1 FROM users WHERE id = ? AND account_type = 'USER' AND status IN ('ACTIVE', 'PENDING_ACTIVATION')").get(id))) {
      throw new HttpError(400, 'INVALID_SELECTION_GROUP_MEMBER', '群组成员包含无效学生');
    }
    if (db.prepare('SELECT 1 FROM student_selection_groups WHERE name = ?').get(name)) {
      throw new HttpError(409, 'DUPLICATE_SELECTION_GROUP_NAME', '预设群组名称已存在');
    }
    const timestamp = now();
    const groupId = transaction(() => {
      const id = Number(db.prepare(`
        INSERT INTO student_selection_groups (name, description, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(name, description, admin.id, timestamp, timestamp).lastInsertRowid);
      const insert = db.prepare(`
        INSERT INTO student_selection_group_members (group_id, user_id, created_at) VALUES (?, ?, ?)
      `);
      for (const userId of memberIds) insert.run(id, userId, timestamp);
      return id;
    });
    audit(admin, req, 'CREATE_STUDENT_SELECTION_GROUP', 'STUDENT_SELECTION_GROUP', groupId, cleanText(body.reason, 200), { memberCount: memberIds.length }, grant, { after: { name, description } });
    return json(res, 201, { group: selectionGroupDetails(db.prepare('SELECT * FROM student_selection_groups WHERE id = ?').get(groupId)) });
  }

  match = pathname.match(/^\/api\/admin\/student-selection-groups\/(\d+)$/);
  if (match && method === 'PATCH') {
    const grant = superGrant();
    const groupId = Number(match[1]);
    const before = db.prepare('SELECT * FROM student_selection_groups WHERE id = ?').get(groupId);
    if (!before) throw new HttpError(404, 'SELECTION_GROUP_NOT_FOUND', '预设群组不存在');
    const body = await readBody(req);
    const name = cleanText(body.name, 80, true);
    const description = cleanText(body.description, 500);
    const reason = cleanText(body.reason, 200, true);
    const memberIds = [...new Set((Array.isArray(body.memberIds) ? body.memberIds : []).map(Number))];
    if (!memberIds.length) throw new HttpError(400, 'SELECTION_GROUP_MEMBERS_REQUIRED', '请至少选择一名学生');
    if (memberIds.some((id) => !Number.isInteger(id) || !db.prepare("SELECT 1 FROM users WHERE id = ? AND account_type = 'USER' AND status IN ('ACTIVE', 'PENDING_ACTIVATION')").get(id))) {
      throw new HttpError(400, 'INVALID_SELECTION_GROUP_MEMBER', '群组成员包含无效学生');
    }
    if (db.prepare('SELECT 1 FROM student_selection_groups WHERE name = ? AND id != ?').get(name, groupId)) {
      throw new HttpError(409, 'DUPLICATE_SELECTION_GROUP_NAME', '预设群组名称已存在');
    }
    transaction(() => {
      db.prepare('UPDATE student_selection_groups SET name = ?, description = ?, updated_at = ? WHERE id = ?')
        .run(name, description, now(), groupId);
      db.prepare('DELETE FROM student_selection_group_members WHERE group_id = ?').run(groupId);
      const insert = db.prepare('INSERT INTO student_selection_group_members (group_id, user_id, created_at) VALUES (?, ?, ?)');
      for (const userId of memberIds) insert.run(groupId, userId, now());
    });
    audit(admin, req, 'UPDATE_STUDENT_SELECTION_GROUP', 'STUDENT_SELECTION_GROUP', groupId, reason, { memberCount: memberIds.length }, grant, { before, after: { name, description } });
    return json(res, 200, { group: selectionGroupDetails(db.prepare('SELECT * FROM student_selection_groups WHERE id = ?').get(groupId)) });
  }

  if (match && method === 'DELETE') {
    const grant = superGrant();
    const groupId = Number(match[1]);
    const group = db.prepare('SELECT * FROM student_selection_groups WHERE id = ?').get(groupId);
    if (!group) throw new HttpError(404, 'SELECTION_GROUP_NOT_FOUND', '预设群组不存在');
    const body = await readBody(req);
    const reason = cleanText(body.reason, 200, true);
    audit(admin, req, 'DELETE_STUDENT_SELECTION_GROUP', 'STUDENT_SELECTION_GROUP', groupId, reason, {}, grant, { before: group });
    db.prepare('DELETE FROM student_selection_groups WHERE id = ?').run(groupId);
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/admin/dormitory-rounds') {
    if (admin.account_type !== 'SUPER_ADMIN' && !authorizedGradeIds(admin, 'DORMITORY_READ')?.length) {
      throw new HttpError(403, 'PERMISSION_DENIED', '当前账号缺少查看宿舍的权限');
    }
    const rounds = db.prepare(`
      SELECT r.*,
        (SELECT COUNT(*) FROM dormitory_round_participants WHERE round_id = r.id) AS participant_count,
        (SELECT COUNT(*) FROM dormitories WHERE selection_round_id = r.id) AS dormitory_count,
        (SELECT COUNT(*) FROM dormitory_result_snapshots WHERE selection_round_id = r.id) AS result_count
      FROM dormitory_selection_rounds r
      ${admin.account_type === 'SUPER_ADMIN' ? '' : "WHERE r.status != 'DRAFT'"}
      ORDER BY r.id DESC
    `).all().map((round) => ({
      ...round,
      participantIds: admin.account_type === 'SUPER_ADMIN'
        ? db.prepare('SELECT user_id FROM dormitory_round_participants WHERE round_id = ? ORDER BY user_id').all(round.id).map((item) => item.user_id)
        : undefined,
    }));
    return json(res, 200, { rounds });
  }

  if (method === 'POST' && pathname === '/api/admin/dormitory-rounds') {
    const grant = superGrant();
    const body = await readBody(req);
    const code = cleanText(body.code, 40, true).toUpperCase();
    const name = cleanText(body.name, 80, true);
    const description = cleanText(body.description, 500);
    const startsAt = cleanText(body.startsAt, 40);
    const endsAt = cleanText(body.endsAt, 40);
    const participantIds = [...new Set((Array.isArray(body.participantIds) ? body.participantIds : []).map(Number))];
    if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(code)) throw new HttpError(400, 'INVALID_ROUND_CODE', '轮次编码只能使用大写字母、数字、下划线和连字符');
    if (!participantIds.length) throw new HttpError(400, 'ROUND_PARTICIPANTS_REQUIRED', '请至少选择一名参与学生');
    if (participantIds.some((id) => !Number.isInteger(id) || !db.prepare("SELECT 1 FROM users WHERE id = ? AND account_type = 'USER'").get(id))) {
      throw new HttpError(400, 'INVALID_ROUND_PARTICIPANT', '参与名单包含无效学生');
    }
    if (db.prepare('SELECT 1 FROM dormitory_selection_rounds WHERE code = ?').get(code)) throw new HttpError(409, 'DUPLICATE_ROUND_CODE', '轮次编码已存在');
    const timestamp = now();
    const roundId = transaction(() => {
      const id = Number(db.prepare(`
        INSERT INTO dormitory_selection_rounds (
          code, name, description, status, starts_at, ends_at, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?)
      `).run(code, name, description, startsAt || null, endsAt || null, admin.id, timestamp, timestamp).lastInsertRowid);
      const insert = db.prepare(`
        INSERT INTO dormitory_round_participants (round_id, user_id, added_by, created_at) VALUES (?, ?, ?, ?)
      `);
      for (const userId of participantIds) insert.run(id, userId, admin.id, timestamp);
      return id;
    });
    audit(admin, req, 'CREATE_DORMITORY_ROUND', 'DORMITORY_ROUND', roundId, cleanText(body.reason, 200), { participantCount: participantIds.length }, grant, { after: { code, name, status: 'DRAFT' } });
    return json(res, 201, { round: db.prepare('SELECT * FROM dormitory_selection_rounds WHERE id = ?').get(roundId) });
  }

  match = pathname.match(/^\/api\/admin\/dormitory-rounds\/(\d+)$/);
  if (match && method === 'PATCH') {
    const grant = superGrant();
    const roundId = Number(match[1]);
    const before = db.prepare('SELECT * FROM dormitory_selection_rounds WHERE id = ?').get(roundId);
    if (!before) throw new HttpError(404, 'DORMITORY_ROUND_NOT_FOUND', '选宿舍轮次不存在');
    if (before.status !== 'DRAFT') throw new HttpError(409, 'ROUND_NOT_EDITABLE', '只有草稿轮次可以修改配置');
    const body = await readBody(req);
    const name = cleanText(body.name, 80, true);
    const description = cleanText(body.description, 500);
    const startsAt = cleanText(body.startsAt, 40);
    const endsAt = cleanText(body.endsAt, 40);
    const participantIds = [...new Set((Array.isArray(body.participantIds) ? body.participantIds : []).map(Number))];
    if (!participantIds.length) throw new HttpError(400, 'ROUND_PARTICIPANTS_REQUIRED', '请至少选择一名参与学生');
    if (participantIds.some((id) => !Number.isInteger(id) || !db.prepare("SELECT 1 FROM users WHERE id = ? AND account_type = 'USER'").get(id))) {
      throw new HttpError(400, 'INVALID_ROUND_PARTICIPANT', '参与名单包含无效学生');
    }
    transaction(() => {
      db.prepare(`UPDATE dormitory_selection_rounds SET name = ?, description = ?, starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ?`)
        .run(name, description, startsAt || null, endsAt || null, now(), roundId);
      db.prepare('DELETE FROM dormitory_round_participants WHERE round_id = ?').run(roundId);
      const insert = db.prepare('INSERT INTO dormitory_round_participants (round_id, user_id, added_by, created_at) VALUES (?, ?, ?, ?)');
      for (const userId of participantIds) insert.run(roundId, userId, admin.id, now());
    });
    audit(admin, req, 'UPDATE_DORMITORY_ROUND', 'DORMITORY_ROUND', roundId, cleanText(body.reason, 200, true), { participantCount: participantIds.length }, grant, { before, after: { name, description, startsAt, endsAt } });
    return json(res, 200, { round: db.prepare('SELECT * FROM dormitory_selection_rounds WHERE id = ?').get(roundId) });
  }

  match = pathname.match(/^\/api\/admin\/dormitory-rounds\/(\d+)\/(open|close|archive)$/);
  if (match && method === 'POST') {
    const grant = superGrant();
    const roundId = Number(match[1]);
    const action = match[2];
    const body = await readBody(req);
    const reason = cleanText(body.reason, 200, true);
    const round = db.prepare('SELECT * FROM dormitory_selection_rounds WHERE id = ?').get(roundId);
    if (!round) throw new HttpError(404, 'DORMITORY_ROUND_NOT_FOUND', '选宿舍轮次不存在');
    const requiredStatus = { open: 'DRAFT', close: 'OPEN', archive: 'CLOSED' }[action];
    if (round.status !== requiredStatus) throw new HttpError(409, 'INVALID_ROUND_TRANSITION', '当前轮次状态不能执行该操作');
    let snapshotCount = 0;
    transaction(() => {
      const timestamp = now();
      if (action === 'open') {
        if (activeDormitoryRound()) throw new HttpError(409, 'ROUND_ALREADY_OPEN', '已有正在进行的选宿舍轮次');
        db.prepare("UPDATE dormitory_selection_rounds SET status = 'OPEN', opened_at = ?, updated_at = ? WHERE id = ?")
          .run(timestamp, timestamp, roundId);
      } else if (action === 'close') {
        db.prepare("UPDATE dormitory_selection_rounds SET status = 'CLOSED', closed_at = ?, updated_at = ? WHERE id = ?")
          .run(timestamp, timestamp, roundId);
        db.prepare("UPDATE dormitory_applications SET status = 'CANCELLED', reviewed_at = ?, updated_at = ? WHERE selection_round_id = ? AND status = 'PENDING'")
          .run(timestamp, timestamp, roundId);
      } else {
        snapshotCount = generateDormitoryRoundSnapshot(roundId);
        db.prepare("UPDATE dormitory_selection_rounds SET status = 'ARCHIVED', archived_at = ?, updated_at = ? WHERE id = ?")
          .run(timestamp, timestamp, roundId);
      }
    });
    const status = { open: 'OPEN', close: 'CLOSED', archive: 'ARCHIVED' }[action];
    audit(admin, req, `${action.toUpperCase()}_DORMITORY_ROUND`, 'DORMITORY_ROUND', roundId, reason, { snapshotCount }, grant, { before: { status: round.status }, after: { status } });
    return json(res, 200, { round: db.prepare('SELECT * FROM dormitory_selection_rounds WHERE id = ?').get(roundId), snapshotCount });
  }

  if (method === 'GET' && pathname === '/api/admin/dormitories') {
    const round = url.searchParams.get('roundId')
      ? db.prepare('SELECT * FROM dormitory_selection_rounds WHERE id = ?').get(Number(url.searchParams.get('roundId')))
      : activeDormitoryRound() || db.prepare("SELECT * FROM dormitory_selection_rounds WHERE status != 'DRAFT' ORDER BY id DESC LIMIT 1").get();
    if (!round) throw new HttpError(404, 'DORMITORY_ROUND_NOT_FOUND', '选宿舍轮次不存在');
    const dormitories = round.status === 'ARCHIVED'
      ? gradeFilter(archivedDormitoryResults(round.id), 'DORMITORY_READ', 'management_grade_id')
      : gradeFilter(db.prepare('SELECT id, management_grade_id FROM dormitories WHERE selection_round_id = ? ORDER BY id DESC').all(round.id), 'DORMITORY_READ', 'management_grade_id')
          .map((item) => dormitoryDetails(item.id));
    return json(res, 200, { open: round.status === 'OPEN', round, dormitories });
  }

  if (method === 'GET' && pathname === '/api/admin/dormitories/export') {
    const round = url.searchParams.get('roundId')
      ? db.prepare('SELECT * FROM dormitory_selection_rounds WHERE id = ?').get(Number(url.searchParams.get('roundId')))
      : activeDormitoryRound() || db.prepare("SELECT * FROM dormitory_selection_rounds WHERE status != 'DRAFT' ORDER BY id DESC LIMIT 1").get();
    if (!round) throw new HttpError(404, 'DORMITORY_ROUND_NOT_FOUND', '选宿舍轮次不存在');
    const gradeIds = authorizedGradeIds(admin, 'DORMITORY_EXPORT');
    if (gradeIds !== null && !gradeIds.length) throw new HttpError(403, 'PERMISSION_DENIED', '当前账号缺少所需管理权限');
    const dormitories = (round.status === 'ARCHIVED'
      ? archivedDormitoryResults(round.id)
      : db.prepare('SELECT id, management_grade_id FROM dormitories WHERE selection_round_id = ? ORDER BY id DESC').all(round.id)
          .map((item) => dormitoryDetails(item.id)))
      .filter((item) => gradeIds === null || gradeIds.includes(Number(item.management_grade_id)));
    const grant = admin.account_type === 'SUPER_ADMIN'
      ? {
          permissionCode: 'DORMITORY_EXPORT', groupId: null, scopeType: 'GRADE',
          scopeValue: [...new Set(dormitories.map((item) => item.management_grade_id).filter(Boolean))].join(','),
        }
      : (() => {
          const group = activeAdminGroups(admin.id).find((item) => item.permissions.includes('DORMITORY_EXPORT'));
          return { permissionCode: 'DORMITORY_EXPORT', groupId: group.id, scopeType: 'GRADE', scopeValue: group.gradeIds.join(',') };
        })();
    const workbook = createDormitoryWorkbook(dormitories);
    const filename = `dormitories-${round.code}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    audit(admin, req, 'EXPORT_DORMITORIES', 'DORMITORY_ROUND', round.id, '', { count: dormitories.length, roundCode: round.code }, grant);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': workbook.length,
      'Cache-Control': 'no-store',
    });
    res.end(workbook);
    return;
  }

  match = pathname.match(/^\/api\/admin\/dormitories\/(\d+)\/location$/);
  if (match && method === 'PATCH') {
    const body = await readBody(req);
    const dormitoryId = Number(match[1]);
    const building = cleanText(body.building, 40, true);
    const roomNumber = cleanText(body.roomNumber, 20, true);
    const dormitory = db.prepare('SELECT * FROM dormitories WHERE id = ?').get(dormitoryId);
    if (!dormitory) throw new HttpError(404, 'DORMITORY_NOT_FOUND', '宿舍不存在');
    const round = db.prepare('SELECT status FROM dormitory_selection_rounds WHERE id = ?').get(dormitory.selection_round_id);
    if (round?.status === 'ARCHIVED') throw new HttpError(409, 'ROUND_ARCHIVED', '归档轮次不能再修改宿舍');
    const grant = authorize(admin, 'DORMITORY_LOCATION_ASSIGN', dormitory.management_grade_id);
    const result = db.prepare(`
      UPDATE dormitories SET building = ?, room_number = ?, updated_at = ? WHERE id = ?
    `).run(building, roomNumber, now(), dormitoryId);
    if (!result.changes) throw new HttpError(404, 'DORMITORY_NOT_FOUND', '宿舍不存在');
    audit(admin, req, 'ASSIGN_DORMITORY_LOCATION', 'DORMITORY', dormitoryId, cleanText(body.reason, 200, true), {}, grant, { before: { building: dormitory.building, roomNumber: dormitory.room_number }, after: { building, roomNumber } });
    return json(res, 200, { dormitory: dormitoryDetails(dormitoryId) });
  }

  match = pathname.match(/^\/api\/admin\/dormitories\/(\d+)\/close$/);
  if (match && method === 'POST') {
    const body = await readBody(req);
    const dormitoryId = Number(match[1]);
    const reason = cleanText(body.reason, 200, true);
    const dormitory = db.prepare('SELECT * FROM dormitories WHERE id = ?').get(dormitoryId);
    if (!dormitory) throw new HttpError(404, 'DORMITORY_NOT_FOUND', '宿舍不存在');
    const round = db.prepare('SELECT status FROM dormitory_selection_rounds WHERE id = ?').get(dormitory.selection_round_id);
    if (round?.status === 'ARCHIVED') throw new HttpError(409, 'ROUND_ARCHIVED', '归档轮次不能再修改宿舍');
    const grant = authorize(admin, 'DORMITORY_CLOSE', dormitory.management_grade_id);
    db.prepare(`UPDATE dormitories SET status = 'CLOSED', updated_at = ? WHERE id = ?`).run(now(), dormitoryId);
    db.prepare(`UPDATE dormitory_applications SET status = 'CANCELLED', updated_at = ? WHERE dormitory_id = ? AND status = 'PENDING'`)
      .run(now(), dormitoryId);
    audit(admin, req, 'CLOSE_DORMITORY', 'DORMITORY', dormitoryId, reason, {}, grant, { before: { status: dormitory.status }, after: { status: 'CLOSED' } });
    return json(res, 200, { dormitory: dormitoryDetails(dormitoryId) });
  }

  if (method === 'GET' && pathname === '/api/admin/reports') {
    const reports = gradeFilter(reportRows(), 'REPORT_READ', 'target_grade_id')
      .map((report) => ({ ...report, snapshot: JSON.parse(report.snapshot || '{}') }));
    return json(res, 200, { reports });
  }

  match = pathname.match(/^\/api\/admin\/reports\/(\d+)\/resolve$/);
  if (match && method === 'POST') {
    const body = await readBody(req);
    const reportId = Number(match[1]);
    const status = body.status === 'REJECTED' ? 'REJECTED' : 'RESOLVED';
    const resolution = cleanText(body.resolution, 500, true);
    const report = reportRows().find((item) => item.id === reportId);
    if (!report) throw new HttpError(404, 'REPORT_NOT_FOUND', '举报不存在');
    const grant = authorize(admin, 'REPORT_RESOLVE', report.target_grade_id);
    const result = db.prepare(`
      UPDATE reports SET status = ?, resolution = ?, handled_by = ?, handled_at = ? WHERE id = ?
    `).run(status, resolution, admin.id, now(), reportId);
    if (!result.changes) throw new HttpError(404, 'REPORT_NOT_FOUND', '举报不存在');
    audit(admin, req, 'RESOLVE_REPORT', 'REPORT', reportId, resolution, {}, grant, { before: { status: report.status }, after: { status } });
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/admin/audit-logs') {
    let logs = db.prepare(`
      SELECT a.*, COALESCE(NULLIF(a.admin_name_snapshot, ''), u.name) AS admin_name FROM audit_logs a
      LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.id DESC LIMIT 500
    `).all();
    if (admin.account_type !== 'SUPER_ADMIN') {
      const gradeIds = authorizedGradeIds(admin, 'AUDIT_READ_SCOPED');
      if (!gradeIds.length) throw new HttpError(403, 'PERMISSION_DENIED', '当前账号缺少所需管理权限');
      logs = logs.filter((log) => log.scope_type === 'GRADE' && String(log.scope_value).split(',').some((value) => gradeIds.includes(Number(value))));
    }
    logs = logs.slice(0, 200).map((log) => ({
      ...log,
      metadata: JSON.parse(log.metadata || '{}'),
      before_snapshot: JSON.parse(log.before_snapshot || '{}'),
      after_snapshot: JSON.parse(log.after_snapshot || '{}'),
    }));
    return json(res, 200, { logs });
  }

  throw new HttpError(404, 'NOT_FOUND', '接口不存在');
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filename = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (!filename.startsWith(PUBLIC_DIR) || !fs.existsSync(filename) || fs.statSync(filename).isDirectory()) {
    const index = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(index)) return json(res, 404, { error: { code: 'NOT_FOUND', message: '页面不存在' } });
    return serveFile(index, res);
  }
  return serveFile(filename, res);
}

function serveFile(filename, res) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.json': 'application/json; charset=utf-8',
  };
  const stat = fs.statSync(filename);
  const extension = path.extname(filename).toLowerCase();
  const revalidate = ['.html', '.js', '.css'].includes(extension);
  res.writeHead(200, {
    'Content-Type': types[extension] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=3600',
  });
  fs.createReadStream(filename).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (error) {
    if (error instanceof HttpError) {
      if (url.pathname.startsWith('/api/admin/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && error.status !== 401) {
        try {
          const actor = authenticate(req);
          audit(actor, req, 'DENIED_MANAGEMENT_REQUEST', 'API', url.pathname, '', {
            method: req.method, errorCode: error.code,
          }, {}, { result: 'FAILURE' });
        } catch {}
      }
      return json(res, error.status, { error: { code: error.code, message: error.message } });
    }
    console.error(error);
    return json(res, 500, { error: { code: 'INTERNAL_ERROR', message: '服务器暂时无法处理请求' } });
  }
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`OpenShude is running at http://${HOST}:${PORT}`);
  });
}

module.exports = { server, db };
