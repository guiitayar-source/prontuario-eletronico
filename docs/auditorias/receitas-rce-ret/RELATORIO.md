# RCE e RET com fluxos próprios (30/10/2026)

Branch `work/checkpoint-lote-1-2026-10-27`. Sem deploy e sem migração remota. A data da transição
(04/03/2027 como primeiro dia bloqueado) entrou na main pelo PR #12, já em produção; esta branch
adota esse padrão (`sncrTransitionEnd` e `public.sncr_transition_end()`).

## Regra por categoria

| Categoria | Assinatura exigida | Até 03/03/2027 | Modelo assinado |
|---|---|---|---|
| Receita simples | qualquer assinatura eletrônica do fluxo | sempre liberada | receituário de uma via |
| RCE | qualificada ICP-Brasil (RDC 1.000/2025, art. 8º) | liberada sem número SNCR | **modelo eletrônico oficial da Anvisa** (`lib/sncr/rce-transition.ts` e `rce-pdf.ts`) |
| RET | avançada ou qualificada (art. 11) | liberada sem número SNCR | receituário sujeito à retenção em duas vias, com idade e sexo (RDC 471/2021) |
| NRA, NRB, NRB2, NRR, NRT | qualificada | bloqueadas até a integração SNCR | — |

A assinatura em uso (Bird ID e VIDaaS) é qualificada ICP-Brasil, o que atende RCE e RET.

## O que mudou

- **Política** (`lib/sncr/policy.ts`): a RET deixa de ser bloqueada por falta de modelo e segue a
  mesma transição da RCE. Novo `prescriptionSignatureRequirement` (RCE qualificada; RET avançada
  ou qualificada).
- **RCE eletrônica.** O PDF assinado passa a ser o modelo oficial (`rcePdf(..., 'transition')`):
  - sem número SNCR (o campo traz "Sem numeração SNCR (período de transição)");
  - sem marca de homologação;
  - QR e texto de consulta apontam para validar.iti.gov.br (art. 13, I);
  - nome e CPF do paciente, ou passaporte se estrangeiro (Portaria 344, art. 55);
  - endereço completo do paciente;
  - prescritor com CPF do certificado, CRM/UF, endereço e telefone;
  - um medicamento por receita.

  O desenho de duas vias fica só para impressão e assinatura manual, e ganhou o CPF do paciente.
  Os campos do modelo são editados no editor ("RCE eletrônica"). O painel de teste SNCR não os
  repete.
- **RET.** PDF próprio, em duas vias, com título "Receituário sujeito à retenção", idade (a partir
  de `dob`, na data de emissão) e sexo (campo "Gênero" do cadastro).
- **Emissão bloqueada sem campo obrigatório**, sempre antes do HSM:
  - RCE: campos do modelo, CPF ou passaporte, endereço do paciente, endereço e telefone do
    consultório, CPF do prescritor;
  - RET: data de nascimento, sexo, endereço e telefone do consultório.
- **Data de emissão = data da assinatura** (art. 12). Na aquisição da tentativa, o banco fixa a
  data das receitas no dia corrente de Brasília, antes do instantâneo que congela o documento
  (`20261030040300_document_signing_attempts`). Documentos que não são receita conservam a data
  escolhida.
- **Banco.**
  - A `20261030040300` aceita RET no caminho comum.
  - A nova `20261030120000_prescription_ret_signing` (em revisão, travada) redefine
    `sncr_document_guard`, liberando RCE e RET até `sncr_transition_end()`. Ela difere da versão
    da main só na condição de categoria.
  - As notificações continuam recusadas.
- **Migrações da branch** renomeadas para `20261030040000`–`040400`, depois da `030624`, já
  aplicada.

## Testes

- `prescription-rce-ret` (novo, 10 casos), sem banco:
  - assinatura exigida por categoria e idade na data de emissão;
  - RET em duas vias, bloqueada sem idade, sexo ou dados do emitente;
  - RCE no modelo oficial: título, uma página, texto "sem numeração", CPF, ITI, medicamento e data
    da assinatura presentes, sem marca de homologação;
  - passaporte só sem CPF;
  - bloqueios por campo ausente;
  - modelo de transição nunca recebe número, e o de homologação exige número;
  - impressão em duas vias;
  - notificações sem PDF.
- `signature-persistence-local` (Postgres real, 50), pelo serviço real de assinatura:
  - RCE assinada no modelo oficial e RET em duas vias, com data de emissão igual à do dia;
  - RET sem nascimento barrada antes do HSM;
  - notificações recusadas;
  - `sncr_transition_end()` = 04/03/2027;
  - não-receita conserva a data.
- Ajustados: `sncr.test` e `prescription-pdf.test` da main, que afirmavam a RET bloqueada;
  `simple-prescription`; e a fixture de `document-signing-identity` (receita simples explícita).
- Todas as suítes 6F, de assinatura e SNCR verdes; `npm test` 111/111.
- tsc, lint, build e `git diff --check` limpos.
- Sequência de migrações testada a partir do estado de produção.

## Pendências e riscos

- **Validador do ITI**: ver `ROTEIRO-ITI.md`. O PAdES é B-B, sem política de assinatura ICP-Brasil
  e sem carimbo do tempo. Falta confirmar como o validador classifica os PDFs.
- **Sexo vem do campo "Gênero (como informado)"**, texto livre. Avaliar um campo próprio de sexo
  no cadastro.
- **RCE com duas fontes**: o texto livre (impressão) e os campos do modelo (eletrônica) podem
  divergir. Avaliar derivar o texto dos campos (`rceClinicalText`).
- **Virada da meia-noite**: se a assinatura no HSM cruzar a meia-noite depois da aquisição, a data
  impressa é a da aquisição.
- **Assinatura avançada (gov.br)** para RET não está implementada; hoje só a qualificada.
- **Promoção**: a `20261030120000` e as cinco de assinatura vão para produção junto com o deploy
  do código da branch, com o aval do Guilherme.
