import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createClient} from '@supabase/supabase-js';
import {documents} from '../lib/supabase/documents.ts';
import {documentPdf} from '../lib/document-pdf.ts';
import {PDFDocument} from 'pdf-lib';
const raw=execFileSync('node_modules/.bin/supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});const s=JSON.parse(raw.slice(raw.indexOf('{')));assert.match(s.API_URL,/^http:\/\/127\.0\.0\.1:/);
process.env.NEXT_PUBLIC_SUPABASE_URL=s.API_URL;process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=s.PUBLISHABLE_KEY;
const options={auth:{persistSession:false,autoRefreshToken:false}},admin=createClient(s.API_URL,s.SECRET_KEY,options),users=[];let c;
async function user(){const email=`documents-${crypto.randomUUID()}@example.invalid`,password='Local_Test_123456789';const u=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.ifError(u.error);users.push(u.data.user.id);const db=createClient(s.API_URL,s.PUBLISHABLE_KEY,options);const login=await db.auth.signInWithPassword({email,password});assert.ifError(login.error);return {db,id:u.data.user.id,token:login.data.session.access_token};}
async function call(u,d,query='patientId=synthetic-doc'){return documents(new Request('http://test.local/api/documents?'+query,{method:d?'POST':'GET',headers:{Authorization:`Bearer ${u.token}`,'X-Clinic-Id':c,'X-Document-Action':'1',Origin:'http://test.local'},body:d?JSON.stringify(d):undefined}));}
try{
 const doctor=await user(),secretary=await user(),outsider=await user();const cr=await doctor.db.rpc('create_clinic',{clinic_name:'Documentos teste'});assert.ifError(cr.error);c=cr.data;
 assert.ifError((await admin.from('clinic_members').insert({clinic_id:c,user_id:secretary.id,role:'secretary'})).error);
 assert.ifError((await admin.from('patients').insert([{clinic_id:c,id:'synthetic-doc',name:'Paciente Sintético'},{clinic_id:c,id:'other-doc',name:'Outro Sintético'}])).error);
 const visit=crypto.randomUUID();assert.ifError((await doctor.db.rpc('consultation_write',{c,action:'create',d:{id:visit,patient_id:'other-doc'}})).error);
 const d={id:crypto.randomUUID(),patient_id:'synthetic-doc',consultation_id:null,kind:'Relatório',text:'Evolução, atenção e avaliação clínica.',physician_name:'Médico Fictício',physician_registration:'CRM/XX 0000',document_date:'2026-09-12',version:0};
 assert.equal((await call(secretary,d)).status,403);assert.equal((await call(outsider,d)).status,403);
 assert.equal((await call(doctor,{...d,consultation_id:visit})).status,409);
 let r=await call(doctor,d);assert.equal(r.status,200);let saved=(await r.json()).document;assert.equal(saved.patient_name,'Paciente Sintético');assert.equal(saved.author_id,doctor.id);
 assert.equal((await call(doctor,d)).status,200);assert.equal((await secretary.db.from('clinical_documents').select('*')).data.length,0);
 assert.ok((await doctor.db.from('clinical_documents').update({text:'bypass'}).eq('id',d.id)).error);
 const concurrent=await Promise.all([call(doctor,{...d,version:1,text:'Edição A'}),call(doctor,{...d,version:1,text:'Edição B'})]);assert.deepEqual(concurrent.map(x=>x.status).sort(),[200,409]);
 const copy={...d,id:crypto.randomUUID()};assert.equal((await call(doctor,copy)).status,200);const list=await (await call(doctor)).json();assert.equal(list.documents.length,2);
 r=await call(doctor,null,`action=pdf&patientId=synthetic-doc&id=${d.id}`);assert.equal(r.status,200);assert.match(r.headers.get('content-type'),/pdf/);assert.equal((await PDFDocument.load(await r.arrayBuffer())).getPageCount(),1);
 assert.equal((await call(secretary,null,`action=pdf&patientId=synthetic-doc&id=${d.id}`)).status,403);
 assert.equal((await call(doctor,null,`action=pdf&patientId=other-doc&id=${d.id}`)).status,404);
 const long=await documentPdf({...d,patient_name:'Paciente fictício',text:('Parágrafo com acentuação e revisão.\n').repeat(120)+'X'.repeat(500)});assert.ok((await PDFDocument.load(long)).getPageCount()>2);
 await assert.rejects(()=>documentPdf({...d,patient_name:'Paciente',text:'Emoji 🧪'}),/caractere/);
 assert.ok((await admin.from('audit_events').select('id').eq('clinic_id',c).eq('entity_type','clinical_documents')).data.length>=3);
 console.log('PASS: salvar/reabrir/duplicar, vínculo de paciente, RLS, concorrência, auditoria, PDF autorizado, paginação e caracteres.');
}finally{
 if(c)for(const table of ['clinical_documents','document_profiles','consultations','audit_events','patients','clinic_members','clinics'])assert.ifError((await admin.from(table).delete().eq(table==='clinics'?'id':'clinic_id',c)).error);
 for(const id of users)assert.ifError((await admin.auth.admin.deleteUser(id)).error);
}
