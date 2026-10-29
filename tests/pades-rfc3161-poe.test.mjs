import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';

import { PadesService } from '../lib/signature/pades-service.ts';
import {
  computeExternalPoeReceiptMacForTest,
  OID_KP_TIME_STAMPING,
  OID_SIGNATURE_TIME_STAMP_TOKEN,
  OID_TST_INFO,
} from '../lib/signature/rfc3161-timestamp.ts';

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

async function createSampleUnsignedPdf(text = 'Receituario Medico - Lote 6F.2B') {
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

function buildBasicConstraintsExtension({
  cA,
  pathLenConstraint = null,
  critical = true,
}) {
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

function buildExtendedKeyUsageExtension(oids, critical = true) {
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
  const contentStr = `01011980${cpf11Digits}${'0'.repeat(26)}`;
  const rawBytes = Buffer.from(contentStr, 'latin1');

  const otherNameSeq = new asn1js.Sequence({
    value: [
      new asn1js.ObjectIdentifier({ value: OID_ICP_BRASIL_PF_DATA }),
      new asn1js.Constructed({
        idBlock: { tagClass: 3, tagNumber: 0 },
        value: [
          new asn1js.OctetString({ valueHex: new Uint8Array(rawBytes).buffer }),
        ],
      }),
    ],
  });
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

async function createSyntheticCertificate({
  serialNumber = 1,
  subjectCn,
  subjectOrg = 'ICP-Brasil Synthetic Test',
  issuerCert = null,
  subjectKeyPair,
  signingPrivateKey = null,
  notBefore = new Date('2025-01-01T00:00:00Z'),
  notAfter = new Date('2027-01-01T00:00:00Z'),
  extensions = [],
}) {
  const cert = new pkijs.Certificate();
  cert.version = 2;
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

let sharedFixturePromise = null;
async function getStandardPkiAndTsaFixture() {
  if (!sharedFixturePromise) {
    sharedFixturePromise = (async () => {
      const docRootKeys = await generateRsaKeyPair();
      const docInterKeys = await generateRsaKeyPair();
      const docSignerKeys = await generateRsaKeyPair();

      const tsaRootKeys = await generateRsaKeyPair();
      const tsaInterKeys = await generateRsaKeyPair();
      const tsaSignerKeys = await generateRsaKeyPair();

      const docRoot = await createSyntheticCertificate({
        serialNumber: 100,
        subjectCn: 'AC Raiz ICP-Brasil Sintetica v1',
        subjectKeyPair: docRootKeys,
        notBefore: new Date('2020-01-01T00:00:00Z'),
        notAfter: new Date('2035-01-01T00:00:00Z'),
        extensions: [
          buildBasicConstraintsExtension({ cA: true, pathLenConstraint: 2 }),
          buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
        ],
      });

      const docInter = await createSyntheticCertificate({
        serialNumber: 200,
        subjectCn: 'AC Intermediaria Medica v1',
        issuerCert: docRoot.cert,
        subjectKeyPair: docInterKeys,
        signingPrivateKey: docRootKeys.privateKey,
        notBefore: new Date('2022-01-01T00:00:00Z'),
        notAfter: new Date('2032-01-01T00:00:00Z'),
        extensions: [
          buildBasicConstraintsExtension({ cA: true, pathLenConstraint: 0 }),
          buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
        ],
      });

      const docSigner = await createSyntheticCertificate({
        serialNumber: 300,
        subjectCn: 'DR GUILHERME TAYAR:34929144892',
        issuerCert: docInter.cert,
        subjectKeyPair: docSignerKeys,
        signingPrivateKey: docInterKeys.privateKey,
        notBefore: new Date('2025-01-01T00:00:00Z'),
        notAfter: new Date('2026-06-30T23:59:59Z'),
        extensions: [
          buildBasicConstraintsExtension({ cA: false, critical: false }),
          buildKeyUsageExtension({ digitalSignature: true, nonRepudiation: true }),
          buildExtendedKeyUsageExtension(
            ['1.3.6.1.5.5.7.3.2', '1.3.6.1.5.5.7.3.4'],
            false,
          ),
          buildIcpBrasilSanExtension('34929144892'),
        ],
      });

      const tsaRoot = await createSyntheticCertificate({
        serialNumber: 400,
        subjectCn: 'AC Raiz Tempo ICP-Brasil Sintetica v1',
        subjectKeyPair: tsaRootKeys,
        notBefore: new Date('2020-01-01T00:00:00Z'),
        notAfter: new Date('2035-01-01T00:00:00Z'),
        extensions: [
          buildBasicConstraintsExtension({ cA: true, pathLenConstraint: 2 }),
          buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
        ],
      });

      const tsaInter = await createSyntheticCertificate({
        serialNumber: 500,
        subjectCn: 'AC ACT Intermediaria Tempo v1',
        issuerCert: tsaRoot.cert,
        subjectKeyPair: tsaInterKeys,
        signingPrivateKey: tsaRootKeys.privateKey,
        notBefore: new Date('2022-01-01T00:00:00Z'),
        notAfter: new Date('2032-01-01T00:00:00Z'),
        extensions: [
          buildBasicConstraintsExtension({ cA: true, pathLenConstraint: 0 }),
          buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
        ],
      });

      const tsaSigner = await createSyntheticCertificate({
        serialNumber: 600,
        subjectCn: 'SERVIDOR ACT CARIMBO DO TEMPO v1',
        issuerCert: tsaInter.cert,
        subjectKeyPair: tsaSignerKeys,
        signingPrivateKey: tsaInterKeys.privateKey,
        notBefore: new Date('2024-01-01T00:00:00Z'),
        notAfter: new Date('2030-01-01T00:00:00Z'),
        extensions: [
          buildBasicConstraintsExtension({ cA: false, critical: false }),
          buildKeyUsageExtension({ digitalSignature: true, nonRepudiation: true }),
          buildExtendedKeyUsageExtension([OID_KP_TIME_STAMPING], true),
        ],
      });

      return {
        docRoot,
        docInter,
        docSigner,
        tsaRoot,
        tsaInter,
        tsaSigner,
      };
    })();
  }
  return sharedFixturePromise;
}

/**
 * Builds an RFC 3161 TimeStampToken (ContentInfo wrapping SignedData with id-ct-TSTInfo)
 * over `stampedContentBytes`.
 */
async function createRfc3161TimestampToken({
  stampedContentBytes,
  genTime = new Date('2026-03-15T14:30:00Z'),
  tsaCert,
  tsaPrivateKey,
  tsaCertificates = [tsaCert],
  overrideImprintBytes = null,
  corruptSignature = false,
  policyOid = '2.16.76.1.6.1',
  serialNumber = 987654,
}) {
  const imprintHash =
    overrideImprintBytes ||
    crypto.createHash('sha256').update(stampedContentBytes).digest();

  const tstInfo = new pkijs.TSTInfo({
    version: 1,
    policy: policyOid,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID_SHA256 }),
      hashedMessage: new asn1js.OctetString({
        valueHex: new Uint8Array(imprintHash).buffer,
      }),
    }),
    serialNumber: new asn1js.Integer({ value: serialNumber }),
    genTime,
    ordering: false,
  });

  const tstInfoDer = Buffer.from(tstInfo.toSchema().toBER(false));
  const tstInfoDigest = crypto.createHash('sha256').update(tstInfoDer).digest();

  const tsaCertDer = Buffer.from(tsaCert.toSchema().toBER(false));
  const tsaCertHash = crypto.createHash('sha256').update(tsaCertDer).digest();

  const essCertIdV2 = new asn1js.Sequence({
    value: [
      new asn1js.OctetString({ valueHex: new Uint8Array(tsaCertHash).buffer }),
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
        values: [new asn1js.ObjectIdentifier({ value: OID_TST_INFO })],
      }),
      new pkijs.Attribute({
        type: OID_SIGNING_TIME,
        values: [new asn1js.UTCTime({ valueDate: genTime })],
      }),
      new pkijs.Attribute({
        type: OID_MESSAGE_DIGEST,
        values: [
          new asn1js.OctetString({
            valueHex: new Uint8Array(tstInfoDigest).buffer,
          }),
        ],
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
      issuer: tsaCert.issuer,
      serialNumber: tsaCert.serialNumber,
    }),
    digestAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID_SHA256 }),
    signatureAlgorithm: new pkijs.AlgorithmIdentifier({
      algorithmId: OID_RSA_SHA256,
      algorithmParams: new asn1js.Null(),
    }),
    signedAttrs,
  });

  const signedData = new pkijs.SignedData({
    version: 3,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: OID_TST_INFO,
      eContent: new asn1js.OctetString({
        valueHex: new Uint8Array(tstInfoDer).buffer,
      }),
    }),
    digestAlgorithms: [
      new pkijs.AlgorithmIdentifier({ algorithmId: OID_SHA256 }),
    ],
    certificates: tsaCertificates,
    signerInfos: [signerInfo],
  });

  await signedData.sign(
    tsaPrivateKey,
    0,
    'SHA-256',
    new Uint8Array(tstInfoDer).buffer,
  );

  if (corruptSignature) {
    const sigHexView = signedData.signerInfos[0].signature.valueBlock.valueHexView;
    const corrupted = Buffer.from(sigHexView);
    corrupted[0] ^= 0xff;
    corrupted[corrupted.length - 1] ^= 0xff;
    signedData.signerInfos[0].signature = new asn1js.OctetString({
      valueHex: new Uint8Array(corrupted).buffer,
    });
  }

  const contentInfo = new pkijs.ContentInfo({
    contentType: OID_SIGNED_DATA,
    content: signedData.toSchema(true),
  });

  const der = Buffer.from(contentInfo.toSchema().toBER(false));
  const asn1 = asn1js.fromBER(new Uint8Array(der).buffer).result;
  return { der, asn1 };
}

