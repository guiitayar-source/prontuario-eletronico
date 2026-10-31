# Checklist: levar a branch da RCE/SNCR para produção (30/10/2026)

Branch `work/checkpoint-lote-1-2026-10-27`. Nada disto foi aplicado em produção. Para revisar com o
titular antes de qualquer passo.

## Resultado do teste em homologação (30/10)

- O login gov.br de homologação funcionou com uma conta criada no gov.br de teste (staging), com
  dados fictícios. A conta real não vale lá.
- O lote RCE veio no formato de **16 dígitos**: `2610.6-35.000112001` a `…113000`.
- A RCE `…112003` foi assinada com o Bird ID.
  - Verificação local: integridade OK, cadeia ICP-Brasil confiável e revogação GOOD (LCR da
    Soluti e do ITI).
  - Validador do ITI: aprovado; "política de assinatura" vazia (ver o item 2).
- Os números `…112001` e `…112002` ficaram em `SIGNATURE_UNCERTAIN` por causa do bug do bucket, já
  corrigido em `20261030160000`. São de treinamento e ficam fora de uso.

## 1. Ordem das migrações

As migrações abaixo estão travadas com `raise exception '… não aplicar'`.

1. Rode `npx supabase migration list` e confira que produção está em `20261030030624`.
2. Em cada arquivo, remova a trava num commit próprio, só no momento do deploy, e aplique em
   ordem:

| Ordem | Migração | O que faz |
|---|---|---|
| 1 | `20261030040000_signature_identity_guard` | Identidade do assinador |
| 2 | `20261030040100_signature_trust_permissions` | Permissões de confiança |
| 3 | `20261030040200_signature_oauth_attempts` | Tentativas OAuth |
| 4 | `20261030040300_document_signing_attempts` | Tentativas de assinatura |
| 5 | `20261030040400_revocation_evidence` | Evidência de revogação |
| 6 | `20261030120000_prescription_ret_signing` | RET eletrônica |
| 7 | `20261030150000_sncr_16_digits` | Números de 16 dígitos e reaproveitamento de retorno preservado |
| 8 | `20261030160000_rce_signature_artifact` | O bucket aceita o `signature.json` da RCE |

3. Antes de aplicar:
   - rode `npx supabase db push --dry-run` e aplique só com o aval do titular;
   - teste a sequência num Postgres descartável a partir do estado de produção, como foi feito
     em 30/10 para as anteriores.
4. A 8 altera `storage.buckets`. Sem ela, **toda RCE assinada fica em conferência**: o Bird ID
   assina, mas a gravação falha.

## 2. Variáveis na Vercel (Production)

| Variável | Valor | Quando |
|---|---|---|
| `SNCR_ENVIRONMENT` | não definir (desligado) | Até o dia de ligar o item 3, com `prd`. `hmg` em produção abriria o fluxo de teste para todos. |
| `SNCR_RETURN_URL` | `https://<domínio>/sncr` | Só junto com o item 3 |
| `SNCR_PLATFORM_CNPJ` | CNPJ da mantenedora | Só junto com o item 3 |
| `SNCR_PLATFORM_NAME` | `PsyWrite` | Só junto com o item 3 |
| `PSYWRITE_REVOCATION_FETCH` | não definir (busca ligada) | `off` desliga a consulta de LCR/OCSP |
| `BIRDID_*`, `SIGNATURE_ENCRYPTION_KEY` | já existem | Trocar o `BIRDID_CLIENT_SECRET` e a `OPENAI_API_KEY`: apareceram num print em 30/10 |

Sem `SNCR_ENVIRONMENT`, o deploy leva para produção:
- a RET eletrônica;
- a RCE no modelo oficial sem número (transição até 03/03/2027);
- o novo passo a passo, que só aparece com o teste ligado;
- a consulta de revogação na assinatura.

## 3. Ambiente `prd` do SNCR (código pronto, desligado)

O código aceita `SNCR_ENVIRONMENT=prd` desde a migração `20261031010000_sncr_production_environment`.
Sem a variável, nada muda: o servidor recusa qualquer valor que não seja exatamente `hmg` ou `prd`.

O que mudou:
- A migração libera `prd` em `sncr_rce_emissions` e passa o ambiente para `sncr_rce_reserve`
  (padrão `hmg`, então o código antigo continua funcionando). A reserva só usa números do mesmo
  ambiente, e `sncr_rce_finish` confere o caminho do original com o ambiente da própria emissão.
