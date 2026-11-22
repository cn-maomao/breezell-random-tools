import { createRequire } from 'node:module';
const { build } = createRequire(import.meta.url)('esbuild');
import { mkdtemp, readdir, rm, mkdir, access, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const tempRoot = path.join(root, '.tmp');
let createdRoot = false;
try { await access(tempRoot); } catch { await mkdir(tempRoot); await writeFile(path.join(tempRoot, '.gitignore'), '*\n'); createdRoot = true; }
const temp = await mkdtemp(path.join(tempRoot, 'tests-'));
try {
  const files = (await readdir('test')).filter(file => /\.test\.(ts|mjs)$/.test(file));
  const tests = [];
  for (const file of files) {
    if (file.endsWith('.ts')) {
      const output = path.join(temp, file.replace(/\.ts$/, '.cjs'));
      await build({ entryPoints: [path.join('test', file)], outfile: output, bundle: true, platform: 'node', format: 'cjs', target: 'node18', logLevel: 'warning' });
      tests.push(output);
    } else tests.push(path.resolve('test', file));
  }
  if (!tests.length) throw new Error('No tests found');
  const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(temp, { recursive: true, force: true });
  if (createdRoot) await rm(tempRoot, { recursive: true, force: true });
}
