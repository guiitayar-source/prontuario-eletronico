# Lote 6F.2C-R — correção dos achados da auditoria 6F.2C

Branch `work/checkpoint-lote-1-2026-10-27`. Auditoria original: `RELATORIO.md` (gerada em
`/tmp/auditoria-6f2c.XvEF/`, preservada aqui). Reproduções: `poc.mjs` + `helpers.mjs`
(`cd docs/auditorias/6f2c && node poc.mjs`). Saídas: `saida-antes.txt`, `saida-depois.txt`.
Regressão independente: `tests/pades-revocation-6f2c-r.test.mjs` (`regressao-antes.txt` = código
original, 20 de 22 falham; `regressao-depois.txt` = 22/22).

> A PoC original usa CRLs da TSA emitidas **antes** do carimbo (02-01 para POE 02-10). Pela
> política nova isso deixa a TSA sem revogação comprovada, então na saída "depois" vários casos
> caem para INDETERMINATE por causa da TSA, e não do signatário. Os testes de regressão usam
> evidências da TSA emitidas depois da POE e isolam cada defeito.

## 1. Defeitos reproduzidos e causa

| # | Defeito | Causa |
|---|---|---|
| A2 | `isValid=true` com revogação comprovada (REVOKED_NO_POE) | `isValid = integridade && status !== 'INVALID'`; os consumidores usavam `isValid` como autorização e a emissão não usava `LIVE_ISSUANCE` |
| A3 | CRL/OCSP emitidos depois da POE recusados quando já vencidos | a janela exigia `verificationTime ≤ nextUpdate` mesmo na validação histórica |
| A4 | CRL anterior à POE aceita como prova de GOOD na POE; o resultado dependia do subconjunto de evidências | `thisUpdate ≤ poeTime ≤ nextUpdate` era aceito como prova na POE |
| A5 | `invalidityDate` ignorada fora de keyCompromise | só os motivos 1/2/10 consultavam `invalidityDate` |
| A7 | OCSP sem `nextUpdate` sempre recusado | `!nextUpdate` virava INVALID_EVIDENCE |
| A8 | OCSP `tryLater` (sem assinatura) contado como evidência de todos os certificados | retornava `MATCHED_VALID` antes de casar o CertID |
| A10 | carimbo antigo de TSA sem revogação comprovada escondia carimbo completo posterior | a POE escolhida era a mais antiga, sem olhar `tsaTrustComplete` |
| A11 | revogação da TSA de um carimbo não usado contaminava o resultado do documento | `tsaRevocationSummaries` era repassado qualquer que fosse a POE |

## 2. Correções

**A2: semântica de validação** (`lib/signature/verification-policy.ts`, `types.ts`, `pades-service.ts`).
`verifyPadesSignature` passa a calcular `isValid`, `persistenceStatus` e o novo
`assessment` numa regra única, aplicada a todos os caminhos de retorno:

| Pergunta | Campo | Regra |
|---|---|---|
| Integridade criptográfica comprovada? | `assessment.cryptographicIntegrity` | PDF + CMS conferem |
| Identidade do certificado? | `assessment.signerIdentity` (+ `chainTrusted`) | titular extraído, CPF = CN, não-AC, keyUsage; ICP-Brasil só com `chainTrusted` |
| Confiança plena? | `assessment.fullTrust` | `status === 'VALID'` |
| Pode emitir? | `assessment.issuanceAllowed` | integridade + identidade + não INVALID + **nenhuma revogação/suspensão conhecida** na cadeia do signatário |
| Estado persistido | `persistenceStatus` | VALID só se VALID; INVALID só se INVALID; INDETERMINATE → UNVERIFIED |

- `isValid` passou a significar "não rejeitada": é falso também com revogação conhecida.
- `INDETERMINATE` por falta de evidência (REVOCATION_UNAVAILABLE) **não** bloqueia a emissão. É o
  caso de todas as assinaturas reais enquanto A1 estiver aberto, e há um teste que fixa isso.
