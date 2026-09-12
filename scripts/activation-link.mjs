// Generates an activation link without sending email. Do not persist its output.
import { createClient } from '@supabase/supabase-js';
const [email,origin] = process.argv.slice(2);
if(!email || !origin) throw new Error('Informe e-mail e origem.');
const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const {data,error}=await db.auth.admin.generateLink({type:'recovery',email});
if(error) throw new Error('Não foi possível gerar a ativação.');
console.log(JSON.stringify({url:`${origin}/?activation=${encodeURIComponent(data.properties.hashed_token)}`}));
