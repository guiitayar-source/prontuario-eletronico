import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import {
  ICP_BRASIL_INTERMEDIATES,
  ICP_BRASIL_ROOTS,
} from './icp-brasil-certs.ts';

// Garante motor WebCrypto para pkijs
try {
  pkijs.setEngine(
    'NodeJS',
    new pkijs.CryptoEngine({ name: 'NodeJS', crypto: globalThis.crypto }),
  );
} catch {
  // Engine já configurada
}

export type IcpChainCheck = {
  // A cadeia fecha numa raiz ICP-Brasil fixada, com todos os elos válidos na data.
  valid: boolean;
  // Nomes (CN) do signatário até a raiz, quando a cadeia foi montada.
  path: string[];
  error?: string;
};

function parse(der: Buffer) {
  const asn1 = asn1js.fromBER(
    der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer,
  );
  return new pkijs.Certificate({ schema: asn1.result });
}

let cache: { roots: pkijs.Certificate[]; intermediates: pkijs.Certificate[] } | null =
  null;
function bundle() {
  cache ??= {
    roots: ICP_BRASIL_ROOTS.map((r) => parse(Buffer.from(r.der, 'base64'))),
    intermediates: ICP_BRASIL_INTERMEDIATES.map((d) => parse(Buffer.from(d, 'base64'))),
  };
  return cache;
}

function commonName(cert: pkijs.Certificate) {
  const cn = cert.subject.typesAndValues.find((t) => t.type === '2.5.4.3');
  return cn ? String(cn.value.valueBlock.value) : 'Sem nome';
}

/**
 * Valida a cadeia do certificado do signatário até uma raiz ICP-Brasil fixada,
 * na data informada (a data da assinatura). Não consulta revogação (LCR/OCSP).
 */
export async function validateIcpChain(
  signer: pkijs.Certificate,
  at: Date,
  extraCerts: pkijs.Certificate[] = [],
): Promise<IcpChainCheck> {
  const { roots, intermediates } = bundle();
  // O pkijs remove duplicados e usa o ÚLTIMO certificado da lista como o que será
  // validado; o signatário não pode aparecer antes dele.
  const signerDer = Buffer.from(signer.tbsView);
  const others = [...intermediates, ...extraCerts].filter(
    (c) => !Buffer.from(c.tbsView).equals(signerDer),
  );
  try {
    const engine = new pkijs.CertificateChainValidationEngine({
      trustedCerts: roots,
      certs: [...others, signer],
      checkDate: at,
    });
    const result = await engine.verify();
    const path = (result.certificatePath || []).map(commonName);
    // Defesa extra: o caminho validado precisa começar no próprio signatário.
    const first = result.certificatePath?.[0];
    if (
      result.result &&
      (!first ||
        !first.serialNumber.isEqual(signer.serialNumber) ||
        commonName(first) !== commonName(signer))
    )
      return {
        valid: false,
        path,
        error: 'A cadeia validada não corresponde ao certificado do signatário.',
      };
    if (!result.result)
      return {
        valid: false,
        path,
        error:
          result.resultMessage ||
          'O certificado não pertence a uma cadeia ICP-Brasil reconhecida.',
      };
    return { valid: true, path };
  } catch (e) {
    const message =
      (e as { resultMessage?: string; message?: string })?.resultMessage ||
      (e as { message?: string })?.message;
    return {
      valid: false,
      path: [],
      error: message || 'O certificado não pertence a uma cadeia ICP-Brasil reconhecida.',
    };
  }
}
