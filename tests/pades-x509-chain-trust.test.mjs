import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';

import { PadesService } from '../lib/signature/pades-service.ts';

const padesService = new PadesService();

try {
  pkijs.setEngine(
    'NodeJS',
    new pkijs.CryptoEngine({ name: 'NodeJS', crypto: globalThis.crypto }),
  );
} catch {
  // Engine already initialized
}

const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_EXTENDED_KEY_USAGE = '2.5.29.37';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_ICP_BRASIL_PF_DATA = '2.16.76.1.3.1';
const OID_CONTENT_TYPE = '1.2.840.113549.1.9.3';
const OID_DATA = '1.2.840.113549.1.7.1';
const OID_SIGNING_TIME = '1.2.840.113549.1.9.5';
const OID_MESSAGE_DIGEST = '1.2.840.113549.1.9.4';
const OID_SIGNING_CERTIFICATE_V2 = '1.2.840.113549.1.9.16.2.47';
const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_RSA_SHA256 = '1.2.840.113549.1.1.11';
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';

async function createSampleUnsignedPdf(text = 'Receituario Medico - Lote 6F.2A') {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 50, y: 760, size: 14, font });
  return Buffer.from(await doc.save());
}

async function generateRsaKeyPair() {
  return crypto.webcrypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
}

function buildRdn(cn, org = 'ICP-Brasil Synthetic Test', country = 'BR') {
  const rdn = new pkijs.RelativeDistinguishedNames();
  rdn.typesAndValues.push(
    new pkijs.AttributeTypeAndValue({
      type: '2.5.4.6',
      value: new asn1js.PrintableString({ value: country }),
    }),
    new pkijs.AttributeTypeAndValue({
      type: '2.5.4.10',
      value: new asn1js.Utf8String({ value: org }),
    }),
    new pkijs.AttributeTypeAndValue({
      type: '2.5.4.3',
      value: new asn1js.Utf8String({ value: cn }),
    }),
  );
  return rdn;
}

function buildBasicConstraintsExtension({ cA, pathLenConstraint = null, critical = true }) {
  const value = [new asn1js.Boolean({ value: Boolean(cA) })];
  if (pathLenConstraint !== null && pathLenConstraint !== undefined) {
    value.push(new asn1js.Integer({ value: pathLenConstraint }));
  }
  const seq = new asn1js.Sequence({ value });
  return new pkijs.Extension({
    extnID: OID_BASIC_CONSTRAINTS,
    critical,
    extnValue: seq.toBER(false),
  });
}

/**
 * Bits per RFC 5280 §4.2.1.3:
 * 0: digitalSignature (0x80)
 * 1: nonRepudiation (0x40)
 * 2: keyEncipherment (0x20)
 * 5: keyCertSign (0x04)
 * 6: cRLSign (0x02)
 */
function buildKeyUsageExtension({
  digitalSignature = false,
  nonRepudiation = false,
  keyEncipherment = false,
  keyCertSign = false,
  cRLSign = false,
  critical = true,
}) {
  let byte0 = 0;
  if (digitalSignature) byte0 |= 0x80;
  if (nonRepudiation) byte0 |= 0x40;
  if (keyEncipherment) byte0 |= 0x20;
  if (keyCertSign) byte0 |= 0x04;
  if (cRLSign) byte0 |= 0x02;

  let unusedBits = 0;
  if (byte0 !== 0) {
    while (unusedBits < 7 && (byte0 & (1 << unusedBits)) === 0) {
      unusedBits += 1;
    }
  }

  const bitString = new asn1js.BitString({
    valueHex: new Uint8Array([byte0]).buffer,
    unusedBits,
  });

  return new pkijs.Extension({
    extnID: OID_KEY_USAGE,
    critical,
    extnValue: bitString.toBER(false),
  });
}

function buildExtendedKeyUsageExtension(oids, critical = false) {
  const seq = new asn1js.Sequence({
    value: oids.map((oid) => new asn1js.ObjectIdentifier({ value: oid })),
  });
  return new pkijs.Extension({
    extnID: OID_EXTENDED_KEY_USAGE,
    critical,
    extnValue: seq.toBER(false),
  });
}

function buildIcpBrasilSanExtension(cpf11Digits) {
  // ICP-Brasil 2.16.76.1.3.1: 8 chars birth date (DDMMYYYY) + 11 chars CPF + zeros
  const contentStr = `01011980${cpf11Digits}${'0'.repeat(26)}`;
  const rawBytes = Buffer.from(contentStr, 'latin1');

  const otherNameSeq = new asn1js.Sequence({
    value: [
      new asn1js.ObjectIdentifier({ value: OID_ICP_BRASIL_PF_DATA }),
      new asn1js.Constructed({
        idBlock: { tagClass: 3, tagNumber: 0 },
        value: [new asn1js.OctetString({ valueHex: new Uint8Array(rawBytes).buffer })],
      }),
    ],
  });
  // GeneralName [0] IMPLICIT OtherName
  otherNameSeq.idBlock.tagClass = 3;
  otherNameSeq.idBlock.tagNumber = 0;

  const generalNamesSeq = new asn1js.Sequence({
    value: [otherNameSeq],
  });

  return new pkijs.Extension({
    extnID: OID_SUBJECT_ALT_NAME,
    critical: false,
    extnValue: generalNamesSeq.toBER(false),
  });
}

