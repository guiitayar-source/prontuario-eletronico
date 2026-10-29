# Lote 6F.2D — evidência de revogação (LCR/OCSP) obtida na rede (A1)

Branch `work/checkpoint-lote-1-2026-10-27`. Segue o desenho da Fase 3 de
`docs/auditorias/6f2c/CORRECAO-6F2C-R.md`. Commits: `707de44` (módulo de busca), `574394b`
(ligação na verificação e na emissão e testes).

## 1. O que foi feito

**`lib/signature/revocation-fetch.ts`** — só busca bytes; quem decide é o
`revocation-validator`. Toda LCR/OCSP baixada entra como evidência injetada (`crls`,
`ocspResponses`) e passa pela mesma validação de assinatura, emissor e frescor.

- **Origem dos endereços.** CDP (LCR) e AIA/OCSP de cada certificado da cadeia, com a âncora de
  fora. A coleta só roda depois de a cadeia ser validada até uma âncora (`chainTrustedForRevocation`
  no signatário, `validAndTrusted` na TSA). Além disso, o provedor recusa cadeia cuja âncora não
  seja, byte a byte, uma raiz de `icp-brasil-certs.ts`. URL vinda do PDF, do DSS ou do cliente
  nunca é usada.
- **Política de URL.** Só `http`/`https`, nas portas 80/443, sem usuário ou senha e sem IP
  literal. O host tem de pertencer à allowlist, que admite subdomínios:
  `ICP_BRASIL_REVOCATION_HOST_SUFFIXES`, com 16 domínios levantados dos CDP/AIA dos certificados
  oficiais do pacote.
  - Um teste confere que todo CDP/AIA daqueles certificados continua coberto.
  - Hosts extras entram por `PSYWRITE_REVOCATION_EXTRA_HOSTS`, separados por vírgula; IP é
    recusado.
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

**Fora deste lote:**
- Não alterei os bytes assinados, o texto canônico (`canonical-evolution.ts`) nem o formato do
  PDF.
- DSS/LTV não foi embutido.
- Nenhuma migração foi criada: a evidência não é persistida no banco.

## 2. Testes

Nova suíte `tests/revocation-fetch.test.mjs`, com 22 casos. Sem rede real: servidor HTTP em
127.0.0.1 e resolvedor de DNS injetado. As LCR/OCSP são sintéticas e assinadas de verdade, e a PKI
sintética tem CDP/AIA apontando para o servidor local.

- **Política de URL:** esquemas ftp/file/ldap, credenciais, portas 8080/22, IP literal (incluindo
  decimal e IPv6), host fora da lista e nomes parecidos (`icpbrasil.gov.br.evil.example`,
  `evilicpbrasil.gov.br`); variável de hosts extras; cobertura dos CDP/AIA oficiais.
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
  - host do CDP fora da lista não gera nenhuma requisição;
  - cadeia sem raiz ICP-Brasil oficial: coleta recusada;
  - cache até nextUpdate;
  - cadeia da TSA coberta, com `tsaTrustComplete` e GOOD_AT_POE.

| Suíte | Antes (17af400) | Depois |
|---|---|---|
| revocation-fetch (nova) | — | 22/22 |
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

- **Allowlist fixa.** Se a AC emissora do certificado do médico (por exemplo, a AC de 2º nível do
  Bird ID) publicar a LCR/OCSP num domínio fora da lista, a busca é recusada e o resultado
  continua INDETERMINATE, como hoje.
  - Isso precisa ser conferido com um certificado real, cuja cadeia não está no repositório.
  - Decisão do Guilherme: manter a lista e ampliá-la com `PSYWRITE_REVOCATION_EXTRA_HOSTS`, ou
    aceitar qualquer host que conste num certificado de cadeia ICP-Brasil validada.
- **Carimbo e validação histórica.** Com carimbo de tempo, a LCR precisa ter `thisUpdate`
  posterior ao `genTime`. Na emissão, a LCR em cache costuma ser anterior, e a TSA fica sem
  revogação comprovada. O OCSP, emitido na hora, resolve. A coleta tardia (job com carência) segue
  pendente. As assinaturas Bird ID atuais (PAdES-B-B, sem carimbo) usam a validação atual e não
  são afetadas.
- **Persistência e LTV.** A evidência não é guardada no banco nem embutida no PDF (DSS). Uma
  verificação futura depende de buscar de novo; depois do vencimento do certificado, a LCR deixa
  de comprovar. Decisão do Guilherme:
  - tabela `revocation_evidence`, que exige migração aplicada antes de ir para a main;
  - DSS/LTV numa revisão incremental do PDF.
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

## 4. Veredito

**PENDENTE.**
- O código e os testes estão completos e verdes.
- Falta conferir com uma assinatura Bird ID real que os CDP/AIA da AC do médico estão na
  allowlist e que a evidência chega a GOOD. O teste manual cobriu só a LCR da raiz.
- Faltam as decisões de persistência e de DSS.
- Não houve deploy, migração remota nem assinatura real.
