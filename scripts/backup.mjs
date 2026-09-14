// Run locally, never in Vercel. All restoration targets are new disposable local databases.
import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  readFile,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID, createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { encrypt, decrypt, digest, pack, unpack } from './backup-crypto.mjs';

const args = process.argv.slice(2),
  command = args[0],
  value = (k) => args[args.indexOf(k) + 1];
if (!['create', 'verify'].includes(command) || !args.includes('--file'))
  throw new Error(
    'Uso: node scripts/backup.mjs create --local|--remote --file /destino/copia.psybackup OU verify --file /destino/copia.psybackup',
  );
const password = process.env.PSYWRITE_BACKUP_PASSPHRASE;
if (!password || password.length < 16)
  throw new Error(
    'Informe PSYWRITE_BACKUP_PASSPHRASE pelo terminal (mínimo 16 caracteres).',
  );
const container =
  process.env.PSYWRITE_LOCAL_DB_CONTAINER || 'supabase_db_prototipo';
if (!/^supabase_db_[a-zA-Z0-9_-]+$/.test(container))
  throw new Error('Container local inválido.');
const work = await mkdtemp(join(tmpdir(), 'psywrite-backup-')),
  scratch = 'psy_restore_' + randomUUID().replaceAll('-', '');
let created = false,
  completed = false,
  outputCreated = false;
const file = resolve(value('--file'));
function sql(query, database = scratch) {
  return execFileSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      database,
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      '-c',
      query,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}
