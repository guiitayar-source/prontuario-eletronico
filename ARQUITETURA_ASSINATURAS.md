# Arquitetura das assinaturas digitais

Guia para quem for mexer nas assinaturas ICP-Brasil do PsyWrite. Descreve o que existe, por onde os dados passam, o que é verificado e onde estão os limites.

Há **dois tipos de assinatura**, que compartilham a sessão com o Bird ID e a mesma forma de assinar (o sistema envia só um hash SHA-256 e recebe uma assinatura CMS):

| | Documentos (receitas, atestados…) | Evoluções clínicas |
|---|---|---|
| O que é assinado | PDF gerado pelo sistema | Representação canônica em JSON da evolução |
| Formato | PAdES (CMS embutido no PDF) | CMS destacado, guardado no banco |
| Onde fica | PDF no Storage + linha em `digital_signatures` | Linha em `evolution_signatures` |
| Validação externa | Validador do ITI (validar.iti.gov.br) | Só pela verificação do próprio sistema |
| Verificação interna | `padesService.verifyPadesSignature` | `evolutionSigningService.verifyEvolutionSignature` |

---

## 1. Mapa dos arquivos

```
lib/signature/
  types.ts                       Tipos compartilhados e interface do provedor
  provider-factory.ts            Escolhe o provedor (Bird ID; mock só em NODE_ENV=test)
  birdid-provider.ts             Cliente da API Bird ID: OAuth, certificados, signHash
  mock-birdid-provider.ts        Provedor falso para testes (gera CA e certificado próprios)
  crypto-utils.ts                PKCE, AES-256-GCM dos tokens, CPF do certificado, parse X.509
  document-signing-service.ts    Sessão OAuth + assinatura de documentos (PAdES)
  pades-service.ts               Prepara o PDF, embute o CMS e verifica o PAdES
  evolution-signing-service.ts   Assinatura e verificação de evoluções
  canonical-evolution.ts         Monta e serializa o JSON canônico da evolução (schema v1)
  evolution-cms.ts               Verificação criptográfica do CMS da evolução
  icp-chain.ts                   Validação da cadeia até uma raiz ICP-Brasil fixada
  icp-brasil-certs.ts            GERADO: raízes fixadas + ACs intermediárias do ITI

app/api/digital-signature/
  birdid/authorize               Inicia o OAuth (PKCE) e devolve a URL do Bird ID
  birdid/callback                Recebe o code, cria a sessão de assinatura
  session                        GET: sessão ativa · DELETE: desconectar
  sign                           Assina um documento clínico (PAdES)
  sign-evolution                 Assina uma evolução
  evolution-details              Verifica e devolve os detalhes da assinatura da evolução
  test-sign                      Assina um documento sintético (teste de ponta a ponta)

components/
  documents.tsx                          Conectar Bird ID, assinar documento, baixar PDF assinado
  clinical-record.tsx                    Assinar evolução
  evolution-signature-details-modal.tsx  Tela "Detalhes da assinatura"

scripts/
  verify-signature.mjs           Verifica um PDF assinado (assinatura, cadeia, diagnóstico CMS)
  update-icp-certs.mjs           Regera icp-brasil-certs.ts a partir do pacote do ITI

supabase/migrations/
  20260925010000_digital_signatures.sql   signature_sessions, signature_oauth_states,
                                          digital_signatures, trava de documentos assinados
  20260925230000_evolution_signatures.sql evolution_signatures, travas de evoluções assinadas
```

Todas as rotas exigem papel `owner` ou `doctor`. As gravações nas tabelas de assinatura usam o cliente administrativo (`adminClient`, chave de servidor) depois das checagens de permissão feitas na rota e no serviço. Os usuários só têm `select` nessas tabelas.

---

## 2. Sessão de assinatura (Bird ID)

O médico autoriza uma vez e assina vários documentos durante a sessão (4 horas).

1. **authorize**: gera `code_verifier`/`code_challenge` (PKCE S256) e um `state` aleatório. Grava o hash do `state` e o `code_verifier` cifrado em `signature_oauth_states` (expira em 15 min). Usa o CPF do perfil como `login_hint`, quando existe.
2. O navegador vai ao Bird ID e o médico aprova no celular.
3. **callback**: confere o `state`, troca o `code` pelo token e busca o certificado.
4. **Titularidade**: extrai o CPF do certificado (SAN `2.16.76.1.3.1` ou `CN=NOME:CPF`) e compara com `document_profiles.cpf`.
   - Divergente: recusa com 403 e grava `signature_cpf_mismatch` em `audit_events`.
   - Perfil sem CPF: grava o CPF do certificado (fica travado a partir daí).
5. Grava o token **cifrado com AES-256-GCM** (`SIGNATURE_ENCRYPTION_KEY`) em `signature_sessions`. Existe uma sessão ativa por usuário, clínica e provedor.

