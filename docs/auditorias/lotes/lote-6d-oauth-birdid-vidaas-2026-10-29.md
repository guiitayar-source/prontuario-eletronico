# Lote 6D — OAuth Bird ID/VIDaaS, identidade e isolamento

**Veredito: APROVADO no escopo local do Lote 6D.** Não há implantação ou validação no Supabase hospedado.

## A. Base e causa das vulnerabilidades

Antes de alterar arquivos, foram confirmados a branch `work/checkpoint-lote-1-2026-10-27`, o HEAD `e07759d380f3ab07f7c18d6e83751038bfd27f31` (`fix: restrict signature trust records to backend`, Lote 6C) e o Git limpo. Foram lidos os relatórios 6B e 6C. A base do relatório 6C refere-se ao commit anterior; o próprio lote foi posteriormente consolidado em `e07759d`.

Mapeamento anterior à implementação:

| Etapa | Fluxo anterior Bird ID/VIDaaS | Comparação com SNCR / correção 6D |
|---|---|---|
| Início | GET autenticado, usuário/clínica do contexto Supabase | POST autenticado com origem e cabeçalho de ação |
| State | Aleatório, SHA-256 persistido por 15 minutos | 256 bits, hash com domínio PSC, validade de 5 minutos |
| PKCE | S256; verifier cifrado no banco | Preservado; verifier apagado na aquisição |
| Navegador | Sem prova de posse vinculada à tentativa | Segredo independente por tentativa em cookie HttpOnly |
| Sessão PsyWrite | Callback GET sem Bearer; recuperava usuário pelo state | GET intermediário, seguido de POST com Bearer validado e mesmo `session_id` |
| Consumo | DELETE somente depois de trocar código e gravar sessão | Aquisição transacional antes de qualquer HTTP ao PSC |
| Token | Troca, descoberta de certificado, gravações separadas | Sem retry; gravação transacional e nova conferência do contexto |
| Identidade | X.509 e CPF do perfil conforme 6B | Preservados, acrescidos de confronto com identidades anteriores e serialização |
| Uso posterior | 6B confronta autor/documento/perfil/sessão/certificado e CMS | Preservado; OAuth não autoriza assinar qualquer documento |

O state persistido funcionava indevidamente como prova suficiente para escolher a conta que receberia as credenciais. PKCE não demonstrava o usuário ou navegador que estava concluindo a operação. Duas requisições podiam ler o mesmo state antes da remoção e iniciar trocas externas independentes. Erros externos também podiam ser refletidos na URL final.

Foram criados e executados testes antes de alterar a implementação: **quatro falhas reproduzidas**, envolvendo ausência de navegador, ausência de sessão vinculada, duas trocas concorrentes e associação no GET somente pelo state. O transporte PSC foi sintético.

## B. Arquivos modificados

Implementação:

- `app/api/digital-signature/birdid/authorize/route.ts`
- `app/api/digital-signature/birdid/callback/route.ts`
- `app/api/digital-signature/birdid/complete/route.ts` (novo)
- `app/api/digital-signature/vidaas/authorize/route.ts`
- `app/signature/connect/page.tsx` (novo)
- `lib/signature/oauth-context.ts` (novo)
- `lib/signature/document-signing-service.ts` (somente fluxo OAuth)
- `lib/signature/psc-provider.ts` (troca OAuth e descoberta)
- `lib/signature/signature-tab.ts`
- `lib/supabase/server.ts` (extração do `session_id` após validação do Bearer)
- `next.config.ts`
- `supabase/migrations/20261029020000_signature_oauth_attempts.sql` (nova, bloqueada)

Testes e relatório:

- `tests/signature-oauth-reproduction.test.mjs` (novo)
- `tests/signature-oauth-context.test.mjs` (novo)
- `tests/signature-oauth-local.test.mjs` (novo)
- `tests/document-signing-identity.test.mjs` (adaptação dos três casos OAuth ao novo contrato)
- `tests/signature-trust-flow.test.mjs` (novo contrato OAuth e retenção do estado concluído)
- `tests/signature-trust-permissions.test.mjs` (inventário explícito do banco-base 6C, anterior ao 6D)
- `tests/helpers/signature-trust-db.mjs`
- `tests/helpers/signature-trust-rest.mjs`
- Este relatório.

