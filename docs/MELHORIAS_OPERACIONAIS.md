# Revisão clínica, auditoria e recuperação

## Entrega local

- Medicamentos: ausência de itens não significa ausência de uso. O titular/médico confirma a lista ou que o paciente nega uso. Toda alteração na lista invalida a revisão anterior; a data fica preservada como referência histórica. Confirmar ausência exige suspender individualmente os itens ativos.
- Evolução: horário de salvamento confirmado pelo servidor, cópia explícita do texto e comparação após conflito. A versão local fica no editor. Sobrescrever um rascunho remoto exige revisão explícita e ainda passa pelo controle otimista de versão; registros finalizados/assinados continuam protegidos.
- Auditoria: filtros no servidor, páginas por cursor de 100 eventos, período inclusivo em UTC−03, conta por ID, paciente por nome ou ID e operação exata. O vínculo histórico com entidades já removidas pode não ser recuperável. Nenhum conteúdo clínico é adicionado aos eventos.
- Backup: painel exclusivo do titular em Ajustes. O relatório automático usa as clínicas extraídas do dump restaurado e só é produzido depois da conferência de banco e Storage. Não contém arquivos clínicos, caminhos, senhas ou URI do banco. A cópia externa é uma declaração identificada do titular, vinculada a um backup verificado; não é validação automática do destino.

## Ativação pendente em produção

Revisar e aplicar, com autorização do titular, as novas migrações:

1. `20261104010000_medication_review.sql`
2. `20261104011000_audit_search.sql`
3. `20261104012000_backup_status.sql`

Antes de aplicar, conferir toda a lista de migrações pendentes e executar o dry-run; não aplicar indiscriminadamente migrações anteriores de assinatura que ainda estejam em revisão. A migração de auditoria adiciona índices e preenche vínculos históricos: avaliar duração e volume antes de executar em produção.

Sem as migrações, o registro de revisão e o painel de backup informam indisponibilidade. A nova pesquisa da auditoria solicita a atualização do banco. Os demais fluxos existentes não dependem desses registros novos.

Após a migração e revisão do código, o titular pode adicionar `PSYWRITE_BACKUP_REPORT=1` ao arquivo privado de configuração da rotina. Isso ativa somente o envio de metadados de verificações futuras. A opção fica desligada por padrão. Não editar nem enviar senhas pelo chat.

O relatório usa a chave de serviço já empregada pelo backup e escreve no mesmo Supabase. Falha na comunicação é reportada como falha da rotina, mesmo quando a cópia já foi verificada. A cópia não é apagada por falha no relatório. Não há importação retroativa de “sucesso” baseada na existência de arquivos.

Os avisos adotam 36 horas desde o início dos dados copiados e 7 dias para a cópia externa; são critérios operacionais iniciais, não política de retenção nem garantia. A duração exibida mede restauração e conferência em ambiente descartável, não o tempo completo de recuperação do serviço.

## Testes e publicação

`npm test` inclui testes de filtros/relatórios e migrações em PGlite, com dados sintéticos e papéis distintos. `npm run test:browser` usa Playwright sobre a interface real, com Auth/API simulados e falhas controladas; não valida Bird ID, Supabase hospedado ou integração completa em produção. O servidor de testes usa uma cópia temporária sem arquivos `.env` e URLs sintéticas locais, sem reutilizar servidores existentes. Para navegador local instalado: `PSYWRITE_TEST_BROWSER=/caminho/do/chrome npm run test:browser`.

O workflow adiciona o job `Fluxos no navegador (dados sintéticos)`. Para que os testes bloqueiem a integração na `main`, a regra de proteção do GitHub precisa exigir os checks `verificar` e `Fluxos no navegador (dados sintéticos)` e impedir push direto que contorne a regra. Na consulta de 03/11/2026, a API do GitHub informou `protected: false` para `main`, sem checks obrigatórios e sem rulesets. A configuração remota é uma etapa separada. O workflow, por si só, não impede a publicação independente da Vercel.

Validar posteriormente o fluxo integrado em ambiente de homologação e a restauração real aprovada pelo titular. Nenhuma migração, publicação, restauração ou cópia externa é executada por estes testes.

## Validação desta entrega

- `npm test`: 127 testes aprovados. Os testes de subprocesso do verificador de assinatura precisaram rodar fora do sandbox local; continuam usando somente arquivos sintéticos.
- `npm run test:browser`: 7 cenários aprovados em Chrome, com API/Auth simulados.
- TypeScript, lint, build de produção e sintaxe do shell aprovados. Cinco imports não utilizados do auxiliar de auditoria 6F.2C foram removidos para liberar o lint, sem alterar seu comportamento.
- Inspeção operacional somente de leitura: 18 arquivos `.psybackup`, o mais recente modificado em 30/10/2026; timer ativo, último processo com `ExecMainStatus=1`. A existência dos arquivos não comprova integridade, atualidade nem cópia externa. Nenhum backup real foi aberto ou restaurado nesta entrega.
- As migrações novas foram testadas em PGlite com esquema sintético. Não foram aplicadas ao Supabase hospedado. Relatório automático e declaração de cópia externa não foram enviados a produção.
