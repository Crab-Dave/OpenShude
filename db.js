const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEMO_STUDENTS = [
  ['2026001', '林夏', '2026级', 'FEMALE', '/assets/avatar-1.png', 24, 26, 20, 23, ['早起', '午休'], 'STRICT', ['开朗', '直接'], ['坦诚', '有边界感'], ['摄影', '音乐'], ['羽毛球'], 'OCCASIONAL', 'CONDITIONAL', 'MIND', '我整理东西时容易过度追求分类。', '希望一起把宿舍住成舒服、彼此尊重的小空间。'],
  ['2026002', '陈遇', '2026级', 'MALE', '/assets/avatar-2.png', 25, 27, 19, 22, ['晚睡'], 'NORMAL', ['安静', '随和'], ['好沟通', '稳定'], ['电影', '桌游'], ['跑步'], 'FREQUENT', 'TOLERATE', 'MIND', '有时戴着耳机就听不到别人叫我。', '游戏会戴耳机，也愿意提前约定安静时间。'],
  ['2026003', '苏晴', '2025级', 'FEMALE', '/assets/avatar-3.png', 24, 25, 21, 24, ['早起'], 'STRICT', ['自律', '慢热'], ['整洁', '守时'], ['阅读', '烘焙'], ['游泳'], 'RARELY', 'MIND', 'MIND', '刚认识时话不多，需要一点熟悉时间。', '希望晚上十一点后尽量安静。'],
  ['2026004', '周屿', '2025级', 'MALE', '/assets/avatar-4.png', 23, 26, 18, 22, ['晚睡', '午休'], 'RELAXED', ['外向', '幽默'], ['包容', '直爽'], ['篮球', '电竞'], ['篮球'], 'FREQUENT', 'TOLERATE', 'CONDITIONAL', '偶尔会忘记把衣服及时收进柜子。', '喜欢热闹，但重要时间会尊重大家的安排。'],
  ['2026005', '沈知行', '2026级', 'MALE', '/assets/avatar-5.png', 26, 28, 20, 24, ['早起', '午休'], 'NORMAL', ['理性', '温和'], ['讲道理', '可靠'], ['编程', '科幻'], ['骑行'], 'OCCASIONAL', 'CONDITIONAL', 'MIND', '做事情投入时会忘记时间。', '可以一起学习，也能各自安静做自己的事。'],
  ['2026006', '江晚', '2026级', 'FEMALE', '/assets/avatar-6.png', 24, 27, 20, 23, ['晚睡'], 'NORMAL', ['细腻', '独立'], ['尊重隐私', '友善'], ['绘画', '音乐'], ['瑜伽'], 'RARELY', 'MIND', 'MIND', '对突然的噪音比较敏感。', '期待有边界感，也愿意互相照顾的室友关系。'],
  ['2026007', '许舟', '2026级', 'MALE', '/assets/avatar-7.png', 24, 26, 19, 22, ['早起'], 'STRICT', ['自律', '直接'], ['整洁', '好沟通'], ['吉他', '历史'], ['足球'], 'OCCASIONAL', 'CONDITIONAL', 'MIND', '周末有时起得特别早。', '希望一起维护安静整洁的宿舍。'],
  ['2026008', '唐宁', '2025级', 'FEMALE', '/assets/avatar-8.png', 25, 27, 20, 24, ['晚睡', '午休'], 'NORMAL', ['随和', '开朗'], ['友善', '有边界感'], ['舞蹈', '电影'], ['网球'], 'RARELY', 'MIND', 'MIND', '偶尔会把快递盒放到第二天再收。', '愿意提前沟通作息和卫生安排。'],
  ['2026009', '顾言', '2025级', 'MALE', '/assets/avatar-9.png', 23, 25, 18, 21, ['晚睡'], 'RELAXED', ['安静', '独立'], ['尊重隐私', '包容'], ['模型', '音乐'], ['乒乓球'], 'FREQUENT', 'TOLERATE', 'MIND', '专注时不太主动聊天。', '打游戏会戴耳机，不影响他人休息。'],
  ['2026010', '叶澜', '2026级', 'FEMALE', '/assets/avatar-10.png', 24, 26, 21, 24, ['早起', '午休'], 'STRICT', ['细腻', '自律'], ['守时', '坦诚'], ['手账', '阅读'], ['慢跑'], 'RARELY', 'MIND', 'MIND', '对桌面杂物比较敏感。', '希望生活节奏稳定，公共区域保持整洁。'],
  ['2026011', '陆川', '2026级', 'MALE', '/assets/avatar-11.png', 25, 28, 20, 23, ['晚睡'], 'NORMAL', ['外向', '随和'], ['直爽', '好沟通'], ['旅行', '摄影'], ['排球'], 'OCCASIONAL', 'CONDITIONAL', 'CONDITIONAL', '偶尔说话声音会有点大。', '接受不同作息，重要事情及时沟通。'],
  ['2026012', '温然', '2025级', 'FEMALE', '/assets/avatar-12.png', 24, 25, 20, 22, ['早起'], 'NORMAL', ['温和', '慢热'], ['包容', '尊重隐私'], ['钢琴', '展览'], ['羽毛球'], 'RARELY', 'MIND', 'MIND', '刚认识时比较拘谨。', '期待安静、有边界感又互相照顾的宿舍。'],
];

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return {
    salt,
    hash: crypto.scryptSync(password, salt, 64).toString('hex'),
  };
}

