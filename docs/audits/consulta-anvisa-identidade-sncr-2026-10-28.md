# Consulta técnica preparada — identidade e evidência de vinculação SNCR

**Rascunho para revisão. Não enviado.**

Destinatário: sncr.integracao@anvisa.gov.br (contato indicado no §2.5 do Manual API SNCR).

Assunto: API SNCR — validação do vínculo CPF/CRM-UF e evidência a conservar pela plataforma

Prezados,

Estamos integrando uma plataforma privada de prescrição eletrônica ao SNCR pelo fluxo individual gov.br documentado. Como o serviço de prescrição deve comprovar que o token recebido corresponde ao CPF e à inscrição CRM/UF do prescritor?

Existe endpoint de consulta de identidade, claim verificável, validação implícita na requisição de numeração ou outro mecanismo oficialmente previsto?

Qual evidência deve ser conservada pela plataforma para demonstrar a vinculação correta?

A dúvida decorre da leitura conjunta das seguintes fontes:

- Manual API SNCR, **3ª edição, setembro de 2026**, §§2.2.1–2.2.4: autenticação individual gov.br e troca de session_id; o exemplo de resposta de auth/token contém access_token e token_type.
- Mesmo manual, **§2.3.2.2, p.13**, fluxograma de RCE/RET: a API SNCR verifica se o documento profissional pertence ao CPF e consulta a API do conselho indicado.
- **§2.3.2.5.i, p.14**, e **§2.3.2.7, pp.15–16**: correspondência entre prescritor autenticado e inscrição solicitada; mensagens sobre CPF autenticado, inscrição e regularidade profissional.
- **§§2.3.1.5.i e 2.3.1.7, pp.11–12**: regras equivalentes para notificações, incluindo rejeição de inscrição diferente da autenticada.
- FAQ de integração dos sistemas de prescrição ao SNCR, **1ª edição, perguntas 20–22, pp.8–9 impressas**: cadastramento/regularidade e validação pelo próprio SNCR nas bases dos conselhos.

Nosso entendimento é que o SNCR realiza a validação CPF autenticado ↔ conselho/documento/UF durante a operação de numeração, e que não há exigência expressa, nas fontes citadas, de a plataforma repetir previamente a consulta às bases dos conselhos. Gostaríamos de confirmar:

1. A resposta de sucesso documentada — HTTP 201 para RCE/RET ou HTTP 200 para notificações, com corpo válido — confirma que a inscrição enviada foi aceita para o titular da sessão individual utilizada nessa transação?
2. Essa validação transacional é o mecanismo previsto para a plataforma, ou também existe alguma validação prévia obrigatória entre o CPF do seu cadastro interno e o titular autenticado no SNCR?
3. É suficiente conservar, em acesso restrito e sem o token bruto, a referência interna do usuário/sessão, ambiente, inscrição solicitada, correlação local, horário, requisição efetivamente enviada, status e resposta de numeração recebida? Há identificador oficial de transação, comprovante, prazo ou formato de retenção exigidos?
4. Se houver necessidade de validação independente do token, quais são os claims, issuer, audience, algoritmos e mecanismo de descoberta/JWKS oficialmente suportados por ambiente? Existe endpoint documentado para consulta do próprio titular autenticado?
5. Como validar esses cenários em homologação com contas/inscrições autorizadas para teste, inclusive inscrição incompatível, sem utilizar produção? O sucesso observado em homologação tem o mesmo significado de vinculação previsto para produção?

Não assumimos que a ausência de CPF explícito na resposta de token represente falha de autenticação. Também não utilizamos dados preenchidos manualmente ou JWT apenas decodificado como prova oficial. As operações reais continuam bloqueadas enquanto concluímos a validação técnica do fluxo.

Atenciosamente,

Equipe técnica PsyWrite

## Fontes para acompanhar a consulta

- [Documentos oficiais SNCR](https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/documentos-do-sncr).
- [Manual API SNCR](https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/documentos-do-sncr/sncr_manual_api_v5.pdf/@@download/file).
- [FAQ de integração](https://www.gov.br/anvisa/pt-br/assuntos/medicamentos/controlados/sncr/documentos-do-sncr/perguntas-e-respostas-sncr-2-0-integracao.pdf/@@download/file).
- [OpenAPI de homologação](https://api-gateway.hmg.apps.anvisa.gov.br/api-sncr/v3/api-docs), consultado com info.version=1.2.1. Publica os dois recursos de numeração, sem contrato de consulta de identidade do titular.
