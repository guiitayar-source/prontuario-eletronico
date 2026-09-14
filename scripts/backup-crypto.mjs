import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  createHash,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, readFile, stat, appendFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
const magic = Buffer.from('PSYBACKUP001\n');
const key = (password, salt) =>
  scryptSync(password, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
export async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function encrypt(input, output, password) {
  if (!password || password.length < 16)
    throw new Error('Defina uma senha de backup com pelo menos 16 caracteres.');
  const salt = randomBytes(16),
    iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key(password, salt), iv);
  const header = Buffer.concat([magic, salt, iv]);
  cipher.setAAD(header);
  const fd = await open(output, 'wx', 0o600);
  await fd.write(header);
  await fd.close();
  await pipeline(
    createReadStream(input),
    cipher,
    createWriteStream(output, { flags: 'a', mode: 0o600 }),
  );
  await appendFile(output, cipher.getAuthTag());
}
export async function decrypt(input, output, password) {
  const headerSize = magic.length + 28,
    size = (await stat(input)).size;
  if (size < headerSize + 16) throw new Error('Backup incompleto.');
  const fd = await open(input, 'r'),
    header = Buffer.alloc(headerSize),
    tag = Buffer.alloc(16);
  try {
    await fd.read(header, 0, headerSize, 0);
    await fd.read(tag, 0, 16, size - 16);
  } finally {
    await fd.close();
  }
  if (!header.subarray(0, magic.length).equals(magic))
    throw new Error('Formato de backup desconhecido.');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key(password, header.subarray(magic.length, magic.length + 16)),
    header.subarray(magic.length + 16),
  );
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  await pipeline(
    createReadStream(input, { start: headerSize, end: size - 17 }),
    decipher,
    createWriteStream(output, { flags: 'wx', mode: 0o600 }),
  );
}
// Framed files, with no tar paths, links or executable extraction hooks.
export async function pack(files, output) {
  const out = await open(output, 'wx', 0o600);
  try {
    for (const [name, path] of files) {
      const header =
        JSON.stringify({
          name,
          size: (await stat(path)).size,
          sha256: await digest(path),
        }) + '\n';
      await out.write(header);
      for await (const chunk of createReadStream(path)) await out.write(chunk);
    }
  } finally {
    await out.close();
  }
}
export async function unpack(input, directory) {
  const { mkdir } = await import('node:fs/promises');
  const fd = await open(input, 'r'),
    size = (await stat(input)).size,
    names = new Set();
  let pos = 0;
  try {
    while (pos < size) {
      const bytes = [];
      let ended = false;
      while (bytes.length < 1024 && pos < size) {
        const b = Buffer.alloc(1);
        await fd.read(b, 0, 1, pos++);
        if (b[0] === 10) {
          ended = true;
          break;
        }
        bytes.push(b[0]);
      }
      if (!ended) throw new Error('Cabeçalho de backup inválido.');
      const h = JSON.parse(Buffer.from(bytes).toString());
      if (
        !/^(database\.dump|manifest\.json|objects\/[a-f0-9]{64})$/.test(
          h.name,
        ) ||
        names.has(h.name) ||
        !Number.isSafeInteger(h.size) ||
        h.size < 0 ||
        h.size > size - pos
      )
        throw new Error('Entrada de backup inválida.');
      names.add(h.name);
      await mkdir(directory + '/objects', { recursive: true, mode: 0o700 });
      const path = directory + '/' + h.name;
      if (h.size)
        await pipeline(
          createReadStream(input, { start: pos, end: pos + h.size - 1 }),
          createWriteStream(path, { flags: 'wx', mode: 0o600 }),
        );
      else {
        const empty = await open(path, 'wx', 0o600);
        await empty.close();
      }
      pos += h.size;
      if ((await digest(path)) !== h.sha256)
        throw new Error('Integridade do backup inválida.');
    }
  } finally {
    await fd.close();
  }
  if (!names.has('database.dump') || !names.has('manifest.json'))
    throw new Error('Backup incompleto.');
  return JSON.parse(await readFile(directory + '/manifest.json', 'utf8'));
}
