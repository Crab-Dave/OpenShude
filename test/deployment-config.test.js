const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('non-interactive deployment commands cannot consume the remote script input', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/deploy.yml'), 'utf8');
  assert.match(workflow, /docker compose -f compose\.prod\.yml "\$@" <\/dev\/null/);

  for (const filename of ['.github/workflows/deploy.yml', 'ops/restore-database.sh']) {
    const content = fs.readFileSync(path.join(__dirname, '..', filename), 'utf8');
    const composeRuns = content.split(/\r?\n/).filter((line) => /\bcompose\b.*\brun\b/.test(line));
    assert.ok(composeRuns.length > 0, `${filename} must contain maintenance containers`);
    for (const command of composeRuns) assert.match(command, /\brun -T\b/, command.trim());
  }
});
