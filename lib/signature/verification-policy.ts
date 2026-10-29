// Lote 6F.2C-R: separa o que a verificação PAdES comprova do que cada consumidor pode concluir.
//
// - Integridade criptográfica: bytes cobertos + CMS conferem com a chave do certificado embutido.
// - Identidade do certificado: titular extraído (CPF coerente com o CN, não-AC, keyUsage de assinatura).
//   Só vale como identidade ICP-Brasil quando a cadeia fecha numa raiz fixada (`chainTrusted`).
// - Confiança plena: `status === 'VALID'` (cadeia, tempo/POE e revogação comprovados).
// - Autorização de emissão: integridade + identidade + nenhuma prova de invalidade ou de revogação
//   conhecida da cadeia do signatário. NÃO exige confiança plena enquanto não houver evidência
//   CRL/OCSP operacional (ver docs/auditorias/6f2c/CORRECAO-6F2C-R.md).
// - Estado persistido: VALID só com confiança plena; INVALID só com prova de invalidade;
//   qualquer INDETERMINATE vira UNVERIFIED.
import type {
  PadesRevocationResult,
  PadesVerificationResult,
  SignatureAssessment,
  VerificationGlobalStatus,
  VerificationStatus,
} from './types.ts';

const SIGNER_CHAIN_ROLES = new Set(['SIGNER', 'SIGNER_CA']);
const REVOKED_STATUSES = new Set([
  'REVOKED_BEFORE_POE',
  'REVOKED_NO_POE',
  'CERTIFICATE_HOLD',
]);

/** Evidência autêntica de revogação ou suspensão de algum certificado da cadeia do signatário. */
export function hasKnownSignerRevocation(
  revocation: PadesRevocationResult,
): boolean {
  if (
    revocation.status === 'REVOKED_BEFORE_POE' ||
    revocation.status === 'REVOKED_NO_POE'
  )
    return true;
  if (
    revocation.isHold &&
    (!revocation.revokedCertificateRole ||
      SIGNER_CHAIN_ROLES.has(revocation.revokedCertificateRole))
  )
    return true;
  return (revocation.certificateResults ?? []).some(
    (r) => SIGNER_CHAIN_ROLES.has(r.role) && REVOKED_STATUSES.has(r.status),
  );
}

export function persistenceStatusFor(
  status: VerificationGlobalStatus,
): VerificationStatus {
  return status === 'VALID'
    ? 'VALID'
    : status === 'INVALID'
      ? 'INVALID'
      : 'UNVERIFIED';
}

export function assessSignature(
  result: Pick<
    PadesVerificationResult,
    | 'status'
    | 'cryptographicIntegrity'
    | 'signerIdentity'
    | 'chainValidation'
    | 'rootTrust'
    | 'revocation'
  >,
): SignatureAssessment {
  const knownRevocation = hasKnownSignerRevocation(result.revocation);
  const signerIdentity =
    result.signerIdentity.extracted &&
    result.signerIdentity.cpfMatchesCommonName &&
    result.signerIdentity.keyUsageValid &&
    !result.signerIdentity.isCa;
  const chainTrusted = result.chainValidation.valid && result.rootTrust.trusted;
  const fullTrust = result.status === 'VALID';
  const rejected = result.status === 'INVALID' || knownRevocation;

  let issuanceBlockReason: string | undefined;
  if (!result.cryptographicIntegrity)
    issuanceBlockReason = 'Integridade criptográfica não comprovada.';
  else if (result.status === 'INVALID')
    issuanceBlockReason =
      'A verificação comprovou que a assinatura é inválida.';
  else if (knownRevocation)
    issuanceBlockReason =
      'Há evidência autêntica de revogação ou suspensão na cadeia do signatário.';
  else if (!signerIdentity)
    issuanceBlockReason =
      'Identidade do titular do certificado não confirmada.';

  return {
    cryptographicIntegrity: result.cryptographicIntegrity,
    signerIdentity,
    chainTrusted,
    fullTrust,
    knownRevocation,
    rejected,
    issuanceAllowed: !issuanceBlockReason,
    issuanceBlockReason,
    persistenceStatus: persistenceStatusFor(result.status),
  };
}
