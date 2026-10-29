# Auditoria 6F.2C — revogação CRL/OCSP + PAdES + cadeia X.509 + RFC 3161 (somente leitura)

## 1) O que li
- Branch `work/checkpoint-lote-1-2026-10-27`, HEAD `ffa542a` (fix: validate RFC3161 timestamps…). Working tree:
  - Modificados: `lib/signature/icp-chain.ts` (+1: ocsp-nocheck como extensão crítica reconhecida), `lib/signature/pades-service.ts`, `lib/signature/rfc3161-timestamp.ts`, `lib/signature/types.ts`.
  - Não rastreados: `lib/signature/revocation-validator.ts` (3014 linhas), `tests/pades-revocation-poe.test.mjs` (1993 linhas, 20 casos).
- Li integralmente `revocation-validator.ts`, o diff dos 4 modificados, o trecho de decisão de status de `pades-service.ts` (l. 960–1292), `evaluateTemporalValidityAndPoe` em `rfc3161-timestamp.ts` (l. 1080–1585), os helpers do teste, `ARQUITETURA_ASSINATURAS.md` e `CLAUDE.md`. Conferi chamadores de `verifyPadesSignature` (`document-signing-service.ts:406`, `document-signing-attempts.ts:191/220/385`, `lib/sncr/signing.ts:77/151`).
- Nada foi gravado no repositório (`git status` idêntico antes/depois). Provas em `/tmp/auditoria-6f2c.XvEF/`.

## 2) Testes rodados (sem banco)
| arquivo | resultado |
|---|---|
| tests/pades-revocation-poe.test.mjs | 20/20 pass |
| tests/pades-rfc3161-poe.test.mjs | 13/13 pass |
| tests/pades-x509-chain-trust.test.mjs | 10/10 pass |
| tests/pades-pdf-integrity.test.mjs | 13/13 pass |
| tests/digital-signature.test.mjs | 25/25 pass |

Os testes usam criptografia real (CRL/OCSP/TST assinados com chaves RSA geradas via pkijs), não mocks que contornam a verificação.

## 3) Achados (por severidade)

### A1 — ALTA — Revogação não tem efeito nenhum em produção
- Onde: todos os chamadores de `verifyPadesSignature` (`document-signing-service.ts:406`, `document-signing-attempts.ts:191,220,385`, `sncr/signing.ts:77,151`) chamam sem `crls`/`ocspResponses`/`validationContext`; não há busca de CRL/OCSP (CDP/AIA) nem leitura de /DSS ou de CRLs do CMS (`embeddedCmsCrls` nunca é passado: `pades-service.ts` ~l.1120 → `revocation-validator.ts:2652,2670`, então `INJECTED_AND_EMBEDDED_LTV` não faz nada).
- Classificação: DEFEITO COMPROVADO (grep). Em produção `evaluateDocumentRevocation` sai sempre em `revocation-validator.ts:2677` → INDETERMINATE/REVOCATION_UNAVAILABLE.
- Impacto: outro. Nenhum documento assinado chega a VALID, e um certificado revogado nunca é detectado, nem na emissão (a assinatura ao vivo não usa `LIVE_ISSUANCE`, que é o único caminho que faz a revogação virar INVALID).
- Correção: decidir explicitamente a origem da evidência (buscar CRL/OCSP no momento da assinatura e guardar no DSS/banco) e passar `validationContext: 'LIVE_ISSUANCE'` na verificação pré-gravação; enquanto isso, documentar que 6F.2C é só a biblioteca.

### A2 — ALTA — `isValid = true` para certificado comprovadamente revogado
- Onde: `pades-service.ts:1232` (`isValid = cryptographicIntegrity && status !== 'INVALID'` quando `requireFullTrust` não é passado) combinado com `revocation-validator.ts:2316-2341` (revogado sem POE → REVOKED_NO_POE → INDETERMINATE).
- Classificação: DEFEITO COMPROVADO (prova P7): CRL autêntica revoga o signatário por keyCompromise em 03-01, verificação em 04-01 → `status=INDETERMINATE, isValid=true`. Com `LIVE_ISSUANCE`, `INVALID, isValid=false`.
- Impacto: VALID indevido no nível da API. Todos os chamadores decidem por `isValid`, então, assim que a evidência for injetada (A1), uma assinatura feita com certificado já revogado passa a gravação e a recuperação.
- Correção: os chamadores de emissão e recuperação devem usar `LIVE_ISSUANCE` e/ou `requireFullTrust`, ou `isValid` deve ser falso quando `revocation.status` for REVOKED_* ou CERTIFICATE_HOLD.

