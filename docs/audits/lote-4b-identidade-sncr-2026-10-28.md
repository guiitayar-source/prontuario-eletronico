# Lote 4B — responsabilidade pela validação de identidade no SNCR

**Veredito: PARCIAL.** A responsabilidade pela validação CPF ↔ inscrição está documentada como parte do processamento do SNCR. A prova independente prévia pela plataforma, tratada como necessária no Lote 4, **não foi localizada como exigência nas fontes oficiais**. Permanece pendente definir e ensaiar a evidência operacional adequada para associar essa autorização transacional ao cadastro interno. Nenhum token ou resposta real de numeração foi obtido nesta execução.

Este relatório qualifica a interpretação do Lote 4; seu relatório histórico foi preservado integralmente. Não se conclui que a autenticação gov.br falhou porque o token não foi inspecionado ou porque sua resposta não contém CPF separado. O estado local `unverified` tem escopo mais restrito: a aplicação ainda não registrou uma comprovação oficial da correspondência entre conta interna e titular/inscrição daquela sessão.

## A. O que o contrato oficial efetivamente permite comprovar

As fontes públicas foram baixadas novamente. A página oficial continua listando `sncr_manual_api_v5.pdf` (3ª edição, setembro/2026) e o FAQ de integração (1ª edição). Os hashes dos PDFs são idênticos aos consultados no Lote 4. Não houve chamada a login, token ou recursos de numeração oficiais.

| Questão | Conclusão fundamentada | Fonte |
|---|---|---|
| O token representa identidade autenticada? | Sim, pelo contrato ele é emitido no fluxo individual gov.br intermediado pelo SNCR/Keycloak. Isso não equivale a termos verificado um token real ou validado localmente seus claims. A ausência de CPF exposto à plataforma não invalida o mecanismo. | Manual §§2.2.1–2.2.4; FAQ 16–17. |
| Há identidade verificável localmente no JWT? | O contrato consultado não especifica claims de CPF/inscrição, issuer/audience e descoberta/JWKS suficientes para implementar essa validação com confiança. Não foi afirmado que o token real não contém esses dados; nenhum token real foi coletado. | Manual §2.2.4.2: resposta com access_token e token_type; OpenAPI sem esquema de identidade. |
| Há endpoint documentado de consulta do próprio titular? | Não foi encontrado nas fontes consultadas. O OpenAPI publica somente dois POSTs de numeração. FAQ 21 trata da ausência de consulta pública de elegibilidade/cadastro de terceiros; não deve ser generalizado como prova de inexistência de um recurso autenticado não publicado. | OpenAPI paths; FAQ 21. |
| Há serviço oficial CPF ↔ CRM/UF acessível à plataforma? | O manual e o FAQ documentam o uso, pelo SNCR, das bases oficiais dos conselhos. Não fornecem um contrato de serviço separado para a plataforma consultar essa associação. Isso não é uma afirmação de que nenhum conselho oferece outros serviços fora do contrato SNCR. | Manual §2.3.2.2, p.13; FAQ 20 e 22, pp.8–9 impressas. |
| O SNCR realiza a validação na numeração? | Sim. O fluxograma de RCE/RET coloca na raia API SNCR a verificação de documento profissional pertencente ao CPF e a consulta à API do conselho. As regras exigem correspondência ao prescritor autenticado e inscrição ativa. Para notificações também há rejeição explícita de inscrição diferente da autenticada. | Manual §§2.3.2.2, 2.3.2.5.i e 2.3.2.7, pp.13–16; §§2.3.1.5.i e 2.3.1.7, pp.11–12; FAQ 22. |
| O sucesso fornece evidência da vinculação? | Pelo significado documentado da operação, o sucesso com corpo válido confirma a autorização da sessão utilizada para a inscrição requisitada e os números retornados **naquela transação**. Para usar essa evidência, a aplicação precisa ter executado a chamada no backend oficial por HTTPS e conservado a correlação entre sessão, requisição, ambiente e resposta. JSON avulso, HTTP 2xx isolado ou mock não são evidência oficial. | Manual §§2.3.1.4–2.3.1.6; §§2.3.2.4–2.3.2.6. |
| A resposta é comprovante independente de CPF? | Não. RCE/RET devolve inicio, fim, quantidade e mensagem; notificações devolve números, saldo e mensagem. Não há CPF/CRM ecoados nem recibo de identidade assinado no contrato desses corpos. A validade como evidência transacional não deve ser confundida com uma credencial reutilizável de identidade. | Manual §2.3.2.4, p.14, §2.3.1.4, p.11; schemas GerarResponse e NumeracaoReceitaDisponibilizadaResponse do OpenAPI. |
| A plataforma deve repetir a validação antes da chamada? | **Não foi localizada essa obrigação expressa.** O fluxo oficial autentica, solicita numeração e deixa a validação profissional com o SNCR. A plataforma continua responsável por usar a sessão correta, enviar a inscrição correta, bloquear rejeições e manter os vínculos de estoque/documentos. | Fluxograma §2.3.2.2 e FAQ 22. |

