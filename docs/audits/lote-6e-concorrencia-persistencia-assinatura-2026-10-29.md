# Lote 6E — concorrência, persistência e recuperação de assinatura

**Veredito: APROVADO localmente para documentos e PDFs.** Escopo: `clinical_documents` e seus PDFs, incluindo preservação do caminho controlado SNCR. Nenhuma implantação ou migração remota.

Base confirmada antes das alterações: branch `work/checkpoint-lote-1-2026-10-27`, HEAD `e04d84c83f1229ac25d70146d20f7de74fcbf0f2` (`fix: secure Bird ID OAuth callbacks and session binding`), também confirmado diretamente no origin; Git limpo. Os relatórios 6B, 6C e 6D foram lidos. O registro de 344 testes do lote anterior é preservado como evidência daquele lote, sem ser confundido com uma nova execução.

## A. Arquivos modificados

Implementação:

- `app/api/digital-signature/sign/route.ts`: versão esperada e chave de idempotência opcional, contexto autenticado preservado.
- `components/documents/use-documents.ts`: envia a versão e permite consultar/retomar uma tentativa em andamento.
- `components/documents/editor.tsx`: congela os campos em `SIGNING` e `SUPERSEDED`, oferece consulta/retomada, preserva o caminho SNCR.
- `lib/signature/document-signing-service.ts`: delega somente o caminho comum ao novo orquestrador; OAuth e prova sintética externa permanecem no serviço.
- `lib/signature/document-signing-attempts.ts` (novo): coordenação de aquisição, resultado externo, journal cifrado, armazenamento e retomada.
- `lib/signature/types.ts`: vínculo opcional da assinatura à tentativa, compatível com registros antigos.
- `lib/supabase/documents.ts`: documentos `SUPERSEDED` também exigem o original, sem regeneração silenciosa.
- `supabase/migrations/20261029030000_document_signing_attempts.sql` (nova, bloqueada): tentativas, eventos, RPC e proteção de documento, metadados e Storage.

Testes e infraestrutura:

- `tests/signature-persistence-local.test.mjs` (novo).
- `tests/helpers/signing-persistence.mjs` (novo).
- `tests/helpers/signing-process.mjs` (novo): processos Node independentes, encerrados com SIGKILL nos pontos de falha.
- `tests/document-signing-identity.test.mjs`: adapta o transporte da tentativa nos testes de identidade 6B; conserva os casos anteriores.
- `tests/document-signing-route.test.mjs`: parâmetros incompatíveis de versão/idempotência.
- `tests/signed-document-retrieval.test.mjs`: original em `SUPERSEDED`, ausência e preservação de compatibilidade histórica.
- `tests/signature-trust-flow.test.mjs`: esquema completo 6E, Storage sintético com registro real de objeto e finalização pela RPC.
- `tests/signature-trust-permissions.test.mjs`: inventário do banco-base 6C exclui a migração posterior 6E.
- `tests/helpers/signature-trust-rest.mjs`: transporte REST assíncrono para não bloquear callbacks das conexões SQL concorrentes.
- `tests/helpers/signature-trust-db.mjs`: aplica a migração somente por opção explícita, amplia a interface mínima de Storage e aplica o histórico em um único processo psql.
- Este relatório.

Não foram modificados o PAdES, o cliente PSC, OAuth 6D, as migrações históricas, os modelos Anvisa ou as funções de numeração SNCR. O congelamento 6B foi estendido por migração incremental ao estado `SUPERSEDED`, inclusive em documentos históricos sem tentativa 6E; nenhum registro histórico ou byte foi modificado.

## B. Defeito original e solução

O mapeamento encontrou `DocumentSigningService.signClinicalDocument`, `signReservedSimulation`/`recoverSimulation`, as RPCs `sncr_begin_signing`/`sncr_save_artifact`/`sncr_finish_signing` e a recuperação de PDF em `lib/supabase/documents.ts`. A assinatura CMS nativa de evoluções em `EvolutionSigningService` é um fluxo separado, sem PDF, e não recebe a nova máquina de estados deste lote.

Na base 6D, o caminho comum já conferia o resultado da aquisição condicional de `SIGNING`, vinculava autor/versão/identidade e usava `upsert: false`. Portanto, as descrições antigas de aquisição sem condição e upload com overwrite não foram tratadas como defeitos ainda presentes nessa base.

Permaneciam a tentativa representada por UUID em auditoria, sem protocolo próprio de retomada, o caminho de arquivo fixo por documento/versão e as operações separadas de INSERT de metadados e UPDATE do documento. Não havia recibo durável com os bytes retornados pelo HSM. Uma falha após o INSERT podia deixar metadados positivos sem a conclusão documental, e repetir uma conclusão retornava 409 sem recuperar o resultado.

