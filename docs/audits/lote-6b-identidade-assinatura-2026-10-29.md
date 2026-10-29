# Lote 6B — identidade, autoria e titularidade da assinatura

**APROVADO no escopo local do Lote 6B.** Base: commit `00c6fe128825d143fa87c85f8d09082709b8a515`. Não representa homologação oficial nem validação completa de confiança ICP-Brasil.

## Política implementada

Todos os tipos de `clinical_documents` usam a autorização de autoria persistida no backend. Pertencer à mesma clínica ou ser proprietário não concede delegação. O caminho SNCR reutiliza essa verificação e conserva as validações adicionais de reserva, modalidade, versão, ambiente e prescritor.

A assinatura comum confronta usuário/clínica/autor, versão do documento, inscrição e CPF do perfil, sessão e certificado X.509 autorizado. O certificado autorizado é conservado no campo `certificate_raw`, já existente no esquema. A identidade devolvida pelo verificador PAdES vem do certificado efetivamente utilizado pelo PKIjs para verificar o CMS, não de uma seleção por serial isolado ou do primeiro certificado embutido. CPF e fingerprint precisam corresponder à autorização anterior, que é reavaliada antes da conclusão.

Não há fallback para CPF declarado no OAuth quando o certificado não contém identidade utilizável. Sessões antigas sem o certificado autorizado exigem reconexão. Os registros novos de assinatura permanecem `UNVERIFIED` quanto à confiança: correspondência de identidade e integridade matemática CMS não demonstram cadeia ICP-Brasil ou revogação.

A aquisição de `SIGNING` confronta autor, clínica, versão e status. A tentativa é registrada antes da chamada ao provedor. Divergências não recebem estado `SIGNED` nem registro positivo de validação. Após iniciar a operação externa, falhas conservam `SIGNING` e referências de tentativa, sessão, resumo e transação quando disponíveis; nova chamada fica bloqueada até reconciliação. Mensagens e eventos de erro não incluem CPF, token ou texto clínico.

## Congelamento e compatibilidade PostgreSQL

A migração `20261028020000_signature_identity_guard.sql` congela identidade, conteúdo, versão e vínculos durante `SIGNING` e `SIGNED`, preserva o caminho do original após conclusão e impede reinício. A transição já admitida para `SUPERSEDED` foi conservada. O arquivo mantém um bloqueio deliberado de aplicação; apenas uma cópia temporária foi aplicada nos testes.

O ensaio utilizou PostgreSQL real em um único contêiner descartável, sem rede, portas ou volumes. O banco continha as relações clínicas necessárias, a tabela de assinaturas extraída da migração existente, o gatilho anterior `check_clinical_document_immutable` e a infraestrutura completa de numeração SNCR. Não foi ensaiada a cadeia inteira de migrações históricas do Supabase nem consultado o esquema de produção.

As alterações de autor, clínica, paciente, identificador, versão, texto, prescritor, data e consulta foram rejeitadas durante `SIGNING` e após `SIGNED`, inclusive em SQL privilegiado. A conclusão preservou versão e caminho original. A função do gatilho não concede execução ao frontend.

## Evidências e resultados

Os testes negativos iniciais reproduziram 11 falhas antes da correção. A execução anterior concluiu os 34 casos de identidade; esses casos foram preservados nesta finalização. Foram acrescentados e executados isoladamente dois casos de alteração de identidade durante o provedor, sem repetir os 34.

| Grupo | Testes distintos aprovados | Falhas finais |
|---|---:|---:|
| Autoria/identidade, incluindo sete tipos de documento e VIDaaS | 36 | 0 |
| Rota: campos forjados pelo frontend, proprietário e outra clínica | 3 | 0 |
| Congelamento de identidade/versão em PostgreSQL real | 3 | 0 |
| Integração SNCR com a nova migração e o gatilho anterior ativos | 32 | 0 |
| Regressão RCE, A/B/B2, PDF comum, Bird ID/PAdES e recuperação | 89 | 0 |
| **Total, sem contar repetições como novos casos** | **163** | **0** |

TypeScript sem cache incremental, lint direcionado, build de produção local e `git diff --check` passaram. As duas falhas históricas do CLI não reapareceram. Os 12 apontamentos gerais de lint anteriormente comprovados no commit anterior ao Lote 5B permanecem dívida técnica fora dos arquivos de implementação deste lote; não foram alterados para zerar o lint geral. Avisos de depreciação do Node e do decoder zbar não produziram falhas de teste.

## Arquivos do lote

- `lib/signature/document-signing-service.ts`
- `lib/signature/pades-service.ts`
- `lib/signature/signing-identity.ts`
- `lib/sncr/signing.ts`
- `supabase/migrations/20261028020000_signature_identity_guard.sql`
- `tests/document-signing-identity.test.mjs`
- `tests/document-signing-route.test.mjs`
- `tests/signature-identity-db.test.mjs`
- `tests/helpers/sncr-local-db.mjs`
- `tests/sncr-integrated-local.test.mjs`
- Este relatório.

## Limites e pendências

O endurecimento geral de RLS das tabelas Bird ID, o vínculo de navegador do OAuth e os demais achados do Lote 6A continuam fora deste lote. Os testes de frontend aqui demonstram que corpo e cabeçalhos não substituem a identidade autenticada da rota e que o congelamento documental resiste à escrita SQL; não certificam a segurança de todas as interfaces de banco da aplicação.

Cadeia, revogação, validade temporal e cobertura integral das revisões PAdES permanecem para o Lote 6F. As pendências de assinatura exigem reconciliação controlada; não foi criado mecanismo automático de nova assinatura. A futura aplicação da migração e o ensaio com certificado/provedor real exigem revisão e autorização próprias. Os bloqueios de numeração e emissão oficial SNCR permanecem ativos.

Não houve migração remota, commit, push, deploy, chamada real à Anvisa ou assinatura externa real. O Lote 6C não foi iniciado.