/**
 * Creates a synthetic X.509 certificate signed by `signingPrivateKey`.
 */
async function createSyntheticCertificate({
  serialNumber = 1,
  subjectCn,
  subjectOrg = 'ICP-Brasil Synthetic Test',
  issuerCert = null,
  subjectKeyPair,
  signingPrivateKey = null,
  notBefore = new Date('2025-01-01T00:00:00Z'),
  notAfter = new Date('2028-01-01T00:00:00Z'),
  extensions = [],
}) {
  const cert = new pkijs.Certificate();
  cert.version = 2; // v3
  cert.serialNumber = new asn1js.Integer({ value: serialNumber });

  const subjectRdn = buildRdn(subjectCn, subjectOrg);
  cert.subject = subjectRdn;
  cert.issuer = issuerCert ? issuerCert.subject : subjectRdn;

  cert.notBefore.value = notBefore;
  cert.notAfter.value = notAfter;
  cert.extensions = extensions;

  await cert.subjectPublicKeyInfo.importKey(subjectKeyPair.publicKey);
  await cert.sign(signingPrivateKey || subjectKeyPair.privateKey, 'SHA-256');

  const der = Buffer.from(cert.toSchema().toBER());
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;

  return { cert, der, pem, keyPair: subjectKeyPair };
}

/**
 * Signs a prepared PDF digest with the given `signerCert` and `signerPrivateKey`,
 * embedding `cmsCertificates` in `SignedData.certificates`.
 */
async function signPdfWithCustomPki({
  unsignedPdfBuffer,
  signerCert,
  signerPrivateKey,
  cmsCertificates = [signerCert],
  signingTime = new Date('2026-06-15T12:00:00Z'),
}) {
  const prepared = await padesService.preparePdfForSignature(unsignedPdfBuffer, {
    signerName: 'DR TESTE CADEIA X509',
    signerCpf: '34929144892',
    doctorCrm: '123456-SP',
  });

  const hashBuffer = Buffer.from(prepared.digestHex, 'hex');
  const signerCertDer = Buffer.from(signerCert.toSchema().toBER());
  const certHashSha256 = crypto.createHash('sha256').update(signerCertDer).digest();

  const essCertIdV2 = new asn1js.Sequence({
    value: [
      new asn1js.OctetString({ valueHex: new Uint8Array(certHashSha256).buffer }),
    ],
  });
  const signingCertificateV2Value = new asn1js.Sequence({
    value: [new asn1js.Sequence({ value: [essCertIdV2] })],
  });

  const signedAttrs = new pkijs.SignedAndUnsignedAttributes({
    type: 0,
    attributes: [
      new pkijs.Attribute({
        type: OID_CONTENT_TYPE,
        values: [new asn1js.ObjectIdentifier({ value: OID_DATA })],
      }),
      new pkijs.Attribute({
        type: OID_SIGNING_TIME,
        values: [new asn1js.UTCTime({ valueDate: signingTime })],
      }),
      new pkijs.Attribute({
        type: OID_MESSAGE_DIGEST,
        values: [new asn1js.OctetString({ valueHex: new Uint8Array(hashBuffer).buffer })],
      }),
      new pkijs.Attribute({
        type: OID_SIGNING_CERTIFICATE_V2,
        values: [signingCertificateV2Value],
      }),
    ],
  });

  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({
      issuer: signerCert.issuer,
      serialNumber: signerCert.serialNumber,
    }),
    digestAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID_SHA256 }),
    signatureAlgorithm: new pkijs.AlgorithmIdentifier({
      algorithmId: OID_RSA_SHA256,
      algorithmParams: new asn1js.Null(),
    }),
    signedAttrs,
  });

  const signedData = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID_DATA }),
    digestAlgorithms: [new pkijs.AlgorithmIdentifier({ algorithmId: OID_SHA256 })],
    certificates: cmsCertificates,
    signerInfos: [signerInfo],
  });

  await signedData.sign(
    signerPrivateKey,
    0,
    'SHA-256',
    new Uint8Array(prepared.contentToSign).buffer,
  );

  const contentInfo = new pkijs.ContentInfo({
    contentType: OID_SIGNED_DATA,
    content: signedData.toSchema(true),
  });

  const cmsDer = Buffer.from(contentInfo.toSchema().toBER());
  return padesService.embedSignature(prepared, cmsDer.toString('base64'));
}

