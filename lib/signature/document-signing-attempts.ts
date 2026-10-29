// Orquestração transacional do caminho comum; não implementa criptografia PAdES/PSC.
import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClinicalDocument } from '../document-fields.ts';
import { documentPdf } from '../document-pdf.ts';
import { withPdfData } from '../supabase/document-pdf-data.ts';
import { HttpError } from '../supabase/server.ts';
import { decryptToken, encryptToken, formatCpf } from './crypto-utils.ts';
import { getSignatureProvider } from './provider-factory.ts';
import { padesService } from './pades-service.ts';
import { liveIssuanceRevocationOptions } from './revocation-fetch.ts';
import {
  authorizeSigningIdentity,
  assertSigningCertificate,
  SigningIdentityError,
  type SigningActor,
  type SigningAuthorization,
} from './signing-identity.ts';
import type { DigitalSignatureRecord } from './types.ts';

const hash = (bytes: Uint8Array) =>
  crypto.createHash('sha256').update(bytes).digest('hex');
export const validSigningKey = (value: string) =>
  /^[A-Za-z0-9._:-]{8,128}$/.test(value);
type Attempt = {
  id: string;
  state: string;
  document_id: string;
  document_version: number;
  clinic_id: string;
  user_id: string;
  session_id: string;
  signer_cpf: string;
  certificate_fingerprint: string;
  certificate_raw: string;
  storage_path: string;
  artifact_cipher: string | null;
  artifact_metadata: { signed_pdf_hash: string; byte_length: number } | null;
  lease_until: string;
};
type Operation = {
  attempt: Attempt | null;
  claimed: boolean;
  document: ClinicalDocument;
  signature: DigitalSignatureRecord | null;
};

