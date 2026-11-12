// Suspensão (certificateHold) e evidências de revogação que se contradizem, vistas pela
// verificação completa de um PDF assinado. Fixa o comportamento de
// `evaluateSingleCertificateRevocation` nesses caminhos, que as demais suítes não exercitam.
// Tudo aqui é sintético (ver tests/helpers/pades-revocation-fixtures.mjs).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  padesService,
  getStandardPkiAndTsaFixture,
  createSampleUnsignedPdf,
  signPdfWithOptionalTimestamp,
  createRfc3161TimestampToken,
  createSyntheticCrl,
} from './helpers/pades-revocation-fixtures.mjs';

const T = (s) => new Date(s);
const POE = T('2026-02-10T14:00:00Z');
const VERIFY_AT = T('2026-04-01T12:00:00Z');
const SIGNER_SERIAL = 300;
const HOLD_AT = T('2026-03-01T00:00:00Z');

let ctxPromise = null;
async function ctx() {
  if (!ctxPromise) {
    ctxPromise = (async () => {
      const fx = await getStandardPkiAndTsaFixture();
      const sign = async (opts = {}) =>
        (
          await signPdfWithOptionalTimestamp({
            unsignedPdfBuffer: await createSampleUnsignedPdf(),
            signerCert: fx.docSigner.cert,
            signerPrivateKey: fx.docSigner.keyPair.privateKey,
            cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
            claimedSigningTime: T('2026-02-10T13:59:50Z'),
            ...opts,
          })
        ).signedPdf;
      const crl = (issuer, thisUpdate, nextUpdate, revokedList = []) =>
        createSyntheticCrl({
          issuerCert: issuer.cert,
          issuerPrivateKey: issuer.keyPair.privateKey,
          thisUpdate: T(thisUpdate),
          nextUpdate: T(nextUpdate),
          revokedList,
        });
      // Evidência das ACs e da TSA emitida depois da POE (válida para a validação histórica).
      const chainAfterPoe = [
        await crl(fx.docRoot, '2026-02-11T00:00:00Z', '2026-12-01T00:00:00Z'),
        await crl(fx.tsaInter, '2026-02-11T00:00:00Z', '2026-12-01T00:00:00Z'),
        await crl(fx.tsaRoot, '2026-02-11T00:00:00Z', '2026-12-01T00:00:00Z'),
      ];
      // LCR da AC do signatário com o certificado dele na lista, pelo motivo e data dados.
      const signerListed = (thisUpdate, entry) =>
        crl(fx.docInter, thisUpdate, '2026-05-01T00:00:00Z', [
          { serialNumber: SIGNER_SERIAL, ...entry },
        ]);
      return {
        fx,
        crl,
        chainAfterPoe,
        signerListed,
        // Com carimbo do tempo: há prova de que a assinatura existia em POE.
        pdfTs: await sign({
          buildTimestampToken: async (sig) =>
            createRfc3161TimestampToken({
              stampedContentBytes: sig,
              genTime: POE,
              tsaCert: fx.tsaSigner.cert,
              tsaPrivateKey: fx.tsaSigner.keyPair.privateKey,
              tsaCertificates: [fx.tsaSigner.cert, fx.tsaInter.cert],
            }),
        }),
        // Sem carimbo: nada prova quando a assinatura foi feita.
        pdfNoTs: await sign({ claimedSigningTime: T('2026-03-15T14:29:50Z') }),
      };
    })();
  }
  return ctxPromise;
}

const verify = async (pdf, extra = {}) => {
  const { fx } = await ctx();
  return padesService.verifyPadesSignature(pdf, {
    trustedRootPems: [fx.docRoot.pem],
    trustedTsaRootPems: [fx.tsaRoot.pem],
    verificationTime: VERIFY_AT,
    ...extra,
  });
};
const signerSummary = (r) =>
  r.revocation.certificateResults?.find((c) => c.role === 'SIGNER');

