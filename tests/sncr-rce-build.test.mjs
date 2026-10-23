// Run after npm run build. No live Supabase/Anvisa calls: all HTTP is intercepted.
// This checks the actual compiled route, including webpack's PDF asset handling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PDFDocument } from 'pdf-lib';
import { localRceDatabase, syntheticSnapshot } from './helpers/sncr-rce-db.mjs';

test('compiled RCE route authorizes, reserves and opens the official PDF without a live service', async () => {
  const local = await localRceDatabase();
  const originalFetch = globalThis.fetch;
  const envNames = [
    'SNCR_ENVIRONMENT',
    'SNCR_PLATFORM_NAME',
    'NEXT_PUBLIC_SUPABASE_URL',
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
    'SUPABASE_SECRET_KEY',
  ];
  const previous = Object.fromEntries(
    envNames.map((key) => [key, process.env[key]]),
  );
  let role = 'doctor',
    reserves = 0;
  try {
    const snapshot = syntheticSnapshot();
    const did = crypto.randomUUID(),
      eid = crypto.randomUUID();
    const fields = {
      crm: snapshot.prescriber.crm,
      uf: snapshot.prescriber.uf,
      passport: 'TESTE000',
      medicine: snapshot.medicine.name,
      concentration: snapshot.medicine.concentration,
      pharmaceuticalForm: snapshot.medicine.pharmaceuticalForm,
      quantity: snapshot.medicine.quantity,
      dosage: snapshot.medicine.dosage,
    };
    await local.addNumbers();
    await local.db.query(
      `insert into public.clinical_documents
      (id,clinic_id,patient_id,author_id,kind,patient_name,physician_name,text,prescription_category,rce_fields)
      values($1,$2,'synthetic-patient',$3,'Receita',$4,$5,'CONTEUDO FICTICIO','RCE',$6::jsonb)`,
      [
        did,
        local.clinic,
        local.user,
        snapshot.patient.name,
        snapshot.prescriber.name,
        JSON.stringify(fields),
      ],
    );
    const document = (
      await local.db.query(
        'select * from public.clinical_documents where id=$1',
        [did],
      )
    ).rows[0];
    process.env.SNCR_ENVIRONMENT = 'hmg';
    process.env.SNCR_PLATFORM_NAME = snapshot.platform;
    process.env.NEXT_PUBLIC_SUPABASE_URL =
      'https://synthetic-sncr-build.invalid';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'synthetic-public-key';
    process.env.SUPABASE_SECRET_KEY = 'synthetic-private-key';
    globalThis.fetch = async (input, init) => {
      // Never delegate to originalFetch, even for an unexpected URL.
      const url = new URL(
        typeof input === 'string' || input instanceof URL ? input : input.url,
      );
      const path = url.pathname;
      if (path === '/auth/v1/user') return Response.json({ id: local.user });
      if (path === '/rest/v1/clinic_members')
        return Response.json([{ clinic_id: local.clinic, role }]);
      if (path === '/rest/v1/rpc/session_is_strong') return Response.json(true);
      if (path === '/rest/v1/clinical_documents')
        return Response.json([document]);
      if (path === '/rest/v1/document_profiles')
        return Response.json([
          {
            cpf: snapshot.prescriber.cpf,
            physician_name: snapshot.prescriber.name,
            letterhead_address: snapshot.prescriber.address,
            letterhead_phone: snapshot.prescriber.phone,
          },
        ]);
      if (path === '/rest/v1/patients')
        return Response.json([
          {
            cpf: '',
            street: 'Rua de Teste',
            address_number: '10',
            neighborhood: 'Bairro Ficticio',
            city: 'Cidade Ficticia',
            state: 'SP',
          },
        ]);
      if (path === '/rest/v1/rpc/sncr_rce_reserve') {
        reserves++;
        return Response.json(
          await local.rpc('sncr_rce_reserve', JSON.parse(init.body)),
        );
      }
      if (path === '/rest/v1/sncr_rce_emissions')
        return Response.json([await local.get(eid)]);
      throw new Error('Unexpected test HTTP path: ' + path);
    };
    const require = createRequire(import.meta.url);
    const { GET, POST } = require('../.next/server/app/api/sncr/rce/route.js')
      .routeModule.userland;
    const headers = {
      Authorization: 'Bearer synthetic-user-token',
      'X-Clinic-Id': local.clinic,
      'X-RCE-Action': '1',
      Origin: 'http://127.0.0.1:3028',
      'Content-Type': 'application/json',
    };
    const url = 'http://127.0.0.1:3028/api/sncr/rce';
    role = 'secretary';
    assert.equal(
      (await GET(new Request(url + '?action=config', { headers }))).status,
      403,
    );
    role = 'doctor';
    const prepared = await POST(
      new Request(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          action: 'prepare',
          id: eid,
          documentId: did,
          version: 1,
        }),
      }),
    );
    const data = await prepared.json();
    assert.equal(prepared.status, 200, JSON.stringify(data));
    assert.equal(data.emission.state, 'AWAITING_REVIEW');
    assert.equal(reserves, 1);
    const preview = await GET(
      new Request(url + '?action=preview&id=' + eid, { headers }),
    );
    assert.equal(preview.status, 200);
    assert.equal(
      (await PDFDocument.load(await preview.arrayBuffer())).getPageCount(),
      1,
    );
    process.env.SNCR_ENVIRONMENT = 'prd';
    assert.equal(
      (await GET(new Request(url + '?action=preview&id=' + eid, { headers })))
        .status,
      503,
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envNames) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await local.db.close();
  }
});
