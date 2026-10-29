import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { adminClient } from '../supabase/admin.ts';
import { HttpError } from '../supabase/server.ts';
import { documentPdf } from '../document-pdf.ts';
import { withPdfData } from '../supabase/document-pdf-data.ts';
import {
  parsePrescriptionText,
  type ClinicalDocument,
} from '../document-fields.ts';
import { signReservedSimulation } from '../sncr/signing.ts';
import {
  formatCpf,
  encryptToken,
  decryptToken,
  generatePkce,
  parseX509Certificate,
} from './crypto-utils.ts';
import { getSignatureProvider } from './provider-factory.ts';
import { signatureProviderLabel, type SignatureProviderId } from './providers.ts';
import { padesService } from './pades-service.ts';
import {
  assertDocumentSigningAuthor,
  authorizeSigningIdentity,
  assertSigningCertificate,
  assertAuthorizedDocumentVersion,
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
  /**
   * Initiates an OAuth 2.0 PKCE flow with the signature provider (Bird ID or VIDaaS).
   */
  async initiateOAuthSession(params: {
    db: SupabaseClient;
    clinicId: string;
    userId: string;
    redirectUri: string;
    provider: SignatureProviderId;
  }): Promise<{ authorizationUrl: string; state: string }> {
    const provider = getSignatureProvider(params.provider);
    const { codeVerifier, codeChallenge } = generatePkce();

    const state = crypto.randomBytes(24).toString('base64url');
    const stateHash = crypto.createHash('sha256').update(state).digest('hex');
    const codeVerifierEncrypted = encryptToken(codeVerifier);

    const admin = adminClient();

    // Store state with encrypted verifier
    const { error: stateError } = await admin
      .from('signature_oauth_states')
      .insert({
        clinic_id: params.clinicId,
        user_id: params.userId,
        provider: params.provider,
        state_hash: stateHash,
        code_verifier_encrypted: codeVerifierEncrypted,
        redirect_uri: params.redirectUri,
        expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      });

    if (stateError) {
      throw new HttpError(
        500,
        `Falha ao iniciar estado OAuth: ${stateError.message}`
      );
    }

    // Try to get doctor CPF to use as login_hint for the provider
    const { data: profile } = await admin
      .from('document_profiles')
      .select('cpf')
      .eq('clinic_id', params.clinicId)
      .eq('user_id', params.userId)
      .maybeSingle();

    const authorizationUrl = provider.getAuthorizationUrl({
      state,
      codeChallenge,
      redirectUri: params.redirectUri,
      loginHint: profile?.cpf || undefined,
      lifetimeSeconds: 4 * 3600, // 4 hours signature session
    });

    return { authorizationUrl, state };
  }

  /**
   * Completes OAuth callback: exchanges code, validates CPF, stores encrypted session.
   */
  async handleOAuthCallback(params: {
    db: SupabaseClient;
    clinicId: string;
    userId: string;
    code: string;
    state: string;
  }): Promise<SignatureSessionData> {
    const admin = this.documentAdmin();
    const stateHash = crypto
      .createHash('sha256')
      .update(params.state)
      .digest('hex');

    // Retrieve and validate state
    const { data: stateRecord, error: stateError } = await admin
      .from('signature_oauth_states')
      .select('*')
      .eq('state_hash', stateHash)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (stateError || !stateRecord) {
      throw new HttpError(
        400,
        'Estado de autorização expirado ou inválido (CSRF prevenido). Reinicie a autorização.'
      );
    }

    if (
      stateRecord.clinic_id !== params.clinicId ||
      stateRecord.user_id !== params.userId
    ) {
      throw new HttpError(
        403,
        'O estado de autorização pertence a outro usuário ou clínica.'
      );
    }

    const codeVerifier = decryptToken(stateRecord.code_verifier_encrypted);
    const provider = getSignatureProvider(stateRecord.provider);

    // 1. Exchange authorization code for token
    const tokenResult = await provider.exchangeAuthorizationCode({
      code: params.code,
      codeVerifier,
      redirectUri: stateRecord.redirect_uri,
    });

    // 2. Discover certificates
    const certs = await provider.getCertificates(tokenResult.accessToken);
    if (!certs.length) {
      throw new HttpError(
        422,
        `Nenhum certificado ICP-Brasil encontrado na conta ${signatureProviderLabel(stateRecord.provider)}.`
      );
    }
    // A identidade vem do certificado X.509, não de um CPF declarado na resposta OAuth.
    let cert;
    try { cert = parseX509Certificate(certs[0].rawPem, certs[0].alias); }
    catch { throw new HttpError(422, 'Não foi possível identificar o certificado autorizado.'); }

    const certCpf = signingCpf(cert.cpf);
    if (!certCpf) {
      throw new HttpError(
        422,
        'Não foi possível identificar o CPF do titular no certificado digital ICP-Brasil.'
      );
    }

    // 3. Strict CPF validation against doctor's registered profile
    const { data: profile, error: profileError } = await admin
      .from('document_profiles')
      .select('cpf, physician_name')
      .eq('clinic_id', params.clinicId)
      .eq('user_id', params.userId)
      .maybeSingle();

    if (profileError) throw new HttpError(503, 'Não foi possível confirmar o perfil autorizado.');

    if (profile?.cpf) {
      const registeredCpf = signingCpf(profile.cpf);
      if (registeredCpf !== certCpf) {
        // Security audit event
        await admin.from('audit_events').insert({
          clinic_id: params.clinicId,
          actor_id: params.userId,
          action: 'signature_cpf_mismatch',
          entity_type: 'signature_session',
          entity_id: params.userId,
          context: {
            reason: 'certificate_profile_identity_mismatch',
          },
        });

        throw new HttpError(
          403,
          'O certificado não corresponde à identidade cadastrada para este médico. A sessão não foi autorizada.'
        );
      }
    } else if (profile) {
      // First time setting CPF on profile: lock it to the verified certificate's CPF
      const { error } = await admin
        .from('document_profiles')
        .update({ cpf: certCpf })
        .eq('clinic_id', params.clinicId)
        .eq('user_id', params.userId);
      if (error) throw new HttpError(503, 'Não foi possível registrar a identidade autorizada.');
    } else {
      // Create initial profile locked to verified certificate
      const { error } = await admin
        .from('document_profiles')
        .insert({
          clinic_id: params.clinicId,
          user_id: params.userId,
          physician_name: cert.commonName || '',
          physician_registration: '',
          cpf: certCpf,
        });
      if (error) throw new HttpError(503, 'Não foi possível registrar a identidade autorizada.');
    }

    // 4. Store encrypted session
    const encryptedToken = encryptToken(tokenResult.accessToken);
    const expiresAt = new Date(
      Date.now() + tokenResult.expiresIn * 1000
    ).toISOString();

    // Invalidate prior sessions
    await admin
      .from('signature_sessions')
      .update({ revoked: true })
      .eq('clinic_id', params.clinicId)
      .eq('user_id', params.userId)
      .eq('revoked', false);

    const { data: newSession, error: sessionError } = await admin
      .from('signature_sessions')
      .insert({
        clinic_id: params.clinicId,
        user_id: params.userId,
        provider: stateRecord.provider,
        cpf: certCpf,
        certificate_alias: cert.alias,
        certificate_subject: cert.subject,
        certificate_issuer: cert.issuer,
        certificate_valid_from: cert.validFrom.toISOString(),
        certificate_valid_to: cert.validTo.toISOString(),
        certificate_raw: cert.rawPem,
        access_token_encrypted: encryptedToken,
        expires_at: expiresAt,
        revoked: false,
      })
      .select()
      .single();

    if (sessionError || !newSession) {
      throw new HttpError(
        500,
        `Falha ao salvar sessão de assinatura: ${sessionError?.message}`
      );
    }

    // Clean up consumed OAuth state
    await admin
      .from('signature_oauth_states')
      .delete()
      .eq('id', stateRecord.id);

    // Audit log
    await admin.from('audit_events').insert({
      clinic_id: params.clinicId,
      actor_id: params.userId,
      action: 'signature_session_created',
      entity_type: 'signature_session',
      entity_id: newSession.id,
      context: {
        provider: stateRecord.provider,
        expires_at: expiresAt,
      },
    });

    return {
      id: newSession.id,
      clinicId: newSession.clinic_id,
      userId: newSession.user_id,
      provider: newSession.provider,
      cpf: newSession.cpf,
      certificateAlias: newSession.certificate_alias,
      certificateSubject: newSession.certificate_subject,
      certificateIssuer: newSession.certificate_issuer,
      certificateValidFrom: newSession.certificate_valid_from,
      certificateValidTo: newSession.certificate_valid_to,
      expiresAt: newSession.expires_at,
      revoked: newSession.revoked,
    };
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

    if (docRecord.status === 'SIGNED' && !(docRecord.kind === 'Receita' && parsePrescriptionText(docRecord.text).modality !== 'simples')) {
      throw new HttpError(
        409,
        'Este documento já foi assinado digitalmente e está imutável.'
      );
    }

    const doc = docRecord as ClinicalDocument;

    if (doc.kind==='Receita' && parsePrescriptionText(doc.text).modality==='simples' && parsePrescriptionText(doc.text).sncrNumber) throw new HttpError(422, 'Número SNCR manual incompatível com receita simples. Revise o rascunho.');
    if (doc.kind === 'Receita' && parsePrescriptionText(doc.text).modality !== 'simples') {
      return signReservedSimulation(admin, params, params.documentId, {
        put: async (path, bytes) => {
          const { error } = await admin.storage.from('clinical-files').upload(path, bytes, {contentType:'application/pdf',upsert:false});
          if (error) throw new HttpError(503, 'Falha ao armazenar artefato simulado. Não repetir assinatura.');
        },
        get: async (path) => {
          const {data,error}=await admin.storage.from('clinical-files').download(path);
          if (error || !data) throw new HttpError(503, 'Artefato original indisponível.');
          return new Uint8Array(await data.arrayBuffer());
        },
      }, {enrich: (d) => withPdfData(admin,params.clinicId,d)});
    }

    if (!['DRAFT', 'FINALIZED', 'SIGNATURE_FAILED'].includes(doc.status || ''))
      throw new HttpError(409, 'Assinatura já iniciada ou documento indisponível. Consulte o estado antes de repetir.');

    // 1. Check active session
    const { data: session, error: sessionErr } = await admin
      .from('signature_sessions')
      .select('*')
      .eq('clinic_id', params.clinicId)
      .eq('user_id', params.userId)
      .eq('revoked', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (sessionErr || !session) {
      throw new HttpError(
        401,
        'Nenhuma sessão ativa de certificado em nuvem. Conecte seu certificado digital para assinar.'
      );
    }

    const { data: profile, error: profileError } = await admin.from('document_profiles')
      .select('cpf,physician_registration').eq('clinic_id', params.clinicId).eq('user_id', params.userId).maybeSingle();
    if (profileError) throw new HttpError(503, 'Não foi possível confirmar a identidade autorizada.');
    let authorization;
    try {
      authorization = authorizeSigningIdentity(params, docRecord, session, profile);
    } catch (error) {
      await audit('document.signature_denied', error instanceof SigningIdentityError ? error.reason : 'identity_unavailable');
      throw error;
    }

    const accessToken = decryptToken(session.access_token_encrypted);

    const sncrNumber: string | undefined = undefined;
    const prescriptionModality = doc.kind === 'Receita' ? 'simples' : undefined;

    // Toda receita ou documento assinado digitalmente precisa ter data de emissão definida
    const effectiveDate =
      doc.document_date ||
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
      }).format(new Date());
    doc.document_date = effectiveDate;

    // 3. Mark status as SIGNING
    const { data: locked, error: lockError } = await admin
      .from('clinical_documents')
      .update({ status: 'SIGNING', document_date: effectiveDate })
      .eq('id', params.documentId).eq('clinic_id', params.clinicId)
      .eq('author_id', params.userId).eq('version', authorization.documentVersion)
      .in('status', ['DRAFT', 'FINALIZED', 'SIGNATURE_FAILED'])
      .select('*').maybeSingle();
    if (lockError || !locked) throw new HttpError(409, 'Documento alterado ou assinatura já iniciada. Reabra o documento.');

    const attemptId = crypto.randomUUID();
    let externalStarted = false;
    let requestedDigest: string | undefined;
    let providerTransactionId: string | undefined;
    let cmsHash: string | undefined;

    try {
      // 4. CPF e endereço do paciente (receitas) e timbre do autor
      await withPdfData(admin, params.clinicId, doc);

      // 5. Generate unsigned official PDF
      const unsignedPdfBytes = await documentPdf(doc, { isDraft: false });
      const unsignedPdfHash = crypto
        .createHash('sha256')
        .update(Buffer.from(unsignedPdfBytes))
        .digest('hex');

      // Extract signer name from CN
      const cnMatch = session.certificate_subject.match(/CN=([^,\n/]+)/i);
      const signerName = cnMatch
        ? cnMatch[1].split(':')[0].trim()
        : doc.physician_name;

      // 6. Prepare PDF with PAdES placeholder (stamp + QR Code on all pages)
      const prepared = await padesService.preparePdfForSignature(
        unsignedPdfBytes,
        {
          signerName,
          signerCpf: formatCpf(session.cpf),
          doctorCrm: doc.physician_registration,
          sncrNumber,
          reason:
            'Documento assinado digitalmente com certificado ICP-Brasil (RDC Anvisa 1.000/2025)',
        }
      );

      // 7. Request signature on the document hash from the provider (HSM)
      const provider = getSignatureProvider(session.provider);
      requestedDigest = prepared.digestHex;
      await audit('document.signature_started', 'authorized_identity', {
        attempt_id: attemptId, session_id: authorization.sessionId, document_hash: requestedDigest,
      });
      externalStarted = true;
      const signResult = await provider.signHash({
        accessToken,
        certificateAlias: session.certificate_alias,
        hashHex: prepared.digestHex,
        documentAlias: `${doc.kind} #${doc.id.slice(0, 8)}`,
      });
      if (signResult.providerTransactionId && /^[A-Za-z0-9._:-]{1,200}$/.test(signResult.providerTransactionId))
        providerTransactionId = signResult.providerTransactionId;
      cmsHash = crypto.createHash('sha256').update(signResult.cmsSignatureBase64).digest('hex');

      // 8. Embed the CMS signature into the PDF
      const signedPdfBuffer = padesService.embedSignature(
        prepared,
        signResult.cmsSignatureBase64
      );
      const signedPdfHash = crypto
        .createHash('sha256')
        .update(signedPdfBuffer)
        .digest('hex');

      // 9. Verify the final signed PDF locally
      const verification =
        await padesService.verifyPadesSignature(signedPdfBuffer);
      if (!verification.isValid) {
        throw new SigningIdentityError('cms_verification_failed', 409);
      }
      assertSigningCertificate(authorization, verification);

      const { data: currentDoc, error: currentError } = await admin.from('clinical_documents')
        .select('*').eq('clinic_id', params.clinicId).eq('id', params.documentId).maybeSingle();
      if (currentError) throw new SigningIdentityError('document_recheck_unavailable', 409);
      assertAuthorizedDocumentVersion(authorization, currentDoc);
      const { data: currentSession, error: sessionRecheckError } = await admin.from('signature_sessions')
        .select('*').eq('id', authorization.sessionId).eq('clinic_id', params.clinicId).eq('user_id', params.userId).maybeSingle();
      const { data: currentProfile, error: profileRecheckError } = await admin.from('document_profiles')
        .select('cpf,physician_registration').eq('clinic_id', params.clinicId).eq('user_id', params.userId).maybeSingle();
      if (sessionRecheckError || profileRecheckError || !currentSession)
        throw new SigningIdentityError('identity_recheck_unavailable', 409);
      const currentAuthorization = authorizeSigningIdentity(params, currentDoc!, currentSession, currentProfile);
      if (currentAuthorization.cpf !== authorization.cpf || currentAuthorization.certificateFingerprint !== authorization.certificateFingerprint)
        throw new SigningIdentityError('authorized_identity_changed', 409);

      // 10. Upload signed PDF to Storage
      const storagePath = `${params.clinicId}/signatures/${params.documentId}_v${doc.version}_signed.pdf`;
      const uploadRes = await admin.storage
        .from('clinical-files')
        .upload(storagePath, signedPdfBuffer, {
          contentType: 'application/pdf',
          upsert: false,
        });

      if (uploadRes.error) {
        throw new Error(
          `Falha ao salvar PDF assinado no Storage: ${uploadRes.error.message}`
        );
      }

      // 11. Insert digital signature record
      const signatureInsert = {
        clinic_id: params.clinicId,
        document_id: params.documentId,
        document_version: doc.version,
        signer_user_id: params.userId,
        signer_doctor_id: params.userId,
        provider: session.provider,
        certificate_subject: verification.certificateSubject,
        certificate_issuer: verification.certificateIssuer,
        certificate_serial: verification.certificateSerial || '',
        certificate_fingerprint: verification.certificateFingerprint || '',
        cpf_from_certificate: authorization.cpf,
        signature_algorithm: 'SHA256withRSA',
        digest_algorithm: 'SHA-256',
        signature_format: 'PAdES-B-B',
        signed_at: new Date().toISOString(),
        document_hash: prepared.digestHex,
        unsigned_pdf_hash: unsignedPdfHash,
        signed_pdf_hash: signedPdfHash,
        signed_pdf_storage_path: storagePath,
        status: 'SIGNED',
        // Identidade/CMS correspondentes não demonstram cadeia ou revogação.
        verification_status: 'UNVERIFIED',
        provider_transaction_id: providerTransactionId || null,
      };

      const { data: sigRecord, error: sigInsertErr } = await admin
        .from('digital_signatures')
        .insert(signatureInsert)
        .select()
        .single();

      if (sigInsertErr || !sigRecord) {
        throw new Error(
          `Erro ao registrar assinatura no banco: ${sigInsertErr?.message}`
        );
      }

      // 12. Update clinical_documents status, text (if SNCR injected), document_date and path
      const { data: completed, error: docUpdateErr } = await admin
        .from('clinical_documents')
        .update({
          status: 'SIGNED',
          text: doc.text,
          document_date: effectiveDate,
          signed_pdf_path: storagePath,
          updated_at: new Date().toISOString(),
        })
        .eq('id', params.documentId).eq('clinic_id', params.clinicId).eq('author_id', params.userId)
        .eq('version', authorization.documentVersion).eq('status', 'SIGNING')
        .select('*').maybeSingle();

      if (docUpdateErr || !completed) throw new SigningIdentityError('document_completion_unconfirmed', 409);

      // 13. Audit event
      await admin.from('audit_events').insert({
        clinic_id: params.clinicId,
        actor_id: params.userId,
        action: 'document.signed',
        entity_type: 'clinical_documents',
        entity_id: params.documentId,
        context: {
          document_id: params.documentId,
          version: doc.version,
          document_date: effectiveDate,
          certificate_serial: verification.certificateSerial,
          signed_pdf_hash: signedPdfHash,
          storage_path: storagePath,
          provider: session.provider,
          ...(prescriptionModality ? { prescription_modality: prescriptionModality } : {}),
          ...(sncrNumber ? { sncr_number: sncrNumber } : {}),
        },
      });

      return {
        success: true,
        documentId: params.documentId,
        signedPdfPath: storagePath,
        verification,
        signature: sigRecord as DigitalSignatureRecord,
      };
    } catch (error) {
      // Depois da chamada externa, SIGNING é durável e bloqueia nova assinatura.
      // Uma falha de auditoria também não autoriza repetir a operação externa.
      if (!externalStarted) await admin.from('clinical_documents').update({ status: 'SIGNATURE_FAILED' })
        .eq('id', params.documentId).eq('clinic_id', params.clinicId)
        .eq('version', authorization.documentVersion).eq('status', 'SIGNING');
      try {
        await audit(externalStarted ? 'document.signature_pending' : 'document.signature_failed',
          error instanceof SigningIdentityError ? error.reason : externalStarted ? 'external_result_unconfirmed' : 'preparation_failed', {
            attempt_id: attemptId, session_id: authorization.sessionId,
            ...(requestedDigest ? { document_hash: requestedDigest } : {}),
            ...(providerTransactionId ? { provider_transaction_id: providerTransactionId } : {}),
            ...(cmsHash ? { cms_hash: cmsHash } : {}),
          });
      } catch { /* O estado SIGNING continua bloqueando retry mesmo sem auditoria disponível. */ }
      throw new HttpError(externalStarted ? 409 : 503, externalStarted
        ? 'Assinatura pendente de reconciliação. Não foi confirmada para este documento. Não repita a assinatura.'
        : 'Não foi possível preparar a assinatura. Nenhuma assinatura externa foi solicitada.');
    }
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
    const verification = await padesService.verifyPadesSignature(signedPdfBuffer);
    if (!verification.isValid) {
      throw new Error(
        `Falha na validação criptográfica do PDF assinado: ${
          verification.error || 'Assinatura inválida'
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
