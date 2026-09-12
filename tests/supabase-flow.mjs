import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
import { patients } from '../lib/supabase/patients.ts';
import { appointments } from '../lib/supabase/appointments.ts';
import { capture } from '../lib/supabase/capture.ts';
const raw = execFileSync('node_modules/.bin/supabase',['status','-o','json'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
const status=JSON.parse(raw.slice(raw.indexOf('{')));
assert.match(status.API_URL,/^http:\/\/127\.0\.0\.1:/);
process.env.NEXT_PUBLIC_SUPABASE_URL=status.API_URL;
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=status.PUBLISHABLE_KEY;
process.env.SUPABASE_SECRET_KEY=status.SECRET_KEY;
const options={auth:{persistSession:false,autoRefreshToken:false}};
const admin=createClient(status.API_URL,status.SECRET_KEY,options);
const ids=[], clinics=[], objects=[];
const password='Local_Test_123456789';
let count=0;
async function user() {
 const email=`flow-${crypto.randomUUID()}@example.invalid`;
 const {data,error}=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.ifError(error);ids.push(data.user.id);
 const db=createClient(status.API_URL,status.PUBLISHABLE_KEY,options);
 const login=await db.auth.signInWithPassword({email,password});assert.ifError(login.error);
 return {id:data.user.id,db,token:login.data.session.access_token};
}
async function call(fn, who, clinic, url, data, token) {
 const headers={Authorization:`Bearer ${who.token}`,'X-Clinic-Id':clinic,origin:'http://test.local','X-Patient-Action':'1','X-Appointment-Action':'1','X-Capture-Action':'1','Content-Type':'application/json'};
 if(token) headers['X-Device-Token']=token;
 const res=await fn(new Request(`http://test.local${url}`,{method:data===undefined?'GET':'POST',headers,body:data===undefined?undefined:JSON.stringify(data)}));
 const value=await res.json();return {status:res.status,value};
}
function ok(r, expected=200) {assert.equal(r.status,expected,JSON.stringify(r.value));count++;return r.value;}
try {
 const owner=await user(), other=await user(), secretary=await user();
 const created=await owner.db.rpc('create_clinic',{clinic_name:'Teste fictício'});assert.ifError(created.error);const c=created.data;clinics.push(c);
 const pid=crypto.randomUUID();
 ok(await call(patients,owner,c,'/api/patients?action=create',{id:pid,name:'Paciente Fictício',phone:'11999990000'}),201);
 const p=ok(await call(patients,owner,c,`/api/patients?id=${pid}`)).patient;
 ok(await call(patients,owner,c,'/api/patients?action=update',{...p,name:'Paciente Atualizado'}));
 ok(await call(patients,owner,c,'/api/patients?action=update',{...p,name:'Conflito'}),409);
 ok(await call(patients,other,c,`/api/patients?id=${pid}`),403);
 const unauth=await patients(new Request('http://test.local/api/patients',{headers:{'oai-authenticated-user-id':owner.id}}));assert.equal(unauth.status,401);count++;
 assert.ifError((await admin.from('clinic_members').insert({clinic_id:c,user_id:secretary.id,role:'secretary'})).error);
 ok(await call(patients,secretary,c,`/api/patients?id=${pid}`));
 const aid=crypto.randomUUID(), time=Date.parse('2026-09-12T23:30:00-03:00');
 ok(await call(appointments,secretary,c,'/api/appointments?action=create',{id:aid,patient_id:pid,starts_at:time,ends_at:time+1200000,modality:'presencial',admin_notes:''}),201);
 assert.equal(ok(await call(appointments,owner,c,'/api/appointments?day=2026-09-12')).appointments.length,1);
 assert.equal(ok(await call(appointments,owner,c,'/api/appointments?day=2026-09-13')).appointments.length,0);
 const pair=ok(await call(capture,owner,c,'/api/capture?action=connect',{patientId:pid,category:'exam'}));
 ok(await call(capture,owner,c,`/api/capture?action=mobile&id=${pair.id}`,undefined,'bad'),403);
 ok(await call(capture,owner,c,`/api/capture?action=mobile&id=${pair.id}`,undefined,pair.token));
 // 6 MB exceeds Vercel's function payload limit, but goes directly to Storage.
 const bytes=new Uint8Array(6*1024*1024);bytes.set(new TextEncoder().encode('%PDF-1.4\n'));
 const d={requestId:pair.request.id,uploadId:crypto.randomUUID(),name:'ficticio.pdf',mime:'application/pdf',size:bytes.length};
 const lease=ok(await call(capture,owner,c,'/api/capture?action=prepare',d,pair.token));objects.push(lease.path);
 const illegal=await other.db.storage.from('clinical-files').upload(lease.path,bytes,{contentType:d.mime});assert.ok(illegal.error);count++;
 assert.ifError((await owner.db.storage.from('clinical-files').upload(lease.path,bytes,{contentType:d.mime})).error);
 const bypass=await owner.db.rpc('capture_command',{c,action:'commit',d:{...d,path:lease.path},device_token:pair.token});assert.ok(bypass.error);count++;
 ok(await call(capture,owner,c,'/api/capture?action=commit',{...d,path:lease.path},pair.token),201);
 ok(await call(capture,owner,c,'/api/capture?action=commit',{...d,path:lease.path},pair.token));
 const files=ok(await call(capture,owner,c,`/api/capture?action=list&patientId=${pid}`));assert.equal(files.attachments.length,1);
 const ticket=ok(await call(capture,owner,c,`/api/capture?action=file&id=${d.uploadId}&patientId=${pid}`));
 const download=await fetch(ticket.url);assert.equal(download.status,200);assert.equal((await download.arrayBuffer()).byteLength,bytes.length);count++;
 const bad={...d,uploadId:crypto.randomUUID(),size:5,name:'falso.pdf'};
 const badLease=ok(await call(capture,owner,c,'/api/capture?action=prepare',bad,pair.token));objects.push(badLease.path);
 assert.ifError((await owner.db.storage.from('clinical-files').upload(badLease.path,new Uint8Array([1,2,3,4,5]),{contentType:bad.mime})).error);
 ok(await call(capture,owner,c,'/api/capture?action=commit',{...bad,path:badLease.path},pair.token),415);
 ok(await call(capture,owner,c,'/api/capture?action=complete',{id:pair.request.id},pair.token));
 ok(await call(capture,owner,c,'/api/capture?action=prepare',{...d,uploadId:crypto.randomUUID()},pair.token),409);
 ok(await call(capture,owner,c,'/api/capture?action=delete',{id:d.uploadId,patientId:pid}));
 assert.equal(ok(await call(capture,owner,c,`/api/capture?action=list&patientId=${pid}`)).attachments.length,0);
 const audit=await owner.db.from('audit_events').select('id').eq('clinic_id',c);assert.ifError(audit.error);assert.ok(audit.data.length>=4);count++;
 const forged=await secretary.db.from('audit_events').insert({clinic_id:c,actor_id:secretary.id,action:'fake',entity_type:'patient',entity_id:pid});assert.ok(forged.error);count++;
 const anonymous=createClient(status.API_URL,status.PUBLISHABLE_KEY,options);
 const leak=await anonymous.from('patients').select('id');assert.equal(leak.data?.length||0,0);count++;
 console.log(`${count} verificações: autenticação, isolamento, versões, fuso da agenda, upload 6 MB, validação, repetição, auditoria e exclusão.`);
} finally {
 if(objects.length) assert.ifError((await admin.storage.from('clinical-files').remove(objects)).error);
 for(const c of clinics) {
  for(const table of ['audit_events','pending_uploads','attachments','capture_requests','device_sessions','appointments','patients','clinic_members','clinics']) {
   const result=await admin.from(table).delete().eq(table==='clinics'?'id':'clinic_id',c);assert.ifError(result.error);
  }
 }
 for(const id of ids) assert.ifError((await admin.auth.admin.deleteUser(id)).error);
}