- Consumidores de emissão (`document-signing-attempts.ts`, rota `test-sign` em
  `document-signing-service.ts`, simulação SNCR) verificam com `validationContext: 'LIVE_ISSUANCE'`
  e decidem por `assessment.issuanceAllowed`. `assertSigningCertificate` (também usado na
  recuperação) exige `issuanceAllowed`.
- Evoluções gravavam `verification_status: 'VALID'` sem consultar revogação; agora gravam
  `UNVERIFIED`. O CHECK atual aceita esse valor e o insert não passa por `*_write`, então não é
  preciso migração. O default da coluna continua `'VALID'`; trocar o default exigiria migração
  (pendência). A verificação de evolução devolve `status: INDETERMINATE` e `isTrusted: false`.
- Telas: o selo verde da evolução passou a dizer "Assinatura íntegra, cadeia ICP-Brasil
  confirmada" (o texto já avisa que a revogação não é consultada). O aviso de documento assinado
  não diz mais "assinatura digital válida". O teste de assinatura informa quando a confiança plena
  não foi atingida.
- Simulações seguem permitidas (cadeia sintética: `chainTrusted=false`, `fullTrust=false`,
  `issuanceAllowed=true`) e continuam marcadas como `local_simulation`/"SIMULAÇÃO LOCAL".

**A3/A4/A5/A7/A8** (`revocation-validator.ts`): a política de frescor está descrita abaixo.
- Evidência autêntica, mas sem frescor, deixou de ser `INVALID_EVIDENCE` e virou `NOT_FRESH`,
  com resultado INDETERMINATE/TRY_LATER (ETSI EN 319 102-1 §5.2.5.4).
- Evidência de revogação vale sem exigência de frescor, porque a revogação é permanente.
- CRL ou OCSP que declara uma revogação posterior ao próprio `thisUpdate`/`producedAt` agora é
  rejeitada.
- Instante efetivo de revogação = `min(revocationDate, invalidityDate)`, qualquer que seja o motivo.
  Com motivos de comprometimento (1, 2, 10) ou códigos não reconhecidos (7, > 10), a POE só
  supera a revogação se houver `invalidityDate`.
- Agregação: as evidências são ordenadas por uma chave total antes da decisão.
  - A revogação prevalece sobre GOOD.
  - Um GOOD emitido em/depois da data de revogação ou suspensão é contraditório
    (INDETERMINATE), mesmo quando lhe falta frescor.
  - Entre vários GOOD, o representante é o mais recente.
- `tryLater` é `UNAVAILABLE`: não conta em `source` e, sozinho, dá TRY_LATER.
- Respondente OCSP delegado: o instante efetivo também vale para ele, e o comprometimento da sua
  chave invalida qualquer resposta, porque o `producedAt` pode ser retroativo.

**A10/A11** (`rfc3161-timestamp.ts`, `pades-service.ts`):
- Entre as POEs confiáveis, as completas têm preferência (TSA com revogação comprovada, ou POE
  externa autenticada); dentro delas vence a mais antiga.
- Só a TSA da POE efetivamente usada entra na revogação do documento.

**Testes existentes ajustados** (`tests/pades-revocation-poe.test.mjs`):
- Caso 3: CRL vencida agora é TRY_LATER, não INVALID_EVIDENCE.
- Casos 6 e 18A: as CRLs listavam uma revogação posterior ao próprio `thisUpdate`.
- Caso 15: as CRLs das ACs e da TSA eram anteriores à POE, o próprio padrão A4. Passaram a 02-11.
- Os helpers foram movidos para `tests/helpers/pades-revocation-fixtures.mjs`, que agora aceita
  vários carimbos por assinatura.

## 3. Política temporal resultante

