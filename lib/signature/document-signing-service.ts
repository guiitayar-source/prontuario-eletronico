import crypto from 'node:crypto';
import { prescriptionSigningBlock } from '../sncr/policy.ts';
import type { SupabaseClient } from '@supabase/supabase-js';
import { adminClient } from '../supabase/admin.ts';
import { HttpError } from '../supabase/server.ts';
import type { ClinicalDocument } from '../document-fields.ts';
import {
  formatCpf,
  encryptToken,
  decryptToken,
  generatePkce,
  parseX509Certificate,
} from './crypto-utils.ts';
import { getSignatureProvider } from './provider-factory.ts';
import { oauthHash, oauthSecret, oauthRedirect, validSecret } from './oauth-context.ts';
import { signatureProviderLabel, type SignatureProviderId } from './providers.ts';
import { padesService } from './pades-service.ts';
import { liveIssuanceRevocationOptions } from './revocation-fetch.ts';
import { signDocumentAttempt } from './document-signing-attempts.ts';
import {
  assertDocumentSigningAuthor,
  SigningIdentityError,
  signingCpf,
} from './signing-identity.ts';
import type {
  DigitalSignatureRecord,
  PadesVerificationResult,
  SignatureSessionData,
} from './types.ts';

export class DocumentSigningService {
  private readonly documentAdmin: typeof adminClient;
  constructor(documentAdmin = adminClient) { this.documentAdmin = documentAdmin; }
  /** Tentativa PSC vinculada ao usuário, sessão PsyWrite e segredo do navegador. */
  async initiateOAuthSession(params: {
    db: SupabaseClient; clinicId: string; userId: string;
    authSessionId: string; binding: string; provider: SignatureProviderId;
  }): Promise<{ authorizationUrl: string; state: string }> {
    if (!params.authSessionId || !validSecret(params.binding))
      throw new HttpError(403, 'Sessão e navegador autorizados são obrigatórios.');
    const redirectUri = oauthRedirect(params.provider);
    const provider = getSignatureProvider(params.provider);
    const { codeVerifier, codeChallenge } = generatePkce(), state = oauthSecret();
    const admin = this.documentAdmin();
    await this.oauthOperation(admin, params, state, 'start', {
      provider: params.provider, redirect_uri: redirectUri, verifier: encryptToken(codeVerifier),
    }, 'pending');
    // login_hint não concede identidade. Somente o X.509 é usado na conclusão.
    return { state, authorizationUrl: provider.getAuthorizationUrl({ state, codeChallenge, redirectUri, lifetimeSeconds: 4 * 3600 }) };
  }

  private async oauthOperation(
    db: SupabaseClient,
    actor: { clinicId: string; userId: string; authSessionId: string; binding: string },
    state: string, action: string, payload: Record<string, unknown>, expected?: string,
  ) {
    const { data, error } = await db.rpc('signature_oauth_operation', {
      p_action: action, p_clinic_id: actor.clinicId, p_user_id: actor.userId,
      p_auth_session_id: actor.authSessionId, p_state_hash: oauthHash('state', state),
      p_binding_hash: oauthHash('browser', actor.binding), p_payload: payload,
    });
    if (error || !data) throw new HttpError(503, 'Não foi possível confirmar a tentativa OAuth. Inicie nova conexão.');
    if (expected && data.status !== expected)
      throw new HttpError(data.reason === 'certificate_profile_identity_mismatch' ? 403 : 409,
        data.reason === 'certificate_profile_identity_mismatch'
          ? 'O certificado não corresponde à identidade autorizada. As sessões incompatíveis exigem revisão.'
          : 'Tentativa inválida, já utilizada ou expirada. Inicie nova conexão.');
    return data;
  }

