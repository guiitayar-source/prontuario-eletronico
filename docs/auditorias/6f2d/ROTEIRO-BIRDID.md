# Roteiro: teste do 6F.2D com Bird ID real, fora da main

Objetivo: confirmar que, com um certificado Bird ID de verdade, a LCR/OCSP da cadeia é encontrada
e que a revogação chega a **GOOD**. Tudo roda no Arch, na branch
`work/checkpoint-lote-1-2026-10-27`.

## Qual caminho é seguro

- **Preview da Vercel: não usar.**
  - Na Vercel, todas as variáveis (Supabase, Bird ID, chave de cifra) existem só em
    *Production*; o Preview não tem nenhuma.
  - Para funcionar, seria preciso copiar as chaves de produção para o Preview. O preview passaria
    a escrever no banco real, que não tem as migrações em revisão (tentativas, evidências).
  - O callback registrado do Bird ID (`BIRDID_REDIRECT_URI`) também não bate com a URL de um
    preview.
- **`npm run dev` local, apontado para o Supabase LOCAL: sim.**
  - O callback registrado é `http://localhost:3000/api/digital-signature/birdid/callback`.
  - **Cuidado:** o `.env.local` do Arch aponta para PRODUÇÃO. As variáveis do Supabase local
    precisam ser exportadas no shell antes do `npm run dev`; o Next não sobrescreve variável que
    já existe no ambiente.

Há dois caminhos. Comece pelo A: não assina nada e já responde a pergunta principal.

## A. Conferir um PDF já assinado (sem banco e sem assinar)

Use um documento que você já assinou com o Bird ID: baixe o PDF pelo app. O arquivo não sai da
máquina. Só as URLs de LCR/OCSP da cadeia são consultadas, e o script não imprime nome, CPF nem
conteúdo.

```bash
cd ~/Projetos/prontuario-eletronico
git switch work/checkpoint-lote-1-2026-10-27 && git pull
node scripts/check-revocation.mjs ~/Downloads/<documento-assinado>.pdf
```

**O que esperar:**
- `Cadeia ICP-Brasil confiável: true`
- linha `SIGNER` com `GOOD` e `origem=OCSP` ou `origem=CRL`
- linha(s) `SIGNER_CA` com `GOOD`
- em `Buscas`, as URLs com `FETCHED`

**Se não vier GOOD:**
- `ERROR … host bloqueado/interno` ou `endereço não permitido`: anote a URL e me mande.
- `ERROR … tempo esgotado` ou `HTTP …`: a AC não respondeu; repita mais tarde.
- `SIGNER INDETERMINATE` com `NOT_FRESH`/`TRY_LATER`: a evidência veio, mas sem frescor. Mande a
  saída.
- Certificado vencido hoje: a validação atual não comprova. Use um documento assinado com o
  certificado vigente.

## B. Fluxo completo no app local, com gravação da evidência

Use só dados sintéticos: paciente "Paciente Teste", sem CPF real de paciente. O Bird ID vai pedir
a sua autorização normalmente; a assinatura é real, mas de um documento de teste no banco local.

**1. Supabase local no ar e variáveis locais num arquivo fora do repositório:**

```bash
cd ~/Projetos/prontuario-eletronico
npx supabase start
npx supabase status -o env | sed -n \
  -e 's/^API_URL="\{0,1\}\([^"]*\)"\{0,1\}$/NEXT_PUBLIC_SUPABASE_URL=\1/p' \
  -e 's/^PUBLISHABLE_KEY="\{0,1\}\([^"]*\)"\{0,1\}$/NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=\1/p' \
  -e 's/^SECRET_KEY="\{0,1\}\([^"]*\)"\{0,1\}$/SUPABASE_SECRET_KEY=\1/p' > /tmp/psywrite-local.env
grep -qx 'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321' /tmp/psywrite-local.env && echo LOCAL-OK
```

Só siga se aparecer `LOCAL-OK`.

**2. Aplicar as migrações pendentes SÓ no banco local.** São as SNCR e de receita simples da main
(`20261030023641` a `20261030023750`) e as de assinatura em revisão (`20261030030000` a
`20261030030400`). O comando usa uma cópia sem a trava;
os arquivos do repositório não mudam. Depois do merge com a main (30/10/2026), testei a sequência
num Postgres descartável a partir do estado de produção: aplica sem erro.

```bash
{ for f in $(ls supabase/migrations/*.sql | awk -F/ '$3 > "20261016010000_z"'); do
    perl -0pe "s/do \\\$\\\$ begin\n raise exception '[^']*não aplicar';\nend \\\$\\\$;//" "$f"; echo;
  done; } | docker exec -i supabase_db_prototipo psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q --single-transaction \
  && echo MIGRACOES-LOCAIS-OK
```

Se o banco local já tiver as da main (por `supabase migration up --local`), aplique só as de
assinatura: troque o filtro por `'$3 > "20261030024"'`.

**3. Conta e clínica locais.** O convite chega no Mailpit local, em http://127.0.0.1:54324.

```bash
node --env-file=/tmp/psywrite-local.env scripts/provision-clinic.mjs <seu-email> "Clínica teste local" http://localhost:3000
```

**4. App local com as variáveis locais por cima do `.env.local`:**

```bash
set -a; . /tmp/psywrite-local.env; set +a
export OPENAI_API_KEY=
test "$NEXT_PUBLIC_SUPABASE_URL" = "http://127.0.0.1:54321" && npm run dev
```

**5. No navegador, em http://localhost:3000** (use `localhost`, que é o host do callback, e não
`127.0.0.1`):
1. aceite o convite, crie a senha e ative o MFA;
2. em Ajustes, preencha o perfil de documentos com o seu CPF (o mesmo do certificado) e o CRM;
3. crie o paciente "Paciente Teste" e um documento simples (atestado ou declaração, não receita
   controlada);
4. conecte o Bird ID e assine.

**6. O que observar:**
- No terminal do `npm run dev`, **não** devem aparecer `[revogação] busca sem sucesso` nem
  `[revogação] evidência não gravada`.
- A evidência gravada:

  ```bash
  docker exec supabase_db_prototipo psql -U postgres -d postgres -c \
   "select l.chain, l.certificate_role, l.result, e.kind, e.source_url, e.this_update, e.next_update
      from signing_revocation_evidence l join revocation_evidence e on e.sha256 = l.evidence_sha256
     order by l.id;"
  ```

  Esperado: `SIGNER | GOOD` e `SIGNER_CA | GOOD`, com `kind` OCSP ou CRL.
- Opcional: baixe o PDF assinado e rode o caminho A nele.

**7. Limpeza (tudo local):**

```bash
# Ctrl+C no npm run dev
rm -f /tmp/psywrite-local.env
npx supabase db reset   # apaga os dados LOCAIS e volta só às migrações liberadas
```

Nunca use `--linked`, `db push` ou `link` neste roteiro.

## O que me mandar

- A saída do caminho A.
- No caminho B, também a saída da consulta do passo 6 e as linhas `[revogação]` do terminal, se
  houver.

Sem nome, CPF ou conteúdo de documento.