### A3 — MÉDIA — Evidência LTV "ideal" (CRL/OCSP emitida depois da POE) é rejeitada quando fica velha
- Onde: `revocation-validator.ts:1016-1041` (CRL) e `1743-1768` (OCSP). Aceita só `thisUpdate ≤ ref ≤ nextUpdate` ou (`ref ≤ thisUpdate` E `verificationTime ≤ nextUpdate`).
- Classificação: DEFEITO COMPROVADO (P1): POE em 02-10T14:00. CRL [02-09, 02-16] (emitida antes da POE) → VALID/GOOD_AT_POE. CRL [02-10T15:00, 02-17T15:00] (emitida 1 h depois da POE, a que um PAdES-LT guardaria) → INDETERMINATE/REVOCATION_EVIDENCE_INVALID ("CRL vencida ou inadequada…").
- Impacto: rejeição indevida. Validação de longo prazo (ETSI EN 319 102-1 §5.6.2 / 319 142 LTV) fica impossível com a evidência correta depois do nextUpdate dela, e é aceita justamente a evidência mais fraca (ver A4).
- Correção: com POE confiável, aceitar evidência com `poeTime ≤ thisUpdate` (de preferência dentro de uma janela de tolerância/grace) independentemente de `verificationTime ≤ nextUpdate`, desde que `thisUpdate ≤ validTo` do certificado (ou ExpiredCertsOnCRL).

### A4 — MÉDIA — CRL emitida antes da POE aceita como prova de não revogação na POE
- Onde: `revocation-validator.ts:1016-1017` (`coversReferenceDirectly`) e `1743-1744` (OCSP), mais `2454-2471` (GOOD → GOOD_AT_POE).
- Classificação: DEFEITO COMPROVADO (P2): signatário revogado (superseded) em 02-05, POE em 02-10. Com só a CRL de 02-01 (sem entradas) → VALID/GOOD_AT_POE. Com a CRL de 02-11 junto → INDETERMINATE/REVOKED_NO_POE. O resultado depende de qual evidência é entregue.
- Impacto: VALID indevido e revogação histórica errada. Contraria a regra de frescor/grace period (ETSI EN 319 102-1 §5.2.5 "revocation freshness checker"; o perfil CAdES/PAdES espera evidência emitida depois do best-signature-time). O teste 15A valida exatamente esse padrão (CRL `docInterCrl` de 02-01 para POE de 02-10).
- Correção: para concluir GOOD na POE, exigir `thisUpdate ≥ poeTime` (com tolerância configurável); com evidência anterior, devolver INDETERMINATE/TRY_LATER (ou FRESHNESS).

### A5 — MÉDIA — `invalidityDate` ignorada para motivos diferentes de comprometimento (inclusive motivo ausente ou unspecified)
- Onde: `revocation-validator.ts:2101-2102` (só 1, 2 e 10 são "compromise") e `2292-2313` (GOOD_AT_POE se `poeTime < revokedAt`, sem olhar a invalidityDate).
- Classificação: DEFEITO COMPROVADO (P3): revogação em 03-01, invalidityDate 01-15, POE 02-10. reason=0, reason ausente e reason=4 → VALID/GOOD_AT_POE. Controle com reason=1 → INDETERMINATE/REVOKED_KEY_COMPROMISE.
- Impacto: VALID indevido. RFC 5280 §5.3.2: invalidityDate é a data em que o certificado se tornou inválido; motivo ausente equivale a unspecified, que pode esconder um comprometimento.
- Correção: usar `min(revokedAt, invalidityDate)` como instante efetivo para qualquer motivo, e tratar reason ausente/0 de forma conservadora quando houver invalidityDate anterior à POE.

### A6 — BAIXA — Carimbo sem revogação da TSA rebaixa assinatura que seria VALID sem carimbo
- Onde: `pades-service.ts:1137-1149` (`tsaTrustSatisfiedIfApplicable`) e `revocation-validator.ts:2703-2713` (sem POE completa a revogação é avaliada no instante da verificação e dá GOOD).
- Classificação: DEFEITO COMPROVADO (P5): mesmo signatário e mesmas CRLs atuais. Sem carimbo → VALID. Com carimbo cuja TSA não tem CRL → INDETERMINATE/TSA_REVOCATION_UNAVAILABLE, embora `revocation=GOOD`.
- Impacto: rejeição indevida (ETSI: a validação básica no tempo atual já bastaria).
- Correção: quando a POE não estiver completa, cair para a validação no instante atual (se o certificado estiver vigente e GOOD agora) em vez de exigir a TSA.

