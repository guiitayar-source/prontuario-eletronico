import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';

import { PadesService } from '../lib/signature/pades-service.ts';
import {
  OID_KP_TIME_STAMPING,
  OID_SIGNATURE_TIME_STAMP_TOKEN,
  OID_TST_INFO,
} from '../lib/signature/rfc3161-timestamp.ts';
import {
  OID_KP_OCSP_SIGNING,
  OID_PKIX_OCSP_BASIC,
  OID_PKIX_OCSP_NOCHECK,
  OID_ISSUING_DISTRIBUTION_POINT,
  OID_DELTA_CRL_INDICATOR,
  OID_CRL_REASON,
  OID_INVALIDITY_DATE,
} from '../lib/signature/revocation-validator.ts';

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

async function createSampleUnsignedPdf(text = 'Receituario Medico - Lote 6F.2C') {
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
 * Builds an RFC 3161 TimeStampToken over `stampedContentBytes`.
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
 * Signs a prepared PDF and optionally attaches an RFC 3161 signatureTimeStampToken.
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

/**
 * Builds an RFC 5280 X.509 Certificate Revocation List (CRL).
 */
async function createSyntheticCrl({
  issuerCert,
  issuerPrivateKey,
  thisUpdate = new Date('2026-02-01T00:00:00Z'),
  nextUpdate = new Date('2026-05-01T00:00:00Z'),
  revokedList = [],
  crlExtensions = [],
  corruptSignature = false,
  signatureAlgMismatch = false,
}) {
  const crl = new pkijs.CertificateRevocationList();
  crl.version = 1; // X.509 v2 CRL
  crl.issuer = issuerCert.subject;
  crl.thisUpdate = new pkijs.Time({ type: 0, value: thisUpdate });
  crl.nextUpdate = new pkijs.Time({ type: 0, value: nextUpdate });

  if (revokedList.length > 0) {
    crl.revokedCertificates = revokedList.map((entry) => {
      const entryExts = [];
      if (entry.reasonCode !== undefined) {
        entryExts.push(
          new pkijs.Extension({
            extnID: OID_CRL_REASON,
            critical: false,
            extnValue: new asn1js.Enumerated({ value: entry.reasonCode }).toBER(false),
          }),
        );
      }
      if (entry.invalidityDate) {
        entryExts.push(
          new pkijs.Extension({
            extnID: OID_INVALIDITY_DATE,
            critical: false,
            extnValue: new asn1js.GeneralizedTime({
              valueDate: entry.invalidityDate,
            }).toBER(false),
          }),
        );
      }
      return new pkijs.RevokedCertificate({
        userCertificate: new asn1js.Integer({ value: entry.serialNumber }),
        revocationDate: new pkijs.Time({ type: 0, value: entry.revocationDate }),
        crlEntryExtensions:
          entryExts.length > 0
            ? new pkijs.Extensions({ extensions: entryExts })
            : undefined,
      });
    });
  }

  if (crlExtensions.length > 0) {
    crl.crlExtensions = new pkijs.Extensions({ extensions: crlExtensions });
  }

  await crl.sign(issuerPrivateKey, 'SHA-256');

  if (signatureAlgMismatch) {
    // Deliberately set signatureAlgorithm different from tbsCertList.signature
    crl.signatureAlgorithm.algorithmId = '1.2.840.113549.1.1.12'; // SHA384withRSA
  }

  if (corruptSignature) {
    const rawSig = crl.signatureValue.valueBlock.valueHexView;
    const corrupted = Buffer.from(rawSig);
    corrupted[0] ^= 0xff;
    corrupted[corrupted.length - 1] ^= 0xff;
    crl.signatureValue = new asn1js.BitString({
      valueHex: new Uint8Array(corrupted).buffer,
      unusedBits: 0,
    });
  }

  return Buffer.from(crl.toSchema().toBER(false));
}

/**
 * Builds an RFC 6960 OCSPResponse.
 */
async function createSyntheticOcspResponse({
  targetCert,
  issuerCert,
  responderCert,
  responderPrivateKey,
  producedAt = new Date('2026-03-01T00:00:00Z'),
  thisUpdate = new Date('2026-02-01T00:00:00Z'),
  nextUpdate = new Date('2026-05-01T00:00:00Z'),
  certStatus = 'good', // 'good' | 'revoked' | 'unknown' | 'tryLater'
  revocationDate = new Date('2026-02-15T12:00:00Z'),
  reasonCode,
  invalidityDate,
  corruptSignature = false,
  extraCerts = [],
  overrideSerialNumber = null,
  overrideIssuerNameHash = null,
  overrideIssuerKeyHash = null,
  responseStatus = 0, // 0 = successful, 3 = tryLater
}) {
  if (responseStatus !== 0) {
    const ocspResp = new pkijs.OCSPResponse();
    ocspResp.responseStatus = new asn1js.Enumerated({ value: responseStatus });
    return Buffer.from(ocspResp.toSchema().toBER(false));
  }

  const basicOcsp = new pkijs.BasicOCSPResponse();
  basicOcsp.tbsResponseData.producedAt = producedAt;
  basicOcsp.tbsResponseData.responderID = responderCert.subject;

  const sr = new pkijs.SingleResponse();
  sr.certID.hashAlgorithm.algorithmId = OID_SHA256;

  const issuerNameDer = Buffer.from(issuerCert.subject.toSchema().toBER(false));
  const issuerNameHash =
    overrideIssuerNameHash ||
    crypto.createHash('sha256').update(issuerNameDer).digest();
  sr.certID.issuerNameHash = new asn1js.OctetString({
    valueHex: new Uint8Array(issuerNameHash).buffer,
  });

  const issuerKeyBytes = Buffer.from(
    issuerCert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView,
  );
  const issuerKeyHash =
    overrideIssuerKeyHash ||
    crypto.createHash('sha256').update(issuerKeyBytes).digest();
  sr.certID.issuerKeyHash = new asn1js.OctetString({
    valueHex: new Uint8Array(issuerKeyHash).buffer,
  });

  sr.certID.serialNumber =
    overrideSerialNumber !== null
      ? new asn1js.Integer({ value: overrideSerialNumber })
      : targetCert.serialNumber;

  if (certStatus === 'good') {
    sr.certStatus = new asn1js.Primitive({
      idBlock: { tagClass: 3, tagNumber: 0 },
    });
  } else if (certStatus === 'unknown') {
    sr.certStatus = new asn1js.Primitive({
      idBlock: { tagClass: 3, tagNumber: 2 },
    });
  } else if (certStatus === 'revoked') {
    const revElements = [
      new asn1js.GeneralizedTime({ valueDate: revocationDate }),
    ];
    if (reasonCode !== undefined) {
      revElements.push(
        new asn1js.Constructed({
          idBlock: { tagClass: 3, tagNumber: 0 },
          value: [new asn1js.Enumerated({ value: reasonCode })],
        }),
      );
    }
    sr.certStatus = new asn1js.Constructed({
      idBlock: { tagClass: 3, tagNumber: 1 },
      value: revElements,
    });
  }

  sr.thisUpdate = thisUpdate;
  sr.nextUpdate = nextUpdate;

  if (invalidityDate) {
    sr.singleExtensions = [
      new pkijs.Extension({
        extnID: OID_INVALIDITY_DATE,
        critical: false,
        extnValue: new asn1js.GeneralizedTime({
          valueDate: invalidityDate,
        }).toBER(false),
      }),
    ];
  }

  basicOcsp.tbsResponseData.responses = [sr];

  if (extraCerts.length > 0) {
    basicOcsp.certs = extraCerts;
  }

  await basicOcsp.sign(responderPrivateKey, 'SHA-256');

  if (corruptSignature) {
    const rawSig = basicOcsp.signature.valueBlock.valueHexView;
    const corrupted = Buffer.from(rawSig);
    corrupted[0] ^= 0xff;
    corrupted[corrupted.length - 1] ^= 0xff;
    basicOcsp.signature = new asn1js.BitString({
      valueHex: new Uint8Array(corrupted).buffer,
      unusedBits: 0,
    });
  }

  const ocspResp = new pkijs.OCSPResponse();
  ocspResp.responseStatus = new asn1js.Enumerated({ value: 0 });
  ocspResp.responseBytes = new pkijs.ResponseBytes({
    responseType: OID_PKIX_OCSP_BASIC,
    response: new asn1js.OctetString({
      valueHex: basicOcsp.toSchema().toBER(false),
    }),
  });

  return Buffer.from(ocspResp.toSchema().toBER(false));
}

describe('Lote 6F.2C — Validação Criptográfica de Revogação (CRL, OCSP e POE)', () => {
  it('1. valida CRL íntegra e emitida por autoridade autorizada (KeyUsage.cRLSign)', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
    });

    const crlDocSigner = await createSyntheticCrl({
      issuerCert: fx.docInter.cert,
      issuerPrivateKey: fx.docInter.keyPair.privateKey,
      revokedList: [], // signer not revoked
    });

    const crlDocInter = await createSyntheticCrl({
      issuerCert: fx.docRoot.cert,
      issuerPrivateKey: fx.docRoot.keyPair.privateKey,
      revokedList: [], // intermediate CA not revoked
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      crls: [crlDocSigner, crlDocInter],
    });

    assert.equal(res.cryptographicIntegrity, true);
    assert.equal(res.chainValidation.valid, true);
    assert.equal(res.rootTrust.trusted, true);
    assert.equal(res.temporalValidity.valid, true);
    assert.equal(res.revocation.checked, true);
    assert.equal(res.revocation.status, 'GOOD');
    assert.equal(res.revocation.source, 'CRL');
    assert.equal(res.revocation.signerChainComplete, true);
    assert.equal(res.certificateTrust, true);
    assert.equal(res.status, 'VALID');
    assert.equal(res.persistenceStatus, 'VALID');
  });

  it('2. rejeita CRL assinada por chave errada como INVALID_EVIDENCE e mantém INDETERMINATE', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const wrongKeys = await generateRsaKeyPair();
    const unsignedPdf = await createSampleUnsignedPdf();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
    });

    // CRL signed by wrong private key
    const badCrl = await createSyntheticCrl({
      issuerCert: fx.docInter.cert,
      issuerPrivateKey: wrongKeys.privateKey,
      revokedList: [],
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      crls: [badCrl],
    });

    assert.equal(res.revocation.checked, true);
    assert.equal(res.revocation.status, 'INVALID_EVIDENCE');
    assert.equal(res.revocation.subIndication, 'REVOCATION_EVIDENCE_INVALID');
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.subIndication, 'REVOCATION_EVIDENCE_INVALID');
    assert.equal(res.persistenceStatus, 'UNVERIFIED');
  });

  it('3. rejeita CRL vencida ou inadequada para a data de referência como INVALID_EVIDENCE', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
    });

    // CRL with nextUpdate before referenceTime
    const expiredCrl = await createSyntheticCrl({
      issuerCert: fx.docInter.cert,
      issuerPrivateKey: fx.docInter.keyPair.privateKey,
      thisUpdate: new Date('2025-01-01T00:00:00Z'),
      nextUpdate: new Date('2025-02-01T00:00:00Z'),
      revokedList: [],
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      crls: [expiredCrl],
    });

    assert.equal(res.revocation.status, 'INVALID_EVIDENCE');
    assert.equal(res.revocation.subIndication, 'REVOCATION_EVIDENCE_INVALID');
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.subIndication, 'REVOCATION_EVIDENCE_INVALID');
  });

  it('4. rejeita CRL sem cRLSign válido na autoridade emissora como INVALID_EVIDENCE', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const noCrlSignCaKeys = await generateRsaKeyPair();
    const unsignedPdf = await createSampleUnsignedPdf();

    // Intermediate CA without cRLSign
    const noCrlSignCa = await createSyntheticCertificate({
      serialNumber: 201,
      subjectCn: 'AC SEM CRLSIGN',
      issuerCert: fx.docRoot.cert,
      subjectKeyPair: noCrlSignCaKeys,
      signingPrivateKey: fx.docRoot.keyPair.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: true }),
        buildKeyUsageExtension({ keyCertSign: true, cRLSign: false }), // cRLSign = false!
      ],
    });

    const signerKeys = await generateRsaKeyPair();
    const signerUnderNoCrlSignCa = await createSyntheticCertificate({
      serialNumber: 301,
      subjectCn: 'DR SEM CRLSIGN:34929144892',
      issuerCert: noCrlSignCa.cert,
      subjectKeyPair: signerKeys,
      signingPrivateKey: noCrlSignCaKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ digitalSignature: true, nonRepudiation: true }),
        buildExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.2', '1.3.6.1.5.5.7.3.4']),
        buildIcpBrasilSanExtension('34929144892'),
      ],
    });

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: signerUnderNoCrlSignCa.cert,
      signerPrivateKey: signerKeys.privateKey,
      cmsCertificates: [signerUnderNoCrlSignCa.cert, noCrlSignCa.cert],
    });

    const crlFromNoCrlSignCa = await createSyntheticCrl({
      issuerCert: noCrlSignCa.cert,
      issuerPrivateKey: noCrlSignCaKeys.privateKey,
      revokedList: [],
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      crls: [crlFromNoCrlSignCa],
    });

    assert.equal(res.revocation.status, 'INVALID_EVIDENCE');
    assert.equal(res.revocation.subIndication, 'REVOCATION_EVIDENCE_INVALID');
    assert.equal(res.status, 'INDETERMINATE');
  });

  it('5. valida certificado não presente numa CRL completa e aplicável', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
    });

    // CRL containing other revoked certificates, but NOT the signer
    const crlWithOthers = await createSyntheticCrl({
      issuerCert: fx.docInter.cert,
      issuerPrivateKey: fx.docInter.keyPair.privateKey,
      revokedList: [
        { serialNumber: 8888, revocationDate: new Date('2026-01-10T00:00:00Z'), reasonCode: 0 },
        { serialNumber: 9999, revocationDate: new Date('2026-02-10T00:00:00Z'), reasonCode: 3 },
      ],
    });

    const crlInter = await createSyntheticCrl({
      issuerCert: fx.docRoot.cert,
      issuerPrivateKey: fx.docRoot.keyPair.privateKey,
      revokedList: [],
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      crls: [crlWithOthers, crlInter],
    });

    assert.equal(res.revocation.status, 'GOOD');
    assert.equal(res.certificateTrust, true);
    assert.equal(res.status, 'VALID');
  });

  it('6. detecta certificado presente na lista de revogação da CRL', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
    });

    const revokedDate = new Date('2026-02-10T10:00:00Z');
    const crlSignerRevoked = await createSyntheticCrl({
      issuerCert: fx.docInter.cert,
      issuerPrivateKey: fx.docInter.keyPair.privateKey,
      revokedList: [
        {
          serialNumber: 300, // fx.docSigner serialNumber
          revocationDate: revokedDate,
          reasonCode: 4, // superseded
        },
      ],
    });

    const crlInter = await createSyntheticCrl({
      issuerCert: fx.docRoot.cert,
      issuerPrivateKey: fx.docRoot.keyPair.privateKey,
      revokedList: [],
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      crls: [crlSignerRevoked, crlInter],
    });

    assert.equal(res.revocation.checked, true);
    assert.equal(res.revocation.status, 'REVOKED_NO_POE');
    assert.equal(res.revocation.reasonName, 'superseded');
    assert.equal(res.revocation.revokedAt?.toISOString(), revokedDate.toISOString());
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.subIndication, 'REVOKED_NO_POE');
  });

  it('7. rejeita CRL parcial ou de escopo incompatível (onlySomeReasons, onlyContainsCACerts, deltaCRL, indirectCRL)', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
    });

    // 7A: IssuingDistributionPoint with onlySomeReasons: true
    const idpOnlySomeReasonsSeq = new asn1js.Sequence({
      value: [
        new asn1js.Constructed({
          idBlock: { tagClass: 3, tagNumber: 3 }, // onlySomeReasons [3] ReasonFlags
          value: [
            new asn1js.BitString({ valueHex: new Uint8Array([0x80]).buffer, unusedBits: 0 }),
          ],
        }),
      ],
    });
    const idpOnlySomeReasonsExt = new pkijs.Extension({
      extnID: OID_ISSUING_DISTRIBUTION_POINT,
      critical: true,
      extnValue: idpOnlySomeReasonsSeq.toBER(false),
    });

    const crlPartialReasons = await createSyntheticCrl({
      issuerCert: fx.docInter.cert,
      issuerPrivateKey: fx.docInter.keyPair.privateKey,
      revokedList: [],
      crlExtensions: [idpOnlySomeReasonsExt],
    });

    const res7A = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      crls: [crlPartialReasons],
    });
    assert.equal(res7A.status, 'INDETERMINATE');
    assert.equal(res7A.subIndication, 'CRL_PARTIAL_SCOPE');

    // 7B: IssuingDistributionPoint with onlyContainsCACerts: true for user certificate
    const idpOnlyCaSeq = new asn1js.Sequence({
      value: [
        new asn1js.Constructed({
          idBlock: { tagClass: 3, tagNumber: 2 }, // onlyContainsCACerts [2] BOOLEAN
          value: [new asn1js.Boolean({ value: true })],
        }),
      ],
    });
    const idpOnlyCaExt = new pkijs.Extension({
      extnID: OID_ISSUING_DISTRIBUTION_POINT,
      critical: true,
      extnValue: idpOnlyCaSeq.toBER(false),
    });

    const crlOnlyCa = await createSyntheticCrl({
      issuerCert: fx.docInter.cert,
      issuerPrivateKey: fx.docInter.keyPair.privateKey,
      revokedList: [],
      crlExtensions: [idpOnlyCaExt],
    });

    const res7B = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      crls: [crlOnlyCa],
    });
    assert.equal(res7B.status, 'INDETERMINATE');
    assert.equal(res7B.subIndication, 'CRL_SCOPE_INCOMPATIBLE');

    // 7C: Standalone Delta CRL (DeltaCRLIndicator 2.5.29.27)
    const deltaExt = new pkijs.Extension({
      extnID: OID_DELTA_CRL_INDICATOR,
      critical: true,
      extnValue: new asn1js.Integer({ value: 1 }).toBER(false),
    });

    const crlDelta = await createSyntheticCrl({
      issuerCert: fx.docInter.cert,
      issuerPrivateKey: fx.docInter.keyPair.privateKey,
      revokedList: [],
      crlExtensions: [deltaExt],
    });

    const res7C = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      crls: [crlDelta],
    });
    assert.equal(res7C.status, 'INDETERMINATE');
    assert.equal(res7C.subIndication, 'CRL_DELTA_UNSUPPORTED');

    // 7D: Indirect CRL (indirectCRL: true)
    const idpIndirectSeq = new asn1js.Sequence({
      value: [
        new asn1js.Constructed({
          idBlock: { tagClass: 3, tagNumber: 4 }, // indirectCRL [4] BOOLEAN
          value: [new asn1js.Boolean({ value: true })],
        }),
      ],
    });
    const idpIndirectExt = new pkijs.Extension({
      extnID: OID_ISSUING_DISTRIBUTION_POINT,
      critical: true,
      extnValue: idpIndirectSeq.toBER(false),
    });

    const crlIndirect = await createSyntheticCrl({
      issuerCert: fx.docInter.cert,
      issuerPrivateKey: fx.docInter.keyPair.privateKey,
      revokedList: [],
      crlExtensions: [idpIndirectExt],
    });

    const res7D = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      crls: [crlIndirect],
    });
    assert.equal(res7D.status, 'INDETERMINATE');
    assert.equal(res7D.subIndication, 'CRL_INDIRECT_UNSUPPORTED');
  });

  it('8. valida OCSP good autêntico e autenticado pelo emissor direto ou delegado autorizado', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
    });

    // 8A: Direct issuer CA OCSP good response for signer
    const ocspDocSigner = await createSyntheticOcspResponse({
      targetCert: fx.docSigner.cert,
      issuerCert: fx.docInter.cert,
      responderCert: fx.docInter.cert,
      responderPrivateKey: fx.docInter.keyPair.privateKey,
      certStatus: 'good',
    });

    // Direct Root CA OCSP good response for intermediate CA
    const ocspDocInter = await createSyntheticOcspResponse({
      targetCert: fx.docInter.cert,
      issuerCert: fx.docRoot.cert,
      responderCert: fx.docRoot.cert,
      responderPrivateKey: fx.docRoot.keyPair.privateKey,
      certStatus: 'good',
    });

    const res8A = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      ocspResponses: [ocspDocSigner, ocspDocInter],
    });

    assert.equal(res8A.revocation.checked, true);
    assert.equal(res8A.revocation.status, 'GOOD');
    assert.equal(res8A.revocation.source, 'OCSP');
    assert.equal(res8A.certificateTrust, true);
    assert.equal(res8A.status, 'VALID');

    // 8B: Authorized delegated OCSP responder with id-kp-OCSPSigning and id-pkix-ocsp-nocheck
    const delegatedKeys = await generateRsaKeyPair();
    const delegatedCert = await createSyntheticCertificate({
      serialNumber: 250,
      subjectCn: 'OCSP RESPONDER DELEGADO AUTORIZADO',
      issuerCert: fx.docInter.cert,
      subjectKeyPair: delegatedKeys,
      signingPrivateKey: fx.docInter.keyPair.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ digitalSignature: true }),
        buildExtendedKeyUsageExtension([OID_KP_OCSP_SIGNING], true),
        new pkijs.Extension({
          extnID: OID_PKIX_OCSP_NOCHECK,
          critical: false,
          extnValue: new asn1js.Null().toBER(false),
        }),
      ],
    });

    const ocspDelegated = await createSyntheticOcspResponse({
      targetCert: fx.docSigner.cert,
      issuerCert: fx.docInter.cert,
      responderCert: delegatedCert.cert,
      responderPrivateKey: delegatedKeys.privateKey,
      certStatus: 'good',
      extraCerts: [delegatedCert.cert],
    });

    const res8B = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      ocspResponses: [ocspDelegated, ocspDocInter],
    });

    assert.equal(res8B.revocation.status, 'GOOD');
    assert.equal(res8B.certificateTrust, true);
    assert.equal(res8B.status, 'VALID');
  });

  it('9. detecta resposta OCSP revoked válida', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
    });

    const revDate = new Date('2026-02-20T10:00:00Z');
    const ocspRevoked = await createSyntheticOcspResponse({
      targetCert: fx.docSigner.cert,
      issuerCert: fx.docInter.cert,
      responderCert: fx.docInter.cert,
      responderPrivateKey: fx.docInter.keyPair.privateKey,
      certStatus: 'revoked',
      revocationDate: revDate,
      reasonCode: 5, // cessationOfOperation
    });

    const ocspDocInter = await createSyntheticOcspResponse({
      targetCert: fx.docInter.cert,
      issuerCert: fx.docRoot.cert,
      responderCert: fx.docRoot.cert,
      responderPrivateKey: fx.docRoot.keyPair.privateKey,
      certStatus: 'good',
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      ocspResponses: [ocspRevoked, ocspDocInter],
    });

    assert.equal(res.revocation.checked, true);
    assert.equal(res.revocation.status, 'REVOKED_NO_POE');
    assert.equal(res.revocation.reasonName, 'cessationOfOperation');
    assert.equal(res.revocation.revokedAt?.toISOString(), revDate.toISOString());
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.subIndication, 'REVOKED_NO_POE');
  });

  it('10. rejeita OCSP unknown e nunca confunde com good (retorna INDETERMINATE)', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
    });

    const ocspUnknown = await createSyntheticOcspResponse({
      targetCert: fx.docSigner.cert,
      issuerCert: fx.docInter.cert,
      responderCert: fx.docInter.cert,
      responderPrivateKey: fx.docInter.keyPair.privateKey,
      certStatus: 'unknown',
    });

    const crlDocInter = await createSyntheticCrl({
      issuerCert: fx.docRoot.cert,
      issuerPrivateKey: fx.docRoot.keyPair.privateKey,
      revokedList: [],
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      ocspResponses: [ocspUnknown],
      crls: [crlDocInter],
    });

    assert.equal(res.revocation.status, 'INDETERMINATE');
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.subIndication, 'OCSP_STATUS_UNKNOWN');
    assert.equal(res.certificateTrust, false);
    assert.notEqual(res.status, 'VALID');
  });

  it('11. rejeita OCSP com assinatura inválida como INVALID_EVIDENCE e preserva INDETERMINATE', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
    });

    const ocspCorrupt = await createSyntheticOcspResponse({
      targetCert: fx.docSigner.cert,
      issuerCert: fx.docInter.cert,
      responderCert: fx.docInter.cert,
      responderPrivateKey: fx.docInter.keyPair.privateKey,
      certStatus: 'good',
      corruptSignature: true,
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      ocspResponses: [ocspCorrupt],
    });

    assert.equal(res.revocation.status, 'INVALID_EVIDENCE');
    assert.equal(res.revocation.subIndication, 'REVOCATION_EVIDENCE_INVALID');
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.subIndication, 'REVOCATION_EVIDENCE_INVALID');
    assert.equal(res.persistenceStatus, 'UNVERIFIED');
  });

  it('12. rejeita substituição por OCSP de outro emissor ou certificado', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
    });

    // 12A: Same issuer CA, but different serial number (e.g. 999 instead of 300)
    const ocspOtherSerial = await createSyntheticOcspResponse({
      targetCert: fx.docSigner.cert,
      issuerCert: fx.docInter.cert,
      responderCert: fx.docInter.cert,
      responderPrivateKey: fx.docInter.keyPair.privateKey,
      certStatus: 'good',
      overrideSerialNumber: 99999, // mismatched serial number!
    });

    const res12A = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      ocspResponses: [ocspOtherSerial],
    });

    assert.equal(res12A.status, 'INDETERMINATE');
    assert.equal(res12A.subIndication, 'REVOCATION_UNAVAILABLE');
    assert.equal(res12A.certificateTrust, false);

    // 12B: Same serial number, but different issuer CA
    const otherCaKeys = await generateRsaKeyPair();
    const otherCa = await createSyntheticCertificate({
      serialNumber: 999,
      subjectCn: 'AC TOTALMENTE ESTRANHA',
      subjectKeyPair: otherCaKeys,
    });

    const ocspOtherIssuer = await createSyntheticOcspResponse({
      targetCert: fx.docSigner.cert,
      issuerCert: otherCa.cert,
      responderCert: otherCa.cert,
      responderPrivateKey: otherCaKeys.privateKey,
      certStatus: 'good',
    });

    const res12B = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      ocspResponses: [ocspOtherIssuer],
    });

    assert.equal(res12B.status, 'INDETERMINATE');
    assert.equal(res12B.subIndication, 'REVOCATION_UNAVAILABLE');
    assert.equal(res12B.certificateTrust, false);
  });

  it('13. rejeita respondente OCSP delegado sem autorização adequada (sem id-kp-OCSPSigning ou de outra AC)', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unauthKeys = await generateRsaKeyPair();
    const unsignedPdf = await createSampleUnsignedPdf();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
    });

    // 13A: Delegated responder without id-kp-OCSPSigning
    const delegatedNoEku = await createSyntheticCertificate({
      serialNumber: 251,
      subjectCn: 'RESPONDENTE SEM OCSPSIGNING',
      issuerCert: fx.docInter.cert,
      subjectKeyPair: unauthKeys,
      signingPrivateKey: fx.docInter.keyPair.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ digitalSignature: true }),
        buildExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.2'], true), // clientAuth only
      ],
    });

    const ocspNoEku = await createSyntheticOcspResponse({
      targetCert: fx.docSigner.cert,
      issuerCert: fx.docInter.cert,
      responderCert: delegatedNoEku.cert,
      responderPrivateKey: unauthKeys.privateKey,
      certStatus: 'good',
      extraCerts: [delegatedNoEku.cert],
    });

    const res13A = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      ocspResponses: [ocspNoEku],
    });

    assert.equal(res13A.revocation.status, 'INVALID_EVIDENCE');
    assert.equal(res13A.revocation.subIndication, 'REVOCATION_EVIDENCE_INVALID');
    assert.equal(res13A.status, 'INDETERMINATE');

    // 13B: Delegated responder issued by an unrelated CA (not fx.docInter)
    const foreignCaKeys = await generateRsaKeyPair();
    const foreignCa = await createSyntheticCertificate({
      serialNumber: 777,
      subjectCn: 'AC ESTRANHA',
      subjectKeyPair: foreignCaKeys,
    });
    const delegatedFromForeignCa = await createSyntheticCertificate({
      serialNumber: 778,
      subjectCn: 'RESPONDENTE DE OUTRA AC',
      issuerCert: foreignCa.cert,
      subjectKeyPair: unauthKeys,
      signingPrivateKey: foreignCaKeys.privateKey,
      extensions: [
        buildBasicConstraintsExtension({ cA: false }),
        buildKeyUsageExtension({ digitalSignature: true }),
        buildExtendedKeyUsageExtension([OID_KP_OCSP_SIGNING], true),
      ],
    });

    const ocspForeignCa = await createSyntheticOcspResponse({
      targetCert: fx.docSigner.cert,
      issuerCert: fx.docInter.cert,
      responderCert: delegatedFromForeignCa.cert,
      responderPrivateKey: unauthKeys.privateKey,
      certStatus: 'good',
      extraCerts: [delegatedFromForeignCa.cert],
    });

    const res13B = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      ocspResponses: [ocspForeignCa],
    });

    assert.equal(res13B.revocation.status, 'INVALID_EVIDENCE');
    assert.equal(res13B.revocation.subIndication, 'REVOCATION_EVIDENCE_INVALID');
    assert.equal(res13B.status, 'INDETERMINATE');
  });

  it('14. detecta evidências contraditórias e preserva INDETERMINATE', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
    });

    // Evidence 1: CRL says REVOKED on 2026-02-15
    const crlRevoked = await createSyntheticCrl({
      issuerCert: fx.docInter.cert,
      issuerPrivateKey: fx.docInter.keyPair.privateKey,
      thisUpdate: new Date('2026-02-16T00:00:00Z'),
      nextUpdate: new Date('2026-05-01T00:00:00Z'),
      revokedList: [
        {
          serialNumber: 300,
          revocationDate: new Date('2026-02-15T00:00:00Z'),
          reasonCode: 4,
        },
      ],
    });

    // Evidence 2: OCSP claiming GOOD produced after the revocation date (contradicting revocation)
    const ocspGood = await createSyntheticOcspResponse({
      targetCert: fx.docSigner.cert,
      issuerCert: fx.docInter.cert,
      responderCert: fx.docInter.cert,
      responderPrivateKey: fx.docInter.keyPair.privateKey,
      certStatus: 'good',
      producedAt: new Date('2026-02-20T00:00:00Z'),
      thisUpdate: new Date('2026-02-20T00:00:00Z'),
      nextUpdate: new Date('2026-05-01T00:00:00Z'),
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      crls: [crlRevoked],
      ocspResponses: [ocspGood],
    });

    assert.equal(res.revocation.hasContradictoryEvidence, true);
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.subIndication, 'CONTRADICTORY_REVOCATION_EVIDENCE');
    assert.equal(res.certificateTrust, false);
  });

  it('15. trata relação temporal com a POE (poeTime < revocationDate vs revocationDate <= poeTime vs keyCompromise)', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    // Timestamp at 2026-02-10
    const tsTime = new Date('2026-02-10T14:00:00Z');
    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
      buildTimestampToken: async (sigBytes) =>
        createRfc3161TimestampToken({
          stampedContentBytes: sigBytes,
          genTime: tsTime,
          tsaCert: fx.tsaSigner.cert,
          tsaPrivateKey: fx.tsaSigner.keyPair.privateKey,
          tsaCertificates: [fx.tsaSigner.cert, fx.tsaInter.cert],
        }),
    });

    // TSA chain revocation evidence (TSA is completely trusted: both tsaSigner and tsaInter verified)
    const tsaSignerCrl = await createSyntheticCrl({
      issuerCert: fx.tsaInter.cert,
      issuerPrivateKey: fx.tsaInter.keyPair.privateKey,
      thisUpdate: new Date('2026-02-01T00:00:00Z'),
      nextUpdate: new Date('2026-05-01T00:00:00Z'),
      revokedList: [],
    });

    const tsaInterCrl = await createSyntheticCrl({
      issuerCert: fx.tsaRoot.cert,
      issuerPrivateKey: fx.tsaRoot.keyPair.privateKey,
      thisUpdate: new Date('2026-02-01T00:00:00Z'),
      nextUpdate: new Date('2026-05-01T00:00:00Z'),
      revokedList: [],
    });

    const docInterCrl = await createSyntheticCrl({
      issuerCert: fx.docRoot.cert,
      issuerPrivateKey: fx.docRoot.keyPair.privateKey,
      thisUpdate: new Date('2026-02-01T00:00:00Z'),
      nextUpdate: new Date('2026-05-01T00:00:00Z'),
      revokedList: [],
    });

    // Case 15A: poeTime (2026-02-10) < revocationDate (2026-03-01) for non-compromise reason
    // Proves signature existed strictly BEFORE revocation occurred -> GOOD_AT_POE (VALID)!
    const crlRevAfterPoe = await createSyntheticCrl({
      issuerCert: fx.docInter.cert,
      issuerPrivateKey: fx.docInter.keyPair.privateKey,
      thisUpdate: new Date('2026-03-05T00:00:00Z'),
      nextUpdate: new Date('2026-05-01T00:00:00Z'),
      revokedList: [
        {
          serialNumber: 300,
          revocationDate: new Date('2026-03-01T00:00:00Z'), // > tsTime (2026-02-10)
          reasonCode: 3, // affiliationChanged
        },
      ],
    });

    const res15A = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      trustedTsaRootPems: [fx.tsaRoot.pem],
      verificationTime: new Date('2026-04-01T12:00:00Z'),
      crls: [crlRevAfterPoe, docInterCrl, tsaSignerCrl, tsaInterCrl],
    });

    assert.equal(res15A.temporalValidity.hasTrustedPoe, true);
    assert.equal(res15A.temporalValidity.tsaTrustComplete, true);
    assert.equal(res15A.revocation.status, 'GOOD_AT_POE');
    assert.equal(res15A.certificateTrust, true);
    assert.equal(res15A.status, 'VALID');

    // Case 15B: revocationDate (2026-02-05) <= poeTime (2026-02-10)
    // POE proves t_sig <= poeTime, but does NOT prove t_sig >= revocationDate.
    // Order of events is NOT proven -> conservative policy preserves INDETERMINATE (REVOKED_NO_POE),
    // NEVER declaring INVALID falsely!
    const crlRevBeforePoe = await createSyntheticCrl({
      issuerCert: fx.docInter.cert,
      issuerPrivateKey: fx.docInter.keyPair.privateKey,
      thisUpdate: new Date('2026-02-06T00:00:00Z'),
      nextUpdate: new Date('2026-05-01T00:00:00Z'),
      revokedList: [
        {
          serialNumber: 300,
          revocationDate: new Date('2026-02-05T00:00:00Z'), // <= tsTime (2026-02-10)
          reasonCode: 4, // superseded
        },
      ],
    });

    const res15B = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      trustedTsaRootPems: [fx.tsaRoot.pem],
      verificationTime: new Date('2026-04-01T12:00:00Z'),
      crls: [crlRevBeforePoe, docInterCrl, tsaSignerCrl, tsaInterCrl],
    });

    assert.equal(res15B.revocation.status, 'REVOKED_NO_POE');
    assert.equal(res15B.status, 'INDETERMINATE');
    assert.equal(res15B.subIndication, 'REVOKED_NO_POE');
    assert.notEqual(res15B.status, 'INVALID');

    // Case 15C: Live Issuance with an already revoked certificate (validationContext: 'LIVE_ISSUANCE')
    // Here we have positive proof of signing after revocation -> returns INVALID!
    const res15C = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      trustedTsaRootPems: [fx.tsaRoot.pem],
      verificationTime: new Date('2026-04-01T12:00:00Z'),
      validationContext: 'LIVE_ISSUANCE',
      crls: [crlRevBeforePoe, docInterCrl, tsaSignerCrl, tsaInterCrl],
    });

    assert.equal(res15C.status, 'INVALID');
    assert.equal(res15C.subIndication, 'REVOKED_BEFORE_POE');
    assert.equal(res15C.persistenceStatus, 'INVALID');

    // Case 15D: keyCompromise (reasonCode = 1):
    // Even if poeTime < revocationDate, key compromise may have happened earlier.
    // Without invalidityDate -> INDETERMINATE (REVOKED_KEY_COMPROMISE).
    const crlKeyCompromiseNoInv = await createSyntheticCrl({
      issuerCert: fx.docInter.cert,
      issuerPrivateKey: fx.docInter.keyPair.privateKey,
      thisUpdate: new Date('2026-03-05T00:00:00Z'),
      nextUpdate: new Date('2026-05-01T00:00:00Z'),
      revokedList: [
        {
          serialNumber: 300,
          revocationDate: new Date('2026-03-01T00:00:00Z'), // > tsTime
          reasonCode: 1, // keyCompromise
        },
      ],
    });

    const res15D = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      trustedTsaRootPems: [fx.tsaRoot.pem],
      verificationTime: new Date('2026-04-01T12:00:00Z'),
      crls: [crlKeyCompromiseNoInv, docInterCrl, tsaSignerCrl, tsaInterCrl],
    });

    assert.equal(res15D.status, 'INDETERMINATE');
    assert.equal(res15D.subIndication, 'REVOKED_KEY_COMPROMISE');

    // Case 15E: keyCompromise with invalidityDate and poeTime < invalidityDate -> GOOD_AT_POE (VALID)!
    const crlKeyCompromiseWithInv = await createSyntheticCrl({
      issuerCert: fx.docInter.cert,
      issuerPrivateKey: fx.docInter.keyPair.privateKey,
      thisUpdate: new Date('2026-03-05T00:00:00Z'),
      nextUpdate: new Date('2026-05-01T00:00:00Z'),
      revokedList: [
        {
          serialNumber: 300,
          revocationDate: new Date('2026-03-01T00:00:00Z'),
          reasonCode: 1, // keyCompromise
          invalidityDate: new Date('2026-02-25T00:00:00Z'), // > tsTime (2026-02-10)
        },
      ],
    });

    const res15E = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      trustedTsaRootPems: [fx.tsaRoot.pem],
      verificationTime: new Date('2026-04-01T12:00:00Z'),
      crls: [crlKeyCompromiseWithInv, docInterCrl, tsaSignerCrl, tsaInterCrl],
    });

    assert.equal(res15E.revocation.status, 'GOOD_AT_POE');
    assert.equal(res15E.status, 'VALID');
  });

  it('16. trata revogação sem POE confiável como INDETERMINATE (REVOKED_NO_POE)', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    // No timestamp attached
    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
    });

    const crlRevoked = await createSyntheticCrl({
      issuerCert: fx.docInter.cert,
      issuerPrivateKey: fx.docInter.keyPair.privateKey,
      thisUpdate: new Date('2026-02-01T00:00:00Z'),
      nextUpdate: new Date('2026-05-01T00:00:00Z'),
      revokedList: [
        {
          serialNumber: 300,
          revocationDate: new Date('2026-01-20T00:00:00Z'),
          reasonCode: 0,
        },
      ],
    });

    const crlInter = await createSyntheticCrl({
      issuerCert: fx.docRoot.cert,
      issuerPrivateKey: fx.docRoot.keyPair.privateKey,
      revokedList: [],
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      crls: [crlRevoked, crlInter],
    });

    assert.equal(res.revocation.status, 'REVOKED_NO_POE');
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.subIndication, 'REVOKED_NO_POE');
    assert.equal(res.persistenceStatus, 'UNVERIFIED');
  });

  it('17. detecta revogação de Autoridade Certificadora intermediária (REVOKED_CA_NO_POE)', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
    });

    const crlDocSigner = await createSyntheticCrl({
      issuerCert: fx.docInter.cert,
      issuerPrivateKey: fx.docInter.keyPair.privateKey,
      revokedList: [],
    });

    // Intermediate CA is revoked in Root CA CRL
    const crlInterRevoked = await createSyntheticCrl({
      issuerCert: fx.docRoot.cert,
      issuerPrivateKey: fx.docRoot.keyPair.privateKey,
      thisUpdate: new Date('2026-02-01T00:00:00Z'),
      nextUpdate: new Date('2026-05-01T00:00:00Z'),
      revokedList: [
        {
          serialNumber: 200, // fx.docInter serialNumber
          revocationDate: new Date('2026-01-15T00:00:00Z'),
          reasonCode: 2, // cACompromise
        },
      ],
    });

    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      crls: [crlDocSigner, crlInterRevoked],
    });

    assert.equal(res.revocation.checked, true);
    assert.equal(res.revocation.revokedCertificateRole, 'SIGNER_CA');
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.subIndication, 'REVOKED_CA_NO_POE');
  });

  it('18. trata revogação ou ausência de evidência da TSA adequadamente', async () => {
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

    const crlDocSigner = await createSyntheticCrl({
      issuerCert: fx.docInter.cert,
      issuerPrivateKey: fx.docInter.keyPair.privateKey,
      revokedList: [],
    });
    const crlDocInter = await createSyntheticCrl({
      issuerCert: fx.docRoot.cert,
      issuerPrivateKey: fx.docRoot.keyPair.privateKey,
      revokedList: [],
    });

    // 18A: TSA signer certificate is revoked in TSA intermediate CRL
    const crlTsaRevoked = await createSyntheticCrl({
      issuerCert: fx.tsaInter.cert,
      issuerPrivateKey: fx.tsaInter.keyPair.privateKey,
      thisUpdate: new Date('2026-03-01T00:00:00Z'),
      nextUpdate: new Date('2026-05-01T00:00:00Z'),
      revokedList: [
        {
          serialNumber: 600, // fx.tsaSigner serialNumber
          revocationDate: new Date('2026-03-10T00:00:00Z'),
          reasonCode: 1, // keyCompromise
        },
      ],
    });

    const res18A = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      trustedTsaRootPems: [fx.tsaRoot.pem],
      verificationTime: new Date('2026-04-01T12:00:00Z'),
      crls: [crlDocSigner, crlDocInter, crlTsaRevoked],
    });

    assert.equal(res18A.temporalValidity.tsaTrustComplete, false);
    assert.equal(res18A.status, 'INDETERMINATE');
    assert.equal(res18A.subIndication, 'TSA_REVOKED');

    // 18B: Absence of revocation evidence for TSA chain -> tsaRevocationChecked=false, tsaTrustComplete=false
    const res18B = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      trustedTsaRootPems: [fx.tsaRoot.pem],
      verificationTime: new Date('2026-04-01T12:00:00Z'),
      crls: [crlDocSigner, crlDocInter], // omitted TSA CRLs!
    });

    assert.equal(res18B.temporalValidity.tsaRevocationChecked, false);
    assert.equal(res18B.temporalValidity.tsaTrustComplete, false);
    assert.equal(res18B.status, 'INDETERMINATE');
    assert.equal(res18B.subIndication, 'TSA_REVOCATION_UNAVAILABLE');
  });

  it('19. ausência de resposta de revogação mantém INDETERMINATE (REVOCATION_UNAVAILABLE)', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
    });

    // No crls or ocspResponses supplied
    const res = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
    });

    assert.equal(res.cryptographicIntegrity, true);
    assert.equal(res.chainValidation.valid, true);
    assert.equal(res.rootTrust.trusted, true);
    assert.equal(res.revocation.checked, false);
    assert.equal(res.revocation.status, 'INDETERMINATE');
    assert.equal(res.revocation.source, 'NONE');
    assert.equal(res.certificateTrust, false);
    assert.equal(res.status, 'INDETERMINATE');
    assert.equal(res.subIndication, 'REVOCATION_UNAVAILABLE');
    assert.equal(res.persistenceStatus, 'UNVERIFIED');
  });

  it('20. demonstra resistência a injeção maliciosa: terceiro com CRL/OCSP adulterado não força falso INVALID', async () => {
    const fx = await getStandardPkiAndTsaFixture();
    const unsignedPdf = await createSampleUnsignedPdf();
    const attackerKeys = await generateRsaKeyPair();

    const { signedPdf } = await signPdfWithOptionalTimestamp({
      unsignedPdfBuffer: unsignedPdf,
      signerCert: fx.docSigner.cert,
      signerPrivateKey: fx.docSigner.keyPair.privateKey,
      cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
    });

    // Genuine authentic CRLs proving GOOD
    const genuineDocSignerCrl = await createSyntheticCrl({
      issuerCert: fx.docInter.cert,
      issuerPrivateKey: fx.docInter.keyPair.privateKey,
      revokedList: [], // genuine: signer NOT revoked
    });

    const genuineDocInterCrl = await createSyntheticCrl({
      issuerCert: fx.docRoot.cert,
      issuerPrivateKey: fx.docRoot.keyPair.privateKey,
      revokedList: [],
    });

    // Attacker crafts forged CRL claiming signer is REVOKED, but signed by attacker's unauthorized key
    const forgedRevokedCrl = await createSyntheticCrl({
      issuerCert: fx.docInter.cert,
      issuerPrivateKey: attackerKeys.privateKey, // unauthorized attacker key!
      revokedList: [
        {
          serialNumber: 300,
          revocationDate: new Date('2026-01-01T00:00:00Z'),
          reasonCode: 1,
        },
      ],
    });

    // Attacker crafts forged OCSP claiming signer is REVOKED, signed by attacker's unauthorized key
    const forgedRevokedOcsp = await createSyntheticOcspResponse({
      targetCert: fx.docSigner.cert,
      issuerCert: fx.docInter.cert,
      responderCert: fx.docInter.cert,
      responderPrivateKey: attackerKeys.privateKey, // unauthorized attacker key!
      certStatus: 'revoked',
      revocationDate: new Date('2026-01-01T00:00:00Z'),
    });

    // Scenario A: Only forged evidences supplied. Result MUST be INDETERMINATE, NEVER INVALID!
    const resOnlyForged = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      crls: [forgedRevokedCrl],
      ocspResponses: [forgedRevokedOcsp],
    });

    assert.notEqual(resOnlyForged.status, 'INVALID');
    assert.equal(resOnlyForged.status, 'INDETERMINATE');
    assert.equal(resOnlyForged.subIndication, 'REVOCATION_EVIDENCE_INVALID');
    assert.equal(resOnlyForged.persistenceStatus, 'UNVERIFIED');

    // Scenario B: Genuine evidences supplied along with injected forged ones.
    // Forged evidences are rejected, genuine evidences prove GOOD -> signature is VALID!
    const resWithGenuineAndForged = await padesService.verifyPadesSignature(signedPdf, {
      trustedRootPems: [fx.docRoot.pem],
      verificationTime: new Date('2026-03-15T12:00:00Z'),
      crls: [genuineDocSignerCrl, genuineDocInterCrl, forgedRevokedCrl],
      ocspResponses: [forgedRevokedOcsp],
    });

    assert.notEqual(resWithGenuineAndForged.status, 'INVALID');
    assert.equal(resWithGenuineAndForged.revocation.status, 'GOOD');
    assert.equal(resWithGenuineAndForged.status, 'VALID');
    assert.equal(resWithGenuineAndForged.certificateTrust, true);
    assert.equal(resWithGenuineAndForged.persistenceStatus, 'VALID');
    assert.ok(resWithGenuineAndForged.revocation.rejectedEvidencesCount >= 1);
  });
});