Antes das alterações de produção, três testes reproduziram: recusa da repetição após conclusão, metadados órfãos quando a atualização final falha e ausência do vínculo estruturado da tentativa. Os cenários foram incorporados à suíte PostgreSQL definitiva. Log anterior à correção: `/tmp/psywrite-6e-reproduction.log`.

A correção acrescenta um protocolo próprio para o caminho comum: tentativa única por documento/versão, posse exclusiva antes do HSM, recibo cifrado dos bytes recebidos, entrega sem overwrite e conclusão PostgreSQL única para tentativa, assinatura e documento.

## C. Máquina de estados

| Estado | Evidência persistida / ação permitida |
|---|---|
| `ACQUIRED` | Documento adquirido; dono e lease persistidos; ainda não há chamada externa. |
| `PREPARED` | Hash do PDF sem assinatura e digest solicitado ao HSM registrados. |
| `EXTERNAL_STARTED` | COMMIT de intenção externa confirmado antes de chamar o provedor; a assinatura pode ter ocorrido. |
| `UNCERTAIN` | Timeout, interrupção ou intenção externa vencida sem recibo; nenhuma nova chamada automática ao HSM. |
| `ARTIFACT_RECEIVED` | PDF assinado, hash, tamanho e metadados preservados em journal cifrado no PostgreSQL; pode entregar os mesmos bytes ao Storage. |
| `ARTIFACT_STORED` | Objeto registrado no Storage e bytes relidos/verificados; pode concluir a transação sem HSM. |
| `COMPLETED` | Uma assinatura, documento `SIGNED`, caminho e evento concluídos atomicamente; ciphertext provisório removido. |
| `PREPARATION_FAILED` | Falha comprovadamente anterior ao gate externo; a mesma tentativa pode adquirir novo dono e refazer a preparação. |
| `REJECTED` | Resultado CMS/identidade recusado; documento conservado em `SIGNING`, sem nova assinatura automática. |

`document_signing_events` conserva as transições. A auditoria registra tentativa, versão, estado e motivo, sem PDF, ciphertext, CPF, token ou código OAuth. Não há transição automática de `UNCERTAIN`/`REJECTED` para uma nova assinatura.

## D. Aquisição exclusiva

`document_signing_operation` é `SECURITY DEFINER`, tem `search_path=pg_catalog,public,pg_temp` e EXECUTE apenas para `service_role`. As tabelas de tentativa/eventos têm RLS e nenhum acesso frontend; o backend não recebe mutação direta nessas tabelas.

A RPC trava a linha do documento e confere clínica, autor, papel médico, versão, estado, sessão do certificado, CPF, inscrição e certificado persistidos. O fingerprint é confrontado com SHA-256 do DER do certificado no próprio PostgreSQL. A análise do CPF/certificado e o confronto do certificado efetivamente verificado no CMS permanecem no backend do 6B. A ordem de locks de perfil/sessão acompanha a do OAuth 6D.

Há unicidade real de `(document_id, document_version)` e `(clinic_id, user_id, idempotency_key)`. Cada posse possui `owner_token` gerado no servidor e lease de dois minutos. Uma retomada antes do gate pode substituir um dono vencido; o processo antigo não consegue liberar o HSM com seu token anterior. O vencimento após `EXTERNAL_STARTED` apenas transforma a tentativa em `UNCERTAIN`.

O gate externo valida novamente documento e identidade, altera o estado e confirma o COMMIT antes da chamada ao PSC. Uma resposta perdida desse COMMIT também não autoriza outra chamada.

Versões históricas com metadados de assinatura ou auditoria de início/resultado incerto também são bloqueadas quando não há tentativa 6E. Um estado `SIGNATURE_FAILED` histórico sem recibo estruturado de fase também exige revisão, mesmo sem metadados/auditoria localizáveis. Ausência de registro não prova ausência de HSM. Uma nova versão após `PREPARATION_FAILED` 6E comprovadamente anterior ao HSM continua permitida. A consulta do histórico possui índice parcial e normaliza a grafia do UUID.

Documentos com reserva ou modalidade controlada são recusados pela RPC comum. O serviço mantém a delegação às RPCs SNCR, que validam reserva, modalidade, ambiente, prescritor e versão e preservam sua própria idempotência. As tabelas de numeração não foram usadas como tabela genérica de tentativas.

## E. Idempotência