As migrações anteriores, o motor PAdES, as rotas/serviços SNCR e os documentos históricos assinados não foram modificados.

## C. Proteção da tentativa e do navegador

Cada tentativa registra usuário, clínica, `session_id` do Supabase, provedor, hash do state, hash de um segredo do navegador e retorno configurado. O Bearer passa primeiro por `auth.getUser`; somente então seu payload fornece o `session_id`. A RPC também verifica a existência e o prazo `not_after` da sessão em `auth.sessions`, além do papel médico na clínica.

O início exige POST, `Origin` exata e `X-Signature-Action: 1`. O retorno deve estar explicitamente configurado em `BIRDID_REDIRECT_URI` ou `VIDAAS_REDIRECT_URI`, ter caminho de callback conhecido, HTTPS e ausência de credenciais, query ou fragmento. HTTP é aceito somente em loopback local de desenvolvimento/teste, sem Vercel. Não há fallback baseado em Host nem parâmetro de redirecionamento fornecido pelo navegador.

Cookies possuem nomes diferentes por tentativa, `HttpOnly`, `SameSite=Lax`, `Path=/`, sem `Domain`, e `Secure`/prefixo `__Host-` em HTTPS. Lax permite o retorno GET de navegação de nível superior do PSC. Fluxo por POST externo/form_post não é aceito. Não se utiliza fingerprint de navegador. A prova principal dura 300 segundos; o envelope de retorno cifrado dura 60 segundos e também tem validade interna conferida no servidor.

O GET do callback exige o segredo correspondente, remove código e state da URL com redirecionamento relativo 303, sem troca externa ou escolha de usuário. A página intermediária conclui uma única vez por POST autenticado. O identificador opaco de tentativa na URL intermediária é removido do histórico; não contém código ou token. Os cookies são apagados após a conclusão, inclusive em erro. Cookies duplicados, envelopes adulterados ou trocados entre tentativas são recusados.

O canal entre abas identifica a tentativa: concluir uma não fecha as outras. O retorno mantém o fluxo existente de recuperação da tela e preservação do trabalho aberto. Os dados da resposta do POST são somente `status: connected`, sem token/certificado bruto.

## D. Consumo atômico e resultado incerto

A RPC `signature_oauth_operation` é `SECURITY DEFINER`, com `search_path=pg_catalog,public,pg_temp`, execução somente por `service_role` e sem acesso frontend. Estados OAuth não admitem mais INSERT/DELETE diretos pelo `service_role` do fluxo; a RPC concentra suas mutações. As negações de escrita e leitura sensível do 6C permanecem.

O `claim` trava a linha, confere usuário/clínica/sessão/segredo/retorno/prazo e muda `pending` para `processing` na mesma transação, apagando o verifier persistido. O backend só chama o PSC depois da resposta desse COMMIT. Duas conexões PostgreSQL concorrentes foram exercitadas: apenas uma recebe o verifier. Respostas perdidas também não liberam nova troca.

Estados: `pending`, `processing`, `completed`, `expired`, `rejected`, `uncertain`. O prazo é sempre imposto antes da troca. Uma tentativa pendente vencida torna-se `expired` quando acessada; uma tentativa em processamento que ultrapassou o prazo torna-se `uncertain` quando acessada. Mesmo antes dessa atualização, `processing` já impede toda nova aquisição. Não foi criado job de retry ou de limpeza.

Código recusado explicitamente é terminal `rejected`; timeout, falha de comunicação e resultado externo indeterminado ficam `uncertain`. Falha em registrar o resultado conserva o claim durável. Se a resposta do COMMIT final se perder, uma sessão eventualmente já gravada não é duplicada nem revertida por uma nova tentativa de consumo. Não há retry de token exchange, nem repetição de POST causada por HTTP 401 do PSC: as falhas da conclusão são devolvidas como 409/403/422/503.

