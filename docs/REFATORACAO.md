# Refatoração — marcos, etapas e andamento

Objetivo: deixar o código mais fácil de ler, para pessoas e para IA, **sem mudar o que o sistema
faz** e sem risco desnecessário (o sistema está em uso com dados reais).

Este arquivo é o registro único do andamento. Cada PR de refatoração atualiza a tabela e o diário
no fim. Levantamento inicial feito em 11/11/2026 sobre a `main` (`bdd0bb2`).

## Regras de toda etapa

- Um PR por etapa (ou por pedaço de etapa); nunca direto na `main`.
- PR de refatoração só move, divide ou renomeia. Função nova ou correção de comportamento vai em
  PR separado.
- `npx tsc --noEmit -p .`, `npm run lint` e `npm test` verdes antes do merge.
- Ao terminar uma etapa, atualizar o `CLAUDE.md` se a estrutura descrita lá mudou.

## Marcos

| Marco | Etapa | O que é | Estado |
| --- | --- | --- | --- |
| A. Rede de proteção | 0 | Tirar `.wrangler/` do repositório | feito (11/11/2026) |
| A. Rede de proteção | 1 | Testes sem banco rodando no `npm test` e no CI | feito (11/11/2026) |
| B. Assinatura legível | 2 | Dividir `lib/signature/revocation-validator.ts` | feito (12/11/2026) |
| C. Telas legíveis | 3 | Telas grandes no padrão pasta + hook `use-*.ts` | em andamento (celular e agenda feitas; faltam importações, diagnósticos e entrada) |
| D. Servidor | 4 | Checagem de papel clínico num auxiliar único | a fazer |
| E. Organização | 5 | Documentação numa pasta só; testes separados por necessidade de banco | a fazer (opcional) |

## Etapas em detalhe

### Etapa 0 — `.wrangler/` fora do repositório (feito)

Sobra de um teste antigo com Cloudflare: 12 arquivos de estado local (dados fictícios) versionados
por engano. Removidos do git e incluídos no `.gitignore`.

### Etapa 1 — Testes sem banco no CI (feito)

O `npm test` lista os arquivos um a um e 15 arquivos que rodam sem banco tinham ficado de fora
(validação PAdES, revogação, carimbo de tempo, identidade de quem assina, Notificação A/B).
Passou de 137 para 340 testes, cerca de 1 minuto, sem depender de internet.

`tests/document-pdf-pagination.test.mjs` foi removido: testava receita em várias páginas, desenho
que não existe na `main`. A regra atual (layout fixo; texto que não cabe é recusado com mensagem)
é coberta por `prescription-pdf.test.mjs`, `simple-prescription.test.mjs` e
`prescription-rce-ret.test.mjs`.

Continuam manuais, porque exigem Supabase local (`npx supabase start`) ou build:
`*-db.mjs` fora da lista, `*-local.test.mjs`, `signature-trust-*.test.mjs`,
`signature-identity-db.test.mjs`, `revocation-evidence-db.test.mjs`, `supabase-flow.mjs`,
`documents.mjs`, `team.mjs`, `consultations.mjs`, `imports.mjs`, `clinical-context.mjs`,
`invite-flow.mjs`, `document-ai.mjs`, `readiness.mjs`, `anamnesator-native-db.mjs`,
`sncr-rce-build.test.mjs` (`npm run test:sncr:build`).

### Etapa 2 — Dividir `lib/signature/revocation-validator.ts` (feito)

3.107 linhas; funções de 705 (`evaluateOcspForCertificate`), 495
(`evaluateSingleCertificateRevocation`) e 423 linhas (`evaluateCrlForCertificate`). É o trecho que
decide se uma assinatura é bloqueada, então vai em pedaços:

1. **Feito (11/11/2026).** Partes que só leem dados em arquivos próprios: `revocation-oids.ts`
   (constantes), `revocation-asn1.ts` (leitura de extensões e estruturas) e
   `revocation-freshness.ts` (política de frescor). O validador caiu de 3.107 para 2.434 linhas.
2. **Feito (11/11/2026).** Validação de LCR em `revocation-crl.ts` (`parseCrlDer`,
   `evaluateCrlForCertificate`) e o formato comum de resultado em `revocation-evaluation.ts`.
   O validador caiu para 1.929 linhas.
3. **Feito (11/11/2026).** Validação de OCSP em `revocation-ocsp.ts`
   (`evaluateOcspForCertificate` e auxiliares). As duas regras sobre o instante da revogação
   foram para `revocation-evaluation.ts`, porque LCR, OCSP e o validador as usam. O validador
   caiu para 1.144 linhas.
