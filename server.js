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
           u.id, u.login_identifier, u.role, u.name, u.grade, u.gender, u.status
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

function requireStudent(user) {
  if (user.role !== 'STUDENT') throw new HttpError(403, 'STUDENT_ONLY', '仅学生账号可执行此操作');
}

function requireAdmin(user) {
  if (user.role !== 'ADMIN') throw new HttpError(403, 'ADMIN_ONLY', '仅管理员可执行此操作');
}

function audit(admin, req, action, targetType, targetId, reason = '', metadata = {}) {
  db.prepare(`
    INSERT INTO audit_logs (admin_id, action, target_type, target_id, reason, metadata, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    admin.id, action, targetType, String(targetId), reason, JSON.stringify(metadata),
    req.socket.remoteAddress || '', now(),
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

function parseList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function cardFromRow(row) {
  if (!row) return null;
  return {
    ...row,
    sleep_preferences: parseList(row.sleep_preferences),
    personality_tags: parseList(row.personality_tags),
    roommate_personality_tags: parseList(row.roommate_personality_tags),
    hobbies: parseList(row.hobbies),
    sports: parseList(row.sports),
  };
}

const CARD_SELECT = `
  SELECT c.*, u.name, u.grade, u.gender, u.status AS user_status
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

function dormitorySelectionOpen() {
  return db.prepare(`SELECT value FROM system_settings WHERE key = 'dormitory_selection_open'`).get()?.value === 'true';
}

function requireDormitorySelectionOpen() {
  if (!dormitorySelectionOpen()) {
    throw new HttpError(403, 'DORMITORY_SELECTION_CLOSED', '自由选宿舍阶段已关闭');
  }
}

function currentDormitoryForUser(userId) {
  return db.prepare(`
    SELECT d.*, dm.role AS current_user_role, dm.joined_at
    FROM dormitories d JOIN dormitory_members dm ON dm.dormitory_id = d.id
    WHERE dm.user_id = ?
    LIMIT 1
  `).get(userId);
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

function refreshDormitoryStatus(dormitoryId) {
  const dormitory = db.prepare(`
    SELECT d.capacity, d.status, (SELECT COUNT(*) FROM dormitory_members WHERE dormitory_id = d.id) AS member_count
    FROM dormitories d WHERE d.id = ?
  `).get(dormitoryId);
  if (!dormitory || dormitory.status === 'CLOSED') return;
  db.prepare(`UPDATE dormitories SET status = ?, updated_at = ? WHERE id = ?`)
    .run(dormitory.member_count >= dormitory.capacity ? 'FULL' : 'OPEN', now(), dormitoryId);
}

function leaveDormitory(userId, reason = '成员退出宿舍') {
  const dormitory = currentDormitoryForUser(userId);
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

function cleanStringList(value, maxItems = 10) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => cleanText(item, 30)).filter(Boolean))].slice(0, maxItems);
}

