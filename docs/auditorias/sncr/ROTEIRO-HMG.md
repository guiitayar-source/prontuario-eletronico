# Roteiro: RCE com número SNCR de treinamento (homologação), cerca de 20 minutos

Objetivo: validar o fluxo inteiro, sem validade para dispensação:
1. login gov.br;
2. pedido de um lote RCE de treinamento;
3. número vinculado à receita;
4. assinatura Bird ID;
5. PDF.

Tudo no Arch, contra o Supabase **local**. Nada de produção.

> Número gasto não volta: o SNCR fornece lotes de 1.000, até 3 pedidos por mês por inscrição e
> categoria. Faça **um** pedido só, com você presente; o login gov.br é seu.

## Conferência do contrato (30/10/2026)

- **Swagger de homologação** (`/api-sncr/v3/api-docs`): versão 1.2.1, idêntico ao snapshot
  `docs/sncr/openapi-hmg-2026-10-19.json` (mesmos caminhos e esquemas). SHA-256 do arquivo baixado:
  `33d8047b…4cd6`.
- **Página operacional da Anvisa**:
  - em 15/10, anunciou "em desenvolvimento" mais de um medicamento por receita e numeração de
    **14 para 16 dígitos**, com atualização prevista para 19/10, às 18h;
  - não confirma que a mudança entrou, e o Swagger não traz o formato do número;
  - outros avisos: falhas pontuais (09, 22 e 23/10), números vinculados ao prescritor errado
    (09/10, já corrigido) e esgotamento de faixa em algumas UFs (09/10).
- **Decisão**: não mudar o código com base em suposição.
  - O PsyWrite aceita hoje só o formato publicado de 14 dígitos (`NNNN.N-NN.NNNNNNN`).
  - A resposta bruta da Anvisa é gravada **antes** da conferência.
  - Se o número vier em outro formato (16 dígitos, por exemplo), a solicitação vai para
    "Retorno preservado para conferência" (`CONTRACT_REVIEW`) e **nenhum número é usado**. Com essa
    amostra real, ajusto o código com teste.
  - Mais de um medicamento por receita é opcional; o modelo continua com um por receita.

## O que já está pronto

- **Banco local** com todas as migrações: as SNCR da main, a prorrogação (`sncr_transition_end()`
  = 04/03/2027), as de assinatura e a de RET. O histórico local já foi alinhado aos nomes novos.
- **`.env.local`** (não versionado), com o backup anterior guardado no scratchpad desta sessão:
  - `SNCR_ENVIRONMENT=hmg`
  - `SNCR_RETURN_URL=http://localhost:3000/sncr`
  - `SNCR_PLATFORM_CNPJ=29861319000193`: mantenedora provisória, sua empresa médica
  - `SNCR_PLATFORM_NAME=PsyWrite`
- **`/tmp/psywrite-local.env`** com as chaves do Supabase local. O app subiu e respondeu em `/` e
  em `/sncr` apontando para o banco local.

## Passo a passo

**1. Subir o app** (em `localhost`, o mesmo host do callback do Bird ID e do retorno do SNCR):

```bash
cd ~/Projetos/prontuario-eletronico
git switch work/checkpoint-lote-1-2026-10-27 && git pull
npx supabase start
set -a; . /tmp/psywrite-local.env; set +a
export OPENAI_API_KEY=
test "$NEXT_PUBLIC_SUPABASE_URL" = "http://127.0.0.1:54321" && npm run dev
```

Se `/tmp/psywrite-local.env` tiver sumido (reinício), recrie-o com o passo 1 de
`docs/auditorias/6f2d/ROTEIRO-BIRDID.md`.

**2. Conta local**, em outro terminal:

```bash
cd ~/Projetos/prontuario-eletronico
node --env-file=/tmp/psywrite-local.env scripts/provision-clinic.mjs <seu-email> "Clínica teste local" http://localhost:3000
```

Abra o convite no Mailpit (http://127.0.0.1:54324), crie a senha e ative o MFA em
http://localhost:3000.

**3. Cadastros (dados fictícios):**
- **Ajustes, dados profissionais**: CPF do seu certificado, CRM, endereço completo e telefone do
  consultório.
- **Paciente "Paciente Teste"**: CPF `111.444.777-35`, data de nascimento, sexo, logradouro,
  número, cidade, UF e CEP.
- **Conecte o Bird ID** em Ajustes, na parte de assinatura.

**4. Pedir o lote de treinamento** (uma vez só):
1. Abra http://localhost:3000/sncr.
2. Em "Tipo de receituário", escolha **Receita de Controle Especial**; informe "Seu CRM" (só
   números) e "UF do CRM".
3. Clique em **Solicitar lote de teste com gov.br**, faça o login gov.br e volte para a página.
4. Clique em **Consultar resultado**.
   - **Esperado**: "Numeração recebida em homologação e em quarentena".
   - Se aparecer **"Retorno preservado para conferência"**, o formato mudou. Não peça outro lote.
     Me avise: o retorno ficou gravado e eu ajusto o código.
   - Em qualquer outro erro, não repita. Copie a mensagem e me mande.

**5. RCE com número:**
1. Volte ao prontuário e crie uma Receita, tipo **Receita de Controle Especial**, para o
   "Paciente Teste".
2. Preencha a seção **RCE eletrônica** (medicamento, concentração, forma, quantidade, posologia,
   CRM/UF) e salve.
3. No painel **RCE eletrônica — teste**, clique em **Preparar RCE de teste para revisar**. Um
   número do lote fica reservado para esta receita.
4. Clique em **Revisar PDF de teste** e confira os campos.
5. Clique em **Abrir SNCR de treinamento para conferir este número** e confirme que ele aparece
   para você.
6. Marque **Revisei a RCE e conferi no SNCR que o número acima pertence…** e clique em
   **Assinar RCE de teste**. O Bird ID vai pedir a sua autorização.
7. Clique em **Abrir original assinado de teste** e baixe.

**6. O que conferir e me mandar** (sem dados reais):
- A mensagem do passo 4.4 e o número recebido, que é de treinamento e sem dado de paciente.
- No PDF: o número no campo próprio, a marca "HOMOLOGAÇÃO – sem validade", os seus dados e os do
  paciente fictício e a data.
- Opcional: o resultado do PDF em https://validar.iti.gov.br/.

**7. Ao terminar**: Ctrl+C no `npm run dev`.

O `.env.local` pode ficar com as linhas SNCR de homologação; elas não afetam a produção. Nunca use
`--linked`, `db push` nem `link`.

## Depois do teste

- **Formato e vínculo conferidos**: liberar a produção, ou seja, ambiente `prd`, migração que
  aceite `prd` em `sncr_rce_emissions`, PDF com número real sem marca de homologação e endereço
  oficial de consulta. Também a RET com número.
- **Retorno preservado para conferência**: ajustar o formato a partir do retorno real, com teste,
  e criar o caminho para reaproveitar o lote já recebido.
