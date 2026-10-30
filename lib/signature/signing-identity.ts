import { HttpError } from '../supabase/server.ts';
import type { ClinicalDocument } from '../document-fields.ts';
import type { PadesVerificationResult } from './types.ts';
import { parseX509Certificate } from './crypto-utils.ts';

export type SigningActor = { clinicId: string; userId: string };
type AuthoredDocument = ClinicalDocument & { clinic_id?: string };
export class SigningIdentityError extends HttpError {
  readonly reason: string;
  constructor(reason: string, status = 403) {
    super(status, status === 409
      ? 'Assinatura pendente de reconciliação: a identidade ou a versão não pôde ser confirmada. Não repita a assinatura.'
      : 'Identidade ou autoria incompatível com a assinatura. Confira seu perfil e conecte novamente o certificado.');
    this.reason = reason;
  }
}

// Sem truncamento nem fallback para CPF declarado pelo provedor ou frontend.
export function signingCpf(value: unknown): string | null {
  if (typeof value !== 'string' || !/^(?:\d{11}|\d{3}\.\d{3}\.\d{3}-\d{2})$/.test(value)) return null;
  const digits = value.replace(/[.-]/g, '');
  if (/^(\d)\1{10}$/.test(digits)) return null;
  for (const length of [9, 10]) {
    const remainder = digits.slice(0, length).split('').reduce((sum, digit, i) => sum + Number(digit) * (length + 1 - i), 0) % 11;
    if (Number(digits[length]) !== (remainder < 2 ? 0 : 11 - remainder)) return null;
  }
  return digits;
}

// Não há delegação/coassinatura de clinical_documents registrada no esquema atual.
// Propriedade da clínica ou papel de owner não substituem a autoria.
export function assertDocumentSigningAuthor(actor: SigningActor, doc: AuthoredDocument) {
  if (!doc.id || doc.clinic_id !== actor.clinicId || doc.author_id !== actor.userId)
    throw new SigningIdentityError('document_author_mismatch');
  if (!Number.isInteger(doc.version) || doc.version < 1)
    throw new SigningIdentityError('document_version_invalid');
}

export type SigningAuthorization = SigningActor & {
  documentId: string;
  documentVersion: number;
  sessionId: string;
  cpf: string;
  certificateFingerprint: string;
};
export function authorizeSigningIdentity(
  actor: SigningActor,
  doc: AuthoredDocument,
  session: { id: string; clinic_id: string; user_id: string; cpf: unknown; certificate_raw?: string | null; revoked: boolean; expires_at: string },
  profile: { cpf?: unknown; physician_registration?: string } | null,
): SigningAuthorization {
  assertDocumentSigningAuthor(actor, doc);
  const cpf = signingCpf(profile?.cpf);
  if (!cpf || cpf !== signingCpf(session.cpf)) throw new SigningIdentityError('session_profile_identity_mismatch');
  if (!session.id || session.clinic_id !== actor.clinicId || session.user_id !== actor.userId || session.revoked !== false ||
      !Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= Date.now())
    throw new SigningIdentityError('session_identity_unavailable');
  if (!profile?.physician_registration?.trim() || profile.physician_registration !== doc.physician_registration)
    throw new SigningIdentityError('prescriber_registration_mismatch');
  let certificate;
  try {
    if (!session.certificate_raw) throw new Error();
    certificate = parseX509Certificate(session.certificate_raw);
  } catch {
    throw new SigningIdentityError('authorized_certificate_unavailable');
  }
  if (signingCpf(certificate.cpf) !== cpf) throw new SigningIdentityError('authorized_certificate_identity_mismatch');
  return { ...actor, documentId: doc.id, documentVersion: doc.version, sessionId: session.id, cpf, certificateFingerprint: certificate.fingerprint256 };
}

export function assertSigningCertificate(authorization: SigningAuthorization, verification: PadesVerificationResult) {
  if (!verification.assessment.issuanceAllowed || verification.certificateFingerprint !== authorization.certificateFingerprint ||
      signingCpf(verification.signerCpf) !== authorization.cpf)
    throw new SigningIdentityError('certificate_identity_mismatch', 409);
  // A correspondência de identidade não atesta confiança plena (cadeia + revogação comprovada):
  // `issuanceAllowed` só exclui invalidade provada e revogação conhecida; o banco grava UNVERIFIED.
}

export function assertAuthorizedDocumentVersion(authorization: SigningAuthorization, doc: AuthoredDocument | null) {
  if (!doc || doc.id !== authorization.documentId || doc.version !== authorization.documentVersion ||
      doc.clinic_id !== authorization.clinicId || doc.author_id !== authorization.userId || doc.status !== 'SIGNING')
    throw new SigningIdentityError('document_version_changed', 409);
}