function openDatabase(filename = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db')) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  createSchema(db);
  migrateSchema(db);
  seedDatabase(db);
  return db;
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      login_identifier TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('STUDENT', 'ADMIN')),
      name TEXT NOT NULL,
      grade TEXT NOT NULL,
      gender TEXT NOT NULL DEFAULT 'UNSPECIFIED' CHECK (gender IN ('MALE', 'FEMALE', 'UNSPECIFIED')),
      email TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING_ACTIVATION'
        CHECK (status IN ('PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'BANNED', 'DEACTIVATED')),
      imported_by INTEGER REFERENCES users(id),
      deactivated_at TEXT,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roommate_cards (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      avatar_url TEXT NOT NULL DEFAULT '',
      school TEXT NOT NULL DEFAULT '',
      campus TEXT NOT NULL DEFAULT '',
      department TEXT NOT NULL DEFAULT '',
      summer_temp_min INTEGER,
      summer_temp_max INTEGER,
      winter_temp_min INTEGER,
      winter_temp_max INTEGER,
      sleep_preferences TEXT NOT NULL DEFAULT '[]',
      sleep_schedule_note TEXT NOT NULL DEFAULT '',
      cleanliness_level TEXT NOT NULL DEFAULT '',
      cleanliness_note TEXT NOT NULL DEFAULT '',
      personality_tags TEXT NOT NULL DEFAULT '[]',
      personality_note TEXT NOT NULL DEFAULT '',
      roommate_personality_tags TEXT NOT NULL DEFAULT '[]',
      roommate_personality_note TEXT NOT NULL DEFAULT '',
      hobbies TEXT NOT NULL DEFAULT '[]',
      sports TEXT NOT NULL DEFAULT '[]',
      hobbies_note TEXT NOT NULL DEFAULT '',
      gaming_frequency TEXT NOT NULL DEFAULT '',
      gaming_time_note TEXT NOT NULL DEFAULT '',
      keyboard_noise_tolerance TEXT NOT NULL DEFAULT '',
      media_noise_tolerance TEXT NOT NULL DEFAULT '',
      self_acknowledged_shortcoming TEXT NOT NULL DEFAULT '',
      additional_note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT', 'PUBLISHED', 'HIDDEN')),
      hidden_reason TEXT,
      published_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY,
      student_a_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      student_b_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_message_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(student_a_id, student_b_id),
      CHECK(student_a_id < student_b_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation
      ON messages(conversation_id, created_at, id);

    CREATE TABLE IF NOT EXISTS conversation_reads (
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_message_id INTEGER,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(conversation_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS blocks (
      blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY(blocker_id, blocked_id)
    );

    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY,
      reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL CHECK (target_type IN ('ROOMMATE_CARD', 'MESSAGE')),
      target_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      snapshot TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RESOLVED', 'REJECTED')),
      handled_by INTEGER REFERENCES users(id),
      resolution TEXT,
      created_at TEXT NOT NULL,
      handled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY,
      admin_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      metadata TEXT NOT NULL DEFAULT '{}',
      ip_address TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      csrf_token TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dormitories (
      id INTEGER PRIMARY KEY,
      dormitory_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      building TEXT NOT NULL DEFAULT '',
      room_number TEXT NOT NULL DEFAULT '',
      capacity INTEGER NOT NULL DEFAULT 4 CHECK (capacity = 4),
      initiator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      gender TEXT NOT NULL CHECK (gender IN ('MALE', 'FEMALE')),
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'FULL', 'CLOSED')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dormitory_members (
      dormitory_id INTEGER NOT NULL REFERENCES dormitories(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('INITIATOR', 'MEMBER')),
      joined_at TEXT NOT NULL,
      PRIMARY KEY(dormitory_id, user_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_dormitory_member_user ON dormitory_members(user_id);

    CREATE TABLE IF NOT EXISTS dormitory_applications (
      id INTEGER PRIMARY KEY,
      dormitory_id INTEGER NOT NULL REFERENCES dormitories(id) ON DELETE CASCADE,
      applicant_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
      reviewed_by INTEGER REFERENCES users(id),
      reviewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_dormitory_application
      ON dormitory_applications(dormitory_id, applicant_id) WHERE status = 'PENDING';
  `);
}

function migrateSchema(db) {
  db.exec('DROP TABLE IF EXISTS dormitory_group_members; DROP TABLE IF EXISTS dormitory_groups;');
  const messageColumns = db.prepare('PRAGMA table_info(messages)').all().map((column) => column.name);
  if (!messageColumns.includes('message_type')) {
    db.exec("ALTER TABLE messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'TEXT'");
  }
  if (!messageColumns.includes('application_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN application_id INTEGER');
  }
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map((column) => column.name);
  if (!userColumns.includes('gender')) {
    db.exec("ALTER TABLE users ADD COLUMN gender TEXT NOT NULL DEFAULT 'UNSPECIFIED'");
  }
  const dormitoryColumns = db.prepare('PRAGMA table_info(dormitories)').all().map((column) => column.name);
  if (!dormitoryColumns.includes('gender')) {
    db.exec("ALTER TABLE dormitories ADD COLUMN gender TEXT NOT NULL DEFAULT 'UNSPECIFIED'");
  }
  db.prepare(`
    INSERT OR IGNORE INTO system_settings (key, value, updated_at)
    VALUES ('dormitory_selection_open', 'true', ?)
  `).run(new Date().toISOString());
  db.prepare(`UPDATE roommate_cards SET status = 'PUBLISHED' WHERE status = 'ROOMMATE_CONFIRMED'`).run();
  db.prepare(`UPDATE dormitories SET capacity = 4`).run();
  for (const [login, , , gender] of DEMO_STUDENTS) {
    db.prepare(`UPDATE users SET gender = ? WHERE login_identifier = ? AND gender = 'UNSPECIFIED'`).run(gender, login);
  }
  db.prepare(`
    UPDATE dormitories SET gender = COALESCE((SELECT gender FROM users WHERE id = initiator_id), gender)
  `).run();
}

function seedDatabase(db) {
  const now = new Date().toISOString();
  const insertUser = db.prepare(`
    INSERT INTO users
      (login_identifier, password_hash, password_salt, role, name, grade, gender, status, imported_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let admin = db.prepare(`SELECT id FROM users WHERE login_identifier = 'admin'`).get();
  if (!admin) {
    const adminPassword = hashPassword('Admin123!');
    admin = { id: Number(insertUser.run(
      'admin', adminPassword.hash, adminPassword.salt, 'ADMIN', '系统管理员', '-', 'UNSPECIFIED', 'ACTIVE', null, now, now,
    ).lastInsertRowid) };
  }

  const insertCard = db.prepare(`
    INSERT INTO roommate_cards (
      user_id, avatar_url, school, campus, department,
      summer_temp_min, summer_temp_max, winter_temp_min, winter_temp_max,
      sleep_preferences, sleep_schedule_note, cleanliness_level, cleanliness_note,
      personality_tags, personality_note, roommate_personality_tags, roommate_personality_note,
      hobbies, sports, hobbies_note, gaming_frequency, gaming_time_note,
      keyboard_noise_tolerance, media_noise_tolerance,
      self_acknowledged_shortcoming, additional_note, status, published_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PUBLISHED', ?, ?, ?)
  `);

  for (let i = 0; i < DEMO_STUDENTS.length; i += 1) {
    const [login, name, grade, gender, avatar, summerMin, summerMax, winterMin, winterMax,
      sleep, clean, personality, expected, hobbies, sports, gaming, keyboard, media, weakness, note] = DEMO_STUDENTS[i];
    if (db.prepare(`SELECT 1 FROM users WHERE login_identifier = ?`).get(login)) continue;
    const password = hashPassword('Student123!');
    const userId = Number(insertUser.run(
      login, password.hash, password.salt, 'STUDENT', name, grade, gender, 'ACTIVE', admin.id, now, now,
    ).lastInsertRowid);
    insertCard.run(
      userId, avatar, '明德大学', i % 2 ? '南校区' : '北校区', ['计算机学院', '设计学院', '商学院'][i % 3],
      summerMin, summerMax, winterMin, winterMax,
      JSON.stringify(sleep), '', clean, '', JSON.stringify(personality), '', JSON.stringify(expected), '',
      JSON.stringify(hobbies), JSON.stringify(sports), '', gaming, '', keyboard, media, weakness, note, now, now, now,
    );
  }
}

module.exports = { openDatabase, hashPassword };
