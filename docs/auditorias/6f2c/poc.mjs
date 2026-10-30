import {
  padesService, getStandardPkiAndTsaFixture, createSampleUnsignedPdf,
  signPdfWithOptionalTimestamp, createRfc3161TimestampToken,
  createSyntheticCrl, createSyntheticOcspResponse,
} from './helpers.mjs';

const fx = await getStandardPkiAndTsaFixture();
const T = (s) => new Date(s);
const show = (label, r) => console.log(label.padEnd(58), '| status=', r.status, '| sub=', r.subIndication,
  '| rev=', r.revocation?.status, '| isValid=', r.isValid, '| src=', r.revocation?.source);

// PDF com carimbo em 2026-02-10T14:00Z (POE)
const tsTime = T('2026-02-10T14:00:00Z');
const { signedPdf: pdfTs } = await signPdfWithOptionalTimestamp({
  unsignedPdfBuffer: await createSampleUnsignedPdf(),
  signerCert: fx.docSigner.cert, signerPrivateKey: fx.docSigner.keyPair.privateKey,
  cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
  claimedSigningTime: T('2026-02-10T13:59:50Z'),
  buildTimestampToken: async (sig) => createRfc3161TimestampToken({
    stampedContentBytes: sig, genTime: tsTime,
    tsaCert: fx.tsaSigner.cert, tsaPrivateKey: fx.tsaSigner.keyPair.privateKey,
    tsaCertificates: [fx.tsaSigner.cert, fx.tsaInter.cert] }),
});
// PDF sem carimbo
const { signedPdf: pdfNoTs } = await signPdfWithOptionalTimestamp({
  unsignedPdfBuffer: await createSampleUnsignedPdf(),
  signerCert: fx.docSigner.cert, signerPrivateKey: fx.docSigner.keyPair.privateKey,
  cmsCertificates: [fx.docSigner.cert, fx.docInter.cert],
  claimedSigningTime: T('2026-03-15T14:29:50Z'),
});

const crl = (issuer, thisUpdate, nextUpdate, revokedList = []) => createSyntheticCrl({
  issuerCert: issuer.cert, issuerPrivateKey: issuer.keyPair.privateKey,
  thisUpdate: T(thisUpdate), nextUpdate: T(nextUpdate), revokedList });
// Evidência "neutra" válida de longo prazo para as ACs e a TSA
const docInterCrl = await crl(fx.docRoot, '2026-02-01T00:00:00Z', '2026-12-01T00:00:00Z');
const tsaSignerCrl = await crl(fx.tsaInter, '2026-02-01T00:00:00Z', '2026-12-01T00:00:00Z');
const tsaInterCrl = await crl(fx.tsaRoot, '2026-02-01T00:00:00Z', '2026-12-01T00:00:00Z');
const base = { trustedRootPems: [fx.docRoot.pem], trustedTsaRootPems: [fx.tsaRoot.pem] };
const others = [docInterCrl, tsaSignerCrl, tsaInterCrl];
const verify = (pdf, crls, extra = {}) => padesService.verifyPadesSignature(pdf, { ...base, crls, ...extra });

console.log('\n== P1: CRL emitida DEPOIS da POE (evidência LTV ideal) é rejeitada após seu nextUpdate');
const crlPrePoe = await crl(fx.docInter, '2026-02-09T00:00:00Z', '2026-02-16T00:00:00Z');
const crlPostPoe = await crl(fx.docInter, '2026-02-10T15:00:00Z', '2026-02-17T15:00:00Z');
let r = await verify(pdfTs, [crlPrePoe, ...others], { verificationTime: T('2026-04-01T12:00:00Z') });
show('P1a CRL [02-09,02-16] (emitida ANTES da POE)', r);
r = await verify(pdfTs, [crlPostPoe, ...others], { verificationTime: T('2026-04-01T12:00:00Z') });
show('P1b CRL [02-10T15,02-17] (emitida DEPOIS da POE)', r);
console.log('     signer summary:', r.revocation.certificateResults?.[0]?.status, '-', r.revocation.certificateResults?.[0]?.error);

console.log('\n== P2: CRL anterior à POE aceita como prova de GOOD apesar de revogação entre thisUpdate e POE');
const crlOld = await crl(fx.docInter, '2026-02-01T00:00:00Z', '2026-05-01T00:00:00Z'); // sem entradas
const crlNew = await crl(fx.docInter, '2026-02-11T00:00:00Z', '2026-05-01T00:00:00Z',
  [{ serialNumber: 300, revocationDate: T('2026-02-05T00:00:00Z'), reasonCode: 4 }]); // superseded em 02-05 < POE
r = await verify(pdfTs, [crlOld, ...others], { verificationTime: T('2026-04-01T12:00:00Z') });
show('P2a só a CRL antiga (thisUpdate 02-01 < revogação 02-05 < POE)', r);
r = await verify(pdfTs, [crlOld, crlNew, ...others], { verificationTime: T('2026-04-01T12:00:00Z') });
show('P2b CRL antiga + CRL nova (lista revogação em 02-05)', r);

