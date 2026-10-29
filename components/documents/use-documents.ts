import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import {
  buildPrescriptionText,
  documentKinds,
  parsePrescriptionText,
  stripSncrNumbers,
  type ClinicalDocument,
  type DocumentProfile,
  type PrescriptionModality,
  type PrescriptionTemplate,
} from '@/lib/document-fields';
import type { NumberingContext } from '@/lib/sncr/numbering';
import type { SncrBatchSummary } from '@/lib/sncr/client';
import type { Patient } from '@/lib/patient-fields';
import {
  fetchSignatureAuthorizationUrl,
  openSignatureTab,
  sendTabToProvider,
  useSignatureResult,
} from '@/lib/signature/signature-tab';
import { useSignatureProvider } from '@/components/signature-provider';
import { useSignatureSession } from '@/components/use-signature-session';
export function useDocuments(patient: Patient, enabled = true) {
  const signature = useSignatureProvider(enabled);
  const signatureState = useSignatureSession(enabled);
  const signatureSession = signatureState.session;
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
    [sncrBatches, setSncrBatches] = useState<SncrBatchSummary[]>([]),
    [draft, setDraft] = useState<ClinicalDocument | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(''),
    [preview, setPreview] = useState(''),
    [signatureNotice, setSignatureNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null),
    [signingDocId, setSigningDocId] = useState<string | null>(null);
  const [numbering,setNumbering]=useState<Partial<NumberingContext> & {mode?:string; loading?:boolean; error?:string}>({});
  const sncrGeneration=useRef(0);
  const previewRef = useRef(''),
    saving = useRef(false);

  // Autenticação feita em outra aba: esta página continua como estava.
  useSignatureResult((result) => {
    if (!enabled) return;
    if (result.status === 'connected') {
      void signatureState.check();
      setSignatureNotice({
        type: 'success',
        message: '✓ Certificado digital conectado com sucesso para esta sessão!',
      });
    } else {
      setSignatureNotice({
        type: 'error',
        message: `Falha na conexão do certificado digital: ${result.message}`,
      });
    }
  });

  async function connectSignature(requestedProvider?: 'birdid' | 'vidaas') {
    const providerId = requestedProvider || signature.id;
    const providerLabel =
      providerId === 'vidaas'
        ? 'VIDaaS'
        : providerId === 'birdid'
          ? 'Bird ID'
          : signature.label;
    if (requestedProvider) {
      signature.choose(requestedProvider);
    }
    // Aba aberta no clique, antes de qualquer await; o documento aberto segue na tela.
    const tab = openSignatureTab(providerLabel);
    if (tab) {
      try {
        setError('');
        sendTabToProvider(tab, await fetchSignatureAuthorizationUrl(providerId));
      } catch (e) {
        tab.close();
        setError((e as Error).message);
      }
      return;
    }
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
      window.location.href = await fetchSignatureAuthorizationUrl(providerId);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function disconnectSignature() {
    try {
      await apiFetch('/api/digital-signature/session', { method: 'DELETE' });
      signatureState.clear();
      setSignatureNotice({
        type: 'success',
        message: 'Certificado digital desconectado.',
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
        verification?: { isValid: boolean; status?: string; signerName: string; signerCpf: string; algorithm: string };
      };
      if (!res.ok) throw new Error(data.error || 'Falha ao testar assinatura');

      setSignatureNotice({
        type: 'success',
        message: `✓ Documento sintético assinado com sucesso! Titular: ${data.verification?.signerName} (${data.verification?.signerCpf}).${
          data.verification?.status === 'VALID'
            ? ''
            : ' Integridade conferida; confiança plena ICP-Brasil (revogação) ainda não comprovada.'
        }`,
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

  async function loadSncrBatches() {
    try {
      const r = await apiFetch('/api/digital-signature/sncr');
      if (!r.ok) return;
      const data = (await r.json()) as { batches?: SncrBatchSummary[] };
      if (Array.isArray(data.batches)) {
        setSncrBatches(data.batches);
      }
    } catch {
      // Falha silenciosa ao carregar resumo de lotes SNCR
    }
  }

  useEffect(() => {
    const generation=++sncrGeneration.current;
    const id=draft?.id;
    if (!enabled || !id || !draft?.version || draft.kind!=='Receita') { setNumbering({}); return; }
    setNumbering({loading:true});
    void apiFetch(`/api/digital-signature/sncr?documentId=${encodeURIComponent(id)}`).then(async r=>{
      const data=await r.json();
      if (generation!==sncrGeneration.current) return;
      if (!r.ok) throw new Error(data.error||'Numeração indisponível');
      setNumbering(data);
    }).catch(e=>{ if(generation===sncrGeneration.current) setNumbering({error:e.message}); });
    return ()=>{++sncrGeneration.current;};
  },[draft?.id,draft?.version,enabled]);

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
    void loadSncrBatches();
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
            message: '✓ Certificado digital conectado com sucesso para esta sessão!',
          });
        });
        window.history.replaceState({}, '', window.location.pathname);
      } else if (sigError) {
        queueMicrotask(() => {
          setSignatureNotice({
            type: 'error',
            message: `Falha na conexão do certificado digital: ${sigError}`,
          });
        });
        window.history.replaceState({}, '', window.location.pathname);
      }
    }
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
                sncr_number: undefined,
                document_date: today,
                consultation_id: consultationId || null,
                physician_name: profile.physician_name,
                physician_registration: profile.physician_registration,
                ...(d.kind === 'Receita'
                  ? {
                      text: (() => {
                        const rx = parsePrescriptionText(d.text);
                        return buildPrescriptionText({
                          modality: rx.modality,
                          sncrNumber: '',
                          viaAdmin: rx.viaAdmin,
                          bodyText: stripSncrNumbers(rx.bodyText),
                        });
                      })(),
                    }
                  : {}),
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
    if (numbering.reservation?.document_id===draft.id) {
      if (dirty) { setError('Documento com reserva é imutável. Duplique como novo rascunho.'); return null; }
      return draft;
    }
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
    const simulation=draft?.kind==='Receita' && parsePrescriptionText(draft.text).modality!=='simples' && numbering.mode==='local-simulation';
    const pending=draft?.id===documentId && draft.status==='SIGNING';
    if (!signatureSession && !simulation && !pending) {
      setError(`Conecte seu ${signature.label} antes de assinar o documento.`);
      return false;
    }
    let currentDoc = draft;
    if (!pending && (dirty || currentDoc?.version === 0)) {
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
        body: JSON.stringify({ documentId, documentVersion: currentDoc?.version }),
      });
      const data = (await res.json()) as { error?: string; signedPdfPath?: string; simulation?:boolean; document?:ClinicalDocument };
      if (!res.ok) {
        // 401: a validação do certificado expirou; a tela passa a oferecer "revalidar".
        if (res.status === 401) signatureState.markExpired();
        throw new Error(data.error || 'Falha ao assinar documento');
      }

      setSignatureNotice({
        type: 'success',
        message: data.simulation ? 'Simulação local concluída — sem validade clínica.' : '✓ Documento assinado digitalmente com sucesso (ICP-Brasil)!',
      });
      await load();
      if (draft && draft.id === documentId) {
        const today = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Sao_Paulo',
        }).format(new Date());
        setDraft(data.document || {
          ...draft,
          status: 'SIGNED',
          document_date: draft.document_date || today,
          signed_pdf_path: data.signedPdfPath,
        });
        if (data.document) setSaved(JSON.stringify(data.document));
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

  async function requestSncrNumber() {
    if (!draft || draft.kind!=='Receita' || draft.status==='SIGNED') return;
    const current=dirty || draft.version===0 ? await save() : draft;
    if (!current) return;
    ++sncrGeneration.current;
    setBusy(true); setError('');
    try {
      const res=await apiFetch('/api/digital-signature/sncr',{method:'POST',headers:{'Content-Type':'application/json','X-Signature-Action':'1'},body:JSON.stringify({action:'reserve',documentId:current.id})});
      const data=await res.json();
      if (!res.ok) throw new Error(data.error||'Reserva indisponível; consulte o estado antes de repetir.');
      setNumbering(data); setDraft(data.document); setSaved(JSON.stringify(data.document)); clearPreview();
      setSignatureNotice({type:'success',message:'Reserva sintética vinculada. Este fluxo local não emite receita válida.'});
    } catch(e) { setError((e as Error).message); setNumbering({error:'Resultado indisponível ou incerto. Reabra a receita para consultar.'}); }
    finally {setBusy(false);}
  }

  return {
    signatureLabel: signature.label,
    patientCpf: patient.cpf || '',
    patientHasAddress: Boolean(patient.street && patient.city && patient.state),
    rows,
    templates,
    sncrBatches,
    saveTemplate,
    deleteTemplate,
    numbering,
    draft,
    setDraft: (d: ClinicalDocument) => {
      if (numbering.reservation?.document_id===d.id) { setError('Documento com reserva é imutável. Duplique para alterar.'); return; }
      clearPreview();
      setDraft(d);
    },
    error,
    busy,
    dirty,
    preview,
    signatureSession,
    signatureExpired: signatureState.expired,
    signatureNotice,
    signingDocId,
    connectSignature,
    disconnectSignature,
    signTestDocument,
    requestSncrNumber,
    sign,
    load,
    open,
    close,
    save,
    pdf,
  };
}
export type DocumentsController = ReturnType<typeof useDocuments>;