  /** O chamador fornece exclusivamente contexto autenticado, nunca o usuário salvo no state. */
  async handleOAuthCallback(params: {
    db: SupabaseClient; clinicId: string; userId: string; authSessionId: string;
    binding: string; code: string; state: string; redirectUri: string; cancelled?: boolean;
  }): Promise<SignatureSessionData> {
    if (!params.authSessionId || !validSecret(params.binding) || !validSecret(params.state) ||
        (!params.cancelled && (!params.code || params.code.length > 1024)))
      throw new HttpError(403, 'Contexto de autorização ausente ou inválido.');
    const admin = this.documentAdmin();
    // Única aquisição: COMMIT no PostgreSQL antes de decifrar PKCE ou chamar o PSC.
    const attempt = await this.oauthOperation(admin, params, params.state, 'claim', { redirect_uri: params.redirectUri }, 'processing');
    let externalStarted = false, exchanged = false;
    try {
      if (params.cancelled) throw new HttpError(409, 'Autorização cancelada. Inicie nova conexão.');
      if (oauthRedirect(attempt.provider) !== params.redirectUri) throw new HttpError(403, 'Endereço de retorno incompatível.');
      const codeVerifier = decryptToken(attempt.verifier), provider = getSignatureProvider(attempt.provider);
      externalStarted = true;
      const token = await provider.exchangeAuthorizationCode({ code: params.code, codeVerifier, redirectUri: attempt.redirect_uri });
      exchanged = true;
      if (!token.accessToken || !Number.isFinite(token.expiresIn) || token.expiresIn <= 0 || token.expiresIn > 86400)
        throw new HttpError(422, 'Resposta de autorização inválida.');
      const certs = await provider.getCertificates(token.accessToken);
      let cert;
      try { cert = parseX509Certificate(certs[0].rawPem, certs[0].alias); }
      catch { throw new HttpError(422, 'Não foi possível identificar o certificado autorizado.'); }
      const cpf = signingCpf(cert.cpf);
      if (!cpf) throw new HttpError(422, 'Não foi possível identificar o CPF do titular no certificado.');
      // Não confia somente no CPF editável do perfil nem no CPF declarado pelo PSC.
      const { data: previous, error } = await admin.from('signature_sessions')
        .select('certificate_raw').eq('user_id', params.userId);
      if (error) throw new HttpError(503, 'Não foi possível conferir a identidade anterior.');
      const priorMismatch = (previous || []).some(row => {
        if (!row.certificate_raw) return false; // legado será revogado na transação
        try { return signingCpf(parseX509Certificate(row.certificate_raw).cpf) !== cpf; }
        catch { return true; }
      });
      const completed = await this.oauthOperation(admin, params, params.state, 'finish', {
        cpf, certificate_alias: cert.alias, certificate_subject: cert.subject, certificate_issuer: cert.issuer,
        certificate_valid_from: cert.validFrom.toISOString(), certificate_valid_to: cert.validTo.toISOString(),
        certificate_raw: cert.rawPem, common_name: cert.commonName, prior_certificate_mismatch: priorMismatch,
        access_token_encrypted: encryptToken(token.accessToken), expires_at: new Date(Date.now() + token.expiresIn * 1000).toISOString(),
      }, 'completed');
      const s = completed.session;
      return { id: s.id, clinicId: s.clinic_id, userId: s.user_id, provider: s.provider, cpf: s.cpf,
        certificateAlias: s.certificate_alias, certificateSubject: s.certificate_subject, certificateIssuer: s.certificate_issuer,
        certificateValidFrom: s.certificate_valid_from, certificateValidTo: s.certificate_valid_to, expiresAt: s.expires_at, revoked: s.revoked };
    } catch (error) {
      // Sem repetição de token exchange, inclusive se a resposta do COMMIT se perder.
      const invalidCode = !exchanged && error instanceof HttpError && [400, 401, 403].includes(error.status);
      const uncertain = externalStarted && !invalidCode && (!exchanged || !(error instanceof HttpError) || error.status >= 500);
      const reason = params.cancelled ? 'cancelled' : invalidCode ? 'invalid_code' : !exchanged ? 'external_failure' : 'certificate_identity_unavailable';
      try { await this.oauthOperation(admin, params, params.state, uncertain ? 'uncertain' : 'reject', { reason }); }
      catch { /* O claim durável permanece processing; nunca libera nova troca. */ }
      throw new HttpError(uncertain ? 409 : error instanceof HttpError && error.status === 422 ? 422 : 403,
        uncertain ? 'Resultado externo incerto. A tentativa não será repetida; inicie nova conexão.'
          : params.cancelled ? 'Autorização cancelada. Inicie nova conexão.'
          : 'Não foi possível autorizar o certificado para esta identidade. Inicie nova conexão ou solicite revisão.');
    }
  }

