// Notificação de Receita A e B eletrônicas: mesmo passo a passo da RCE com numeração SNCR.
// Sem rede e sem dados reais; banco local em PGlite com as migrações do projeto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';
import { MockBirdIdProvider } from '../lib/signature/mock-birdid-provider.ts';
import { padesService } from '../lib/signature/pades-service.ts';
import { signRce, originalRce, sha256 } from '../lib/sncr/rce-workflow.ts';
import { rcePdf, numberedTemplates } from '../lib/sncr/rce-pdf.ts';
import { parseNumberingResponse } from '../lib/sncr/client.ts';
import { prescriptionSigningBlock } from '../lib/sncr/policy.ts';
import {
  numberedCategoryOf,
  numberedStateLabel,
  validateRceSnapshot,
} from '../lib/sncr/rce.ts';
import { localRceDatabase, syntheticSnapshot } from './helpers/sncr-rce-db.mjs';

const nr = (category) => ({ ...syntheticSnapshot(), category });
// Os modelos oficiais de A e B ainda não estão no repositório. Para exercitar o fluxo, estes
// testes apontam a categoria para o modelo da RCE, que tem o mesmo layout.
function withRceTemplate(category, run) {
  const original = numberedTemplates[category];
  numberedTemplates[category] = numberedTemplates.RCE;
  return Promise.resolve(run()).finally(() => {
    numberedTemplates[category] = original;
  });
}
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
  return async () => ({
    cpf: cert.cpf,
    fingerprint: cert.fingerprint256,
    provider: 'mock-test-only',
    sign: (digest) =>
      provider.signHash({
        accessToken: 'synthetic',
        certificateAlias: cert.alias,
        hashHex: digest,
        documentAlias: 'TESTE SEM VALIDADE',
      }),
  });
}

test('Notificação A em produção: número do lote NRA, modelo oficial, assinatura e QR do SNCR', () =>
  withRceTemplate('NRA', async () => {
    const local = await localRceDatabase();
    try {
      // Um lote de RCE nunca serve para a notificação, nem o inverso.
      await local.addNumbers(['2610.6-35.000112001'], undefined, 'prd', 'RCE');
      await assert.rejects(
        () => local.reserve(nr('NRA'), undefined, 'prd', 'NRA'),
        /Notificação de Receita A.*Vigilância Sanitária/,
      );
      await local.addNumbers(['2611.1-35.0000101', '2611.1-35.0000102'], undefined, 'prd', 'NRA');
      const e = await local.reserve(nr('NRA'), undefined, 'prd', 'NRA');
      assert.equal(e.category, 'NRA');
      assert.equal(e.number, '2611.1-35.0000101');
      assert.equal(
        (
          await local.db.query(
            "select state from public.sncr_numbering_items where number='2610.6-35.000112001'",
          )
        ).rows[0].state,
        'QUARANTINED',
        'o lote da RCE fica intacto',
      );
      const repo = local.repo(e.id),
        artifacts = memoryArtifacts();
      const signed = await signRce({
        repository: repo,
        artifacts,
        reviewedHash: e.snapshot_hash,
        numberChecked: true,
        getSigner: await mockSigner(),
      });
      assert.equal(signed.state, 'SIGNED');
      const pdf = await originalRce(repo, artifacts);
      assert.equal((await PDFDocument.load(pdf)).getTitle(), 'Notificação de Receita A');
      assert.ok(!Buffer.from(pdf).toString('latin1').includes('HOMOLOGACAO'));
      assert.ok((await padesService.verifyPadesSignature(Buffer.from(pdf))).isValid);
      // O tipo do receituário não pode mudar depois de reservado.
      await assert.rejects(
        () =>
          local.db.query("update public.sncr_rce_emissions set category='NRB' where id=$1", [e.id]),
        /imutáveis/,
      );
    } finally {
      await local.db.close();
    }
  }));

test('Notificação B de teste sai com a marca de homologação e o número do lote NRB', () =>
  withRceTemplate('NRB', async () => {
    const local = await localRceDatabase();
    try {
      await local.addNumbers(['2611.1-35.0000201'], undefined, 'hmg', 'NRB');
      const e = await local.reserve(nr('NRB'), undefined, 'hmg', 'NRB');
      assert.equal(e.category, 'NRB');
      const doc = await PDFDocument.load(await rcePdf(e.snapshot, e.number, new Date(), 'hmg'));
      assert.match(doc.getTitle(), /^Notificação de Receita B de teste - sem validade/);
    } finally {
      await local.db.close();
    }
  }));

