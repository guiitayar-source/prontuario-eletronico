import { handle, HttpError, json } from '@/lib/supabase/server';
import {
  ICD11_RELEASE,
  searchCid10,
  searchIcd11,
  suggestIcd11,
} from '@/lib/cid/catalog';
export const dynamic = 'force-dynamic';

// GET ?q=texto&system=cid10|icd11  → busca no catálogo
// GET ?suggest=F32.1               → sugestões CID-11 para um CID-10
export const GET = handle(async (request, { role }) => {
  if (!['owner', 'doctor'].includes(role))
    throw new HttpError(403, 'Diagnósticos são exclusivos da equipe médica.');
  const url = new URL(request.url);
  const suggest = url.searchParams.get('suggest');
  if (suggest) {
    if (suggest.length > 10) throw new HttpError(400, 'Código inválido.');
    return json({ release: ICD11_RELEASE, suggestions: suggestIcd11(suggest) });
  }
  const q = (url.searchParams.get('q') || '').slice(0, 100);
  const system = url.searchParams.get('system') === 'icd11' ? 'icd11' : 'cid10';
  return json({
    release: system === 'icd11' ? ICD11_RELEASE : '2008',
    results: system === 'icd11' ? searchIcd11(q) : searchCid10(q),
  });
});