A gravação de perfil, revogação das sessões anteriores, inserção de credenciais e marcação `completed` ocorre em uma única transação. Um lock por usuário serializa conclusões independentes, inclusive entre clínicas. Sessão Auth e vínculo médico são novamente conferidos e protegidos por locks durante a conclusão. Logout ou perda do papel durante HTTP impede reconexão tardia.

## E. Vínculo da identidade

CPF declarado pelo PSC e CPF editável do perfil não bastam. O certificado X.509 retornado é efetivamente analisado; o CPF extraído deve ser utilizável e corresponder ao perfil e às identidades de sessões anteriores. Certificados anteriores também são analisados, evitando confiar apenas no CPF denormalizado dessas sessões.

Uma identidade anterior divergente impede a nova sessão e revoga as sessões locais anteriores do usuário para revisão. Uma nova autorização explícita do mesmo titular pode substituir o certificado anterior; a sessão nova conserva o certificado exato para o confronto posterior do 6B. Sessões legadas sem certificado são revogadas na reconexão; não recebem um certificado presumido. Tentativas OAuth legadas sem prova de contexto são rejeitadas pela migração.

Nenhum registro de confiança ICP-Brasil é promovido por este lote. Autenticação, correspondência de identidade e integridade CMS continuam distintas da validação de cadeia, revogação e confiança, reservada ao Lote 6F. As proteções de autoria/versão/identidade da assinatura do 6B permanecem obrigatórias.

## F. Testes negativos

Matriz exigida: médico A/B; navegador diferente; mesma conta com outra sessão Supabase; ausência, revogação e expiração de sessão; state inválido/expirado; repetição; concorrência em requisições e em conexões PostgreSQL independentes; código inválido; erro após claim; timeout; perda de resposta de COMMIT; origem/retorno arbitrários; domínio PSC distinto de SNCR; certificado/CPF incompatíveis; perfil editado frente a identidade anterior; certificado anterior incompatível com CPF denormalizado; sessão legada; cookies duplicados; envelope alterado/expirado/trocado; cancelamento; logout durante HTTP; tentativa de execução da RPC ou escrita direta pelo frontend.

As verificações de segredo inspecionam respostas finais e auditoria persistida, recusam reflexão de erros externos e conferem a exclusão dos callbacks Bird ID/VIDaaS/SNCR do logging de requisições Next, inclusive callback Bird ID com barra final. POSTs não devolvem códigos, tokens ou ciphertext. As chamadas de troca e descoberta recusam redirects HTTP e não usam cache.

Cobertura dos 20 requisitos de teste solicitados:

| Item | Cenário | Evidência local |
|---|---|---|
| 1 | Mesmo usuário e navegador | PKCE, cookie, sessão Auth e sessão cifrada concluída |
| 2 | Médico A → médico B | Recusa antes do PSC; nenhuma sessão para B |
| 3 | Outro navegador | Binding ausente/trocado recusado |
| 4 | Sem sessão válida | POST inválido; sessão Auth revogada ou vencida |
| 5 | State inválido | Formato inválido e identificador inexistente recusados |
| 6 | State expirado | Transição `expired`, sem HTTP |
| 7 | Repetição | Nenhuma segunda troca nem segunda sessão |
| 8 | Concorrência | Uma troca em callbacks concorrentes; um claim em duas conexões SQL |
| 9 | Falha após aquisição | Erro local, HTTP externo e resposta de COMMIT perdida |
| 10 | Timeout | `uncertain`, sem retry |
| 11 | Código inválido | `rejected`, erro externo sanitizado |
| 12 | Redirecionamento arbitrário | Origem/retorno/corpo forjados recusados ou ignorados |
| 13 | Duas tentativas do mesmo usuário | Cookies e states distintos; conclusões serializadas |
| 14 | Dois médicos simultâneos | Usuários e sessões distintos, sem mistura |
| 15 | State SNCR no Bird ID | Tentativa SNCR real no banco descartável; consumo Bird ID recusado |
| 16 | CPF/certificado divergentes | Sem nova sessão; perfil preservado |
| 17 | Sessão anterior incompatível | Revogação e revisão; legado sem certificado exige reconexão |
| 18 | Código/token em URL ou log | Redirects limpos, envelope cifrado, auditoria sanitizada e filtro Next |
| 19 | PAdES simulado | Integridade CMS, identidade, autoria e recuperação de bytes originais |
| 20 | Autenticação SNCR | 36 testes existentes preservados |

