# Linha SNCR da branch `work/checkpoint-lote-1-2026-10-27`, descartada no merge com a main

Decisão do Guilherme em 30/10/2026: no merge com a `main` (PR #10, `feat/sncr-rce`), fica o SNCR da
main. A linha SNCR desta branch nasceu em paralelo a partir da mesma base (`639b474`) e foi
retirada.

**O código continua no histórico.** O último commit com a linha completa é `13b9b79`. Para
consultar um arquivo:

```bash
git show 13b9b79:<caminho>
```

As auditorias dos lotes continuam em `docs/audits/` (3B, 4, 4B, 5A e a consulta de identidade).

## O que a linha da branch tinha e a main não tem

| Assunto | Na branch (até `13b9b79`) | Na main |
|---|---|---|
| Notificações eletrônicas A, B e B2 | Modelos oficiais (`assets/sncr/notificacao-{a,b,b2}-eletronica-anvisa-2026-06-29.pdf`), campos explícitos (`lib/sncr/notification-fields.ts`) e preenchimento sem redesenhar o PDF (`lib/sncr/notification-pdf.ts`), só em simulação | Só RCE |
| Sessão SNCR persistida | `sncr_sessions` (migração `20261028010000`), token cifrado (`lib/sncr/session-crypto.ts`), fluxo gov.br pelo manual 3ª ed. §§2.1–2.2 (`auth-config.ts`, `auth-http.ts`, `sessions.ts`), rotas `/api/sncr/auth/*`, página `/sncr/connect`, componente `SncrConnection` em Ajustes | Token só em memória, para uma chamada de numeração |
| Numeração em lotes no banco | `sncr_batches`, `sncr_requests`, `sncr_reservations`, histórico imutável, checagem de sobreposição de lotes e cursor, `sncr_document_modality` (migração `20261027010000`); reserva por documento, abandono, resultado incerto e reconciliação | `sncr_numbering_requests` e itens em quarentena; RCE com reserva própria em `sncr_rce_emissions` |
| Assinatura de receita controlada | `sncr_begin_signing`, `sncr_finish_signing`, `sncr_mark_uncertain` integrados ao PAdES (`lib/sncr/signing.ts`); artefatos em `/sncr-simulations/` | Fluxo RCE próprio (`rce-service`, `rce-workflow`) |
| Simulação local completa | `PSYWRITE_SNCR_MODE=local-simulation`: reserva sintética `SIMULADO.*`, PDF oficial preenchido e assinatura com Bird simulado | Bancada `scripts/sncr-rce-lab.mjs` em homologação |
| Mantenedora | `lib/sncr/maintainer.ts`: CNPJ da mantenedora do PsyWrite, nunca o da clínica | Validação de CNPJ no cliente |
| Contrato do rascunho RCE | `lib/sncr/rce-fields.ts`, que nunca infere medicamento do texto livre, e `rce-pdf.ts` com o modelo `rce-eletronica-anvisa-2026-06-24.pdf` conferido por SHA-256 | `rce.ts` (`validateRceSnapshot`) e `rce-pdf.ts` com `assets/sncr/rce-eletronica-anvisa.pdf` |
| Modalidade da receita | Lida do texto (`parsePrescriptionText().modality`: simples, controle especial, notificações) | Coluna `prescription_category` (RCE, RET, NRA, NRB, NRB2, NRR, NRT) |

## Testes que saíram com a linha

- Postgres real: `sncr-postgres-local` (23), `sncr-auth-local` (36), `sncr-concurrency-local` (4)
  e `sncr-integrated-local` (32).
- Sem banco: `sncr-maintainer` (8), `sncr-safety` (4), o `sncr.test` da branch (6),
  `rce-pdf`, `rce-build` e `notification-pdf`.
- Também saíram as partes SNCR de `signature-trust-flow`, `signature-persistence-local`,
  `signature-trust-permissions` (caso 11), `signature-oauth-local` (namespace SNCR) e
  `pades-pdf-integrity` (PDFs simulados de RCE e notificação).

## Candidatos a levar para a linha da main

- **Notificações A, B e B2.** A main só cobre RCE.
- **Sessão SNCR persistida e cifrada.** Avaliar contra o limite de 30 s do token no manual.
- **Histórico imutável e checagem de sobreposição de lotes de numeração.**
- **Conferência do modelo oficial por SHA-256.** Ver se o `rce-pdf.ts` da main já confere.