| Situação | Referência | Evidência de **não revogação** aceita | Evidência de **revogação** |
|---|---|---|---|
| Sem POE confiável completa (validação atual) | instante da verificação | `thisUpdate ≤ agora ≤ nextUpdate` (RFC 5280 §6.3.3; RFC 6960 §4.2.2.1); OCSP sem nextUpdate: `agora − thisUpdate ≤ maxAgeWithoutNextUpdateSeconds` (padrão 24 h); limite opcional `maxAgeSeconds` | sempre (fato permanente) → REVOKED_NO_POE; com `LIVE_ISSUANCE` → INVALID |
| Com POE confiável completa (validação histórica) | `poeTime` | `thisUpdate ≥ poeTime + gracePeriodSeconds` (padrão 0) e `thisUpdate ≤ notAfter` do certificado; **não** precisa estar vigente agora | `poeTime + grace < min(revocationDate, invalidityDate)` → GOOD_AT_POE; senão REVOKED_NO_POE; compromisso sem invalidityDate → REVOKED_KEY_COMPROMISE |
| Cadeia da TSA | `genTime` | igual à histórica | qualquer revogação retira a POE (política, ver A9) |
| Respondente OCSP delegado | `producedAt` | CRL vigente em producedAt ou emitida depois dele | revogado se o efetivo for ≤ producedAt ou se o motivo for comprometimento |

Evidência emitida antes da POE nunca comprova não revogação na POE. Se faltar evidência
posterior, o resultado é INDETERMINATE/TRY_LATER (o padrão CAdES/PAdES de *grace period*).
Opções em `PadesVerificationOptions.revocationFreshness`.

## 4. Estado dos consumidores de `verifyPadesSignature`

| Consumidor | Contexto | Decide por | Persistido |
|---|---|---|---|
| `document-signing-attempts.ts` (emissão) | LIVE_ISSUANCE | `assessment.issuanceAllowed` + `assertSigningCertificate` | `UNVERIFIED` (forçado também pelo trigger `signing_attempt_metadata_guard`) |
| `document-signing-attempts.ts` (recuperação/entrega) | VERIFICATION | `assertSigningCertificate` → `issuanceAllowed` | idem |
| `document-signing-service.ts` (`test-sign`) | LIVE_ISSUANCE | `issuanceAllowed` | não grava assinatura; a tela informa "confiança plena não comprovada" |
| `lib/sncr/signing.ts` (simulação) | LIVE_ISSUANCE / VERIFICATION | `issuanceAllowed` / `isValid` | `UNVERIFIED` (SQL), `local_simulation` |
| Evolução (CMS, não PAdES) | — | integridade + certificado + cadeia | passa a gravar `UNVERIFIED` |

Em produção nenhum consumidor recebe CRL/OCSP (A1), então o resultado real continua
INDETERMINATE/REVOCATION_UNAVAILABLE, gravado como UNVERIFIED, e a emissão segue liberada.

## 5. Fase 3 — desenho para obter CRL/OCSP (A1), sem implementação

1. **Fontes autorizadas.** Só URLs tiradas de certificados já validados até uma raiz fixada:
   - CRLDistributionPoints (LCR) e AuthorityInfoAccess/OCSP do signatário, das ACs intermediárias
     e da TSA;
   - para as LCR das ACs ICP-Brasil, também os endereços publicados pelo ITI, numa lista
     estática versionada como `icp-brasil-certs.ts`.

   Nunca usar URL vinda do PDF/DSS ou do cliente sem que ela conste de certificado confiável.
2. **Momento da coleta: na emissão.** Logo após `verifyPadesSignature` (LIVE_ISSUANCE),
   buscar a OCSP (preferencial) ou a LCR de cada certificado da cadeia do signatário. Fazer o
   mesmo para a TSA quando o carimbo for adotado.
   - Para satisfazer a validação histórica, a coleta precisa ocorrer depois do carimbo, com uma
     carência configurável, por exemplo 1 a 5 min. Isso pede uma fila (job) que complete a
     evidência depois da emissão, sem bloquear a entrega.