4. **Feito (11/11/2026).** Decisão sobre um certificado em `revocation-certificate.ts`
   (`evaluateSingleCertificateRevocation`). `revocation-validator.ts` fica com 622 linhas: só as
   avaliações de cadeia (carimbo de tempo e documento), os reexports e um mapa dos arquivos no topo.
5. Quebrar as três funções longas em passos nomeados, uma por PR. Método: as linhas de lógica
   ficam onde estão e na mesma ordem; o PR só insere os limites das funções novas (o diff tem
   praticamente só linhas adicionadas, fácil de revisar).
   - **Feito (11/11/2026):** `evaluateCrlForCertificate` (420 linhas) virou um roteiro de 65 linhas
     e quatro passos: `checkCrlIssuerAndSignature`, `checkCrlScope`, `checkCrlDates` e
     `crlStatusForCertificate`.
   - **Feito (12/11/2026):** `evaluateOcspForCertificate` (700 linhas) virou um roteiro de 85 linhas
     e sete passos: `parseBasicOcspResponse`, `checkOcspEnvelope`, `findOcspSingleResponse`,
     `findVerifiedOcspResponder`, `checkOcspResponderAuthorization`,
     `checkOcspSingleResponseDates` e `ocspStatusForCertificate`.
   - **Feito (12/11/2026):** `evaluateSingleCertificateRevocation` (490 linhas) virou um roteiro de
     110 linhas e oito passos: `collectEvidenceEvaluations`, `sortAndGroupEvaluations`,
     `summaryWithoutValidEvidence`, `splitByDeclaredStatus`, `makePoeProvesBefore`,
     `summaryForRevokedCertificate`, `summaryForCertificateOnHold` e `summaryForGoodOrUnknown`.
     Antes da divisão entrou `tests/pades-revocation-hold.test.mjs`: a decisão para certificado
     suspenso (certificateHold) e para LCRs que discordam entre si não tinha teste nenhum
     (`npm test` foi de 340 para 344 testes).

Anotado para depois, fora desta etapa:

- `ocspResponderStatusFromCrls` (confere por LCR se o certificado de um respondedor OCSP delegado
  foi revogado) segue sem teste.
- No CI o teste "posições dos campos de A e B batem com os rótulos dos modelos oficiais" é sempre
  pulado, porque a máquina do GitHub não tem `pdftotext`. Instalar `poppler-utils` no fluxo
  `verificacao.yml` faria esse teste rodar lá também.

Quem importa de `revocation-validator.ts` não muda: ele reexporta os nomes públicos que saíram.

Cada pedaço é um PR que só move código; os testes `pades-*` e `revocation-*` precisam continuar verdes.
Outros arquivos grandes de assinatura (`rfc3161-timestamp`, `pdf-structure-validator`, `icp-chain`,
`pades-service`) ficam para depois, se incomodarem.

### Etapa 3 — Telas grandes

Padrão do `CLAUDE.md`: pasta com `index.tsx` e a lógica num hook `use-*.ts`.

| Arquivo | Linhas | Estado |
| --- | --- | --- |
| `app/celular/page.tsx` | 947 | feito (12/11/2026) |
| `components/agenda.tsx` | 670 | feito (12/11/2026) |
| `components/imports.tsx` | 648 | a fazer |
| `components/diagnoses.tsx` | 603 | a fazer |
| `components/auth.tsx` | 501 | a fazer |

Uma tela por PR. Antes de mexer, conferir o que os testes de navegador (`npm run test:browser`)
cobrem daquela tela e completar se faltar. O PR tem dois commits: primeiro os testes, que passam
sobre o código antigo; depois a divisão.

- **Tela do celular (feito).** Não tinha teste nenhum; entrou `tests/browser/mobile-capture.spec.ts`
  (12 testes, API de captura e Storage sintéticos). A tela foi para `components/capture/`, junto
  da tela de anexos do computador: `use-mobile-capture.ts` (lógica), `mobile.tsx` (tela) e
  `redact-modal.tsx` (editor de tarja). `app/celular/page.tsx` ficou só com a rota. Das 947 linhas,
  893 foram movidas como estavam (14 delas só com outro recuo). Mudaram os imports, cinco linhas
  de declaração (`export`, o tipo `Page` virou `MobilePage`, as referências aos campos de arquivo
  ficaram na tela) e quatro manipuladores que estavam dentro do JSX e viraram três funções do
  hook: `reconnect`, `renamePage` e `applyRedaction`.
  Conferência extra: o HTML da tela em três estados saiu idêntico antes e depois.
