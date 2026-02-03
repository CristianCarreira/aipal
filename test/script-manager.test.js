const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ScriptManager } = require('../src/script-manager');

test('listScripts includes llm metadata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipal-scripts-'));
  try {
    const scriptPath = path.join(dir, 'xbrief');
    fs.writeFileSync(scriptPath, '#!/bin/sh\necho ok\n');
    fs.chmodSync(scriptPath, 0o755);

    const scriptsJson = {
      scripts: {
        xbrief: {
          description: 'Filtra briefing',
          args: ['--max', '3'],
          llm: { prompt: 'Filtra el briefing para quedarte solo con IA.' },
        },
      },
    };
    fs.writeFileSync(
      path.join(dir, 'scripts.json'),
      JSON.stringify(scriptsJson, null, 2),
    );

    const manager = new ScriptManager(dir);
    const scripts = await manager.listScripts();
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].name, 'xbrief');
    assert.equal(scripts[0].description, 'Filtra briefing');
    assert.deepEqual(scripts[0].args, ['--max', '3']);
    assert.deepEqual(scripts[0].llm, { prompt: 'Filtra el briefing para quedarte solo con IA.' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getScriptMetadata returns metadata or empty object', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipal-scripts-meta-'));
  try {
    const scriptsJson = {
      scripts: {
        inbox: { llm: { prompt: 'Resume los emails.' } },
      },
    };
    fs.writeFileSync(
      path.join(dir, 'scripts.json'),
      JSON.stringify(scriptsJson, null, 2),
    );

    const manager = new ScriptManager(dir);
    const meta = await manager.getScriptMetadata('inbox');
    assert.equal(meta.llm.prompt, 'Resume los emails.');

    const missing = await manager.getScriptMetadata('missing');
    assert.deepEqual(missing, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