/**
 * Signs a prepared PDF and optionally attaches an RFC 3161 signatureTimeStampToken
 * inside `signerInfo.unsignedAttrs`.
 */
async function signPdfWithOptionalTimestamp({
  unsignedPdfBuffer,
  signerCert,
  signerPrivateKey,
  cmsCertificates = [signerCert],
  claimedSigningTime = new Date('2026-03-15T14:29:50Z'),
  buildTimestampToken = null,
}) {
  const prepared = await padesService.preparePdfForSignature(unsignedPdfBuffer, {
    signerName: 'DR GUILHERME TAYAR',
    signerCpf: '34929144892',
    doctorCrm: '123456-SP',
    signatureLength: 24576,
  });

  const hashBuffer = Buffer.from(prepared.digestHex, 'hex');
  const signerCertDer = Buffer.from(signerCert.toSchema().toBER());
  const certHashSha256 = crypto
    .createHash('sha256')
    .update(signerCertDer)
    .digest();

  const essCertIdV2 = new asn1js.Sequence({
    value: [
      new asn1js.OctetString({ valueHex: new Uint8Array(certHashSha256).buffer }),
    ],
  });
  const signingCertificateV2Value = new asn1js.Sequence({
    value: [new asn1js.Sequence({ value: [essCertIdV2] })],
  });

  const attributes = [
    new pkijs.Attribute({
      type: OID_CONTENT_TYPE,
      values: [new asn1js.ObjectIdentifier({ value: OID_DATA })],
    }),
    new pkijs.Attribute({
      type: OID_MESSAGE_DIGEST,
      values: [
        new asn1js.OctetString({ valueHex: new Uint8Array(hashBuffer).buffer }),
      ],
    }),
    new pkijs.Attribute({
      type: OID_SIGNING_CERTIFICATE_V2,
      values: [signingCertificateV2Value],
    }),
  ];

  if (claimedSigningTime) {
    attributes.splice(
      1,
      0,
      new pkijs.Attribute({
        type: OID_SIGNING_TIME,
        values: [new asn1js.UTCTime({ valueDate: claimedSigningTime })],
      }),
    );
  }

  const signedAttrs = new pkijs.SignedAndUnsignedAttributes({
    type: 0,
    attributes,
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
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: OID_DATA,
    }),
    digestAlgorithms: [
      new pkijs.AlgorithmIdentifier({ algorithmId: OID_SHA256 }),
    ],
    certificates: cmsCertificates,
    signerInfos: [signerInfo],
  });

  await signedData.sign(
    signerPrivateKey,
    0,
    'SHA-256',
    new Uint8Array(prepared.contentToSign).buffer,
  );

  const signatureValueBytes = Buffer.from(
    signedData.signerInfos[0].signature.valueBlock.valueHexView,
  );

  if (typeof buildTimestampToken === 'function') {
    const tsToken = await buildTimestampToken(signatureValueBytes);
    signedData.signerInfos[0].unsignedAttrs =
      new pkijs.SignedAndUnsignedAttributes({
        type: 1,
        attributes: [
          new pkijs.Attribute({
            type: OID_SIGNATURE_TIME_STAMP_TOKEN,
            values: [tsToken.asn1],
          }),
        ],
      });
  }

  const contentInfo = new pkijs.ContentInfo({
    contentType: OID_SIGNED_DATA,
    content: signedData.toSchema(true),
  });

  const cmsDer = Buffer.from(contentInfo.toSchema().toBER());
  const signedPdf = padesService.embedSignature(
    prepared,
    cmsDer.toString('base64'),
  );
  return { signedPdf, signatureValueBytes, digestHex: prepared.digestHex };
}

