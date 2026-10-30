# Lote 6F.2D — evidência de revogação (LCR/OCSP) obtida na rede (A1)

Branch `work/checkpoint-lote-1-2026-10-27`. Segue o desenho da Fase 3 de
`docs/auditorias/6f2c/CORRECAO-6F2C-R.md`.

Commits:
- `707de44`: módulo de busca;
- `574394b`: ligação na verificação e na emissão, com testes;
- `ba66c84`: hosts abertos e lista de bloqueio;
- `359b729`: migração de evidências;
- `922b1c2`: gravação e reverificação sem rede.

> **Antes de ir para a main:** a migração `20261029040000_revocation_evidence.sql` (em revisão,
> com trava) depende de `20261029030000_document_signing_attempts.sql`, também em revisão. As duas
> precisam ser aplicadas em produção **com o aval do Guilherme** antes do merge. Até lá, o código
> degrada: sem a tabela, nada é gravado e a recuperação segue sem evidência, sem interromper a
> assinatura.

Decisões do Guilherme (29/10/2026):
- aceitar qualquer host que conste no CDP/AIA de uma cadeia ICP-Brasil validada;
- guardar a evidência no banco;
- DSS/LTV fica para um lote próprio.

## 1. O que foi feito

**`lib/signature/revocation-fetch.ts`** — só busca bytes; quem decide é o
`revocation-validator`. Toda LCR/OCSP baixada entra como evidência injetada (`crls`,
`ocspResponses`) e passa pela mesma validação de assinatura, emissor e frescor.

- **Origem dos endereços.** CDP (LCR) e AIA/OCSP de cada certificado da cadeia, com a âncora de
  fora. A coleta só roda depois de a cadeia ser validada até uma âncora (`chainTrustedForRevocation`
  no signatário, `validAndTrusted` na TSA). Além disso, o provedor recusa cadeia cuja âncora não
  seja, byte a byte, uma raiz de `icp-brasil-certs.ts`. URL vinda do PDF, do DSS ou do cliente
  nunca é usada.
- **Política de URL.**
  - Vale qualquer host que conste no CDP/AIA da cadeia validada; a lista fixa de 16 domínios foi
    retirada em `ba66c84`.
  - Só `http`/`https`, nas portas 80/443, sem usuário ou senha e sem IP literal (inclusive nas
    formas decimal e hexadecimal).
  - Nomes internos são recusados: sem ponto, `localhost`, `.local`, `.internal`, `.intranet`,
    `.lan` e `home.arpa`.
  - Lista de bloqueio opcional em `PSYWRITE_REVOCATION_BLOCKED_HOSTS` (separada por vírgula;
    cada item vale para o domínio e seus subdomínios).
  - Um teste confere que todo CDP/AIA dos certificados ICP-Brasil oficiais passa pela política.
- **DNS e IP.** O transporte resolve o nome e exige que todos os endereços sejam públicos. Ficam
  bloqueados, entre outros:
  - privados (10/8, 172.16/12, 192.168/16) e loopback;
  - link-local (169.254/16, que inclui 169.254.169.254) e CGNAT (100.64/10);
  - faixas de documentação, multicast e reservadas;
  - IPv6 ULA (fc00::/7, que inclui fd00:ec2::254), fe80::/10, ::1, ::, 64:ff9b::/96 e 2002::/16;
  - IPv4 mapeado em IPv6, conferido contra as regras IPv4.

  A conexão vai ao IP conferido, sem nova resolução, o que evita DNS rebinding.
- **Redirecionamento** manual, no máximo 2. Cada destino passa de novo pela política inteira.
- **Limites.** LCR até 10 MB e OCSP até 64 KB, conferidos pelo `Content-Length` e durante a
  leitura do corpo. Cada requisição tem 4 s, e a coleta da cadeia inteira tem 12 s. Sem agente
  compartilhado, cookies ou credenciais; o `Content-Type` não é usado para nada.
- **Ordem.** Primeiro OCSP do AIA (POST `application/ocsp-request`, CertID SHA-1), até 3 URLs. Se
  não houver resposta `successful`, a LCR do CDP, também até 3 URLs. Os certificados da cadeia
  são consultados em paralelo, e uma LCR compartilhada é baixada uma vez por coleta.
