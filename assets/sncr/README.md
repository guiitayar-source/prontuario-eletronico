Modelo RCE eletrônico original da Anvisa, consultado em 19/10/2026:

https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/receituario-eletronico/modelos-de-receituarios-eletronicos/receita-de-controle-especial-eletronica.pdf/@@display-file/file

SHA-256: `112946ead832ec07f9343f81b35b3571065eb51dea5526cf5c949e0259c11fde`.

O arquivo original é preservado. O preenchimento de homologação acrescenta indicação inequívoca de teste, sem validade para dispensação. Não habilitar produção com esse preenchimento de teste.

## Notificações de Receita A e B eletrônicas

Modelos oficiais da Anvisa, com os mesmos campos da RCE e uma faixa colorida à esquerda (amarela
na A, azul na B). Arquivos recebidos do titular em 11/11/2026, sem alteração:

- `notificacao-receita-a-eletronica.pdf`, SHA-256 `e72ddb49831615c4b4c652ee9ca0d4f01f131a3896e43512494b16dca6b9f001`
  ([fonte](https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/receituario-eletronico/modelos-de-receituarios-eletronicos/notificacao-de-receita-a-eletronica.pdf/@@display-file/file))
- `notificacao-receita-b-eletronica.pdf`, SHA-256 `8c7db7622ef8eda963684409da4e0c70ebd7090d5834b7ed7b6f2c05d1f5c7c4`
  ([fonte](https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/receituario-eletronico/modelos-de-receituarios-eletronicos/notificacao-de-receita-b-eletronica.pdf/@@display-file/file))

Por causa da faixa, os quadros ficam deslocados e mais estreitos que os da RCE. Os deslocamentos
de cada bloco estão em `numberedTemplates` (`lib/sncr/rce-pdf.ts`) e são conferidos rótulo a
rótulo contra os arquivos em `node tests/sncr-notificacoes.test.mjs`. Um modelo novo da Anvisa
exige medir de novo e trocar o hash; com o hash divergente, a emissão para antes de reservar
número.

O QR da notificação aponta para `https://sncr.anvisa.gov.br/receita/consultar?numero={numero}`,
formato definido pela Anvisa na página "Receituário eletrônico" do SNCR.
