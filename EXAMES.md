# Exames estruturados

Na aba Exames, médicos e proprietários podem buscar na biblioteca, preencher resultados e consultar a evolução do paciente. Anexos continuam no fluxo existente. A biblioteca inicial tem 25 exames/painéis; as unidades são sugestões editáveis, e referências vêm do laudo. Não são aplicadas faixas universais nem interpretação clínica automática.

## Uso

- Busque hemograma, TSH, TGO/AST, TGP/ALT etc. A biblioteca aparece somente durante a busca.
- Informe a data real da coleta e apenas os resultados disponíveis. Campos vazios não são gravados como zero.
- Registre laboratório, material, método e referências quando disponíveis; é possível vincular um anexo já recebido daquele paciente.
- Após salvar, o exame permanece no resumo do paciente. Novo resultado abre uma coleta vazia. Histórico compara parâmetros por data; Gráfico abre séries por parâmetro.
- Números usam vírgula ou ponto decimal, sem separador de milhar. Valores como `< 0,1` são preservados como texto e não viram pontos no gráfico.
- Séries gráficas são separadas por unidade, método, material e laboratório, sem conversões implícitas. Metadados ausentes são explicitamente identificados. A tabela preserva o valor original e a referência de cada coleta.
- Criar exame adiciona um modelo imutável à biblioteca da clínica com parâmetros numéricos, textuais ou de opções. Nomes/sinônimos não alteram a identidade do exame. Não há edição retroativa dos modelos nesta versão.
- Corrigir cria um novo registro com motivo obrigatório, preservando autoria, horário e valores anteriores. O resumo, o gráfico e a exportação mostram apenas a revisão atual. O histórico detalhado mantém as anteriores.

## Banco e ativação

Aplicar, na sequência normal de migrações do projeto:

1. `20260914010000_exams.sql`: tabelas, RLS, RPC autenticada e auditoria.
2. `20260914010100_exam_catalog.sql`: catálogo inicial.
3. `20260914010200_exam_fhir.sql`: extensão do snapshot FHIR.

O código depende dessas três migrações. Esta entrega não aplica migrações ao Supabase hospedado nem publica na Vercel. Configurar o ambiente conforme `.env.example` antes de usar o aplicativo conectado.

`exam_definitions` tem modelos globais e modelos privados da clínica. `exam_results` é append-only, com vínculo clínica/paciente, exame, coleta, valores, anexo e revisão anterior. Gravações passam por `exam_write`, que valida o escopo, os tipos, a referência ao anexo e os conflitos de correção. RLS e `has_clinic_role` mantêm a proteção de MFA já existente. Secretárias continuam com seu acesso anterior aos anexos, mas não acessam resultados estruturados.

Resultados são incluídos na exportação existente como `DiagnosticReport` + `Observation`, com identificadores locais e sem inventar códigos LOINC. O dump do schema `public` usado pelo backup existente inclui as tabelas novas. Não houve ensaio do backup hospedado nesta entrega.

## Extração futura

`lib/exam-extraction.ts` define um contrato de proposta para um adaptador local ou externo: identificação do modelo, arquivo, página, trecho original, sugestões por campo, incerteza e avisos. Datas e valores desconhecidos permanecem ausentes. O contrato não é uma integração de OCR, e nenhuma imagem é enviada a um provedor.

A integração deverá apresentar a proposta para revisão antes de incorporá-la ao histórico, reutilizar a validação de valores e adicionar persistência de rascunhos/proveniência. Nesta versão, a origem persistida é exclusivamente manual e o banco não aceita proveniência externa arbitrária. O campo reservado e o contrato delimitam a extensão, sem declarar uma extração como já implementada.

## Verificação

`npm run test:exams` executa testes de busca, números, referências, correções, gráficos, exportação e migrações no PostgreSQL embarcado (PGlite, somente desenvolvimento). Os testes de banco usam funções sintéticas de autenticação e papéis; não substituem um ensaio no Supabase com Auth/Storage reais.

Também executar `npm exec tsc -- --noEmit` e `npm run build`. A conferência de interface deve cobrir lançamento de duas coletas, correção, modelo personalizado e telas estreitas.
