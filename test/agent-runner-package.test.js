'use strict';

// What the desktop app ships of the agent runner (integrations/agent-runner) for Run on this computer: its four
// program files, by name in package.json's build.files. A README, agent.json, a state file or a log in that folder,
// such as those a person keeps there to run it by hand, stays out of the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('the app ships the runner as its four program files, by name, and the child needs no other', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const runner = pkg.build.files.filter((f) => f.startsWith('integrations/'));
  assert.deepEqual(runner.sort(), ['integrations/agent-runner/backends.js', 'integrations/agent-runner/prompt.js', 'integrations/agent-runner/rukoo.js', 'integrations/agent-runner/runner.js']);
  // What those files and the child load from the runner's folder is among them.
  const dirOf = path.join(__dirname, '..', 'integrations', 'agent-runner');
  const loads = new Set();
  for (const f of ['runner.js', 'rukoo.js', 'backends.js', 'prompt.js']) for (const m of fs.readFileSync(path.join(dirOf, f), 'utf8').matchAll(/require\('\.\/([a-z]+)(?:\.js)?'\)/g)) loads.add(`integrations/agent-runner/${m[1]}.js`);
  for (const m of fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'agent-runner-child.js'), 'utf8').matchAll(/require\('\.\.\/\.\.\/(integrations\/agent-runner\/[a-z]+\.js)'\)/g)) loads.add(m[1]);
  for (const f of loads) assert.ok(runner.includes(f), f);
});