- **Cache em memória** (por processo, 256 entradas). Guarda só os bytes e o instante de expiração:
  - `min(nextUpdate, agora + 6 h)`;
  - OCSP sem nextUpdate: 5 min;
  - resposta ilegível ou OCSP sem sucesso não entra no cache.
- **Falhas.** Rede caída, HTTP ≠ 200, corpo ilegível e prazo esgotado só deixam a evidência
  faltando, e o resultado fica `INDETERMINATE` (REVOCATION_UNAVAILABLE ou TRY_LATER). A coleta
  nunca lança exceção: se o provedor falhar, `withOnlineRevocationEvidence` devolve as opções
  originais.

**Ligação** (`types.ts`, `pades-service.ts`, `rfc3161-timestamp.ts`):
- Duas opções novas em `PadesVerificationOptions`:
  - `revocationEvidenceProvider`;
  - `onRevocationFetch`, que registra URL, resultado e motivo, sem dados do documento.
- A coleta acontece em dois pontos: antes de `evaluateDocumentRevocation` (cadeia do signatário)
  e antes de `evaluateTsaChainRevocation` (cadeia da TSA).
- Sem provedor, o comportamento é exatamente o anterior.

**Consumidores** (`document-signing-attempts.ts` na emissão e `document-signing-service.ts` no
`test-sign`, ambos com `LIVE_ISSUANCE`):
- Usam `liveIssuanceRevocationOptions()`: o provedor do servidor, mais um `console.warn` com URL
  e motivo das buscas que falharam.
- Revogação comprovada faz `issuanceAllowed=false`, e a emissão é bloqueada, como já era.
- Sem evidência, a emissão segue.
- `PSYWRITE_REVOCATION_FETCH=off` desliga a busca.
- A recuperação e a entrega de artefato já assinado continuam sem busca na rede, de propósito:
  ver o risco de recuperação no relatório do 6F.2C-R.

**Evidência no banco** (`supabase/migrations/20261029040000_revocation_evidence.sql` e
`lib/signature/revocation-evidence-store.ts`):
- `revocation_evidence`: uma linha por evidência, identificada pelo SHA-256 do DER, com tipo,
  tamanho, emissor, datas e URL de origem. Não tem `clinic_id`: é dado público de AC,
  compartilhado entre clínicas, sem paciente.
- **Bytes só quando são prova** (decisão do Guilherme, 30/10/2026):
  - o arquivo inteiro é guardado para respostas OCSP (poucos KB) e para a LCR que mostrou
    revogação ou suspensão (REVOKED_* ou CERTIFICATE_HOLD), o motivo de um bloqueio;
  - a LCR que só confirmou "não revogado" fica com SHA-256, tamanho, emissor, datas, URL e o
    resultado por certificado, sem o arquivo;
  - motivo: uma LCR posterior prova o mesmo, a revogação é permanente e tem data, e a da AC
    Soluti Múltipla tem ~0,9 MB e muda a cada 6 h (até ~1,3 GB por ano se guardada inteira);
  - se uma LCR guardada só como metadados aparecer depois como prova de bloqueio, os bytes são
    acrescentados à mesma linha;
  - a regra vale no código (`keepsBytes`) e no banco: a função recusa OCSP ou prova de bloqueio
    sem bytes.
- **Migração ajustada no próprio arquivo.** A `20261029040000` está em revisão, travada, e nunca
  foi aplicada fora do Postgres descartável dos testes: a trava faz qualquer aplicação falhar e
  ser desfeita, e o arquivo foi criado nesta sessão, sem `db push`. A conferência por
  `supabase migration list` no remoto foi bloqueada pela política de permissões do ambiente e não
  foi contornada.
- `signing_revocation_evidence`: vínculo entre clínica, tentativa e evidência. Guarda a cadeia
  (signatário ou TSA), o papel do certificado, o serial, a impressão digital e o resultado que a
  verificação deu.
- **Escrita:** só por `signing_revocation_evidence_write`, `security definer` e executável apenas
  por `service_role`. A função:
  - exige médico ou titular da clínica e uma tentativa dele mesmo, com artefato
    (EXTERNAL_STARTED ou posterior);
  - recalcula o SHA-256 e o tamanho quando recebe os bytes;
  - limita cada evidência a 4 MB e a chamada a 8 MB e 32 itens;
  - não tem UPDATE nem DELETE concedidos.