### A7 — BAIXA — OCSP sem `nextUpdate` é rejeitado como INVALID_EVIDENCE
- Onde: `revocation-validator.ts:1661-1676`.
- Classificação: DEFEITO COMPROVADO (P6): OCSP good, assinado pela AC, thisUpdate e producedAt 1 h antes da verificação, sem nextUpdate → INDETERMINATE/REVOCATION_EVIDENCE_INVALID.
- Impacto: rejeição indevida. RFC 6960 §2.4/§4.2.2.1 permitem nextUpdate ausente ("informação mais nova sempre disponível").
- Correção: sem nextUpdate, aceitar quando `thisUpdate` estiver dentro de uma janela de frescor configurável em relação ao tempo de referência.

### A8 — BAIXA — OCSP `tryLater` (não assinado) vira evidência "MATCHED_VALID" de todos os certificados
- Onde: `revocation-validator.ts:1214-1222`. Retorna antes de casar o CertID e de qualquer assinatura.
- Classificação: DEFEITO COMPROVADO (P4): com CRLs válidas mais um tryLater, `source` vira `BOTH` em SIGNER, SIGNER_CA, TSA_SIGNER e TSA_CA. Sem GOOD, qualquer terceiro rebaixa tudo para TRY_LATER.
- Impacto: outro (diagnóstico falso, rebaixamento a INDETERMINATE). Não gera VALID indevido.
- Correção: tratar respostas não-successful como "sem evidência" (fora de `validEvaluations`) e não contá-las em `source`.

### A9 — BAIXA (política) — TSA revogada depois do genTime por motivo administrativo descarta a POE
- Onde: `revocation-validator.ts:2175-2200`.
- Classificação: DEFEITO COMPROVADO (P8): TSA revogada por cessationOfOperation em 03-20, genTime 02-10 → INDETERMINATE/TSA_REVOKED.
- Impacto: rejeição indevida em parte. ETSI aceita isso sem POE do próprio carimbo, mas o motivo e a data não são considerados. Defensável; registrar como política.
- Correção: quando houver POE do carimbo (archive timestamp ou DocTimeStamp posterior) e motivo não for comprometimento, manter a POE.

### A10 — BAIXA — Escolha da POE mais antiga ignora `tsaTrustComplete`
- Onde: `rfc3161-timestamp.ts:1245,1312,1378`. Candidatos entram com `validAndTrusted` (sem exigir revogação da TSA) e vence o mais antigo; `evaluateDocumentRevocation:2703` exige `tsaTrustComplete` só do vencedor.
- Classificação: RISCO TEÓRICO. Com dois carimbos (o mais antigo com TSA sem CRL e o posterior completo), o resultado fica INDETERMINATE em vez de usar a POE completa.
- Impacto: rejeição indevida.
- Correção: escolher a POE mais antiga entre as completas, ou avaliar cada uma.

### A11 — BAIXA — `tsaRevocationSummaries` de carimbo não escolhido (ou com POE externa) contamina o resultado
- Onde: `rfc3161-timestamp.ts` (`lastTsDiag` entra no diag da EXTERNAL_POE) e `revocation-validator.ts:2863-2893`.
- Classificação: RISCO TEÓRICO. TSA revogada em um carimbo irrelevante deixa INDETERMINATE mesmo com POE externa válida.
- Impacto: rejeição indevida.
- Correção: só considerar os resumos da TSA cuja POE foi efetivamente usada.

### A12 — INFO
- `reasonCode` 7 e >10 viram `'unknown'` e são tratados como não-comprometimento (`:89-115`). RFC 5280 §5.3.1: o valor 7 não é usado; melhor tratar como evidência malformada.
- `removeFromCRL` (8) numa CRL base é tratado como REVOKED (`:1099`). RFC 5280 só admite esse motivo em delta; o resultado é conservador.
- Delta CRL, CRL indireta, onlySomeReasons e IDP com nameRelativeToCRLIssuer são sempre SCOPE_INCOMPATIBLE (`:857-968`). Conservador, mas rejeita esquemas legítimos de AC.
- `normalizeSerialHex` (`:139-158`) remove o 0x00 inicial, então os seriais 0x00FF (255) e 0xFF (−1) colidem. Só importa com serial negativo (não conforme).
- Código morto: `targetNode.isSelfIssued && i === length-1` nunca executa (`:2551`, `:2746`), porque o laço vai até `length-2`.
- `icp-chain.ts:53` aceita ocsp-nocheck crítico em qualquer certificado da cadeia (inócuo).
- Não há tratamento de nonce, o que é correto para evidência offline.

