# Lote 5A — Receita de Controle Especial eletrônica

Data: 28/10/2026. Ambiente: Fedora, Node.js 22.23.1, PostgreSQL 17 em Podman local.
Branch: `work/checkpoint-lote-1-2026-10-27`. Checkpoint inicial e final: `6c00d89`.

**Veredito: APROVADO no escopo de implementação e validação local do Lote 5A. Emissão real permanece bloqueada.** Esta aprovação não significa homologação Anvisa, qualificação do certificado de teste ou autorização para uso clínico.

## 1. Referência e preservação

Foram inspecionados o checkpoint do Lote 1, os relatórios 3B, 4 e 4B, os testes de paginação/recuperação do Lote 2 e o código efetivamente presente neste checkout. O Lote 4B continua qualificando a interpretação anterior sobre identidade; este lote não altera seu diagnóstico nem tenta resolver essa pendência por configuração.

Referência visual: [PDF oficial incluído no repositório](../../assets/sncr/rce-eletronica-anvisa-2026-06-24.pdf), de 24/06/2026, uma página de 595,5 × 842,25 pontos. SHA-256: `112946ead832ec07f9343f81b35b3571065eb51dea5526cf5c949e0259c11fde`.

O cabeçalho visível é “RECEITA DE CONTROLE ESPECIAL / ELETRÔNICA”. A identificação do paciente diz “CPF ou, se estrangeiro, PASSAPORTE”. A prescrição possui os campos “NOME DO MEDICAMENTO OU SUBSTÂNCIA”, “CONCENTRAÇÃO”, “FORMA FARMACÊUTICA”, “QUANTIDADE” e “POSOLOGIA”. O rodapé inclui plataforma, registro de assinatura/data, `validar.iti.gov.br` e `sncr.anvisa.gov.br`. O título interno de metadados do arquivo original menciona Notificação A; a referência adotada foi seu conteúdo visual de RCE, não esse metadado inconsistente.

Um manifesto SHA-256 dos 310 arquivos rastreados foi capturado antes da edição. Permaneceram idênticos ao checkpoint:

- Os 14 arquivos de `lib/signature/`, incluindo provedores Bird ID/VIDaaS, PAdES, criptografia e serviço principal.
- `lib/document-pdf.ts` e `lib/document-fields.ts`: gerador comum, modalidades e modelos antigos intactos.
- As 29 migrações existentes, incluindo os dois bloqueios iniciais de aplicação das migrações SNCR.
- O PDF oficial e os cinco relatórios/consultas anteriores em `docs/audits/`.
- A numeração, sessões, cliente e mantenedora SNCR; a única alteração de produção em `lib/sncr/signing.ts` é o encaminhamento da RCE ao gerador novo.

## 2. Implementação

| Arquivo | Resultado |
|---|---|
| `lib/sncr/rce-fields.ts` | Contrato explícito dos campos da RCE, via de administração e passaporte opcional. Rejeita campos obrigatórios ausentes, marcadores, controles invisíveis, duplicações e SNCR manual. |
| `lib/sncr/rce-pdf.ts` | Carrega e preenche o próprio PDF oficial, confere seu hash, mantém o desenho original e mede cada campo antes de retornar os bytes. |
| `lib/sncr/signing.ts` | Seleciona esse gerador somente para RCE na simulação. Outras modalidades seguem o gerador existente. |
| `components/documents/editor.tsx` | Explica os campos e limites no modo local e oferece inserção explícita do modelo eletrônico, conservando integralmente o texto anterior para revisão. |
| `next.config.ts` | Inclui PDF e fontes nos artefatos standalone das rotas de documentos e assinatura. |
| `tests/rce-pdf.test.mjs` e `tests/rce-build.test.mjs` | Testes novos de conteúdo, limites, geometria, assinatura, adulteração, empacotamento e bloqueios no bundle real do Next. |
| `tests/sncr-integrated-local.test.mjs` | Atualiza a fixture sintética para campos completos e acrescenta três testes de RCE incompleta/excessiva sem chamada ao provedor. Mantém as verificações anteriores. |
| Harnesses SNCR e `tests/helpers/sncr-container.mjs` | Suporte explícito a Docker/Podman e à imagem local 17.6.1.171, preservando exigência de contêiner sem rede/volumes. Pequenos ajustes de estilo para lint, sem remoção de asserções. |
| `tests/helpers/rce-fixture.mjs`, `package.json`, `.gitignore` | Dados sintéticos compartilhados, comandos de teste reproduzíveis e exclusão dos PDFs de evidência do versionamento. |

O preenchimento preserva a página única, sem criar vias de papel, caixas de comprador/fornecedor ou carimbo manual. A fonte dos valores é Liberation Sans, embutida no PDF. Os valores são colocados nos espaços entre os rótulos, com limites fixos de linhas. Medicamento, concentração, forma e quantidade têm uma linha cada; a área de posologia comporta até 12 linhas a 10 pt, contando via e orientações. Não há diminuição ilimitada da fonte, corte ou paginação improvisada do formulário.

