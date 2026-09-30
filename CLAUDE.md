# PsyWrite — guia para quem mexe no código (pessoas e IA)

Prontuário eletrônico de consultório (psiquiatria). Next.js 16 (App Router, React 19) na
Vercel (`gru1`) + Supabase (Postgres com RLS, Auth com MFA, Storage privado), região São Paulo.
Interface, mensagens, commits e documentação em **português**.

Estado: protótipo em validação, **sem liberação para dados reais** — ver `OPERACAO_SEGURA.md`.

## Comandos

- `npx tsc --noEmit -p .` — checagem de tipos (ignore erros em `.next/`, gerados pelo `next dev`).
- `npm run lint` / `npm run format` — oxlint / oxfmt. Não rode o formatador em arquivos que
  você não alterou: ele reescreve linhas não relacionadas e polui o diff.
- `npm run dev` — servidor local em 127.0.0.1:3000; precisa de `.env.local` (ver `.env.example`).
- Testes: `node tests/<arquivo>`. Os `*.test.mjs` sem banco rodam direto; os demais
  (`*-db.mjs`, `document-ai.mjs`, `supabase-flow.mjs`…) exigem Supabase local (`npx supabase start`).
- Migrações: `npx supabase migration list` e `npx supabase db push` aplicam no projeto remoto
  vinculado (produção). Rode `--dry-run` primeiro e só aplique com o aval do titular.

## Estrutura

- `app/page.tsx` — casca da aplicação: escolhe a tela (Pacientes, Agenda, Equipe, Ajustes,
  Atendimento) e envolve tudo no `AppHeader` (busca de pacientes).
- `app/api/<recurso>/route.ts` — rotas finas que só reexportam o handler de `lib/supabase/<recurso>.ts`.
- `lib/supabase/*.ts` — regras do servidor. Padrão: `handle(async (request, { db, clinic, role, user }) => …)`,
  `check()` em cada resultado do Supabase, `writeGuard(request, 'X-…-Action')` antes de escrever,
  `body()`/`boundedBody()` para ler JSON com limite, erros com `HttpError(status, mensagem em pt)`.
- `supabase/migrations/` — esquema. Escritas passam por funções `security definer` (`*_write`)
  com controle de versão otimista (`version`); leitura por RLS com `has_clinic_role`.
  Nunca edite uma migração já aplicada: crie outra (`AAAAMMDDHHMMSS_nome.sql`).
- `components/` — telas e componentes cliente. Telas grandes viram pasta com `index.tsx`
  (ou `index.ts` reexportando) e a lógica num hook `use-*.ts`, deixando o componente só com a tela:
  - `clinical-record/` — atendimento: `index.tsx` (estado e fluxo), `status-banner`, `actions`,
    `sidebar`, `dialogs`, `types`.
  - `documents/` — `use-documents.ts`, `use-document-ai.ts`, `editor`, `ai-box`, `history`.
  - `capture/` — anexos: `use-attachments.ts` (lógica), `desktop.tsx` (tela), `client.ts` (API).
  - `dialog-frame.tsx` — moldura padrão de diálogo (fundo, foco preso, fechar); `modal.tsx` usa
    `<dialog>` nativo. `topbar.tsx` tem a busca global (desenhada por portal na barra da conta,
    em `mfa.tsx`).
- `lib/cid/` — catálogos CID-10/CID-11 e o bloco de diagnósticos da evolução.
- `lib/signature/` — assinatura ICP-Brasil (Bird ID); ver `ARQUITETURA_ASSINATURAS.md`.
- `app/globals.css` só importa `app/styles/*.css`, **na ordem da cascata** (a ordem importa).
  `styles/tokens.css` tem os tokens do tema "Vidro Noturno" (`:root`, `[data-theme]`); os demais
  arquivos são por tela. Use as variáveis (`--text`, `--surface`, `--border`, `--accent`…), não
  cores soltas. Classes genéricas antigas (`.danger`, `.primary`) valem para o app inteiro.

## Papéis e sigilo

`owner` e `doctor` têm acesso clínico; `secretary` só agenda, cadastro e envio de anexos.
Toda rota clínica começa checando `['owner', 'doctor'].includes(role)`. A tabela de permissões em
`components/team.tsx` descreve isso ao usuário — mantenha as duas coisas em sincronia.

## Regras que não são óbvias

- **Códigos clínicos só de fontes oficiais.** Nunca escreva códigos CID de memória. Os catálogos em
  `lib/cid/data/` são gerados por `node scripts/update-cid.mjs [release]` (DATASUS e OMS); não os
  edite à mão. Nova release da CID-11 gera arquivos novos, sem sobrescrever os antigos.
- **Texto assinado.** O que entra na assinatura da evolução é o texto da consulta
  (`lib/signature/canonical-evolution.ts`). Consulta finalizada ou assinada é imutável; correções
  são adendos. Não altere o formato canônico sem tratar as assinaturas existentes.
- **IA só OpenAI** (`lib/ai/client.ts`), sempre com `store: false`. Nada de IA escreve no
  prontuário sem revisão humana explícita.
- **Estilo visual sóbrio**: uma cor de destaque para ações e estados; sem cores por categoria,
  ícones decorativos ou cartões aninhados (referência: página Equipe).
- `next dev` gera `AGENTS.md`/`CLAUDE.md` se faltarem; a geração está desligada em `next.config.ts`
  (`agentRules: false`). Não versione arquivos gerados.

## Git

`main` publica em produção pela Vercel a cada push. Mensagens no padrão
`tipo(escopo): descrição em português` (`feat`, `fix`, `refactor`, `style`, `docs`).
Commits pequenos e separados por assunto.
