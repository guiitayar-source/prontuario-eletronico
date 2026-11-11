Modelo RCE eletrônico original da Anvisa, consultado em 19/10/2026:

https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/receituario-eletronico/modelos-de-receituarios-eletronicos/receita-de-controle-especial-eletronica.pdf/@@display-file/file

SHA-256: `112946ead832ec07f9343f81b35b3571065eb51dea5526cf5c949e0259c11fde`.

O arquivo original é preservado. O preenchimento de homologação acrescenta indicação inequívoca de teste, sem validade para dispensação. Não habilitar produção com esse preenchimento de teste.

## Notificações de Receita A e B eletrônicas (pendente)

Modelos oficiais da Anvisa, com os mesmos campos e o mesmo desenho da RCE:

- A: https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/receituario-eletronico/modelos-de-receituarios-eletronicos/notificacao-de-receita-a-eletronica.pdf/@@display-file/file
- B: https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/receituario-eletronico/modelos-de-receituarios-eletronicos/notificacao-de-receita-b-eletronica.pdf/@@display-file/file

Salvar sem alterar como `notificacao-receita-a-eletronica.pdf` e `notificacao-receita-b-eletronica.pdf`
nesta pasta. Depois:

1. `node tests/sncr-notificacoes.test.mjs`: o último teste confere, rótulo a rótulo, que os campos
   estão nas mesmas posições do modelo da RCE (o preenchimento usa as mesmas coordenadas).
2. Fixar o SHA-256 de cada arquivo em `numberedTemplates` (`lib/sncr/rce-pdf.ts`) e anotar aqui.

Enquanto o hash não estiver fixado, a notificação para antes de reservar número, com aviso para
usar o talonário físico.

O QR da notificação aponta para `https://sncr.anvisa.gov.br/receita/consultar?numero={numero}`,
formato definido pela Anvisa na página "Receituário eletrônico" do SNCR.
