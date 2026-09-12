// Run with: node --env-file=.env.local scripts/import-sites.mjs <email> <export.json>
// The input is a local, ignored export from the authenticated Sites reader.
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';
const [email, source] = process.argv.slice(2);
if (!email || !source) throw new Error('Informe o e-mail e o arquivo exportado.');
const bundle = JSON.parse(fs.readFileSync(source,'utf8'));
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
function check(r) { if(r.error) throw new Error(r.error.code || 'Falha no Supabase'); return r.data; }
const users=check(await db.auth.admin.listUsers({perPage:1000})).users;
let user=users.find(u=>u.email===email);
if(!user) user=check(await db.auth.admin.createUser({email,email_confirm:true})).user;
let member=check(await db.from('clinic_members').select('clinic_id').eq('user_id',user.id).eq('role','owner').maybeSingle());
if(!member) {
 const clinic=check(await db.from('clinics').insert({name:'PsyWrite — Consultório'}).select('id').single());
 check(await db.from('clinic_members').insert({clinic_id:clinic.id,user_id:user.id,role:'owner'}));
 member={clinic_id:clinic.id};
}
const c=member.clinic_id;
const iso=ms=>new Date(ms).toISOString();
for(const original of bundle.patients) {
 const {owner,...p}=original;
 const existing=check(await db.from('patients').select('id').eq('clinic_id',c).eq('id',p.id).maybeSingle());
 if(!existing) check(await db.from('patients').insert({...p,clinic_id:c,created_at:iso(p.created_at),updated_at:iso(p.updated_at)}));
}
for(const original of bundle.appointments) {
 const {owner,...a}=original;
 const existing=check(await db.from('appointments').select('id').eq('clinic_id',c).eq('id',a.id).maybeSingle());
 if(!existing) check(await db.from('appointments').insert({...a,clinic_id:c,starts_at:iso(a.starts_at),ends_at:iso(a.ends_at),created_at:iso(a.created_at),updated_at:iso(a.updated_at)}));
}
console.log(JSON.stringify({userId:user.id,clinicId:c,patients:bundle.patients.length,appointments:bundle.appointments.length,pendingFiles:bundle.attachments.length}));
