# Lote 1 — checkpoint seguro antes das correções SNCR

Data: 27/10/2026. Repositório: PsyWrite.

## Escopo e referência inicial

- Branch inicial: `main`, acompanhando `origin/main`.
- HEAD inicial: `639b4743882508747ab088350367183c4bec630b`.
- Branch do checkpoint: `work/checkpoint-lote-1-2026-10-27`.
- Índice inicialmente vazio; 11 arquivos modificados e 3 arquivos não rastreados.
- Nenhuma correção funcional, instalação, migração, operação em dados reais, chamada a provedor externo, deploy ou push foi realizada.
- O commit que contém este relatório preserva os 14 arquivos abaixo no estado encontrado, acrescentando somente este registro.

## Arquivos existentes preservados

```text
.env.example
app/api/digital-signature/sncr/route.ts
components/documents/editor.tsx
components/documents/use-documents.ts
components/prescriptions.tsx
lib/document-fields.ts
lib/document-pdf.ts
lib/signature/document-signing-service.ts
lib/signature/pades-service.ts
lib/sncr/client.ts
lib/supabase/document-pdf-data.ts
package.json
tests/prescription-pdf.test.mjs
tests/sncr.test.mjs
```

Os três arquivos SNCR anteriormente não rastreados passam a integrar o histórico. Não houve stash, reset, clean ou substituição de arquivos existentes.

## Credenciais e artefatos excluídos

- `.env.local` permanece local e ignorado; seu conteúdo foi conferido por hash, sem registrar valores.
- `.env.example` foi revisado: os novos campos de credenciais estão vazios. O campo de exemplo já preenchido anteriormente contém um placeholder, não uma credencial operacional.
- Permanecem fora do checkpoint: `.claude/`, `.next/`, `.vercel/`, `dist/`, `node_modules/`, `next-env.d.ts`, `supabase/.branches/`, `supabase/.temp/`, `tsconfig.tsbuildinfo` e `work/`.
- A seleção para staging foi explícita, sem `git add .` e sem inclusão forçada de arquivos ignorados.
- A revisão dos candidatos incluiu padrões de chave privada, JWT literal, chave de provedor, URI com senha e correspondência com valores sensíveis do ambiente local. Não foram encontrados segredos nesses candidatos. Esta revisão pontual não é uma auditoria de todo o histórico Git.
- Logs auxiliares, manifesto inicial e PDFs exclusivamente sintéticos usados para conferir o CLI ficaram em diretório temporário privado, fora do repositório. Nenhuma chave privada sintética foi exportada.

## Testes locais anteriores às correções

Ambiente: Node.js `v26.12.1`; TypeScript `5.9.3`.

Resultado agregado das execuções concluídas: **96 testes contabilizados pelo runner, 94 aprovados e 2 falhas**. O teste de PDF usa asserções no nível do arquivo e é contabilizado como uma entrada pelo runner.

| Grupo | Testes | Aprovados | Falhas |
| --- | ---: | ---: | ---: |
| Backup/conexão, plano da clínica, exames, criação/PDF de receita, provisionamento simulado, pseudonimização, SNCR e timer | 39 | 39 | 0 |
| Provedores de assinatura simulados | 6 | 6 | 0 |
| Proteção de salvamento antes de assinatura de evolução | 12 | 12 | 0 |
| Integração nativa HTTP com Supabase simulado | 5 | 5 | 0 |
| Sessão privada do Anamnesator simulada | 3 | 3 | 0 |
| Painel da plataforma com Supabase simulado | 6 | 6 | 0 |
| Criptografia, PAdES, cadeia de certificados e testes CLI | 25 | 23 | 2 |
| **Total** | **96** | **94** | **2** |

Comandos concluídos:

```bash
node --test --test-isolation=none --test-reporter=spec tests/sncr.test.mjs tests/prescription-pdf.test.mjs tests/prescription-new.test.mjs tests/timer-utils.test.mjs tests/backup-connection.test.mjs tests/clinic-plan.test.mjs tests/provision-clinic.test.mjs tests/pseudonymize.test.mjs tests/exams.test.mjs
node --test --test-isolation=none --test-reporter=spec tests/signature-providers.test.mjs
node tests/evolution-save-before-sign.test.mjs
node tests/anamnesator-native-http.test.mjs
node tests/anamnesator-private-session.test.mjs
node tests/platform.test.mjs
timeout 30s node tests/digital-signature.test.mjs
node_modules/.bin/tsc --noEmit --incremental false
git diff --check
git fsck --no-dangling
```

TypeScript, conferência de whitespace e integridade dos objetos Git passaram.

