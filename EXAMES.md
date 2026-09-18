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

As três migrações abaixo foram aplicadas ao projeto remoto `mywmszbmdqzwewhzdjug` em 14 de setembro de 2026. A conferência remota confirmou 25 modelos no catálogo, RLS nas duas tabelas, permissões de escrita e as funções de gravação e exportação FHIR. Não havia resultados de pacientes nesse momento.

1. `20260914010000_exams.sql`: tabelas, RLS, RPC autenticada e auditoria.
2. `20260914010100_exam_catalog.sql`: catálogo inicial.
3. `20260914010200_exam_fhir.sql`: extensão do snapshot FHIR.
4. `20260915010000_ai_reviewed_exams.sql`: origem e proveniência de sugestões de IA confirmadas pelo profissional.

O código depende dessas três migrações. A interface ainda precisa de publicação na Vercel para que o módulo apareça em `https://psywrite.vercel.app`.

`exam_definitions` tem modelos globais e modelos privados da clínica. `exam_results` é append-only, com vínculo clínica/paciente, exame, coleta, valores, anexo e revisão anterior. Gravações passam por `exam_write`, que valida o escopo, os tipos, a referência ao anexo e os conflitos de correção. RLS e `has_clinic_role` mantêm a proteção de MFA já existente. Secretárias continuam com seu acesso anterior aos anexos, mas não acessam resultados estruturados.

Resultados são incluídos na exportação existente como `DiagnosticReport` + `Observation`, com identificadores locais e sem inventar códigos LOINC. O dump do schema `public` usado pelo backup existente inclui as tabelas novas. Não houve ensaio do backup hospedado nesta entrega.

## Leitura por IA

PDFs e imagens classificados como exame podem ser enviados à ação **Ler com IA**. Depois do clique, o profissional escolhe entre Gemini 2.5 Flash, GPT-5.6 Luna e GPT-4o mini, desde que a chave do respectivo provedor esteja configurada. O backend confirma clínica, paciente, tipo e integridade do anexo, baixa o arquivo do Storage privado e o envia diretamente ao modelo escolhido. As chaves nunca são enviadas ao navegador. O modelo recebe o catálogo atual e devolve uma proposta estruturada com página, trecho original, sugestões, incerteza e avisos. Datas e valores desconhecidos permanecem ausentes.

A proposta fica apenas no navegador e não é um resultado. Cada exame precisa ser aberto, conferido e confirmado pelo médico. Somente então passa pela mesma validação de preenchimento manual e entra no histórico como `ai_reviewed`, com provedor, modelo, horário de extração, horário de revisão, autor e anexo de origem. Trechos extraídos não são duplicados no banco.

Em Documentos, **Transcrever** abre o texto como um novo rascunho não salvo. O profissional deve comparar com o arquivo, editar e salvar manualmente. A transcrição não resume, interpreta nem cria automaticamente um documento clínico definitivo.

Configure `OPENAI_API_KEY` e/ou `GEMINI_API_KEY` exclusivamente no servidor/Vercel. `OPENAI_EXAM_MODEL`, `OPENAI_TRANSCRIPTION_MODEL`, `GEMINI_EXAM_MODEL` e `GEMINI_TRANSCRIPTION_MODEL` são opcionais; os padrões são `gpt-4o-mini` e `gemini-2.5-flash`. Antes de dados reais, revise contrato, retenção, transferência internacional, base legal e demais controles LGPD. A configuração de não retenção de um provedor não equivale, sozinha, a Zero Data Retention.

## Verificação

`npm run test:exams` executa testes de busca, números, referências, correções, gráficos, exportação e migrações no PostgreSQL embarcado (PGlite, somente desenvolvimento). Os testes de banco usam funções sintéticas de autenticação e papéis; não substituem um ensaio no Supabase com Auth/Storage reais.

Também executar `npm exec tsc -- --noEmit` e `npm run build`. A conferência de interface deve cobrir lançamento de duas coletas, correção, modelo personalizado e telas estreitas.