describe('Lote 6F.2A — Validação da Cadeia X.509 e Âncoras de Confiança', () => {
  it('1. valida cadeia correta até raiz confiável configurada (preservando status global INDETERMINATE)', async () => {
    const rootKeys = await generateRsaKeyPair();
    const interKeys = await generateRsaKeyPair();
    const signerKeys = await generateRsaKeyPair();

    const root = await createSyntheticCertificate({
      serialNumber: 100,
      subjectCn: 'AC Raiz Sintetica Confiavel v1',
      subjectKeyPair: rootKeys,
      extensions: [
        buildBasicConstraintsExtension({ cA: true, pathLenConstraint: 2 }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });

    const intermediate = await createSyntheticCertificate({
      serialNumber: 200,
      subjectCn: 'AC Intermediaria Sintetica v1',
      issuerCert: root.cert,
      subjectKeyPair: interKeys,
      signingPrivateKey: rootKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: true, pathLenConstraint: 0 }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });

    const signer = await createSyntheticCertificate({
      serialNumber: 300,
      subjectCn: 'DR GUILHERME TAYAR:34929144892',
      issuerCert: intermediate.cert,
      subjectKeyPair: signerKeys,
      signingPrivateKey: interKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false, critical: false }),
        buildKeyUsageExtension({ digitalSignature: true, nonRepudiation: true }),
        buildExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.2', '1.3.6.1.5.5.7.3.4']),
        buildIcpBrasilSanExtension('34929144892'),
      ],
    });

    const unsignedPdf = await createSampleUnsignedPdf();
    const signedPdf = await signPdfWithCustomPki({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: signer.cert,
      signerPrivateKey: signerKeys.privateKey,
      cmsCertificates: [signer.cert], // Intermediate injected via options to test injection
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [root.pem],
      intermediatePems: [intermediate.pem],
      verificationTime: new Date('2026-06-15T12:00:05Z'),
    });

    assert.equal(res.pdfIntegrity.valid, true);
    assert.equal(res.cmsIntegrity.valid, true);
    assert.equal(res.cryptographicIntegrity, true);

    assert.equal(res.signerIdentity.extracted, true);
    assert.equal(res.signerIdentity.cpf, '34929144892');
    assert.equal(res.signerIdentity.cpfMatchesCommonName, true);
    assert.equal(res.signerIdentity.isCa, false);
    assert.equal(res.signerIdentity.keyUsageValid, true);

    assert.equal(res.chainValidation.status, 'VALID');
    assert.equal(res.chainValidation.valid, true);
    assert.equal(res.chainValidation.isSelfSigned, false);
    assert.equal(res.chainValidation.chainLength, 3);

    assert.equal(res.rootTrust.trusted, true);
    assert.ok(res.rootTrust.rootSubject?.includes('AC Raiz Sintetica Confiavel v1'));
    assert.ok(res.rootTrust.rootFingerprint256);

    // Requirement 8: Global status MUST remain INDETERMINATE while revocation is not checked
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.subIndication, 'REVOCATION_UNAVAILABLE');
    assert.equal(res.persistenceStatus, 'UNVERIFIED');
    assert.equal(res.certificateTrust, false);
    assert.equal(res.isTrusted, false);
  });

  it('2. classifica certificado autoassinado sem confiança como SELF_SIGNED e global INDETERMINATE', async () => {
    const selfKeys = await generateRsaKeyPair();
    const selfCert = await createSyntheticCertificate({
      serialNumber: 1,
      subjectCn: 'DR AUTOASSINADO:34929144892',
      subjectKeyPair: selfKeys,
      extensions: [
        buildBasicConstraintsExtension({ cA: false, critical: false }),
        buildKeyUsageExtension({ digitalSignature: true, nonRepudiation: true }),
      ],
    });

    const unsignedPdf = await createSampleUnsignedPdf();
    const signedPdf = await signPdfWithCustomPki({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: selfCert.cert,
      signerPrivateKey: selfKeys.privateKey,
      cmsCertificates: [selfCert.cert],
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      verificationTime: new Date('2026-06-15T12:00:05Z'),
    });

    assert.equal(res.cryptographicIntegrity, true);
    assert.equal(res.chainValidation.status, 'SELF_SIGNED');
    assert.equal(res.chainValidation.valid, false);
    assert.equal(res.chainValidation.isSelfSigned, true);
    assert.equal(res.rootTrust.trusted, false);
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.subIndication, 'NO_CERTIFICATE_CHAIN_FOUND_SELF_SIGNED');
    assert.equal(res.isTrusted, false);
  });

  it('3. rejeita raiz não autorizada embutida no CMS (UNTRUSTED_ROOT) e bloqueia raiz personalizada em produção sem política explícita', async () => {
    const untrustedRootKeys = await generateRsaKeyPair();
    const authorizedRootKeys = await generateRsaKeyPair();
    const interKeys = await generateRsaKeyPair();
    const signerKeys = await generateRsaKeyPair();

    const untrustedRoot = await createSyntheticCertificate({
      serialNumber: 10,
      subjectCn: 'AC Raiz Nao Autorizada v1',
      subjectKeyPair: untrustedRootKeys,
      extensions: [
        buildBasicConstraintsExtension({ cA: true }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });

    const authorizedRoot = await createSyntheticCertificate({
      serialNumber: 11,
      subjectCn: 'AC Raiz Autorizada Oficial v1',
      subjectKeyPair: authorizedRootKeys,
      extensions: [
        buildBasicConstraintsExtension({ cA: true }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });

    const intermediate = await createSyntheticCertificate({
      serialNumber: 20,
      subjectCn: 'AC Intermediaria Subordinada v1',
      issuerCert: untrustedRoot.cert,
      subjectKeyPair: interKeys,
      signingPrivateKey: untrustedRootKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: true }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });

    const signer = await createSyntheticCertificate({
      serialNumber: 30,
      subjectCn: 'DR MEDICO:34929144892',
      issuerCert: intermediate.cert,
      subjectKeyPair: signerKeys,
      signingPrivateKey: interKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ digitalSignature: true, nonRepudiation: true }),
      ],
    });

    const unsignedPdf = await createSampleUnsignedPdf();
    // Requirement 6: Embed the entire chain INCLUDING untrustedRoot inside the CMS SignedData
    const signedPdf = await signPdfWithCustomPki({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: signer.cert,
      signerPrivateKey: signerKeys.privateKey,
      cmsCertificates: [signer.cert, intermediate.cert, untrustedRoot.cert],
    });

    // Presence of untrustedRoot inside CMS MUST NOT make it trusted!
    const resUntrusted = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [authorizedRoot.pem],
      verificationTime: new Date('2026-06-15T12:00:05Z'),
    });

    assert.equal(resUntrusted.cryptographicIntegrity, true);
    assert.equal(resUntrusted.chainValidation.status, 'UNTRUSTED_ROOT');
    assert.equal(resUntrusted.chainValidation.valid, false);
    assert.equal(resUntrusted.rootTrust.trusted, false);
    assert.ok(resUntrusted.rootTrust.rootSubject?.includes('AC Raiz Nao Autorizada v1'));
    assert.equal(resUntrusted.status, 'INDETERMINATE');
    assert.equal(resUntrusted.subIndication, 'UNTRUSTED_ROOT_CA');
    assert.equal(resUntrusted.isTrusted, false);

    // Requirement 7: In production, passing a custom root without allowCustomTrustAnchors: true MUST fail as INVALID
    const prevNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const resProdBlocked = await padesService.verifyPadesSignature(signedPdf, {
        trustedRootPems: [untrustedRoot.pem],
        verificationTime: new Date('2026-06-15T12:00:05Z'),
      });
      assert.equal(resProdBlocked.chainValidation.status, 'INVALID');
      assert.equal(resProdBlocked.rootTrust.trusted, false);
      assert.equal(resProdBlocked.status, 'INVALID');
      assert.equal(
        resProdBlocked.subIndication,
        'CUSTOM_TRUST_ANCHOR_FORBIDDEN_IN_PRODUCTION',
      );
      assert.equal(resProdBlocked.isValid, false);

      // With explicit policy allowCustomTrustAnchors: true, the custom root is accepted
      const resProdAllowed = await padesService.verifyPadesSignature(signedPdf, {
        trustedRootPems: [untrustedRoot.pem],
        allowCustomTrustAnchors: true,
        verificationTime: new Date('2026-06-15T12:00:05Z'),
      });
      assert.equal(resProdAllowed.chainValidation.status, 'VALID');
      assert.equal(resProdAllowed.rootTrust.trusted, true);
      assert.equal(resProdAllowed.status, 'INDETERMINATE');
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it('4. classifica cadeia com intermediária ausente como INCOMPLETE_CHAIN', async () => {
    const rootKeys = await generateRsaKeyPair();
    const interKeys = await generateRsaKeyPair();
    const signerKeys = await generateRsaKeyPair();

    const root = await createSyntheticCertificate({
      serialNumber: 1,
      subjectCn: 'AC Raiz Sintetica v1',
      subjectKeyPair: rootKeys,
      extensions: [
        buildBasicConstraintsExtension({ cA: true }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });

    const intermediate = await createSyntheticCertificate({
      serialNumber: 2,
      subjectCn: 'AC Intermediaria Ausente v1',
      issuerCert: root.cert,
      subjectKeyPair: interKeys,
      signingPrivateKey: rootKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: true }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });

    const signer = await createSyntheticCertificate({
      serialNumber: 3,
      subjectCn: 'DR MEDICO:34929144892',
      issuerCert: intermediate.cert,
      subjectKeyPair: signerKeys,
      signingPrivateKey: interKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ digitalSignature: true, nonRepudiation: true }),
      ],
    });

    const unsignedPdf = await createSampleUnsignedPdf();
    // Embed ONLY signer.cert, omitting intermediate.cert
    const signedPdf = await signPdfWithCustomPki({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: signer.cert,
      signerPrivateKey: signerKeys.privateKey,
      cmsCertificates: [signer.cert],
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [root.pem],
      verificationTime: new Date('2026-06-15T12:00:05Z'),
    });

    assert.equal(res.cryptographicIntegrity, true);
    assert.equal(res.chainValidation.status, 'INCOMPLETE_CHAIN');
    assert.equal(res.chainValidation.valid, false);
    assert.equal(res.chainValidation.chainLength, 1);
    assert.equal(res.rootTrust.trusted, false);
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.subIndication, 'INCOMPLETE_CERTIFICATE_CHAIN');
    assert.equal(res.isTrusted, false);
  });

  it('5. rejeita assinatura de certificado falsificada (tanto no certificado final quanto na intermediária) como INVALID', async () => {
    const rootKeys = await generateRsaKeyPair();
    const interKeys = await generateRsaKeyPair();
    const attackerKeys = await generateRsaKeyPair();
    const signerKeys = await generateRsaKeyPair();

    const root = await createSyntheticCertificate({
      serialNumber: 1,
      subjectCn: 'AC Raiz Confiavel v1',
      subjectKeyPair: rootKeys,
      extensions: [
        buildBasicConstraintsExtension({ cA: true }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });

    const intermediate = await createSyntheticCertificate({
      serialNumber: 2,
      subjectCn: 'AC Intermediaria Legitima v1',
      issuerCert: root.cert,
      subjectKeyPair: interKeys,
      signingPrivateKey: rootKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: true }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });

    // Signer claims issuer = intermediate.cert, but its X.509 signature was signed by attackerKeys!
    const forgedSigner = await createSyntheticCertificate({
      serialNumber: 3,
      subjectCn: 'DR FALSIFICADO:34929144892',
      issuerCert: intermediate.cert,
      subjectKeyPair: signerKeys,
      signingPrivateKey: attackerKeys.privateKey, // Forged!
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ digitalSignature: true, nonRepudiation: true }),
      ],
    });

    const unsignedPdf = await createSampleUnsignedPdf();
    const signedPdfForgedLeaf = await signPdfWithCustomPki({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: forgedSigner.cert,
      signerPrivateKey: signerKeys.privateKey,
      cmsCertificates: [forgedSigner.cert, intermediate.cert],
    });

    const resLeaf = await padesService.verifyPadesSignature(signedPdfForgedLeaf, {
      trustedRootPems: [root.pem],
      verificationTime: new Date('2026-06-15T12:00:05Z'),
    });

    assert.equal(resLeaf.chainValidation.status, 'INVALID');
    assert.equal(resLeaf.chainValidation.valid, false);
    assert.equal(resLeaf.rootTrust.trusted, false);
    assert.equal(resLeaf.status, 'INVALID');
    assert.equal(resLeaf.subIndication, 'CERT_SIGNATURE_INVALID');
    assert.equal(resLeaf.persistenceStatus, 'INVALID');
    assert.equal(resLeaf.isValid, false);

    // Also test a forged intermediate claiming issuer = root.cert but signed by attackerKeys
    const forgedIntermediate = await createSyntheticCertificate({
      serialNumber: 22,
      subjectCn: 'AC Intermediaria Falsificada v1',
      issuerCert: root.cert,
      subjectKeyPair: interKeys,
      signingPrivateKey: attackerKeys.privateKey, // Forged!
      extensions: [
        buildBasicConstraintsExtension({ cA: true }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });

    const signerUnderForgedInter = await createSyntheticCertificate({
      serialNumber: 33,
      subjectCn: 'DR SUBORDINADO:34929144892',
      issuerCert: forgedIntermediate.cert,
      subjectKeyPair: signerKeys,
      signingPrivateKey: interKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ digitalSignature: true, nonRepudiation: true }),
      ],
    });

    const signedPdfForgedInter = await signPdfWithCustomPki({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: signerUnderForgedInter.cert,
      signerPrivateKey: signerKeys.privateKey,
      cmsCertificates: [signerUnderForgedInter.cert, forgedIntermediate.cert],
    });

    const resInter = await padesService.verifyPadesSignature(signedPdfForgedInter, {
      trustedRootPems: [root.pem],
      verificationTime: new Date('2026-06-15T12:00:05Z'),
    });

    assert.equal(resInter.chainValidation.status, 'INVALID');
    assert.equal(resInter.status, 'INVALID');
    assert.equal(resInter.subIndication, 'CERT_SIGNATURE_INVALID');
    assert.equal(resInter.isValid, false);
  });

  it('6. rejeita emissor sem permissão de CA (BasicConstraints cA=false ou ausente) como INVALID', async () => {
    const rootKeys = await generateRsaKeyPair();
    const nonCaIssuerKeys = await generateRsaKeyPair();
    const signerKeys = await generateRsaKeyPair();

    const root = await createSyntheticCertificate({
      serialNumber: 1,
      subjectCn: 'AC Raiz Confiavel v1',
      subjectKeyPair: rootKeys,
      extensions: [
        buildBasicConstraintsExtension({ cA: true }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });

    // Intermediate has cA: false!
    const nonCaIntermediate = await createSyntheticCertificate({
      serialNumber: 2,
      subjectCn: 'Entidade Sem Permissao de CA',
      issuerCert: root.cert,
      subjectKeyPair: nonCaIssuerKeys,
      signingPrivateKey: rootKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ keyCertSign: true, digitalSignature: true }),
      ],
    });

    const signer = await createSyntheticCertificate({
      serialNumber: 3,
      subjectCn: 'DR MEDICO:34929144892',
      issuerCert: nonCaIntermediate.cert,
      subjectKeyPair: signerKeys,
      signingPrivateKey: nonCaIssuerKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ digitalSignature: true, nonRepudiation: true }),
      ],
    });

    const unsignedPdf = await createSampleUnsignedPdf();
    const signedPdf = await signPdfWithCustomPki({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: signer.cert,
      signerPrivateKey: signerKeys.privateKey,
      cmsCertificates: [signer.cert, nonCaIntermediate.cert],
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [root.pem],
      verificationTime: new Date('2026-06-15T12:00:05Z'),
    });

    assert.equal(res.chainValidation.status, 'INVALID');
    assert.equal(res.chainValidation.valid, false);
    assert.equal(res.rootTrust.trusted, false);
    assert.equal(res.status, 'INVALID');
    assert.equal(res.subIndication, 'ISSUER_NOT_CA');
    assert.equal(res.persistenceStatus, 'INVALID');
    assert.equal(res.isValid, false);
  });

  it('7. rejeita violação de pathLenConstraint na cadeia como INVALID', async () => {
    const rootKeys = await generateRsaKeyPair();
    const inter1Keys = await generateRsaKeyPair();
    const inter2Keys = await generateRsaKeyPair();
    const signerKeys = await generateRsaKeyPair();

    const root = await createSyntheticCertificate({
      serialNumber: 1,
      subjectCn: 'AC Raiz Confiavel v1',
      subjectKeyPair: rootKeys,
      extensions: [
        buildBasicConstraintsExtension({ cA: true, pathLenConstraint: 2 }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });

    // Inter1 has pathLenConstraint = 0 (cannot issue another intermediate CA!)
    const inter1 = await createSyntheticCertificate({
      serialNumber: 2,
      subjectCn: 'AC Intermediaria Nivel 1 (pathLen=0)',
      issuerCert: root.cert,
      subjectKeyPair: inter1Keys,
      signingPrivateKey: rootKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: true, pathLenConstraint: 0 }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });

    // Inter2 is illegally issued by Inter1
    const inter2 = await createSyntheticCertificate({
      serialNumber: 3,
      subjectCn: 'AC Intermediaria Nivel 2 Ilegal',
      issuerCert: inter1.cert,
      subjectKeyPair: inter2Keys,
      signingPrivateKey: inter1Keys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: true, pathLenConstraint: 0 }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });

    const signer = await createSyntheticCertificate({
      serialNumber: 4,
      subjectCn: 'DR MEDICO:34929144892',
      issuerCert: inter2.cert,
      subjectKeyPair: signerKeys,
      signingPrivateKey: inter2Keys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ digitalSignature: true, nonRepudiation: true }),
      ],
    });

    const unsignedPdf = await createSampleUnsignedPdf();
    const signedPdf = await signPdfWithCustomPki({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: signer.cert,
      signerPrivateKey: signerKeys.privateKey,
      cmsCertificates: [signer.cert, inter2.cert, inter1.cert],
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [root.pem],
      verificationTime: new Date('2026-06-15T12:00:05Z'),
    });

    assert.equal(res.chainValidation.status, 'INVALID');
    assert.equal(res.chainValidation.valid, false);
    assert.equal(res.rootTrust.trusted, false);
    assert.equal(res.status, 'INVALID');
    assert.equal(res.subIndication, 'PATH_LEN_CONSTRAINT_VIOLATION');
    assert.equal(res.persistenceStatus, 'INVALID');
    assert.equal(res.isValid, false);
  });

  it('8. rejeita KeyUsage incompatível na Autoridade Certificadora (sem keyCertSign) e no signatário (apenas keyEncipherment)', async () => {
    const rootKeys = await generateRsaKeyPair();
    const badCaKeys = await generateRsaKeyPair();
    const signerKeys = await generateRsaKeyPair();

    const root = await createSyntheticCertificate({
      serialNumber: 1,
      subjectCn: 'AC Raiz Confiavel v1',
      subjectKeyPair: rootKeys,
      extensions: [
        buildBasicConstraintsExtension({ cA: true }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });

    // Case 8A: Intermediate CA has cA=true, but KeyUsage lacks keyCertSign
    const caWithoutKeyCertSign = await createSyntheticCertificate({
      serialNumber: 2,
      subjectCn: 'AC Sem KeyCertSign v1',
      issuerCert: root.cert,
      subjectKeyPair: badCaKeys,
      signingPrivateKey: rootKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: true }),
        buildKeyUsageExtension({ digitalSignature: true, cRLSign: true, keyCertSign: false }),
      ],
    });

    const signerA = await createSyntheticCertificate({
      serialNumber: 3,
      subjectCn: 'DR MEDICO:34929144892',
      issuerCert: caWithoutKeyCertSign.cert,
      subjectKeyPair: signerKeys,
      signingPrivateKey: badCaKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ digitalSignature: true, nonRepudiation: true }),
      ],
    });

    const unsignedPdf = await createSampleUnsignedPdf();
    const signedPdfBadCaKu = await signPdfWithCustomPki({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: signerA.cert,
      signerPrivateKey: signerKeys.privateKey,
      cmsCertificates: [signerA.cert, caWithoutKeyCertSign.cert],
    });

    const resBadCaKu = await padesService.verifyPadesSignature(signedPdfBadCaKu, {
      trustedRootPems: [root.pem],
      verificationTime: new Date('2026-06-15T12:00:05Z'),
    });

    assert.equal(resBadCaKu.chainValidation.status, 'INVALID');
    assert.equal(resBadCaKu.status, 'INVALID');
    assert.equal(resBadCaKu.subIndication, 'CA_KEY_USAGE_INCOMPATIBLE');
    assert.equal(resBadCaKu.isValid, false);

    // Case 8B: Signer certificate has KeyUsage with only keyEncipherment (no digitalSignature or nonRepudiation)
    const signerEncryptionOnly = await createSyntheticCertificate({
      serialNumber: 4,
      subjectCn: 'DR CIFRAGEM:34929144892',
      issuerCert: root.cert,
      subjectKeyPair: signerKeys,
      signingPrivateKey: rootKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({
          digitalSignature: false,
          nonRepudiation: false,
          keyEncipherment: true,
        }),
      ],
    });

    const signedPdfBadSignerKu = await signPdfWithCustomPki({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: signerEncryptionOnly.cert,
      signerPrivateKey: signerKeys.privateKey,
      cmsCertificates: [signerEncryptionOnly.cert],
    });

    const resBadSignerKu = await padesService.verifyPadesSignature(
      signedPdfBadSignerKu,
      {
        trustedRootPems: [root.pem],
        verificationTime: new Date('2026-06-15T12:00:05Z'),
      },
    );

    assert.equal(resBadSignerKu.signerIdentity.keyUsageValid, false);
    assert.equal(resBadSignerKu.chainValidation.status, 'INVALID');
    assert.equal(resBadSignerKu.status, 'INVALID');
    assert.equal(resBadSignerKu.subIndication, 'SIGNER_KEY_USAGE_INCOMPATIBLE');
    assert.equal(resBadSignerKu.isValid, false);
  });

  it('9. rejeita certificado final inadequado para assinatura digital (cA=true no signatário, EKU exclusivo de TLS serverAuth, ou divergência de CPF SAN vs CN)', async () => {
    const rootKeys = await generateRsaKeyPair();
    const signerKeys = await generateRsaKeyPair();

    const root = await createSyntheticCertificate({
      serialNumber: 1,
      subjectCn: 'AC Raiz Confiavel v1',
      subjectKeyPair: rootKeys,
      extensions: [
        buildBasicConstraintsExtension({ cA: true }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });

    const unsignedPdf = await createSampleUnsignedPdf();

    // Case 9A: End-entity signer is a CA certificate (BasicConstraints cA=true)
    const caAsSigner = await createSyntheticCertificate({
      serialNumber: 50,
      subjectCn: 'AC TENTANDO ASSINAR RECEITA:34929144892',
      issuerCert: root.cert,
      subjectKeyPair: signerKeys,
      signingPrivateKey: rootKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: true }),
        buildKeyUsageExtension({
          digitalSignature: true,
          keyCertSign: true,
          cRLSign: true,
        }),
      ],
    });

    const signedByCa = await signPdfWithCustomPki({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: caAsSigner.cert,
      signerPrivateKey: signerKeys.privateKey,
      cmsCertificates: [caAsSigner.cert],
    });

    const resCaAsSigner = await padesService.verifyPadesSignature(signedByCa, {
      trustedRootPems: [root.pem],
      verificationTime: new Date('2026-06-15T12:00:05Z'),
    });

    assert.equal(resCaAsSigner.signerIdentity.isCa, true);
    assert.equal(resCaAsSigner.signerIdentity.keyUsageValid, false);
    assert.equal(resCaAsSigner.chainValidation.status, 'INVALID');
    assert.equal(resCaAsSigner.status, 'INVALID');
    assert.equal(resCaAsSigner.subIndication, 'SIGNER_IS_CA_CERTIFICATE');
    assert.equal(resCaAsSigner.isValid, false);

    // Case 9B: End-entity signer has EKU restricted exclusively to id-kp-serverAuth (1.3.6.1.5.5.7.3.1)
    const tlsServerSigner = await createSyntheticCertificate({
      serialNumber: 51,
      subjectCn: 'servidor.clinica.med.br:34929144892',
      issuerCert: root.cert,
      subjectKeyPair: signerKeys,
      signingPrivateKey: rootKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ digitalSignature: true }),
        buildExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']), // serverAuth only
      ],
    });

    const signedByTls = await signPdfWithCustomPki({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: tlsServerSigner.cert,
      signerPrivateKey: signerKeys.privateKey,
      cmsCertificates: [tlsServerSigner.cert],
    });

    const resTls = await padesService.verifyPadesSignature(signedByTls, {
      trustedRootPems: [root.pem],
      verificationTime: new Date('2026-06-15T12:00:05Z'),
    });

    assert.equal(resTls.signerIdentity.keyUsageValid, false);
    assert.equal(resTls.chainValidation.status, 'INVALID');
    assert.equal(resTls.status, 'INVALID');
    assert.equal(
      resTls.subIndication,
      'SIGNER_EXTENDED_KEY_USAGE_INCOMPATIBLE',
    );
    assert.equal(resTls.isValid, false);

    // Case 9C: CPF in SAN (2.16.76.1.3.1) conflicts with CPF in CN
    const mismatchedCpfSigner = await createSyntheticCertificate({
      serialNumber: 52,
      subjectCn: 'DR MEDICO:11122233344',
      issuerCert: root.cert,
      subjectKeyPair: signerKeys,
      signingPrivateKey: rootKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ digitalSignature: true, nonRepudiation: true }),
        buildIcpBrasilSanExtension('99988877766'), // Conflicts with CN!
      ],
    });

    const signedByMismatchedCpf = await signPdfWithCustomPki({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: mismatchedCpfSigner.cert,
      signerPrivateKey: signerKeys.privateKey,
      cmsCertificates: [mismatchedCpfSigner.cert],
    });

    const resMismatch = await padesService.verifyPadesSignature(
      signedByMismatchedCpf,
      {
        trustedRootPems: [root.pem],
        verificationTime: new Date('2026-06-15T12:00:05Z'),
      },
    );

    assert.equal(resMismatch.signerIdentity.cpfMatchesCommonName, false);
    assert.equal(resMismatch.chainValidation.status, 'INVALID');
    assert.equal(resMismatch.status, 'INVALID');
    assert.equal(resMismatch.subIndication, 'SIGNER_IDENTITY_MISMATCH');
    assert.equal(resMismatch.isValid, false);
  });

  it('10. impede promover cadeia isoladamente válida a assinatura globalmente VALID e identifica com exatidão o certificado associado ao SignerInfo', async () => {
    const rootKeys = await generateRsaKeyPair();
    const interKeys = await generateRsaKeyPair();
    const decoyKeys = await generateRsaKeyPair();
    const signerKeys = await generateRsaKeyPair();

    // Notice both root and signer have serialNumber = 777 (different issuers) to verify exact (issuer + serialNumber) binding
    const root = await createSyntheticCertificate({
      serialNumber: 777,
      subjectCn: 'AC Raiz Confiavel v1',
      subjectKeyPair: rootKeys,
      extensions: [
        buildBasicConstraintsExtension({ cA: true }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });

    const intermediate = await createSyntheticCertificate({
      serialNumber: 777,
      subjectCn: 'AC Intermediaria Confiavel v1',
      issuerCert: root.cert,
      subjectKeyPair: interKeys,
      signingPrivateKey: rootKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: true }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });

    // Unrelated certificate also embedded in CMS before the real signer certificate
    const decoyCert = await createSyntheticCertificate({
      serialNumber: 777,
      subjectCn: 'OUTRO MEDICO DECOY:00011122233',
      issuerCert: root.cert,
      subjectKeyPair: decoyKeys,
      signingPrivateKey: rootKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ digitalSignature: true, nonRepudiation: true }),
      ],
    });

    const realSigner = await createSyntheticCertificate({
      serialNumber: 777,
      subjectCn: 'DR MEDICO TITULAR:34929144892',
      issuerCert: intermediate.cert,
      subjectKeyPair: signerKeys,
      signingPrivateKey: interKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ digitalSignature: true, nonRepudiation: true }),
        buildIcpBrasilSanExtension('34929144892'),
      ],
    });

    const unsignedPdf = await createSampleUnsignedPdf();
    const signedPdf = await signPdfWithCustomPki({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: realSigner.cert,
      signerPrivateKey: signerKeys.privateKey,
      // Place decoyCert, root.cert, and intermediate.cert BEFORE realSigner.cert in CMS certificates
      cmsCertificates: [decoyCert.cert, root.cert, intermediate.cert, realSigner.cert],
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [root.pem],
      requireFullTrust: true,
      verificationTime: new Date('2026-06-15T12:00:05Z'),
    });

    // Must identify realSigner (not decoyCert or root) despite identical serialNumber=777
    assert.equal(res.signerName, 'DR MEDICO TITULAR:34929144892');
    assert.equal(res.signerCpf, '34929144892');

    // Chain and Root Trust are both valid
    assert.equal(res.chainValidation.status, 'VALID');
    assert.equal(res.chainValidation.valid, true);
    assert.equal(res.rootTrust.trusted, true);

    // Yet global status CANNOT be promoted to VALID because revocation is INDETERMINATE
    assert.equal(res.revocation.status, 'INDETERMINATE');
    assert.equal(res.revocation.checked, false);
    assert.equal(res.certificateTrust, false);
    assert.equal(res.isTrusted, false);
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.persistenceStatus, 'UNVERIFIED');
    // With requireFullTrust: true, isValid is false unless status === 'VALID'
    assert.equal(res.isValid, false);

    // Also verify that if the certificate is currently expired at verificationTime (e.g. 2035),
    // it is NOT classified as historically INVALID (remains INDETERMINATE / OUT_OF_BOUNDS_NO_POE)
    const resExpiredAtVerification = await padesService.verifyPadesSignature(
      signedPdf,
      {
        trustedRootPems: [root.pem],
        verificationTime: new Date('2035-01-01T00:00:00Z'),
      },
    );
    assert.equal(resExpiredAtVerification.chainValidation.status, 'VALID');
    assert.equal(resExpiredAtVerification.rootTrust.trusted, true);
    assert.equal(
      resExpiredAtVerification.temporalValidity.status,
      'OUT_OF_BOUNDS_NO_POE',
    );
    assert.equal(resExpiredAtVerification.temporalValidity.hasTrustedPoe, false);
    assert.equal(resExpiredAtVerification.status, 'INDETERMINATE');
    assert.equal(resExpiredAtVerification.subIndication, 'OUT_OF_BOUNDS_NO_POE');
  });
});