A chave privada do médico nunca passa pelo sistema: fica no HSM do Bird ID.

---

## 3. Assinatura de documentos (PAdES)

`documentSigningService.signClinicalDocument`:

1. Confere a sessão ativa e decifra o token.
2. Busca o documento, marca `status = 'SIGNING'`.
3. Completa os dados do PDF com `withPdfData` (endereço do paciente nas receitas e timbre do autor, de `document_profiles`) e gera o PDF com `documentPdf` (`lib/document-pdf.ts`).
4. `padesService.preparePdfForSignature`: reserva o espaço da assinatura (`/ByteRange`, `/Contents`), desenha o selo visual e calcula o SHA-256 dos bytes cobertos.
5. `provider.signHash`: envia só o hash; recebe o CMS.
6. `padesService.embedSignature`: grava o CMS no espaço reservado.
7. `padesService.verifyPadesSignature`: **verifica antes de gravar**. Se falhar, nada é salvo e o documento vai para `SIGNATURE_FAILED`.
8. Envia o PDF ao Storage (`<clinica>/signatures/<doc>_v<versão>_signed.pdf`), insere em `digital_signatures`, marca o documento como `SIGNED` e grava a auditoria.

**Trava no banco**: `trg_check_clinical_document_immutable` impede alterar texto, tipo, data, profissional e paciente de documentos `FINALIZED`, `SIGNED` ou `SUPERSEDED`. Na interface, um documento assinado só pode ser duplicado como novo rascunho.

A verificação PAdES confere o hash dos bytes cobertos e a assinatura com a chave do certificado embutido. **Não há alternativa que aprove o PDF só pelo hash.** Para cadeia e revogação, o PDF pode ser levado ao validador do ITI.

---

## 4. Assinatura de evoluções

Evoluções não viram PDF. O que se assina é um JSON canônico.

### 4.1 Representação canônica (schema v1)

`canonical-evolution.ts` monta:

```json
{
  "appointment_id": "...ou null",
  "clinic_id": "...",
  "clinical_text": "texto normalizado",
  "created_at": "ISO 8601",
  "doctor_id": "...",
  "evolution_id": "...",
  "patient_id": "...",
  "schema_version": 1,
  "version": 3
}
```

- Texto normalizado: Unicode NFC, quebras de linha `\n`, sem espaços nas pontas.
- Serialização: `JSON.stringify` com as chaves em ordem alfabética (só um nível).
- Hash: SHA-256 dos bytes UTF-8 dessa string.

**Nunca altere a serialização ou os campos do schema v1**: todas as assinaturas já gravadas deixariam de conferir. Para mudar, crie um schema v2 e mantenha o v1 para verificar as antigas (o `canonical_schema_version` fica gravado em cada assinatura).

### 4.2 Assinar

`evolutionSigningService.signEvolution`:

1. Confere a sessão, a evolução (não pode estar assinada; texto não vazio) e marca `status = 'SIGNING'`.
2. Monta o JSON canônico e o hash, e chama `provider.signHash`.
3. **Verifica a resposta antes de gravar** (`verifyEvolutionCms`): a assinatura precisa conferir com os dados e o certificado precisa estar dentro da validade. Se falhar, a evolução **não** é bloqueada e volta ao status anterior.
4. Insere em `evolution_signatures` (JSON canônico, hash, CMS em base64, dados do certificado).
5. Marca a evolução como `SIGNED` (grava `current_signature_id`) e conclui o agendamento vinculado.

**Travas no banco**: `trg_check_consultation_immutable` impede alterar texto, paciente, clínica, autor e data de criação de uma evolução `SIGNED`. `trg_check_consultation_delete_immutable` impede excluí-la. Complementos são adendos.

### 4.3 Verificar (tela "Detalhes da assinatura")

`verifyEvolutionSignature` combina quatro checagens:

| Checagem | O que prova | Campo |
|---|---|---|
| Hash do JSON canônico gravado = `document_hash` | O registro da assinatura é coerente | `hashMatches` |
| Texto, paciente, clínica e autor atuais = JSON canônico | A evolução não mudou depois de assinada | `dataMatchesRecord` |
| CMS: `messageDigest` = hash e assinatura conferida com a chave do certificado | O certificado embutido assinou exatamente esses dados | `signatureValid` |
| Certificado = o registrado e válido na data da assinatura | Não houve troca de certificado | `certificateValid` |

`isValid` exige as quatro. A **cadeia ICP-Brasil** é informada à parte (`chainValid`, `chainPath`, `chainError`):

- tudo válido → selo verde;
- íntegra, mas cadeia não confirmada → aviso amarelo;
- qualquer outra falha → erro vermelho com o motivo.

Cada verificação grava `EVOLUTION_SIGNATURE_VERIFIED` em `audit_events`.

---

## 5. Cadeia ICP-Brasil