Sem chave fornecida, usa-se uma chave determinística de documento/versão. Uma chave pode ser enviada no corpo ou em `Idempotency-Key`; valores divergentes entre os dois lugares são recusados. O usuário/clínica continuam vindo exclusivamente do contexto autenticado.

A mesma chave com outro documento, versão ou identidade é recusada no PostgreSQL. Chaves diferentes também não criam duas tentativas para a mesma versão. Repetições durante o gate externo ficam bloqueadas. Depois de receber o PDF, a repetição usa o recibo/objeto da tentativa original; depois da conclusão, devolve o original verificado.

A posse não é uma autorização para qualquer conteúdo: o snapshot da versão documental fica congelado e os hashes se referem ao PDF preparado para aquela tentativa. Não existe reexecução de `signHash` para reparar upload, metadados, resposta HTTP ou confirmação perdida.

## F. Armazenamento sem sobrescrita

O caminho novo é `<clínica>/signature-attempts/<documento>_v<versão>/<tentativa>.pdf`. O upload usa `upsert: false` e inclui tentativa e SHA-256 em `user_metadata`. Se o objeto já existe, ele é relido e aceito somente quando tamanho, hash e CMS correspondem; bytes diferentes causam erro e nunca são substituídos.

Antes do upload, o PDF original retornado é cifrado com AES-GCM pela infraestrutura já existente e gravado no PostgreSQL, vinculado a tentativa, documento e versão. Esse registro permite retomar uma indisponibilidade de Storage sem gerar um PDF novo nem pedir outro CMS ao HSM. O ciphertext é apagado na conclusão; o objeto definitivo permanece.

O trigger de Storage nega INSERT frontend nos caminhos reservados e UPDATE/DELETE/renomeação de objetos de assinatura, inclusive pelo papel de serviço. Também protege caminhos históricos registrados como assinados, sem alterar registros ou bytes antigos. Os triggers que consultam vínculos privados têm DEFINER com search_path fixo e sem EXECUTE para clientes; não são RPCs de elevação de privilégio.

Foi inspecionado o código da imagem local Storage API 1.77.5: ela faz uma sondagem de permissão com INSERT revertido, com `contentLength` antes do `size` definitivo. Essa sondagem foi reproduzida no PostgreSQL. A conclusão continua exigindo o objeto definitivo com hash/tamanho/identificador compatíveis. O transporte de bytes de Storage nos testes é simulado; não se declara homologação da Storage API real.

Após `ARTIFACT_STORED` ou `COMPLETED`, objeto ausente/corrompido retorna erro explícito; não se regenera nem se repõe silenciosamente o original. `SIGNED` e `SUPERSEDED` seguem a recuperação original; autor, versão e consulta de históricos substituídos também ficam congelados, conservando a transição legítima `SIGNED` → `SUPERSEDED`; registros históricos sem hash mantêm a compatibilidade anterior, sem receber validação retroativa.

## G. Finalização e recuperação

A sequência comum é: adquirir → preparar digest → confirmar gate → chamar HSM → embutir/verificar CMS e identidade → registrar PDF cifrado → entregar/reler original → confirmar objeto → concluir no PostgreSQL.

O backend confere hash, tamanho, CMS e certificado dos bytes relidos. A RPC verifica a presença e a identidade do registro em `storage.objects`, o snapshot documental, o signatário e os estados permitidos. PostgreSQL não lê nem valida criptograficamente o blob remoto; a prova dos bytes é feita pelo backend, e a proteção contra alteração preserva o objeto que foi confirmado.

A transação final insere os metadados com `signing_attempt_id`, conclui a tentativa, limpa o ciphertext e altera o documento para `SIGNED` com o caminho correto. A unicidade e os guards impedem duplicação e conclusão fora da tentativa. INSERT direto de `digital_signatures` pelo papel de serviço foi revogado; os fluxos comum e SNCR finalizam pelas respectivas RPCs. A confiança permanece **`UNVERIFIED`**, separada da integridade CMS verificada localmente.

Uma falha após upload retoma o objeto ou o journal recebido. Uma resposta perdida após COMMIT final conserva `COMPLETED`; nova requisição lê o mesmo resultado. Um processo Node novo consegue finalizar o artefato persistido, sem depender da memória do processo encerrado.

Há uma janela inevitável entre a operação externa e a gravação de seu recibo. Se o processo morre ou o banco permanece indisponível antes de tornar os bytes duráveis, o resultado fica incerto. O adaptador existente não fornece uma consulta oficial documentada para esse resultado; nenhum endpoint foi inventado. Essa tentativa exige reconciliação operacional explícita, e nunca é reiniciada automaticamente.

