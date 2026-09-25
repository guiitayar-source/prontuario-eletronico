# Integração de Assinatura Digital ICP-Brasil com Bird ID (Cloud HSM)

Este documento descreve a arquitetura, o fluxo de autenticação OAuth 2.0 PKCE, a geração e incorporação de assinaturas PAdES (`ETSI.CAdES.detached` com SHA-256), a validação estrita de titularidade (CPF) e os mecanismos de imutabilidade implementados no prontuário eletrônico.

---

## 1. Visão Geral e Conformidade Legal

A implementação atende integralmente à legislação brasileira de documentos médicos eletrônicos e certificados digitais:
- **Medida Provisória nº 2.200-2/2001**: Institui a Infraestrutura de Chaves Públicas Brasileira (ICP-Brasil).
- **Lei Federal nº 14.063/2020**: Regulamenta o uso de assinaturas eletrônicas e digitais em serviços de saúde.
- **Resolução CFM nº 2.299/2021**: Normatiza a emissão de documentos médicos eletrônicos com assinatura digital ICP-Brasil.
- **Padrão PAdES (PDF Advanced Electronic Signatures)**: SubFilter `ETSI.CAdES.detached`, `/ByteRange` estrito, `/Contents` e função hash criptográfica SHA-256 (OID `2.16.840.1.101.3.4.2.1`).

---

## 2. Princípios de Segurança Criptográfica

1. **A chave privada NUNCA transita pelo nosso sistema**:
   - A chave privada do médico permanece permanentemente protegida no Hardware Security Module (HSM) certificado ICP-Brasil em nuvem da Bird ID (Valid).
   - O nosso sistema envia **apenas o resumo criptográfico (hash SHA-256)** do documento preparado para a API da Bird ID.
2. **Autenticação OAuth 2.0 com PKCE (RFC 7636)**:
   - Utilização de `code_verifier` (alta entropia aleatória) e `code_challenge` (S256) gerados a cada tentativa de conexão.
   - Proteção estrita contra ataques CSRF e interceptação de código de autorização através de `state` assinado com hash e com expiração curta (15 minutos).
3. **Sessão de Assinatura (`signature_session`)**:
   - Uma única autorização inicial no aplicativo Bird ID habilita uma sessão válida por tempo determinado (ex.: 4 horas de atendimento ambulatorial).
   - O médico pode assinar múltiplos prontuários, receitas e atestados durante o período sem necessidade de aprovação push no celular a cada documento individual.
4. **Armazenamento Seguro de Tokens (AES-256-GCM)**:
   - Tokens de acesso OAuth são cifrados em repouso no banco PostgreSQL com criptografia autenticada AES-256-GCM antes da gravação na tabela `signature_sessions`.
   - A chave de criptografia de 256 bits é mantida estritamente nas variáveis de ambiente do servidor (`SIGNATURE_ENCRYPTION_KEY`).
5. **Validação Estrita de Titularidade (CPF Matching)**:
   - Ao receber o certificado X.509 da Bird ID, o sistema extrai o CPF do médico:
     1. Via Subject Alternative Name (SAN) `otherName` com OID `2.16.76.1.3.1` (Pessoa Física ICP-Brasil).
     2. Via Common Name (`CN=NOME DO MEDICO:CPF`).
   - O sistema valida que o CPF do certificado coincide rigorosamente com o CPF cadastrado do médico logado na clínica.
   - Se houver divergência, a sessão é **rejeitada imediatamente com HTTP 403** e um alerta de segurança é gravado na tabela `audit_events`.
6. **Imutabilidade e Não-Repúdio**:
   - Ao ser assinado, o documento tem seu status alterado para `SIGNED` e seu PDF final gravado no Storage.
   - Um gatilho no banco de dados (`trg_check_clinical_document_immutable`) proíbe qualquer operação de `UPDATE` ou `DELETE` subsequente no registro do documento.
   - A interface web bloqueia qualquer edição, oferecendo apenas "Duplicar como novo rascunho".

---

## 3. Fluxo de Execução

```
[Médico no Navegador]           [Backend Next.js]               [Bird ID Cloud API]
         |                              |                                |
         |--- 1. Conectar Bird ID ----->|                                |
         |    (GET /api/.../authorize)  |-- Gera PKCE (verifier/chal) -->|
         |                              |-- Salva state_hash no DB ----->|
         |<-- Retorna URL Authorize ----|                                |
         |                                                               |
         |--- 2. Redireciona navegador para Bird ID -------------------->|
         |<-- 3. Notificação Push no Celular / Autenticação -------------|
         |<-- 4. Redirecionamento com code + state ----------------------|
         |                                                               |
         |--- 5. GET /api/.../callback?code=...&state=... -------------->|
         |                              |-- Valida state e CSRF -------->|
         |                              |-- Troca code por token ------->|
         |                              |<-- Retorna access_token -------|
         |                              |-- Busca certificados X.509 --->|
         |                              |<-- Retorna lista de certs -----|
         |                              |-- Valida CPF estrito --------->|
         |                              |-- Cifra token (AES-GCM) ------>|
         |                              |-- Grava signature_sessions --->|
         |<-- 6. Redireciona p/ UI -----|                                |
         |    (?signature_status=ok)    |                                |
         |                                                               |
         |--- 7. "Finalizar e assinar" ->|                               |
         |    (POST /api/.../sign)      |-- Carrega PDF oficial -------->|
         |                              |-- Prepara PAdES & ByteRange -->|
         |                              |-- Calcula digest SHA-256 ----->|
         |                              |-- POST /oauth/signature ------>|
         |                              |   (apenas o hash SHA-256)      |
         |                              |<-- Retorna CMS SignedData -----|
         |                              |-- Incorpora CMS no PDF ------->|
         |                              |-- Verifica PAdES localmente -->|
         |                              |-- Grava no Storage / DB ------>|
         |                              |-- Atualiza status = SIGNED --->|
         |                              |-- Registra audit_events ------>|
         |<-- Retorna PDF assinado -----|                                |
```