- **Leitura:** RLS com `has_clinic_role(owner, doctor)`. A evidência só é visível a quem enxerga
  um vínculo dela na própria clínica; secretária, outra clínica e anônimo não leem nada.
- **bytea, não Storage.** Com bytes só para OCSP e provas de bloqueio, o volume fica em poucos KB
  por assinatura. Mantê-los na mesma transação do vínculo evita objeto órfão e segunda credencial.
- **Emissão:** grava a evidência usada logo depois da verificação, inclusive quando a emissão é
  bloqueada por revogação, como prova do motivo. Falha ao gravar só gera log.
- **Recuperação e entrega** (`readArtifact` e `recover` em `document-signing-attempts.ts`):
  reverificam com a evidência guardada que tem bytes (OCSP e prova de bloqueio), sem rede.
  - Sem bytes, o resultado fica INDETERMINATE, sem erro. A LCR estaria vencida em até 6 h de
    qualquer forma.
  - Na leitura, os bytes cujo SHA-256 não confere são descartados.
- **Degradação:** se a tabela ou a função não existir, ou se o banco falhar, gravar devolve
  `unavailable` e ler devolve listas vazias. Não lança exceção.
- **Testes de banco:** a migração vai para o helper `tests/helpers/signature-trust-db.mjs` com a
  opção `revocationEvidence`, aplicada depois da de tentativas; o original continua bloqueado.

**Fora deste lote:**
- Não alterei os bytes assinados, o texto canônico (`canonical-evolution.ts`) nem o formato do
  PDF.
- DSS/LTV fica para um lote próprio.

**Teste com Bird ID real:** roteiro em `docs/auditorias/6f2d/ROTEIRO-BIRDID.md`, com o script
`scripts/check-revocation.mjs`, que confere um PDF já assinado sem banco e sem assinar.
- O caminho seguro é `npm run dev` contra o Supabase local.
- O Preview da Vercel não tem nenhuma variável (todas são só de Production), e configurá-lo
  levaria as chaves de produção para um banco sem as migrações em revisão.
- Testei as migrações em revisão no stack local, dentro de uma transação com ROLLBACK: aplicam
  sem erro. Depois do merge com a main, a sequência que fica foi testada de novo; ver seção 6.

## 2. Testes

Nova suíte `tests/revocation-fetch.test.mjs`, com 24 casos. Sem rede real: servidor HTTP em
127.0.0.1 e resolvedor de DNS injetado. As LCR/OCSP são sintéticas e assinadas de verdade, e a PKI
sintética tem CDP/AIA apontando para o servidor local.

- **Política de URL:**
  - host fora da antiga lista agora é aceito;
  - recusa esquemas ftp/file/ldap, credenciais, portas 8080/22, IP literal (decimal, hexadecimal,
    IPv6, metadados) e nomes internos;
  - lista de bloqueio funcionando;
  - CDP/AIA oficiais aceitos.
- **Endereços:** privados, loopback, link-local, CGNAT, metadados AWS/Alibaba, IPv6 ULA e
  link-local, IPv4 mapeado (pontuado e hexadecimal), além dos públicos aceitos.
- **Transporte:**
  - DNS que aponta para IP privado é recusado sem conectar (o servidor não recebe nada);
  - DNS que mistura endereço público e privado também é recusado;
  - resposta grande demais é cortada, venha com `Content-Length` ou sem tamanho declarado;
  - tempo esgotado.
- **Ponta a ponta** (`verifyPadesSignature`):
  - LCR da rede leva a GOOD, VALID e emissão liberada;
  - sem provedor, tudo como antes;
  - OCSP tem preferência: a requisição POST é conferida pelo serial e a LCR do signatário não é
    baixada;
  - revogação comprovada bloqueia a emissão;
  - LCR forjada (outra chave) e OCSP com assinatura corrompida não viram GOOD nem INVALID;
  - HTML, HTTP 500, rede caída e provedor que lança erro dão INDETERMINATE com emissão liberada;
  - redirecionamento dentro da lista é seguido; para fora dela ou acima do limite é recusado sem
    tocar o destino;
  - redirecionamento para IP interno é recusado, seja literal ou por DNS que resolve para
    10.0.0.5;
  - URL vinda do PDF: com cadeia não confiável, o provedor nem é chamado;
  - host do CDP fora da lista não gera nenhuma requisição;
  - cadeia sem raiz ICP-Brasil oficial: coleta recusada;
  - cache até nextUpdate;
  - cadeia da TSA coberta, com `tsaTrustComplete` e GOOD_AT_POE.

