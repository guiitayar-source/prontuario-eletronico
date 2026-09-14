# Preparação para uso real — PsyWrite

Estado: implementação técnica em validação, **sem liberação para dados reais**. Este roteiro não é certificação legal, assinatura digital ou garantia de conformidade.

## MFA e recuperação de acesso

1. No PsyWrite, abra **Segurança · MFA → Configurar autenticador**.
2. Leia o QR code no seu aplicativo autenticador e confirme o código. O QR é um segredo individual; não envie ao chat ou à equipe.
3. Como proprietário, clique em **Exigir MFA para toda a clínica**. A ação exige uma sessão com segundo fator confirmado e gera auditoria.
4. Cada médico/secretária configura seu próprio autenticador ao entrar. Faça o teste de sair e entrar novamente, inclusive no celular de captura.
5. Antes de dados reais, valide entrega dos e-mails de recuperação e registre quem administra a conta Supabase. A recuperação por perda de TOTP exige verificação de identidade fora do sistema e intervenção do administrador do projeto; o aplicativo não oferece um atalho que dispense o segundo fator.

O banco protege SELECT, gravações por RPC e Storage com o nível da sessão (`aal2`). Mesmo antes de exigir MFA da clínica inteira, uma conta com fator verificado passa a precisar dele. Nome da clínica e o próprio vínculo permanecem consultáveis com senha para permitir a configuração do MFA. Contas do painel Supabase/Vercel têm MFA separado, que também deve ser ativado pelo titular.

## Perfis e auditoria

| Ação | Proprietário | Médico | Secretária |
|---|---|---|---|
| Cadastro e agenda | Sim | Sim | Sim |
| Receber, visualizar e classificar anexos | Sim | Sim | Sim |
| Arquivar/restaurar anexos | Sim | Sim | Não |
| Evoluções, adendos, diagnósticos, medicamentos, alergias | Sim | Sim | Não |
| Documentos clínicos, PDF, importação e exportação FHIR | Sim | Sim | Não |
| Consultar auditoria | Sim | Sim | Não |
| Gerenciar equipe e exigir MFA | Sim | Não | Não |

Anexos podem conter informação clínica: o acesso da secretária a eles é uma decisão explícita do fluxo atual, não isolamento total de dados de saúde. Use contas individuais e retire vínculos quando alguém deixar a equipe. A alteração de papel não transfere autoria; consultas finalizadas recebem adendos.

**Auditoria**, no topo, mostra os últimos 100 eventos com conta, operação, entidade e horário. Alterações persistidas, importações, reversões, exigência de MFA e solicitações de exportação são registradas. `export_snapshot` registra a preparação do conjunto de dados, não a conclusão do download. Não inclui conteúdo clínico no evento. A lista não cobre toda leitura direta do banco; logs do provedor e eventual solução de auditoria de leituras precisam integrar a revisão operacional. A conta administrativa do Supabase continua privilegiada; isso não é um registro externamente imutável.

## Retenção proposta

- Nenhuma exclusão física de pacientes, consultas, documentos ou anexos pelo aplicativo. Anexos são arquivados e recuperáveis; arquivos aceitos não podem ser removidos diretamente por usuários do aplicativo. Envios ainda não confirmados podem ser descartados.
- Importações desfeitas ficam retiradas do histórico ativo e mantêm rastreabilidade. Prévia não confirmada é temporária e não constitui prontuário incorporado.
- Referência inicial: guarda mínima de 20 anos a partir do último registro, com revisão pelo responsável antes de qualquer eliminação. Não há expurgo automático nem autorização automática ao completar o prazo. Solicitações legais, litígios e outras obrigações podem impedir descarte.
- A política de auditoria proposta acompanha a retenção do prontuário associado. O sistema ainda não executa expurgo automático de eventos.
- Proposta para **cópias de recuperação**, distinta da guarda do prontuário: diárias por 30 dias e mensais por 12 meses, com revisão de capacidade e necessidade. Nenhuma rotação ou tarefa recorrente foi ativada automaticamente.

A [Lei 13.787/2018, art. 6](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13787.htm) é a referência para revisar a política de guarda. A decisão final, responsabilidades, finalidade do tratamento e procedimentos de acesso devem ser formalizados pela clínica.

## Backup criptografado e ensaio de restauração

O backup inclui dump consistente dos schemas `public`, `auth`, `storage`, `extensions` e os **bytes de todos os anexos confirmados, inclusive arquivados**. O inventário é lido do dump restaurado, preservando o mesmo ponto do banco; anexos aceitos são imutáveis no aplicativo. Uploads pendentes não fazem parte do conjunto clínico recuperável.

O pacote `.psybackup` usa AES-256-GCM, chave derivada da senha com scrypt e hashes SHA-256. Contém dados clínicos e credenciais de contas/fatores MFA do banco; trate a cópia como sensível. Nunca grave a senha no repositório nem junto do backup. Temporários têm diretório privado e são removidos ao final; antes de dados reais, use disco/volume temporário criptografado. Remover um arquivo não garante apagamento físico do SSD.

Requisitos: Node, Docker e Supabase local iniciado. O container local é `supabase_db_prototipo` (configurável por `PSYWRITE_LOCAL_DB_CONTAINER`). A versão do PostgreSQL local deve ser compatível com a origem. O comando `verify` **nunca sobrescreve um banco existente**: cria banco e bucket privados descartáveis, restaura o dump com suas permissões, confere tabelas, contagens e hashes, envia e baixa os anexos pelo Storage local e limpa os temporários.

