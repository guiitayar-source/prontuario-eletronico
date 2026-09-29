// Gera lib/signature/icp-brasil-certs.ts a partir do pacote oficial de ACs do ITI.
//
// Uso:
//   curl -o /tmp/ac.zip http://acraiz.icpbrasil.gov.br/credenciadas/CertificadosAC-ICP-Brasil/ACcompactado.zip
//   unzip -o /tmp/ac.zip -d /tmp/ac
//   node scripts/update-icp-certs.mjs /tmp/ac
//
// Só raízes com impressão digital fixada em PINNED_ROOTS entram como âncora de
// confiança. As ACs intermediárias não precisam ser confiáveis: só valem se a
// cadeia fechar numa raiz fixada. Para fixar uma nova raiz, confirme a impressão
// digital validando um certificado real (já aceito pelo validador do ITI) com
// scripts/verify-signature.mjs antes de adicioná-la aqui.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import crypto from 'node:crypto';

const PINNED_ROOTS = {
  // Autoridade Certificadora Raiz Brasileira v5. Confirmada em 29/09/2026:
  // scripts/verify-signature.mjs fechou a cadeia de um e-CPF real (AC SOLUTI
  // Múltipla v5), aceito pelo validador do ITI, até esta raiz.
  'CA:A5:3F:C6:09:1C:69:51:88:7C:97:6E:37:8F:6E:F8:9A:A6:37:7C:55:D9:7B:64:75:42:2B:71:ED:7E:9B:17':
    'Autoridade Certificadora Raiz Brasileira v5',
};

const dir = process.argv[2];
if (!dir) {
  console.error('Uso: node scripts/update-icp-certs.mjs <pasta-com-os-.crt>');
  process.exit(1);
}

const roots = [];
const intermediates = [];
const seen = new Set();
for (const name of (await readdir(dir)).sort()) {
  const raw = await readFile(join(dir, name));
  let x509;
  try {
    x509 = new crypto.X509Certificate(raw);
  } catch {
    console.warn(`Ignorado (não é certificado): ${name}`);
    continue;
  }
  if (seen.has(x509.fingerprint256)) continue;
  seen.add(x509.fingerprint256);
  const der = x509.raw.toString('base64');
  if (x509.subject === x509.issuer) {
    if (PINNED_ROOTS[x509.fingerprint256]) roots.push({ name: PINNED_ROOTS[x509.fingerprint256], der });
    else console.warn(`Raiz não fixada, ignorada: ${x509.subject.replace(/\n/g, ', ')}`);
  } else if (x509.ca) {
    intermediates.push(der);
  }
}

const missing = Object.values(PINNED_ROOTS).filter((n) => !roots.some((r) => r.name === n));
if (missing.length) {
  console.error(`Raiz fixada ausente no pacote: ${missing.join(', ')}`);
  process.exit(1);
}

const out = `// Gerado por scripts/update-icp-certs.mjs a partir do pacote oficial do ITI.
// Não edite à mão.
export const ICP_BRASIL_ROOTS: { name: string; der: string }[] = ${JSON.stringify(roots, null, 2)};

export const ICP_BRASIL_INTERMEDIATES: string[] = ${JSON.stringify(intermediates, null, 2)};
`;
await writeFile(new URL('../lib/signature/icp-brasil-certs.ts', import.meta.url), out);
console.log(`${roots.length} raiz(es) fixada(s), ${intermediates.length} AC(s) intermediária(s).`);
