'use client';
import { useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import type { Patient } from '@/lib/patient-fields';
import { PatientSearch } from './patients/search';
export function FhirExportPanel() {
  const [patient, setPatient] = useState<Patient | null>(null),
    [files, setFiles] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  async function download() {
    if (!patient) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const r = await apiFetch('/api/fhir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-FHIR-Action': '1' },
        body: JSON.stringify({ patientId: patient.id, includeFiles: files }),
      });
      if (!r.ok) throw new Error(((await r.json()) as { error: string }).error);
      const href = URL.createObjectURL(await r.blob()),
        a = document.createElement('a');
      a.href = href;
      a.download = 'psywrite-fhir-r4.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 60000);
      setMessage('Exportação gerada.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="import-card">
      <h2>Exportar prontuário · FHIR R4</h2>
      <p>
        Inclui cadastro, consultas salvas e adendos, condições, medicamentos,
        documentos e histórico importado. Alterações ainda não salvas e anexos
        arquivados não entram. Documentos permanecem preliminares e a lista de
        medicamentos é um plano terapêutico, sem assinatura de receita.
      </p>
      {!patient ? (
        <PatientSearch compact onOpen={setPatient} />
      ) : (
        <>
          <p>
            Paciente: <strong>{patient.social_name || patient.name}</strong>{' '}
            <button
              className="text-button"
              disabled={busy}
              onClick={() => {
                setPatient(null);
                setError('');
                setMessage('');
              }}
            >
              Trocar paciente
            </button>
          </p>
          <label>
            <input
              type="checkbox"
              checked={files}
              disabled={busy}
              onChange={(e) => setFiles(e.target.checked)}
            />{' '}
            Incluir o conteúdo dos anexos (até 2 MB no total)
          </label>
          <p className="muted">
            Sem essa opção, os anexos têm referências protegidas: outro sistema
            precisará de autenticação Bearer e do cabeçalho X-Clinic-Id para
            baixá-los. O arquivo exportado contém informações de saúde.
          </p>
          {error && (
            <p role="alert" className="capture-error">
              {error}
            </p>
          )}
          {message && <output className="capture-notice">{message}</output>}
          <div className="import-actions">
            <button className="primary" disabled={busy} onClick={download}>
              {busy ? 'Preparando…' : 'Baixar JSON'}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
