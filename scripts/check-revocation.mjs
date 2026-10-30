#!/usr/bin/env node
// Confere a revogação (LCR/OCSP) de um PDF já assinado, buscando a evidência na rede como a
// emissão faz (lote 6F.2D). Não usa banco, não lê .env e não assina nada; o PDF não sai da máquina.
// Só os endereços de LCR/OCSP dos certificados da cadeia são consultados.
//   node scripts/check-revocation.mjs <arquivo.pdf>
// Imprime papel, situação e origem de cada certificado e as URLs consultadas; não imprime o
// conteúdo do documento nem nome/CPF.
import { readFile } from 'node:fs/promises';
import { padesService } from '../lib/signature/pades-service.ts';
import { createOnlineRevocationProvider } from '../lib/signature/revocation-fetch.ts';

const file = process.argv[2];
if (!file) {
  console.error('Uso: node scripts/check-revocation.mjs <arquivo.pdf>');
  process.exit(2);
}

const attempts = [];
const result = await padesService.verifyPadesSignature(await readFile(file), {
  validationContext: 'VERIFICATION',
  revocationEvidenceProvider: createOnlineRevocationProvider(),
  onRevocationFetch: (a) => attempts.push(...a),
});

console.log('Integridade criptográfica:', result.assessment.cryptographicIntegrity);
console.log('Cadeia ICP-Brasil confiável:', result.rootTrust?.trusted ?? false);
console.log('Situação global:', result.status, result.subIndication ?? '');
console.log('Revogação:', result.revocation.status, result.revocation.subIndication ?? '');
for (const c of result.revocation.certificateResults ?? [])
  console.log(
    `  ${c.role.padEnd(10)} ${c.status.padEnd(14)} origem=${c.source}` +
      (c.subIndication ? ` (${c.subIndication})` : ''),
  );
console.log('Buscas:');
for (const a of attempts)
  console.log(`  ${a.kind.padEnd(5)} ${a.outcome.padEnd(8)} ${a.url ?? ''} ${a.reason ?? ''}`);
console.log('Emissão seria permitida:', result.assessment.issuanceAllowed);
