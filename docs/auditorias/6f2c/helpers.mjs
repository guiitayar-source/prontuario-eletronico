import crypto from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import * as pkijs from 'pkijs';
import * as asn1js from 'asn1js';

import { PadesService } from '../../../lib/signature/pades-service.ts';
import {
  OID_KP_TIME_STAMPING,
  OID_SIGNATURE_TIME_STAMP_TOKEN,
  OID_TST_INFO,
} from '../../../lib/signature/rfc3161-timestamp.ts';
import {
  OID_PKIX_OCSP_BASIC,
  OID_CRL_REASON,
  OID_INVALIDITY_DATE,
} from '../../../lib/signature/revocation-validator.ts';

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


export {
  padesService, getStandardPkiAndTsaFixture, createSampleUnsignedPdf,
  signPdfWithOptionalTimestamp, createRfc3161TimestampToken,
  createSyntheticCrl, createSyntheticOcspResponse,
};