describe('Lote 6F.2B — Validação de Carimbos de Tempo RFC 3161 e Prova de Existência (POE)', () => {
  it('1. valida timestamp RFC 3161 íntegro com TSA confiável configurada', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();
    const genTime = new Date('2026-03-15T14:30:00Z');

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
      buildTimestampToken: async (sigBytes) =>
        createRfc3161TimestampToken({
          stampedContentBytes: sigBytes,
          genTime,
          tsaCert: fx.tsaSigner.cert,
          tsaPrivateKey: fx.tsaSigner.keyPair.privateKey,
          tsaCertificates: [fx.tsaSigner.cert, fx.tsaInter.cert],
        }),
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      trustedTsaRootPems: [fx.tsaRoot.pem],
      verificationTime: new Date('2026-04-01T12:00:00Z'),
    });

    assert.equal(res.cryptographicIntegrity, true);
    assert.equal(res.chainValidation.status, 'VALID');
    assert.equal(res.rootTrust.trusted, true);

    assert.equal(res.temporalValidity.timestampPresent, true);
    assert.equal(res.temporalValidity.timestampSignatureValid, true);
    assert.equal(res.temporalValidity.timestampMessageImprintValid, true);
    assert.equal(res.temporalValidity.tsaKeyUsageValid, true);
    assert.equal(res.temporalValidity.tsaExtendedKeyUsageValid, true);
    assert.equal(res.temporalValidity.tsaExtendedKeyUsageCritical, true);
    assert.equal(res.temporalValidity.tsaChainStatus, 'VALID');
    assert.equal(res.temporalValidity.tsaChainValid, true);
    assert.equal(res.temporalValidity.tsaRootTrusted, true);
    assert.equal(res.temporalValidity.tsaRevocationChecked, false);
    assert.equal(res.temporalValidity.tsaTrustComplete, false);
    assert.equal(res.temporalValidity.hasTrustedPoe, true);
    assert.equal(res.temporalValidity.provenExistedBeforeExpiration, true);
    assert.equal(res.temporalValidity.exactCreationTimeProven, false);
    assert.equal(res.temporalValidity.lowerBoundAfterNotBeforeProven, false);
    assert.equal(
      res.temporalValidity.poeSource,
      'RFC3161_SIGNATURE_TIMESTAMP',
    );
    assert.equal(res.temporalValidity.poeTime?.toISOString(), genTime.toISOString());
    assert.equal(res.poeTime?.toISOString(), genTime.toISOString());
    assert.equal(res.temporalValidity.status, 'VALID_AT_POE');
    assert.equal(res.temporalValidity.valid, true);

    // Revocation (signer + TSA) is not yet checked in 6F.2B, so global status and certificateTrust remain INDETERMINATE / false
    assert.equal(res.certificateTrust, false);
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.subIndication, 'REVOCATION_UNAVAILABLE');
    assert.equal(res.isTrusted, false);
  });

  it('2. rejeita timestamp com assinatura matemática inválida como INVALID', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
      buildTimestampToken: async (sigBytes) =>
        createRfc3161TimestampToken({
          stampedContentBytes: sigBytes,
          tsaCert: fx.tsaSigner.cert,
          tsaPrivateKey: fx.tsaSigner.keyPair.privateKey,
          tsaCertificates: [fx.tsaSigner.cert, fx.tsaInter.cert],
          corruptSignature: true, // Corrupted mathematical signature
        }),
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      trustedTsaRootPems: [fx.tsaRoot.pem],
      verificationTime: new Date('2026-04-01T12:00:00Z'),
    });

    assert.equal(res.temporalValidity.timestampPresent, true);
    assert.equal(res.temporalValidity.timestampSignatureValid, false);
    assert.equal(res.temporalValidity.hasTrustedPoe, false);
    assert.equal(res.temporalValidity.status, 'INVALID_TIMESTAMP');
    assert.equal(res.temporalValidity.valid, false);
    assert.equal(res.status, 'INVALID');
    assert.equal(res.subIndication, 'TIMESTAMP_SIGNATURE_INVALID');
    assert.equal(res.persistenceStatus, 'INVALID');
    assert.equal(res.isValid, false);
  });

  it('3. rejeita timestamp com messageImprint divergente da assinatura carimbada como INVALID', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
      buildTimestampToken: async () =>
        createRfc3161TimestampToken({
          stampedContentBytes: Buffer.from('bytes-de-outra-assinatura'),
          overrideImprintBytes: crypto
            .createHash('sha256')
            .update('outro-documento-qualquer')
            .digest(),
          tsaCert: fx.tsaSigner.cert,
          tsaPrivateKey: fx.tsaSigner.keyPair.privateKey,
          tsaCertificates: [fx.tsaSigner.cert, fx.tsaInter.cert],
        }),
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      trustedTsaRootPems: [fx.tsaRoot.pem],
      verificationTime: new Date('2026-04-01T12:00:00Z'),
    });

    assert.equal(res.temporalValidity.timestampPresent, true);
    assert.equal(res.temporalValidity.timestampSignatureValid, true);
    assert.equal(res.temporalValidity.timestampMessageImprintValid, false);
    assert.equal(res.temporalValidity.hasTrustedPoe, false);
    assert.equal(res.temporalValidity.status, 'INVALID_TIMESTAMP');
    assert.equal(res.temporalValidity.valid, false);
    assert.equal(res.status, 'INVALID');
    assert.equal(res.subIndication, 'TIMESTAMP_MESSAGE_IMPRINT_MISMATCH');
    assert.equal(res.isValid, false);
  });

  it('4. rejeita TSA com certificado incompatível (BasicConstraints cA=true, KeyUsage inadequado ou genTime fora da vigência da TSA)', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const badTsaKeys = await generateRsaKeyPair();
    const unsignedPdf = await createSampleUnsignedPdf();

    // Case 4A: TSA certificate has BasicConstraints cA=true
    const caTsaCert = await createSyntheticCertificate({
      serialNumber: 601,
      subjectCn: 'TSA COM CA TRUE INDEVIDO',
      issuerCert: fx.tsaInter.cert,
      subjectKeyPair: badTsaKeys,
      signingPrivateKey: fx.tsaInter.keyPair.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: true }),
        buildKeyUsageExtension({ digitalSignature: true, keyCertSign: true }),
        buildExtendedKeyUsageExtension([OID_KP_TIME_STAMPING], true),
      ],
    });

    const { signedPdf: pdfCaTsa } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
      buildTimestampToken: async (sigBytes) =>
        createRfc3161TimestampToken({
          stampedContentBytes: sigBytes,
          tsaCert: caTsaCert.cert,
          tsaPrivateKey: badTsaKeys.privateKey,
          tsaCertificates: [caTsaCert.cert, fx.tsaInter.cert],
        }),
    });

    const resCaTsa = await padesService.verifyPadesSignature(pdfCaTsa, {
      trustedRootPems: [fx.docRoot.pem],
      trustedTsaRootPems: [fx.tsaRoot.pem],
      verificationTime: new Date('2026-04-01T12:00:00Z'),
    });

    assert.equal(resCaTsa.temporalValidity.tsaKeyUsageValid, false);
    assert.equal(resCaTsa.temporalValidity.hasTrustedPoe, false);
    assert.equal(resCaTsa.temporalValidity.status, 'INVALID_TIMESTAMP');
    assert.equal(resCaTsa.status, 'INVALID');
    assert.equal(resCaTsa.subIndication, 'TSA_CERT_INCOMPATIBLE');
    assert.equal(resCaTsa.isValid, false);

    // Case 4B: TSA certificate has KeyUsage with only keyEncipherment (no digitalSignature/nonRepudiation)
    const encOnlyTsaCert = await createSyntheticCertificate({
      serialNumber: 602,
      subjectCn: 'TSA KEY ENCIPHERMENT ONLY',
      issuerCert: fx.tsaInter.cert,
      subjectKeyPair: badTsaKeys,
      signingPrivateKey: fx.tsaInter.keyPair.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({
          digitalSignature: false,
          nonRepudiation: false,
          keyEncipherment: true,
        }),
        buildExtendedKeyUsageExtension([OID_KP_TIME_STAMPING], true),
      ],
    });

    const { signedPdf: pdfEncTsa } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
      buildTimestampToken: async (sigBytes) =>
        createRfc3161TimestampToken({
          stampedContentBytes: sigBytes,
          tsaCert: encOnlyTsaCert.cert,
          tsaPrivateKey: badTsaKeys.privateKey,
          tsaCertificates: [encOnlyTsaCert.cert, fx.tsaInter.cert],
        }),
    });

    const resEncTsa = await padesService.verifyPadesSignature(pdfEncTsa, {
      trustedRootPems: [fx.docRoot.pem],
      trustedTsaRootPems: [fx.tsaRoot.pem],
      verificationTime: new Date('2026-04-01T12:00:00Z'),
    });

    assert.equal(resEncTsa.temporalValidity.tsaKeyUsageValid, false);
    assert.equal(resEncTsa.temporalValidity.hasTrustedPoe, false);
    assert.equal(resEncTsa.temporalValidity.status, 'INVALID_TIMESTAMP');
    assert.equal(resEncTsa.status, 'INVALID');
    assert.equal(resEncTsa.subIndication, 'TSA_CERT_INCOMPATIBLE');
    assert.equal(resEncTsa.isValid, false);
  });

  it('5. rejeita TSA com ExtendedKeyUsage inadequado (sem id-kp-timeStamping, com múltiplos EKUs ou critical=false)', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const badEkuKeys = await generateRsaKeyPair();
    const unsignedPdf = await createSampleUnsignedPdf();

    // Case 5A: TSA certificate has emailProtection instead of id-kp-timeStamping
    const wrongEkuTsa = await createSyntheticCertificate({
      serialNumber: 603,
      subjectCn: 'TSA COM EKU EMAIL PROTECTION',
      issuerCert: fx.tsaInter.cert,
      subjectKeyPair: badEkuKeys,
      signingPrivateKey: fx.tsaInter.keyPair.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ digitalSignature: true }),
        buildExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.4'], true), // emailProtection
      ],
    });

    const { signedPdf: pdfWrongEku } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
      buildTimestampToken: async (sigBytes) =>
        createRfc3161TimestampToken({
          stampedContentBytes: sigBytes,
          tsaCert: wrongEkuTsa.cert,
          tsaPrivateKey: badEkuKeys.privateKey,
          tsaCertificates: [wrongEkuTsa.cert, fx.tsaInter.cert],
        }),
    });

    const resWrongEku = await padesService.verifyPadesSignature(pdfWrongEku, {
      trustedRootPems: [fx.docRoot.pem],
      trustedTsaRootPems: [fx.tsaRoot.pem],
      verificationTime: new Date('2026-04-01T12:00:00Z'),
    });

    assert.equal(resWrongEku.temporalValidity.tsaKeyUsageValid, true);
    assert.equal(resWrongEku.temporalValidity.tsaExtendedKeyUsageValid, false);
    assert.equal(resWrongEku.temporalValidity.hasTrustedPoe, false);
    assert.equal(resWrongEku.temporalValidity.status, 'INVALID_TIMESTAMP');
    assert.equal(resWrongEku.status, 'INVALID');
    assert.equal(resWrongEku.subIndication, 'TSA_EKU_INVALID');
    assert.equal(resWrongEku.isValid, false);

    // Case 5B: TSA certificate has id-kp-timeStamping mixed with serverAuth (violating RFC 3161 §2.3 exclusivity)
    const mixedEkuTsa = await createSyntheticCertificate({
      serialNumber: 604,
      subjectCn: 'TSA COM EKU MISTO NAO EXCLUSIVO',
      issuerCert: fx.tsaInter.cert,
      subjectKeyPair: badEkuKeys,
      signingPrivateKey: fx.tsaInter.keyPair.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ digitalSignature: true }),
        buildExtendedKeyUsageExtension(
          [OID_KP_TIME_STAMPING, '1.3.6.1.5.5.7.3.1'],
          true,
        ),
      ],
    });

    const { signedPdf: pdfMixedEku } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
      buildTimestampToken: async (sigBytes) =>
        createRfc3161TimestampToken({
          stampedContentBytes: sigBytes,
          tsaCert: mixedEkuTsa.cert,
          tsaPrivateKey: badEkuKeys.privateKey,
          tsaCertificates: [mixedEkuTsa.cert, fx.tsaInter.cert],
        }),
    });

    const resMixedEku = await padesService.verifyPadesSignature(pdfMixedEku, {
      trustedRootPems: [fx.docRoot.pem],
      trustedTsaRootPems: [fx.tsaRoot.pem],
      verificationTime: new Date('2026-04-01T12:00:00Z'),
    });

    assert.equal(resMixedEku.temporalValidity.tsaExtendedKeyUsageValid, false);
    assert.equal(resMixedEku.temporalValidity.status, 'INVALID_TIMESTAMP');
    assert.equal(resMixedEku.status, 'INVALID');
    assert.equal(resMixedEku.subIndication, 'TSA_EKU_INVALID');

    // Case 5C: TSA certificate has exclusive id-kp-timeStamping, but critical = false (violating RFC 3161 §2.3 MUST be critical)
    const nonCriticalEkuTsa = await createSyntheticCertificate({
      serialNumber: 605,
      subjectCn: 'TSA COM EKU NAO CRITICO',
      issuerCert: fx.tsaInter.cert,
      subjectKeyPair: badEkuKeys,
      signingPrivateKey: fx.tsaInter.keyPair.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ digitalSignature: true }),
        buildExtendedKeyUsageExtension([OID_KP_TIME_STAMPING], false), // critical = false!
      ],
    });

    const { signedPdf: pdfNonCriticalEku } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
      buildTimestampToken: async (sigBytes) =>
        createRfc3161TimestampToken({
          stampedContentBytes: sigBytes,
          tsaCert: nonCriticalEkuTsa.cert,
          tsaPrivateKey: badEkuKeys.privateKey,
          tsaCertificates: [nonCriticalEkuTsa.cert, fx.tsaInter.cert],
        }),
    });

    const resNonCriticalEku = await padesService.verifyPadesSignature(
      pdfNonCriticalEku,
      {
        trustedRootPems: [fx.docRoot.pem],
        trustedTsaRootPems: [fx.tsaRoot.pem],
        verificationTime: new Date('2026-04-01T12:00:00Z'),
      },
    );

    assert.equal(
      resNonCriticalEku.temporalValidity.tsaExtendedKeyUsageCritical,
      false,
    );
    assert.equal(
      resNonCriticalEku.temporalValidity.tsaExtendedKeyUsageValid,
      false,
    );
    assert.equal(
      resNonCriticalEku.temporalValidity.status,
      'INVALID_TIMESTAMP',
    );
    assert.equal(resNonCriticalEku.status, 'INVALID');
    assert.equal(resNonCriticalEku.subIndication, 'TSA_EKU_INVALID');
    assert.equal(resNonCriticalEku.isValid, false);
  });

  it('6. não aceita timestamp com cadeia da TSA incompleta como POE confiável, preservando INDETERMINATE', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    // Omit fx.tsaInter.cert from tsaCertificates so the TSA chain is incomplete
    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
      buildTimestampToken: async (sigBytes) =>
        createRfc3161TimestampToken({
          stampedContentBytes: sigBytes,
          tsaCert: fx.tsaSigner.cert,
          tsaPrivateKey: fx.tsaSigner.keyPair.privateKey,
          tsaCertificates: [fx.tsaSigner.cert], // Missing TSA intermediate!
        }),
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      trustedTsaRootPems: [fx.tsaRoot.pem],
      verificationTime: new Date('2028-01-01T00:00:00Z'), // After signer expiration
    });

    // Mathematical signature and messageImprint of the timestamp are true, but POE is NOT trusted!
    assert.equal(res.temporalValidity.timestampPresent, true);
    assert.equal(res.temporalValidity.timestampSignatureValid, true);
    assert.equal(res.temporalValidity.timestampMessageImprintValid, true);
    assert.equal(res.temporalValidity.tsaChainStatus, 'INCOMPLETE_CHAIN');
    assert.equal(res.temporalValidity.tsaChainValid, false);
    assert.equal(res.temporalValidity.tsaRootTrusted, false);
    assert.equal(res.temporalValidity.hasTrustedPoe, false);
    assert.equal(res.temporalValidity.poeSource, 'NONE');
    assert.equal(res.temporalValidity.poeTime, undefined);
    assert.equal(res.temporalValidity.valid, false);
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.subIndication, 'TSA_CHAIN_INCOMPLETE');
    assert.equal(res.isTrusted, false);
  });

  it('7. rejeita TSA não confiável (raiz da TSA não autorizada ou TSA autoassinada sintética em produção)', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const otherTsaRootKeys = await generateRsaKeyPair();
    const selfSignedTsaKeys = await generateRsaKeyPair();
    const unsignedPdf = await createSampleUnsignedPdf();

    const otherAuthorizedTsaRoot = await createSyntheticCertificate({
      serialNumber: 499,
      subjectCn: 'AC Raiz Tempo Oficial Diferente v1',
      subjectKeyPair: otherTsaRootKeys,
      extensions: [
        buildBasicConstraintsExtension({ cA: true }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: true }),
      ],
    });

    // Case 7A: Embed fx.tsaRoot.cert inside the timestamp CMS, but configure otherAuthorizedTsaRoot as the only trusted TSA anchor
    const { signedPdf: pdfUntrustedTsaRoot } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
      buildTimestampToken: async (sigBytes) =>
        createRfc3161TimestampToken({
          stampedContentBytes: sigBytes,
          tsaCert: fx.tsaSigner.cert,
          tsaPrivateKey: fx.tsaSigner.keyPair.privateKey,
          tsaCertificates: [fx.tsaSigner.cert, fx.tsaInter.cert, fx.tsaRoot.cert],
        }),
    });

    const resUntrusted = await padesService.verifyPadesSignature(
      pdfUntrustedTsaRoot,
      {
        trustedRootPems: [fx.docRoot.pem],
        trustedTsaRootPems: [otherAuthorizedTsaRoot.pem],
        verificationTime: new Date('2028-01-01T00:00:00Z'),
      },
    );

    assert.equal(resUntrusted.temporalValidity.timestampSignatureValid, true);
    assert.equal(resUntrusted.temporalValidity.tsaChainStatus, 'UNTRUSTED_ROOT');
    assert.equal(resUntrusted.temporalValidity.tsaChainValid, false);
    assert.equal(resUntrusted.temporalValidity.tsaRootTrusted, false);
    assert.equal(resUntrusted.temporalValidity.hasTrustedPoe, false);
    assert.equal(resUntrusted.temporalValidity.valid, false);
    assert.equal(resUntrusted.status, 'INDETERMINATE');
    assert.equal(resUntrusted.subIndication, 'TSA_ROOT_UNTRUSTED');
    assert.equal(resUntrusted.isTrusted, false);

    // Case 7B (Requirement 5): Self-signed synthetic TSA is never treated as trusted, including in production
    const selfSignedTsa = await createSyntheticCertificate({
      serialNumber: 699,
      subjectCn: 'TSA AUTOASSINADA SINTETICA',
      subjectKeyPair: selfSignedTsaKeys,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ digitalSignature: true }),
        buildExtendedKeyUsageExtension([OID_KP_TIME_STAMPING], true),
      ],
    });

    const { signedPdf: pdfSelfSignedTsa } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
      buildTimestampToken: async (sigBytes) =>
        createRfc3161TimestampToken({
          stampedContentBytes: sigBytes,
          tsaCert: selfSignedTsa.cert,
          tsaPrivateKey: selfSignedTsaKeys.privateKey,
          tsaCertificates: [selfSignedTsa.cert],
        }),
    });

    const prevNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      const resSelfTsaProd = await padesService.verifyPadesSignature(
        pdfSelfSignedTsa,
        {
          trustedRootPems: [fx.docRoot.pem],
          trustedTsaRootPems: [selfSignedTsa.pem],
          allowCustomTrustAnchors: true,
          verificationTime: new Date('2028-01-01T00:00:00Z'),
        },
      );

      assert.equal(resSelfTsaProd.temporalValidity.tsaChainStatus, 'SELF_SIGNED');
      assert.equal(resSelfTsaProd.temporalValidity.tsaChainValid, false);
      assert.equal(resSelfTsaProd.temporalValidity.tsaRootTrusted, false);
      assert.equal(resSelfTsaProd.temporalValidity.hasTrustedPoe, false);
      assert.equal(resSelfTsaProd.isTrusted, false);
      assert.equal(resSelfTsaProd.status, 'INDETERMINATE');
      assert.equal(resSelfTsaProd.subIndication, 'TSA_SELF_SIGNED');
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });

  it('8. aplica a Regra Temporal Fundamental: timestamp posterior ao vencimento sem evidência anterior resulta em INDETERMINATE (nunca INVALID automático)', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    // fx.docSigner expires at 2026-06-30T23:59:59Z.
    // Timestamp genTime is 2026-09-01T12:00:00Z (AFTER signer certificate expiration).
    const postExpiryGenTime = new Date('2026-09-01T12:00:00Z');

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
      claimedSigningTime: new Date('2026-05-01T12:00:00Z'),
      buildTimestampToken: async (sigBytes) =>
        createRfc3161TimestampToken({
          stampedContentBytes: sigBytes,
          genTime: postExpiryGenTime,
          tsaCert: fx.tsaSigner.cert,
          tsaPrivateKey: fx.tsaSigner.keyPair.privateKey,
          tsaCertificates: [fx.tsaSigner.cert, fx.tsaInter.cert],
        }),
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      trustedTsaRootPems: [fx.tsaRoot.pem],
      verificationTime: new Date('2026-10-01T12:00:00Z'),
    });

    // POE is authentic (hasTrustedPoe = true), but since poeTime > notAfter,
    // it does NOT prove the signature was created before notAfter, nor does it prove it was created after notAfter!
    assert.equal(res.temporalValidity.hasTrustedPoe, true);
    assert.equal(
      res.temporalValidity.poeTime?.toISOString(),
      postExpiryGenTime.toISOString(),
    );
    assert.equal(res.temporalValidity.status, 'OUT_OF_BOUNDS_AT_POE');
    assert.equal(res.temporalValidity.valid, false);

    // Must be INDETERMINATE, NEVER INVALID!
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.subIndication, 'OUT_OF_BOUNDS_AT_POE');
    assert.equal(res.persistenceStatus, 'UNVERIFIED');
    assert.equal(res.isTrusted, false);

    // Contrast: POE BEFORE signer's notBefore (2025-01-01) proves the signature existed before the certificate was valid -> INVALID (NOT_YET_VALID)
    const preNotBeforeGenTime = new Date('2024-06-01T12:00:00Z');
    const { signedPdf: pdfBeforeNotBefore } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
      claimedSigningTime: null,
      buildTimestampToken: async (sigBytes) =>
        createRfc3161TimestampToken({
          stampedContentBytes: sigBytes,
          genTime: preNotBeforeGenTime,
          tsaCert: fx.tsaSigner.cert,
          tsaPrivateKey: fx.tsaSigner.keyPair.privateKey,
          tsaCertificates: [fx.tsaSigner.cert, fx.tsaInter.cert],
        }),
    });

    const resBeforeNotBefore = await padesService.verifyPadesSignature(
      pdfBeforeNotBefore,
      {
        trustedRootPems: [fx.docRoot.pem],
        trustedTsaRootPems: [fx.tsaRoot.pem],
        verificationTime: new Date('2026-04-01T12:00:00Z'),
      },
    );

    assert.equal(resBeforeNotBefore.temporalValidity.status, 'NOT_YET_VALID');
    assert.equal(
      resBeforeNotBefore.temporalValidity.subIndication,
      'POE_BEFORE_NOT_BEFORE',
    );
    assert.equal(resBeforeNotBefore.status, 'INVALID');
    assert.equal(resBeforeNotBefore.isValid, false);
  });

  it('9. valida historicamente timestamp anterior ao vencimento quando o certificado já expirou no momento da verificação, mantendo INDETERMINATE até comprovar revogação', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    // Signer valid until 2026-06-30. Timestamp at 2026-03-15 (within signer validity).
    const preExpiryGenTime = new Date('2026-03-15T14:30:00Z');

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
      buildTimestampToken: async (sigBytes) =>
        createRfc3161TimestampToken({
          stampedContentBytes: sigBytes,
          genTime: preExpiryGenTime,
          tsaCert: fx.tsaSigner.cert,
          tsaPrivateKey: fx.tsaSigner.keyPair.privateKey,
          tsaCertificates: [fx.tsaSigner.cert, fx.tsaInter.cert],
        }),
    });

    // Verify in 2029 (long after signer certificate expired in 2026)
    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      trustedTsaRootPems: [fx.tsaRoot.pem],
      verificationTime: new Date('2029-11-20T10:00:00Z'),
    });

    assert.equal(res.temporalValidity.currentlyValid, false);
    assert.equal(res.temporalValidity.hasTrustedPoe, true);
    assert.equal(
      res.temporalValidity.poeSource,
      'RFC3161_SIGNATURE_TIMESTAMP',
    );
    assert.equal(
      res.temporalValidity.poeTime?.toISOString(),
      preExpiryGenTime.toISOString(),
    );
    assert.equal(res.temporalValidity.status, 'VALID_AT_POE');
    assert.equal(res.temporalValidity.valid, true);

    // Remaining requirement (revocation) is still pending, so global status stays INDETERMINATE
    assert.equal(res.revocation.status, 'INDETERMINATE');
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.subIndication, 'REVOCATION_UNAVAILABLE');
    assert.equal(res.persistenceStatus, 'UNVERIFIED');
    assert.equal(res.isTrusted, false);
  });

  it('10. distingue ausência de timestamp dentro da vigência atual (WITHIN_CURRENT_VALIDITY_NO_TIMESTAMP) e após expiração (OUT_OF_BOUNDS_NO_POE)', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
      claimedSigningTime: null,
      buildTimestampToken: null, // No timestamp
    });

    // 10A: Verified while signer certificate is currently valid
    const resCurrent = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-04-01T12:00:00Z'),
    });

    assert.equal(resCurrent.temporalValidity.currentlyValid, true);
    assert.equal(resCurrent.temporalValidity.hasTrustedPoe, false);
    assert.equal(resCurrent.temporalValidity.poeSource, 'NONE');
    assert.equal(resCurrent.temporalValidity.poeTime, undefined);
    assert.equal(
      resCurrent.temporalValidity.status,
      'WITHIN_CURRENT_VALIDITY_NO_TIMESTAMP',
    );
    assert.equal(resCurrent.temporalValidity.valid, true);
    assert.equal(resCurrent.status, 'INDETERMINATE');
    assert.equal(resCurrent.subIndication, 'REVOCATION_UNAVAILABLE');

    // 10B: Verified after signer certificate expired, without any POE
    const resExpired = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2028-04-01T12:00:00Z'),
    });

    assert.equal(resExpired.temporalValidity.currentlyValid, false);
    assert.equal(resExpired.temporalValidity.hasTrustedPoe, false);
    assert.equal(resExpired.temporalValidity.poeSource, 'NONE');
    assert.equal(resExpired.temporalValidity.status, 'OUT_OF_BOUNDS_NO_POE');
    assert.equal(resExpired.temporalValidity.valid, false);
    assert.equal(resExpired.status, 'INDETERMINATE');
    assert.equal(resExpired.subIndication, 'OUT_OF_BOUNDS_NO_POE');
  });

  it('11. não aceita claimedSigningTime falsamente anterior à expiração como substituto de POE', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    // Signer backdates claimedSigningTime to 2025-06-01 (inside [2025-01-01, 2026-06-30]), without any TSA timestamp
    const backdatedClaimedTime = new Date('2025-06-01T10:00:00Z');
    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
      claimedSigningTime: backdatedClaimedTime,
      buildTimestampToken: null,
    });

    // Verified in 2028 (after signer certificate expiration)
    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2028-01-15T12:00:00Z'),
    });

    assert.equal(
      res.claimedSigningTime?.toISOString(),
      backdatedClaimedTime.toISOString(),
    );
    assert.equal(
      res.temporalValidity.claimedSigningTime?.toISOString(),
      backdatedClaimedTime.toISOString(),
    );
    assert.equal(res.temporalValidity.hasTrustedPoe, false);
    assert.equal(res.temporalValidity.poeSource, 'NONE');
    assert.equal(res.temporalValidity.poeTime, undefined);
    assert.equal(res.poeTime, undefined);
    assert.equal(res.temporalValidity.status, 'OUT_OF_BOUNDS_NO_POE');
    assert.equal(res.temporalValidity.valid, false);
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.subIndication, 'OUT_OF_BOUNDS_NO_POE');
  });

  it('12. rejeita POE externa sem origem autenticada ou sem registro independente (options.poeTime bruto, sem evidenceRecordId, sem autenticador ou auto-autenticação em produção)', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
      buildTimestampToken: null,
    });

    const signedPdfHash = crypto
      .createHash('sha256')
      .update(signedPdf)
      .digest('hex');

    // 12A: Caller passes bare `poeTime` directly in options (Requirement 6)
    const resBarePoeTime = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2028-01-15T12:00:00Z'),
      poeTime: new Date('2026-02-01T12:00:00Z'),
    });

    assert.equal(resBarePoeTime.temporalValidity.hasTrustedPoe, false);
    assert.equal(resBarePoeTime.temporalValidity.externalPoeValid, false);
    assert.equal(resBarePoeTime.temporalValidity.poeTime, undefined);
    assert.equal(resBarePoeTime.temporalValidity.valid, false);
    assert.equal(resBarePoeTime.status, 'INDETERMINATE');
    assert.equal(resBarePoeTime.subIndication, 'EXTERNAL_POE_UNAUTHENTICATED');

    // 12B: Caller passes externalPoe missing `evidenceRecordId` (attempting to authenticate a bare date declaration without an independent record)
    const resNoRecordId = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2028-01-15T12:00:00Z'),
      externalPoeHmacKey: 'test-hmac-secret-key-32-bytes-long',
      externalPoe: {
        evidenceRecordId: '',
        poeTime: new Date('2026-02-01T12:00:00Z'),
        targetType: 'SIGNED_PDF_SHA256',
        targetHashHex: signedPdfHash,
        sourceId: 'PSYWRITE_AUDIT_LEDGER',
        authenticator: 'deadbeef'.repeat(8),
      },
    });

    assert.equal(resNoRecordId.temporalValidity.hasTrustedPoe, false);
    assert.equal(resNoRecordId.temporalValidity.externalPoeValid, false);
    assert.equal(resNoRecordId.status, 'INDETERMINATE');
    assert.equal(resNoRecordId.subIndication, 'EXTERNAL_POE_UNAUTHENTICATED');

    // 12C: Caller passes externalPoe without cryptographic authenticator or verifier
    const resNoAuth = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2028-01-15T12:00:00Z'),
      externalPoeHmacKey: 'test-hmac-secret-key-32-bytes-long',
      externalPoe: {
        evidenceRecordId: 'ledger-rec-2026-0001',
        poeTime: new Date('2026-02-01T12:00:00Z'),
        targetType: 'SIGNED_PDF_SHA256',
        targetHashHex: signedPdfHash,
        sourceId: 'PSYWRITE_AUDIT_LEDGER',
      },
    });

    assert.equal(resNoAuth.temporalValidity.hasTrustedPoe, false);
    assert.equal(resNoAuth.temporalValidity.externalPoeValid, false);
    assert.equal(resNoAuth.status, 'INDETERMINATE');
    assert.equal(resNoAuth.subIndication, 'EXTERNAL_POE_UNAUTHENTICATED');

    // 12D: Caller passes externalPoe with forged HMAC authenticator
    const resForgedHmac = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2028-01-15T12:00:00Z'),
      externalPoeHmacKey: 'test-hmac-secret-key-32-bytes-long',
      externalPoe: {
        evidenceRecordId: 'ledger-rec-2026-0002',
        poeTime: new Date('2026-02-01T12:00:00Z'),
        targetType: 'SIGNED_PDF_SHA256',
        targetHashHex: signedPdfHash,
        sourceId: 'PSYWRITE_AUDIT_LEDGER',
        authenticator: 'deadbeef'.repeat(8),
      },
    });

    assert.equal(resForgedHmac.temporalValidity.hasTrustedPoe, false);
    assert.equal(resForgedHmac.temporalValidity.externalPoeValid, false);
    assert.equal(resForgedHmac.status, 'INDETERMINATE');
    assert.equal(resForgedHmac.subIndication, 'EXTERNAL_POE_UNAUTHENTICATED');

    // 12E: In production (`NODE_ENV === 'production'`), `computeExternalPoeReceiptMacForTest` is blocked from minting HMACs over arbitrary dates,
    // and `process.env.EXTERNAL_POE_HMAC_KEY` is never implicitly read by the validator.
    const prevNodeEnv = process.env.NODE_ENV;
    const prevEnvKey = process.env.EXTERNAL_POE_HMAC_KEY;
    try {
      process.env.NODE_ENV = 'production';
      process.env.EXTERNAL_POE_HMAC_KEY = 'env-secret-key-that-must-not-be-used';

      assert.throws(
        () =>
          computeExternalPoeReceiptMacForTest(
            {
              evidenceRecordId: 'self-minted-record',
              poeTime: new Date('2026-02-01T12:00:00Z'),
              targetType: 'SIGNED_PDF_SHA256',
              targetHashHex: signedPdfHash,
              sourceId: 'PSYWRITE_AUDIT_LEDGER',
            },
            'env-secret-key-that-must-not-be-used',
          ),
        /restrito a testes/,
      );

      // Even if a caller supplies an authenticator matching process.env.EXTERNAL_POE_HMAC_KEY without explicit verifier/key in options, it is rejected
      const resImplicitEnv = await padesService.verifyPadesSignature(signedPdf, {
        trustedRootPems: [fx.docRoot.pem],
        allowCustomTrustAnchors: true,
        verificationTime: new Date('2028-01-15T12:00:00Z'),
        externalPoe: {
          evidenceRecordId: 'self-minted-record',
          poeTime: new Date('2026-02-01T12:00:00Z'),
          targetType: 'SIGNED_PDF_SHA256',
          targetHashHex: signedPdfHash,
          sourceId: 'PSYWRITE_AUDIT_LEDGER',
          authenticator: '00'.repeat(32),
        },
      });
      assert.equal(resImplicitEnv.temporalValidity.hasTrustedPoe, false);
      assert.equal(resImplicitEnv.temporalValidity.externalPoeValid, false);
      assert.equal(resImplicitEnv.status, 'INDETERMINATE');
      assert.equal(resImplicitEnv.subIndication, 'EXTERNAL_POE_UNAUTHENTICATED');
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      if (prevEnvKey === undefined) {
        delete process.env.EXTERNAL_POE_HMAC_KEY;
      } else {
        process.env.EXTERNAL_POE_HMAC_KEY = prevEnvKey;
      }
    }
  });

  it('13. rejeita POE externa com hash divergente do artefato e aceita POE externa independente vinculada ao hash real e ao evidenceRecordId', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();
    const hmacSecret = 'psywrite-poe-hmac-secret-key-2026';

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
      buildTimestampToken: null,
    });

    const poeTime = new Date('2026-02-10T15:00:00Z');
    const wrongHash = 'a'.repeat(64);

    // 13A: Valid HMAC for wrongHash, but wrongHash does not match the signedPdf being verified!
    const mismatchedEvidenceBase = {
      evidenceRecordId: 'sncr-anvisa-receipt-2026-99001',
      poeTime,
      targetType: 'SIGNED_PDF_SHA256',
      targetHashHex: wrongHash,
      sourceId: 'SNCR_ANVISA_RECEIPT',
    };
    const mismatchedAuth = computeExternalPoeReceiptMacForTest(
      mismatchedEvidenceBase,
      hmacSecret,
    );

    const resMismatch = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2028-06-01T12:00:00Z'),
      externalPoeHmacKey: hmacSecret,
      externalPoe: {
        ...mismatchedEvidenceBase,
        authenticator: mismatchedAuth,
      },
    });

    assert.equal(resMismatch.temporalValidity.hasTrustedPoe, false);
    assert.equal(resMismatch.temporalValidity.externalPoeValid, false);
    assert.equal(resMismatch.temporalValidity.poeTime, undefined);
    assert.equal(resMismatch.temporalValidity.valid, false);
    assert.equal(resMismatch.status, 'INDETERMINATE');
    assert.equal(resMismatch.subIndication, 'EXTERNAL_POE_HASH_MISMATCH');

    // 13B: Independent External POE bound to `evidenceRecordId` and the exact SHA-256 of signedPdf, verified both by MAC and independent ledger callback
    const actualPdfHash = crypto
      .createHash('sha256')
      .update(signedPdf)
      .digest('hex');
    const validEvidenceBase = {
      evidenceRecordId: 'sncr-anvisa-receipt-2026-99002',
      poeTime,
      targetType: 'SIGNED_PDF_SHA256',
      targetHashHex: actualPdfHash,
      sourceId: 'SNCR_ANVISA_RECEIPT',
    };
    const validAuth = computeExternalPoeReceiptMacForTest(
      validEvidenceBase,
      hmacSecret,
    );

    const persistedReceiptStore = new Map([
      [
        'sncr-anvisa-receipt-2026-99002',
        {
          sourceId: 'SNCR_ANVISA_RECEIPT',
          targetHashHex: actualPdfHash,
          poeTimeIso: poeTime.toISOString(),
        },
      ],
    ]);

    const resValidExtPoe = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2028-06-01T12:00:00Z'),
      externalPoeHmacKey: hmacSecret,
      externalPoeVerifier: (ev, expectedHash) => {
        const stored = persistedReceiptStore.get(ev.evidenceRecordId);
        return (
          Boolean(stored) &&
          stored.sourceId === ev.sourceId &&
          stored.targetHashHex === expectedHash.toLowerCase() &&
          stored.poeTimeIso === ev.poeTime.toISOString()
        );
      },
      externalPoe: {
        ...validEvidenceBase,
        authenticator: validAuth,
      },
    });

    assert.equal(resValidExtPoe.temporalValidity.externalPoeValid, true);
    assert.equal(resValidExtPoe.temporalValidity.hasTrustedPoe, true);
    assert.equal(resValidExtPoe.temporalValidity.provenExistedBeforeExpiration, true);
    assert.equal(resValidExtPoe.temporalValidity.exactCreationTimeProven, false);
    assert.equal(resValidExtPoe.temporalValidity.lowerBoundAfterNotBeforeProven, false);
    assert.equal(resValidExtPoe.temporalValidity.poeSource, 'EXTERNAL_POE');
    assert.equal(
      resValidExtPoe.temporalValidity.poeTime?.toISOString(),
      poeTime.toISOString(),
    );
    assert.equal(resValidExtPoe.temporalValidity.status, 'VALID_AT_POE');
    assert.equal(resValidExtPoe.temporalValidity.valid, true);
    assert.equal(resValidExtPoe.status, 'INDETERMINATE');
    assert.equal(resValidExtPoe.subIndication, 'REVOCATION_UNAVAILABLE');
  });
});
