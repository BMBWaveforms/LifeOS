// The existing workflow runs tests/*.cjs; load the candidate suites through that
// entry point without requiring any new GitHub workflow permissions.
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
for (const name of fs.readdirSync(path.join(root, 'frontend/horizon')).filter(name => name.endsWith('.mjs'))) {
  const checked = spawnSync(process.execPath, ['--check', path.join(root, 'frontend/horizon', name)], {encoding:'utf8'});
  if (checked.status !== 0) throw new Error(checked.stderr || `Syntax check failed: ${name}`);
}
for (const name of fs.readdirSync(path.join(__dirname, 'horizon')).filter(name => name.endsWith('.test.mjs'))) {
  require(path.join(__dirname, 'horizon', name));
}