console.log('\n== P3: invalidityDate anterior à POE ignorada para motivo != keyCompromise');
for (const reasonCode of [0, undefined, 4]) {
  const c = await crl(fx.docInter, '2026-03-05T00:00:00Z', '2026-05-01T00:00:00Z',
    [{ serialNumber: 300, revocationDate: T('2026-03-01T00:00:00Z'), reasonCode,
       invalidityDate: T('2026-01-15T00:00:00Z') }]);
  r = await verify(pdfTs, [c, ...others], { verificationTime: T('2026-04-01T12:00:00Z') });
  show(`P3 reason=${reasonCode} invalidityDate=01-15 < POE 02-10 < revoked 03-01`, r);
}
{
  const c = await crl(fx.docInter, '2026-03-05T00:00:00Z', '2026-05-01T00:00:00Z',
    [{ serialNumber: 300, revocationDate: T('2026-03-01T00:00:00Z'), reasonCode: 1,
       invalidityDate: T('2026-01-15T00:00:00Z') }]);
  r = await verify(pdfTs, [c, ...others], { verificationTime: T('2026-04-01T12:00:00Z') });
  show('P3-ctrl reason=1 (keyCompromise), mesma invalidityDate', r);
}

console.log('\n== P4: OCSP tryLater (não assinado) é contado como evidência "MATCHED_VALID" de todos os certificados');
const tryLater = await createSyntheticOcspResponse({ targetCert: fx.docSigner.cert, issuerCert: fx.docInter.cert,
  responderCert: fx.docInter.cert, responderPrivateKey: fx.docInter.keyPair.privateKey, responseStatus: 3 });
const signerCrlGood = await crl(fx.docInter, '2026-03-20T00:00:00Z', '2026-05-01T00:00:00Z');
r = await verify(pdfTs, [signerCrlGood, ...others], { verificationTime: T('2026-04-01T12:00:00Z'), ocspResponses: [tryLater] });
show('P4 CRLs válidas + OCSP tryLater sem assinatura', r);
console.log('     sources por certificado:', r.revocation.certificateResults.map((c) => `${c.role}:${c.source}`).join(', '));

console.log('\n== P5: carimbo com revogação da TSA indisponível piora o resultado em relação a NÃO ter carimbo');
r = await verify(pdfNoTs, [signerCrlGood, docInterCrl], { verificationTime: T('2026-04-01T12:00:00Z') });
show('P5a sem carimbo, CRLs atuais do signatário', r);
r = await verify(pdfTs, [signerCrlGood, docInterCrl], { verificationTime: T('2026-04-01T12:00:00Z') });
show('P5b com carimbo, mesmas CRLs (sem CRL da TSA)', r);

console.log('\n== P6: OCSP sem nextUpdate (permitido pela RFC 6960 §2.4/§4.2.2.1) é rejeitado');
const ocspNoNext = await createSyntheticOcspResponse({ targetCert: fx.docSigner.cert, issuerCert: fx.docInter.cert,
  responderCert: fx.docInter.cert, responderPrivateKey: fx.docInter.keyPair.privateKey,
  producedAt: T('2026-04-01T11:00:00Z'), thisUpdate: T('2026-04-01T11:00:00Z'), nextUpdate: null, certStatus: 'good' });
r = await verify(pdfNoTs, [docInterCrl], { verificationTime: T('2026-04-01T12:00:00Z'), ocspResponses: [ocspNoNext] });
show('P6 OCSP good recente sem nextUpdate', r);
console.log('     signer summary:', r.revocation.certificateResults?.[0]?.error);

console.log('\n== P7: certificado comprovadamente revogado (sem POE) => isValid=true no modo padrão');
const crlRevoked = await crl(fx.docInter, '2026-03-02T00:00:00Z', '2026-05-01T00:00:00Z',
  [{ serialNumber: 300, revocationDate: T('2026-03-01T00:00:00Z'), reasonCode: 1 }]);
r = await verify(pdfNoTs, [crlRevoked, docInterCrl], { verificationTime: T('2026-04-01T12:00:00Z') });
show('P7a VERIFICATION (padrão), keyCompromise em 03-01', r);
r = await verify(pdfNoTs, [crlRevoked, docInterCrl], { verificationTime: T('2026-04-01T12:00:00Z'), validationContext: 'LIVE_ISSUANCE' });
show('P7b LIVE_ISSUANCE', r);

console.log('\n== P8: TSA revogada DEPOIS do genTime por motivo administrativo descarta a POE');
const tsaRevLater = await crl(fx.tsaInter, '2026-03-21T00:00:00Z', '2026-05-01T00:00:00Z',
  [{ serialNumber: 600, revocationDate: T('2026-03-20T00:00:00Z'), reasonCode: 5 }]); // cessationOfOperation
r = await verify(pdfTs, [crlPrePoe, crlOld, docInterCrl, tsaRevLater, tsaInterCrl], { verificationTime: T('2026-04-01T12:00:00Z') });
show('P8 TSA cessationOfOperation em 03-20 > genTime 02-10', r);
