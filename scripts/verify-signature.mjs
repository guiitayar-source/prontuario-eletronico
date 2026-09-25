#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import crypto from 'node:crypto';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';
import utilsPkg from '@signpdf/utils';

const { extractSignature } = utilsPkg;

// Ensure pkijs has WebCrypto engine initialized
try {
  const cryptoEngine = new pkijs.CryptoEngine({
    name: 'NodeJS',
    crypto: globalThis.crypto,
  });
  pkijs.setEngine('NodeJS', cryptoEngine);
} catch {
  // Already initialized
}

function cleanCpf(cpf) {
  if (!cpf) return '';
  return cpf.replace(/\D/g, '').slice(0, 11);
}

function formatCpf(cpf) {
  const cleaned = cleanCpf(cpf);
  if (cleaned.length !== 11) return cleaned || 'Não identificado';
  return cleaned.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}

function extractCpfFromCertificate(x509, derBuffer) {
  if (derBuffer) {
    try {
      const u8 = new Uint8Array(derBuffer.length);
      u8.set(derBuffer);
      const asn1 = asn1js.fromBER(u8.buffer);
      if (asn1.result && asn1.result.valueBlock) {
        const pkiCert = new pkijs.Certificate({ schema: asn1.result });
        if (pkiCert.extensions) {
          const sanExt = pkiCert.extensions.find((ext) => ext.extnID === '2.5.29.17');
          if (sanExt && sanExt.parsedValue) {
            const generalNames = sanExt.parsedValue;
            if (Array.isArray(generalNames.names)) {
              for (const gn of generalNames.names) {
                if (gn.type === 0 && gn.value) {
                  const otherName = gn.value;
                  if (otherName.typeId === '2.16.76.1.3.1') {
                    const val = otherName.value;
                    if (val?.valueBlock?.valueHex) {
                      const str = Buffer.from(val.valueBlock.valueHex).toString('latin1');
                      const candidate = str.slice(8, 19);
                      if (/^\d{11}$/.test(candidate)) return candidate;
                    }
                  }
                }
              }
            }
          }
        }
      }
    } catch {
      // Fallback to CN
    }
  }

  const subjectStr = x509.subject;
  const cnMatch = subjectStr.match(/CN=([^,\n/]+)/i);
  if (cnMatch) {
    const commonName = cnMatch[1].trim();
    const cpfMatch = commonName.match(/(?:[:\s-]|^)(\d{11})(?:[:\s-]|$)/);
    if (cpfMatch) return cpfMatch[1];
  }

  const colonMatch = subjectStr.match(/:(\d{11})/);
  if (colonMatch) return colonMatch[1];

  return null;
}