## H. Testes de concorrência e falhas

**Resultados finais: 368 testes distintos aprovados em pelo menos uma execução, sem falhas finais nos testes.** A regressão integrada teve 362 de 363 aprovados; o caso restante, de dez solicitações, passou em reexecução pontual após o transporte de teste PostgREST tornar-se assíncrono: uma tentativa, uma chamada ao HSM simulado, um artefato e uma conclusão.

Os testes novos usam PostgreSQL Supabase 17.6.1.171, com o histórico completo de migrações e cópias exclusivamente descartáveis dos scripts bloqueados. Acesso REST usa PostgREST 14.5 real. Há disputas em duas e dez conexões PostgreSQL independentes e solicitações concorrentes do serviço. O PSC e os bytes de Storage são sintéticos; a existência/metadados dos objetos são gravados no PostgreSQL real.

| Cenário | Resultado exigido e observado nos ensaios específicos |
|---|---|
| Falha antes da aquisição | Zero tentativas, HSMs, artefatos e metadados; documento permanece disponível. |
| Duas/dez solicitações concorrentes | Uma tentativa, uma chamada ao HSM simulado, um artefato, uma assinatura e documento `SIGNED`. |
| Mesma chave / chaves diferentes | Uma posse para a versão; parâmetros incompatíveis recusados; nenhuma segunda operação externa. |
| Resposta perdida após criar tentativa | Tentativa durável; retomada após lease, com novo dono e mesma tentativa, antes de qualquer HSM. |
| Falha de preparação | `PREPARATION_FAILED`, zero HSM; retomada segura antes do gate. |
| Resposta do gate perdida / timeout HSM | `UNCERTAIN`; nova assinatura bloqueada. |
| PDF recebido e Storage indisponível | `ARTIFACT_RECEIVED`; retoma os mesmos bytes; HSM permanece em uma chamada. |
| Upload com resposta perdida | Relê o objeto original, conclui uma vez, sem overwrite. |
| Storage confirmado e banco falha | `ARTIFACT_STORED`; usa o mesmo objeto e finaliza sem HSM. |
| Erro SQL após INSERT de metadados | Rollback real conserva zero metadados concluídos; documento `SIGNING`; retomada cria uma conclusão. |
| COMMIT final com resposta perdida | Uma conclusão persistida; repetição não duplica assinatura/artefato. |
| SIGKILL após persistir artefato | Segundo processo Node independente conclui; um HSM, um upload e uma assinatura. |
| SIGKILL após HSM sem receber retorno | Segundo processo fica bloqueado; um HSM, nenhum novo artefato ou assinatura. |
| Edição concorrente | Ou a edição muda a versão antes da aquisição e ela é recusada, ou a aquisição vence e a edição falha. |
| Tentativa externa antiga | Passa para `UNCERTAIN` e continua bloqueada, sem liberar outra operação. |
| Original ausente/corrompido ou journal adulterado | Erro explícito; sem regeneração, overwrite ou HSM adicional. |
| Retomadas concorrentes | Finalizam o mesmo artefato apenas uma vez. |
| A/B/B2 com o esquema 6E completo | Duas solicitações conservam uma chamada simulada, uma reserva/numeração, um artefato e uma conclusão; replay devolve os mesmos bytes. |

Foram verificados RLS/ACL, EXECUTE de funções, search_path, fingerprint incompatível no banco, falha de identidade durante o HSM, alteração de autor/clínica/versão/consulta/numeração/caminho e imutabilidade de objeto inclusive para `service_role`. Quando RLS filtra uma escrita frontend para zero linhas, os testes aceitam esse resultado somente conferindo que nenhuma linha foi alterada; não presumem que toda negação deva lançar exceção.

## I. Regressão e verificações estáticas

A regressão integrada foi executada uma única vez, em sequência, com os testes novos, identidade 6B, permissões/fluxo 6C, OAuth 6D, PAdES, recuperação de originais, salvamento antes da assinatura, receitas simples, RCE, A/B/B2, autenticação e reservas SNCR. A execução teve 362/363 aprovados; o caso restante passou na reexecução pontual. No total são 368 casos distintos aprovados: 317 regressões existentes e 51 novos (46 de persistência/SQL, três de rota e dois de recuperação). As reexecuções não foram contadas novamente. Não foi repetido o ensaio antigo de estresse de numeração a cada alteração; as novas disputas de assinatura foram efetivamente testadas em PostgreSQL.

