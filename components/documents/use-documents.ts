import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import {
  documentKinds,
  type ClinicalDocument,
  type DocumentProfile,
  type PrescriptionTemplate,
} from '@/lib/document-fields';
import type { Patient } from '@/lib/patient-fields';
import type { SignatureSessionData } from '@/lib/signature/types';
export function useDocuments(patient: Patient, enabled = true) {
  const [rows, setRows] = useState<ClinicalDocument[]>([]),
    [profile, setProfile] = useState<DocumentProfile>({
      physician_name: '',
      physician_registration: '',
      letterhead_title: '',
      letterhead_address: '',
      letterhead_phone: '',
      cpf: null,
    }),
    [templates, setTemplates] = useState<PrescriptionTemplate[]>([]),
    [draft, setDraft] = useState<ClinicalDocument | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(''),
    [preview, setPreview] = useState(''),
    [signatureSession, setSignatureSession] = useState<SignatureSessionData | null>(null),
    [signatureNotice, setSignatureNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null),
    [signingDocId, setSigningDocId] = useState<string | null>(null);
  const previewRef = useRef(''),
    saving = useRef(false);

  async function checkSignatureSession() {
    try {
      const r = await apiFetch('/api/digital-signature/session');
      if (r.ok) {
        const data = (await r.json()) as { active: boolean; session: SignatureSessionData | null };
        setSignatureSession(data.active ? data.session : null);
      }
    } catch {
      // Ignore background check failure
    }
  }

  async function connectBirdId() {
    try {
      setError('');
      // Salva o documento aberto para reabri-lo na volta da autenticação, pronto para assinar.
      const doc = draft && (dirty || draft.version === 0) ? await save() : draft;
      if (draft && !doc) return;
      if (typeof window !== 'undefined' && patient?.id) {
        sessionStorage.setItem('birdid_return_patient_id', patient.id);
        sessionStorage.setItem('birdid_return_tab', 'documentos');
        if (doc && doc.status !== 'SIGNED')
          sessionStorage.setItem('birdid_return_document_id', doc.id);
      }
      const r = await apiFetch('/api/digital-signature/birdid/authorize');
      const data = (await r.json()) as { authorizationUrl?: string; error?: string };
      if (!r.ok) throw new Error(data.error || 'Falha ao iniciar autenticação Bird ID');
      if (data.authorizationUrl) {
        window.location.href = data.authorizationUrl;
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function disconnectBirdId() {
    try {
      await apiFetch('/api/digital-signature/session', { method: 'DELETE' });
      setSignatureSession(null);
      setSignatureNotice({
        type: 'success',
        message: 'Sessão Bird ID desconectada.',
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function signTestDocument() {
    setBusy(true);
    setError('');
    try {
      const res = await apiFetch('/api/digital-signature/test-sign', {
        method: 'POST',
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        storagePath?: string;
        verification?: { isValid: boolean; signerName: string; signerCpf: string; algorithm: string };
      };
      if (!res.ok) throw new Error(data.error || 'Falha ao testar assinatura');

      setSignatureNotice({
        type: 'success',
        message: `✓ Documento sintético assinado com sucesso! Titular: ${data.verification?.signerName} (${data.verification?.signerCpf}).`,
      });

      if (data.storagePath) {
        window.open(
          `/api/digital-signature/test-sign?path=${encodeURIComponent(data.storagePath)}`,
          '_blank'
        );
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function load() {
    const r = await apiFetch(
      '/api/documents?patientId=' + encodeURIComponent(patient.id),
    );
    const data = (await r.json()) as {
      documents: ClinicalDocument[];
      profile: DocumentProfile | null;
      templates: PrescriptionTemplate[];
      error?: string;
    };
    if (!r.ok) throw new Error(data.error);
    setRows(data.documents);
    setTemplates(data.templates || []);
    if (data.profile) setProfile(data.profile);
  }
  async function templateAction(
    action: 'save-template' | 'delete-template',
    body: Partial<PrescriptionTemplate>,
  ) {
    const r = await apiFetch('/api/documents?action=' + action, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Document-Action': '1',
      },
      body: JSON.stringify(body),
    });
    const data = (await r.json()) as {
      template?: PrescriptionTemplate;
      error?: string;
    };
    if (!r.ok) throw new Error(data.error);
    return data.template;
  }
  async function saveTemplate(t: PrescriptionTemplate) {
    const saved = (await templateAction('save-template', t))!;
    setTemplates((current) =>
      [...current.filter((item) => item.id !== saved.id), saved].sort((a, b) =>
        a.name.localeCompare(b.name, 'pt-BR'),
      ),
    );
    return saved;
  }
  async function deleteTemplate(id: string) {
    await templateAction('delete-template', { id });
    setTemplates((current) => current.filter((item) => item.id !== id));
  }
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const sigStatus = params.get('signature_status');
      const sigError = params.get('signature_error');
      if (sigStatus === 'connected') {
        queueMicrotask(() => {
          setSignatureNotice({
            type: 'success',
            message: '✓ Certificado digital Bird ID conectado com sucesso para esta sessão!',
          });
        });
        window.history.replaceState({}, '', window.location.pathname);
      } else if (sigError) {
        queueMicrotask(() => {
          setSignatureNotice({
            type: 'error',
            message: `Falha na conexão Bird ID: ${sigError}`,
          });
        });
        window.history.replaceState({}, '', window.location.pathname);
      }
    }
    void checkSignatureSession();
  }, []);

  useEffect(() => {
    if (enabled) void load().catch((e) => setError(e.message));
    return () => {
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
    // Recarrega ao trocar de paciente ou habilitar; load não é estável entre renderizações.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patient.id, enabled]);
  function clearPreview() {
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = '';
    setPreview('');
  }
  function open(
    d?: ClinicalDocument,
    consultationId?: string,
    duplicate = false,
    initialText = '',
    kind = documentKinds[0],
  ) {
    clearPreview();
    setError('');
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
    }).format(new Date());
    const next: ClinicalDocument = d
      ? {
          ...d,
          ...(duplicate
            ? {
                id: crypto.randomUUID(),
                version: 0,
                author_id: undefined,
                updated_at: undefined,
                status: undefined,
                signed_pdf_path: null,
                document_date: today,
                consultation_id: consultationId || null,
                physician_name: profile.physician_name,
                physician_registration: profile.physician_registration,
              }
            : {}),
        }
      : {
          id: crypto.randomUUID(),
          patient_id: patient.id,
          consultation_id: consultationId || null,
          kind,
          patient_name: patient.social_name || patient.name,
          physician_name: profile.physician_name,
          physician_registration: profile.physician_registration,
          document_date: today,
          text: initialText,
          version: 0,
        };
    setDraft(next);
    setSaved(JSON.stringify(next));
  }
  const dirty = !!draft && JSON.stringify(draft) !== saved;
  function close() {
    if (busy) return false;
    if (
      dirty &&
      !window.confirm('Descartar as alterações não salvas deste documento?')
    )
      return false;
    setDraft(null);
    clearPreview();
    return true;
  }
  async function save() {
    if (!draft || saving.current) return null;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      const r = await apiFetch('/api/documents', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Document-Action': '1',
        },
        body: JSON.stringify(draft),
      });
      const result = (await r.json()) as {
        document: ClinicalDocument;
        error?: string;
      };
      if (!r.ok) throw new Error(result.error);
      setDraft(result.document);
      setSaved(JSON.stringify(result.document));
      await load();
      return result.document;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function pdf() {
    const d = dirty || draft?.version === 0 ? await save() : draft;
    if (!d) return;
    setBusy(true);
    setError('');
    try {
      const r = await apiFetch(
        `/api/documents?action=pdf&patientId=${encodeURIComponent(patient.id)}&id=${d.id}`,
      );
      if (!r.ok) {
        const e = (await r.json()) as { error: string };
        throw new Error(e.error);
      }
      clearPreview();
      previewRef.current = URL.createObjectURL(await r.blob());
      setPreview(previewRef.current);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function sign(documentId: string) {
    if (!signatureSession) {
      setError('Conecte sua conta Bird ID antes de assinar o documento.');
      return false;
    }
    let currentDoc = draft;
    if (dirty || currentDoc?.version === 0) {
      currentDoc = await save();
      if (!currentDoc) return false;
    }
    setBusy(true);
    setSigningDocId(documentId);
    setError('');
    try {
      const res = await apiFetch('/api/digital-signature/sign', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature-Action': '1',
        },
        body: JSON.stringify({ documentId }),
      });
      const data = (await res.json()) as { error?: string; signedPdfPath?: string };
      if (!res.ok) throw new Error(data.error || 'Falha ao assinar documento');

      setSignatureNotice({
        type: 'success',
        message: '✓ Documento assinado digitalmente com sucesso (ICP-Brasil)!',
      });
      await load();
      if (draft && draft.id === documentId) {
        setDraft({ ...draft, status: 'SIGNED', signed_pdf_path: data.signedPdfPath });
        await pdf();
      }
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
      setSigningDocId(null);
    }
  }

  return {
    rows,
    templates,
    saveTemplate,
    deleteTemplate,
    draft,
    setDraft: (d: ClinicalDocument) => {
      clearPreview();
      setDraft(d);
    },
    error,
    busy,
    dirty,
    preview,
    signatureSession,
    signatureNotice,
    signingDocId,
    connectBirdId,
    disconnectBirdId,
    signTestDocument,
    sign,
    load,
    open,
    close,
    save,
    pdf,
  };
}
export type DocumentsController = ReturnType<typeof useDocuments>;
