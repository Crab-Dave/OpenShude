const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openDatabase, hashPassword } = require('../db');

const databasePath = path.join(__dirname, 'authorization-migration-test.db');

test('legacy roles migrate once and later account type changes survive restart', () => {
  fs.rmSync(databasePath, { force: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      login_identifier TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('STUDENT', 'ADMIN')),
      name TEXT NOT NULL,
      grade TEXT NOT NULL,
      gender TEXT NOT NULL DEFAULT 'UNSPECIFIED',
      major TEXT NOT NULL DEFAULT '',
      email TEXT,
      status TEXT NOT NULL,
      imported_by INTEGER REFERENCES users(id),
      deactivated_at TEXT,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const timestamp = new Date().toISOString();
  const adminPassword = hashPassword('Admin123!');
  const studentPassword = hashPassword('Student123!');
  const insert = legacy.prepare(`
    INSERT INTO users (
      login_identifier, password_hash, password_salt, role, name, grade, gender,
      major, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
  `);
  insert.run('admin', adminPassword.hash, adminPassword.salt, 'ADMIN', '旧管理员', '-', 'UNSPECIFIED', '', timestamp, timestamp);
  insert.run('legacy-user', studentPassword.hash, studentPassword.salt, 'STUDENT', '旧用户', '2026级', 'FEMALE', '计算机科学与技术', timestamp, timestamp);
  legacy.close();

  let migrated = openDatabase(databasePath);
  assert.equal(migrated.prepare("SELECT account_type FROM users WHERE login_identifier = 'admin'").get().account_type, 'SUPER_ADMIN');
  const student = migrated.prepare("SELECT id, account_type, grade_id FROM users WHERE login_identifier = 'legacy-user'").get();
  assert.equal(student.account_type, 'USER');
  assert.ok(student.grade_id);
  migrated.prepare("UPDATE users SET account_type = 'SUPER_ADMIN' WHERE id = ?").run(student.id);
  migrated.close();

  migrated = openDatabase(databasePath);
  assert.equal(migrated.prepare('SELECT account_type FROM users WHERE id = ?').get(student.id).account_type, 'SUPER_ADMIN');
  migrated.close();
  fs.rmSync(databasePath, { force: true });
});

test('legacy dormitory data migrates into an initial round without blocking later rounds', () => {
  const dormitoryPath = path.join(__dirname, 'dormitory-round-migration-test.db');
  fs.rmSync(dormitoryPath, { force: true });
  const legacy = new DatabaseSync(dormitoryPath);
  legacy.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      login_identifier TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('STUDENT', 'ADMIN')),
      name TEXT NOT NULL,
      grade TEXT NOT NULL,
      gender TEXT NOT NULL DEFAULT 'UNSPECIFIED',
      major TEXT NOT NULL DEFAULT '',
      email TEXT,
      status TEXT NOT NULL,
      imported_by INTEGER REFERENCES users(id),
      deactivated_at TEXT,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE system_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_by INTEGER REFERENCES users(id),
      updated_at TEXT NOT NULL
    );
    CREATE TABLE dormitories (
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
    CREATE TABLE dormitory_members (
      dormitory_id INTEGER NOT NULL REFERENCES dormitories(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('INITIATOR', 'MEMBER')),
      joined_at TEXT NOT NULL,
      PRIMARY KEY(dormitory_id, user_id)
    );
    CREATE UNIQUE INDEX idx_dormitory_member_user ON dormitory_members(user_id);
  `);
  const timestamp = new Date().toISOString();
  const adminPassword = hashPassword('Admin123!');
  const studentPassword = hashPassword('Student123!');
  const insertUser = legacy.prepare(`
    INSERT INTO users (
      login_identifier, password_hash, password_salt, role, name, grade, gender,
      major, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
  `);
  const adminId = Number(insertUser.run('admin', adminPassword.hash, adminPassword.salt, 'ADMIN', '旧管理员', '-', 'UNSPECIFIED', '', timestamp, timestamp).lastInsertRowid);
  const studentId = Number(insertUser.run('legacy-student', studentPassword.hash, studentPassword.salt, 'STUDENT', '旧宿舍成员', '2026级', 'MALE', '计算机科学与技术', timestamp, timestamp).lastInsertRowid);
  legacy.prepare("INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES ('dormitory_selection_open', 'false', ?, ?)").run(adminId, timestamp);
  const dormitoryId = Number(legacy.prepare(`
    INSERT INTO dormitories (dormitory_code, name, initiator_id, gender, created_at, updated_at)
    VALUES ('LEGACY-DORM', '旧宿舍', ?, 'MALE', ?, ?)
  `).run(studentId, timestamp, timestamp).lastInsertRowid);
  legacy.prepare(`INSERT INTO dormitory_members (dormitory_id, user_id, role, joined_at) VALUES (?, ?, 'INITIATOR', ?)`)
    .run(dormitoryId, studentId, timestamp);
  legacy.close();

  const migrated = openDatabase(dormitoryPath);
  const initialRound = migrated.prepare("SELECT * FROM dormitory_selection_rounds WHERE code = 'LEGACY_INITIAL'").get();
  assert.equal(initialRound.status, 'CLOSED');
  assert.equal(migrated.prepare('SELECT selection_round_id FROM dormitories WHERE id = ?').get(dormitoryId).selection_round_id, initialRound.id);
  assert.equal(migrated.prepare('SELECT selection_round_id FROM dormitory_members WHERE dormitory_id = ?').get(dormitoryId).selection_round_id, initialRound.id);
  assert.ok(migrated.prepare('SELECT 1 FROM dormitory_round_participants WHERE round_id = ? AND user_id = ?').get(initialRound.id, studentId));
  const indexes = migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'dormitory_members'").all().map((item) => item.name);
  assert.equal(indexes.includes('idx_dormitory_member_user'), false);
  assert.equal(indexes.includes('idx_dormitory_member_round_user'), true);

  const secondRoundId = Number(migrated.prepare(`
    INSERT INTO dormitory_selection_rounds (code, name, status, created_by, created_at, updated_at)
    VALUES ('SECOND', '第二轮', 'OPEN', ?, ?, ?)
  `).run(adminId, timestamp, timestamp).lastInsertRowid);
  const secondDormitoryId = Number(migrated.prepare(`
    INSERT INTO dormitories (selection_round_id, dormitory_code, name, initiator_id, gender, created_at, updated_at)
    VALUES (?, 'SECOND-DORM', '第二轮宿舍', ?, 'MALE', ?, ?)
  `).run(secondRoundId, studentId, timestamp, timestamp).lastInsertRowid);
  migrated.prepare(`
    INSERT INTO dormitory_members (selection_round_id, dormitory_id, user_id, role, joined_at)
    VALUES (?, ?, ?, 'INITIATOR', ?)
  `).run(secondRoundId, secondDormitoryId, studentId, timestamp);
  assert.throws(() => migrated.prepare(`
    INSERT INTO dormitory_members (selection_round_id, dormitory_id, user_id, role, joined_at)
    VALUES (?, ?, ?, 'MEMBER', ?)
  `).run(secondRoundId, secondDormitoryId, studentId, timestamp), /UNIQUE constraint failed/);
  migrated.close();
  fs.rmSync(dormitoryPath, { force: true });
});

test('production bootstrap uses a deployment secret and requires an initial password change', () => {
  const productionPath = path.join(__dirname, 'authorization-production-test.db');
  fs.rmSync(productionPath, { force: true });
  const previousNodeEnv = process.env.NODE_ENV;
  const previousPassword = process.env.INITIAL_ADMIN_PASSWORD;
  try {
    process.env.NODE_ENV = 'production';
    process.env.INITIAL_ADMIN_PASSWORD = 'OneTime-Strong-Password!';
    let production = openDatabase(productionPath);
    const admin = production.prepare("SELECT account_type, must_change_password FROM users WHERE login_identifier = 'admin'").get();
    assert.equal(admin.account_type, 'SUPER_ADMIN');
    assert.equal(admin.must_change_password, 1);
    production.close();

    delete process.env.INITIAL_ADMIN_PASSWORD;
    production = openDatabase(productionPath);
    assert.equal(production.prepare("SELECT COUNT(*) AS count FROM users WHERE account_type = 'SUPER_ADMIN'").get().count, 1);
    production.close();
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousPassword === undefined) delete process.env.INITIAL_ADMIN_PASSWORD;
    else process.env.INITIAL_ADMIN_PASSWORD = previousPassword;
    fs.rmSync(productionPath, { force: true });
  }
});