Foi reutilizado um único PostgreSQL descartável, sem rede externa, portas ou volumes, usando a imagem local disponível via Podman. Os processos PostgREST temporários usam somente o namespace de rede isolado dele. Nenhum `.env` é carregado pelos testes, e seus transportes recusam destinos externos. Os testes de processo usam IPC com o harness de banco/Storage/HSM, preservando serviços externos ao processo da aplicação.

- TypeScript sem cache incremental: aprovado.
- Build de produção local: aprovado.
- Lint direcionado da implementação/testes novos: aprovado.
- `git diff --check`: aprovado até este registro.
- **Dívida preexistente:** `components/documents/use-documents.ts` tem três erros de lint: um tipo importado sem uso e dois apontamentos de dependências/cleanup de efeito React. Os mesmos três foram reproduzidos extraindo esse arquivo de `e04d84c`; não foram introduzidos por este lote nem corrigidos por refatoração alheia ao escopo. O lint do componente novo alterado `editor.tsx` passou.

Logs: `/tmp/psywrite-6e-regression.log`, `/tmp/psywrite-6e-closing.log`, `/tmp/psywrite-6e-legacy-failed.log`, `/tmp/psywrite-6e-local-full.log`, `/tmp/psywrite-6e-extra.log`, `/tmp/psywrite-6e-sncr-combined.log`, `/tmp/psywrite-6e-trust-flow.log`, `/tmp/psywrite-6e-identity.log`, `/tmp/psywrite-6e-recovery-route.log`, `/tmp/psywrite-6e-build.log` e `/tmp/psywrite-6e-lint-baseline.log`.

Na primeira execução específica, 35 de 36 casos passaram; a expectativa de exceção para uma escrita frontend filtrada para zero linhas foi ajustada e passou, sem relaxar a proteção. Uma execução preliminar de seis casos teve uma falha na primeira conclusão, sem causa determinada nessa execução; o caso passou isoladamente e nas execuções completas seguintes. A instrumentação passou a conservar somente nomes de fases/códigos, sem segredos, para diagnóstico. O fechamento pontual teve 5/5 casos aprovados e os dois casos de legado tiveram 2/2 aprovados.

## J. Limitações e riscos restantes

- Resultado externo sem recibo durável exige tratamento operacional. Não há retry automático nem endpoint de consulta presumido. Se não houver resultado oficial ou bytes recuperáveis, a versão permanece bloqueada.
- Recuperação de resultado já recebido continua submetida à identidade do 6B. Perfil/certificado incompatível, sessão original revogada ou expirada impedem finalização automática e exigem revisão; isso não libera outra assinatura.
- A transação PostgreSQL não inclui HSM nem blob remoto. A estratégia depende da confirmação e imutabilidade do Storage e foi testada com bytes sintéticos e registros reais no PostgreSQL; comportamento completo do serviço Storage/GoTrue no ambiente hospedado ainda exige ensaio próprio.
- Journal cifrado tem limites de tamanho e depende da preservação da chave já exigida pela assinatura. Artefatos provisórios sem conclusão requerem acompanhamento operacional; não foi criado job de descarte ou de nova assinatura.
- Documentos históricos não foram reassinados, migrados ou promovidos em confiança. Uma tentativa antiga sem a estrutura 6E não é inferida ou reiniciada automaticamente.
- O fluxo CMS nativo de evoluções não foi alterado e não herda esta máquina de estados; este veredito é para os documentos/PDFs aqui testados. O ensaio não é homologação externa, Anvisa ou ICP-Brasil.
- Validação completa de cadeia, revogação, temporalidade e confiança ICP-Brasil continua no Lote 6F. O lote não foi iniciado.
- Aplicação remota das migrações, revisão do esquema/privilégios/objetos históricos e ensaio do Storage no destino permanecem pendentes. A migração 6E original conserva a exceção que impede aplicação acidental.

## K. Estado final do Git

Branch `work/checkpoint-lote-1-2026-10-27`, HEAD `e04d84c83f1229ac25d70146d20f7de74fcbf0f2`: 13 arquivos modificados e seis novos, sem staging. Nenhum commit, push, merge, deploy ou migração remota foi executado neste lote. Não houve assinatura Bird ID real, autenticação gov.br real, chamada Anvisa ou operação com pacientes reais.

## L. Veredito

**APROVADO localmente para o fluxo de documentos/PDF.** O PsyWrite impede assinaturas concorrentes e recupera as falhas intermediárias testadas sem uma segunda assinatura e sem perda de integridade nesse fluxo localmente validado. Quando o resultado externo não possui recibo durável, a tentativa permanece bloqueada e exige reconciliação operacional segura. As limitações da seção J permanecem.