A ilustração de QR do modelo é coberta e substituída por QR funcional que aponta somente ao validador público `https://validar.iti.gov.br`. Gerar esse QR não faz requisição de rede. Ele não verifica individualmente a receita nem prova validade do certificado de teste. O rodapé informa “Simulação: verificação clínica indisponível”. O cabeçalho traz “SIMULACAO LOCAL - SEM VALIDADE CLINICA”.

## 3. Conteúdo completo e revisão

A implementação aceita um conjunto explícito de campos de medicamento por documento. É uma restrição conservadora deste lote; não constitui uma afirmação de que toda RCE, em qualquer modalidade de emissão, esteja legalmente limitada a um medicamento.

O texto livre antigo não é convertido por inferência. O prescritor precisa revisar e preencher os rótulos. A ação nova de inserção conserva o texto anterior no editor; os marcadores devem ser substituídos e as instruções conferidas. Linhas e orientações pertencentes a um campo são mantidas, inclusive quebras e palavras extensas. Nada é retirado silenciosamente para fazer o PDF caber.

O gerador exige nome e inscrição do prescritor, endereço e telefone profissional, nome do paciente, CPF válido nos dígitos verificadores **ou** passaporte explícito, endereço/cidade/UF do paciente, data efetiva e todos os campos clínicos. CPF e passaporte simultâneos são rejeitados como ambíguos. A validação matemática do CPF não comprova identidade civil. Não se deduz endereço completo ou adequação clínica apenas da presença de uma string.

Para estrangeiro sem CPF cadastrado, o passaporte é salvo no próprio texto clínico, sob `Passaporte do paciente (se estrangeiro):`; não foi criada migração ou alteração do cadastro geral do paciente. A data congelada é obrigatória no PDF. A reserva existente continua definindo uma data antes do congelamento caso o documento salvo não a tenha.

Conteúdo que não caiba, caractere sem glifo, campo ausente, placeholder ou identificação ambígua impedem a geração completa e, portanto, impedem a chamada ao provedor. Se o problema for detectado após reserva, a tentativa segue a quarentena existente: estado incerto, número preservado/consumido e nenhuma assinatura criada. Corrigir exige novo rascunho; não se edita a versão congelada nem se devolve o número ao estoque. Dados cadastrais auxiliares são lidos na geração, como no fluxo anterior; não foi criado snapshot transacional desses cadastros nem fluxo novo de confirmação de prévia neste lote.

## 4. Numeração, PAdES e bloqueios

O fluxo preservado é: reserva transacional → versão congelada → início exclusivo da tentativa → PDF completo com número da reserva → preparação PAdES existente → provedor local simulado → verificação criptográfica → metadados/arquivo → conclusão transacional.

Chave estável, concorrência, idempotência, falhas, consumo de estoque, isolamento por clínica/médico e recuperação continuam no banco. Falha de upload/conclusão não provoca nova assinatura. Artefato ausente ou adulterado não é regenerado. Documento já assinado continua sendo servido exclusivamente pelos bytes originais, inclusive se tiver sido emitido com um layout anterior.

O simulador continua exigindo ambiente local, modo explícito, backend Supabase local, sandbox administrativo, origem `synthetic`, ambiente `hmg` e prefixo `SIMULADO.`. Metadados continuam com `provider=local_simulation` e `verification_status=UNVERIFIED`. O gerador isolado produz apenas PDFs com aviso de simulação; seu prefixo textual não substitui a autorização/reserva exigida pelo serviço de assinatura.

Não foi habilitada assinatura real de RCE com Bird ID, alterada a autenticação gov.br, promovida identidade `unverified`, admitida origem sintética como oficial ou reativada a alocação legada. O serviço real de Bird ID/PAdES e os modelos das receitas simples, retenção e notificações permanecem preservados.

## 5. Verificações

| Grupo | Aprovados | Falhas |
|---|---:|---:|
| RCE: conteúdo, campos, CPF/passaporte, desenho, limites, geometria e PAdES | 39 | 0 |
| Bundle Next de produção e assets standalone | 5 | 0 |
| Integração PostgreSQL/assinatura local | 30 | 0 |
| Numeração PostgreSQL 3A | 23 | 0 |
| Sessões SNCR Lote 4 | 36 | 0 |
| Criptografia, cadeia e CLI | 25 | 0 |
| Paginação PDF comum | 5 | 0 |
| Recuperação de documento assinado | 10 | 0 |
| Provedores simulados | 6 | 0 |
| Salvamento antes de assinatura | 12 | 0 |
| Nova receita | 4 | 0 |
| Segurança SNCR | 4 | 0 |
| Mantenedora | 8 | 0 |
| Parsing/contrato SNCR | 6 | 0 |
| **Total contabilizado pelos runners** | **213** | **0** |

