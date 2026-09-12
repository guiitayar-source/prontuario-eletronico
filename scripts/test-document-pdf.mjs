import {writeFileSync,mkdirSync} from 'node:fs';
import {documentPdf} from '../lib/document-pdf.ts';
mkdirSync('work/pdf-check',{recursive:true});
writeFileSync('work/pdf-check/sample.pdf',await documentPdf({kind:'Relatório',patient_name:'Paciente fictício de teste',physician_name:'Médico fictício - Psiquiatra',physician_registration:'CRM/XX 0000',document_date:'2026-09-12',text:'Finalidade: teste de paginação e acentuação.\n\n'+('Acompanhamento clínico: atenção, memória e evolução. Este conteúdo é inteiramente fictício e serve para conferir a legibilidade do documento.\n\n').repeat(28)}));
