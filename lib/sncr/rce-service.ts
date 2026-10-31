import type { SupabaseClient } from '@supabase/supabase-js';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import {
  handle,
  HttpError,
  json,
  writeGuard,
  body,
  check,
} from '../supabase/server.ts';
import { adminClient } from '../supabase/admin.ts';
import {
  decryptToken,
  parseX509Certificate,
} from '../signature/crypto-utils.ts';
import { validateIcpChain } from '../signature/icp-chain.ts';
import { getSignatureProvider } from '../signature/provider-factory.ts';
import { liveIssuanceRevocationOptions } from '../signature/revocation-fetch.ts';
import {
  validateRceFields,
  validateRceSnapshot,
  type RceSnapshot,
} from './rce.ts';
import { configuredSncrEnvironment } from './client.ts';
import { rcePdf } from './rce-pdf.ts';
import { rceRepository } from './rce-repository.ts';
import {
  originalRce,
  recoverRceOriginal,
  rceSnapshotHash,
  sha256,
  signRce,
  type RceArtifacts,
  type RceEmission,
  type RceSigner,
} from './rce-workflow.ts';

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function id(value: unknown) {
  if (typeof value !== 'string' || !uuid.test(value))
    throw new HttpError(422, 'Identificador inválido.');
  return value;
}
export function rceArtifacts(admin: SupabaseClient): RceArtifacts {
  const bucket = admin.storage.from('clinical-files');
  const read = async (path: string) => {
    const r = await bucket.download(path);
    if (r.error) {
      if (
        r.error.message.toLowerCase().includes('not found') ||
        ('statusCode' in r.error && String(r.error.statusCode) === '404')
      )
        return null;
      throw new HttpError(
        503,
        'Não foi possível recuperar o arquivo original agora. Tente recuperar esta mesma emissão.',
      );
    }
    return new Uint8Array(await r.data.arrayBuffer());
  };
  return {
    read,
    writeOnce: async (path, bytes, contentType) => {
      const r = await bucket.upload(path, bytes, {
        contentType,
        upsert: false,
      });
      if (!r.error) return;
      const old = await read(path);
      if (old && sha256(old) === sha256(bytes)) return;
      throw new HttpError(
        503,
        'O arquivo não pôde ser preservado. Recupere esta emissão antes de tentar outra.',
      );
    },
  };
}
async function activeSigner(
  admin: SupabaseClient,
  clinic: string,
  user: string,
): Promise<RceSigner> {
  const session = check(
    await admin
      .from('signature_sessions')
      .select('*')
      .eq('clinic_id', clinic)
      .eq('user_id', user)
      .eq('revoked', false)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  );
  if (!session?.certificate_raw)
    throw new HttpError(
      422,
      'Conecte seu certificado Bird ID ou VIDaaS antes de assinar a RCE.',
    );
  const cert = parseX509Certificate(
    session.certificate_raw,
    session.certificate_alias,
  );
  if (
    !cert.cpf ||
    cert.cpf !== session.cpf ||
    cert.validFrom > new Date() ||
    cert.validTo <= new Date()
  )
    throw new HttpError(
      422,
      'O certificado não está válido para esta assinatura.',
    );
  const der = Buffer.from(
    session.certificate_raw.replace(/-----[^-]+-----|\s/g, ''),
    'base64',
  );
  const certificate = new pkijs.Certificate({
    schema: asn1js.fromBER(new Uint8Array(der).buffer).result,
  });
  const chain = await validateIcpChain(certificate, new Date());
  if (!chain.valid)
    throw new HttpError(
      422,
      'A cadeia ICP-Brasil do certificado não pôde ser confirmada.',
    );
  const token = decryptToken(session.access_token_encrypted);
  return {
    cpf: cert.cpf,
    fingerprint: cert.fingerprint256,
    provider: session.provider,
    sign: (digest) =>
      getSignatureProvider(session.provider).signHash({
        accessToken: token,
        certificateAlias: session.certificate_alias,
        hashHex: digest,
        documentAlias: 'RCE de teste - sem validade',
      }),
  };
}
const pdfResponse = (bytes: Uint8Array, filename: string) =>
  new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });

