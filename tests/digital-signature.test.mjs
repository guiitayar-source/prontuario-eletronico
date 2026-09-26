import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PDFDocument } from 'pdf-lib';

import {
  generatePkce,
  encryptToken,
  decryptToken,
  timingSafeEqualStr,
  cleanCpf,
  formatCpf,
} from '../lib/signature/crypto-utils.ts';
import { MockBirdIdProvider } from '../lib/signature/mock-birdid-provider.ts';
import { PadesService } from '../lib/signature/pades-service.ts';
import {
  buildCanonicalEvolutionV1,
  computeEvolutionHash,
  normalizeClinicalText,
  serializeCanonicalData,
} from '../lib/signature/canonical-evolution.ts';

const execFileAsync = promisify(execFile);

describe('ICP-Brasil Digital Signature Suite', () => {
  describe('1. Cryptographic Utilities & PKCE', () => {
    it('should generate valid PKCE code_verifier and code_challenge (RFC 7636)', () => {
      const { codeVerifier, codeChallenge } = generatePkce();
      assert.ok(codeVerifier.length >= 43, 'codeVerifier must have at least 43 characters');
      assert.ok(codeChallenge.length >= 43, 'codeChallenge must have at least 43 characters');

      // Verify challenge calculation: SHA-256 of verifier base64url encoded
      const expectedChallenge = crypto
        .createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
      assert.equal(codeChallenge, expectedChallenge, 'Challenge must match SHA256 of verifier');
    });

    it('should encrypt and decrypt tokens using AES-256-GCM', () => {
      const secretToken = 'birdid_oauth_session_token_xyz_987654321';
      const encrypted = encryptToken(secretToken);

      assert.notEqual(encrypted, secretToken);
      const parts = encrypted.split(':');
      assert.equal(parts.length, 3, 'Encrypted format must be iv:tag:ciphertext');

      const decrypted = decryptToken(encrypted);
      assert.equal(decrypted, secretToken, 'Decrypted token must match original');
    });

    it('should fail decryption if auth tag is tampered', () => {
      const secret = 'sensitive-token';
      const encrypted = encryptToken(secret);
      const [iv, tag, cipher] = encrypted.split(':');

      // Corrupt tag
      const corruptedTag = Buffer.from(tag, 'hex');
      corruptedTag[0] ^= 0xff;
      const tampered = `${iv}:${corruptedTag.toString('hex')}:${cipher}`;

      assert.throws(() => {
        decryptToken(tampered);
      }, /Unsupported state or unable to authenticate data|Formato inválido/);
    });

    it('should perform timing-safe string comparison', () => {
      assert.equal(timingSafeEqualStr('token123', 'token123'), true);
      assert.equal(timingSafeEqualStr('token123', 'token456'), false);
      assert.equal(timingSafeEqualStr('token123', 'token12345'), false);
    });

    it('should format and clean CPFs properly', () => {
      assert.equal(cleanCpf('123.456.789-01'), '12345678901');
      assert.equal(cleanCpf('12345678901'), '12345678901');
      assert.equal(formatCpf('12345678901'), '123.456.789-01');
      assert.equal(cleanCpf(''), '');
      assert.equal(cleanCpf(null), '');
    });
  });

  describe('2. Certificate Parsing & CPF Extraction', () => {
    it('should parse ICP-Brasil X.509 certificate and extract CPF from CN', async () => {
      const mockProvider = new MockBirdIdProvider({
        mockCpf: '55544433322',
        doctorName: 'DRA. CAROLINA MENEZES',
      });

      const certs = await mockProvider.getCertificates('mock-token');
      assert.equal(certs.length, 1);
      const cert = certs[0];

      assert.equal(cert.cpf, '55544433322');
      assert.ok(cert.commonName.includes('DRA. CAROLINA MENEZES'));
      assert.ok(cert.issuer.includes('ICP-Brasil'));
      assert.ok(cert.fingerprint256.length > 0);
      assert.ok(cert.validTo > new Date());
    });
  });

  describe('3. PAdES PDF Preparation & Remote Signing Flow', () => {
    const padesService = new PadesService();

    it('should prepare PDF, embed detached CMS signature, and verify cryptographically', async () => {
      // 1. Create a sample clinical PDF
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([595.28, 841.89]);
      page.drawText('RECEITUARIO MEDICO DE CONTROLE ESPECIAL');
      page.drawText('Paciente: Fulano de Tal');
      page.drawText('Medicamento: Clonazepam 2mg - Tomar 1 cp a noite');
      const unsignedBytes = await pdfDoc.save();

      // 2. Prepare PDF for signature (calculates ByteRange and SHA-256 digest)
      const prepared = await padesService.preparePdfForSignature(unsignedBytes, {
        signerName: 'DR. GUILHERME TAYAR',
        doctorCrm: '164119 SP',
        reason: 'Assinatura digital ICP-Brasil',
      });

      assert.ok(prepared.digestHex, 'Digest must be calculated');
      assert.equal(prepared.digestHex.length, 64, 'SHA-256 digest must be 64 hex characters');
      assert.equal(prepared.byteRange.length, 4, 'ByteRange must have 4 coordinates');

      // 3. Request signature on digest from provider (HSM simulation)
      const mockProvider = new MockBirdIdProvider({
        mockCpf: '12345678901',
        doctorName: 'DR. GUILHERME TAYAR',
      });
      const signResult = await mockProvider.signHash({
        accessToken: 'mock-token',
        certificateAlias: 'e-CPF',
        hashHex: prepared.digestHex,
        documentAlias: 'Receituário #1234',
      });

      assert.ok(signResult.cmsSignatureBase64, 'Must return CMS signature');

      // 4. Embed detached CMS signature into PDF
      const signedPdf = padesService.embedSignature(prepared, signResult.cmsSignatureBase64);
      assert.ok(signedPdf.length > unsignedBytes.length, 'Signed PDF must include embedded signature');

      // 5. Cryptographic PAdES Verification
      const verification = await padesService.verifyPadesSignature(signedPdf);
      assert.equal(verification.isValid, true, 'Cryptographic verification must return true');
      assert.equal(verification.signerCpf, '12345678901');
      assert.ok(verification.signerName.includes('GUILHERME TAYAR'));
      assert.equal(verification.digestAlgorithm, 'SHA-256');
    });

    it('should detect any tampering of signed PDF and fail verification', async () => {
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([595.28, 841.89]);
      page.drawText('ATESTADO MEDICO - VALIDADE LEGAL');
      const unsignedBytes = await pdfDoc.save();

      const prepared = await padesService.preparePdfForSignature(unsignedBytes, {
        signerName: 'DR. TESTE',
      });

      const mockProvider = new MockBirdIdProvider();
      const signResult = await mockProvider.signHash({
        accessToken: 'mock-token',
        certificateAlias: 'e-CPF',
        hashHex: prepared.digestHex,
        documentAlias: 'Atestado #1',
      });

      const signedPdf = padesService.embedSignature(prepared, signResult.cmsSignatureBase64);

      // Verify intact PDF passes
      const intactVerification = await padesService.verifyPadesSignature(signedPdf);
      assert.equal(intactVerification.isValid, true);

      // Tamper with document content (modify 1 byte outside signature placeholder)
      const tamperedPdf = Buffer.from(signedPdf);
      tamperedPdf[60] ^= 0x42; // Flips bits in the PDF body

      const tamperedVerification = await padesService.verifyPadesSignature(tamperedPdf);
      assert.equal(tamperedVerification.isValid, false, 'Tampered document must fail verification');
    });
  });

  describe('4. CLI Signature Verification Tool', () => {
    it('should verify signed PDF via scripts/verify-signature.mjs CLI and exit with 0', async () => {
      const padesService = new PadesService();
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([595.28, 841.89]);
      page.drawText('LAUDO PSIQUIATRICO');
      const unsignedBytes = await pdfDoc.save();

      const prepared = await padesService.preparePdfForSignature(unsignedBytes, {
        signerName: 'DR. GUILHERME TAYAR',
        doctorCrm: '164119',
      });

      const mockProvider = new MockBirdIdProvider({ mockCpf: '11122233344' });
      const signResult = await mockProvider.signHash({
        accessToken: 'mock-token',
        certificateAlias: 'e-CPF',
        hashHex: prepared.digestHex,
        documentAlias: 'Laudo #1',
      });

      const signedPdf = padesService.embedSignature(prepared, signResult.cmsSignatureBase64);
      const testPdfPath = resolve(process.cwd(), 'temp-test-signed.pdf');
      await writeFile(testPdfPath, signedPdf);

      try {
        const { stdout } = await execFileAsync('node', [
          'scripts/verify-signature.mjs',
          testPdfPath,
        ]);
        assert.ok(stdout.includes('STATUS: ASSINATURA ÍNTEGRA E VÁLIDA'));
        assert.ok(stdout.includes('111.222.333-44'));
      } finally {
        await unlink(testPdfPath).catch(() => {});
      }
    });

    it('should exit with code 1 when CLI checks a tampered PDF', async () => {
      const padesService = new PadesService();
      const pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([595.28, 841.89]);
      page.drawText('DOCUMENTO ORIGINAL');
      const unsignedBytes = await pdfDoc.save();

      const prepared = await padesService.preparePdfForSignature(unsignedBytes, {
        signerName: 'DR. TESTE',
      });

      const mockProvider = new MockBirdIdProvider();
      const signResult = await mockProvider.signHash({
        accessToken: 'mock-token',
        certificateAlias: 'e-CPF',
        hashHex: prepared.digestHex,
        documentAlias: 'Doc #1',
      });

      const signedPdf = padesService.embedSignature(prepared, signResult.cmsSignatureBase64);
      const textIdx = signedPdf.indexOf('DOCUMENTO ORIGINAL');
      if (textIdx !== -1) {
        signedPdf[textIdx] = 'X'.charCodeAt(0);
      } else {
        signedPdf[50] ^= 0x01;
      }

      const testPdfPath = resolve(process.cwd(), 'temp-tampered.pdf');
      await writeFile(testPdfPath, signedPdf);

      try {
        await execFileAsync('node', [
          'scripts/verify-signature.mjs',
          testPdfPath,
        ]);
        assert.fail('Should have failed with exit code 1');
      } catch (err) {
        assert.equal(err.code, 1);
        const output = (err.stdout || '') + (err.stderr || '');
        assert.ok(
          output.includes('STATUS: ASSINATURA INVÁLIDA OU DOCUMENTO ADULTERADO') ||
          output.includes('Erro na verificação')
        );
      } finally {
        await unlink(testPdfPath).catch(() => {});
      }
    });
  });

  describe('5. Canonical Clinical Evolution Serialization & Hashing', () => {
    it('should normalize clinical text with Unicode NFC and LF line endings', () => {
      const rawText = '  Paciente refere cefaleia intensa.\r\nSintomas há 3 dias.\r\nPrescrito analgésico.  ';
      const normalized = normalizeClinicalText(rawText);
      assert.ok(!normalized.includes('\r'), 'Must not contain CR');
      assert.equal(normalized.startsWith(' '), false);
      assert.equal(normalized.endsWith(' '), false);
      assert.equal(
        normalized,
        'Paciente refere cefaleia intensa.\nSintomas há 3 dias.\nPrescrito analgésico.'
      );
    });

    it('should produce identical deterministic JSON regardless of object key order', () => {
      const obj1 = {
        schema_version: 1,
        evolution_id: '11111111-1111-1111-1111-111111111111',
        clinic_id: '22222222-2222-2222-2222-222222222222',
        patient_id: '33333333-3333-3333-3333-333333333333',
        appointment_id: null,
        doctor_id: '44444444-4444-4444-4444-444444444444',
        created_at: '2026-09-25T20:00:00.000Z',
        clinical_text: 'Paciente comparece para retorno.',
        version: 1,
      };

      // Shuffled keys
      const obj2 = {
        version: 1,
        created_at: '2026-09-25T20:00:00.000Z',
        appointment_id: null,
        schema_version: 1,
        clinical_text: 'Paciente comparece para retorno.',
        doctor_id: '44444444-4444-4444-4444-444444444444',
        patient_id: '33333333-3333-3333-3333-333333333333',
        evolution_id: '11111111-1111-1111-1111-111111111111',
        clinic_id: '22222222-2222-2222-2222-222222222222',
      };

      const json1 = serializeCanonicalData(obj1);
      const json2 = serializeCanonicalData(obj2);

      assert.equal(json1, json2, 'Canonical serialization must be strictly identical');

      const { hashHex: hash1 } = computeEvolutionHash(obj1);
      const { hashHex: hash2 } = computeEvolutionHash(obj2);
      assert.equal(hash1, hash2, 'Hashes must be identical');
      assert.equal(hash1.length, 64, 'SHA-256 hash must be 64 hex characters');
    });

    it('should detect any tampering of text or metadata (immutability check)', () => {
      const canonical = buildCanonicalEvolutionV1({
        evolutionId: 'a1b2c3d4-0000-0000-0000-000000000001',
        clinicId: 'a1b2c3d4-0000-0000-0000-000000000002',
        patientId: 'a1b2c3d4-0000-0000-0000-000000000003',
        doctorId: 'a1b2c3d4-0000-0000-0000-000000000004',
        createdAt: '2026-09-25T22:00:00.000Z',
        clinicalText: 'Evolução clínica sem queixas.',
        version: 1,
      });

      const { hashHex: originalHash } = computeEvolutionHash(canonical);

      // 1. Modifying text by 1 character
      const tamperedText = {
        ...canonical,
        clinical_text: 'Evolução clínica sem queixas!', // exclamation point
      };
      const { hashHex: tamperedTextHash } = computeEvolutionHash(tamperedText);
      assert.notEqual(
        originalHash,
        tamperedTextHash,
        'Changing 1 character in text must alter hash'
      );

      // 2. Modifying patientId
      const tamperedPatient = {
        ...canonical,
        patient_id: 'a1b2c3d4-0000-0000-0000-000000000099',
      };
      const { hashHex: tamperedPatientHash } = computeEvolutionHash(tamperedPatient);
      assert.notEqual(
        originalHash,
        tamperedPatientHash,
        'Changing patient ID must alter hash'
      );
    });

    it('should sign evolution hash with CMS detached signature without PDF', async () => {
      const canonical = buildCanonicalEvolutionV1({
        evolutionId: 'evo-12345',
        clinicId: 'clinic-123',
        patientId: 'patient-456',
        doctorId: 'doctor-789',
        createdAt: new Date().toISOString(),
        clinicalText: 'Paciente em bom estado geral. Pressão arterial 120x80 mmHg.',
        version: 1,
      });

      const { hashHex } = computeEvolutionHash(canonical);
      assert.equal(hashHex.length, 64);

      // Sign the hash directly with provider
      const mockProvider = new MockBirdIdProvider({
        mockCpf: '34929144892',
        doctorName: 'GUILHERME TAYAR DE CAMARGO',
      });

      const signResult = await mockProvider.signHash({
        accessToken: 'mock-token',
        certificateAlias: 'e-CPF',
        hashHex,
        documentAlias: 'Evolução Clínica #evo-123',
      });

      assert.ok(signResult.cmsSignatureBase64, 'Must produce CMS detached signature');
      assert.ok(
        !signResult.cmsSignatureBase64.includes('PDF'),
        'Signature must be native CMS and never touch PDF'
      );

      // Clean base64 and verify DER length
      const cleanB64 = signResult.cmsSignatureBase64
        .replace(/-----[^-]+-----/g, '')
        .replace(/\s+/g, '');
      const der = Buffer.from(cleanB64, 'base64');
      assert.ok(der.length > 500, 'CMS SignedData must contain certificate chain and signature');
    });
  });
});
