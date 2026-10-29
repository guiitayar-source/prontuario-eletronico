// Lote 6F.2D: guarda a LCR/OCSP usada na emissão e a devolve para a recuperação/reverificação,
// sem rede. Depende da migração 20261029040000_revocation_evidence.sql; sem ela (ou com o banco
// indisponível) as funções degradam: nada é gravado e a verificação segue sem evidência.
import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';

import type {
  CertificateRevocationCheckSummary,
  CollectedRevocationEvidence,
  PadesVerificationResult,
} from './types.ts';

export type RevocationEvidenceChain = 'SIGNER' | 'TSA';

export interface CollectedEvidenceByChain {
  chain: RevocationEvidenceChain;
  evidence: CollectedRevocationEvidence[];
}

export interface RevocationEvidenceRecord {
  kind: 'CRL' | 'OCSP';
  der: string;
  sha256: string;
  source_url: string;
  issuer: string;
  this_update: string | null;
  next_update: string | null;
  produced_at: string | null;
  chain: RevocationEvidenceChain;
  certificate_role: CertificateRevocationCheckSummary['role'];
  certificate_serial: string;
  certificate_fingerprint: string;
  result: CertificateRevocationCheckSummary['status'] | 'NOT_EVALUATED';
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

/** Datas informativas da evidência (a decisão sempre reavalia o DER). */
function evidenceDates(kind: 'CRL' | 'OCSP', der: Buffer) {
  const iso = (d?: Date) => (d instanceof Date ? d.toISOString() : null);
  try {
    const asn1 = asn1js.fromBER(toArrayBuffer(der));
    if (kind === 'CRL') {
      const crl = new pkijs.CertificateRevocationList({ schema: asn1.result });
      return {
        this_update: iso(crl.thisUpdate.value),
        next_update: iso(crl.nextUpdate?.value),
        produced_at: null,
      };
    }
    const response = new pkijs.OCSPResponse({ schema: asn1.result });
    const basic = new pkijs.BasicOCSPResponse({
      schema: asn1js.fromBER(
        response.responseBytes!.response.valueBlock.valueHexView.slice()
          .buffer as ArrayBuffer,
      ).result,
    });
    const single = basic.tbsResponseData.responses[0];
    return {
      this_update: iso(single?.thisUpdate),
      next_update: iso(single?.nextUpdate),
      produced_at: iso(basic.tbsResponseData.producedAt),
    };
  } catch {
    return { this_update: null, next_update: null, produced_at: null };
  }
}

/**
 * Monta os registros a gravar: cada evidência com o certificado para o qual foi buscada e o
 * resultado que a verificação deu a esse certificado.
 */
export function revocationEvidenceRecords(
  collected: CollectedEvidenceByChain[],
  verification: Pick<
    PadesVerificationResult,
    'revocation' | 'temporalValidity'
  >,
): RevocationEvidenceRecord[] {
  const summaries = [
    ...(verification.revocation?.certificateResults ?? []),
    ...(verification.temporalValidity?.tsaRevocationSummaries ?? []),
  ];
  const records = new Map<string, RevocationEvidenceRecord>();
  for (const { chain, evidence } of collected)
    for (const item of evidence) {
      const node = item.certificate;
      const role =
        chain === 'SIGNER'
          ? item.chainPosition === 0
            ? 'SIGNER'
            : 'SIGNER_CA'
          : item.chainPosition === 0
            ? 'TSA_SIGNER'
            : 'TSA_CA';
      const summary = summaries.find(
        (s) =>
          s.role === role &&
          s.serialNumber === node.serialNumber &&
          s.issuer === node.issuer,
      );
      const sha256 = crypto.createHash('sha256').update(item.der).digest('hex');
      records.set(`${sha256} ${node.fingerprint256}`, {
        kind: item.kind,
        der: item.der.toString('base64'),
        sha256,
        source_url: item.url,
        issuer: node.issuer,
        ...evidenceDates(item.kind, item.der),
        chain,
        certificate_role: role,
        certificate_serial: node.serialNumber,
        certificate_fingerprint: node.fingerprint256,
        result: summary?.status ?? 'NOT_EVALUATED',
      });
    }
  return [...records.values()];
}

/** Grava a evidência da tentativa. Nunca lança: a emissão não depende disso. */
export async function saveAttemptRevocationEvidence(
  db: SupabaseClient,
  target: { clinicId: string; userId: string; attemptId: string },
  records: RevocationEvidenceRecord[],
): Promise<'saved' | 'empty' | 'unavailable'> {
  if (records.length === 0) return 'empty';
  try {
    const { error } = await db.rpc('signing_revocation_evidence_write', {
      p_clinic: target.clinicId,
      p_user: target.userId,
      p_attempt: target.attemptId,
      p_items: records,
    });
    if (error) {
      console.warn(
        '[revogação] evidência não gravada:',
        error.code || '',
        error.message,
      );
      return 'unavailable';
    }
    return 'saved';
  } catch (error) {
    console.warn(
      '[revogação] evidência não gravada:',
      (error as Error)?.message,
    );
    return 'unavailable';
  }
}

function byteaToBuffer(value: unknown): Buffer | null {
  if (typeof value !== 'string') return null;
  // PostgREST devolve bytea em hexadecimal com prefixo \x.
  if (value.startsWith('\\x')) return Buffer.from(value.slice(2), 'hex');
  return null;
}

/**
 * Evidência guardada para a tentativa, pronta para `crls`/`ocspResponses`. Sem rede.
 * Devolve listas vazias se a tabela não existir ou a consulta falhar.
 */
export async function loadAttemptRevocationEvidence(
  db: SupabaseClient,
  target: { clinicId: string; attemptId: string },
): Promise<{ crls: Buffer[]; ocspResponses: Buffer[] }> {
  const empty = { crls: [], ocspResponses: [] };
  try {
    const { data, error } = await db
      .from('signing_revocation_evidence')
      .select('evidence_sha256,revocation_evidence(kind,der)')
      .eq('clinic_id', target.clinicId)
      .eq('attempt_id', target.attemptId);
    if (error || !Array.isArray(data)) return empty;
    const seen = new Set<string>();
    const crls: Buffer[] = [];
    const ocspResponses: Buffer[] = [];
    for (const row of data as unknown as Array<{
      evidence_sha256: string;
      revocation_evidence: { kind: string; der: unknown } | null;
    }>) {
      const ev = row.revocation_evidence;
      const der = byteaToBuffer(ev?.der);
      if (!ev || !der || seen.has(row.evidence_sha256)) continue;
      // Confere que os bytes ainda são os que o SHA-256 identifica.
      if (
        crypto.createHash('sha256').update(der).digest('hex') !==
        row.evidence_sha256
      )
        continue;
      seen.add(row.evidence_sha256);
      (ev.kind === 'OCSP' ? ocspResponses : crls).push(der);
    }
    return { crls, ocspResponses };
  } catch {
    return empty;
  }
}