---

## 4. Variáveis de Ambiente

As seguintes variáveis de ambiente devem ser configuradas no arquivo `.env.local` (ou secrets da hospedagem):

```bash
# ==============================================================================
# ASSINATURA DIGITAL ICP-BRASIL (BIRD ID)
# ==============================================================================
# Endpoint da API Bird ID (Produção: https://api.birdid.com.br/v0 | Sandbox: https://api.sandbox.birdid.com.br/v0)
BIRDID_BASE_URL="https://api.birdid.com.br/v0"

# Credenciais obtidas no Portal do Desenvolvedor Bird ID / Valid Certificadora
BIRDID_CLIENT_ID="seu_client_id_aqui"
BIRDID_CLIENT_SECRET="seu_client_secret_aqui"

# URL de callback registrada na sua aplicação na Bird ID
BIRDID_REDIRECT_URI="https://seu-dominio.com.br/api/digital-signature/birdid/callback"

# Chave simétrica para cifrar tokens de sessão de assinatura em repouso no PostgreSQL
# (32 bytes em hexadecimal = 64 caracteres hexadecimais)
SIGNATURE_ENCRYPTION_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

# Modo Mock para testes e desenvolvimento sem credenciais ativas
# Defina como "true" em desenvolvimento ou CI
BIRDID_USE_MOCK="false"
```

---

## 5. Ferramenta CLI de Verificação Criptográfica

Para auditoria independente e conferência offline de documentos assinados pelo prontuário:

```bash
# Execução via npm script
npm run verify-signature <caminho-para-documento.pdf>

# Exemplo de saída:
======================================================
  VERIFICADOR DE ASSINATURA DIGITAL ICP-BRASIL (PAdES)
======================================================
Arquivo: /home/.../receita_assinada.pdf

Tamanho do arquivo: 18.28 KB

--- RESULTADO DA VERIFICAÇÃO CRIPTOGRÁFICA ---
✔ STATUS: ASSINATURA ÍNTEGRA E VÁLIDA (PAdES / SHA-256)
O documento NÃO foi alterado desde a assinatura.

--- DADOS DO SIGNATÁRIO ---
Signatário (CN): DR. GUILHERME TAYAR DE CAMARGO:12345678901
CPF:             123.456.789-01
Sujeito:         C=BR + O=ICP-Brasil + OU=Certisign + CN=DR. GUILHERME TAYAR DE CAMARGO:12345678901

--- CERTIFICADO DIGITAL ---
Emissor (AC):    C=BR + O=ICP-Brasil + CN=AC Certisign Multipla G7
Serial:          1A2B3C4D
Válido de:       10/01/2026, 09:00:00
Válido até:      10/01/2027, 09:00:00
Fingerprint 256: E8:61:CD:6F:FE:B5:92:77:56:E0:4A:3C:BB:B4:72:71...

--- DETALHES TÉCNICOS PAdES ---
ByteRange:       [0, 1053, 17439, 1279]
Digest SHA-256:  5dff0c836d27cc0fa96c47f79d24fb1fdfe34bc6a17c899a27d4a215be84af9d
======================================================
```

A ferramenta retorna `0` se a assinatura for matematicamente válida e íntegra, e `1` caso o documento tenha sido adulterado em qualquer byte ou a assinatura seja inválida.

---

## 6. Testes Automatizados

Para rodar a suíte de testes de assinatura:

```bash
npm run test:signature
```

A suíte cobre:
1. Geração de parâmetros PKCE (RFC 7636).
2. Cifragem e decifragem de tokens com AES-256-GCM e rejeição de tags corrompidas.
3. Comparação em tempo constante para mitigação de side-channel attacks.
4. Extração de CPF em certificados ICP-Brasil (SAN OID `2.16.76.1.3.1` e CN).
5. Ciclo completo de preparação PAdES, cálculo de ByteRange e digest SHA-256.
6. Assinatura destacada CMS com atributos assinados (`messageDigest`, `signingTime`, `contentType`).
7. Verificação criptográfica completa do PDF gerado.
8. Detecção e reprovação de adulteração de bytes no documento assinado.
9. Execução e validação da ferramenta CLI.