| Suíte | Antes (17af400) | Depois |
|---|---|---|
| revocation-fetch (nova) | — | 24/24 |
| revocation-evidence-db (nova, PostgreSQL + PostgREST reais) | — | 10/10 |
| pades-revocation-6f2c-r | 22/22 | 22/22 |
| pades-revocation-poe | 20/20 | 20/20 |
| pades-rfc3161-poe | 13/13 | 13/13 |
| pades-x509-chain-trust | 10/10 | 10/10 |
| pades-pdf-integrity | 13/13 | 13/13 |
| digital-signature | 25/25 | 25/25 |
| document-signing-identity | 36/36 | 36/36 |
| evolution-save-before-sign | 12/12 | 12/12 |
| document-signing-route, signed-document-retrieval | 6/6, 12/12 | 6/6, 12/12 |
| signature-providers, -oauth-context, -oauth-reproduction | 6, 9, 4 | 6, 9, 4 |
| sncr, sncr-safety, sncr-maintainer, platform | 6, 4, 8, 6 | 6, 4, 8, 6 |
| PostgreSQL real: signature-trust-permissions, signature-identity-db, signature-persistence-local, signature-trust-flow, signature-oauth-local | 24, 3, 46, 10, 36 | 24, 3, 46, 10, 36 |
| PostgreSQL real: sncr-postgres-local, sncr-auth-local, sncr-concurrency-local, sncr-integrated-local | 23, 36, 4, 32 | 23, 36, 4, 32 |

`revocation-evidence-db` cobre:
- a trava da migração;
- registros:
  - LCR GOOD só com metadados;
  - prova de bloqueio e OCSP com os bytes;
- gravação e deduplicação:
  - as mesmas LCRs em 2 tentativas: 2 evidências e 4 vínculos;
  - com o bloqueio e o OCSP: 4 evidências, 7 vínculos e só 2 linhas com bytes;
- recusas da função:
  - SHA ou tamanho divergente;
  - prova de bloqueio sem bytes e OCSP sem bytes;
  - secretária, outra clínica, tentativa sem artefato e lista vazia;
- autenticado sem escrita, nem pela função nem direto na tabela;
- RLS: médico lê 7/4; secretária, outra clínica e anônimo, 0/0;
- reverificação sem rede:
  - só metadados dá INDETERMINATE (REVOCATION_UNAVAILABLE) sem erro;
  - a LCR de bloqueio guardada continua bloqueando a emissão;
  - o OCSP guardado dá GOOD de novo;
- bytes adulterados descartados;
- LCR só com metadados recebe os bytes quando vira prova de bloqueio;
- degradação sem a migração.

`signature-trust-permissions` passou a excluir a nova migração da lista do histórico (24/24).

Nenhuma suíte existente disparou busca na rede: as cadeias sintéticas não terminam em raiz
ICP-Brasil oficial. Além das suítes:
- `tsc --noEmit` sem erros;
- `oxlint` nos arquivos alterados sem erros;
- `npm run build` ok, com variáveis sintéticas;
- `git diff --check` limpo.

**Teste manual (fora da suíte), 29/10/2026.** GET de `http://acraiz.icpbrasil.gov.br/LCRacraizv5.crl`
pelo transporte de produção, com a política, o DNS e o IP conferidos e sem dado de paciente:

```
política: true
HTTP 200 bytes 869 ms 47
emissor: BR, ICP-Brasil, Instituto Nacional de Tecnologia da Informacao - ITI, Autoridade Certificadora Raiz Brasileira v5
thisUpdate 2026-10-01T14:28:55.000Z nextUpdate 2026-12-30T14:28:55.000Z revogados 2
assinatura confere com a raiz v5: true
```

## 3. Riscos restantes e decisões pendentes