async function processFile(params, path, direction, env = process.env) {
  const child = spawn('docker', params, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Capture no database diagnostics in logs: these can contain clinical values.
  if (args.includes('--local') && process.env.PSYWRITE_TEST_DIAGNOSTICS === '1')
    child.stderr.pipe(process.stderr);
  else child.stderr.resume();
  const exit = new Promise((yes, no) => {
    child.on('error', no);
    child.on('close', (code) =>
      code === 0
        ? yes()
        : no(
            new Error(
              'Operação PostgreSQL falhou. Nenhum banco existente foi substituído.',
            ),
          ),
    );
  });
  const transfer =
    direction === 'out'
      ? pipeline(
          child.stdout,
          createWriteStream(path, { flags: 'wx', mode: 0o600 }),
        )
      : pipeline(createReadStream(path), child.stdin);
  if (direction === 'out') child.stdin.end();
  else child.stdout.resume();
  await Promise.all([transfer, exit]);
}
async function restoreDatabase() {
  sql(`CREATE DATABASE ${scratch} TEMPLATE template0`, 'postgres');
  created = true;
  sql('DROP SCHEMA public');
  await processFile(
    [
      'exec',
      '-i',
      container,
      'pg_restore',
      '-U',
      'supabase_admin',
      '-d',
      scratch,
      '--exit-on-error',
    ],
    join(work, 'database.dump'),
    'in',
  );
}
function inventory() {
  return JSON.parse(
    sql(
      "select coalesce(json_agg(row_to_json(a)),'[]') from (select storage_path,size,mime from public.attachments order by storage_path) a",
    ),
  );
}
function counts() {
  return JSON.parse(
    sql(
      "select json_build_object('patients',(select count(*) from public.patients),'consultations',(select count(*) from public.consultations),'documents',(select count(*) from public.clinical_documents),'attachments',(select count(*) from public.attachments),'audit_events',(select count(*) from public.audit_events),'users',(select count(*) from auth.users))",
    ),
  );
}
try {
  if (command === 'create') {
    let api,
      key,
      params = [
        'exec',
        container,
        'pg_dump',
        '-U',
        'postgres',
        '-d',
        'postgres',
      ],
      env = process.env;
    if (args.includes('--local')) {
      const raw = execFileSync(
        'node_modules/.bin/supabase',
        ['status', '-o', 'json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const status = JSON.parse(raw.slice(raw.indexOf('{')));
      api = status.API_URL;
      key = status.SECRET_KEY;
      if (!api.startsWith('http://127.0.0.1:'))
        throw new Error('Destino local não confirmado.');
    } else if (args.includes('--remote')) {
      api = process.env.NEXT_PUBLIC_SUPABASE_URL;
      key = process.env.SUPABASE_SECRET_KEY;
      const db = new URL(process.env.PSYWRITE_DB_URL || '');
      const ref = new URL(api).hostname.split('.')[0];
      if (db.hostname !== `db.${ref}.supabase.co`)
        throw new Error(
          'Use a conexão direta do mesmo projeto Supabase do aplicativo.',
        );
      env = {
        ...process.env,
        PGHOST: db.hostname,
        PGPORT: db.port || '5432',
        PGUSER: decodeURIComponent(db.username),
        PGPASSWORD: decodeURIComponent(db.password),
        PGDATABASE: db.pathname.slice(1),
        PGSSLMODE: 'require',
      };
      params = [
        'exec',
        ...[
          'PGHOST',
          'PGPORT',
          'PGUSER',
          'PGPASSWORD',
          'PGDATABASE',
          'PGSSLMODE',
        ].flatMap((k) => ['-e', k]),
        container,
        'pg_dump',
      ];
    } else throw new Error('Escolha --local ou --remote.');
    await processFile(
      [
        ...params,
        '--format=custom',
        '--no-owner',
        '--schema=public',
        '--schema=auth',
        '--schema=storage',
        '--schema=extensions',
      ],
      join(work, 'database.dump'),
      'out',
      env,
    );
    // Read the attachment inventory from the restored dump, not a later live query.
    await restoreDatabase();
    const db = createClient(api, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      }),
      objects = inventory(),
      files = [['database.dump', join(work, 'database.dump')]];
    await mkdir(join(work, 'objects'), { mode: 0o700 });
    for (const object of objects) {
      const result = await db.storage
        .from('clinical-files')
        .download(object.storage_path);
      if (
        result.error ||
        !result.data ||
        result.data.size !== Number(object.size)
      )
        throw new Error('Anexo ausente ou inconsistente; backup interrompido.');
      const name =
          'objects/' +
          createHash('sha256').update(object.storage_path).digest('hex'),
        path = join(work, name);
      await writeFile(path, Buffer.from(await result.data.arrayBuffer()), {
        flag: 'wx',
        mode: 0o600,
      });
      object.file = name;
      object.sha256 = await digest(path);
      files.push([name, path]);
    }
    const manifest = {
      version: 1,
      created_at: new Date().toISOString(),
      source: new URL(api).hostname,
      counts: counts(),
      database_sha256: await digest(join(work, 'database.dump')),
      objects,
    };
    await writeFile(join(work, 'manifest.json'), JSON.stringify(manifest), {
      mode: 0o600,
    });
    files.push(['manifest.json', join(work, 'manifest.json')]);
    await pack(files, join(work, 'bundle'));
    await encrypt(join(work, 'bundle'), file, password);
    outputCreated = true;
    await decrypt(file, join(work, 'roundtrip'), password);
    if (
      (await digest(join(work, 'bundle'))) !==
      (await digest(join(work, 'roundtrip')))
    )
      throw new Error('Falha na conferência da cópia criptografada.');
    completed = true;
    console.log(
      'Backup criptografado criado. Dump restaurado em banco descartável; anexos e integridade conferidos. Execute verify também na cópia externa.',
    );
  } else {
    await decrypt(file, join(work, 'bundle'), password);
    const manifest = await unpack(join(work, 'bundle'), work);
    if (
      manifest.version !== 1 ||
      (await digest(join(work, 'database.dump'))) !== manifest.database_sha256
    )
      throw new Error('Manifesto inconsistente.');
    await restoreDatabase();
    if (JSON.stringify(counts()) !== JSON.stringify(manifest.counts))
      throw new Error('Contagens restauradas divergentes.');
    const records = inventory();
    if (records.length !== manifest.objects.length)
      throw new Error('Inventário de anexos divergente.');
    for (const record of records) {
      const entry = manifest.objects.find(
        (o) => o.storage_path === record.storage_path,
      );
      if (
        !entry ||
        !/^objects\/[a-f0-9]{64}$/.test(entry.file) ||
        entry.size !== record.size ||
        (await stat(join(work, entry.file))).size !== Number(record.size) ||
        (await digest(join(work, entry.file))) !== entry.sha256
      )
        throw new Error('Anexo restaurado inconsistente.');
    }
    // Exercise restoring the bytes through the local Storage API in a separate private bucket.
    const raw = execFileSync(
        'node_modules/.bin/supabase',
        ['status', '-o', 'json'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ),
      local = JSON.parse(raw.slice(raw.indexOf('{')));
    if (!local.API_URL.startsWith('http://127.0.0.1:'))
      throw new Error('Storage local não confirmado.');
    const client = createClient(local.API_URL, local.SECRET_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      }),
      bucket = 'restore-drill-' + randomUUID();
    const createdBucket = await client.storage.createBucket(bucket, {
      public: false,
    });
    if (createdBucket.error)
      throw new Error('Não foi possível criar o Storage descartável.');
    let storageFailure;
    try {
      for (const entry of manifest.objects) {
        const bytes = await readFile(join(work, entry.file));
        const uploaded = await client.storage
          .from(bucket)
          .upload(entry.file, bytes, { contentType: entry.mime });
        if (uploaded.error)
          throw new Error('Falha ao restaurar anexo no Storage de teste.');
        const downloaded = await client.storage
          .from(bucket)
          .download(entry.file);
        if (
          downloaded.error ||
          !downloaded.data ||
          createHash('sha256')
            .update(Buffer.from(await downloaded.data.arrayBuffer()))
            .digest('hex') !== entry.sha256
        )
          throw new Error('Storage restaurado divergente.');
      }
    } catch (error) {
      storageFailure = error;
    } finally {
      const emptied = await client.storage.emptyBucket(bucket);
      if (emptied.error)
        storageFailure ||= new Error(
          'Remova manualmente o bucket local restore-drill pendente.',
        );
      const removed = await client.storage.deleteBucket(bucket);
      if (removed.error)
        storageFailure ||= new Error(
          'Remova manualmente o bucket local restore-drill vazio.',
        );
    }
    if (storageFailure) throw storageFailure;
    completed = true;
    console.log(
      'Restauração verificada em banco e Storage locais descartáveis: tabelas, contagens e bytes dos anexos íntegros. Temporários removidos ao terminar.',
    );
  }
} catch (error) {
  if (args.includes('--local') && process.env.PSYWRITE_TEST_DIAGNOSTICS === '1')
    console.error(error.message);
  console.error(
    'Backup/restauração não concluído. Confira senha, conexão, espaço em disco e compatibilidade do PostgreSQL. Nenhum banco existente foi substituído.',
  );
  process.exitCode = 1;
} finally {
  if (created) sql(`DROP DATABASE ${scratch} WITH (FORCE)`, 'postgres');
  await rm(work, { recursive: true, force: true });
  if (outputCreated && !completed) await rm(file, { force: true });
}
