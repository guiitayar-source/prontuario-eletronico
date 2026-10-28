import { handle, HttpError, json, writeGuard, body } from '@/lib/supabase/server';
import { adminClient } from '@/lib/supabase/admin';
import { getNumberingContext, localSimulationEnabled, reserveDocument } from '@/lib/sncr/numbering';
export const dynamic = 'force-dynamic';
const medical = (role: string) => { if (!['owner','doctor'].includes(role)) throw new HttpError(403,'Acesso restrito à equipe médica.'); };
export const GET = handle(async (request,ctx) => {
  medical(ctx.role);
  const mode=localSimulationEnabled()?'local-simulation':'blocked';
  if (mode==='blocked') return json({mode,batches:[],message:'Emissão controlada bloqueada até autenticação oficial. Números históricos não autorizam emissão.'});
  const admin=adminClient(), id=new URL(request.url).searchParams.get('documentId');
  if (id) return json({mode,...await getNumberingContext(admin,{clinicId:ctx.clinic,userId:ctx.user},id)});
  const {data,error}=await admin.rpc('sncr_inventory',{p_clinic:ctx.clinic,p_prescriber:ctx.user});
  if (error) throw new HttpError(503,'Estoque indisponível. Nenhum número foi reservado.');
  return json({mode,batches:data});
});
export const POST = handle(async (request,ctx) => {
  writeGuard(request,'x-signature-action'); medical(ctx.role);
  const payload=await body(request);
  if (payload.action && payload.action!=='reserve') throw new HttpError(422,'Cadastro manual e alocação legada bloqueados. Utilize reserva vinculada ao documento.');
  if (typeof payload.documentId!=='string' || !payload.documentId.trim()) throw new HttpError(422,'Salve e informe o documento antes de reservar.');
  return json({mode:'local-simulation',...await reserveDocument(adminClient(),{clinicId:ctx.clinic,userId:ctx.user},payload.documentId)});
});