Também passou `tests/prescription-pdf.test.mjs`, script de asserções sem contagem própria de casos. `npm run build`, TypeScript sem cache incremental, lint de todos os arquivos de código/teste tocados e `git diff --check` passaram. As duas falhas históricas do CLI não se reproduziram no Fedora/Node 22 desta execução; não foram removidos testes ou alterado o verificador para fazê-las passar.

Os testes novos confirmam que os streams de desenho originais permanecem no PDF, dimensões e página única coincidem, todos os valores esperados são extraíveis e os bounding boxes dos valores não colidem entre si, com os rótulos originais ou com a borda inferior da prescrição. PAdES íntegro passa e adulteração falha. A integração confere contador de chamadas ao provedor, inexistência de registro de assinatura para documentos incompletos, preservação do texto/versão/número e impossibilidade de nova assinatura após falha.

O bundle real de produção foi importado diretamente, com todo HTTP interceptado: exige login, preserva impressão de papel, bloqueia RCE antes de sessão de certificado/RPC SNCR e entrega a RCE assinada original sem enriquecimento/regeneração. Ambos os manifests de tracing e os arquivos copiados ao standalone contêm o PDF e as fontes corretos. O caminho eletrônico não é liberado dentro do build de produção para facilitar testes.

### Comparação visual

O original e os três PDFs finais foram renderizados com Poppler e inspecionados visualmente. A primeira iteração apresentou colisões entre valores/rótulos e foi corrigida. A versão final, incluindo posologia no limite de 12 linhas e nome em duas linhas, apresenta texto legível, campos alinhados e ausência de sobreposição/corte. O PDF assinado também foi renderizado após inclusão do CMS, sem carimbo adicional sobre o formulário.

Evidências locais, ignoradas pelo Git:

- [RCE curta](../../output/pdf/lote5a/rce-curta-simulada.pdf), [RCE extensa](../../output/pdf/lote5a/rce-extensa-simulada.pdf) e [RCE assinada com certificado de teste](../../output/pdf/lote5a/rce-assinada-simulada.pdf).
- [Imagem do original](../../output/pdf/lote5a/referencia-oficial.png), [curta](../../output/pdf/lote5a/rce-curta-simulada.png), [extensa](../../output/pdf/lote5a/rce-extensa-simulada.png) e [assinada](../../output/pdf/lote5a/rce-assinada-simulada.png).
- Logs e resumo: `output/pdf/lote5a/logs/` e `output/pdf/lote5a/test-summary.json`.

## 6. Reprodução e limites

```sh
npm run test:rce
npm run test:rce:build

# Imagem já instalada; sem pull, rede, portas ou volumes.
podman run -d --rm --pull=never --network none --name psywrite-sncr-3a-disposable -e POSTGRES_PASSWORD=synthetic-test-only public.ecr.aws/supabase/postgres:17.6.1.171
podman exec psywrite-sncr-3a-disposable pg_isready -U supabase_admin
export SNCR_TEST_CONTAINER_ENGINE=podman
export SNCR_TEST_CONTAINER_IMAGE=public.ecr.aws/supabase/postgres:17.6.1.171
# Executar em sequência: algumas suítes reiniciam o contêiner.
node --experimental-strip-types tests/sncr-postgres-local.test.mjs
node --experimental-strip-types tests/sncr-integrated-local.test.mjs
node --experimental-strip-types tests/sncr-auth-local.test.mjs
podman stop --time 10 psywrite-sncr-3a-disposable
```

Os bancos usados são reais, exclusivos e descartáveis. Os harnesses aplicam cópias temporárias das migrações somente nesses bancos, removendo o bloqueio da string de teste; os arquivos originais não são desbloqueados. Não há Supabase remoto ou cópia de dados reais. HTTP oficial, provedores e Storage são simulados/interceptados; as relações clínicas são mínimas, sem ensaio de um Supabase completo ou do editor em navegador. O contêiner foi encerrado após a execução.

Permanecem externos ao lote: ensaio autorizado de autenticação/numeração Anvisa, evidência transacional de identidade, configuração/aceitação da mantenedora, assinatura real com certificado ICP-Brasil e validação externa no ITI. Os resultados locais não demonstram essas etapas. Não foi escolhido, cadastrado ou enviado CNPJ algum.

## 7. Estado final

Implementação local concluída e revisável, sem staging ou commit. Nenhum push, deploy, migração remota ou chamada real à Anvisa foi realizado. Não foram alterados credenciais, cadastros ou documentos reais. Os bloqueios de emissão continuam ativos.

**APROVADO para o Lote 5A local. Emissão real e homologação externa continuam PENDENTES e bloqueadas.**
