begin;

alter table public.clinical_documents
 drop constraint clinical_documents_kind_check;
alter table public.clinical_documents
 add constraint clinical_documents_kind_check
 check(kind in ('Declaração de comparecimento','Atestado','Relatório','Receita','Pedido de exames','Encaminhamento','Documento livre'));

alter table public.document_ai_templates
 drop constraint document_ai_templates_kind_check;
alter table public.document_ai_templates
 add constraint document_ai_templates_kind_check
 check(kind in ('Declaração de comparecimento','Atestado','Relatório','Receita','Pedido de exames','Encaminhamento','Documento livre'));

commit;
