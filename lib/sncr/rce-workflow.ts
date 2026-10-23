import { createHash } from 'node:crypto';
import { padesService } from '../signature/pades-service.ts';
import type { PreparedPdf, SignatureResult } from '../signature/types.ts';
import { rcePdf } from './rce-pdf.ts';
import { type RceSnapshot } from './rce.ts';

export const sha256 = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
export const rceSnapshotHash = (snapshot: RceSnapshot) =>
  sha256(
    JSON.stringify(snapshot, (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((k) => [k, value[k]]),
          )
        : value,
    ),
  );
export type RceEmission = {
  id: string;
  clinic_id: string;
  user_id: string;
  document_id: string;
  document_version: number;
  environment: 'hmg';
  number: string;
  snapshot: RceSnapshot;
  snapshot_hash: string;
  state: string;
  attempt_id: string | null;
  prepared_meta: PreparedMeta | null;
  signed_pdf_path: string | null;
  signed_pdf_hash: string | null;
  signed_at: string | null;
  updated_at?: string;
};
type PreparedMeta = {
  path: string;
  hash: string;
  byteRange: [number, number, number, number];
  digest: string;
  issuedAt: string;
  signerCpf: string;
  signerFingerprint: string;
  provider: string;
};
export type RceRepository = {
  get: () => Promise<RceEmission>;
  acquire: (
    hash: string,
    checked: boolean,
  ) => Promise<{ claimed: boolean; emission: RceEmission }>;
  transition: (
    attempt: string,
    expected: string,
    next: string,
    meta?: PreparedMeta,
  ) => Promise<RceEmission>;
  finish: (
    attempt: string,
    path: string,
    hash: string,
    signedAt: string,
    verification: Record<string, unknown>,
  ) => Promise<RceEmission>;
};
export type RceArtifacts = {
  read: (path: string) => Promise<Uint8Array | null>;
  writeOnce: (
    path: string,
    bytes: Uint8Array,
    contentType: string,
  ) => Promise<void>;
};
export type RceSigner = {
  cpf: string;
  fingerprint: string;
  provider: string;
  sign: (digest: string) => Promise<SignatureResult>;
};
const day = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
    date,
  );

function restorePrepared(bytes: Uint8Array, meta: PreparedMeta): PreparedPdf {
  if (sha256(bytes) !== meta.hash)
    throw new Error('O arquivo preparado diverge do registro.');
  const b = meta.byteRange;
  if (
    b.length !== 4 ||
    !b.every(Number.isSafeInteger) ||
    b[0] !== 0 ||
    b[1] <= 0 ||
    b[2] <= b[1] ||
    b[3] <= 0 ||
    b[2] + b[3] !== bytes.length
  )
    throw new Error('ByteRange inválido.');
  const buffer = Buffer.from(bytes);
  const content = Buffer.concat([
    buffer.subarray(0, b[1]),
    buffer.subarray(b[2]),
  ]);
  if (sha256(content) !== meta.digest)
    throw new Error('O resumo do documento preparado diverge do registro.');
  return {
    pdfWithPlaceholder: bytes,
    actualByteRangePdf: buffer,
    byteRange: b,
    contentToSign: content,
    digestHex: meta.digest,
  };
}

