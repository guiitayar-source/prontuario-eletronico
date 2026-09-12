# PsyWrite — protótipo de prontuário

Interface de prontuário com texto livre, cadastro de pacientes, agenda e recebimento de anexos pelo celular. Use somente dados fictícios nesta etapa.

## Executar

Configure `.env.local` conforme `.env.example` e execute:

```sh
npm ci
npm run dev
```

A aplicação atual usa Next.js, Supabase Auth, PostgreSQL e Storage privado. Consulte [SUPABASE_MIGRATION.md](./SUPABASE_MIGRATION.md) para configuração, migração, publicação e limitações.

## Funcionalidades

- Cadastro, pesquisa e edição de pacientes, com controle de versão.
- Agenda com criação, edição, cancelamento e acesso à consulta.
- Evolução em texto livre, cujo rascunho permanece somente no navegador.
- Captura de fotos e PDFs por QR, revisão, classificação e exclusão de anexos.
- Login individual, vínculo à clínica e auditoria das alterações persistidas.

O histórico clínico, a finalização e os documentos são demonstrativos. Não há assinatura, OCR, Anamnesator conectado ou evolução clínica sincronizada.

## Verificação

```sh
npm exec tsc -- --noEmit
npm run build
npm run test:supabase
```

O último comando exige Supabase local iniciado; só usa contas sintéticas locais. Os testes SQLite/D1 e arquivos em `drizzle/` preservam a implementação anterior para referência. Os antigos testes HTTP D1 não se aplicam ao servidor Next.js atual.

A demonstração publicada anteriormente ainda usa Sites e D1/R2. Não publique esta versão Next.js pelo fluxo antigo de Sites. A migração externa permanece pendente até a publicação e a transferência do anexo legado.
