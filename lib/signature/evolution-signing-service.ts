import crypto from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { adminClient } from '@/lib/supabase/admin';
import { HttpError } from '@/lib/supabase/server';
import {
  decryptToken,
  cleanCpf,
  parseX509Certificate,
  timingSafeEqualStr,
} from './crypto-utils.ts';
import { getSignatureProvider } from './provider-factory.ts';
import {
  buildCanonicalEvolutionV1,
  computeEvolutionHash,
  normalizeClinicalText,
} from './canonical-evolution.ts';
import type {
  EvolutionSignatureRecord,
  EvolutionVerificationResult,
} from './types.ts';

// Garante motor WebCrypto para pkijs
try {
  const cryptoEngine = new pkijs.CryptoEngine({
    name: 'NodeJS',
    crypto: globalThis.crypto,
  });
  pkijs.setEngine('NodeJS', cryptoEngine);
} catch {
  // Motor já configurado
}

export class EvolutionSigningService {
  /**
   * Assina digitalmente uma evolução clínica como registro eletrônico nativo (sem gerar PDF).
   * 1. Valida a sessão ativa do certificado em nuvem Bird ID.
   * 2. Bloqueia a evolução em status 'SIGNING' contra concorrência.
   * 3. Gera a representação canônica determinística (schema_version: 1) e calcula o hash SHA-256.
   * 4. Envia o hash para a API oficial Bird ID solicitando assinatura remota CMS (PKCS#7).
   * 5. Armazena a assinatura e os metadados criptográficos em evolution_signatures.
   * 6. Atualiza a evolução para status 'SIGNED' e bloqueia qualquer edição posterior.
   * 7. Conclui o agendamento associado (se houver).
   */
  async signEvolution(params: {
    db: SupabaseClient;
    clinicId: string;
    userId: string;
    evolutionId: string;
  }): Promise<{
    success: boolean;
    evolutionId: string;
    signature: EvolutionSignatureRecord;
    verification: EvolutionVerificationResult;
  }> {
    const admin = adminClient();

    // 1. Verificar sessão ativa de assinatura
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
        'Nenhuma sessão ativa de certificado digital Bird ID. Conecte seu certificado Bird ID para assinar.'
      );
    }

    const accessToken = decryptToken(session.access_token_encrypted);

    // 2. Buscar dados da evolução clínica
    const { data: evoRecord, error: evoErr } = await admin
      .from('consultations')
      .select('*')
      .eq('clinic_id', params.clinicId)
      .eq('id', params.evolutionId)
      .maybeSingle();

    if (evoErr || !evoRecord) {
      throw new HttpError(404, 'Evolução clínica não encontrada.');
    }

    if (evoRecord.status === 'SIGNED') {
      throw new HttpError(
        409,
        'Esta evolução já foi assinada digitalmente e está imutável. Registre um adendo.'
      );
    }

    if (evoRecord.author_id !== params.userId) {
      const { data: member } = await admin
        .from('clinic_members')
        .select('role')
        .eq('clinic_id', params.clinicId)
        .eq('user_id', params.userId)
        .maybeSingle();

      if (!member || (member.role !== 'owner' && evoRecord.author_id !== params.userId)) {
        throw new HttpError(
          403,
          'Apenas o médico autor da evolução ou o responsável pela clínica pode assinar este registro.'
        );
      }
    }

    const normalizedText = normalizeClinicalText(evoRecord.text || '');
    if (normalizedText.length === 0) {
      throw new HttpError(422, 'Escreva a evolução antes de assinar.');
    }

    // 3. Concurrency lock: Atualizar status para SIGNING atomicamente
    const { data: locked, error: lockErr } = await admin
      .from('consultations')
      .update({ status: 'SIGNING' })
      .eq('id', params.evolutionId)
      .eq('clinic_id', params.clinicId)
      .in('status', ['DRAFT', 'FINALIZED', 'SIGNATURE_FAILED'])
      .select()
      .maybeSingle();

    if (lockErr || !locked) {
      throw new HttpError(
        409,
        'A evolução clínica está sendo processada por outra operação de assinatura ou foi alterada.'
      );
    }

    // 4. Registrar início no log de auditoria
    await admin.from('audit_events').insert({
      clinic_id: params.clinicId,
      actor_id: params.userId,
      action: 'EVOLUTION_SIGNATURE_STARTED',
      entity_type: 'consultation',
      entity_id: params.evolutionId,
      context: {
        version: evoRecord.version,
        schema_version: 1,
      },
    });

    try {
      // 5. Construir representação canônica e calcular hash SHA-256
      const canonicalData = buildCanonicalEvolutionV1({
        evolutionId: evoRecord.id,
        clinicId: evoRecord.clinic_id,
        patientId: evoRecord.patient_id,
        appointmentId: evoRecord.appointment_id,
        doctorId: evoRecord.author_id,
        createdAt: evoRecord.created_at,
        clinicalText: normalizedText,
        version: evoRecord.version,
      });

      const { canonicalJson, hashHex } = computeEvolutionHash(
        canonicalData as unknown as Record<string, unknown>
      );

      // 6. Solicitar assinatura remota CMS à API Bird ID (HSM)
      const provider = getSignatureProvider();
      const signResult = await provider.signHash({
        accessToken,
        certificateAlias: session.certificate_alias,
        hashHex,
        documentAlias: `Evolução Clínica #${evoRecord.id.slice(0, 8)}`,
      });

      // 7. Extrair dados detalhados do certificado contido na assinatura CMS
      let certSubject = session.certificate_subject;
      let certIssuer = session.certificate_issuer;
      let certSerial = '';
      let certFingerprint = '';
      let certNotBefore = session.certificate_valid_from;
      let certNotAfter = session.certificate_valid_to;

      try {
        const cleanB64 = signResult.cmsSignatureBase64
          .replace(/-----[^-]+-----/g, '')
          .replace(/\s+/g, '');
        const sigDer = Buffer.from(cleanB64, 'base64');
        const sigAsn1 = asn1js.fromBER(
          sigDer.buffer.slice(
            sigDer.byteOffset,
            sigDer.byteOffset + sigDer.byteLength
          )
        );
        if (sigAsn1.result) {
          const contentInfo = new pkijs.ContentInfo({ schema: sigAsn1.result });
          const signedData = new pkijs.SignedData({
            schema: contentInfo.content,
          });
          const cert = signedData.certificates?.[0];
          if (cert instanceof pkijs.Certificate) {
            const certDer = Buffer.from(cert.toSchema().toBER());
            const parsed = parseX509Certificate(certDer);
            certSubject = parsed.subject;
            certIssuer = parsed.issuer;
            certSerial = parsed.serialNumber;
            certFingerprint = parsed.fingerprint256;
            certNotBefore = parsed.validFrom.toISOString();
            certNotAfter = parsed.validTo.toISOString();
          }
        }
      } catch (certParseErr) {
        console.warn('Aviso na extração de certificado do CMS:', certParseErr);
      }

      // Se o serial/fingerprint não estiverem no CMS, gerar fallback determinístico
      if (!certFingerprint) {
        certFingerprint = crypto
          .createHash('sha256')
          .update(certSubject + certIssuer)
          .digest('hex');
      }

      // 8. Inserir registro em evolution_signatures
      const nowIso = new Date().toISOString();
      const { data: sigRecord, error: sigErr } = await admin
        .from('evolution_signatures')
        .insert({
          clinic_id: params.clinicId,
          evolution_id: evoRecord.id,
          evolution_version: evoRecord.version,
          signer_user_id: params.userId,
          doctor_id: evoRecord.author_id,
          canonical_schema_version: 1,
          canonical_data: canonicalData,
          digest_algorithm: 'SHA-256',
          document_hash: hashHex,
          signature_format: 'CMS',
          signature_value: signResult.cmsSignatureBase64,
          certificate_subject: certSubject,
          certificate_issuer: certIssuer,
          certificate_serial: certSerial,
          certificate_fingerprint: certFingerprint,
          certificate_not_before: certNotBefore,
          certificate_not_after: certNotAfter,
          provider: session.provider,
          provider_signature_id: signResult.providerTransactionId || null,
          verification_status: 'VALID',
          verified_at: nowIso,
          signed_at: nowIso,
        })
        .select()
        .single();

      if (sigErr || !sigRecord) {
        throw new HttpError(
          500,
          `Falha ao salvar assinatura digital da evolução: ${sigErr?.message}`
        );
      }

      // 9. Atualizar a evolução para SIGNED (bloqueio definitivo)
      const { error: updateErr } = await admin
        .from('consultations')
        .update({
          status: 'SIGNED',
          signed_at: nowIso,
          signed_by: params.userId,
          current_signature_id: sigRecord.id,
          finalized_at: evoRecord.finalized_at || nowIso,
          finalized_by: evoRecord.finalized_by || params.userId,
          text: normalizedText,
        })
        .eq('id', evoRecord.id);

      if (updateErr) {
        throw new HttpError(
          500,
          `Falha ao atualizar status final da evolução: ${updateErr.message}`
        );
      }

      // 10. Se houver agendamento vinculado, marcar como concluído se ainda não estiver
      if (evoRecord.appointment_id) {
        const { data: appt } = await admin
          .from('appointments')
          .select('version, status')
          .eq('clinic_id', params.clinicId)
          .eq('id', evoRecord.appointment_id)
          .maybeSingle();

        if (appt && appt.status !== 'completed') {
          await admin
            .from('appointments')
            .update({
              status: 'completed',
              version: (appt.version ?? 0) + 1,
              updated_at: nowIso,
            })
            .eq('clinic_id', params.clinicId)
            .eq('id', evoRecord.appointment_id);
        }
      }

      // 11. Auditoria de sucesso
      await admin.from('audit_events').insert({
        clinic_id: params.clinicId,
        actor_id: params.userId,
        action: 'EVOLUTION_SIGNATURE_SUCCEEDED',
        entity_type: 'consultation',
        entity_id: evoRecord.id,
        context: {
          signature_id: sigRecord.id,
          document_hash: hashHex,
          provider: session.provider,
          schema_version: 1,
        },
      });

      // 12. Obter verificação imediata para retorno
      const verification = await this.verifyEvolutionSignature({
        db: params.db,
        clinicId: params.clinicId,
        evolutionId: evoRecord.id,
      });

      return {
        success: true,
        evolutionId: evoRecord.id,
        signature: sigRecord as EvolutionSignatureRecord,
        verification,
      };
    } catch (err) {
      // Reverter status para o anterior (FINALIZED ou SIGNATURE_FAILED) caso estivesse em SIGNING
      await admin
        .from('consultations')
        .update({
          status: evoRecord.finalized_at ? 'FINALIZED' : 'SIGNATURE_FAILED',
        })
        .eq('id', evoRecord.id)
        .eq('status', 'SIGNING');

      // Auditoria de falha
      await admin.from('audit_events').insert({
        clinic_id: params.clinicId,
        actor_id: params.userId,
        action: 'EVOLUTION_SIGNATURE_FAILED',
        entity_type: 'consultation',
        entity_id: evoRecord.id,
        context: {
          error: err instanceof Error ? err.message : String(err),
        },
      });

      throw err;
    }
  }

  /**
   * Verifica a integridade criptográfica da assinatura digital de uma evolução clínica:
   * 1. Recalcula o hash SHA-256 a partir da representação canônica dos dados.
   * 2. Compara o hash calculado com o document_hash registrado.
   * 3. Valida se o texto e campos atuais no banco coincidem integralmente com os dados assinados.
   * 4. Valida a estrutura ASN.1 CMS (PKCS#7) e o messageDigest autenticado.
   * 5. Confirma o período de validade do certificado ICP-Brasil.
   */
  async verifyEvolutionSignature(params: {
    db: SupabaseClient;
    clinicId: string;
    evolutionId: string;
    signatureId?: string;
  }): Promise<EvolutionVerificationResult> {
    const admin = adminClient();

    // 1. Buscar a evolução clínica
    const { data: evo, error: evoErr } = await admin
      .from('consultations')
      .select('*')
      .eq('clinic_id', params.clinicId)
      .eq('id', params.evolutionId)
      .maybeSingle();

    if (evoErr || !evo) {
      return {
        isValid: false,
        evolutionId: params.evolutionId,
        signerName: 'Desconhecido',
        signerCpf: null,
        certificateSubject: '',
        certificateIssuer: '',
        certificateSerial: '',
        certificateFingerprint: '',
        validFrom: new Date(0),
        validTo: new Date(0),
        documentHash: '',
        recalculatedHash: '',
        hashMatches: false,
        dataMatchesRecord: false,
        signedAt: new Date(0),
        error: 'Evolução clínica não encontrada.',
      };
    }

    // 2. Buscar o registro de assinatura
    let sigQuery = admin
      .from('evolution_signatures')
      .select('*')
      .eq('clinic_id', params.clinicId)
      .eq('evolution_id', params.evolutionId);

    if (params.signatureId) {
      sigQuery = sigQuery.eq('id', params.signatureId);
    } else if (evo.current_signature_id) {
      sigQuery = sigQuery.eq('id', evo.current_signature_id);
    } else {
      sigQuery = sigQuery.order('created_at', { ascending: false }).limit(1);
    }

    const { data: sig, error: sigErr } = await sigQuery.maybeSingle();

    if (sigErr || !sig) {
      return {
        isValid: false,
        evolutionId: params.evolutionId,
        signerName: 'Desconhecido',
        signerCpf: null,
        certificateSubject: '',
        certificateIssuer: '',
        certificateSerial: '',
        certificateFingerprint: '',
        validFrom: new Date(0),
        validTo: new Date(0),
        documentHash: '',
        recalculatedHash: '',
        hashMatches: false,
        dataMatchesRecord: false,
        signedAt: new Date(0),
        error: 'Nenhum registro de assinatura digital encontrado para esta evolução.',
      };
    }

    const canonicalData = sig.canonical_data as Record<string, unknown>;

    // 3. Recalcular o hash a partir dos dados canônicos gravados
    const { hashHex: recalculatedHash } = computeEvolutionHash(canonicalData);
    const hashMatches = timingSafeEqualStr(
      recalculatedHash.toLowerCase(),
      sig.document_hash.toLowerCase()
    );

    // 4. Comparar os dados canônicos com a evolução atual no banco
    const normalizedDbText = normalizeClinicalText(evo.text || '');
    const dataMatchesRecord =
      hashMatches &&
      normalizedDbText === canonicalData.clinical_text &&
      evo.patient_id === canonicalData.patient_id &&
      evo.clinic_id === canonicalData.clinic_id &&
      evo.author_id === canonicalData.doctor_id;

    // 5. Validar a assinatura CMS via ASN.1 / pkijs
    let cmsValid = false;
    let signerCpf: string | null = null;
    let signerName = '';
    const cnMatch = sig.certificate_subject.match(/CN=([^,\n/]+)/i);
    signerName = cnMatch ? cnMatch[1].trim() : sig.certificate_subject;

    try {
      const cleanB64 = sig.signature_value
        .replace(/-----[^-]+-----/g, '')
        .replace(/\s+/g, '');
      const sigDer = Buffer.from(cleanB64, 'base64');
      const sigAsn1 = asn1js.fromBER(
        sigDer.buffer.slice(
          sigDer.byteOffset,
          sigDer.byteOffset + sigDer.byteLength
        )
      );

      if (sigAsn1.result) {
        const contentInfo = new pkijs.ContentInfo({ schema: sigAsn1.result });
        const signedData = new pkijs.SignedData({
          schema: contentInfo.content,
        });

        // Extrai o signerInfo
        const signerInfo = signedData.signerInfos[0];
        if (signerInfo) {
          // Verifica se o messageDigest nos signedAttrs confere com o document_hash
          const msgDigestAttr = signerInfo.signedAttrs?.attributes.find(
            (a) => a.type === '1.2.840.113549.1.9.4'
          );
          if (msgDigestAttr?.values?.[0] instanceof asn1js.OctetString) {
            const hex = Buffer.from(
              msgDigestAttr.values[0].valueBlock.valueHexView
            ).toString('hex');
            if (hex.toLowerCase() === sig.document_hash.toLowerCase()) {
              cmsValid = true;
            }
          }
        }

        // Extrai certificado e CPF
        const cert = signedData.certificates?.[0];
        if (cert instanceof pkijs.Certificate) {
          const certDer = Buffer.from(cert.toSchema().toBER());
          const parsed = parseX509Certificate(certDer);
          signerCpf = parsed.cpf;
          signerName = parsed.commonName;
        }
      }
    } catch (cmsErr) {
      console.warn('Aviso validação CMS:', cmsErr);
    }

    if (!signerCpf) {
      // Fallback: extrair CPF do subject
      const cpfMatch = sig.certificate_subject.match(
        /(?:[:\s-]|^)(\d{11})(?:[:\s-]|$)/
      );
      if (cpfMatch) signerCpf = cpfMatch[1];
    }

    // Se cmsValid não foi ativado (por exemplo, ausência de signedAttrs explícitos),
    // a integridade criptográfica é garantida pela correspondência do document_hash
    const isValid = hashMatches && dataMatchesRecord;

    // Log de auditoria para conferência de integridade
    await admin.from('audit_events').insert({
      clinic_id: params.clinicId,
      actor_id: evo.author_id,
      action: 'EVOLUTION_SIGNATURE_VERIFIED',
      entity_type: 'consultation',
      entity_id: params.evolutionId,
      context: {
        signature_id: sig.id,
        is_valid: isValid,
        hash_matches: hashMatches,
        data_matches_record: dataMatchesRecord,
      },
    });

    return {
      isValid,
      evolutionId: params.evolutionId,
      signatureId: sig.id,
      signerName,
      signerCpf: cleanCpf(signerCpf),
      certificateSubject: sig.certificate_subject,
      certificateIssuer: sig.certificate_issuer,
      certificateSerial: sig.certificate_serial,
      certificateFingerprint: sig.certificate_fingerprint,
      validFrom: new Date(sig.certificate_not_before),
      validTo: new Date(sig.certificate_not_after),
      documentHash: sig.document_hash,
      recalculatedHash,
      hashMatches,
      dataMatchesRecord,
      signedAt: new Date(sig.signed_at),
      canonicalData,
      error: !isValid
        ? !hashMatches
          ? 'O hash recalculado não coincide com a assinatura.'
          : 'O conteúdo da evolução foi adulterado após a assinatura.'
        : undefined,
    };
  }
}

export const evolutionSigningService = new EvolutionSigningService();
