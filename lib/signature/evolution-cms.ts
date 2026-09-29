import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import { parseX509Certificate } from './crypto-utils.ts';
import type { CertificateInfo } from './types.ts';
import { validateIcpChain, type IcpChainCheck } from './icp-chain.ts';

// Garante motor WebCrypto para pkijs
try {
  pkijs.setEngine(
    'NodeJS',
    new pkijs.CryptoEngine({ name: 'NodeJS', crypto: globalThis.crypto }),
  );
} catch {
  // Engine já configurada
}

export type EvolutionCmsCheck = {
  // A assinatura RSA/ECDSA sobre os atributos assinados confere com a chave
  // pública do certificado do signatário.
  signatureValid: boolean;
  // O messageDigest assinado é o SHA-256 dos dados canônicos informados.
  digestMatches: boolean;
  certificate: CertificateInfo | null;
  // Cadeia até a raiz ICP-Brasil na data informada (só quando `at` é passado).
  chain?: IcpChainCheck;
  error?: string;
};

const toArrayBuffer = (b: Buffer) =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/**
 * Verifica criptograficamente uma assinatura CMS destacada de evolução clínica:
 * confirma que o certificado embutido assinou exatamente estes dados canônicos.
 * Com `at`, também valida a cadeia do certificado até a raiz ICP-Brasil nessa data.
 */
export async function verifyEvolutionCms(
  cmsBase64: string,
  canonicalJson: string,
  expectedHashHex: string,
  at?: Date,
): Promise<EvolutionCmsCheck> {
  const fail = (error: string, certificate: CertificateInfo | null = null) => ({
    signatureValid: false,
    digestMatches: false,
    certificate,
    error,
  });
  let signedData: pkijs.SignedData;
  try {
    const der = Buffer.from(
      cmsBase64.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
      'base64',
    );
    const asn1 = asn1js.fromBER(toArrayBuffer(der));
    if (asn1.offset === -1) return fail('Assinatura CMS com estrutura ASN.1 inválida.');
    const contentInfo = new pkijs.ContentInfo({ schema: asn1.result });
    signedData = new pkijs.SignedData({ schema: contentInfo.content });
  } catch {
    return fail('Não foi possível decodificar a assinatura CMS.');
  }

  const signerInfo = signedData.signerInfos[0];
  const certificates = (signedData.certificates || []).filter(
    (c): c is pkijs.Certificate => c instanceof pkijs.Certificate,
  );
  const sid = signerInfo?.sid;
  const signerCert =
    sid instanceof pkijs.IssuerAndSerialNumber
      ? certificates.find((c) => c.serialNumber.isEqual(sid.serialNumber))
      : undefined;
  if (!signerInfo || !signerCert)
    return fail('Certificado do signatário ausente na assinatura CMS.');
  const certificate = parseX509Certificate(
    Buffer.from(signerCert.toSchema().toBER()),
  );

  let digestMatches = false;
  const digestAttr = signerInfo.signedAttrs?.attributes.find(
    (a) => a.type === '1.2.840.113549.1.9.4',
  );
  const digestValue = digestAttr?.values?.[0];
  if (digestValue instanceof asn1js.OctetString) {
    digestMatches =
      Buffer.from(digestValue.valueBlock.valueHexView)
        .toString('hex')
        .toLowerCase() === expectedHashHex.toLowerCase();
  }
  if (!digestMatches)
    return {
      ...fail('O resumo assinado não corresponde aos dados da evolução.', certificate),
    };

  try {
    const result = await signedData.verify({
      signer: 0,
      data: toArrayBuffer(Buffer.from(canonicalJson, 'utf8')),
      checkChain: false,
      extendedMode: true,
    });
    if (!result.signatureVerified)
      return {
        ...fail(
          'A assinatura criptográfica não confere com o certificado do signatário.',
          certificate,
        ),
        digestMatches,
      };
    const chain = at
      ? await validateIcpChain(signerCert, at, certificates)
      : undefined;
    return { signatureValid: true, digestMatches, certificate, chain };
  } catch (e) {
    const message =
      (e as { message?: string })?.message ||
      'A assinatura criptográfica não confere com o certificado do signatário.';
    return { ...fail(message, certificate), digestMatches };
  }
}