describe('suspensão do certificado do signatário (certificateHold)', () => {
  it('suspensão posterior ao carimbo do tempo não atinge a assinatura', async () => {
    const { pdfTs, chainAfterPoe, signerListed } = await ctx();
    const r = await verify(pdfTs, {
      crls: [
        await signerListed('2026-03-05T00:00:00Z', {
          revocationDate: HOLD_AT,
          reasonCode: 6,
        }),
        ...chainAfterPoe,
      ],
    });
    assert.equal(r.status, 'VALID');
    assert.equal(r.isValid, true);
    assert.equal(r.revocation.status, 'GOOD_AT_POE');
    const signer = signerSummary(r);
    assert.equal(signer.status, 'GOOD_AT_POE');
    assert.equal(signer.source, 'CRL');
    assert.equal(signer.isHold, true);
    assert.equal(signer.reasonCode, 6);
    assert.equal(signer.reasonName, 'certificateHold');
    assert.equal(signer.revokedAt.toISOString(), HOLD_AT.toISOString());
  });

  it('suspensão sem prova de data da assinatura fica indeterminada (TRY_LATER)', async () => {
    const { fx, crl, pdfNoTs, signerListed } = await ctx();
    const r = await verify(pdfNoTs, {
      crls: [
        await signerListed('2026-03-05T00:00:00Z', {
          revocationDate: HOLD_AT,
          reasonCode: 6,
        }),
        await crl(fx.docRoot, '2026-02-01T00:00:00Z', '2026-12-01T00:00:00Z'),
      ],
    });
    assert.equal(r.status, 'INDETERMINATE');
    assert.equal(r.subIndication, 'TRY_LATER');
    assert.equal(r.isValid, false);
    assert.equal(r.revocation.status, 'INDETERMINATE');
    assert.equal(r.assessment.knownRevocation, true);
    assert.equal(r.assessment.issuanceAllowed, false);
    const signer = signerSummary(r);
    assert.equal(signer.status, 'CERTIFICATE_HOLD');
    assert.equal(signer.subIndication, 'TRY_LATER');
    assert.equal(signer.isHold, true);
    assert.equal(signer.revokedAt.toISOString(), HOLD_AT.toISOString());
    assert.match(signer.error, /suspenso \(certificateHold\)/);
  });

  it('suspensão contradita por LCR posterior sem o certificado é sinalizada', async () => {
    const { fx, crl, pdfTs, chainAfterPoe, signerListed } = await ctx();
    const r = await verify(pdfTs, {
      crls: [
        await signerListed('2026-03-05T00:00:00Z', {
          revocationDate: HOLD_AT,
          reasonCode: 6,
        }),
        await crl(fx.docInter, '2026-03-10T00:00:00Z', '2026-05-01T00:00:00Z'),
        ...chainAfterPoe,
      ],
    });
    assert.equal(r.status, 'INDETERMINATE');
    assert.equal(r.subIndication, 'CONTRADICTORY_REVOCATION_EVIDENCE');
    assert.equal(r.isValid, false);
    const signer = signerSummary(r);
    assert.equal(signer.status, 'CERTIFICATE_HOLD');
    assert.equal(signer.hasContradictoryEvidence, true);
    assert.equal(signer.subIndication, 'CONTRADICTORY_REVOCATION_EVIDENCE');
    assert.equal(signer.isHold, true);
  });
});

describe('evidências de revogação que discordam entre si', () => {
  it('duas LCRs com datas de revogação diferentes são tratadas como contraditórias', async () => {
    const { pdfTs, chainAfterPoe, signerListed } = await ctx();
    const earlier = await signerListed('2026-03-05T00:00:00Z', {
      revocationDate: T('2026-03-01T00:00:00Z'),
      reasonCode: 4,
    });
    const later = await signerListed('2026-03-06T00:00:00Z', {
      revocationDate: T('2026-03-02T00:00:00Z'),
      reasonCode: 4,
    });
    const summaries = [];
    for (const pair of [
      [earlier, later],
      [later, earlier],
    ]) {
      const r = await verify(pdfTs, { crls: [...pair, ...chainAfterPoe] });
      assert.equal(r.status, 'INDETERMINATE');
      assert.equal(r.isValid, false);
      assert.equal(r.revocation.status, 'REVOKED_NO_POE');
      const signer = signerSummary(r);
      assert.equal(signer.status, 'REVOKED_NO_POE');
      assert.equal(signer.hasContradictoryEvidence, true);
      assert.equal(signer.subIndication, 'CONTRADICTORY_REVOCATION_EVIDENCE');
      // Vale a revogação mais antiga, qualquer que seja a ordem em que as LCRs chegam.
      assert.equal(signer.revokedAt.toISOString(), '2026-03-01T00:00:00.000Z');
      summaries.push(signer);
    }
    assert.deepEqual(summaries[0], summaries[1]);
  });
});