### Distinção que corrige o diagnóstico anterior

Existe um mecanismo oficial documentado de **validação transacional pelo SNCR**. Não existe, nas fontes consultadas, um contrato suficiente de **atestado prévio de CPF retornado à plataforma**. A falta do segundo não prova falha do primeiro e não deve criar, por interpretação, uma obrigação regulatória nova.

O bloqueio atual do PsyWrite é uma salvaguarda temporária do projeto, mantida conforme a instrução deste lote. Não se afirma que a Anvisa exige `identity_status=verified` local antes da primeira requisição de numeração. Uma futura integração pode delegar a validação da inscrição ao SNCR no processamento da própria operação, desde que o fluxo seja ensaiado, autorizado e corretamente correlacionado. Não é necessário presumir a obrigatoriedade de um endpoint de identidade ou de JWKS se esse não for o mecanismo oficial previsto.

O código de status sozinho não classifica todas as falhas: o manual também usa 404 para falha na comunicação com a API do conselho (§2.3.2.7, p.16). Portanto, um 404 não deve ser convertido automaticamente em diagnóstico de identidade divergente.

## B. O que o código já implementa corretamente

| Evidência no código | O que demonstra e seu limite |
|---|---|
| `lib/sncr/sessions.ts:85` | Tentativa aleatória vinculada ao contexto interno, com state e vínculo de navegador persistidos como hashes. Não afirma CPF gov.br. |
| `app/api/sncr/auth/complete/route.ts:15` | Contexto PsyWrite autenticado, papel médico e origem confrontados antes de concluir. Não aceita usuário/CRM do body como autoridade. |
| `lib/sncr/sessions.ts:175` | Claim transacional antes da troca; uso único e proteção contra conclusões concorrentes. |
| `app/api/sncr/auth/callback/[state]/route.ts:14` | Callback com cookie HttpOnly cifrado e redirect para URL limpa; sem troca de token em GET. |
| `lib/sncr/auth-http.ts:40` | Troca somente no endpoint oficial selecionado, com Origin, timeout, sem redirect/retry e erro sanitizado. Não prova o comportamento externo sem ensaio real. |
| `lib/sncr/session-crypto.ts:21` e `lib/sncr/sessions.ts:191` | Token cifrado e autenticado com contexto de clínica/usuário/ambiente/tentativa. Não promove o token a uma identidade por decodificação. |
| `supabase/migrations/20261028010000_sncr_sessions.sql:84` | A RPC confronta autor, clínica, ambiente, tentativa, prazo e snapshot profissional; frontend não tem acesso direto às tabelas ou funções privilegiadas. |
| `supabase/migrations/20261028010000_sncr_sessions.sql:29` | `identity_status` só admite unverified. Isso é estado interno da aplicação, não falha declarada do gov.br/SNCR. |
| `lib/sncr/sessions.ts:212` | Sessão ausente/expirada e inscrição divergente são rejeitadas; mesmo sessão com inscrição interna coincidente ainda não libera numeração oficial. |
| `lib/sncr/numbering.ts:124` | Documento autorizado, modalidade, ambiente, mantenedora e sessão são confrontados; o fluxo sintético continua separado. |

O perfil profissional preservado no snapshot fornece uma referência de coerência interna. O fato de o CRM ter sido digitado ou de o CPF constar do perfil não o transforma em validação oficial. Login PsyWrite, sessão SNCR e assinatura Bird ID continuam tecnicamente separados.

