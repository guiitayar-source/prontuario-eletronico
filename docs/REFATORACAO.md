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
| B. Assinatura legível | 2 | Dividir `lib/signature/revocation-validator.ts` | em andamento (pedaços 1 a 4 de 5 feitos) |
| C. Telas legíveis | 3 | Telas grandes no padrão pasta + hook `use-*.ts` | a fazer |
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

### Etapa 2 — Dividir `lib/signature/revocation-validator.ts`

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
5. Quebrar as três funções longas em passos nomeados.

Quem importa de `revocation-validator.ts` não muda: ele reexporta os nomes públicos que saíram.

Cada pedaço é um PR que só move código; os testes `pades-*` e `revocation-*` precisam continuar verdes.
Outros arquivos grandes de assinatura (`rfc3161-timestamp`, `pdf-structure-validator`, `icp-chain`,
`pades-service`) ficam para depois, se incomodarem.

### Etapa 3 — Telas grandes

Padrão do `CLAUDE.md`: pasta com `index.tsx` e a lógica num hook `use-*.ts`.

| Arquivo | Linhas |
| --- | --- |
| `app/celular/page.tsx` | 947 |
| `components/agenda.tsx` | 670 |
| `components/imports.tsx` | 648 |
| `components/diagnoses.tsx` | 603 |
| `components/auth.tsx` | 501 |

Uma tela por PR. Antes de mexer, conferir o que os testes de navegador (`npm run test:browser`)
cobrem daquela tela e completar se faltar.

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