- **Hosts abertos.** Qualquer AC credenciada (cadeia validada até a raiz ICP-Brasil) pode fazer o
  servidor consultar um host público à escolha dela. O risco é limitado: só IP público, portas
  80/443, sem credenciais, com limites de tamanho e tempo, e a resposta passa pelo validador.
  Para cortar uma AC específica, use `PSYWRITE_REVOCATION_BLOCKED_HOSTS`.
- **Migração pendente em produção.** Sem ela, a evidência não é guardada, e a recuperação e a
  reverificação seguem sem evidência, como antes do lote.
- **Evidência guardada envelhece.** Sem POE, a reverificação usa a validação atual
  (`thisUpdate ≤ agora ≤ nextUpdate`). Depois do `nextUpdate`, a LCR guardada fica NOT_FRESH e o
  resultado volta a INDETERMINATE. Ela continua valendo como registro do que foi verificado na
  emissão; para valer no tempo é preciso carimbo e LTV (próximo lote).
- **LCR GOOD sem bytes.** A reverificação posterior de uma assinatura cuja LCR só confirmou "não
  revogado" não tem o arquivo; dá INDETERMINATE, como daria de qualquer jeito após o
  `nextUpdate`. O DSS/LTV do próximo lote põe a evidência dentro do PDF.
- **Carimbo e validação histórica.** Com carimbo de tempo, a LCR precisa ter `thisUpdate`
  posterior ao `genTime`. Na emissão, a LCR em cache costuma ser anterior, e a TSA fica sem
  revogação comprovada. O OCSP, emitido na hora, resolve. A coleta tardia (job com carência) segue
  pendente. As assinaturas Bird ID atuais (PAdES-B-B, sem carimbo) usam a validação atual e não
  são afetadas.
- **DSS/LTV.** A evidência não é embutida no PDF. Fica para um lote próprio.
- **Envenenamento do cache.** Quem conseguir interceptar o HTTP de uma AC (as LCRs ICP-Brasil são
  em HTTP) pode servir uma resposta legível, mas inválida. Ela fica no cache até 6 h e mantém o
  resultado INDETERMINATE, nunca GOOD. Mitigações possíveis: validar antes de guardar no cache ou
  reduzir o teto.
- **OCSP com sucesso, mas inválido, impede a tentativa da LCR** para aquele certificado: o
  resultado fica INDETERMINATE. É conservador, mas pode ser melhorado validando o OCSP antes de
  desistir da LCR.
- **Latência da emissão.** No pior caso, a coleta acrescenta até 12 s. A LCR do ITI respondeu em
  47 ms.
- **Evolução (CMS) sem revogação.** A assinatura de evolução não consulta revogação e continua
  gravando UNVERIFIED. Ligar o provedor ali é o próximo passo natural.
- **Auditoria.** As falhas vão só para o log do servidor (`console.warn`). O registro em
  `audit_events` e o painel operacional ficaram de fora.
- **Default `'VALID'`** de `evolution_signatures.verification_status`: pendência do 6F.2C-R.

## 4. Teste com certificado real (29/10/2026) e correção

**Primeira execução.** O Guilherme rodou o caminho A (`scripts/check-revocation.mjs`) com um PDF
assinado com o Bird ID:
- cadeia confiável;
- SIGNER INDETERMINATE (REVOCATION_UNAVAILABLE);
- as duas ACs superiores GOOD;
- a LCR da AC emissora, `ccd.acsoluti.com.br/lcr/ac-soluti-multipla-v5.crl` (e a do `ccd2`),
  saiu como "LCR ilegível".

**Causa**, investigada só com GET público da LCR:
- O download estava íntegro: HTTP 200, `application/pkix-crl`, sem Content-Encoding, DER de
  919.142 bytes (igual ao Content-Length). Não houve truncamento nem tempo esgotado.
- O `asn1js` 3.0.10 limita, por padrão, cada análise a **10.000 elementos ASN.1**. Essa LCR tem
  34.015 revogados, cerca de 102 mil elementos, e a análise falhava com
  `Maximum ASN.1 node count exceeded`. O "ilegível" escondia esse erro.
- O validador usa o mesmo analisador, então recusaria a LCR do mesmo jeito. O `pkijs` também
  esbarra no limite ao reanalisar a estrutura para assinar uma LCR grande.