export const rce = handle(async (request, ctx) => {
  if (!['owner', 'doctor'].includes(ctx.role))
    throw new HttpError(403, 'A RCE eletrônica é exclusiva do prescritor.');
  const environment = configuredSncrEnvironment();
  const u = new URL(request.url),
    action = u.searchParams.get('action');
  if (request.method === 'GET' && action === 'config')
    return json({
      enabled: environment !== null,
      environment: environment ?? 'disabled',
      productionAvailable: environment === 'prd',
    });
  if (!environment)
    throw new HttpError(
      503,
      'A RCE eletrônica com numeração SNCR não está habilitada neste servidor.',
    );
  const admin = adminClient();
  const rpc = async <T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> => check(await admin.rpc(name, args)) as T;
  const get = async (eid: string) => {
    const e = check(
      await admin
        .from('sncr_rce_emissions')
        .select('*')
        .eq('id', eid)
        .eq('clinic_id', ctx.clinic)
        .eq('user_id', ctx.user)
        .maybeSingle(),
    );
    if (!e) throw new HttpError(404, 'Emissão não encontrada.');
    // Uma emissão de treinamento nunca é aberta pelo servidor de produção, nem o inverso.
    if (e.environment !== environment)
      throw new HttpError(
        503,
        'Esta emissão pertence a outro ambiente do SNCR e não está disponível neste servidor.',
      );
    return e as RceEmission;
  };
  const artifacts = rceArtifacts(admin);
  if (request.method === 'GET') {
    if (!u.searchParams.has('id')) {
      const documentId = id(u.searchParams.get('documentId'));
      const emissions = check(
        await admin
          .from('sncr_rce_emissions')
          .select('*')
          .eq('document_id', documentId)
          .eq('clinic_id', ctx.clinic)
          .neq('state', 'CANCELLED')
          .order('created_at', { ascending: false })
          .limit(1),
      );
      if (emissions[0] && emissions[0].user_id !== ctx.user)
        throw new HttpError(
          403,
          'Esta RCE está vinculada a outro prescritor. Solicite a ele o original ou o andamento.',
        );
      return json({ emission: emissions[0] || null });
    }
    const eid = id(u.searchParams.get('id')),
      e = await get(eid);
    if (action === 'preview')
      return pdfResponse(
        await rcePdf(e.snapshot, e.number, new Date(), e.environment),
        e.environment === 'hmg' ? 'rce-previa-teste.pdf' : 'rce-previa.pdf',
      );
    if (action === 'original') {
      try {
        return pdfResponse(
          await originalRce({ get: () => get(eid) }, artifacts),
          e.environment === 'hmg' ? 'rce-assinada-teste.pdf' : 'rce-assinada.pdf',
        );
      } catch (error) {
        throw new HttpError(503, (error as Error).message);
      }
    }
    return json({ emission: e });
  }
  writeGuard(request, 'X-RCE-Action');
  const p = await body(request);
  if (p.action === 'prepare') {
    const eid = id(p.id),
      documentId = id(p.documentId);
    const doc = check(
      await ctx.db
        .from('clinical_documents')
        .select('*')
        .eq('id', documentId)
        .eq('clinic_id', ctx.clinic)
        .eq('author_id', ctx.user)
        .maybeSingle(),
    );
    if (
      !doc ||
      doc.kind !== 'Receita' ||
      (doc.prescription_category || 'RCE') !== 'RCE'
    )
      throw new HttpError(
        422,
        'Selecione uma Receita de Controle Especial de sua autoria.',
      );
    const profile = check(
      await admin
        .from('document_profiles')
        .select('*')
        .eq('clinic_id', ctx.clinic)
        .eq('user_id', ctx.user)
        .maybeSingle(),
    );
    const patient = check(
      await admin
        .from('patients')
        .select('*')
        .eq('clinic_id', ctx.clinic)
        .eq('id', doc.patient_id)
        .maybeSingle(),
    );
    if (!profile || !patient)
      throw new HttpError(
        422,
        'Confira o cadastro do paciente e seus dados profissionais.',
      );
    let snapshot: RceSnapshot;
    try {
      const f = validateRceFields(doc.rce_fields);
      if (
        !patient.street ||
        !patient.address_number ||
        !patient.city ||
        !patient.state
      )
        throw new Error(
          'Complete logradouro, número, cidade e UF do paciente antes de preparar a RCE.',
        );
      snapshot = validateRceSnapshot({
        schema: 1,
        patient: {
          name: doc.patient_name,
          identifier:
            patient.cpf || (f.passport ? 'Passaporte ' + f.passport : ''),
          address: [
            patient.street,
            patient.address_number,
            patient.complement,
            patient.neighborhood,
            patient.city + '/' + patient.state,
            patient.zip_code,
          ]
            .filter(Boolean)
            .join(', '),
        },
        prescriber: {
          name: doc.physician_name,
          cpf: profile.cpf || '',
          crm: f.crm,
          uf: f.uf,
          address: profile.letterhead_address,
          phone: profile.letterhead_phone,
        },
        medicine: {
          name: f.medicine,
          concentration: f.concentration,
          pharmaceuticalForm: f.pharmaceuticalForm,
          quantity: f.quantity,
          dosage: f.dosage,
        },
        platform: process.env.SNCR_PLATFORM_NAME || 'PsyWrite',
      });
      // Check layout before consuming a number; this synthetic value is never
      // saved, signed, submitted or presented as a real SNCR grant.
      await rcePdf(snapshot, '0000.0-00.0000000', new Date(), environment);
    } catch (error) {
      throw new HttpError(422, (error as Error).message);
    }
    return json({
      emission: await rpc('sncr_rce_reserve', {
        eid,
        c: ctx.clinic,
        u: ctx.user,
        did: documentId,
        v: p.version,
        env: environment,
        s: snapshot,
        h: rceSnapshotHash(snapshot),
      }),
    });
  }
  const eid = id(p.id);
  await get(eid);
  if (p.action === 'cancel') {
    await rpc('sncr_rce_cancel', { eid, c: ctx.clinic, u: ctx.user });
    return json({ cancelled: true });
  }
  if (p.action === 'recoverOriginal') {
    try {
      const bytes = await recoverRceOriginal(
        { get: () => get(eid) },
        artifacts,
      );
      await rpc('sncr_rce_original_recovered', {
        eid,
        c: ctx.clinic,
        u: ctx.user,
        h: sha256(bytes),
      });
      return json({ recovered: true });
    } catch (error) {
      throw new HttpError(503, (error as Error).message);
    }
  }
  if (
    p.action !== 'sign' ||
    typeof p.reviewedHash !== 'string' ||
    p.numberChecked !== true
  )
    throw new HttpError(
      422,
      'Revise a RCE e confira o número antes de assinar.',
    );
  const repo = rceRepository({
    id: eid,
    clinic: ctx.clinic,
    user: ctx.user,
    rpc,
    get: () => get(eid),
  });
  try {
    return json({
      emission: await signRce({
        repository: repo,
        artifacts,
        reviewedHash: p.reviewedHash,
        numberChecked: true,
        getSigner: () => activeSigner(admin, ctx.clinic, ctx.user),
        revocation: liveIssuanceRevocationOptions(),
      }),
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      503,
      'Não foi possível concluir agora. Consulte ou recupere esta mesma emissão; não solicite outro número.',
    );
  }
});