async function verifyPdf(pdfBuffer) {
  let extracted;
  try {
    extracted = extractSignature(pdfBuffer);
  } catch (err) {
    throw new Error(`O arquivo PDF não contém assinatura digital PAdES válida ou está corrompido: ${err.message}`);
  }

  const calculatedDigestHex = crypto
    .createHash('sha256')
    .update(extracted.signedData)
    .digest('hex');

  const sigDer = Buffer.from(extracted.signature, 'binary');
  const u8 = new Uint8Array(sigDer.length);
  u8.set(sigDer);
  const sigAsn1 = asn1js.fromBER(u8.buffer);

  if (!sigAsn1.result) {
    throw new Error('Falha ao decodificar estrutura ASN.1 da assinatura CMS.');
  }

  const contentInfo = new pkijs.ContentInfo({ schema: sigAsn1.result });
  const signedData = new pkijs.SignedData({ schema: contentInfo.content });

  const certificates = signedData.certificates || [];
  let signerCert;

  const signerInfo = signedData.signerInfos[0];
  if (signerInfo?.sid && certificates.length > 0) {
    const sid = signerInfo.sid;
    if ('serialNumber' in sid && sid.serialNumber) {
      signerCert = certificates.find((c) => {
        if (c instanceof pkijs.Certificate) {
          return c.serialNumber.isEqual(sid.serialNumber);
        }
        return false;
      });
    }
  }

  if (!signerCert && certificates[0] instanceof pkijs.Certificate) {
    signerCert = certificates[0];
  }

  if (!signerCert) {
    throw new Error('Nenhum certificado de signatário encontrado na assinatura CMS.');
  }

  const certDer = Buffer.from(signerCert.toSchema().toBER());
  const x509 = new crypto.X509Certificate(certDer);
  const cpf = extractCpfFromCertificate(x509, certDer);

  const isValid = await signedData.verify({
    signer: 0,
    data: extracted.signedData.buffer.slice(
      extracted.signedData.byteOffset,
      extracted.signedData.byteOffset + extracted.signedData.byteLength
    ),
    trustedCerts: [signerCert],
  });

  return {
    isValid: Boolean(isValid),
    signerName: x509.subject.match(/CN=([^,\n/]+)/i)?.[1]?.trim() || x509.subject,
    signerCpf: cpf,
    subject: x509.subject,
    issuer: x509.issuer,
    serialNumber: x509.serialNumber,
    fingerprint256: x509.fingerprint256,
    validFrom: new Date(x509.validFrom),
    validTo: new Date(x509.validTo),
    calculatedDigestHex,
    byteRange: extracted.ByteRange,
  };
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Uso: node scripts/verify-signature.mjs <caminho-para-documento.pdf>');
    console.error('  ou: npm run verify-signature -- <caminho-para-documento.pdf>');
    process.exit(1);
  }

  const resolvedPath = resolve(process.cwd(), filePath);
  console.log(`\n======================================================`);
  console.log(`  VERIFICADOR DE ASSINATURA DIGITAL ICP-BRASIL (PAdES)`);
  console.log(`======================================================`);
  console.log(`Arquivo: ${resolvedPath}\n`);

  try {
    const pdfBuffer = await readFile(resolvedPath);
    console.log(`Tamanho do arquivo: ${(pdfBuffer.length / 1024).toFixed(2)} KB`);

    const result = await verifyPdf(pdfBuffer);

    console.log(`\n--- RESULTADO DA VERIFICAÇÃO CRIPTOGRÁFICA ---`);
    if (result.isValid) {
      console.log(`\x1b[32m✔ STATUS: ASSINATURA ÍNTEGRA E VÁLIDA (PAdES / SHA-256)\x1b[0m`);
      console.log(`O documento NÃO foi alterado desde a assinatura.`);
    } else {
      console.log(`\x1b[31m✖ STATUS: ASSINATURA INVÁLIDA OU DOCUMENTO ADULTERADO\x1b[0m`);
      console.log(`O hash do conteúdo assinado não corresponde à assinatura criptográfica.`);
    }

    console.log(`\n--- DADOS DO SIGNATÁRIO ---`);
    console.log(`Signatário (CN): ${result.signerName}`);
    console.log(`CPF:             ${formatCpf(result.signerCpf)}`);
    console.log(`Sujeito:         ${result.subject}`);

    console.log(`\n--- CERTIFICADO DIGITAL ---`);
    console.log(`Emissor (AC):    ${result.issuer}`);
    console.log(`Serial:          ${result.serialNumber}`);
    console.log(`Válido de:       ${result.validFrom.toLocaleString('pt-BR')}`);
    console.log(`Válido até:      ${result.validTo.toLocaleString('pt-BR')}`);
    console.log(`Fingerprint 256: ${result.fingerprint256}`);

    console.log(`\n--- DETALHES TÉCNICOS PAdES ---`);
    console.log(`ByteRange:       [${result.byteRange.join(', ')}]`);
    console.log(`Digest SHA-256:  ${result.calculatedDigestHex}`);
    console.log(`======================================================\n`);

    if (!result.isValid) {
      process.exit(1);
    }
  } catch (err) {
    console.error(`\x1b[31mErro na verificação:\x1b[0m ${err.message}\n`);
    process.exit(1);
  }
}

void main();
