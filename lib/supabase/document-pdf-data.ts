// Server only. Completa o documento com o endereço do paciente (receitas) e o
// timbre do profissional que o escreveu, antes de gerar o PDF.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClinicalDocument } from '../document-fields.ts';

export async function withPdfData(
  admin: SupabaseClient,
  clinicId: string,
  doc: ClinicalDocument,
) {
  if (doc.kind === 'Receita') {
    const { data: p } = await admin
      .from('patients')
      .select('street,address_number,complement,neighborhood,city,state')
      .eq('clinic_id', clinicId)
      .eq('id', doc.patient_id)
      .maybeSingle();
    if (p) {
      doc.patient_address = [
        p.street,
        p.address_number ? `nº ${p.address_number}` : '',
        p.complement,
        p.neighborhood,
      ]
        .filter(Boolean)
        .join(', ');
      doc.patient_city = p.city || '';
      doc.patient_state = p.state || '';
    }
  }
  if (doc.author_id) {
    const { data: profile } = await admin
      .from('document_profiles')
      .select('letterhead_title,letterhead_address,letterhead_phone')
      .eq('clinic_id', clinicId)
      .eq('user_id', doc.author_id)
      .maybeSingle();
    if (profile) {
      doc.letterhead_title = profile.letterhead_title || '';
      doc.letterhead_address = profile.letterhead_address || '';
      doc.letterhead_phone = profile.letterhead_phone || '';
    }
  }
  return doc;
}