export async function signDocumentAttempt(
  db: SupabaseClient,
  actor: SigningActor & {
    documentId: string;
    idempotencyKey?: string;
    documentVersion?: number;
  },
  initial: ClinicalDocument,
) {
  const version = actor.documentVersion ?? initial.version;
  if (!Number.isInteger(version) || version !== initial.version)
    throw new HttpError(409, 'Versão documental alterada. Reabra o documento.');
  const key =
    actor.idempotencyKey ?? `document:${actor.documentId}:v${version}`;
  if (!validSigningKey(key))
    throw new HttpError(400, 'Chave de idempotência inválida.');
  const owner = crypto.randomUUID();
  const operation = async (
    action: string,
    data: Record<string, unknown> = {},
  ): Promise<Operation> => {
    let result;
    try {
      result = await db.rpc('document_signing_operation', {
        p_action: action,
        p_clinic: actor.clinicId,
        p_user: actor.userId,
        p_document: actor.documentId,
        p_version: version,
        p_key: key,
        p_owner: owner,
        p_data: data,
      });
    } catch {
      throw new HttpError(
        503,
        'Não foi possível confirmar a tentativa. Consulte o estado antes de repetir.',
      );
    }
    if (result.error || !result.data)
      throw new HttpError(
        result.error?.code === '42501'
          ? 403
          : result.error?.code === '23505' ||
              result.error?.code === '23514' ||
              result.error?.code === '40001'
            ? 409
            : 503,
        'Tentativa indisponível, incompatível ou pendente de reconciliação. Não solicite outra assinatura.',
      );
    return result.data as Operation;
  };
  const authorizationFor = (a: Attempt): SigningAuthorization => ({
    ...actor,
    documentId: a.document_id,
    documentVersion: a.document_version,
    sessionId: a.session_id,
    cpf: a.signer_cpf,
    certificateFingerprint: a.certificate_fingerprint,
  });
  const readIdentity = async (doc: ClinicalDocument, sessionId?: string) => {
    let query = db
      .from('signature_sessions')
      .select('*')
      .eq('clinic_id', actor.clinicId)
      .eq('user_id', actor.userId);
    if (sessionId) query = query.eq('id', sessionId);
    else
      query = query
        .eq('revoked', false)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1);
    const { data: session, error } = await query.maybeSingle();
    if (error)
      throw new HttpError(
        503,
        'Não foi possível consultar a identidade de assinatura.',
      );
    if (!session)
      throw new HttpError(
        sessionId ? 409 : 401,
        'Nenhuma sessão válida do certificado autorizado.',
      );
    const { data: profile, error: profileError } = await db
      .from('document_profiles')
      .select('cpf,physician_registration')
      .eq('clinic_id', actor.clinicId)
      .eq('user_id', actor.userId)
      .maybeSingle();
    if (profileError)
      throw new HttpError(
        503,
        'Não foi possível confirmar o perfil autorizado.',
      );
    return {
      session,
      authorization: authorizeSigningIdentity(actor, doc, session, profile),
    };
  };
  const audit = async (
    action: string,
    reason: string,
    a?: Attempt,
    details: Record<string, unknown> = {},
  ) => {
    const { error } = await db.from('audit_events').insert({
      clinic_id: actor.clinicId,
      actor_id: actor.userId,
      action,
      entity_type: 'clinical_documents',
      entity_id: actor.documentId,
      context: {
        reason,
        document_version: version,
        ...(a ? { attempt_id: a.id, session_id: a.session_id } : {}),
        ...details,
      },
    });
    if (error)
      throw new HttpError(
        503,
        'Não foi possível registrar a tentativa de assinatura.',
      );
  };
  const readArtifact = async (a: Attempt) => {
    const { data, error } = await db.storage
      .from('clinical-files')
      .download(a.storage_path);
    if (error || !data)
      throw new HttpError(
        503,
        'Artefato assinado original indisponível. Não será regenerado.',
      );
    const bytes = Buffer.from(await data.arrayBuffer());
    if (
      !a.artifact_metadata ||
      hash(bytes) !== a.artifact_metadata.signed_pdf_hash ||
      bytes.length !== a.artifact_metadata.byte_length
    )
      throw new HttpError(
        503,
        'Artefato assinado original inconsistente. Não será substituído.',
      );
    const verification = await padesService.verifyPadesSignature(bytes);
    assertSigningCertificate(authorizationFor(a), verification);
    return { bytes, verification };
  };
  const recover = async (state: Operation, recovered: boolean) => {
    let a = state.attempt!;
    if (a.state === 'ARTIFACT_RECEIVED') {
      if (!a.artifact_cipher || !a.artifact_metadata)
        throw new HttpError(
          409,
          'Artefato recebido sem registro recuperável. Exige reconciliação.',
        );
      let bytes: Buffer;
      try {
        const envelope = JSON.parse(decryptToken(a.artifact_cipher));
        if (
          envelope.attemptId !== a.id ||
          envelope.documentId !== a.document_id ||
          envelope.version !== a.document_version
        )
          throw Error('binding');
        bytes = Buffer.from(envelope.pdf, 'base64');
        if (
          hash(bytes) !== a.artifact_metadata.signed_pdf_hash ||
          bytes.length !== a.artifact_metadata.byte_length
        )
          throw Error('hash');
        assertSigningCertificate(
          authorizationFor(a),
          await padesService.verifyPadesSignature(bytes),
        );
      } catch {
        throw new HttpError(
          409,
          'Registro cifrado do artefato inconsistente. Exige reconciliação.',
        );
      }
      // Repetir a entrega dos MESMOS bytes é seguro; a escrita nunca sobrescreve.
      const { error } = await db.storage
        .from('clinical-files')
        .upload(a.storage_path, bytes, {
          contentType: 'application/pdf',
          upsert: false,
          metadata: {
            attempt_id: a.id,
            sha256: a.artifact_metadata.signed_pdf_hash,
          },
        });
      // Também resolve upload confirmado remotamente cuja resposta se perdeu.
      try {
        await readArtifact(a);
      } catch {
        throw new HttpError(
          503,
          error
            ? 'PDF recebido preservado para retomada; armazenamento não confirmado. Não solicite outra assinatura.'
            : 'Leitura do artefato armazenado não confirmou sua integridade.',
        );
      }
      state = await operation('stored');
      a = state.attempt!;
    }
    const original = await readArtifact(a);
    if (a.state !== 'COMPLETED') {
      let current;
      try {
        current = await readIdentity(state.document, a.session_id);
      } catch (error) {
        throw new SigningIdentityError(
          error instanceof SigningIdentityError
            ? error.reason
            : 'identity_recheck_unavailable',
          409,
        );
      }
      if (
        current.authorization.cpf !== a.signer_cpf ||
        current.authorization.certificateFingerprint !==
          a.certificate_fingerprint
      )
        throw new SigningIdentityError('authorized_identity_changed', 409);
      state = await operation('finish');
      a = state.attempt!;
    }
    if (a.state !== 'COMPLETED' || !state.signature)
      throw new HttpError(
        409,
        'Conclusão ainda não confirmada. Exige reconciliação.',
      );
    return {
      success: true,
      documentId: actor.documentId,
      signedPdfPath: a.storage_path,
      verification: original.verification,
      signature: state.signature,
      document: state.document,
      attemptId: a.id,
      recovered,
    };
  };

  const existing = await operation('inspect');
  if (
    existing.attempt &&
    ['ARTIFACT_RECEIVED', 'ARTIFACT_STORED', 'COMPLETED'].includes(
      existing.attempt.state,
    )
  )
    return recover(existing, true);
  if (
    existing.attempt &&
    (!['ACQUIRED', 'PREPARED', 'PREPARATION_FAILED'].includes(
      existing.attempt.state,
    ) ||
      (existing.attempt.state !== 'PREPARATION_FAILED' &&
        Date.parse(existing.attempt.lease_until) > Date.now()))
  )
    throw new HttpError(
      409,
      'Assinatura em andamento ou resultado incerto. Exige reconciliação, sem nova assinatura.',
    );
  let identity;
  try {
    identity = await readIdentity(initial);
  } catch (error) {
    await audit(
      'document.signature_denied',
      error instanceof SigningIdentityError
        ? error.reason
        : 'identity_unavailable',
    );
    throw error;
  }
  const acquired = await operation('acquire', {
    session_id: identity.session.id,
    cpf: identity.authorization.cpf,
    fingerprint: identity.authorization.certificateFingerprint,
    certificate_raw: identity.session.certificate_raw,
  });
  if (!acquired.claimed || !acquired.attempt)
    throw new HttpError(
      409,
      'Outra solicitação já adquiriu esta versão. Consulte o estado.',
    );
  const a = acquired.attempt,
    doc = { ...acquired.document };
  let externalGate = false;
  let digest: string | undefined;
  try {
    const accessToken = decryptToken(identity.session.access_token_encrypted);
    await withPdfData(db, actor.clinicId, doc);
    const unsigned = await documentPdf(doc, { isDraft: false });
    const cn = identity.session.certificate_subject.match(/CN=([^,\n/]+)/i);
    const prepared = await padesService.preparePdfForSignature(unsigned, {
      signerName: cn ? cn[1].split(':')[0].trim() : doc.physician_name,
      signerCpf: formatCpf(a.signer_cpf),
      doctorCrm: doc.physician_registration,
      reason:
        'Documento assinado digitalmente com certificado ICP-Brasil (RDC Anvisa 1.000/2025)',
    });
    digest = prepared.digestHex;
    await operation('prepare', {
      document_hash: digest,
      unsigned_pdf_hash: hash(unsigned),
    });
    const provider = getSignatureProvider(identity.session.provider);
    await audit('document.signature_started', 'authorized_identity', a, {
      document_hash: digest,
    });
    externalGate = true;
    await operation('external'); // COMMIT confirmado; token de posse impede processo antigo.
    const signed = await provider.signHash({
      accessToken,
      certificateAlias: identity.session.certificate_alias,
      hashHex: digest,
      documentAlias: `${doc.kind} #${doc.id.slice(0, 8)}`,
    });
    const transactionId =
      signed.providerTransactionId &&
      /^[A-Za-z0-9._:-]{1,200}$/.test(signed.providerTransactionId)
        ? signed.providerTransactionId
        : null;
    if (transactionId)
      try {
        await operation('external_reference', {
          transaction_id: transactionId,
        });
      } catch {
        /* A recepção abaixo ainda pode registrar o resultado. */
      }
    const bytes = padesService.embedSignature(
      prepared,
      signed.cmsSignatureBase64,
    );
    // Emissão ao vivo: revogação conhecida ou certificado vencido agora bloqueiam (6F.2C-R).
    // A LCR/OCSP vem da rede (6F.2D); sem resposta, a emissão segue como INDETERMINATE.
    const verification = await padesService.verifyPadesSignature(bytes, {
      validationContext: 'LIVE_ISSUANCE',
      ...liveIssuanceRevocationOptions(),
    });
    if (!verification.assessment.issuanceAllowed)
      throw new SigningIdentityError('cms_verification_failed', 409);
    assertSigningCertificate(identity.authorization, verification);
    const metadata = {
      signed_pdf_storage_path: a.storage_path,
      signed_pdf_hash: hash(bytes),
      byte_length: bytes.length,
      unsigned_pdf_hash: hash(unsigned),
      document_hash: digest,
      certificate_subject: verification.certificateSubject,
      certificate_issuer: verification.certificateIssuer,
      certificate_serial: verification.certificateSerial || '',
      certificate_fingerprint: verification.certificateFingerprint || '',
      cpf_from_certificate: a.signer_cpf,
      signature_algorithm: 'SHA256withRSA',
      digest_algorithm: 'SHA-256',
      provider_transaction_id: transactionId,
    };
    const cipher = encryptToken(
      JSON.stringify({
        attemptId: a.id,
        documentId: a.document_id,
        version: a.document_version,
        pdf: bytes.toString('base64'),
      }),
    );
    const received = await operation('receive', { metadata, cipher });
    return await recover(received, false);
  } catch (error) {
    // Nunca desfaz recibo/artefato/conclusão já persistidos nem libera outro HSM.
    try {
      await operation(
        !externalGate
          ? 'preparation_failed'
          : error instanceof SigningIdentityError
            ? 'reject'
            : 'uncertain',
      );
    } catch {
      /* Estado durável já bloqueia retry externo. */
    }
    try {
      await audit(
        externalGate
          ? 'document.signature_pending'
          : 'document.signature_failed',
        error instanceof SigningIdentityError
          ? error.reason
          : externalGate
            ? 'external_result_unconfirmed'
            : 'preparation_failed',
        a,
        digest ? { document_hash: digest } : {},
      );
    } catch {
      /* Não libera nova assinatura. */
    }
    throw new HttpError(
      externalGate ? 409 : 503,
      externalGate
        ? 'Assinatura pendente de reconciliação ou retomada do artefato. Não solicite outra assinatura.'
        : 'Preparação interrompida antes da assinatura externa. A tentativa pode ser retomada com segurança.',
    );
  }
}
