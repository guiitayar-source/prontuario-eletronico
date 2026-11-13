# Testes que precisam de infraestrutura na máquina

O `npm test` (e o CI) roda tudo o que está direto em `tests/`, sem banco nem rede. Os testes
desta pasta precisam de algo ligado ou construído na máquina e rodam à mão, sempre a partir da
raiz do repositório. Os auxiliares compartilhados ficam em `tests/helpers/`.

Teste novo que precise de banco, contêiner ou build entra aqui. Teste novo sem nada disso fica em
`tests/` e passa a rodar no `npm test` e no CI sozinho.

## Supabase local (`npx supabase start`)

Leem o endereço e as chaves de `supabase status` e usam contas sintéticas.

| Arquivo | Comando |
| --- | --- |
| `supabase-flow.mjs` | `npm run test:supabase` |
| `consultations.mjs` | `npm run test:consultations` |
| `documents.mjs` | `npm run test:documents` |
| `document-ai.mjs` | `npm run test:document-ai` |
| `team.mjs` | `npm run test:team` |
| `invite-flow.mjs` | `npm run test:invite` |
| `clinical-context.mjs` | `npm run test:clinical-context` |
| `imports.mjs` | `npm run test:imports` |
| `readiness.mjs` | `npm run test:readiness` |
| `supabase-local.test.mjs` | `node tests/local/supabase-local.test.mjs` |

## PostgreSQL descartável em contêiner (Docker ou Podman)

`revocation-evidence-db.test.mjs`, `signature-identity-db.test.mjs`,
`signature-oauth-local.test.mjs`, `signature-persistence-local.test.mjs`,
`signature-trust-flow.test.mjs` e `signature-trust-permissions.test.mjs`. Cada um roda com
`node tests/local/<arquivo>`.

Eles usam um contêiner já em execução, que `tests/helpers/signature-trust-db.mjs` confere antes
de começar:

- nome `psywrite-sncr-3a-disposable`, sem rede (`--network none`) e sem volumes;
- imagem `public.ecr.aws/supabase/postgres:17.6.1.167`, já baixada (os testes não fazem pull);
- rótulo `psywrite.test=lote-6c`.

O comando usado nas auditorias está em `docs/auditorias/lotes/lote-4-2026-10-28.md` ("Reprodução
segura"); desde o lote 6C o auxiliar exige também o rótulo acima. A imagem e o motor podem ser
trocados pelas variáveis descritas em `tests/helpers/sncr-container.mjs`.

Os que sobem o PostgREST (`tests/helpers/signature-trust-rest.mjs`) precisam também da imagem
`public.ecr.aws/supabase/postgrest:v16.2` já baixada.

## Build

`sncr-rce-build.test.mjs` chama a rota compilada do Next, com todo o HTTP interceptado: rode
`npm run build` e depois `npm run test:sncr:build`.