No terminal, dentro da pasta do projeto:

**Destino escolhido pelo titular:** `/home/Guilherme/Backups/PsyWrite`, no disco do Arch. A pasta foi criada com permissão privada. Não há backup da origem hospedada feito ainda. Para iniciar o assistente (solicita senhas ocultas no terminal): `bash scripts/backup-interactive.sh`. A segunda cópia independente fica pendente.

Para testar os comandos manualmente:

```bash
read -rsp 'Senha do backup (mínimo 16 caracteres): ' PSYWRITE_BACKUP_PASSPHRASE
export PSYWRITE_BACKUP_PASSPHRASE
npm run backup:create -- --local --file /caminho/privado/copia.psybackup
npm run backup:verify -- --file /caminho/privado/copia.psybackup
unset PSYWRITE_BACKUP_PASSPHRASE
```

`--local` copia **somente os dados locais de teste**. Para a origem hospedada, use `--remote` e forneça `PSYWRITE_DB_URL` pelo terminal com a conexão direta do projeto (a senha não vai no comando nem no chat). `.env.local` fornece URL e credencial de servidor do Supabase. A referência da conexão deve coincidir com o projeto do aplicativo. O script não cria senha do banco, não configura rede IPv6/pooler e não altera a origem.

```bash
read -rsp 'Conexão PostgreSQL direta: ' PSYWRITE_DB_URL
export PSYWRITE_DB_URL
npm run backup:create -- --remote --file /caminho/privado/copia.psybackup
unset PSYWRITE_DB_URL
```

Depois copie o `.psybackup` para o armazenamento privado externo e rode `backup:verify` sobre **essa cópia**. A senha precisa continuar disponível no ambiente durante a verificação. Uma cópia no mesmo disco não cobre perda/falha do computador.

Os [backups do Supabase não incluem os bytes do Storage](https://supabase.com/docs/guides/platform/backups); por isso o script os inclui separadamente. Configurações de SMTP, DNS, Vercel, segredos do projeto, código/fontes e papéis personalizados de infraestrutura não são recriados por esse dump. Mantenha código e inventário de configurações em local privado. Uma recuperação para outro projeto hospedado exige configurar esses serviços e repetir login/MFA/perfis/consulta/anexos antes de trocar o endereço do aplicativo. Nenhuma substituição do projeto em uso é automatizada.

## Exportação FHIR R4

No prontuário: **Exportar FHIR → Baixar JSON**. O Bundle é `collection` e usa referências internas estáveis por clínica. Exporta somente o paciente selecionado e dados salvos.

| Recurso | Origem e significado |
|---|---|
| Patient | Identificação, contatos e endereço; complemento cadastral em DocumentReference |
| Encounter | Consultas locais, texto livre e adendos; período usa registro/finalização locais |
| Condition | Diagnósticos/CID, hipóteses e condições resolvidas; sem inventar data de início |
| MedicationRequest | Lista de medicamentos como `intent=plan`, sem afirmar ordem prescrita ou assinatura |
| DocumentReference | Documentos preliminares, anexos, alergias textuais e histórico importado com origem |

Texto de gênero não é convertido por inferência para sexo administrativo. Documentos em rascunho continuam `preliminary`. Receita em texto livre permanece DocumentReference; não se tenta deduzir doses para criar ordens. Histórico importado não é promovido a diagnóstico atual. Anexos arquivados e lotes retirados não entram na exportação ativa, mas permanecem no backup.

Há opção de incorporar anexos até **2 MB somados**, respeitando limite de 3,5 MB do JSON final. Sem ela, são URLs protegidas que exigem Bearer e `X-Clinic-Id`; não são links públicos nem contêm tokens. A aplicação destinatária precisa implementar esse acesso ou receber os arquivos separadamente. O endpoint devolve redirecionamento para URL de 60 segundos. Se um limite ou download falhar, a exportação é interrompida, sem entrega silenciosa parcial.

Validação: esquema JSON oficial R4 e testes de referências, recursos, permissões e semântica. Isso não equivale à validação completa de todos os invariantes FHIR/FHIRPath ou à homologação com um sistema de destino. Referências: [FHIR R4 downloads](https://hl7.org/fhir/R4/downloads.html), [MedicationRequest](https://hl7.org/fhir/R4/medicationrequest.html), [DocumentReference](https://hl7.org/fhir/R4/documentreference.html).

## Pendências antes de qualquer dado real

- Ativação efetiva do TOTP pelo titular e exigência para a clínica; teste de cada conta e recuperação.
- Backup da origem hospedada com senha escolhida pelo titular, segunda cópia independente e ensaio dessa cópia. O teste automatizado usa somente dados sintéticos locais.
- Aprovação da política de retenção, acesso administrativo a anexos e responsabilidades de auditoria/privacidade.
- Definir rotina e responsável pelos backups, monitorar falhas, medir duração de restauração e perda de dados tolerável. O script não é um serviço agendado.
- Revisar ambientes, e-mails, contas privilegiadas e logs de leitura; corrigir qualquer lacuna apontada nessa revisão. Validar portabilidade no sistema destinatário quando definido.