`icp-chain.ts` valida o caminho do certificado do signatário até uma **raiz fixada**, na data da assinatura, usando o `CertificateChainValidationEngine` do pkijs. Cada elo é conferido pela assinatura da chave de cima, pelos prazos e pela marcação de AC.

- **Raízes fixadas**: só as listadas em `PINNED_ROOTS` (`scripts/update-icp-certs.mjs`), identificadas pela impressão digital SHA-256. Hoje: **Autoridade Certificadora Raiz Brasileira v5**.
- **ACs intermediárias**: todas as do pacote do ITI. Não precisam ser confiáveis, porque só valem se a cadeia fechar numa raiz fixada.
- Os certificados vão embutidos no código (`icp-brasil-certs.ts`), então a verificação não depende de rede.

Cuidados com o pkijs (já tratados, com testes):

- O certificado a validar precisa ser o **último** da lista `certs`.
- O pkijs remove duplicados. Se o signatário também estiver no pacote, a cópia do fim some e outro certificado vira o validado. Por isso o signatário é retirado do pacote antes, e o resultado só é aceito se o caminho começar nele.

### Como fixar uma nova raiz (v6, v7, v10, v11, v12…)

O site do ITI só é acessível por HTTP ou por HTTPS com certificado ICP-Brasil (não reconhecido pelos sistemas comuns). Por isso a impressão digital precisa ser confirmada por uma prova independente:

1. Obtenha um PDF assinado com um certificado dessa raiz e **aprovado no validador do ITI**.
2. Baixe e descompacte o pacote:
   ```sh
   curl -o /tmp/ac.zip http://acraiz.icpbrasil.gov.br/credenciadas/CertificadosAC-ICP-Brasil/ACcompactado.zip
   unzip -o /tmp/ac.zip -d /tmp/ac
   ```
3. Adicione a impressão digital da raiz em `PINNED_ROOTS` e rode `node scripts/update-icp-certs.mjs /tmp/ac`.
4. Rode `npm run verify-signature -- <pdf>`. A linha "Cadeia ICP-Brasil" precisa sair **CONFIRMADA** até essa raiz. Se a raiz fosse falsa, a cadeia de um certificado real não fecharia.
5. Rode `npm run test:signature`.

Para atualizar as ACs intermediárias (novas ACs credenciadas), repita os passos 2 e 3 sem mudar `PINNED_ROOTS`.

---

## 6. Variáveis de ambiente

| Variável | Uso |
|---|---|
| `BIRDID_CLIENT_ID`, `BIRDID_CLIENT_SECRET` | Credenciais da aplicação no Bird ID. **Obrigatórias; não há valor padrão no código.** |
| `BIRDID_BASE_URL` | API do Bird ID (padrão: produção). |
| `BIRDID_REDIRECT_URI` | URL do callback registrada no Bird ID. |
| `SIGNATURE_ENCRYPTION_KEY` | 32 bytes em hexadecimal (64 caracteres). Cifra tokens e `code_verifier`. Trocar invalida as sessões abertas. |
| `SIGNATURE_PROVIDER` | `birdid` (padrão). `mock` só funciona com `NODE_ENV=test`. |

---

## 7. Testes e ferramentas

```sh
npm run test:signature                      # suíte de assinatura (tests/digital-signature.test.mjs)
npm run verify-signature -- arquivo.pdf     # verifica um PDF assinado
```

A suíte cobre, entre outros:

- PKCE, AES-GCM, extração de CPF;
- PAdES: assinatura íntegra, PDF adulterado e **assinatura corrompida com hash correto**;
- evoluções: JSON canônico determinístico; dados adulterados, assinatura corrompida, **certificado trocado com o mesmo hash** e conteúdo que não é CMS;
- cadeia: cadeia real da SOLUTI até a Raiz v5, data fora da validade, raiz não fixada, certificado autoemitido e **certificado que se diz emitido pela AC SOLUTI mas foi assinado por outra chave**.

Toda mudança na verificação deve manter os testes negativos: eles pegaram erros reais (um "plano B" que aprovava PDFs só pelo hash e o uso errado do pkijs na cadeia).

O provedor mock gera a própria AC; certificados dele **nunca** fecham cadeia ICP-Brasil.

---

## 8. Limites conhecidos

- **Revogação não é consultada** (LCR/OCSP). Um certificado cancelado antes de vencer aparece como válido na verificação interna. Para PDFs, o validador do ITI consulta.
- **Sem carimbo do tempo.** A data e hora da assinatura são as do servidor. Uma prova independente da data exige carimbo do tempo de uma ACT credenciada.
- **Só a raiz v5 está fixada.** Certificados de outras raízes aparecem com o aviso amarelo até a raiz ser fixada (seção 5).
- As travas no banco impedem alterações pelo aplicativo, mas quem administra o banco pode contorná-las. Nesse caso a verificação deixa de confirmar a assinatura, que é o que torna a alteração detectável.
- A verificação interna não substitui o validador do ITI para fins legais.
