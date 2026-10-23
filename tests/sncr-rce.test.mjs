import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { MockBirdIdProvider } from '../lib/signature/mock-birdid-provider.ts';
import { padesService } from '../lib/signature/pades-service.ts';
import {
  signRce,
  originalRce,
  recoverRceOriginal,
  sha256,
  rceSnapshotHash,
} from '../lib/sncr/rce-workflow.ts';
import { rcePdf } from '../lib/sncr/rce-pdf.ts';
import { localRceDatabase, syntheticSnapshot } from './helpers/sncr-rce-db.mjs';

function memoryArtifacts() {
  const files = new Map();
  return {
    files,
    read: async (p) => files.get(p) || null,
    writeOnce: async (p, b) => {
      const old = files.get(p);
      if (old && sha256(old) !== sha256(b)) throw new Error('immutable');
      files.set(p, new Uint8Array(b));
    },
  };
}
async function mockSigner() {
  const provider = new MockBirdIdProvider({
    mockCpf: '52998224725',
    doctorName: 'PRESCRITOR FICTICIO',
  });
  const [cert] = await provider.getCertificates('synthetic');
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    get: async () => ({
      cpf: cert.cpf,
      fingerprint: cert.fingerprint256,
      provider: 'mock-test-only',
      sign: async (digest) => {
        calls++;
        return provider.signHash({
          accessToken: 'synthetic',
          certificateAlias: cert.alias,
          hashHex: digest,
          documentAlias: 'TESTE SEM VALIDADE',
        });
      },
    }),
  };
}
test('RCE end to end: reserve, official PDF, explicit review, PAdES, atomic save and original download', async () => {
  const local = await localRceDatabase();
  try {
    await local.addNumbers();
    const e = await local.reserve();
    const repo = local.repo(e.id),
      artifacts = memoryArtifacts(),
      signer = await mockSigner();
    assert.equal(e.state, 'AWAITING_REVIEW');
    assert.equal(e.number, '2602.6-53.0000001');
    await assert.rejects(() => repo.acquire(e.snapshot_hash, false), /Revise/);
    await assert.rejects(() => repo.acquire('0'.repeat(64), true), /Revise/);
    const signed = await signRce({
      repository: repo,
      artifacts,
      reviewedHash: e.snapshot_hash,
      numberChecked: true,
      getSigner: signer.get,
    });
    assert.equal(signed.state, 'SIGNED');
    assert.equal(signer.calls, 1);
    const pdf = await originalRce(repo, artifacts);
    assert.ok(
      (await padesService.verifyPadesSignature(Buffer.from(pdf))).isValid,
    );
    assert.equal(sha256(pdf), signed.signed_pdf_hash);
    assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);
    const again = await signRce({
      repository: repo,
      artifacts,
      reviewedHash: e.snapshot_hash,
      numberChecked: true,
      getSigner: signer.get,
    });
    assert.equal(again.signed_pdf_hash, signed.signed_pdf_hash);
    assert.equal(signer.calls, 1, 'repeat must not call provider again');
    assert.equal(
      (
        await local.db.query(
          'select state from public.sncr_numbering_items where number=$1',
          [e.number],
        )
      ).rows[0].state,
      'USED',
    );
    await assert.rejects(
      () =>
        local.db.query(
          "update public.clinical_documents set text='edited' where id=$1",
          [e.document_id],
        ),
      /possui uma RCE/,
    );
    artifacts.files.delete(signed.signed_pdf_path);
    await assert.rejects(
      () => originalRce(repo, artifacts),
      /Nenhum PDF substituto/,
    );
    const restored = await recoverRceOriginal(repo, artifacts);
    assert.equal(sha256(restored), signed.signed_pdf_hash);
    assert.equal(signer.calls, 1, 'restore must not sign again');
    await local.rpc('sncr_rce_original_recovered', {
      eid: e.id,
      c: local.clinic,
      u: local.user,
      h: sha256(restored),
    });
    assert.equal(
      (
        await local.db.query(
          "select count(*)::int as n from public.sncr_rce_events where emission_id=$1 and action='ORIGINAL_RECOVERED'",
          [e.id],
        )
      ).rows[0].n,
      1,
    );
    artifacts.files.set(signed.signed_pdf_path, new Uint8Array([0, 1]));
    await assert.rejects(
      () => recoverRceOriginal(repo, artifacts),
      /nenhum arquivo foi sobrescrito/,
    );
    artifacts.files.delete(signed.signed_pdf_path);
    artifacts.files.set(signed.prepared_meta.path, new Uint8Array([0, 1]));
    await assert.rejects(
      () => recoverRceOriginal(repo, artifacts),
      /diverge do registro/,
    );
    assert.equal(
      artifacts.files.has(signed.signed_pdf_path),
      false,
      'never replace a lost original with different bytes',
    );
  } finally {
    await local.db.close();
  }
});
test('PDF preserves official page and all required fields; long dosage continues on another page', async () => {
  const s = syntheticSnapshot(),
    pdf = await rcePdf(s, '2602.6-53.0000001', new Date(), 'hmg');
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);
  s.medicine.dosage = Array.from(
    { length: 30 },
    (_, i) => `Orientacao ficticia ${i + 1}`,
  ).join('\n');
  assert.equal(
    (
      await PDFDocument.load(
        await rcePdf(s, '2602.6-53.0000001', new Date(), 'hmg'),
      )
    ).getPageCount(),
    3,
  );
  await assert.rejects(
    () => rcePdf(s, '2602.6-53.0000001', new Date(), 'prd'),
    /produção/,
  );
  const reordered = JSON.parse(JSON.stringify(s));
  reordered.patient = Object.fromEntries(Object.entries(s.patient).reverse());
  assert.equal(
    rceSnapshotHash(s),
    rceSnapshotHash(reordered),
    'JSONB key order must not change the frozen hash',
  );
});
test('recover storage/database partial failures without signing or numbering again', async () => {
  for (const failAt of ['signed-upload', 'final-commit']) {
    const local = await localRceDatabase();
    try {
      await local.addNumbers();
      const e = await local.reserve(),
        base = local.repo(e.id),
        signer = await mockSigner(),
        artifacts = memoryArtifacts();
      let fail = true;
      const repo = {
        ...base,
        finish: async (...args) => {
          if (fail && failAt === 'final-commit') throw new Error('db lost');
          return base.finish(...args);
        },
      };
      const write = artifacts.writeOnce;
      artifacts.writeOnce = async (p, ...args) => {
        if (fail && failAt === 'signed-upload' && p.endsWith('/signed.pdf'))
          throw new Error('storage lost');
        return write(p, ...args);
      };
      const run = () =>
        signRce({
          repository: repo,
          artifacts,
          reviewedHash: e.snapshot_hash,
          numberChecked: true,
          getSigner: signer.get,
        });
      await assert.rejects(run);
      assert.equal((await base.get()).state, 'FINALIZING');
      assert.equal(signer.calls, 1);
      fail = false;
      assert.equal((await run()).state, 'SIGNED');
      assert.equal(signer.calls, 1);
    } finally {
      await local.db.close();
    }
  }
});
test('provider timeout stays uncertain; recovery never repeats the signature', async () => {
  const local = await localRceDatabase();
  try {
    await local.addNumbers();
    const e = await local.reserve(),
      repo = local.repo(e.id),
      artifacts = memoryArtifacts(),
      signer = await mockSigner();
    let calls = 0;
    const getSigner = async () => ({
      ...(await signer.get()),
      sign: async () => {
        calls++;
        throw new Error('timeout after request');
      },
    });
    const run = () =>
      signRce({
        repository: repo,
        artifacts,
        reviewedHash: e.snapshot_hash,
        numberChecked: true,
        getSigner,
      });
    assert.equal((await run()).state, 'SIGNATURE_UNCERTAIN');
    assert.equal((await run()).state, 'SIGNATURE_UNCERTAIN');
    assert.equal(calls, 1);
  } finally {
    await local.db.close();
  }
});
test('wrong prescriber certificate stops before remote signing; invalid CMS blocks the number', async () => {
  const local = await localRceDatabase();
  try {
    await local.addNumbers();
    const e = await local.reserve(),
      repo = local.repo(e.id),
      artifacts = memoryArtifacts(),
      signer = await mockSigner();
    await assert.rejects(
      () =>
        signRce({
          repository: repo,
          artifacts,
          reviewedHash: e.snapshot_hash,
          numberChecked: true,
          getSigner: async () => ({
            ...(await signer.get()),
            cpf: '11111111111',
          }),
        }),
      /certificado não pertence/,
    );
    assert.equal(signer.calls, 0);
    assert.equal((await repo.get()).state, 'AWAITING_REVIEW');
    let calls = 0;
    const getSigner = async () => ({
      ...(await signer.get()),
      sign: async () => {
        calls++;
        return { cmsSignatureBase64: 'aW52YWxpZA==' };
      },
    });
    const run = () =>
      signRce({
        repository: repo,
        artifacts,
        reviewedHash: e.snapshot_hash,
        numberChecked: true,
        getSigner,
      });
    assert.equal((await run()).state, 'BLOCKED');
    assert.equal((await run()).state, 'BLOCKED');
    assert.equal(calls, 1);
    assert.equal(
      (
        await local.db.query(
          'select state from public.sncr_numbering_items where number=$1',
          [e.number],
        )
      ).rows[0].state,
      'RESERVED',
    );
  } finally {
    await local.db.close();
  }
});
test('cancel burns the number, and concurrent reservations cannot share a number', async () => {
  const local = await localRceDatabase();
  try {
    await local.addNumbers();
    const reserved = await Promise.all([local.reserve(), local.reserve()]);
    assert.notEqual(reserved[0].number, reserved[1].number);
    const e = reserved[0];
    await local.rpc('sncr_rce_cancel', {
      eid: e.id,
      c: local.clinic,
      u: local.user,
    });
    assert.equal(
      (
        await local.db.query(
          'select state from public.sncr_numbering_items where number=$1',
          [e.number],
        )
      ).rows[0].state,
      'VOID',
    );
    await assert.rejects(() => local.reserve(), /Sem numeração/);
    const other = 'aaaaaaaa-0000-4000-8000-000000000002';
    await assert.rejects(
      () =>
        local.rpc('sncr_rce_acquire', {
          eid: reserved[1].id,
          c: other,
          u: local.user,
          h: reserved[1].snapshot_hash,
          checked: true,
        }),
      /privilege|permission/i,
    );
    const otherUser = 'bbbbbbbb-0000-4000-8000-000000000002';
    await assert.rejects(
      () =>
        local.rpc('sncr_rce_acquire', {
          eid: reserved[1].id,
          c: local.clinic,
          u: otherUser,
          h: reserved[1].snapshot_hash,
          checked: true,
        }),
      /privilege|permission/i,
    );
    await assert.rejects(
      () =>
        local.rpc('sncr_rce_original_recovered', {
          eid: reserved[1].id,
          c: local.clinic,
          u: otherUser,
          h: '0'.repeat(64),
        }),
      /privilege|permission/i,
    );
    await local.db.exec('set role authenticated');
    await assert.rejects(
      () => local.db.query('select * from public.sncr_rce_emissions'),
      /permission denied/,
    );
    await assert.rejects(
      () => local.db.query('delete from public.sncr_rce_events'),
      /permission denied/,
    );
    await local.db.exec('reset role');
  } finally {
    await local.db.close();
  }
});
