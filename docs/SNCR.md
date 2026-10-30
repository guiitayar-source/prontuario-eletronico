# SNCR: diagnóstico, implementação local e bloqueios de produção

Verificação em **19/10/2026**, incluindo nova consulta pública às 16h35 de Brasília. Sem deploy, sem migração remota e sem receitas ou pacientes reais nos testes. **O caminho completo da RCE está implementado para treinamento: reserva exclusiva de número → revisão → modelo eletrônico oficial → assinatura → armazenamento → recuperação do original. Foi executado com banco, paciente, número e certificado de teste. Ainda não foi validado do começo ao fim com a Anvisa e um certificado ICP-Brasil real; produção permanece bloqueada.**

O usuário informou ter feito login no gov.br. Até a última conferência desta execução, a bancada não recebeu o retorno de autenticação do SNCR e não registrou pedido real de numeração. Estar conectado à página geral gov.br não conclui o retorno específico à aplicação.

## Regra confirmada nas fontes oficiais

- [RDC 1.000/2025, texto consolidado na Anvisa](https://anvisalegis.datalegis.net/action/ActionDatalegis.php?acao=detalharAto&cod_menu=9451&cod_modulo=134&nomeTitulo=codigos&numeroAto=00001000&orgao=RDC%2FDC%2FANVISA%2FMS&seqAto=000&tipo=RDC&valorAno=2025): arts. 2–12 e 16–20. Vigência geral em **13/02/2026** (60 dias da publicação de 15/12/2025).
- [RDC 1.028/2026](https://anvisalegis.datalegis.net/action/ActionDatalegis.php?acao=abrirTextoAto&numeroAto=00001028&orgao=RDC%2FDC%2FANVISA%2FMS&seqAto=000&tipo=RDC&valorAno=2026): prorrogou a disponibilização das funcionalidades eletrônicas, antes prevista para 01/06, para **até 30/09/2026**; não prorrogou a vigência geral da RDC 1.000.
- [Orientação oficial de transição, 21/09/2026](https://www.gov.br/anvisa/pt-br/assuntos/noticias-anvisa/2026/inicio-de-nova-etapa-do-sncr-o-que-muda-a-partir-de-30-de-setembro): até **29/10/2026**, RCE/RET eletrônicas podem coexistir sem integração, observados os demais requisitos; **a partir de 30/10/2026**, a emissão eletrônica dessas categorias exige SNCR. Não é obrigação de abandonar o papel. O art. 18 trata também da aceitação por até 30 dias após início do registro de uso; não presumir uma validade adicional além da transição informada pela Agência.
- Não foi localizada prorrogação posterior do marco de 30/10 nas pesquisas oficiais desta data. [Página operacional, atualizada em 16/10](https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/documentos-do-sncr) reafirma a transição até 29/10. A publicação da notícia de disponibilização da API em 01/10 não foi interpretada como alteração autônoma do prazo.

| Categoria | Abrangência | Assinatura eletrônica | Numeração |
| --- | --- | --- | --- |
| RCE | C1, C5 e adendos A1/A2/B1, conforme Portaria 344 e atualizações | Qualificada ICP-Brasil (art. 8) | API, lote de 1.000, até 3 pedidos/mês por inscrição e categoria |
| RET | RDC 471/2021 e listas atualizadas; inclui antimicrobianos e agonistas GLP-1 conforme enquadramento | Avançada ou qualificada (art. 11); implementação existente continua ICP-Brasil | API, lote de 1.000; cota separada de RCE |
| NRA, NRB, NRB2 | Notificações A, B, B2 | Qualificada ICP-Brasil | Autorização da Visa para o prescritor, específica para meio eletrônico; API fornece 10–50 por pedido, até 50/dia/tipo/prescritor |
| NRR, NRT | Retinoides sistêmicos e talidomida | Qualificada ICP-Brasil; termos e regras específicos continuam aplicáveis | Mesmo fluxo de autorização Visa das notificações; modelos próprios |

A transição sem integração de RCE/RET não autoriza notificações eletrônicas sem SNCR. O certificado não substitui integração, numeração, modelo nem regularidade profissional. A FAQ técnica de integração publicada apresenta aparente contradição na pergunta 43 ao incluir RCE entre as que aceitariam assinatura avançada; foi aplicada a exigência expressa do art. 8 da RDC, mantendo ICP-Brasil.

Documento nato-digital e assinado eletronicamente é receita eletrônica. PDF impresso e assinado à mão segue a via física e seu modelo correspondente; digitalização ou imagem de assinatura não o transforma em receita eletrônica (art. 2, parágrafo único). Registro de conduta/medicação na evolução e salvamento de rascunho são registros clínicos, não emissão de receituário.

## Diagnóstico do checkout inicial

`main`, limpo no início, commit `595873d`; nenhuma instrução AGENTS.md encontrada nos ancestrais ou no projeto. Nenhuma implementação SNCR identificada na busca do código, rotas e migrações. A hipótese anterior foi confirmada para este checkout.

| Etapa | Comportamento encontrado | Lacuna/alteração |
| --- | --- | --- |
| Prescrição | `components/prescriptions.tsx`, editor compartilhado, texto livre, modelos por profissional, repetição com nova data | Só havia o tipo genérico Receita; agora há categoria explícita. Nenhum enquadramento automático de medicamentos foi presumido. |
| Registro | `document_write`: clínica, paciente, autor, versão, data opcional para receita; leitura médica via RLS | Rascunho não é receita emitida. Migração adiciona categoria, preserva RPC e trava edição durante assinatura. |
| PDF | `lib/document-pdf.ts`: todas as receitas renderizadas como RCE em 2 vias, timbre pessoal; data podia ficar vazia | Não é modelo eletrônico SNCR. Mantido para impressão/fluxo legado; outras categorias não podem reutilizá-lo. Texto excedente agora causa erro em vez de corte silencioso. O layout físico legado não foi certificado como equivalente ao modelo físico vigente. |
| Assinatura | Bird ID/VIDaaS, sessão individual, token cifrado no servidor, PAdES, verificação local | Preservada; agora exige autoria e adquire estado SIGNING por comparação de versão/status, evitando duas assinaturas simultâneas. Não há selo SNCR derivado de ICP-Brasil. |
| Armazenamento | Bucket privado `clinical-files`, metadados em `digital_signatures`, caminho na tabela clínica | Corrigida a regeneração silenciosa quando o arquivo assinado faltava: agora exige recuperação do original. |
| Validação | Integridade/criptografia e cadeia ICP fixada; sem consulta de revogação ou carimbo de tempo, conforme arquitetura existente | Não equivale a confirmação SNCR nem substitui o serviço ITI exigido na dispensação. Não foi criada afirmação nova de validade jurídica completa. |
| Entrega | Médico visualiza/baixa original assinado ou PDF para impressão | Não há portal/entrega direta ao paciente identificada neste fluxo. A responsabilidade de disponibilizar o arquivo original ao paciente permanece pendente de validação operacional. Não foi enviado documento a paciente. |

## Contrato técnico consultado

- [Manual API, arquivo `sncr_manual_api_v5.pdf`, 3ª edição, setembro/2026](https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/documentos-do-sncr/sncr_manual_api_v5.pdf/@@display-file/file), pp. 4–16.
- [Instruções de integração, julho/2026 v1.0](https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/documentos-do-sncr/instrucoes-de-integracao-api-sncr-v1-0.pdf/@@display-file/file), complementadas pela atualização de autenticação do manual atual.
- [Perguntas e Respostas SNCR 2.0: integração](https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/documentos-do-sncr/perguntas-e-respostas-sncr-2-0-integracao.pdf/@@display-file/file), especialmente questões 6–38, 49–53; tratar inconsistências como pendência, não como alteração da RDC.
- [Swagger de homologação](https://api-gateway.hmg.apps.anvisa.gov.br/api-sncr/swagger-ui/index.html#/), [OpenAPI consultado](https://api-gateway.hmg.apps.anvisa.gov.br/api-sncr/v3/api-docs), versão declarada 1.2.1. Snapshot local [openapi-hmg-2026-10-19.json](sncr/openapi-hmg-2026-10-19.json), SHA-256 `caddc75ac0ab073037f6eaf675b387ad0f832b9e99219ae82ae25c8b9be32893`. Na nova leitura das 16h35, a única diferença JSON foi o nonce aleatório do exemplo OAuth; os endpoints e schemas permaneciam iguais. A leitura pública não valida operações autenticadas.
- [Modelos eletrônicos oficiais](https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/receituario-eletronico), [RCE eletrônica](https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/receituario-eletronico/modelos-de-receituarios-eletronicos/receita-de-controle-especial-eletronica.pdf/@@display-file/file). Campos incluem número, emitente/CRM-UF/endereço/telefone, paciente/CPF ou passaporte/endereço, medicamento/concentração/forma/quantidade/posologia, identificação da plataforma, assinatura e data, verificação ITI e SNCR. Modelos não admitem customização comercial; QR de notificações deve direcionar a `https://sncr.anvisa.gov.br/receita/consultar?numero={numero}`. RET não tem modelo específico imposto nessa página.
- [Modelos físicos vigentes](https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/receituario-fisico): versão 2, obrigatória para novas impressões desde 18/05/2026. Manter impressão não significa declarar conformidade do layout legado.

Não existe credenciamento prévio, peticionamento Solicita, chave fixa de parceiro ou selo de homologação Anvisa exigido na documentação consultada. Prescritor se autentica individualmente via gov.br; o SNCR valida inscrição ativa. O CNPJ em RCE/RET é da **mantenedora do PsyWrite**, não da clínica cliente. O header `X-Jws-Integradora` aparece como **opcional** no Swagger consultado; não foi inventada obrigação nem implementado JWS sem contrato adicional.

Bases oficiais:

| Ambiente | Base API | Portal |
| --- | --- | --- |
| Homologação | `https://api-gateway.hmg.apps.anvisa.gov.br/api-sncr/api/v1/` | `https://sncr-treinamento.anvisa.gov.br/` |
| Produção (bloqueada no código nesta etapa) | `https://api-gateway.prd.apps.anvisa.gov.br/api-sncr/api/v1/` | `https://sncr.anvisa.gov.br/` |

Fluxo implementado, somente homologação: POST autenticado no PsyWrite cria operação durável → GET `auth/login?client_url=...` redireciona ao gov.br → retorno `session_id` → POST autenticado ao PsyWrite, vinculado a clínica/usuário/cookie HttpOnly → troca no servidor por GET `auth/token?session_id=...` com Origin correspondente → token só em memória → uma única chamada de numeração. Não há refresh token; manual informa 30 segundos para session token e access token. Callback `/sncr`, HTTPS em domínio .br ou localhost/127.0.0.1 em homologação. CNPJ e token nunca são aceitos do navegador como credenciais de numeração.

| Operação oficial | Payload implementado | Resposta |
| --- | --- | --- |
| POST `numeracoes/receita-especial-retencao` | `conselho`, `tipo` RCE/RET, `documento`, `uf`, `cnpj` | `inicio`, `fim`, `quantidade`, `mensagem` |
| POST `numeracoes/notificacao-receita` | `receita` NRA/NRB/NRB2/NRR/NRT, `conselho`, `uf`, `documento`, `quantidade` | `numeracoesReceita` lista, `saldoReceitas`, `mensagem` |

As chamadas desta implementação restringem conselho a CRM porque o PsyWrite atende médicos; não se declarou suporte clínico a odontologia/veterinária. Os números são strings para preservar zeros e pontuação. Notificações admitem retorno parcial, dentro da quantidade pedida. Não existe campo idempotency-key documentado para o POST remoto: nenhum foi inventado.

**Sequência implementada para RCE de treinamento:** obtenção de numeração → reserva exclusiva vinculada ao CRM/UF e congelamento do conteúdo → revisão do documento e conferência explícita de vínculo/disponibilidade do número pelo prescritor no portal → geração no modelo eletrônico oficial com número → assinatura pelo próprio prescritor (a data da assinatura é a emissão) → persistência e leitura de conferência do original → download. A prévia não assina nem entrega uma receita. O **registro de utilização** é feito pelo estabelecimento dispensador no portal SNCR, após validação ITI e da numeração, não por um endpoint de emissão fictício do PsyWrite. Não foi localizado endpoint público para upload/registro da receita assinada, cancelamento/devolução, consulta autônoma de saldo ou consulta de elegibilidade. Não há confirmação automática de regularidade SNCR no PsyWrite: a confirmação do prescritor é registrada como tal, sem convertê-la em resposta da Anvisa.

## Estado implementado e proteção contra falhas

`lib/sncr/client.ts`: transporte com URLs fixas oficiais, Origin fixado na configuração validada, sem redirecionamentos HTTP, timeout, corpo limitado, sem retry de POST, mensagens sem token/corpo de erro remoto. `workflow.ts`: sequência testável de autenticação, pedido, persistência do retorno e materialização em quarentena. `service.ts`: autorização médica/MFA existente, vínculo clínica/usuário/navegador, operação de uso único e consulta restrita ao solicitante. `/sncr` solicita numeração; a preparação, revisão e assinatura da RCE ficam no editor clínico, em painel próprio.

Salvar receita com o código novo exige a migração de categoria. O servidor verifica a coluna antes de escrever, para impedir que um RPC antigo ignore a categoria selecionada e salve uma notificação como RCE. Em falha, o editor preserva o texto. Novos PDFs assinados recebem caminho com hash e são gravados sem sobrescrever um original anterior.

Migração **somente preparada** `20261019010000_sncr_preparation.sql`:

- Pedidos, itens em quarentena e eventos append-only próprios. Operações service-role também deixam evento, diferentemente do trigger genérico que depende de `auth.uid()`.
- Banco não concede leitura/escrita dessas tabelas aos navegadores. RPCs de claim/materialização são exclusivas de service-role; chamadas no servidor sempre fornecem clínica e usuário autenticados.
- Claim transacional impede replay/callback simultâneo. Uma operação pendente, incerta ou não conferida bloqueia novos lotes do mesmo usuário/categoria, inclusive em outra clínica.
- Número único global por ambiente, inclusive entre clínicas; lote duplicado reverte integralmente. A primeira migração mantém os itens em quarentena; a segunda adiciona reserva, uso e inutilização exclusivamente para RCE de treinamento.
- Retorno bruto persistido antes de expandir intervalos. Resposta contraditória ou formato desconhecido fica em `CONTRACT_REVIEW`. Sem inventar decodificação de novos 16 dígitos.
- `UNKNOWN` (ou REQUESTING interrompido há mais de 30 segundos) não é retomado/repetido automaticamente. Se o processo morrer após o POST remoto e antes da persistência, o banco conserva a operação sem permitir novo pedido. Falha de autenticação acontece antes da chamada de numeração.
- Nenhuma rotina apaga/reaproveita números não utilizados ou os transfere entre prescritores/clínicas. Não há suposta sincronização offline posterior.
- Bloqueio de assinatura eletrônica de RCE a partir de 30/10, usando data de São Paulo, também no banco. Outras categorias não reutilizam a assinatura/modelo RCE. Assinaturas e documentos históricos não são migrados para um estado SNCR fictício.

Estados operacionais: `AUTH_PENDING`, `AUTH_EXPIRED`, `REQUESTING`, `AUTH_FAILED`, `REJECTED`, `UNKNOWN`, `CONTRACT_REVIEW`, `RECEIVED_UNVERIFIED`. Documento clínico mantém estados próprios DRAFT/SIGNING/SIGNED/SIGNATURE_FAILED; nenhum desses implica SNCR regular. Não foi criado um selo de integração pendente em documentos que nunca fizeram uma tentativa de integração.

### Emissão RCE implementada nesta continuação

Migração **somente local/preparada** `20261019020000_sncr_rce_issuance.sql`, `lib/sncr/rce*.ts`, `/api/sncr/rce` e `components/documents/rce-panel.tsx`:

- Uma medicação por receita, com concentração, forma, quantidade e posologia; paciente com CPF ou passaporte e endereço, prescritor com CRM/UF, CPF do certificado e dados profissionais. Os campos clínicos são salvos antes da reserva. O texto gerado substitui o texto livre somente após confirmação quando há diferença; as orientações devem estar na posologia.
- Usa o PDF eletrônico original da Anvisa, preservado em `assets/sncr/`, sem timbre comercial. A posologia longa continua em outras páginas do mesmo documento; campos que não cabem provocam erro antes de consumir um número. A prévia e todos os originais de treinamento têm marca de ausência de validade para dispensação. O QR usa apenas a entrada de treinamento documentada, sem inventar consulta por URL nesse ambiente.
- Reserva transacional por clínica, usuário, CRM/UF, documento e versão. Número globalmente único; snapshot imutável e hash canônico, independente da ordem de chaves JSONB. O documento clínico fica travado enquanto existir emissão ativa. Duplicar cria outro rascunho, preservando a emissão anterior.
- `AWAITING_REVIEW` aguarda revisão e conferência do número. `PREPARING` prepara os bytes. `SIGNING` é anterior ao único envio ao provedor. `FINALIZING` permite concluir Storage/banco com a assinatura já preservada. `SIGNED` exige original gravado e relido com o mesmo hash. `SIGNATURE_UNCERTAIN` e `BLOCKED` não repetem a assinatura. `CANCELLED` só é permitido antes do início da assinatura e inutiliza o número localmente. O lote recebe `ALLOCATED` após a reserva de todos os números.
- A aplicação usa as sessões reais existentes Bird ID/VIDaaS: token cifrado no servidor, validade do certificado, cadeia ICP-Brasil, CPF do prescritor e fingerprint. A data de emissão no PDF precisa coincidir com a data da assinatura em São Paulo. Não há assinador simulado nas rotas da aplicação.
- Os bytes preparados e o CMS são preservados antes de finalizar. Uma repetição depois de falha parcial reaproveita esses mesmos artefatos. O botão de recuperação de original perdido só restaura bytes com o hash exato do original assinado e assinatura verificada; não gera outro PDF nem chama o assinador. Arquivo divergente não é sobrescrito. A recuperação deixa evento próprio append-only.
- Tabelas e RPCs são privadas; o servidor exige a clínica e o usuário autenticados. Somente o próprio prescritor pode concluir, descartar ou recuperar sua emissão. Histórico/editor distinguem o documento de teste assinado do rascunho clínico; nenhum estado afirma regularidade confirmada automaticamente pelo SNCR.

### Bancada local sem acesso ao prontuário

`npm run test:sncr:lab` abre `http://127.0.0.1:3027/sncr`. Dados sintéticos ficam em `/tmp/psywrite-rce-lab`; não lê `.env`, não se conecta ao Supabase e não toca em pacientes da aplicação. Reutiliza o orquestrador, PDF e RPCs da RCE. Seu assinador é sempre simulado, mesmo após login real no gov.br. Para testar outra execução isolada, use `SNCR_LAB_DIRECTORY` com uma nova pasta em `/tmp`.

O modo “Preparar com numeração simulada” faz todo o percurso sem rede. O modo Anvisa requer que o usuário preencha o CNPJ da mantenedora e CRM/UF e clique no botão de login. O servidor troca o retorno por token e faz uma única solicitação de lote RCE de treinamento. Não envia nome, CPF ou endereço de pacientes. O resultado de numeração aparece separadamente da assinatura simulada. Nenhum resultado incerto é repetido automaticamente. Não usar um CNPJ fictício na comunicação real.

## Pendências concretas e responsáveis

| Pendência | Quem providencia | Como verificar |
| --- | --- | --- |
| Confirmar formato atual após anúncio de expansão 14 → 16 dígitos em 19/10 às 18h; múltiplos medicamentos também em atualização | Equipe técnica + Anvisa, se a documentação não for atualizada | Reabrir página operacional, baixar novo manual/schema, comparar snapshot, conferir intervalos e exemplos em homologação; não deduzir máscara/dígitos. |
| Validar vínculo da numeração com CRM/UF/CPF e cancelamentos | Equipe técnica + prescritor + Anvisa/Visa | Resposta atual não ecoa prescritor; nenhuma consulta API documentada foi encontrada. Definir procedimento oficial de validação, incluindo consulta no portal. Alerta oficial de 09/10 relatou números de outro prescritor e cancelamento dos afetados. Quarentena não pode ser removida só porque HTTP retornou sucesso. |
| CNPJ correto da mantenedora e endereço de retorno | Responsável pela operação do PsyWrite | Configurar somente servidor com `SNCR_ENVIRONMENT=hmg`, `SNCR_RETURN_URL` (origem da aplicação, caminho `/sncr`) e `SNCR_PLATFORM_CNPJ`. Nenhum segredo Anvisa fixo precisa ser solicitado. |
| Prescritor e cotas | Cada prescritor; Visa nas notificações | Login próprio gov.br, inscrição ativa; conferência da inscrição selecionada; autorização de numerações eletrônicas na Visa conforme procedimento local. Não emitir em nome de pessoa jurídica. |
| Schema local e auditoria de migração | Equipe técnica | Aplicar inicialmente em banco local descartável; depois auditar compatibilidade/acessos/backups e dry-run antes de qualquer migração remota, que não foi autorizada nesta etapa. |
| Emissão RET e notificações | Equipe técnica + prescritores responsáveis | Implementar modelos, campos e termos próprios. Nessas categorias há somente transporte/numeração; a emissão RCE de treinamento não pode ser reaproveitada como se fosse outro tipo. |
| Validação ITI, entrega e verificação pública | Equipe técnica + prescritor/farmácia | Original recuperável e disponibilizado ao paciente para qualquer dispensador, assinatura verificável no ITI, numeração verificável no portal; não confundir a verificação local com revogação/carimbo do tempo/ITI. |
| Teste real completo da RCE | Prescritor autorizado + equipe técnica | Apenas ambiente hmg, paciente fictício: login da bancada → lote → consulta do vínculo no portal → documento de teste. Depois, teste integrado no aplicativo com Bird ID/VIDaaS e verificação ITI. A assinatura da bancada é simulada e não demonstra funcionamento do provedor real. |

O ambiente prd está deliberadamente bloqueado no handler mesmo que alguém mude `SNCR_ENVIRONMENT=prd`. Não remover essa trava nem liberar a quarentena antes dos itens acima. O código não promete emissão SNCR offline ou devolução de números: a contingência oficial é o papel apropriado, com assinatura manual e demais requisitos de cada categoria.

Para recuperar falhas, consultar o pedido em `/sncr` ou no banco (equipe técnica) e seus `sncr_request_events`. Após AUTH_FAILED/AUTH_EXPIRED/REJECTED, o usuário pode preparar nova solicitação explicitamente. UNKNOWN/CONTRACT_REVIEW exigem conferência técnica. Em RECEIVED_UNVERIFIED, a RCE pode reservar um número para a revisão, mas exige confirmação explícita do vínculo no portal antes da assinatura. Não editar estado para liberar outro lote sem evidência e trilha de auditoria. Para a emissão, consultar `sncr_rce_events` e usar a recuperação da mesma emissão. Logs de proxy/observabilidade devem redigir query `session_id` e cabeçalhos de autenticação. Não registrar respostas de token. Um resultado incerto não é convertido em falha definitiva por decurso de tempo.

## O que falta, em termos práticos

1. **Programação:** o percurso básico RCE de treinamento já está implementado, inclusive PDF, assinatura, download e recuperação. Continua pendente adaptar a numeração de 16 dígitos quando houver contrato oficial atualizado, preparar a versão de produção com URL de consulta/validação oficialmente confirmada e concluir a aceitação operacional do modelo/documento. Uma medicação por receita é a limitação atual. RET e notificações ainda precisam de emissão própria. A rotina de registro da utilização pelo dispensador não é uma funcionalidade a inventar no PsyWrite.
2. **Comunicação real:** falta receber o retorno OAuth e testar uma solicitação de lote hmg, conferir os números no portal e a vinculação ao CRM/UF, executar a RCE no aplicativo com o provedor real e verificar o arquivo no ITI. Também falta observar falhas reais de autenticação/indisponibilidade e documentar os resultados. Testes simulados não substituem essas etapas. Não é necessário emitir receita real nem testar com pacientes reais.
3. **Ação do responsável pelo PsyWrite:** em [http://127.0.0.1:3027/sncr](http://127.0.0.1:3027/sncr), abrir “Testar a comunicação real com a Anvisa”, informar CNPJ da mantenedora, CRM/UF e clicar em “Entrar no gov.br e solicitar lote RCE de teste”; concluir pessoalmente o login. O botão já prepara o retorno e o pedido no servidor. Não enviar senha, token ou código no chat. Se receber lote, conferir o número escolhido no [portal de treinamento](https://sncr-treinamento.anvisa.gov.br/). Para testar o aplicativo real depois, o prescritor deve conectar Bird ID/VIDaaS e a equipe deve preparar um ambiente local isolado com as duas migrações e os parâmetros SNCR. Não há Solicita, chave fixa Anvisa ou pedido de talonário à Visa para esta etapa RCE. Nas notificações, a autorização da Visa é outra etapa, ainda fora do escopo implementado.
4. **Significado de homologação:** aqui significa testes reais no ambiente de treinamento, seguidos de verificação do resultado. **Não significa aprovação formal do software pela Anvisa.** A [FAQ oficial, pergunta 6](https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/documentos-do-sncr/perguntas-e-respostas-sncr-2-0-integracao.pdf/@@display-file/file) diz: “Não está previsto processo de credenciamento prévio, licenciamento ou concessão de 'selo de homologação' para empresas de software.” Estar no ambiente hmg ou passar os testes locais não equivale a ter concluído os testes reais.

**Ainda impede produção:** formato novo anunciado sem contrato atualizado conferido, ausência de teste autenticado Anvisa neste fluxo, ausência do teste conjunto com provedor ICP-Brasil e ITI, validação operacional da disponibilização do original, migrações ainda não aplicadas no ambiente de destino e trava de produção deliberadamente mantida. A revisão de migrações/configuração é da equipe técnica; não foi feito deploy nem alteração remota.

## Validação local

`npm run test:sncr`: transporte com respostas simuladas e banco PostgreSQL efêmero (PGlite), sem rede. Inclui `sncr-rce.test.mjs`, que executa o percurso completo da RCE e seis cenários de sucesso/falha. Cobre contrato do snapshot, categorias, cotas/formatos, token/Origin, URLs, expiração, cutoff em São Paulo, callbacks repetidos, isolamento de clínica/usuário/navegador, privilégios, duplicidade e rollback de lote, preservação do retorno, falha entre resposta e persistência, quarentena e travas clínicas. A RCE cobre certificado de outro prescritor, CMS inválido, assinatura incerta, perda de Storage/commit, recuperação exata e recusa de sobrescrever original divergente. Testes de PDF verificam que conteúdo não é cortado silenciosamente; o PDF RCE foi renderizado e inspecionado, corrigindo a origem do CropBox do modelo e sobreposições. Regressões de receitas, templates e assinaturas existentes são executadas separadamente. Testes reais completos permanecem **não realizados**.

Resultados desta execução:

- `npm run test:sncr`: passou.
- Regressões de nova receita, PDF para impressão, datas/templates no banco, provedores e fluxo de salvar antes de assinar: passaram.
- `npm run build` (inclui `tsc --noEmit`): passou.
- `npm run test:sncr:build`, após o build: passou. Executa a rota compilada do Next, com todo HTTP interceptado e banco sintético: autorização, reserva e abertura do PDF oficial. Detecta problemas de empacotamento que não aparecem no teste do módulo TypeScript. O carregamento do PDF foi corrigido para usar o caminho de arquivos incluído no pacote, como o gerador legado; não usa a URL `/_next/` transformada pelo webpack.
- Oxlint dos arquivos envolvidos: passou; `git diff --check`: passou.
- Na execução da suíte geral anterior à continuação RCE, `npm test`: 18 dos 19 arquivos passaram. O arquivo `digital-signature.test.mjs` falhou em duas expectativas de texto do CLI; 23 dos seus 25 casos passaram, incluindo os casos criptográficos. A falha do grupo CLI também foi reproduzida em cópia isolada de `HEAD` anterior às alterações (`595873d`). Nesta continuação foram repetidos os testes SNCR/RCE e as regressões indicadas acima; não se declara a suíte geral integralmente verde. Não foi alterada a criptografia nem o CLI para acomodar esse problema preexistente.
- A bancada também atingiu `SIGNED` e recuperou o original de teste no navegador, com número e certificado fictícios. Não certifica o formulário clínico autenticado contra um Supabase real.
- Nenhum teste automatizado usou credenciais gov.br, pacientes reais ou serviço remoto de emissão. A leitura do Swagger/manual público não constitui teste real de integração. O teste manual de comunicação hmg depende do retorno específico do login preparado na bancada.