3. **Persistência.**
   - Formato: DER bruto, com SHA-256, URL de origem, horário da coleta, thisUpdate/nextUpdate e
     status.
   - Destino: tabela própria (por exemplo `revocation_evidence`, migração futura) ligada à
     `digital_signatures`; arquivo no Storage para LCRs grandes.
   - Em seguida, incorporar ao PDF como DSS (PAdES-LT, nova revisão incremental `/DSS` + `/VRI`).
     O `pdf-structure-validator` já admite revisões LTV.
   - A verificação passa a usar `INJECTED_AND_EMBEDDED_LTV` com evidência do DSS. O DSS não é
     confiável por si: toda evidência passa pela mesma validação criptográfica.
4. **Cache.**
   - A LCR de uma AC é compartilhada entre clínicas e reaproveitada até `nextUpdate`
     (respeitando `maxAgeSeconds`).
   - O OCSP é por certificado e reaproveitado até `nextUpdate`, ou até 24 h quando não houver
     nextUpdate.
   - A chave do cache é o SHA-256 da URL mais o emissor; evidência expirada não é usada.
5. **Proteção contra SSRF.**
   - Esquemas: só `http`/`https`. ICP-Brasil publica LCR em HTTP, o que é aceitável porque a
     evidência é assinada.
   - Resolver o DNS e recusar IPs privados, loopback, link-local e metadados de nuvem; validar de
     novo a cada redirecionamento, com no máximo 2 redirecionamentos.
   - Allowlist de domínios das ACs credenciadas; limites de tamanho (LCR ≤ 20 MB, OCSP ≤ 64 KB) e
     de tempo (5 s para conectar, 15 s no total).
   - Sem cookies nem credenciais; `Content-Type` conferido e nunca confiado.
   - Requisição OCSP com nonce opcional (as ACs ICP-Brasil costumam não ecoá-lo); CertID em SHA-1,
     com SHA-256 quando suportado.
6. **Falhas de rede.**
   - Nunca convertem em GOOD nem em INVALID: o resultado fica INDETERMINATE/TRY_LATER, a emissão
     segue (como hoje) e o job tenta de novo com backoff.
   - Registro em `audit_events`; um painel operacional mostra assinaturas sem evidência depois de
     N horas.
7. **Cadeia completa.** Signatário e intermediárias pela LCR/OCSP da AC emissora; a raiz é
   âncora (sem revogação). A TSA usa a mesma regra, com a referência em `genTime`. O respondente
   OCSP delegado exige `ocsp-nocheck` ou LCR.
8. **Testes futuros.** Servidor HTTP local com LCR/OCSP sintéticos, injeção do `fetch` (sem rede
   real em teste), casos de SSRF (IP privado, redirecionamento, tamanho, tempo esgotado).

## 6. Fase 4 — demais achados

| Achado | Classificação | Ação |
|---|---|---|
| A6 carimbo com TSA sem revogação rebaixa assinatura que seria VALID sem carimbo | decisão de política (6F.2B), hoje conservadora | pendente: a ETSI §5.5 permitiria cair na validação atual; decidir no 6F.3 |
| A7 OCSP sem nextUpdate | defeito comprovado | **corrigido** (idade máxima configurável) |
| A8 tryLater não autenticado | defeito comprovado | **corrigido** |
| A9 TSA revogada depois do genTime por motivo administrativo | política conservadora legítima sem POE do próprio carimbo | mantido; revisar quando houver carimbo de arquivo (PAdES-LTA) |
| A10 seleção de carimbo | defeito comprovado (regressão) | **corrigido** |
| A11 TSA de carimbo não usado contamina o resultado | defeito | **corrigido** |
| A12 reason 7 / > 10 | risco | **corrigido** (tratados como comprometimento) |
| A12 removeFromCRL em CRL base vira REVOKED | risco baixo e conservador | pendente |
| A12 delta, indireta, onlySomeReasons, nameRelativeToCRLIssuer | política conservadora | pendente (verificar se alguma AC ICP-Brasil usa esses formatos) |
| A12 colisão de serial com zero à esquerda | risco teórico (serial não conforme) | pendente |
| A12 código morto `isSelfIssued && i === length-1` | limpeza | pendente |
| Suspensão (hold) | GOOD emitido depois do hold é tratado como contradição; não há liberação via removeFromCRL | pendente (holds são raros na ICP-Brasil) |

