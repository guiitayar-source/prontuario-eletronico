# Lote 5B — concorrência e dívida de lint

O teste anterior de inserção de faixas sobrepostas registrou `40P01` na verificação da restrição de exclusão GiST. O relatório do PostgreSQL mostrou duas transações aguardando reciprocamente `ShareLock` sobre o identificador de transação da outra. A falha ocorreu na admissão de lotes, não na RPC de reserva. O processo `psql` executava com `ON_ERROR_STOP`; ao terminar a conexão, a transação abortada foi revertida. A sequência dos identificadores de histórico pode apresentar lacunas, pois sequências PostgreSQL não são transacionais; isso não representa consumo de numeração de receita.

A admissão agora obtém, antes da inserção, um bloqueio consultivo transacional para a combinação de ambiente, prefixo e largura do sufixo. A restrição `EXCLUDE` permanece ativa, inclusive para snapshots `REPEATABLE READ`. Em transações futuras que insiram vários domínios de lote, os chamadores deverão adquiri-los em ordem determinística; a alteração não elimina todo deadlock possível no banco. Não há retry automático nem chamada externa. Falhas transacionais continuam exigindo reconciliação, preservando a chave de idempotência.

No PostgreSQL descartável, o teste `tests/sncr-concurrency-local.test.mjs` executou 20 rodadas para cada combinação: faixas sobrepostas e último número, com duas e dez conexões independentes. Em cada rodada foram verificados resultado único, rollback dos perdedores, estoque, vínculos, estado, histórico e auditoria; a reserva vencedora foi repetida com a mesma chave e sem consumo adicional. As quatro combinações passaram. A suíte transacional existente passou 23/23 e a regressão integrada final 32/32. A migração original continua deliberadamente bloqueada; apenas uma cópia foi aplicada ao banco descartável.

## Dívida de lint anterior ao Lote 5B

O `oxlint` foi executado com as mesmas dependências e configuração sobre uma cópia do commit anterior `2c039e8` e sobre o estado atual. As saídas ordenadas foram idênticas, com 12 erros em arquivos não modificados:

- `lib/sncr/maintainer.ts`: expressão regular com caracteres de controle (1).
- `components/documents/use-documents.ts`: importação não usada e duas regras de dependências de hooks (3).
- `tests/signed-document-retrieval.test.mjs`: expressão não usada e método sem vínculo (2).
- `tests/sncr-maintainer.test.mjs`: expressão não usada (1).
- `tests/sncr-safety.test.mjs` e `tests/sncr.test.mjs`: chamadas deliberadas a APIs marcadas como obsoletas (5).

O lint direcionado aos arquivos de código e testes do Lote 5B passou. TypeScript, build local e `git diff --check` passaram. Os testes e as amostras são locais e sintéticos: a emissão real continua bloqueada e a homologação Anvisa, a numeração real e a assinatura real permanecem não validadas.