// One emission, one immutable snapshot, one reserved number. Retrying after the
// provider call ONLY recovers persisted artifacts; it never calls the HSM again.
export async function signRce(params: {
  repository: RceRepository;
  artifacts: RceArtifacts;
  reviewedHash: string;
  numberChecked: boolean;
  getSigner: () => Promise<RceSigner>;
  now?: () => Date;
  numberCheckMode?: 'prescriber_checked' | 'simulated';
}): Promise<RceEmission> {
  const { repository: repo, artifacts, getSigner } = params;
  const acquisition = await repo.acquire(
    params.reviewedHash,
    params.numberChecked,
  );
  let e = acquisition.emission;
  const claimed = acquisition.claimed;
  if (rceSnapshotHash(e.snapshot) !== e.snapshot_hash)
    throw new Error('O conteúdo reservado foi alterado. Interrompa a emissão.');
  if (e.environment !== 'hmg') throw new Error('Produção ainda não liberada.');
  if (e.state === 'SIGNED' || e.state === 'BLOCKED' || e.state === 'CANCELLED')
    return e;
  if (!claimed && e.state === 'PREPARING') return e;
  const attempt = e.attempt_id!;
  const prefix = `${e.clinic_id}/sncr/hmg/${e.id}/${attempt}`;
  const cmsPath = prefix + '/signature.json';
  if (claimed) {
    let signer: RceSigner;
    let prepared: PreparedPdf;
    try {
      signer = await getSigner();
      if (signer.cpf !== e.snapshot.prescriber.cpf)
        throw new Error('O certificado não pertence ao prescritor desta RCE.');
      const issuedAt = (params.now || (() => new Date()))();
      const unsigned = await rcePdf(e.snapshot, e.number, issuedAt, 'hmg');
      prepared = await padesService.preparePdfForSignature(unsigned, {
        signerName: e.snapshot.prescriber.name,
        doctorCrm: `${e.snapshot.prescriber.crm}/${e.snapshot.prescriber.uf}`,
        drawVisualBox: false,
        reason: 'RCE de homologação - sem validade para dispensação',
      });
      const meta: PreparedMeta = {
        path: prefix + '/prepared.pdf',
        hash: sha256(prepared.actualByteRangePdf),
        byteRange: prepared.byteRange,
        digest: prepared.digestHex,
        issuedAt: issuedAt.toISOString(),
        signerCpf: signer.cpf,
        signerFingerprint: signer.fingerprint,
        provider: signer.provider,
      };
      await artifacts.writeOnce(
        meta.path,
        prepared.actualByteRangePdf,
        'application/pdf',
      );
      e = await repo.transition(attempt, 'PREPARING', 'SIGNING', meta);
    } catch (error) {
      // No remote signature was requested; allow an explicit retry of the SAME
      // frozen snapshot and number. CAS prevents a stale worker from continuing.
      await repo
        .transition(attempt, 'PREPARING', 'AWAITING_REVIEW')
        .catch(() => {});
      throw error;
    }
    try {
      const signature = await signer.sign(prepared.digestHex);
      await artifacts.writeOnce(
        cmsPath,
        Buffer.from(JSON.stringify(signature)),
        'application/json',
      );
    } catch {
      // May have signed remotely. Never sign again to "fix" an uncertain result.
      return repo.transition(attempt, 'SIGNING', 'SIGNATURE_UNCERTAIN');
    }
  }
  const cmsBytes = await artifacts.read(cmsPath);
  if (!cmsBytes) {
    if (
      e.state === 'SIGNING' &&
      e.updated_at &&
      Date.parse(e.updated_at) < Date.now() - 120000
    )
      return repo.transition(attempt, 'SIGNING', 'SIGNATURE_UNCERTAIN');
    return e;
  }
  if (e.state === 'SIGNING' || e.state === 'SIGNATURE_UNCERTAIN')
    e = await repo.transition(attempt, e.state, 'FINALIZING');
  if (e.state !== 'FINALIZING' || !e.prepared_meta) return e;
  const meta = e.prepared_meta;
  const preparedBytes = await artifacts.read(meta.path);
  if (!preparedBytes)
    throw new Error(
      'Arquivo preparado indisponível. Recupere esta mesma emissão.',
    );
  let signed: Buffer;
  let verification;
  try {
    const prepared = restorePrepared(preparedBytes, meta);
    const signature = JSON.parse(
      Buffer.from(cmsBytes).toString('utf8'),
    ) as SignatureResult;
    signed = padesService.embedSignature(
      prepared,
      signature.cmsSignatureBase64,
    );
    verification = await padesService.verifyPadesSignature(signed);
    if (
      !verification.isValid ||
      verification.signerCpf !== meta.signerCpf ||
      verification.certificateFingerprint !== meta.signerFingerprint ||
      !verification.signedAt ||
      day(verification.signedAt) !== day(new Date(meta.issuedAt))
    )
      throw new Error('Falha na verificação da assinatura ou data.');
  } catch {
    return repo.transition(attempt, 'FINALIZING', 'BLOCKED');
  }
  const path = prefix + '/signed.pdf',
    hash = sha256(signed);
  await artifacts.writeOnce(path, signed, 'application/pdf');
  // Download/readback prevents a successful upload response from standing in
  // for actual availability. Missing storage never regenerates the original.
  const stored = await artifacts.read(path);
  if (!stored || sha256(stored) !== hash)
    throw new Error(
      'O original assinado ainda não está disponível. Recupere esta mesma emissão.',
    );
  return repo.finish(
    attempt,
    path,
    hash,
    verification.signedAt!.toISOString(),
    {
      ...verification,
      validFrom: verification.validFrom.toISOString(),
      validTo: verification.validTo.toISOString(),
      signedAt: verification.signedAt!.toISOString(),
      provider: meta.provider,
      sncrBinding: params.numberCheckMode || 'prescriber_checked',
      environment: 'hmg',
    },
  );
}

