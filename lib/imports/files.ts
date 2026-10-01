// Leitura dos arquivos de importação no navegador: extrai os JSON dos .zip de portabilidade
// (entradas sem compressão ou deflate) e agrupa as exportações em lotes.
export async function jsonFromZip(file: File): Promise<string[]> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(buf.buffer);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new Error(`${file.name}: arquivo .zip inválido.`);
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const out: string[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50)
      throw new Error(`${file.name}: arquivo .zip corrompido.`);
    const method = view.getUint16(at + 10, true),
      size = view.getUint32(at + 20, true),
      nameLen = view.getUint16(at + 28, true),
      extraLen = view.getUint16(at + 30, true),
      commentLen = view.getUint16(at + 32, true),
      local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(
      buf.subarray(at + 46, at + 46 + nameLen),
    );
    at += 46 + nameLen + extraLen + commentLen;
    if (!name.toLowerCase().endsWith('.json')) continue;
    const start =
      local +
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    const data = buf.subarray(start, start + size);
    if (method === 0) out.push(new TextDecoder().decode(data));
    else if (method === 8) {
      const stream = new Blob([data])
        .stream()
        .pipeThrough(new DecompressionStream('deflate-raw'));
      out.push(await new Response(stream).text());
    } else throw new Error(`${file.name}: compressão não suportada.`);
  }
  if (!out.length) throw new Error(`${file.name}: nenhum JSON dentro do .zip.`);
  return out;
}
// Agrupa várias exportações LGPD (uma por paciente) em lotes dentro dos limites do servidor.
const LOT_PATIENTS = 30,
  LOT_RECORDS = 450,
  LOT_BYTES = 1_800_000;
export async function readExports(files: File[]): Promise<string[]> {
  const texts: string[] = [];
  for (const f of files)
    if (f.name.toLowerCase().endsWith('.zip'))
      texts.push(...(await jsonFromZip(f)));
    else texts.push(await f.text());
  return texts;
}
export function lots(texts: string[]): string[] {
  if (texts.length === 1) return texts;
  const out: string[] = [];
  let group: unknown[] = [],
    records = 0,
    bytes = 0;
  for (const text of texts) {
    let root: Record<string, unknown>;
    try {
      root = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    } catch {
      throw new Error(
        'Um dos arquivos contém JSON inválido. Nada foi importado.',
      );
    }
    if (root.resourceType === 'Bundle')
      throw new Error(
        'Bundles FHIR devem ser importados um arquivo por vez. Para vários pacientes, use os .zip ou JSON LGPD.',
      );
    const size = new TextEncoder().encode(text).length;
    const count =
      2 +
      [
        'consultations',
        'prescriptions',
        'medications',
        'appointments',
        'allergies',
        'documents',
      ]
        .map((k) =>
          Array.isArray(root[k]) ? (root[k] as unknown[]).length : 0,
        )
        .reduce((a, b) => a + b, 0);
    if (
      group.length &&
      (group.length >= LOT_PATIENTS ||
        records + count > LOT_RECORDS ||
        bytes + size > LOT_BYTES)
    ) {
      out.push(JSON.stringify({ lote: group }));
      group = [];
      records = 0;
      bytes = 0;
    }
    group.push(root);
    records += count;
    bytes += size;
  }
  out.push(JSON.stringify({ lote: group }));
  return out;
}