### Falhas existentes e limitações do runner

1. `tests/digital-signature.test.mjs:214`: teste de PDF íntegro pelo CLI falha na asserção da mensagem em `stdout`, na linha 243.
2. `tests/digital-signature.test.mjs:250`: teste de PDF adulterado pelo CLI falha na asserção da mensagem em `stdout/stderr`, na linha 289.

A investigação complementar utilizou dois PDFs com certificado autoemitido pelo mock, sem conta Bird ID, certificado real ou dados clínicos. Executado diretamente, `scripts/verify-signature.mjs` apresentou a mensagem esperada e retornou 0 para o íntegro e 1 para o adulterado. Uma reprodução com `execFile` recebeu os mesmos códigos, mas `stdout` e `stderr` vazios para ambos. Portanto, as duas falhas de teste foram isoladas na captura de saída de subprocessos neste ambiente; não comprovam falha da verificação matemática do PDF. Os testes permanecem falhando e não foram modificados.

Tentativas com `--test-isolation=none` para scripts que aguardam testes no nível superior não produziram conclusão e foram interrompidas; a primeira execução teve timeout de 45 segundos. Esses scripts passaram quando executados diretamente com `node`, como registrado acima. Essas tentativas não foram contabilizadas como testes aprovados ou como defeitos comprovados da aplicação.

Também houve aviso `DEP0205` de depreciação de `module.register()` no Node 26; não impediu os testes concluídos.

### Testes intencionalmente não executados

- `npm test` integral: agrega testes que executam SQL de migrações.
- Testes PGlite: `attachment-delete-db.mjs`, `clinic-features-db.mjs`, `documents-date-db.mjs`, `exams-db.mjs`, `prescription-templates-db.mjs` e `anamnesator-native-db.mjs`. Embora usem banco sintético em memória, foram excluídos para cumprir o limite deste lote de não executar migrações.
- `supabase-local.test.mjs`: cria usuários e registros em um serviço Supabase; não integra o conjunto puramente simulado.
- Scripts de integração com aplicação/serviços, como `supabase-flow.mjs`, `documents.mjs`, `consultations.mjs`, `team.mjs`, `invite-flow.mjs`, `imports.mjs`, `clinical-context.mjs`, `readiness.mjs` e `document-ai.mjs`.
- Autenticação SNCR/gov.br real, obtenção de números, assinatura externa e validação de produção.

## Integridade dos módulos

Foi criado um manifesto SHA-256 antes da criação da branch para **282 arquivos existentes rastreados ou candidatos a versionamento**. Todos permaneceram idênticos após os testes. O ambiente local protegido também permaneceu inalterado.

Os hashes abaixo são resumos SHA-256 de manifestos JSON ordenados, contendo caminhos e hashes dos arquivos de cada grupo. Servem como referência de preservação de conteúdo, sem incluir segredos.

| Grupo | Arquivos conferidos | SHA-256 do manifesto |
| --- | ---: | --- |
| Bird ID/provedores, criptografia, serviço de assinatura e rotas Bird ID | 7 | `02b9342637e80c84ed176ce6bcf245d01c296c638f9487f545cb9ce7d0d2ab58` |
| PAdES, cadeia/certificados públicos, gerador de PDF e CLI | 5 | `3d7bcc48fde01c196bbb74075035ca4e81ed23e3ee4b50a5b6c9a29e3b3568e9` |
| `lib/supabase/` e migrações SQL, somente leitura | 48 | `eaa82e74062eed0baf09e942adfe91886bf8fdc79923d877114eb6fbe066b755` |
| Cliente, rota e testes SNCR | 3 | `5b77af9f7ecfdf26e8b0e87274c1ed8153836d8055cb35b6765e57a47e7c5451` |

Bird ID e SNCR foram exercitados com mocks; Supabase foi exercitado por clientes/respostas simulados. PAdES teve testes criptográficos locais e conferência direta de PDFs sintéticos. A preservação dos módulos foi confirmada; funcionamento externo e conformidade regulatória continuam fora da validação deste checkpoint.

## Problemas anteriores preservados

Além das duas falhas CLI e limitações do runner documentadas acima, os achados da auditoria anterior permanecem sem correção: autenticação SNCR, reserva/persistência de números, truncamento de lotes e PDF, distinção B/B2, identidade do prescritor, RLS, concorrência e recuperação da assinatura. O sucesso dos testes existentes não elimina esses achados nem significa homologação da integração.

Este checkpoint é uma referência de código e resultados de teste antes das intervenções, não uma liberação para uso clínico ou produção.