test('o conteúdo congelado precisa ser do mesmo tipo do documento', async () => {
  const local = await localRceDatabase();
  try {
    await local.addNumbers(['2611.1-35.0000301'], undefined, 'hmg', 'NRA');
    // Documento NRA com snapshot de RCE (sem categoria) e o inverso.
    await assert.rejects(
      () => local.reserve(syntheticSnapshot(), undefined, 'hmg', 'NRA'),
      /não corresponde ao tipo/,
    );
    await local.addNumbers(['2602.6-53.0000001'], undefined, 'hmg', 'RCE');
    await assert.rejects(
      () => local.reserve(nr('NRA'), undefined, 'hmg', 'RCE'),
      /não corresponde ao tipo/,
    );
    // B2, retinoides e talidomida continuam fora.
    await assert.rejects(
      () => local.reserve({ ...syntheticSnapshot() }, undefined, 'hmg', 'NRB2'),
      /alterada ou já está em emissão/,
    );
  } finally {
    await local.db.close();
  }
});

test('RCE antiga mantém o hash: o snapshot sem categoria continua sem categoria', () => {
  const rce = validateRceSnapshot(syntheticSnapshot());
  assert.equal('category' in rce, false);
  assert.equal(validateRceSnapshot(nr('NRB')).category, 'NRB');
  assert.throws(() => validateRceSnapshot(nr('NRB2')), /Tipo de receituário/);
  assert.equal(numberedCategoryOf(null), 'RCE');
  assert.equal(numberedCategoryOf('NRA'), 'NRA');
  assert.equal(numberedCategoryOf('NRT'), 'RCE');
  assert.match(numberedStateLabel('SIGNED', 'NRA', 'prd'), /^Notificação A assinada/);
  assert.match(numberedStateLabel('SIGNED', 'RCE', 'hmg'), /sem validade/);
});

test('sem o modelo oficial conferido, a notificação para antes de gastar número', async () => {
  assert.equal(numberedTemplates.NRA.sha256 === null || typeof numberedTemplates.NRA.sha256 === 'string', true);
  if (numberedTemplates.NRA.sha256) return; // já conferido: o teste de layout abaixo cobre
  await assert.rejects(
    () => rcePdf(nr('NRA'), '2611.1-35.0000101', new Date(), 'prd'),
    /ainda não foi conferido/,
  );
  // Notificação nunca sai sem número (a transição sem SNCR é só da RCE).
  await assert.rejects(
    () => rcePdf(nr('NRA'), null, new Date(), 'transition'),
    /exige numeração SNCR/,
  );
});

test('numeração de notificação segue no formato publicado (14 dígitos)', () => {
  // Um retorno em outro formato fica preservado para conferência (CONTRACT_REVIEW) e pode ser
  // relido depois sem nova chamada à Anvisa; nunca vira número usável por engano.
  const input = { category: 'NRA', conselho: 'CRM', documento: '1', uf: 'SP', quantidade: 10 };
  assert.deepEqual(
    parseNumberingResponse(input, { numeracoesReceita: ['2611.1-35.0000101'], saldoReceitas: 9 }),
    ['2611.1-35.0000101'],
  );
  assert.throws(
    () => parseNumberingResponse(input, { numeracoesReceita: ['2611.1-35.00001'], saldoReceitas: 0 }),
    /divergente/,
  );
});

test('A e B não assinam pelo botão comum: só pelo passo a passo numerado', () => {
  assert.match(prescriptionSigningBlock('NRA'), /Colocar numeração da Anvisa/);
  assert.match(prescriptionSigningBlock('NRB'), /talonário físico/);
  assert.match(prescriptionSigningBlock('NRB2'), /ainda não está disponível/);
});

// Os três modelos eletrônicos vêm do mesmo desenho; o preenchimento usa as coordenadas da RCE.
// Quando os arquivos de A e B estiverem em assets/sncr, confere rótulo a rótulo.
test('modelos de A e B têm os rótulos nas mesmas posições do modelo da RCE', (t) => {
  const files = ['NRA', 'NRB'].map((c) => 'assets/sncr/' + numberedTemplates[c].file);
  if (!files.every(existsSync)) return t.skip('modelos oficiais de A e B ainda não instalados');
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
  } catch {
    return t.skip('pdftotext indisponível');
  }
  const labels = (file) => {
    const html = execFileSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8' });
    const out = new Map();
    for (const m of html.matchAll(
      /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="[\d.]+">([^<]+)<\/word>/g,
    ))
      if (!out.has(m[3])) out.set(m[3], [Number(m[1]), Number(m[2])]);
    return out;
  };
  const rce = labels('assets/sncr/' + numberedTemplates.RCE.file);
  for (const file of files) {
    const other = labels(file);
    for (const word of ['NOME:', 'TELEFONE:', 'CONCENTRAÇÃO:', 'QUANTIDADE:', 'POSOLOGIA:', 'PLATAFORMA', 'N.º']) {
      const a = rce.get(word),
        b = other.get(word);
      assert.ok(a && b, `${word} em ${file}`);
      assert.ok(Math.abs(a[0] - b[0]) < 1 && Math.abs(a[1] - b[1]) < 1, `${word} fora do lugar em ${file}`);
    }
  }
});
