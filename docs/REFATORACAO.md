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
| C. Telas legíveis | 3 | Telas grandes no padrão pasta + hook `use-*.ts` | feito (12/11/2026) |
| D. Servidor | 4 | Checagem de papel clínico num auxiliar único | servidor feito (12/11/2026); telas a fazer |
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
| `components/imports.tsx` | 648 | feito (12/11/2026) |
| `components/diagnoses.tsx` | 603 | feito (12/11/2026) |
| `components/auth.tsx` | 501 | feito (12/11/2026) |

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
- **Importações (feito).** Sem teste antes; entrou `tests/browser/imports.spec.ts` (12 testes: painel
  de importação em Pacientes → Importar e exportar e o histórico importado no prontuário). Dos 14
  defeitos plantados no código antigo (destino padrão, vínculo anterior, nome ou CPF repetido,
  conflito, confirmação refeita ao mudar destino, mensagens dos lotes, limite de 2 MB, confirmação
  ao desfazer, trava da navegação, páginas do histórico, entre outros), os 14 foram pegos.
  `components/imports.tsx` virou a pasta `components/imports/`: `index.ts` (reexporta, então quem
  importa `../imports` não muda), `import-panel.tsx` (tela) e `use-import-panel.ts` (lógica) do
  painel, `imported-history.tsx` (aba do prontuário) e `entry.tsx` (item importado e formato de
  data, usados pelos dois). Das 648 linhas, 639 foram movidas como estavam (2 só ganharam `export`
  e 5 só mudaram de recuo), 5 foram reescritas e 4 saíram. Dois manipuladores que estavam no JSX
  viraram funções do hook: `chooseFiles` e `chooseDestination`.
  Conferência extra: o HTML das telas em oito estados saiu idêntico antes e depois.
- **Diagnósticos (feito).** Sem teste antes; entrou `tests/browser/diagnoses.spec.ts` (6 testes:
  busca no CID-10 pelo teclado, sugestões da CID-11, texto livre, diagnósticos anteriores do
  paciente, erro ao salvar e consulta finalizada). Os códigos e títulos dos testes saem dos
  catálogos oficiais em `lib/cid/data/`, nenhum escrito à mão. Dos 14 defeitos plantados no código
  antigo (teclado da lista, Escape e clique fora, ordem dos grupos da CID-11, versão da CID-11
  enviada, desfazer a CID-11, descrição vazia, diagnóstico resolvido sugerido, bloco da evolução
  reescrito, cópia mostrada na consulta finalizada, entre outros), os 14 foram pegos.
  `components/diagnoses.tsx` virou a pasta `components/diagnoses/`: `index.ts` (reexporta, então
  quem importa `../diagnoses` não muda), `cid-autocomplete.tsx` (busca no catálogo),
  `icd11-suggestions.tsx` (sugestões e etiqueta da CID-11), `consultation-diagnoses.tsx` (tela) e
  `use-consultation-diagnoses.ts` (lógica) dos diagnósticos do atendimento, e `types.ts`. Das 603
  linhas, 567 foram movidas como estavam (3 só ganharam `export` e 18 só mudaram de recuo), 13
  foram reescritas e 23 saíram (fechamentos de manipulador, imports refeitos, linhas em branco e
  duas chamadas que passaram a caber numa linha). Seis manipuladores que estavam no JSX viraram
  funções do hook: `changeStatus`, `unlink`, `chooseIcd11`, `include`, `startDraft` e
  `startFreeDraft`. Conferência extra: o HTML em dez estados (inclusive a janela de contexto
  clínico, que usa a mesma busca) saiu idêntico antes e depois.