- O certificado do signatário tem AIA só com `caIssuers` (1.3.6.1.5.5.7.48.2), sem OCSP, e as
  ACs não têm AIA. Para essa cadeia, a LCR é o único caminho; não havia OCSP a tentar.

**Medição**, com essa LCR:
- análise ASN.1 em ~160 ms e montagem `pkijs` em ~430 ms;
- ~146 MB de heap transitório;
- `nextUpdate` 6 h depois de `thisUpdate`.

**Correção:**
- `parseCrlDer` (`revocation-validator.ts`) analisa com `maxNodes = CRL_MAX_ASN1_NODES` (500 mil).
  O validador, o coletor e o armazenamento usam a mesma função.
- A análise é memorizada por Buffer (WeakMap): a LCR é analisada uma vez só, e não uma vez por
  certificado da cadeia.
- O limite de LCR caiu de 10 MB para **4 MB**, coerente com os 500 mil elementos (~9 bytes por
  elemento numa LCR real). Acima disso, a análise passaria de ~600 MB de heap numa função
  serverless.
- O tempo por requisição de LCR é de 10 s (OCSP continua com 4 s), e o prazo da coleta, 15 s.
- LCR em PEM ("X509 CRL") é aceita.
- Mensagens com a causa:
  - `resposta excede 4 MB`;
  - `tempo esgotado (10 s)`;
  - `formato: HTML em vez de LCR`;
  - `formato: conteúdo gzip sem Content-Encoding`;
  - `formato: Content-Encoding gzip não suportado`;
  - `formato: PEM que não é "X509 CRL"`;
  - `formato: LCR com mais de 500000 elementos ASN.1`.

**Escolha dos limites e do lugar da busca:**
- **Memória e tempo na Vercel.** A análise única de uma LCR desse porte custa ~0,6 s e ~150 MB
  transitórios, folgado para a memória padrão das funções. O limite de 500 mil elementos segura o
  pior caso, inclusive com entrada maliciosa.
- **Cache em memória por instância.** Não sobrevive entre instâncias, então cada instância fria
  baixa a LCR de novo (~0,9 MB, servida por CDN). Como a LCR muda a cada 6 h, o ganho de um cache
  compartilhado seria pequeno.
- **Reusar a LCR guardada no banco até o nextUpdate.** Trocaria um GET de CDN por uma leitura de
  ~0,9 MB do Postgres. Não compensa agora; fica como opção se as ACs ficarem lentas.
- **Busca fora do caminho crítico.** A medição real foi de 1,4 s no processo inteiro (Node +
  verificação + 3 LCRs). Como a emissão precisa do resultado para bloquear revogação comprovada,
  a busca fica no caminho; a fila continua sendo a solução para carimbo e validação histórica.
- **Volume no banco.** A LCR da AC Soluti Múltipla muda a cada 6 h: guardada inteira, seriam até 4
  versões de ~0,9 MB por dia (~1,3 GB por ano). Decidido em 30/10/2026: só metadados para LCR
  GOOD, bytes para OCSP e provas de bloqueio (ver seção 1).

**Teste de regressão** (`tests/revocation-fetch.test.mjs`):
- LCR sintética com 4 mil revogados, montada em ASN.1 e assinada de verdade. O teste confere que
  ela passa do limite padrão, dá GOOD e encontra o signatário revogado no meio dela.
- PEM aceito; gzip, Content-Encoding, PEM de outro tipo, lixo e bytes sobrando, cada um com a sua
  mensagem.
- Mensagem de limite de tamanho.
- Estrutura com 600 mil elementos recusada com a causa.

**Segunda execução, com o mesmo PDF real** (só a saída do script; nada do conteúdo do PDF):

```
Integridade criptográfica: true
Cadeia ICP-Brasil confiável: true
Situação global: VALID
Revogação: GOOD
  SIGNER     GOOD           origem=CRL
  SIGNER_CA  GOOD           origem=CRL
  SIGNER_CA  GOOD           origem=CRL
Buscas:
  CRL   FETCHED  http://ccd.acsoluti.com.br/lcr/ac-soluti-v5.crl
  CRL   FETCHED  http://ccd.acsoluti.com.br/lcr/ac-soluti-multipla-v5.crl
  CRL   FETCHED  http://acraiz.icpbrasil.gov.br/LCRacraizv5.crl
Emissão seria permitida: true
```