function cardInput(body) {
  if (Object.hasOwn(body, 'name') || Object.hasOwn(body, 'grade')) {
    throw new HttpError(403, 'IDENTITY_FIELDS_READ_ONLY', '姓名和年级只能由管理员修改');
  }
  const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
  const avatar = cleanText(body.avatar_url, 3_000_000);
  if (avatar && !avatar.startsWith('/assets/') && !/^data:image\/(png|jpeg|webp);base64,/i.test(avatar)) {
    throw new HttpError(400, 'INVALID_AVATAR', '头像格式不受支持');
  }
  return {
    avatar_url: avatar,
    school: cleanText(body.school, 80),
    campus: cleanText(body.campus, 80),
    department: cleanText(body.department, 80),
    summer_temp_min: number(body.summer_temp_min),
    summer_temp_max: number(body.summer_temp_max),
    winter_temp_min: number(body.winter_temp_min),
    winter_temp_max: number(body.winter_temp_max),
    sleep_preferences: JSON.stringify(cleanStringList(body.sleep_preferences, 3)),
    sleep_schedule_note: cleanText(body.sleep_schedule_note, 120),
    cleanliness_level: cleanText(body.cleanliness_level, 20),
    cleanliness_note: cleanText(body.cleanliness_note, 160),
    personality_tags: JSON.stringify(cleanStringList(body.personality_tags, 8)),
    personality_note: cleanText(body.personality_note, 200),
    roommate_personality_tags: JSON.stringify(cleanStringList(body.roommate_personality_tags, 8)),
    roommate_personality_note: cleanText(body.roommate_personality_note, 200),
    hobbies: JSON.stringify(cleanStringList(body.hobbies, 10)),
    sports: JSON.stringify(cleanStringList(body.sports, 10)),
    hobbies_note: cleanText(body.hobbies_note, 200),
    gaming_frequency: cleanText(body.gaming_frequency, 20),
    gaming_time_note: cleanText(body.gaming_time_note, 120),
    keyboard_noise_tolerance: cleanText(body.keyboard_noise_tolerance, 20),
    media_noise_tolerance: cleanText(body.media_noise_tolerance, 20),
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
  if (!card.avatar_url || !card.school || !parseList(card.sleep_preferences).length ||
      !card.cleanliness_level || !parseList(card.personality_tags).length ||
      !parseList(card.roommate_personality_tags).length || !card.gaming_frequency ||
      !card.keyboard_noise_tolerance || !card.media_noise_tolerance ||
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
      user: { id: user.id, role: user.role, name: user.name, grade: user.grade, gender: user.gender, status: 'ACTIVE' },
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
        id: user.id, loginIdentifier: user.login_identifier, role: user.role,
        name: user.name, grade: user.grade, gender: user.gender, status: user.status,
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
    db.prepare('UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?')
      .run(password.hash, password.salt, now(), user.id);
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/me/deactivate') {
    requireStudent(user);
    const body = await readBody(req);
    if (body.confirmation !== '注销账号') throw new HttpError(400, 'CONFIRMATION_REQUIRED', '请输入“注销账号”确认');
    transaction(() => {
      leaveDormitory(user.id, '成员注销账号');
      db.prepare(`UPDATE users SET status = 'DEACTIVATED', deactivated_at = ?, updated_at = ? WHERE id = ?`)
        .run(now(), now(), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    });
    return json(res, 200, { ok: true }, {
      'Set-Cookie': 'session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
    });
  }

  if (pathname.startsWith('/api/admin/')) {
    requireAdmin(user);
    return handleAdminApi(req, res, url, user);
  }

  requireStudent(user);

  if (method === 'GET' && pathname === '/api/me/roommate-card') {
    return json(res, 200, { card: getCardByUser(user.id) });
  }

  if (method === 'PUT' && pathname === '/api/me/roommate-card') {
    const body = await readBody(req);
    const input = cardInput(body);
    const existing = db.prepare('SELECT * FROM roommate_cards WHERE user_id = ?').get(user.id);
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
    db.prepare(`UPDATE roommate_cards SET status = 'DRAFT', updated_at = ? WHERE user_id = ? AND status != 'HIDDEN'`)
      .run(now(), user.id);
    return json(res, 200, { card: getCardByUser(user.id) });
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
    if (search) cards = cards.filter((card) => [card.name, card.department, ...card.hobbies, ...card.personality_tags]
      .join(' ').toLowerCase().includes(search));
    if (grade) cards = cards.filter((card) => card.grade === grade);
    if (availability === 'AVAILABLE') cards = cards.filter((card) => card.status === 'PUBLISHED');
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
    const other = db.prepare(`SELECT id, status, role FROM users WHERE id = ?`).get(Number(match[1]));
    if (!other || other.role !== 'STUDENT' || other.status !== 'ACTIVE' || other.id === user.id) {
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
             d.capacity AS dormitory_capacity,
             (SELECT COUNT(*) FROM dormitory_members WHERE dormitory_id = d.id) AS dormitory_member_count
      FROM messages m JOIN users u ON u.id = m.sender_id
      LEFT JOIN dormitory_applications a ON a.id = m.application_id
      LEFT JOIN dormitories d ON d.id = a.dormitory_id
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
    return json(res, 200, { open: dormitorySelectionOpen() });
  }

  if (method === 'GET' && pathname === '/api/dormitories') {
    const dormitories = db.prepare(`
      SELECT d.*, u.name AS initiator_name,
        (SELECT id FROM roommate_cards WHERE user_id = d.initiator_id) AS initiator_card_id,
        (SELECT COUNT(*) FROM dormitory_members WHERE dormitory_id = d.id) AS member_count
      FROM dormitories d JOIN users u ON u.id = d.initiator_id
      WHERE d.gender = ? AND d.status IN ('OPEN', 'FULL')
      ORDER BY d.created_at DESC
    `).all(user.gender);
    return json(res, 200, { open: dormitorySelectionOpen(), dormitories });
  }

  if (method === 'GET' && pathname === '/api/me/dormitory') {
    const dormitory = currentDormitoryForUser(user.id);
    const applications = db.prepare(`
      SELECT a.*, d.name AS dormitory_name, d.dormitory_code
      FROM dormitory_applications a JOIN dormitories d ON d.id = a.dormitory_id
      WHERE a.applicant_id = ? ORDER BY a.created_at DESC
    `).all(user.id);
    return json(res, 200, {
      open: dormitorySelectionOpen(),
      dormitory: dormitory ? dormitoryDetails(dormitory.id, user.id) : null,
      applications,
    });
  }

  if (method === 'POST' && pathname === '/api/dormitories') {
    requireDormitorySelectionOpen();
    if (currentDormitoryForUser(user.id)) throw new HttpError(409, 'ALREADY_IN_DORMITORY', '你已经加入一个宿舍');
    const body = await readBody(req);
    const name = cleanText(body.name, 40, true);
    if (!['MALE', 'FEMALE'].includes(user.gender)) throw new HttpError(409, 'GENDER_REQUIRED', '请联系管理员补充性别信息');
    const dormitoryId = transaction(() => {
      const timestamp = now();
      const code = `R${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const id = Number(db.prepare(`
        INSERT INTO dormitories (dormitory_code, name, building, room_number, capacity, initiator_id, gender, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(code, name, '', '', 4, user.id, user.gender, timestamp, timestamp).lastInsertRowid);
      db.prepare(`INSERT INTO dormitory_members (dormitory_id, user_id, role, joined_at) VALUES (?, ?, 'INITIATOR', ?)`)
        .run(id, user.id, timestamp);
      return id;
    });
    return json(res, 201, { dormitory: dormitoryDetails(dormitoryId, user.id) });
  }

  let dormMatch = pathname.match(/^\/api\/dormitories\/(\d+)$/);
  if (dormMatch && method === 'GET') {
    const dormitory = dormitoryDetails(Number(dormMatch[1]), user.id);
    if (!dormitory) throw new HttpError(404, 'DORMITORY_NOT_FOUND', '宿舍不存在');
    return json(res, 200, { open: dormitorySelectionOpen(), dormitory });
  }

  dormMatch = pathname.match(/^\/api\/conversations\/(\d+)\/dormitory-applications$/);
  if (dormMatch && method === 'POST') {
    requireDormitorySelectionOpen();
    if (currentDormitoryForUser(user.id)) throw new HttpError(409, 'ALREADY_IN_DORMITORY', '你已经加入一个宿舍');
    const conversation = getConversation(Number(dormMatch[1]), user.id);
    const body = await readBody(req);
    const dormitory = dormitoryDetails(Number(body.dormitoryId), user.id);
    if (!dormitory || dormitory.status !== 'OPEN' || dormitory.member_count >= dormitory.capacity) {
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
          (dormitory_id, applicant_id, conversation_id, note, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'PENDING', ?, ?)
      `).run(dormitory.id, user.id, conversation.id, note, timestamp, timestamp).lastInsertRowid);
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
    requireDormitorySelectionOpen();
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
    if (application.status !== 'PENDING') throw new HttpError(409, 'APPLICATION_REVIEWED', '申请已处理');
    transaction(() => {
      if (action === 'approve') {
        if (application.dormitory_status !== 'OPEN' || application.member_count >= application.capacity) throw new HttpError(409, 'DORMITORY_FULL', '宿舍已满员');
        if (currentDormitoryForUser(application.applicant_id)) throw new HttpError(409, 'APPLICANT_JOINED_OTHER', '申请人已加入其他宿舍');
        if (application.applicant_gender !== application.dormitory_gender) throw new HttpError(409, 'SAME_GENDER_REQUIRED', '申请人与宿舍性别不一致');
        db.prepare(`INSERT INTO dormitory_members (dormitory_id, user_id, role, joined_at) VALUES (?, ?, 'MEMBER', ?)`)
          .run(application.dormitory_id, application.applicant_id, now());
        db.prepare(`
          UPDATE dormitory_applications SET status = 'CANCELLED', updated_at = ?
          WHERE applicant_id = ? AND status = 'PENDING' AND id != ?
        `).run(now(), application.applicant_id, applicationId);
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
    requireDormitorySelectionOpen();
    const dormitoryId = Number(dormMatch[1]);
    const memberId = Number(dormMatch[2]);
    const dormitory = dormitoryDetails(dormitoryId, user.id);
    if (!dormitory || dormitory.initiator_id !== user.id) throw new HttpError(403, 'INITIATOR_ONLY', '仅宿舍发起人可以移除成员');
    if (memberId === user.id) throw new HttpError(400, 'USE_LEAVE_ENDPOINT', '发起人请使用退出宿舍');
    const result = db.prepare(`DELETE FROM dormitory_members WHERE dormitory_id = ? AND user_id = ?`).run(dormitoryId, memberId);
    if (!result.changes) throw new HttpError(404, 'MEMBER_NOT_FOUND', '宿舍成员不存在');
    refreshDormitoryStatus(dormitoryId);
    return json(res, 200, { dormitory: dormitoryDetails(dormitoryId, user.id) });
  }

  if (method === 'POST' && pathname === '/api/me/dormitory/leave') {
    requireDormitorySelectionOpen();
    const result = transaction(() => leaveDormitory(user.id));
    if (!result) throw new HttpError(404, 'DORMITORY_NOT_FOUND', '你尚未加入宿舍');
    return json(res, 200, { ok: true });
  }

  throw new HttpError(404, 'NOT_FOUND', '接口不存在');
}

async function handleAdminApi(req, res, url, admin) {
  const { method } = req;
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/admin/overview') {
    const counts = {
      students: db.prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'STUDENT'`).get().count,
      activeStudents: db.prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'STUDENT' AND status = 'ACTIVE'`).get().count,
      publishedCards: db.prepare(`SELECT COUNT(*) AS count FROM roommate_cards WHERE status = 'PUBLISHED'`).get().count,
      pendingReports: db.prepare(`SELECT COUNT(*) AS count FROM reports WHERE status = 'PENDING'`).get().count,
      dormitories: db.prepare(`SELECT COUNT(*) AS count FROM dormitories WHERE status IN ('OPEN', 'FULL')`).get().count,
      dormitoryMembers: db.prepare(`SELECT COUNT(*) AS count FROM dormitory_members`).get().count,
      dormitorySelectionOpen: dormitorySelectionOpen(),
    };
    return json(res, 200, { counts });
  }

  if (method === 'GET' && pathname === '/api/admin/users') {
    const users = db.prepare(`
      SELECT u.id, u.login_identifier, u.name, u.grade, u.gender, u.email, u.status, u.last_login_at, u.created_at,
             c.status AS card_status
      FROM users u LEFT JOIN roommate_cards c ON c.user_id = u.id
      WHERE u.role = 'STUDENT' ORDER BY u.id DESC
    `).all();
    return json(res, 200, { users });
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
        const grade = cleanText(item.grade, 20, true);
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
            (login_identifier, password_hash, password_salt, role, name, grade, gender, status, imported_by, created_at, updated_at)
          VALUES (?, ?, ?, 'STUDENT', ?, ?, ?, 'PENDING_ACTIVATION', ?, ?, ?)
        `).run(login, password.hash, password.salt, name, grade, gender, admin.id, timestamp, timestamp).lastInsertRowid);
        created.push({ id, loginIdentifier: login, name, grade, gender, initialPassword });
      } catch (error) {
        failed.push({ row: index + 1, loginIdentifier: item.loginIdentifier || '', reason: error.message });
      }
    }
    audit(admin, req, 'IMPORT_USERS', 'USER_BATCH', created.map((item) => item.id).join(','), '', { created: created.length, failed: failed.length });
    return json(res, 200, { created, failed });
  }

  let match = pathname.match(/^\/api\/admin\/users\/(\d+)\/identity$/);
  if (match && method === 'PATCH') {
    const body = await readBody(req);
    const userId = Number(match[1]);
    const name = cleanText(body.name, 40, true);
    const grade = cleanText(body.grade, 20, true);
    const gender = body.gender;
    if (!['MALE', 'FEMALE'].includes(gender)) {
      throw new HttpError(400, 'INVALID_GENDER', '性别必须为男或女');
    }
    const account = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'STUDENT'`).get(userId);
    if (!account) throw new HttpError(404, 'USER_NOT_FOUND', '学生账号不存在');
    if (account.gender !== gender && currentDormitoryForUser(userId)) {
      throw new HttpError(409, 'USER_IN_DORMITORY', '该学生已加入宿舍，请退出后再修改性别');
    }
    db.prepare(`UPDATE users SET name = ?, grade = ?, gender = ?, updated_at = ? WHERE id = ?`)
      .run(name, grade, gender, now(), userId);
    audit(admin, req, 'UPDATE_IDENTITY', 'USER', userId, cleanText(body.reason, 200), { name, grade, gender });
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
    const account = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'STUDENT'`).get(userId);
    if (!account) throw new HttpError(404, 'USER_NOT_FOUND', '学生账号不存在');
    transaction(() => {
      if (status !== 'ACTIVE') leaveDormitory(userId, `账号状态变更为 ${status}`);
      db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), userId);
    });
    audit(admin, req, 'UPDATE_USER_STATUS', 'USER', userId, cleanText(body.reason, 200, true), { from: account.status, to: status });
    return json(res, 200, { ok: true });
  }

  match = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (match && method === 'DELETE') {
    const body = await readBody(req);
    const userId = Number(match[1]);
    const account = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'STUDENT'`).get(userId);
    if (!account) throw new HttpError(404, 'USER_NOT_FOUND', '学生账号不存在');
    if (body.confirmation !== account.login_identifier) {
      throw new HttpError(400, 'CONFIRMATION_REQUIRED', '请输入该账号的登录标识确认删除');
    }
    const reason = cleanText(body.reason, 200, true);
    audit(admin, req, 'DELETE_USER_PERMANENTLY', 'USER', userId, reason, { loginIdentifier: account.login_identifier, name: account.name });
    leaveDormitory(userId, '管理员永久删除账号');
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/admin/roommate-cards') {
    const cards = db.prepare(`${CARD_SELECT} ORDER BY c.updated_at DESC`).all().map(cardFromRow);
    return json(res, 200, { cards });
  }

  match = pathname.match(/^\/api\/admin\/roommate-cards\/(\d+)\/(hide|restore)$/);
  if (match && method === 'POST') {
    const cardId = Number(match[1]);
    const action = match[2];
    const body = await readBody(req);
    const card = getCard(cardId);
    if (!card) throw new HttpError(404, 'CARD_NOT_FOUND', '室友卡片不存在');
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
    audit(admin, req, action === 'hide' ? 'HIDE_CARD' : 'RESTORE_CARD', 'ROOMMATE_CARD', cardId, reason);
    return json(res, 200, { card: getCard(cardId) });
  }

  if (method === 'GET' && pathname === '/api/admin/settings/dormitory-selection') {
    return json(res, 200, { open: dormitorySelectionOpen() });
  }

  if (method === 'PATCH' && pathname === '/api/admin/settings/dormitory-selection') {
    const body = await readBody(req);
    const reason = cleanText(body.reason, 200, true);
    const open = Boolean(body.open);
    db.prepare(`
      INSERT INTO system_settings (key, value, updated_by, updated_at)
      VALUES ('dormitory_selection_open', ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `).run(String(open), admin.id, now());
    audit(admin, req, open ? 'OPEN_DORMITORY_SELECTION' : 'CLOSE_DORMITORY_SELECTION', 'SYSTEM_SETTING', 'dormitory_selection_open', reason);
    return json(res, 200, { open });
  }

  if (method === 'GET' && pathname === '/api/admin/dormitories') {
    const dormitories = db.prepare('SELECT id FROM dormitories ORDER BY id DESC').all()
      .map((item) => dormitoryDetails(item.id));
    return json(res, 200, { open: dormitorySelectionOpen(), dormitories });
  }

  if (method === 'GET' && pathname === '/api/admin/dormitories/export') {
    const dormitories = db.prepare('SELECT id FROM dormitories ORDER BY id DESC').all()
      .map((item) => dormitoryDetails(item.id));
    const workbook = createDormitoryWorkbook(dormitories);
    const filename = `dormitories-${new Date().toISOString().slice(0, 10)}.xlsx`;
    audit(admin, req, 'EXPORT_DORMITORIES', 'DORMITORY', 'ALL', '', { count: dormitories.length });
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
    const result = db.prepare(`
      UPDATE dormitories SET building = ?, room_number = ?, updated_at = ? WHERE id = ?
    `).run(building, roomNumber, now(), dormitoryId);
    if (!result.changes) throw new HttpError(404, 'DORMITORY_NOT_FOUND', '宿舍不存在');
    audit(admin, req, 'ASSIGN_DORMITORY_LOCATION', 'DORMITORY', dormitoryId, cleanText(body.reason, 200, true), { building, roomNumber });
    return json(res, 200, { dormitory: dormitoryDetails(dormitoryId) });
  }

  match = pathname.match(/^\/api\/admin\/dormitories\/(\d+)\/close$/);
  if (match && method === 'POST') {
    const body = await readBody(req);
    const dormitoryId = Number(match[1]);
    const reason = cleanText(body.reason, 200, true);
    if (!dormitoryDetails(dormitoryId)) throw new HttpError(404, 'DORMITORY_NOT_FOUND', '宿舍不存在');
    db.prepare(`UPDATE dormitories SET status = 'CLOSED', updated_at = ? WHERE id = ?`).run(now(), dormitoryId);
    db.prepare(`UPDATE dormitory_applications SET status = 'CANCELLED', updated_at = ? WHERE dormitory_id = ? AND status = 'PENDING'`)
      .run(now(), dormitoryId);
    audit(admin, req, 'CLOSE_DORMITORY', 'DORMITORY', dormitoryId, reason);
    return json(res, 200, { dormitory: dormitoryDetails(dormitoryId) });
  }

  if (method === 'GET' && pathname === '/api/admin/reports') {
    const reports = db.prepare(`
      SELECT r.*, reporter.name AS reporter_name, handler.name AS handler_name
      FROM reports r JOIN users reporter ON reporter.id = r.reporter_id
      LEFT JOIN users handler ON handler.id = r.handled_by
      ORDER BY CASE r.status WHEN 'PENDING' THEN 0 ELSE 1 END, r.id DESC
    `).all().map((report) => ({ ...report, snapshot: JSON.parse(report.snapshot || '{}') }));
    return json(res, 200, { reports });
  }

  match = pathname.match(/^\/api\/admin\/reports\/(\d+)\/resolve$/);
  if (match && method === 'POST') {
    const body = await readBody(req);
    const reportId = Number(match[1]);
    const status = body.status === 'REJECTED' ? 'REJECTED' : 'RESOLVED';
    const resolution = cleanText(body.resolution, 500, true);
    const result = db.prepare(`
      UPDATE reports SET status = ?, resolution = ?, handled_by = ?, handled_at = ? WHERE id = ?
    `).run(status, resolution, admin.id, now(), reportId);
    if (!result.changes) throw new HttpError(404, 'REPORT_NOT_FOUND', '举报不存在');
    audit(admin, req, 'RESOLVE_REPORT', 'REPORT', reportId, resolution, { status });
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/admin/audit-logs') {
    const logs = db.prepare(`
      SELECT a.*, u.name AS admin_name FROM audit_logs a
      LEFT JOIN users u ON u.id = a.admin_id ORDER BY a.id DESC LIMIT 200
    `).all().map((log) => ({ ...log, metadata: JSON.parse(log.metadata || '{}') }));
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
    if (error instanceof HttpError) return json(res, error.status, { error: { code: error.code, message: error.message } });
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
