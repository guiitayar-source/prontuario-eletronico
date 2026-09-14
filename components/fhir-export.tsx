'use client';
import { useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import { Modal } from './modal';
export function FHIRExport({
  patientId,
  patientName,
}: {
  patientId: string;
  patientName: string;
}) {
  const [open, setOpen] = useState(false),
    [files, setFiles] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function download() {
    setBusy(true);
    setError('');
    try {
      const r = await apiFetch('/api/fhir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-FHIR-Action': '1' },
        body: JSON.stringify({ patientId, includeFiles: files }),
      });
      if (!r.ok) throw new Error(((await r.json()) as { error: string }).error);
      const href = URL.createObjectURL(await r.blob()),
        a = document.createElement('a');
      a.href = href;
      a.download = 'psywrite-fhir-r4.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 60000);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button onClick={() => setOpen(true)}>Exportar FHIR</button>
      {open && (
        <Modal
          label="Exportar prontuário FHIR R4"
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <h2 id="fhir-title">Exportar prontuário · FHIR R4</h2>
          <p>
            <strong>{patientName}</strong>
          </p>
          <p>
            Inclui cadastro, consultas salvas e adendos, condições,
            medicamentos, documentos e histórico importado. Alterações ainda não
            salvas e anexos arquivados não entram.
          </p>
          <p>
            Documentos permanecem preliminares. A lista de medicamentos é um
            plano terapêutico, sem assinatura de receita.
          </p>
          <label>
            <input
              type="checkbox"
              checked={files}
              onChange={(e) => setFiles(e.target.checked)}
            />{' '}
            Incluir o conteúdo dos anexos (até 2 MB no total)
          </label>
          <p>
            Sem essa opção, os anexos têm referências protegidas: outro sistema
            precisará de autenticação Bearer e do cabeçalho X-Clinic-Id para
            baixá-los. O arquivo exportado contém informações de saúde.
          </p>
          {error && <p role="alert">{error}</p>}
          <button className="primary" disabled={busy} onClick={download}>
            {busy ? 'Preparando…' : 'Baixar JSON'}
          </button>{' '}
          <button
            className="secondary"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            Cancelar
          </button>
        </Modal>
      )}
    </>
  );
}