  /**
   * Retrieves current active signature session for user (without exposing encrypted token).
   */
  async getActiveSession(
    db: SupabaseClient,
    clinicId: string,
    userId: string
  ): Promise<SignatureSessionData | null> {
    const { data: session } = await db
      .from('signature_sessions')
      .select(
        'id, clinic_id, user_id, provider, cpf, certificate_alias, certificate_subject, certificate_issuer, certificate_valid_from, certificate_valid_to, expires_at, revoked'
      )
      .eq('clinic_id', clinicId)
      .eq('user_id', userId)
      .eq('revoked', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!session) return null;

    return {
      id: session.id,
      clinicId: session.clinic_id,
      userId: session.user_id,
      provider: session.provider,
      cpf: session.cpf,
      certificateAlias: session.certificate_alias,
      certificateSubject: session.certificate_subject,
      certificateIssuer: session.certificate_issuer,
      certificateValidFrom: session.certificate_valid_from,
      certificateValidTo: session.certificate_valid_to,
      expiresAt: session.expires_at,
      revoked: session.revoked,
    };
  }

  /**
   * Revokes the active session for the user.
   */
  async revokeSession(
    db: SupabaseClient,
    clinicId: string,
    userId: string
  ): Promise<void> {
    const admin = adminClient();
    const { data: session } = await admin
      .from('signature_sessions')
      .select('id, access_token_encrypted, provider')
      .eq('clinic_id', clinicId)
      .eq('user_id', userId)
      .eq('revoked', false)
      .maybeSingle();

    if (session) {
      try {
        const provider = getSignatureProvider(session.provider);
        if (provider.revokeSession) {
          const token = decryptToken(session.access_token_encrypted);
          await provider.revokeSession(token);
        }
      } catch {
        // Best effort remote revocation
      }

      await admin
        .from('signature_sessions')
        .update({ revoked: true })
        .eq('id', session.id);

      await admin.from('audit_events').insert({
        clinic_id: clinicId,
        actor_id: userId,
        action: 'signature_session_revoked',
        entity_type: 'signature_session',
        entity_id: session.id,
      });
    }
  }

  /**
   * Signs a clinical document using the authorized cloud certificate session.
   * Produces an ICP-Brasil compliant PAdES PDF and ensures immutability.
   */
  async signClinicalDocument(params: {
    db: SupabaseClient;
    clinicId: string;
    userId: string;
    documentId: string;
    documentVersion?: number;
    idempotencyKey?: string;
  }): Promise<{
    success: boolean;
    documentId: string;
    signedPdfPath: string;
    verification: PadesVerificationResult;
    signature?: DigitalSignatureRecord;
    simulation?: boolean;
    document?: ClinicalDocument;
  }> {
    const admin = this.documentAdmin();

    // 2. Fetch document
    const { data: docRecord, error: docErr } = await admin
      .from('clinical_documents')
      .select('*')
      .eq('clinic_id', params.clinicId)
      .eq('id', params.documentId)
      .maybeSingle();

    if (docErr || !docRecord) {
      throw new HttpError(404, 'Documento clínico não encontrado.');
    }

    const audit = async (action: string, reason: string, details: Record<string, unknown> = {}) => {
      const { error } = await admin.from('audit_events').insert({
        clinic_id: params.clinicId, actor_id: params.userId, action,
        entity_type: 'clinical_documents', entity_id: params.documentId,
        context: { reason, document_version: docRecord.version, ...details },
      });
      if (error) throw new HttpError(503, 'Não foi possível registrar a operação de assinatura.');
    };
    try {
      assertDocumentSigningAuthor(params, docRecord);
    } catch (error) {
      await audit('document.signature_denied', error instanceof SigningIdentityError ? error.reason : 'identity_unavailable');
      throw error;
    }

    const doc = docRecord as ClinicalDocument;
    if (doc.author_id !== params.userId)
      throw new HttpError(403, 'Apenas o autor pode emitir e assinar este documento.');
    if (doc.kind === 'Receita') {
      const block = prescriptionSigningBlock(doc.prescription_category || 'RCE');
      if (block) throw new HttpError(409, block);
    }

    return signDocumentAttempt(admin, params, docRecord);
  }