export async function originalRce(
  repo: Pick<RceRepository, 'get'>,
  artifacts: RceArtifacts,
) {
  const e = await repo.get();
  if (e.state !== 'SIGNED' || !e.signed_pdf_path || !e.signed_pdf_hash)
    throw new Error('O original assinado ainda não está disponível.');
  const bytes = await artifacts.read(e.signed_pdf_path);
  if (!bytes || sha256(bytes) !== e.signed_pdf_hash)
    throw new Error(
      'O original assinado precisa ser recuperado. Nenhum PDF substituto foi gerado.',
    );
  return bytes;
}

// Explicit recovery uses the exact prepared bytes and the already saved CMS.
// It never renders a new PDF, asks for another number, or calls the signer.
export async function recoverRceOriginal(
  repo: Pick<RceRepository, 'get'>,
  artifacts: RceArtifacts,
) {
  const e = await repo.get();
  if (
    e.state !== 'SIGNED' ||
    !e.signed_pdf_path ||
    !e.signed_pdf_hash ||
    !e.prepared_meta ||
    !e.attempt_id
  )
    throw new Error(
      'Conclua a recuperação da emissão antes de recuperar o original.',
    );
  const existing = await artifacts.read(e.signed_pdf_path);
  if (existing) {
    if (sha256(existing) !== e.signed_pdf_hash)
      throw new Error(
        'O arquivo armazenado diverge do original. É necessária conferência técnica; nenhum arquivo foi sobrescrito.',
      );
    return existing;
  }
  const preparedBytes = await artifacts.read(e.prepared_meta.path);
  const cms = await artifacts.read(
    `${e.clinic_id}/sncr/hmg/${e.id}/${e.attempt_id}/signature.json`,
  );
  if (!preparedBytes || !cms)
    throw new Error(
      'Os arquivos de recuperação estão indisponíveis. Restaure o backup do original; não assine novamente.',
    );
  const signature = JSON.parse(
    Buffer.from(cms).toString('utf8'),
  ) as SignatureResult;
  const restored = padesService.embedSignature(
    restorePrepared(preparedBytes, e.prepared_meta),
    signature.cmsSignatureBase64,
  );
  if (sha256(restored) !== e.signed_pdf_hash)
    throw new Error(
      'A recuperação não reproduziu o original. Nenhum arquivo substituto foi salvo.',
    );
  const verification = await padesService.verifyPadesSignature(restored);
  if (
    !verification.isValid ||
    verification.signerCpf !== e.prepared_meta.signerCpf ||
    verification.certificateFingerprint !== e.prepared_meta.signerFingerprint
  )
    throw new Error(
      'A assinatura do original recuperado não pôde ser confirmada.',
    );
  await artifacts.writeOnce(e.signed_pdf_path, restored, 'application/pdf');
  return originalRce(repo, artifacts);
}