## G. Positivos e regressão

**344 testes distintos aprovados em pelo menos uma execução, sem falhas finais.** Não se contaram repetições como novos casos.

| Grupo | Casos distintos aprovados |
|---|---:|
| Novos testes OAuth: reprodução, contexto/HTTP/abas e PostgreSQL/PostgREST | 49 |
| Identidade/autoria 6B, rota e congelamento SQL | 42 |
| Permissões e fluxo 6C | 34 |
| Autenticação SNCR existente | 36 |
| Demais regressões: assinatura, recuperação, PDFs e SNCR | 183 |
| **Total** | **344** |

A única regressão integrada executou 343 casos: 336 passaram e sete falharam inicialmente (seis pela ausência do decoder QR e um pelo inventário do banco-base 6C). Todos os sete passaram nas reexecuções pontuais após resolver a causa. Um teste novo de perda da resposta do COMMIT final foi acrescentado e passou isoladamente, totalizando 344 casos distintos. Os dois outros casos complementares, de state SNCR real e reaplicação/legado, também passaram sem duplicar sua contagem. A integração SNCR tem 32 casos, todos aprovados ao considerar a reexecução dos três casos de QR.

As quatro falhas de reprodução anteriores à correção foram resolvidas. Nenhuma falha final de implementação ou falha preexistente de código ficou identificada neste conjunto.

O ensaio usa PostgreSQL Supabase 17.6.1.171 e PostgREST 14.5 reais, com migrações históricas completas e cópias descartáveis das migrações bloqueadas. Auth/GoTrue, PSC e bytes de Storage permanecem simulados. O ambiente desta execução apresenta Fedora 44 e Podman; Docker não está disponível neste executor. Foi criado um único PostgreSQL sem rede, portas ou volumes, reutilizado durante o lote e removido ao encerrar os ensaios. Os processos PostgREST temporários compartilham somente seu namespace de rede isolado.

A regressão integrada usa `node --test --test-concurrency=1` e inclui as três suítes OAuth novas, identidade/autoria/rota/SQL 6B, permissões/fluxo 6C, provedores, PAdES, salvamento antes de assinatura, recuperação de originais, autenticação/concorrência/integração/SQL/segurança SNCR, RCE e PDFs. Não carrega `.env` nos testes nem permite chamadas a um Supabase remoto.

Falhas de ambiente identificadas separadamente:

- Seis testes existentes de leitura de QR (três de PDF e três de integração SNCR) encontraram `spawnSync zbarimg ENOENT` na primeira regressão. Sem instalação no sistema, os RPMs oficiais Fedora de zbar 0.23.95 e suas bibliotecas foram extraídos em `/tmp/psywrite-6d-tools`. Após configurar os caminhos das bibliotecas/configuração GraphicsMagick, **os seis casos afetados passaram**, usando o decoder nativo real. Os demais casos já aprovados não foram contados novamente. O ensaio intermediário, ainda sem o caminho de configuração GraphicsMagick, também falhou somente nos três casos de PDF. Avisos do decoder e do DBus não impediram a decodificação.
- Uma execução complementar foi iniciada enquanto outro PostgREST de teste ainda ocupava a porta fixa do helper. Nenhum dos seus casos chegou a executar; a inicialização falhou. Trata-se de sobreposição indevida dos ensaios, não de falha demonstrada no OAuth. Essa execução complementar foi repetida isoladamente após a regressão: três aprovações, sem reiniciar o PostgreSQL.
- O caso 6C de inventário de migrações esperava todo arquivo SQL, inclusive o 6D recém-adicionado, embora o banco-base desse ensaio seja deliberadamente anterior ao 6D. A expectativa foi ajustada para excluir a nova migração; as permissões não foram relaxadas. A reexecução isolada passou: uma aprovação.
- Não foram identificadas falhas preexistentes de código neste conjunto. O lint geral fora do escopo não foi usado como critério; o lint direcionado aos arquivos deste lote passou.

