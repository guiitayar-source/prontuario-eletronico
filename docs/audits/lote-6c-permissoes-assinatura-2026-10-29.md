# Lote 6C — permissões e registros de confiança de assinaturas

**APROVADO localmente**, com base no commit `837008cfd5f2f07a0866444bef67fa3a2f335003`. A migração permanece bloqueada para aplicação: os testes aplicaram apenas uma cópia em PostgreSQL descartável. O Supabase hospedado não foi alterado nem validado.

## Alterações

- `supabase/migrations/20261029010000_signature_trust_permissions.sql`: RLS, privilégios e conferência dos vínculos de novas assinaturas.
- `tests/signature-trust-permissions.test.mjs` e `tests/signature-trust-flow.test.mjs`: testes negativos e fluxos positivos.
- `tests/helpers/signature-trust-db.mjs` e `tests/helpers/signature-trust-rest.mjs`: infraestrutura de teste isolada para PostgreSQL e PostgREST.
- Este relatório. Nenhuma migração histórica foi modificada.

## Permissões e fluxos

Antes, a política `FOR ALL` permitia ao usuário autenticado ler e escrever a própria sessão e o próprio estado OAuth, inclusive ciphertext e metadados de identidade. Uma política também permitia inserir metadados de assinatura com `verification_status = VALID`. A reprodução local confirmou essas possibilidades; operações de atualização sem política permissiva também podiam retornar zero linhas, em vez de erro explícito.

Agora, `anon` e `authenticated` não recebem escrita nas quatro tabelas `signature_sessions`, `signature_oauth_states`, `digital_signatures` e `evolution_signatures`. Políticas restritivas adicionais negam escrita mesmo se um privilégio de tabela for reintroduzido. Privilégios antigos de coluna também são revogados.

O médico pode consultar apenas os campos seguros da própria sessão, sujeitos à associação e ao papel na clínica; ciphertext e certificado bruto não são concedidos. Estados OAuth ficam acessíveis somente ao servidor. A leitura de metadados de assinatura permanece sujeita à autorização clínica e ao vínculo com documento da mesma clínica. Os registros de evolução permanecem acessíveis para leitura conforme a política existente.

O backend usa `service_role`: cria e lê sessões, revoga-as por atualização restrita, cria e consome estados OAuth e insere metadados de assinatura. O fluxo existente de documentos e a RPC SNCR `sncr_finish_signing` continuam responsáveis pelas gravações confiáveis. Novas assinaturas de documentos passam por gatilho `SECURITY INVOKER` que exige clínica, autor, signatários, versão e estado `SIGNING` correspondentes. Ele não é uma RPC privilegiada e não comprova confiança ICP-Brasil. Registros antigos não foram alterados.

## Evidências

Foram obtidos **261 testes distintos aprovados em pelo menos uma execução, sem falhas finais**, contando apenas uma vez os casos repetidos: 24 testes de permissões PostgreSQL, 10 testes de fluxo com PostgREST e 227 casos da regressão existente. Um script adicional de geração de receituário também passou.

Os testes negativos abrangeram inserção anônima ou autenticada de assinatura, declaração `VALID`, alteração de hash e caminho, CPF e token de sessão, estado OAuth, exclusão, acesso entre médicos e clínicas, execução indevida de RPC e forja de vínculos. Também verificaram a negação de leitura de ciphertext e a remoção de privilégios de coluna. Os testes positivos exercitaram criação e revogação de sessão, assinatura PAdES simulada, acesso clínico, receita simples, reserva SNCR de receita controlada e recuperação dos bytes originais, inclusive recusa de artefato ausente ou adulterado.

O ensaio aplicou os 30 arquivos históricos completos do projeto sobre PostgreSQL real, com interfaces mínimas de Auth e Storage, seguidos por uma cópia da migração nova. PostgREST foi real; GoTrue, provedor de assinatura e armazenamento de arquivos foram simulados localmente. Não houve chamada real à Anvisa nem assinatura externa. O bloqueio da migração original foi testado, e a cópia foi reaplicada sem alterar os registros existentes.

A primeira regressão integrada teve 258 aprovações e três falhas na suíte SNCR quando outra suíte reiniciou o mesmo PostgreSQL em paralelo. A suíte afetada foi reexecutada isoladamente: 36 aprovações, incluindo os três casos, sem falhas. As falhas históricas de CLI não reapareceram.

TypeScript sem cache incremental, lint direcionado, build local de produção e `git diff --check` passaram. Os testes não demonstram implantação remota, operação real do Storage/GoTrue ou validação de cadeia e revogação ICP-Brasil. Os bloqueios de emissão real e de numeração sintética em produção permanecem ativos. Antes de qualquer implantação, as permissões e os registros históricos devem ser revisados no ambiente de destino; a migração não corrige retroativamente registros eventualmente fabricados no passado.

## Estado do Git

Branch `work/checkpoint-lote-1-2026-10-27`, HEAD `837008cfd5f2f07a0866444bef67fa3a2f335003`. Os seis arquivos deste lote estão novos e sem staging. Não houve commit, push, deploy ou migração remota. O Lote 6D não foi iniciado.