## 4) Lacunas de teste
- Não há caso com evidência emitida depois da POE e já vencida (A3), com CRL anterior à POE mais revogação no intervalo (A4), com invalidityDate em motivo diferente de compromise (A5), com OCSP sem nextUpdate (A7), com `responseStatus: 3` (A8) nem com certificateHold/reasonCode 6 de ponta a ponta (0 ocorrências).
- Nenhum teste com RSA-PSS ou ECDSA (CRL/OCSP/TSA), SHA-1 no CertID, responderID byKey, várias SingleResponse, OCSP de AC intermediária pela raiz, `INJECTED_AND_EMBEDDED_LTV` ou EXTERNAL_POE combinada com revogação.
- Nenhum teste prende o contrato de `isValid` diante de REVOKED_NO_POE (A2), nem a ausência de evidência nos chamadores reais (A1).
- O teste 15A consagra o padrão de A4 (CRL de 02-01 como prova para POE de 02-10).

## 5) Verificado e considerado correto
- Revogação só é avaliada sobre cadeia válida até âncora confiável (`pades-service.ts:1113`). CRL/OCSP forjados não forçam INVALID: INVALID_EVIDENCE leva a INDETERMINATE (teste 20).
- CRL: emissor = AC do alvo; algoritmo externo = interno; lista de algoritmos permitidos; AC com cA e cRLSign; AKI×SKI; assinatura verificada com a chave da AC; extensões críticas desconhecidas rejeitadas; thisUpdate dentro da vigência da AC e não no futuro; nextUpdate obrigatório; CRL posterior ao vencimento do alvo não serve como GOOD; escopo IDP de usuário/AC verificado.
- OCSP: responseStatus ≠ 0 rejeitado; responseType basic; CertID com hash do nome e da chave do emissor e serial (comparação em tempo constante); CertID de outro certificado é ignorado e nunca substitui evidência; assinatura verificada contra o responderID; responder delegado emitido e assinado diretamente pela AC, com EKU OCSPSigning, cA=false e vigente em producedAt; revogação do delegado checada por CRL ou nocheck; unknown nunca vira good; status revoked lê revocationTime e motivo.
- Regra temporal: `revokedAt ≤ poeTime` nunca vira INVALID (só INDETERMINATE); `poeTime < revokedAt` com motivo não-compromise dá GOOD_AT_POE; keyCompromise exige invalidityDate posterior à POE; signingTime declarado nunca é usado como prova; hold com POE anterior dá GOOD_AT_POE, sem POE dá TRY_LATER; GOOD×REVOKED contraditórios nunca são promovidos.
- TSA: revogação avaliada na cadeia da TSA (sem a âncora); TSA revogada perde a POE mas não invalida a assinatura; `tsaTrustComplete` exige GOOD em todos os certificados da cadeia.
- Tipos: os estados de `CertificateRevocationCheckSummary` e de `PadesRevocationResult` são consumidos de forma coerente em `pades-service.ts`; `persistenceStatus` mapeia INDETERMINATE para UNVERIFIED.

## Scripts de prova
Diretório: `/tmp/auditoria-6f2c.XvEF/`
1. `helpers.mjs`: linhas 1–790 de `tests/pades-revocation-poe.test.mjs`, com imports reescritos para caminhos absolutos e os helpers exportados. Gerado com:
```sh
R=/home/noteconsultorio/Projetos/prontuario-eletronico; D=/tmp/auditoria-6f2c.XvEF
sed -n 1,790p $R/tests/pades-revocation-poe.test.mjs | sed -e "s#'\.\./lib/#'$R/lib/#g" \
 -e "s#from 'pkijs'#from '$R/node_modules/pkijs/build/index.js'#" \
 -e "s#from 'asn1js'#from '$R/node_modules/asn1js/build/index.js'#" \
 -e "s#from 'pdf-lib'#from '$R/node_modules/pdf-lib/cjs/index.js'#" \
 -e "/import { describe, it } from 'node:test';/d" > $D/helpers.mjs
# + export { padesService, getStandardPkiAndTsaFixture, createSampleUnsignedPdf, signPdfWithOptionalTimestamp, createRfc3161TimestampToken, createSyntheticCrl, createSyntheticOcspResponse };
```
2. `poc.mjs`: conteúdo abaixo. Rodar com `cd /tmp/auditoria-6f2c.XvEF && node poc.mjs`.
```js
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
```