Verificações de compilação: `npx tsc --noEmit --incremental false`, lint direcionado, `npm run build` e `git diff --check` passaram. O build inclui `/signature/connect` e as rotas de autorização, callback e conclusão.

Comando-base dos testes locais: `SNCR_TEST_CONTAINER_ENGINE=podman SNCR_TEST_CONTAINER_IMAGE=public.ecr.aws/supabase/postgres:17.6.1.171 SIGNATURE_TEST_REST_IMAGE=public.ecr.aws/supabase/postgrest:v14.5 node --test --test-concurrency=1 <arquivos>`. Logs locais em `/tmp/psywrite-6d-regression.log`, `/tmp/psywrite-6d-qr-fixed.log`, `/tmp/psywrite-6d-build.log`, `/tmp/psywrite-6d-reproduction.log`, `/tmp/psywrite-6d-extra-fixed.log`, `/tmp/psywrite-6d-permissions-fixed.log` e `/tmp/psywrite-6d-integrated-qr-fixed.log`.

## H. Pendências e limites

- Aplicação remota das migrações 6B/6C/6D e revisão do esquema, privilégios, sessões históricas e `auth.sessions` no ambiente de destino. Nenhuma aplicação foi autorizada ou executada neste lote.
- Configurar/conferir os callbacks HTTPS exatos e a chave de cifra no ambiente de destino. Conferir também a supressão de queries sensíveis nos logs de proxy/hospedagem; o controle demonstrado aqui cobre a aplicação Next e sua auditoria.
- Ensaio externo do contrato de redirecionamento/cookies com o PSC e GoTrue reais, em fase própria. Os testes locais não são homologação Bird ID/VIDaaS, Supabase hospedado, Anvisa ou ICP-Brasil.
- Na implementação validada, sessões históricas incompatíveis são bloqueadas/revogadas até revisão controlada. Este lote não cria procedimento administrativo de troca de titular.
- Validação completa ICP-Brasil permanece no Lote 6F. Numeração/emissão SNCR e modelos Anvisa permanecem fora deste lote.

Não houve autenticação Bird ID real, assinatura externa real, operação com pacientes reais, alteração de documento histórico assinado, deploy, push, commit ou migração remota. O Lote 6E não foi iniciado.

## I. Estado final do Git

Branch `work/checkpoint-lote-1-2026-10-27`, HEAD inalterado `e07759d380f3ab07f7c18d6e83751038bfd27f31`. São **13 arquivos modificados e oito arquivos novos**, todos deste lote, sem staging. `git diff --check` passou; os arquivos novos também foram inspecionados quanto a whitespace final. Não houve commit, push ou deploy.

## J. Veredito

**APROVADO localmente.**

**O PsyWrite impede agora a vinculação indevida de uma autenticação Bird ID a outro usuário e a reutilização de callbacks OAuth?**

**Sim, na implementação e no ambiente local validados.** State isolado de uso único, prova do navegador, mesmo usuário/clínica/sessão PsyWrite, aquisição atômica anterior ao HTTP e conferência transacional de identidade impedem os caminhos reproduzidos. Nenhum callback escolhe a conta somente pelo state persistido. Sem comprovação de contexto, a conclusão é bloqueada.

A operação no ambiente hospedado permanece pendente da revisão e aplicação das migrações e da validação externa indicadas em H. Este veredito não declara o Supabase remoto corrigido ou homologado. O Lote 6E não foi iniciado.
