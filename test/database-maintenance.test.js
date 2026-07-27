const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const maintenanceScript = path.join(__dirname, '..', 'ops', 'database-maintenance.js');

test('database maintenance creates, verifies, restores, and prunes backups', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openshude-backup-'));
  try {
    const databasePath = path.join(directory, 'app.db');
    const backupDirectory = path.join(directory, 'backups');
    const firstBackup = path.join(backupDirectory, 'first.db');
    const secondBackup = path.join(backupDirectory, 'second.db');
    const database = new DatabaseSync(databasePath);
    database.exec('CREATE TABLE sample (value TEXT NOT NULL); INSERT INTO sample VALUES (\'original\')');
    database.close();

    execFileSync(process.execPath, [maintenanceScript, 'backup', databasePath, firstBackup]);
    execFileSync(process.execPath, [maintenanceScript, 'verify', firstBackup]);
    assert.equal(fs.existsSync(`${firstBackup}.sha256`), true);

    const changed = new DatabaseSync(databasePath);
    changed.exec("UPDATE sample SET value = 'changed'");
    changed.close();
    execFileSync(process.execPath, [maintenanceScript, 'restore', firstBackup, databasePath]);

    const restored = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(restored.prepare('SELECT value FROM sample').get().value, 'original');
    restored.close();

    execFileSync(process.execPath, [maintenanceScript, 'backup', databasePath, secondBackup]);
    execFileSync(process.execPath, [maintenanceScript, 'prune', backupDirectory, '1']);
    assert.equal(fs.existsSync(firstBackup), false);
    assert.equal(fs.existsSync(secondBackup), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
