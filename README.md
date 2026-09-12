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
- Evolução em texto livre com salvamento automático no Supabase, controle de versão e histórico por paciente.
- Finalização imutável com autor e horário, correções por adendos e vínculo opcional à agenda.
- Captura de fotos e PDFs por QR, revisão, classificação e exclusão de anexos.
- Login individual, vínculo à clínica e auditoria das alterações persistidas.

Evoluções e adendos são acessíveis somente a médicos e proprietários da clínica. A secretária mantém acesso ao cadastro, agenda e anexos. Documentos continuam temporários; não há assinatura digital, OCR ou Anamnesator conectado. Rascunhos antigos do navegador não são importados automaticamente.

## Verificação

```sh
npm exec tsc -- --noEmit
npm run build
npm run test:supabase
npm run test:consultations
```

O último comando exige Supabase local iniciado; só usa contas sintéticas locais. Os testes SQLite/D1 e arquivos em `drizzle/` preservam a implementação anterior para referência. Os antigos testes HTTP D1 não se aplicam ao servidor Next.js atual.

A aplicação está hospedada na Vercel em https://psywrite.vercel.app. A demonstração anterior ainda usa Sites e D1/R2; um anexo legado permanece pendente de transferência. Não publique esta versão Next.js pelo fluxo antigo de Sites.
