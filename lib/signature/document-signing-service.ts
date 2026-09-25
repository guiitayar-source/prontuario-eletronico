import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { adminClient } from '@/lib/supabase/admin';
import { HttpError } from '@/lib/supabase/server';
import { documentPdf } from '@/lib/document-pdf';
import type { ClinicalDocument } from '@/lib/document-fields';
import {
  cleanCpf,
  formatCpf,
  encryptToken,
  decryptToken,
  generatePkce,
} from './crypto-utils.ts';
import { getSignatureProvider } from './provider-factory.ts';
import { padesService } from './pades-service.ts';
import type {
  DigitalSignatureRecord,
  PadesVerificationResult,
  SignatureSessionData,
} from './types.ts';

export class DocumentSigningService {
  /**
   * Initiates an OAuth 2.0 PKCE flow with the signature provider (Bird ID).
   */
  async initiateOAuthSession(params: {
    db: SupabaseClient;
    clinicId: string;
    userId: string;
    redirectUri: string;
    provider?: string;
  }): Promise<{ authorizationUrl: string; state: string }> {
    const provider = getSignatureProvider();
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
        provider: params.provider || 'birdid',
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

    // Try to get doctor CPF to use as login_hint for Bird ID
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
    const admin = adminClient();
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
    const provider = getSignatureProvider();

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
        'Nenhum certificado ICP-Brasil encontrado na conta Bird ID.'
      );
    }
    const cert = certs[0];

    const certCpf = cleanCpf(cert.cpf || tokenResult.cpf);
    if (!certCpf || certCpf.length !== 11) {
      throw new HttpError(
        422,
        'Não foi possível identificar o CPF do titular no certificado digital ICP-Brasil.'
      );
    }

    // 3. Strict CPF validation against doctor's registered profile
    const { data: profile } = await admin
      .from('document_profiles')
      .select('cpf, physician_name')
      .eq('clinic_id', params.clinicId)
      .eq('user_id', params.userId)
      .maybeSingle();

    if (profile?.cpf) {
      const registeredCpf = cleanCpf(profile.cpf);
      if (registeredCpf && registeredCpf !== certCpf) {
        // Security audit event
        await admin.from('audit_events').insert({
          clinic_id: params.clinicId,
          actor_id: params.userId,
          action: 'signature_cpf_mismatch',
          entity_type: 'signature_session',
          entity_id: params.userId,
          context: {
            doctor_registered_cpf: formatCpf(registeredCpf),
            certificate_cpf: formatCpf(certCpf),
            certificate_subject: cert.subject,
          },
        });

        throw new HttpError(
          403,
          `O CPF do certificado digital (${formatCpf(certCpf)}) não coincide com o CPF cadastrado para o médico (${formatCpf(registeredCpf)}). Por segurança, a sessão foi cancelada.`
        );
      }
    } else {
      // First time setting CPF on profile: lock it to the verified certificate's CPF
      await admin
        .from('document_profiles')
        .update({ cpf: certCpf })
        .eq('clinic_id', params.clinicId)
        .eq('user_id', params.userId);
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
        cpf: certCpf,
        certificate_alias: cert.alias,
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
        const provider = getSignatureProvider();
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
   * Signs a clinical document using the authorized Bird ID session.
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
    signature: DigitalSignatureRecord;
  }> {
    const admin = adminClient();

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
        'Nenhuma sessão ativa de certificado digital Bird ID. Conecte sua conta Bird ID para assinar.'
      );
    }

    const accessToken = decryptToken(session.access_token_encrypted);

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

    if (docRecord.status === 'SIGNED') {
      throw new HttpError(
        409,
        'Este documento já foi assinado digitalmente e está imutável.'
      );
    }

    const doc = docRecord as ClinicalDocument;

    // 3. Mark status as SIGNING
    await admin
      .from('clinical_documents')
      .update({ status: 'SIGNING' })
      .eq('id', params.documentId);

    try {
      // 4. If prescription, load patient address if needed
      if (doc.kind === 'Receita') {
        const { data: patientData } = await admin
          .from('patients')
          .select('street,address_number,complement,neighborhood,city,state')
          .eq('clinic_id', params.clinicId)
          .eq('id', doc.patient_id)
          .maybeSingle();

        if (patientData) {
          const parts = [
            patientData.street,
            patientData.address_number
              ? `nº ${patientData.address_number}`
              : '',
            patientData.complement,
            patientData.neighborhood,
          ].filter(Boolean);
          doc.patient_address = parts.join(', ');
          doc.patient_city = patientData.city || '';
          doc.patient_state = patientData.state || '';
        }
      }

      // 5. Generate unsigned official PDF
      const unsignedPdfBytes = await documentPdf(doc, { isDraft: false });
      const unsignedPdfHash = crypto
        .createHash('sha256')
        .update(Buffer.from(unsignedPdfBytes))
        .digest('hex');

      // Extract signer name from CN
      const cnMatch = session.certificate_subject.match(/CN=([^,\n/]+)/i);
      const signerName = cnMatch ? cnMatch[1].trim() : doc.physician_name;

      // 6. Prepare PDF with PAdES placeholder
      const prepared = await padesService.preparePdfForSignature(
        unsignedPdfBytes,
        {
          signerName,
          doctorCrm: doc.physician_registration,
          reason: 'Documento assinado digitalmente com certificado ICP-Brasil',
        }
      );

      // 7. Request signature on the document hash from the provider (HSM)
      const provider = getSignatureProvider();
      const signResult = await provider.signHash({
        accessToken,
        certificateAlias: session.certificate_alias,
        hashHex: prepared.digestHex,
        documentAlias: `${doc.kind} #${doc.id.slice(0, 8)}`,
      });

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
        throw new Error(
          `Falha na validação criptográfica do PDF assinado: ${
            verification.error || 'Assinatura inválida'
          }`
        );
      }

      // 10. Upload signed PDF to Storage
      const storagePath = `${params.clinicId}/signatures/${params.documentId}_v${doc.version}_signed.pdf`;
      const uploadRes = await admin.storage
        .from('clinical-files')
        .upload(storagePath, signedPdfBuffer, {
          contentType: 'application/pdf',
          upsert: true,
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
        certificate_subject:
          verification.certificateSubject || session.certificate_subject,
        certificate_issuer:
          verification.certificateIssuer || session.certificate_issuer,
        certificate_serial: verification.certificateSerial || '',
        certificate_fingerprint: verification.certificateFingerprint || '',
        cpf_from_certificate: verification.signerCpf || session.cpf,
        signature_algorithm: 'SHA256withRSA',
        digest_algorithm: 'SHA-256',
        signature_format: 'PAdES-B-B',
        signed_at: new Date().toISOString(),
        document_hash: prepared.digestHex,
        unsigned_pdf_hash: unsignedPdfHash,
        signed_pdf_hash: signedPdfHash,
        signed_pdf_storage_path: storagePath,
        status: 'SIGNED',
        verification_status: 'VALID',
        provider_transaction_id: signResult.providerTransactionId || null,
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

      // 12. Update clinical_documents status and path
      const { error: docUpdateErr } = await admin
        .from('clinical_documents')
        .update({
          status: 'SIGNED',
          signed_pdf_path: storagePath,
          updated_at: new Date().toISOString(),
        })
        .eq('id', params.documentId);

      if (docUpdateErr) {
        throw new Error(
          `Erro ao atualizar status do documento para SIGNED: ${docUpdateErr.message}`
        );
      }

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
          cpf: formatCpf(verification.signerCpf || session.cpf),
          certificate_serial: verification.certificateSerial,
          signed_pdf_hash: signedPdfHash,
          storage_path: storagePath,
          provider: session.provider,
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
      // Mark as SIGNATURE_FAILED on failure
      await admin
        .from('clinical_documents')
        .update({ status: 'SIGNATURE_FAILED' })
        .eq('id', params.documentId);

      await admin.from('audit_events').insert({
        clinic_id: params.clinicId,
        actor_id: params.userId,
        action: 'document.signature_failed',
        entity_type: 'clinical_documents',
        entity_id: params.documentId,
        context: {
          error: error instanceof Error ? error.message : String(error),
        },
      });

      throw error;
    }
  }
}

export const documentSigningService = new DocumentSigningService();
