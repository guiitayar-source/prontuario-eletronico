# PsyWrite — protótipo de prontuário

Interface de prontuário com texto livre, cadastro de pacientes, agenda e recebimento de anexos pelo celular. Use somente dados fictícios nesta etapa.

## Executar

Configure `.env.local` conforme `.env.example` e execute:

```sh
npm ci
npm run dev
```

A aplicação atual usa Next.js, Supabase Auth, PostgreSQL e Storage privado. Consulte [SUPABASE_MIGRATION.md](./SUPABASE_MIGRATION.md) para configuração, migração, publicação e limitações.

## Funcionalidades

- Exames estruturados com biblioteca pesquisável, sinônimos, modelos personalizados, preenchimento manual, histórico longitudinal, correções e gráficos por parâmetro. Consulte [EXAMES.md](./EXAMES.md) para ativação e a estrutura de extração futura.
- Importação LGPD JSON e FHIR R4 com prévia, vínculo explícito, detecção de repetidos, histórico de origem e reversão de lote com auditoria.
- Cadastro, pesquisa e edição de pacientes, com controle de versão.
- Agenda com criação, edição, cancelamento e acesso à consulta.
- Evolução em texto livre com salvamento automático no Supabase, controle de versão e histórico por paciente.
- Contexto clínico longitudinal com diagnósticos/CID, medicamentos e alergias, disponível no painel lateral da consulta.
- Finalização imutável com autor e horário, correções por adendos e vínculo opcional à agenda.
- Captura de fotos e PDFs por QR, revisão, classificação, arquivamento e restauração de anexos.
- Login individual, vínculo à clínica e auditoria das alterações persistidas.
- Exportação FHIR R4 por paciente, MFA com proteção também no banco e backup criptografado com ensaio local de restauração. Consulte [OPERACAO_SEGURA.md](./OPERACAO_SEGURA.md) para ativação, limites e pendências antes de dados reais.

Evoluções, adendos e documentos clínicos são acessíveis somente a médicos e proprietários da clínica. A secretária mantém acesso ao cadastro, agenda e anexos. Documentos possuem modelos editáveis, histórico de rascunhos, duplicação e PDF com fontes incorporadas. O PDF corresponde à versão salva e permanece identificado como rascunho sem assinatura. Não há assinatura digital, OCR ou Anamnesator conectado. Rascunhos antigos do navegador não são importados automaticamente.

## Verificação

```sh
npm exec tsc -- --noEmit
npm run build
npm run test:supabase
npm run test:consultations
npm run test:documents
npm run test:team
npm run test:clinical-context
npm run test:imports
npm run test:readiness
npm run test:exams
```

Os testes de integração Supabase exigem a instância local iniciada e usam contas sintéticas. `test:exams` usa PostgreSQL embarcado e não exige Docker. Os testes SQLite/D1 e arquivos em `drizzle/` preservam a implementação anterior para referência. Os antigos testes HTTP D1 não se aplicam ao servidor Next.js atual.

A aplicação está hospedada na Vercel em https://psywrite.vercel.app. A demonstração anterior ainda usa Sites e D1/R2; um anexo legado permanece pendente de transferência. Não publique esta versão Next.js pelo fluxo antigo de Sites.

## Importar prontuários

Em **Pacientes → Importar prontuários**, escolha JSON LGPD ou Bundle FHIR R4 (collection, document ou searchset). Use sempre o mesmo nome de sistema de origem. A prévia mostra dados cadastrais, registros, avisos e possíveis duplicados; CPF e nome normalizado identificam candidatos. Revise o destino e confirme. Um cadastro existente nunca é sobrescrito. Limites: 2 MB, 30 pacientes e 500 registros por arquivo.

Evoluções, diagnósticos, medicamentos, alergias, receitas, agendamentos e documentos textuais ficam na aba **Histórico importado**. Não são transformados automaticamente em receitas novas, consultas assinadas, medicamentos atuais nem compromissos ativos. As datas do atendimento, de criação na origem e de importação são distintas. Datas parciais/sem fuso são sinalizadas e preservadas como texto, sem inventar um instante. Encounter pode não conter uma evolução: só o texto efetivamente presente é importado.

Reenvios com os mesmos IDs e conteúdo são ignorados; o mesmo ID com conteúdo diferente bloqueia a transação até revisão. A identificação considera clínica, nome da origem, formato, paciente, tipo e ID de origem. Não há deduplicação automática entre exportações LGPD e FHIR. Sem ID, usa-se o conteúdo e um aviso é exibido. Prévia vale por uma hora; cancelar remove o conteúdo preparado. Prévias expiradas são limpas na próxima geração de prévia da clínica.

**Desfazer lote** retira seus registros do histórico ativo, mantendo a auditoria, o cadastro do paciente e dados locais. O médico que importou ou o proprietário pode desfazer. É possível importar novamente depois. Não há exclusão física de prontuários pelo importador.

Arquivos binários, URLs, tokens operacionais e consentimentos da origem não são transferidos. Campos não suportados são sinalizados por avisos; conserve o arquivo original. PDFs e fotos devem ser anexados separadamente. Os exemplos em `public/examples/` são inteiramente fictícios; os arquivos particulares do usuário não fazem parte do repositório ou do deploy.

Referências de formato: [Bundle FHIR R4](https://hl7.org/fhir/R4/bundle.html), [Encounter](https://hl7.org/fhir/R4/encounter.html), [MedicationRequest](https://hl7.org/fhir/R4/medicationrequest.html). O importador implementa um subconjunto explícito; não é um validador FHIR completo.