- **Agenda (feito).** Também não tinha teste; entrou `tests/browser/agenda.spec.ts` (15 testes,
  API de horários sintética e relógio do navegador parado num instante fixo). Para conferir que os
  testes pegam defeito de verdade, oito defeitos foram plantados um a um no código antigo (situação
  de dia passado, duração ao remarcar, Enter na busca, identificador do reenvio, contagem de faltas,
  confirmação de falta, falta antes do horário, término pela duração): os oito foram pegos.
  `components/agenda.tsx` virou a pasta `components/agenda/`: `index.tsx` (tela), `use-agenda.ts`
  (lógica do dia), `appointment-form.tsx` e `use-appointment-form.ts` (formulário de horário) e
  `appointment.ts` (o tipo do horário e as contas de data, hora e duração). Quem importa
  `@/components/agenda` não muda. Das 670 linhas, 652 foram movidas como estavam (14 delas só
  ganharam `export` e 10 só mudaram de recuo), 8 foram reescritas e 10 saíram (linhas em branco,
  fechamentos de manipulador, imports refeitos). O que mudou: os imports, o tipo dos props do
  formulário (agora `AppointmentFormProps`) e quatro manipuladores que estavam dentro do JSX e
  viraram funções: `typePatient`, `pickOnlyMatch` e `pickPatient` no formulário e `reload` na agenda.
  Conferência extra: o HTML da agenda em sete estados saiu idêntico antes e depois.

Anotado para depois, fora desta etapa (mudaria comportamento):

- Agenda: se carregar um dia falha, a tela mostra o aviso de erro, mas continua listando os
  horários do dia que estava aberto antes, sob o título do dia novo. Limpar a lista quando o
  carregamento falha evitaria confundir os dias.

### Etapa 4 — Servidor

- `['owner', 'doctor'].includes(role)` está copiado em 9 lugares; vira um auxiliar único, no
  estilo do `assertFeature`.
- `lib/document-pdf.ts` (880 linhas) e `lib/supabase/ai-files.ts` (502) podem ser divididos por
  tipo de documento, se forem crescer.

### Etapa 5 — Organização (opcional)

- Juntar `docs/audits/` e `docs/auditorias/`.
- Separar em pastas os testes que exigem Supabase local, para o `npm test` usar um padrão de nome
  em vez da lista arquivo a arquivo.

## Fora do escopo

- Formato canônico da evolução assinada (`lib/signature/canonical-evolution.ts`).
- Migrações já aplicadas.
- CSS (grande, mas organizado por tela).
- `lib/supabase/*.ts` (já segue um padrão só).

## Diário

- 11/11/2026 — Levantamento e plano. Etapas 0 e 1 num PR só.
- 11/11/2026 — Etapa 2, pedaço 1: constantes, leitura ASN.1 e frescor saem do validador de revogação (código movido sem alteração).
- 11/11/2026 — Etapa 2, pedaço 2: validação de LCR e o tipo de resultado saem do validador (código movido sem alteração).
- 11/11/2026 — Etapa 2, pedaço 3: validação de OCSP sai do validador (código movido sem alteração).
- 11/11/2026 — Etapa 2, pedaço 4: decisão sobre um certificado sai do validador, que passa a ter um mapa dos arquivos no topo.
- 11/11/2026 — Etapa 2, pedaço 5 (LCR): `evaluateCrlForCertificate` dividida em quatro passos nomeados, sem alterar linhas de lógica.
- 12/11/2026 — Etapa 2, pedaço 5 (OCSP): `evaluateOcspForCertificate` dividida em sete passos nomeados, sem alterar linhas de lógica.
- 12/11/2026 — Teste de assinatura que falhava por acaso (exigia que o base64 da assinatura não tivesse as letras "PDF") passa a conferir os bytes.
- 12/11/2026 — Etapa 2, pedaço 5 (certificado): teste novo para suspensão e evidências contraditórias; `evaluateSingleCertificateRevocation` dividida em passos nomeados, sem alterar linhas de lógica. Etapa 2 concluída.
- 12/11/2026 — Etapa 3, tela do celular: 12 testes de navegador novos; `app/celular/page.tsx` dividido em hook, tela e editor de tarja dentro de `components/capture/`.
- 12/11/2026 — Etapa 3, agenda: 15 testes de navegador novos; `components/agenda.tsx` dividido na pasta `components/agenda/` (tela, lógica do dia, formulário de horário e contas de data).