Tempo total do processo: 1,4 s.

**Suítes:**
- revocation-fetch: 28/28;
- revocation-evidence-db: 10/10;
- as demais 26 suítes 6F e de assinatura verdes, incluindo as de PostgreSQL real.

`tsc`, lint dos arquivos alterados, build e `git diff --check` limpos.

## 5. Veredito

**APROVADO para o código do lote**, com uma condição para a main:
- A evidência real de uma assinatura Bird ID chegou a GOOD (situação global VALID).
- Os testes, inclusive com PostgreSQL real, estão verdes.
- **Antes do merge na main**, as migrações em revisão (`20261029030000` de tentativas e
  `20261029040000` de evidências) precisam ser aplicadas em produção com o aval do Guilherme.
- O caminho B do roteiro (fluxo completo com gravação no banco local) é opcional.
- Não houve deploy, migração remota nem assinatura nova.

## 6. Merge com a main (30/10/2026)

O Guilherme escolheu a opção A: fica o SNCR da main (PR #10). A linha SNCR desta branch saiu,
resumida em `docs/auditorias/sncr-branch-descartada.md`.

Migrações que ficam, em ordem, depois de `20261016010000`. Os nomes foram atualizados em
30/10/2026, depois do PR #11 da main:

| Migração | Origem | Estado |
|---|---|---|
| `20261030023641_sncr_preparation` | main (PR #10, renomeada no PR #11) | aplicada em produção, segundo o PR #11 |
| `20261030023733_sncr_rce_issuance` | main | aplicada em produção, segundo o PR #11 |
| `20261030023750_prescription_simple` | main (PR #11) | aplicada em produção, segundo o PR #11 |
| `20261030030624_sncr_transition_extension` | main (PR #12): `sncr_transition_end()` = 04/03/2027 | aplicada em produção |
| `20261030040000_signature_identity_guard` | branch (6B), antes `20261028020000` | travada, não aplicada |
| `20261030040100_signature_trust_permissions` | branch (6C), antes `20261029010000` | travada, não aplicada |
| `20261030040200_signature_oauth_attempts` | branch (6D), antes `20261029020000` | travada, não aplicada |
| `20261030040300_document_signing_attempts` | branch (6E), antes `20261029030000`, adaptada ao modelo da main | travada, não aplicada |
| `20261030040400_revocation_evidence` | branch (6F.2D), antes `20261029040000` | travada, não aplicada |

As migrações da branch foram renomeadas (duas vezes, a última depois do PR #12) para depois da última aplicada em produção. Elas nunca
foram aplicadas, e a `…030300` usa `sncr_rce_emissions`, criada na `20261030023733`.

- A sequência aplica sem erro num Postgres descartável a partir do estado de produção.
- `clinical_documents` fica só com as guardas SNCR da main: `sncr_document_guard` e
  `sncr_rce_lock_document`.
- A `20261029030000` deixou de depender de `sncr_reservations` e `sncr_document_modality`, que
  eram da linha da branch. Agora recusa no banco, pelo caminho comum, receita de categoria
  diferente de RCE ou com RCE eletrônica não cancelada (`sncr_rce_emissions`).
- Nada disso foi aplicado em produção. Continua valendo a análise pré-voo: a `20261029030000`
  retira de `service_role` o INSERT direto em `digital_signatures`. Ela só pode ir junto com o
  deploy do código desta branch.

**Receita simples (decisão do Guilherme, 30/10/2026).** A assinatura digital de receita simples
continua funcionando, independentemente da integração SNCR.
- A correção entrou na main pelo PR #11 (categoria `SIMPLES`, política, PDF em uma via e
  `20261030023750_prescription_simple`). Ela já está em produção, então a branch adotou a versão
  da main. A implementação paralela feita aqui (`20261030010000` e
  `documentPrescriptionCategories`) foi descartada no merge.
- A branch acrescenta:
  - a `…030300` (tentativas de assinatura) aceita `SIMPLES` no caminho comum;
  - `simple-prescription.test` (5 casos: política em qualquer data, recusa na numeração SNCR,
    PDF em uma via);
  - `signature-persistence-local`, com receita simples concluída e RCE conforme a data em
    Brasília;
  - `signature-trust-flow`, com receita simples assinada pelo fluxo completo e o original
    recuperado.
