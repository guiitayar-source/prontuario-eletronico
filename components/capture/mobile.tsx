'use client';
// Tela do celular (/celular): fotografar, conferir e enviar páginas para o computador.
// A lógica fica em use-mobile-capture.ts; o editor de tarja, em redact-modal.tsx.
import { useRef } from 'react';
import {
  Activity,
  Camera,
  Upload,
  FileText,
  ArrowUp,
  ArrowDown,
  Trash2,
  Smartphone,
  Check,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { formatBytes } from './client';
import { RedactModal } from './redact-modal';
import { useMobileCapture } from './use-mobile-capture';

export default function MobileCapture() {
  const camera = useRef<HTMLInputElement>(null),
    files = useRef<HTMLInputElement>(null);
  const {
    pair,
    loaded,
    verified,
    current,
    locked,
    stale,
    expired,
    available,
    pages,
    editingPage,
    confirmed,
    sending,
    error,
    message,
    select,
    drop,
    reorder,
    renamePage,
    clear,
    send,
    disconnect,
    reconnect,
    setConfirmed,
    setEditingPageId,
    applyRedaction,
  } = useMobileCapture();
  return (
    <div className="mobile-capture">
      <header>
        <Activity size={23} />
        <span>meu prontuário</span>
        <span className="mobile-pill">Câmera</span>
      </header>
      <main>
        <div className="eyebrow">ANEXAR PELO CELULAR</div>
        <h1>Do papel para o prontuário.</h1>
        <p className="mobile-lead">
          Fotografe, confira e envie para o computador.
        </p>
        {error && (
          <div className="capture-error" role="alert">
            {error}
            <button
              aria-label="Tentar reconectar"
              onClick={reconnect}
            >
              <RefreshCw size={17} />
            </button>
          </div>
        )}
        {message && (
          <p className="capture-message" role="status">
            {message}
          </p>
        )}
        {!pair ? (
          <div className="mobile-wait">
            <Smartphone size={36} />
            <h2>{loaded ? 'Conecte pelo computador' : 'Carregando…'}</h2>
            <p>
              Na página da paciente, abra Exames ou Documentos e clique em
              “Anexar pelo celular”. Leia o QR code com a câmera.
            </p>
          </div>
        ) : (
          <>
            <div className="capture-destination">
              <span>
                DESTINO{' '}
                {locked ? 'FIXADO PARA ESTAS PÁGINAS' : 'DA SOLICITAÇÃO'}
              </span>
              <strong>
                {current?.patient_name || 'Aguardando solicitação…'}
              </strong>
              <small>Paciente vinculado à solicitação</small>
            </div>
            {stale && (
              <div className="capture-error">
                O computador abriu uma nova solicitação. Estas páginas continuam
                vinculadas à anterior e não serão enviadas para outro destino.
              </div>
            )}
            {expired && (
              <div className="capture-error">
                A conexão ou solicitação expirou. Inicie um novo envio no
                computador.
              </div>
            )}
            {available ? (
              <>
                <div className="mobile-capture-actions">
                  <button
                    className="camera-button"
                    disabled={sending || pages.some((p) => p.sent)}
                    onClick={() => camera.current?.click()}
                  >
                    <Camera size={28} />
                    <strong>Tirar foto</strong>
                    <span>Adicione uma página por vez</span>
                  </button>
                  <button
                    className="secondary"
                    disabled={sending || pages.some((p) => p.sent)}
                    onClick={() => files.current?.click()}
                  >
                    <Upload size={18} /> Galeria ou PDF
                  </button>
                  <input
                    ref={camera}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    capture="environment"
                    hidden
                    onChange={(e) => {
                      void select(e.target.files);
                      e.target.value = '';
                    }}
                  />
                  <input
                    ref={files}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,application/pdf"
                    multiple
                    hidden
                    onChange={(e) => {
                      void select(e.target.files);
                      e.target.value = '';
                    }}
                  />
                </div>
                <small className="upload-limits">
                  Até 10 arquivos · 12 MB por arquivo · JPG, PNG, WebP e PDF
                </small>
              </>
            ) : (
              !stale &&
              !expired &&
              verified && (
                <div className="mobile-wait">
                  <Check size={32} />
                  <h2>Pronto para o próximo envio</h2>
                  <p>
                    Deixe esta página aberta. No computador, clique em
                    “Solicitar novo envio” quando precisar.
                  </p>
                </div>
              )
            )}
            {pages.length > 0 && (
              <section className="mobile-pages">
                <h2>
                  Conferir páginas <span className="count">{pages.length}</span>
                </h2>
                <p>
                  Verifique se todo o texto está legível e na ordem correta.
                </p>
                {pages.map((p, i) => (
                  <article className="capture-page" key={p.id}>
                    {p.file.type === 'application/pdf' ? (
                      <div className="pdf-placeholder">
                        <FileText size={34} />
                        <a href={p.url} target="_blank" rel="noreferrer">
                          Conferir PDF
                        </a>
                      </div>
                    ) : (
                      <a href={p.url} target="_blank" rel="noreferrer">
                        <img
                          src={p.url}
                          alt={`Página ${i + 1} — conferir legibilidade`}
                        />
                      </a>
                    )}
                    <div className="capture-page-info">
                      <div className="capture-page-header-row">
                        <span className="capture-page-number">Página {i + 1}</span>
                        <small>
                          {formatBytes(p.file.size)}{' '}
                          {p.sent ? '· Recebido no computador' : ''}
                        </small>
                      </div>

                      <div className="page-name-field">
                        <div className="page-name-input-row">
                          <input
                            type="text"
                            className="page-name-input"
                            disabled={sending || p.sent}
                            value={p.name}
                            placeholder="Nome do exame (ex: Hemograma)"
                            onChange={(e) => renamePage(p.id, e.target.value)}
                          />
                          <span className="page-name-ext">
                            {p.file.name.includes('.')
                              ? p.file.name.slice(p.file.name.lastIndexOf('.'))
                              : ''}
                          </span>
                        </div>

                        <div className="page-name-chips" aria-label="Sugestões de nomes">
                          {[
                            'Hemograma',
                            'Bioquímica',
                            'Urina',
                            'Raio-X',
                            'Tomografia',
                            'Laudo',
                            'Receita',
                          ].map((chip) => (
                            <button
                              key={chip}
                              type="button"
                              disabled={sending || p.sent}
                              className={`page-chip ${p.name === chip ? 'is-selected' : ''}`}
                              onClick={() => renamePage(p.id, chip)}
                            >
                              {chip}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="capture-page-actions-row">
                        {p.file.type.startsWith('image/') ? (
                          <button
                            type="button"
                            className={`redact-trigger-btn ${p.isRedacted ? 'is-redacted' : ''}`}
                            disabled={sending || p.sent}
                            onClick={() => setEditingPageId(p.id)}
                          >
                            {p.isRedacted ? (
                              <>
                                <ShieldCheck size={15} />
                                <span>Tarja aplicada (editar)</span>
                              </>
                            ) : (
                              <>
                                <ShieldAlert size={15} />
                                <span>Ocultar dados (tarja)</span>
                              </>
                            )}
                          </button>
                        ) : (
                          <span />
                        )}

                        <div className="capture-order-btns">
                          <button
                            aria-label={`Subir página ${i + 1}`}
                            disabled={
                              sending || pages.some((x) => x.sent) || i === 0
                            }
                            onClick={() => reorder(i, -1)}
                          >
                            <ArrowUp size={16} />
                          </button>
                          <button
                            aria-label={`Descer página ${i + 1}`}
                            disabled={
                              sending ||
                              pages.some((x) => x.sent) ||
                              i === pages.length - 1
                            }
                            onClick={() => reorder(i, 1)}
                          >
                            <ArrowDown size={16} />
                          </button>
                          <button
                            aria-label={`Remover página ${i + 1}`}
                            disabled={sending || p.sent}
                            onClick={() => drop(p.id)}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
                <label className="confirm-patient">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={sending}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />{' '}
                  Confirmo que estes arquivos pertencem a{' '}
                  {current?.patient_name}.
                </label>
                <button
                  className="primary send-pages"
                  disabled={sending || !confirmed || !available}
                  onClick={send}
                >
                  <Upload size={18} />
                  {sending
                    ? 'Enviando…'
                    : pages.every((p) => p.sent)
                      ? 'Confirmar conclusão'
                      : `Enviar ${pages.filter((p) => !p.sent).length} arquivo(s)`}
                </button>
                <button
                  className="text-button"
                  disabled={sending}
                  onClick={clear}
                >
                  Limpar seleção e acompanhar nova solicitação
                </button>
              </section>
            )}
            <div className="mobile-session">
              <span>
                Conexão temporária
                {pair.expires_at
                  ? ` até ${new Date(pair.expires_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
                  : ''}
              </span>
              <button disabled={sending} onClick={disconnect}>
                Desconectar
              </button>
            </div>
          </>
        )}
      </main>

      {editingPage && (
        <RedactModal
          page={editingPage}
          onClose={() => setEditingPageId(null)}
          onSave={applyRedaction}
        />
      )}
    </div>
  );
}