## 7. Riscos restantes

- **A1 aberto.** Sem CRL/OCSP em produção, nenhuma assinatura real chega a VALID e uma revogação
  real não é detectada na emissão.
- **Recuperação de artefato.** Com evidência injetada no futuro, um certificado revogado entre a
  assinatura e a recuperação bloqueia a recuperação (409, reconciliação). É conservador, mas
  pode exigir intervenção manual.
- **Carência padrão 0.** Uma LCR emitida 1 s depois da POE já comprova. Definir carência
  operacional (sugestão: 5 min) ao implementar A1.
- **ExpiredCertsOnCRL (2.5.29.60)** não é reconhecida. LCR emitida depois do vencimento do
  certificado nunca comprova GOOD.
- **Default da coluna.** `evolution_signatures.verification_status` ainda tem default `'VALID'`
  no banco (só o código mudou).
- **Testes de banco.** Rodados em 29/10/2026 sobre 17af400 (seção 8). Nenhuma falha do lote.

## 8. Execução das suítes de banco (29/10/2026)

Ambiente: Supabase local (`http://127.0.0.1:54321`, URL lida de `supabase status`) e contêiner
descartável `psywrite-sncr-3a-disposable` (`postgres:17.6.1.167`, `--network none`, rótulo
`psywrite.test=lote-6c`). Variáveis de produção removidas do ambiente; nada com `--linked`.

- Banco local: `supabase migration up --local` aplicou 20261012, 20261015 e 20261016. A
  20261027 (SNCR) bloqueia a própria aplicação, por isso as migrações de assinatura só entram no
  contêiner descartável, carregadas pelos helpers dos testes.
- Sem banco (todas passam): pades-revocation-6f2c-r 22, pades-revocation-poe 20,
  pades-rfc3161-poe 13, pades-x509-chain-trust 10, pades-pdf-integrity 13, digital-signature 25,
  document-signing-identity 36, evolution-save-before-sign 12, document-signing-route 6,
  signed-document-retrieval 12, signature-providers 6, signature-oauth-context 9,
  signature-oauth-reproduction 4, sncr 6, sncr-safety 4, sncr-maintainer 8, platform 6.
- PostgreSQL real (todas passam): signature-trust-permissions 24, signature-identity-db 3,
  signature-persistence-local 46 (inclui o trigger `signing_attempt_metadata_guard`),
  signature-trust-flow 10, signature-oauth-local 36, sncr-postgres-local 23, sncr-auth-local 36,
  sncr-concurrency-local 4, sncr-integrated-local 32.
- Supabase local e PGlite (passam): supabase-flow, document-ai, consultations, team,
  invite-flow, clinical-context, imports, readiness, attachment-delete-db, clinic-features-db,
  documents-date-db, exams-db, prescription-templates-db, anamnesator-native-db.
- Falhas anteriores ao lote (iguais em ffa542a, mesma linha; fora do escopo):
  - `supabase-local.test.mjs:83`: `permission denied for table clinic_members` ao inserir como
    `authenticated`.
  - `documents.mjs:25`: `action=pdf` devolve 500. Causa não investigada.
- Esquema local: o CHECK de `evolution_signatures.verification_status` aceita `UNVERIFIED`, e a
  tabela não tem trigger. O default continua `'VALID'` (ver seção 7).
- `tsc --noEmit` sem erros. `npm run lint`: 3 erros `no-deprecated` antigos em
  `tests/sncr.test.mjs` e `tests/sncr-safety.test.mjs`.
