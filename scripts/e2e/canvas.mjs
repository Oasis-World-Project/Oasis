// 在正式的桌面外壳里打开画布成果（apps/desktop/test/canvas-smoke.cjs），按测试计划点一遍。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ROOT } from './stack.mjs';

export async function checkCanvas({ t, webUrl, outDir, artifact, plan }) {
  const evidence = path.resolve(outDir, 'canvas', `${t.name}-${artifact.id.slice(0, 8)}`);
  mkdirSync(evidence, { recursive: true });
  const electron = createRequire(path.join(ROOT, 'apps/desktop/package.json'))('electron');
  const output = await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(ROOT, 'apps/desktop/test/canvas-smoke.cjs')], {
      env: {
        ...process.env,
        OASIS_WEB_URL: webUrl,
        OASIS_CANVAS_PATH: `/canvas/artifacts/${artifact.id}`,
        OASIS_CANVAS_COOKIE: t.user.cookie(),
        OASIS_CANVAS_PLAN: JSON.stringify(plan),
        OASIS_CANVAS_EVIDENCE: evidence,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stdout.on('data', (bytes) => (text += bytes));
    child.stderr.on('data', (bytes) => (text += bytes));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, text }));
  });
  writeFileSync(path.join(evidence, 'electron.log'), output.text);
  const ok = output.code === 0 && output.text.includes('CANVAS_OK');
  t.check(
    ok,
    `桌面端画布里没能运行网页：${
      output.text
        .split('\n')
        .filter((l) => l.includes('画布回归'))
        .join(' ') || `退出码 ${output.code}`
    }`,
  );
  if (ok) t.log('桌面端画布里打开并操作通过');
}
