# Migração para Supabase e Next.js

O projeto de desenvolvimento `mywmszbmdqzwewhzdjug` usa São Paulo. Trabalhar somente com dados fictícios nesta etapa.

## Implementado

- Interface Next.js com login Supabase Auth e vínculo de usuário à clínica.
- Pacientes e agenda no PostgreSQL, com RLS por clínica e controle de versão.
- Anexos no bucket privado `clinical-files`: JPG, PNG, WebP e PDF até 12 MB, dez por solicitação.
- Upload direto para Storage; a API verifica tamanho e assinatura do arquivo antes de registrar o anexo. Downloads usam URLs temporárias.
- Captura por QR com sessão de duas horas, solicitação de quinze minutos, hash de token e revogação.
- Auditoria de alterações cadastrais, agenda, anexos e resultados estruturados por gatilhos do banco.
- Exames estruturados: biblioteca de 25 modelos, resultados por paciente, histórico, correções, RLS médica e exportação FHIR.
- Leitura assistida de exames e transcrição de documentos com revisão humana obrigatória; a API externa é chamada somente pelo backend.

As migrações até `20260913030000_readiness` e as três migrações de exames (`20260914010000`, `20260914010100` e `20260914010200`) foram aplicadas ao projeto remoto em São Paulo. A verificação posterior encontrou 25 modelos de exame, RLS ativa e nenhuma coleta estruturada criada durante a publicação. Dois cadastros e um agendamento foram copiados da demonstração. Um arquivo ainda aguarda transferência.

## Configuração

Copie `.env.example` para `.env.local` e configure a URL, a chave pública, `SUPABASE_SECRET_KEY` e, para leitura de arquivos, `OPENAI_API_KEY`. As duas chaves são exclusivas do servidor: nunca use prefixo `NEXT_PUBLIC_`, publique em Git ou inclua em código cliente. O arquivo local está ignorado pelo Git. Os modelos podem ser alterados com `OPENAI_EXAM_MODEL` e `OPENAI_TRANSCRIPTION_MODEL`.

```sh
npm ci
npm run dev
npm run build
npm start
```

Na Vercel, configure as mesmas variáveis. `vercel.json` seleciona Next.js e funções em São Paulo. Os arquivos passam diretamente pelo Storage para evitar o limite de corpo das funções. A aplicação base está publicada; o código do módulo de exames precisa ser incluído na próxima publicação da Vercel.

## Administração e importação

`scripts/import-sites.mjs` recebe e-mail e exportação local, cria a conta e sua clínica quando necessário e importa pacientes e agenda preservando identificadores. Reexecuções ignoram registros existentes. A exportação fica em `work/`, ignorado pelo Git. O script não transfere arquivos nem rascunhos do navegador.

`scripts/activation-link.mjs` gera um link de recuperação para definição da senha, sem enviar e-mail. Seu resultado é uma credencial temporária: não deve ser salvo ou registrado em logs compartilhados. Gerar somente para a origem onde a interface estará acessível.

## Verificação

Com Supabase local iniciado, execute `npm run test:supabase`. O teste usa contas sintéticas, verifica isolamento entre clínicas, autenticação, conflitos de versão, agenda em São Paulo, upload de 6 MB, rejeição de arquivo inválido, repetição, auditoria e exclusão; remove seus dados no final.

## Limites desta entrega

A aplicação Next.js está publicada na Vercel em https://psywrite.vercel.app. A demonstração antiga continua no Sites com D1/R2. O anexo legado precisa ser copiado e conferido antes de encerrar a migração.

Consultas novas usam PostgreSQL com controle de versão, histórico, finalização imutável e adendos. A migração 20260912050000 limita evoluções e adendos a médicos e proprietários; operações de escrita passam por função autenticada. A secretária mantém acesso administrativo. A finalização não aplica assinatura digital. Documentos ainda são temporários. Rascunhos antigos no navegador não são importados automaticamente. Faltam revisão de privacidade, operação de backups/restauração e validação para uso com dados reais.