  /**
   * Signs a synthetic test document (no clinical data) to validate end-to-end PAdES signature with the real provider.
   */
  async signTestDocument(params: {
    clinicId: string;
    userId: string;
  }): Promise<{
    success: boolean;
    verification: PadesVerificationResult;
    signedPdfBase64: string;
    storagePath: string;
    certInfo: {
      subject: string;
      issuer: string;
      cpf: string;
      validFrom: string;
      validTo: string;
    };
  }> {
    const admin = adminClient();
    const { data: sessionRecord } = await admin
      .from('signature_sessions')
      .select('*')
      .eq('clinic_id', params.clinicId)
      .eq('user_id', params.userId)
      .eq('revoked', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!sessionRecord) {
      throw new HttpError(
        401,
        'Nenhuma sessão ativa de certificado em nuvem. Conecte seu certificado digital para assinar.'
      );
    }

    const accessToken = decryptToken(sessionRecord.access_token_encrypted);
    const provider = getSignatureProvider(sessionRecord.provider);

    // 1. Create a clean synthetic test PDF
    const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([595.28, 841.89]); // A4
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const testId = crypto.randomUUID();
    const timestampStr = new Date().toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
    });

    page.drawText('PROVA DE CONCEITO - ASSINATURA DIGITAL ICP-BRASIL', {
      x: 50,
      y: 780,
      size: 16,
      font: fontBold,
      color: rgb(0.08, 0.2, 0.4),
    });

    page.drawText(`Validação Técnica PAdES com Certificado em Nuvem ${signatureProviderLabel(sessionRecord.provider)}`, {
      x: 50,
      y: 755,
      size: 12,
      font,
      color: rgb(0.2, 0.2, 0.2),
    });

    const lines = [
      `Data e Hora da Emissão: ${timestampStr} (Horário de Brasília)`,
      `Identificador do Documento: ${testId}`,
      `Titular do Certificado: ${sessionRecord.certificate_subject}`,
      `CPF do Signatário: ${formatCpf(sessionRecord.cpf)}`,
      `Emissor da AC: ${sessionRecord.certificate_issuer}`,
      `Validade: ${new Date(sessionRecord.certificate_valid_from).toLocaleDateString('pt-BR')} até ${new Date(sessionRecord.certificate_valid_to).toLocaleDateString('pt-BR')}`,
      '',
      'Finalidade do Documento:',
      'Este documento técnico sintético não contém quaisquer dados clínicos,',
      'diagnósticos ou informações sensíveis de pacientes.',
      'Sua emissão tem por objetivo exclusivo a validação da cadeia de confiança,',
      'conformidade com a MP 2.200-2/2001 e verificação criptográfica do padrão PAdES.',
    ];

    let y = 700;
    for (const line of lines) {
      if (line.startsWith('Finalidade') || line.startsWith('Data') || line.startsWith('Titular')) {
        page.drawText(line, { x: 50, y, size: 10, font: fontBold, color: rgb(0.1, 0.1, 0.1) });
      } else {
        page.drawText(line, { x: 50, y, size: 10, font, color: rgb(0.2, 0.2, 0.2) });
      }
      y -= 20;
    }

    const unsignedPdfBytes = await pdfDoc.save();

    // 2. Prepare PAdES placeholder & compute hash
    const prepared = await padesService.preparePdfForSignature(
      Buffer.from(unsignedPdfBytes),
      {
        signerName: sessionRecord.certificate_subject.split(':')[0] || 'Médico Titular',
        reason: 'Validação técnica de assinatura digital ICP-Brasil PAdES',
        location: 'São Paulo, Brasil',
      }
    );

    // 3. Request remote CMS signature from the provider
    const signResult = await provider.signHash({
      accessToken,
      certificateAlias: sessionRecord.certificate_alias,
      hashHex: prepared.digestHex,
      documentAlias: 'Documento Teste ICP-Brasil',
    });

    // 4. Embed detached CMS signature into reserved ByteRange
    const signedPdfBuffer = padesService.embedSignature(
      prepared,
      signResult.cmsSignatureBase64
    );

    // 5. Verify cryptographically
    const verification = await padesService.verifyPadesSignature(signedPdfBuffer, {
      validationContext: 'LIVE_ISSUANCE',
      ...liveIssuanceRevocationOptions(),
    });
    if (!verification.assessment.issuanceAllowed) {
      throw new Error(
        `Falha na validação criptográfica do PDF assinado: ${
          verification.assessment.issuanceBlockReason ||
          verification.error ||
          'Assinatura inválida'
        }`
      );
    }

    // 6. Upload to Storage
    const storagePath = `${params.clinicId}/signatures/test_${testId}_signed.pdf`;
    await admin.storage
      .from('clinical-files')
      .upload(storagePath, signedPdfBuffer, {
        contentType: 'application/pdf',
        upsert: true,
      });

    return {
      success: true,
      verification,
      signedPdfBase64: signedPdfBuffer.toString('base64'),
      storagePath,
      certInfo: {
        subject: sessionRecord.certificate_subject,
        issuer: sessionRecord.certificate_issuer,
        cpf: formatCpf(sessionRecord.cpf),
        validFrom: sessionRecord.certificate_valid_from,
        validTo: sessionRecord.certificate_valid_to,
      },
    };
  }
}

export const documentSigningService = new DocumentSigningService();
