import { spawn } from 'node:child_process';
// Allowlist: .env.local é lido pelo Next, porém suas variáveis públicas são
// sobrescritas e nenhuma credencial de servidor é disponibilizada ao processo.
// Usa cópia temporária sem .env, mantendo o servidor de testes isolado.
import { mkdtemp, cp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = resolve('.'),
  dir = await mkdtemp(join(tmpdir(), 'psywrite-browser-'));
for (const name of [
  'app',
  'components',
  'lib',
  'public',
  'assets',
  'package.json',
  'tsconfig.json',
  'next.config.ts',
  'postcss.config.mjs',
]) {
  await cp(join(root, name), join(dir, name), { recursive: true });
}
await symlink(join(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
const child = spawn(
  process.execPath,
  [
    join(root, 'node_modules/next/dist/bin/next'),
    'dev',
    '--webpack',
    '--hostname',
    '127.0.0.1',
    '--port',
    '3107',
  ],
  {
    cwd: dir,
    stdio: 'inherit',
    env: {
      PATH: process.env.PATH,
      TMPDIR: tmpdir(),
      NODE_ENV: 'development',
      NEXT_TELEMETRY_DISABLED: '1',
      NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54329',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable-key',
    },
  },
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal));
child.on('exit', async (code) => {
  await rm(dir, { recursive: true, force: true });
  process.exitCode = code || 0;
});