## C. Correções realizadas e decisões de escopo

Foram corrigidos somente comentários em `lib/sncr/numbering.ts` e `lib/sncr/sessions.ts`, além da mensagem de bloqueio em `sessions.ts`, para deixar claro que:

- o SNCR documenta a validação CPF ↔ inscrição na transação;
- não foi localizada obrigação de pré-prova independente pela plataforma;
- `unverified` representa a falta de comprovação local registrada e não invalida a autenticação oficial;
- a emissão continua bloqueada por decisão conservadora do projeto.

Não foi implementado um verificador de claims/JWKS, endpoint fictício ou promoção de identidade a partir de um mock. Não foi criada nova tabela, migração ou flag de liberação. Também não foi implementada, neste sublote, admissão de evidência de uma transação oficial: ainda não existe uma resposta oficial correlacionada neste ambiente, e os campos/escopo de comprovação a conservar precisam ser definidos sem confundir autorização transacional com atestado independente de CPF.

Este é um resultado parcial deliberadamente explícito: o mecanismo transacional e a distribuição de responsabilidades foram identificados, mas não foi concluída uma verificação oficial executável para a sessão atual. Os bloqueios não foram removidos apenas para aprovar o lote. O relatório histórico do Lote 4 e seus testes foram preservados.

## D. Testes e resultados desta execução

| Verificação executada agora | Resultado |
|---|---|
| `node tests/sncr-auth-local.test.mjs` | 36 aprovados, zero falhas, sem testes ignorados/cancelados. PostgreSQL real isolado e transporte SNCR explicitamente mock. |
| `node tests/sncr-safety.test.mjs` | 4 aprovados, zero falhas. |
| `node tests/sncr-maintainer.test.mjs` | 8 aprovados, zero falhas. |
| `tsc --noEmit --incremental false` | Aprovado. |
| Lint dos dois módulos de código tocados | Aprovado. |
| `git diff --check` e comparação com manifesto inicial | Aprovados. |

**Total desta execução: 48 testes aprovados e zero falhas.** Não são 48 testes de identidade oficial; os 36 de autenticação demonstram o comportamento local seguro. Incluem usuário errado, cookie trocado, JWT não confiável, inscrição diferente, ausência de sessão, expiração, dois usuários, isolamento de ambiente, rollback/resultado incerto, concorrência e reinicialização real do banco. Os casos de inscrição interna coincidente continuam bloqueados sem comprovação oficial.

Não houve necessidade de novos testes que espelhassem apenas os comentários ou a redação da mensagem. As suítes completas de PDF/assinatura e numeração 3A/3B não foram repetidas: não houve alteração desses mecanismos. O resultado histórico do Lote 4 permanece 164 aprovados e duas falhas CLI preexistentes; essas duas falhas não foram reexecutadas nem declaradas corrigidas neste sublote.

O PostgreSQL foi iniciado a partir da imagem já existente, sem pull, rede, portas ou volumes. Foram usados somente bancos exclusivos descartáveis e dados sintéticos; as cópias temporárias das migrações tiveram o bloqueio removido pelo harness, sem editar os arquivos originais. O contêiner foi encerrado ao terminar e os demais serviços locais foram preservados.

## E. Pendências e consulta à Anvisa

A [consulta técnica preparada](consulta-anvisa-identidade-sncr-2026-10-28.md) contém a pergunta solicitada, referências ao manual e questões objetivas sobre:

1. Confirmação de que o sucesso da operação é a validação prevista para o vínculo inscrição/titular, sem pré-consulta independente obrigatória.
2. Necessidade ou não de comparar, fora da transação, o CPF interno do médico com um identificador oficial do titular.
3. Evidência, identificador oficial, escopo e prazo de retenção necessários para demonstrar essa vinculação.
4. Existência de endpoint de identificação própria/claims verificáveis, caso sejam parte do mecanismo exigido.
5. Como conduzir os testes de homologação com contas e inscrições autorizadas.

**A consulta não foi enviada.** A documentação já permite atribuir a validação profissional ao SNCR; não se depende de resposta do órgão para reconhecer esse fato. O que precisa de esclarecimento é o mecanismo/evidência exigidos da plataforma para vinculação e auditoria, caso haja obrigação adicional à correlação transacional descrita.