Saída obtida:
```

== P1: CRL emitida DEPOIS da POE (evidência LTV ideal) é rejeitada após seu nextUpdate
P1a CRL [02-09,02-16] (emitida ANTES da POE)               | status= VALID | sub= undefined | rev= GOOD_AT_POE | isValid= true | src= CRL
P1b CRL [02-10T15,02-17] (emitida DEPOIS da POE)           | status= INDETERMINATE | sub= REVOCATION_EVIDENCE_INVALID | rev= INVALID_EVIDENCE | isValid= true | src= CRL
     signer summary: INVALID_EVIDENCE - CRL vencida ou inadequada para a data de referência (2026-02-10T14:00:00.000Z): janela [2026-02-10T15:00:00.000Z, 2026-02-17T15:00:00.000Z].

== P2: CRL anterior à POE aceita como prova de GOOD apesar de revogação entre thisUpdate e POE
P2a só a CRL antiga (thisUpdate 02-01 < revogação 02-05 < POE) | status= VALID | sub= undefined | rev= GOOD_AT_POE | isValid= true | src= CRL
P2b CRL antiga + CRL nova (lista revogação em 02-05)       | status= INDETERMINATE | sub= REVOKED_NO_POE | rev= REVOKED_NO_POE | isValid= true | src= CRL

== P3: invalidityDate anterior à POE ignorada para motivo != keyCompromise
P3 reason=0 invalidityDate=01-15 < POE 02-10 < revoked 03-01 | status= VALID | sub= undefined | rev= GOOD_AT_POE | isValid= true | src= CRL
P3 reason=undefined invalidityDate=01-15 < POE 02-10 < revoked 03-01 | status= VALID | sub= undefined | rev= GOOD_AT_POE | isValid= true | src= CRL
P3 reason=4 invalidityDate=01-15 < POE 02-10 < revoked 03-01 | status= VALID | sub= undefined | rev= GOOD_AT_POE | isValid= true | src= CRL
P3-ctrl reason=1 (keyCompromise), mesma invalidityDate     | status= INDETERMINATE | sub= REVOKED_KEY_COMPROMISE | rev= REVOKED_NO_POE | isValid= true | src= CRL

== P4: OCSP tryLater (não assinado) é contado como evidência "MATCHED_VALID" de todos os certificados
P4 CRLs válidas + OCSP tryLater sem assinatura             | status= VALID | sub= undefined | rev= GOOD_AT_POE | isValid= true | src= BOTH
     sources por certificado: SIGNER:BOTH, SIGNER_CA:BOTH, TSA_SIGNER:BOTH, TSA_CA:BOTH

== P5: carimbo com revogação da TSA indisponível piora o resultado em relação a NÃO ter carimbo
P5a sem carimbo, CRLs atuais do signatário                 | status= VALID | sub= undefined | rev= GOOD | isValid= true | src= CRL
P5b com carimbo, mesmas CRLs (sem CRL da TSA)              | status= INDETERMINATE | sub= TSA_REVOCATION_UNAVAILABLE | rev= GOOD | isValid= true | src= CRL

== P6: OCSP sem nextUpdate (permitido pela RFC 6960 §2.4/§4.2.2.1) é rejeitado
P6 OCSP good recente sem nextUpdate                        | status= INDETERMINATE | sub= REVOCATION_EVIDENCE_INVALID | rev= INVALID_EVIDENCE | isValid= true | src= CRL
     signer summary: Período temporal (thisUpdate / nextUpdate / producedAt) da resposta OCSP ausente ou incompatível.

== P7: certificado comprovadamente revogado (sem POE) => isValid=true no modo padrão
P7a VERIFICATION (padrão), keyCompromise em 03-01          | status= INDETERMINATE | sub= REVOKED_NO_POE | rev= REVOKED_NO_POE | isValid= true | src= CRL
P7b LIVE_ISSUANCE                                          | status= INVALID | sub= REVOKED_BEFORE_POE | rev= REVOKED_BEFORE_POE | isValid= false | src= CRL

== P8: TSA revogada DEPOIS do genTime por motivo administrativo descarta a POE
P8 TSA cessationOfOperation em 03-20 > genTime 02-10       | status= INDETERMINATE | sub= TSA_REVOKED | rev= INDETERMINATE | isValid= true | src= CRL
```
