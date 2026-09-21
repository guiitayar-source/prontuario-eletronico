export const MAX_FILE = 12 * 1024 * 1024;

export function fileType(data: Uint8Array): string | null {
  const prefix = (...n: number[]) => n.every((v, i) => data[i] === v);
  if (prefix(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (prefix(137, 80, 78, 71, 13, 10, 26, 10)) return 'image/png';
  if (prefix(37, 80, 68, 70, 45)) return 'application/pdf';
  if (
    prefix(82, 73, 70, 70) &&
    new TextDecoder().decode(data.slice(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return null;
}