### O que a homologação externa poderá demonstrar

Mediante autorização separada e contas/inscrições admitidas para teste, será possível observar:

- autenticação no fluxo oficial e retorno ao callback esperado;
- troca de sessão e comportamento de expiração;
- sucesso para inscrição compatível e rejeição para inscrição incompatível, preservando a correlação backend por usuário/ambiente;
- estrutura real da resposta de sucesso/erro e eventuais identificadores de transação;
- separação entre falha de identidade, falta de autorização e falha do serviço do conselho.

Essa etapa pode produzir evidência real da **autorização transacional em homologação**. Não transforma token apenas decodificado em prova, não comprova comportamento de produção e não define, por si só, a suficiência jurídica ou prazo de retenção dessa evidência. Um teste de numeração altera estoque/cota de homologação; não deve ser tratado como consulta de identidade sem efeitos. Não foi executado neste lote e não deve usar produção para essa finalidade.

Uma futura implementação de evidência transacional deverá limitar a conclusão à inscrição, ambiente e transação efetivamente aceitos, com proveniência distinta de mocks/sintéticos; conservar a referência interna da sessão e o contexto autorizado; e não promover uma resposta passada a identidade geral ou a validade indefinida de uma sessão nova. O contrato de retenção e o ensaio externo ainda estão pendentes; não há estado fictício de verificação criado antecipadamente.

## F. Estado do Git e preservação

Branch `work/checkpoint-lote-1-2026-10-27`, HEAD `b0a570e`, preservados. Nenhum commit, staging, push, deploy ou migração remota foi realizado.

Os 16 arquivos do Lote 4 foram inventariados por SHA-256 no início. Apenas os dois módulos descritos em C receberam ajustes de comentário/mensagem; os outros 14 continuam byte a byte iguais, incluindo o relatório e os testes do Lote 4. Foram adicionados este relatório e o rascunho da consulta. Estado final: quatro arquivos rastreados modificados e 14 arquivos novos, total 18 arquivos desde o checkpoint.

Não foram alterados arquivos privados, configuração real da mantenedora, credenciais, documentos assinados ou dados de pacientes. As duas migrações SNCR conservam seus bloqueios de aplicação acidental.

## G. Veredito

**PARCIAL.** A interpretação do contrato foi corrigida: o SNCR realiza a validação profissional durante a operação, e não foi encontrada obrigação de repeti-la previamente fora dele. Não foi obtida evidência oficial da vinculação de uma sessão concreta ao cadastro interno, nem implantado mecanismo que pudesse alegá-la sem suporte suficiente.

`unverified` e os bloqueios reais permanecem. A consulta está pronta para revisão e o procedimento de homologação está delimitado, sem ter sido executado. O Lote 5 não foi iniciado.

## Fontes oficiais e reprodução documental

- [Página oficial de documentos](https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/documentos-do-sncr).
- [Manual API SNCR, 3ª edição, setembro/2026](https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/documentos-do-sncr/sncr_manual_api_v5.pdf/@@download/file). Páginas 13–15 e fluxograma §2.3.2.2 também conferidos visualmente. SHA-256: `dbaed56de26b42c739c5eedda5b688bf4c42249f75d151c5e57d6541e62a39bb`.
- [FAQ de integração, 1ª edição](https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/documentos-do-sncr/perguntas-e-respostas-sncr-2-0-integracao.pdf/@@download/file). SHA-256: `3d7d92f2b08c174e9bb57c27f2cae5d04f5255044c0864d9431d50299450366e`.
- [OpenAPI de homologação](https://api-gateway.hmg.apps.anvisa.gov.br/api-sncr/v3/api-docs), HTTP 200, info.version=1.2.1. SHA-256 do conteúdo consultado: `5f57375694b3cbd5f3d014f0c8a735d0c15f0898c8b88541e591c080f18ba2d6`.

O OpenAPI continua publicando autenticação implicit/clientCredentials com URLs de desenvolvimento e sem descrever auth/login/auth/token. Isso não substitui o fluxo individual do manual. Não foram inferidos endpoints ou exigências de certificado a partir dessa divergência.
