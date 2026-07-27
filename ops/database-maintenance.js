const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function checksum(filename) {
  return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
}

function verify(filename) {
  if (!fs.existsSync(filename)) throw new Error(`Database file does not exist: ${filename}`);
  const checksumFile = `${filename}.sha256`;
  if (!fs.existsSync(checksumFile)) throw new Error(`Checksum file does not exist: ${checksumFile}`);
  const expected = fs.readFileSync(checksumFile, 'utf8').trim().split(/\s+/)[0];
  const actual = checksum(filename);
  if (expected !== actual) throw new Error(`Checksum mismatch for ${filename}`);

  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    const result = database.prepare('PRAGMA quick_check').all();
    if (!result.length || result.some((row) => row.quick_check !== 'ok')) {
      throw new Error(`SQLite quick_check failed for ${filename}`);
    }
  } finally {
    database.close();
  }
}

function backup(source, target) {
  if (!fs.existsSync(source)) throw new Error(`Source database does not exist: ${source}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target) || fs.existsSync(`${target}.sha256`)) {
    throw new Error(`Backup target already exists: ${target}`);
  }

  const temporary = `${target}.tmp`;
  fs.rmSync(temporary, { force: true });
  fs.rmSync(`${temporary}.sha256`, { force: true });
  const escaped = temporary.replaceAll("'", "''");
  const database = new DatabaseSync(source);
  try {
    database.exec('PRAGMA busy_timeout = 10000');
    database.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    database.close();
  }

  const digest = checksum(temporary);
  fs.writeFileSync(`${temporary}.sha256`, `${digest}  ${path.basename(target)}\n`, { flag: 'wx' });
  verify(temporary);
  fs.renameSync(temporary, target);
  fs.renameSync(`${temporary}.sha256`, `${target}.sha256`);
  process.stdout.write(`${JSON.stringify({ operation: 'backup', source, target, sha256: digest })}\n`);
}

function restore(source, target) {
  verify(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.restore.tmp`;
  fs.rmSync(temporary, { force: true });
  fs.copyFileSync(source, temporary);
  if (process.platform !== 'win32') {
    const handle = fs.openSync(temporary, 'r');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
  }

  const digest = checksum(temporary);
  const sourceDigest = fs.readFileSync(`${source}.sha256`, 'utf8').trim().split(/\s+/)[0];
  if (digest !== sourceDigest) throw new Error('Restored temporary database checksum mismatch');

  fs.rmSync(`${target}-wal`, { force: true });
  fs.rmSync(`${target}-shm`, { force: true });
  if (process.platform === 'win32') fs.rmSync(target, { force: true });
  fs.renameSync(temporary, target);

  const database = new DatabaseSync(target, { readOnly: true });
  try {
    const result = database.prepare('PRAGMA quick_check').all();
    if (!result.length || result.some((row) => row.quick_check !== 'ok')) {
      throw new Error(`SQLite quick_check failed after restoring ${target}`);
    }
  } finally {
    database.close();
  }
  process.stdout.write(`${JSON.stringify({ operation: 'restore', source, target, sha256: digest })}\n`);
}

function prune(directory, retainText) {
  const retain = Number(retainText);
  if (!Number.isInteger(retain) || retain < 1) throw new Error('Retention count must be a positive integer');
  if (!fs.existsSync(directory)) return;
  const backups = fs.readdirSync(directory)
    .filter((name) => name.endsWith('.db'))
    .map((name) => ({ name, modified: fs.statSync(path.join(directory, name)).mtimeMs }))
    .sort((left, right) => right.modified - left.modified);
  for (const backupFile of backups.slice(retain)) {
    const filename = path.join(directory, backupFile.name);
    fs.rmSync(filename, { force: true });
    fs.rmSync(`${filename}.sha256`, { force: true });
  }
  process.stdout.write(`${JSON.stringify({ operation: 'prune', directory, retained: Math.min(backups.length, retain) })}\n`);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'backup' && args.length === 2) backup(args[0], args[1]);
  else if (command === 'verify' && args.length === 1) {
    verify(args[0]);
    process.stdout.write(`${JSON.stringify({ operation: 'verify', filename: args[0] })}\n`);
  } else if (command === 'restore' && args.length === 2) restore(args[0], args[1]);
  else if (command === 'prune' && args.length === 2) prune(args[0], args[1]);
  else throw new Error('Usage: backup <source> <target> | verify <backup> | restore <backup> <target> | prune <directory> <retain>');
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