- **Tela de entrada (feito).** Sem teste antes; entrou `tests/browser/auth.spec.ts` (18 testes,
  com o Auth e o vínculo com a clínica do Supabase sintéticos): entrar, esqueci minha senha,
  primeiro acesso e recuperação (pelo endereço, pelo fragmento e por conta marcada), conferência
  da senha enquanto digita, links com erro, de ativação e de código, pareamento do celular no
  endereço, conta sem clínica, primeiro vínculo define clínica e papel, sair. Os 22 defeitos
  plantados no código antigo foram pegos. `tests/browser/fixtures.ts` ganhou `syntheticSession()`
  e a opção de começar sem sessão. `components/auth.tsx` virou a pasta `components/auth/`:
  `index.tsx` (escolhe a tela e reexporta `useAccess`, então quem importa `./auth`, `../auth` ou
  `@/components/auth` não muda), `use-auth.ts` (sessão, links do e-mail, vínculo e ações),
  `password-form.tsx` (definir senha), `sign-in-form.tsx` (entrar) e `access.ts` (contexto de papel
  e clínica). Das 501 linhas, 491 foram movidas como estavam (1 só ganhou `export` e 139 só
  mudaram de recuo), 6 foram reescritas (imports e os nomes das ações nos dois formulários) e 4
  saíram. Conferência extra: o HTML em onze estados saiu idêntico antes e depois.
  Limite: os testes rodam com `next dev`, que executa duas vezes o efeito de abertura; nesse modo a
  resposta de erro do link de ativação e do código de acesso é ignorada, então só o caminho de
  sucesso desses dois links é testado (em produção o aviso de erro aparece).

Anotado para depois, fora desta etapa (mudaria comportamento):

- Agenda: se carregar um dia falha, a tela mostra o aviso de erro, mas continua listando os
  horários do dia que estava aberto antes, sob o título do dia novo. Limpar a lista quando o
  carregamento falha evitaria confundir os dias.
- Histórico importado: o mesmo acontece ao trocar de página. Se a página nova falha, a tela mostra
  o aviso e "Página 2 de 2", mas continua listando os registros da página anterior.
- Entrada: se o servidor falha ao sair, a biblioteca do Supabase encerra a sessão no navegador
  mesmo assim e a tela volta para "Entrar" com o aviso, mas o pareamento de captura guardado na aba
  (`capture-desktop`, `capture-mobile`) não é apagado, porque a função para antes. Apagar antes
  de conferir o erro resolveria.
- Entrada: em "Esqueci minha senha", um envio que falha depois de outro que deu certo mostra as
  duas mensagens juntas (a de sucesso não é apagada).

### Etapa 4 — Servidor

O levantamento de 11/11 contou 9 cópias de `['owner', 'doctor'].includes(role)`. Contando as rotas
de assinatura, do SNCR, da CID e de anexos, eram 25 no servidor e 6 nas telas.

- **Servidor (feito, 12/11/2026):** a lista de papéis clínicos fica em `lib/roles.ts`
  (`isClinicalRole`) e cada rota clínica começa com `assertClinicalRole(role, mensagem)`
  (`lib/supabase/server.ts`), que recusa com 403 e a mensagem da própria rota, como antes. As
  mensagens continuam diferentes por rota, porque são o que a pessoa lê. Onde o papel se combina
  com outra condição (sessão válida no Bird ID; marcar quais anexos têm exame), a rota usa
  `isClinicalRole`. `tests/clinical-roles.test.mjs` (71 testes) fixa, rota por rota, o 403 com a
  mensagem para secretária e para papel desconhecido, antes de qualquer acesso a dados, e que owner
  e doctor passam. Foi escrito antes da troca: pegou os 50 defeitos plantados no código antigo
  (checagem removida ou recusando doctor) e os 31 plantados no novo.
- **Telas (a fazer):** `app/sncr/page.tsx`, `components/patients/registry.tsx`,
  `components/clinical-record/use-clinical-record.ts`, `components/settings.tsx`,
  `components/mfa.tsx` (Auditoria) e `components/imports/use-import-panel.ts` passam a usar
  `isClinicalRole`.
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
- 12/11/2026 — Etapa 3, importações: 12 testes de navegador novos; `components/imports.tsx` dividido na pasta `components/imports/` (painel, lógica do painel, histórico importado e item importado).
- 12/11/2026 — Etapa 3, diagnósticos: 6 testes de navegador novos; `components/diagnoses.tsx` dividido na pasta `components/diagnoses/` (busca no catálogo CID, sugestões da CID-11, tela e lógica dos diagnósticos do atendimento).
- 12/11/2026 — Etapa 3, tela de entrada: 18 testes de navegador novos; `components/auth.tsx` dividido na pasta `components/auth/` (tela, lógica, formulários de entrar e de definir senha, contexto de acesso). Etapa 3 concluída.
- 12/11/2026 — Etapa 4, servidor: 71 testes novos de papel nas rotas (`tests/clinical-roles.test.mjs`); as 25 cópias da checagem owner/doctor viram `assertClinicalRole`, com a lista de papéis em `lib/roles.ts`.