- `sncrPreparationConfig`, `rce-service`, `rce-workflow` e `rcePdf` aceitam `prd`.
- O PDF de produção não tem a marca "HOMOLOGAÇÃO", aponta para `sncr.anvisa.gov.br` (QR e rodapé)
  e tem o título "Receita de Controle Especial".
- Uma emissão de um ambiente não abre num servidor configurado para o outro.
- Em `prd`, a página `/sncr` pede confirmação antes de solicitar o lote (gasta uma das 3
  solicitações do mês) e só aceita RCE e RET; notificações seguem bloqueadas.

Para ligar, nesta ordem:
1. Aplicar a migração `20261031010000` (só com o aval do titular; é aditiva e pode ir antes do
   deploy).
2. Confirmar com `sncr.integracao@anvisa.gov.br`:
   - o endereço de consulta que vai no QR (hoje `https://sncr.anvisa.gov.br/`, o do rodapé do
     modelo oficial; o guia v1.0 só cita o de treinamento);
   - se a mantenedora precisa de habilitação própria.
3. Na Vercel (Production): `SNCR_ENVIRONMENT=prd`, `SNCR_RETURN_URL=https://www.psywrite.com.br/sncr`,
   `SNCR_PLATFORM_CNPJ`, `SNCR_PLATFORM_NAME`. Redeploy.
4. Com o titular presente, em `/sncr`, pedir o primeiro lote real com o gov.br de verdade.
   Número gasto não volta.
5. A conferência do vínculo do número com o CRM continua manual (a caixa do passo 4). A API não
   devolve o prescritor do lote.

Para voltar atrás: remover `SNCR_ENVIRONMENT` e redeploy. Os números e as emissões ficam no banco.

## 4. Política de assinatura AD-RB (proposta)

**Fonte oficial**: a LPA PAdES do ITI, `http://politicas.icpbrasil.gov.br/LPA_PAdES.der`, baixada
em 30/10/2026 (SHA-256 do arquivo `ffb2404d…583317`). A versão vigente mais nova da AD-RB PAdES é:

- OID `2.16.76.1.7.1.11.1.3`
- política `http://politicas.icpbrasil.gov.br/PA_PAdES_AD_RB_v1_3.der`
- SHA-256 da política `23DA544AEF71F7A75DC85FA6E17A83875741E4BAEF41EC178258A5C86ACE54DD`
- validade de 23/07/2025 a 22/10/2037

Por que não entrou agora:
- O PsyWrite pede ao Bird ID `signature_format: CMS`, e é o Bird ID quem monta os atributos
  assinados. Não há parâmetro documentado para incluir `SignaturePolicyIdentifier`.
- A API aceita `signature_format: RAW` (PKCS#1 sobre um hash). Com ele, o servidor montaria o CMS:
  - `contentType`, `messageDigest`, `signingCertificateV2` e `signaturePolicyIdentifier` com o
    OID e o hash acima;
  - o Bird ID assinaria o hash dos atributos;
  - o servidor embutiria o resultado.

Isso muda a assinatura de **todos** os documentos, não só da RCE. Proposta:
1. Ler a `PA_PAdES_AD_RB_v1_3.der` e listar os atributos obrigatórios.
2. Implementar a montagem do CMS com testes, comparando com o validador do ITI em documentos
   sintéticos assinados pelo provedor de teste.
3. Fazer uma assinatura real de teste no Bird ID e validar no ITI.
4. Só então trocar o fluxo de produção.

O validador do ITI já aprova as assinaturas atuais; a política é um ganho de conformidade, não um
bloqueio.

## 5. Teste depois do deploy

1. Atestado simples assinado com Bird ID:
   - abre;
   - validar.iti.gov.br aprova;
   - o log não mostra `[revogação] busca sem sucesso`.
2. Receita de controle especial sem número (transição):
   - PDF no modelo oficial, com a data da assinatura;
   - ITI aprova.
3. RET: duas vias, idade e sexo do paciente; ITI aprova.
4. Receita simples: sem bloqueio.
5. Uma assinatura que falhe antes do Bird ID (por exemplo, sem posologia) mostra o motivo na tela.
6. Em caso de erro, os registros ficam no log da Vercel. O motivo de assinatura incerta aparece
   como `[rce] assinatura incerta: …`.
