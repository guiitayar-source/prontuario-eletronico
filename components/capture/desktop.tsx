'use client';
import Exams from '@/components/exams';
import {
  Smartphone,
  X,
  Link,
  FileText,
  Pill,
  Download,
  Upload,
  Trash2,
  Image as ImageIcon,
  ScanText,
} from 'lucide-react';
import { categoryNames, formatBytes, type Received } from './client';
import { useAttachments, type AttachmentsProps } from './use-attachments';

export default function Attachments({
  tab,
  setTab,
  newDocument,
  newPrescription,
  canCreateDocument = true,
  patient,
}: AttachmentsProps) {
  const {
    isOwner,
    isDoctor,
    files,
    pair,
    archived,
    setArchived,
    purgeConfirm,
    setPurgeConfirm,
    loadArchived,
    restore,
    request,
    connected,
    dialog,
    setDialog,
    qr,
    link,
    error,
    setError,
    busy,
    message,
    setMessage,
    filter,
    setFilter,
    preview,
    setPreview,
    remove,
    setRemove,
    closeRef,
    desktopFiles,
    connect,
    disconnect,
    uploadFromDesktop,
    uploadSingleExam,
    classify,
    deleteFile,
    purgeFile,
    open,
    transcribe,
    pending,
    accepted,
    visible,
    expired,
    modalKey,
    requestExpired,
  } = useAttachments({
    tab,
    setTab,
    newDocument,
    newPrescription,
    canCreateDocument,
    patient,
  });
  function row(file: Received) {
    return (
      <article className="received-file" key={file.id}>
        <div className="file-symbol">
          {file.mime === 'application/pdf' ? <FileText /> : <ImageIcon />}
        </div>
        <div className="file-detail">
          <button
            className="file-name"
            disabled={busy}
            onClick={() => open(file)}
          >
            {file.name}
          </button>
          <small>
            {new Date(file.created_at).toLocaleString('pt-BR')} ·{' '}
            {formatBytes(file.size)}
          </small>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
            <span className="file-category" style={{ margin: 0 }}>{categoryNames[file.category]}</span>
            {file.category === 'exam' && (
              <span
                style={{
                  fontSize: '11px',
                  padding: '1px 6px',
                  borderRadius: '4px',
                  background: file.has_exams ? 'var(--accent-soft)' : 'var(--warning-soft)',
                  color: file.has_exams ? 'var(--success)' : 'var(--warning)',
                  fontWeight: 500,
                }}
              >
                {file.has_exams ? 'Exames preenchidos' : 'Sem exames preenchidos'}
              </span>
            )}
          </div>
        </div>
        <select
          aria-label={`Classificar ${file.name}`}
          disabled={busy}
          value={file.category}
          onChange={(e) => classify(file, e.target.value)}
        >
          <option value="pending" disabled>
            A conferir
          </option>
          <option value="exam">Exame</option>
          <option value="report">Relatório externo</option>
          <option value="other">Outro documento</option>
        </select>
        {tab === 'documentos' &&
          canCreateDocument &&
          ['report', 'other'].includes(file.category) && (
            <button
              type="button"
              className="secondary ai-file-action"
              disabled={busy}
              onClick={() => void transcribe(file)}
            >
              <ScanText size={16} /> Transcrever
            </button>
          )}
        {canCreateDocument && (
          <button
            className="icon-btn"
            disabled={busy}
            aria-label={`Arquivar ${file.name}`}
            onClick={() => setRemove(file)}
          >
            <Trash2 size={18} />
          </button>
        )}
      </article>
    );
  }
  return (
    <section
      className="attachments-area"
      hidden={tab !== 'exames' && tab !== 'documentos'}
    >
      {tab === 'exames' && canCreateDocument && (
        <Exams
          key={patient.id}
          patientId={patient.id}
          attachments={files.filter((f) => f.category === 'exam')}
          onUploadAttachment={uploadSingleExam}
        />
      )}
      <div className="attachments-heading">
        <div>
          <div className="eyebrow">
            {patient.name} · CADASTRO DE DEMONSTRAÇÃO
          </div>
          <h2>{tab === 'exames' ? 'Resultados recebidos' : 'Documentos'}</h2>
          <p>
            {tab === 'exames'
              ? 'Fotografe no celular. Confira e organize aqui.'
              : 'Relatórios externos e outros arquivos do atendimento.'}
          </p>
        </div>
        <div className="attachment-buttons">
          {tab === 'documentos' && canCreateDocument && (
            <button className="secondary" onClick={() => newDocument()}>
              <FileText size={16} /> Novo documento
            </button>
          )}
          {tab === 'documentos' && canCreateDocument && newPrescription && (
            <button className="secondary" onClick={newPrescription}>
              <Pill size={16} /> Nova receita
            </button>
          )}
          <button className="primary" disabled={busy} onClick={connect}>
            <Smartphone size={17} />
            {pair && !expired ? 'Solicitar novo envio' : 'Anexar pelo celular'}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => desktopFiles.current?.click()}
          >
            <Upload size={16} /> Anexar arquivo
          </button>
          <input
            ref={desktopFiles}
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            multiple
            hidden
            onChange={(event) => void uploadFromDesktop(event.target.files)}
          />
        </div>
      </div>
      <div className="capture-notice">
        Os anexos ficam preservados no armazenamento privado. O arquivamento permite
        recuperá-los.
      </div>
      {canCreateDocument && (
        <div style={{ marginTop: '16px' }}>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => (archived ? setArchived(null) : loadArchived())}
          >
            {archived ? 'Fechar arquivados' : 'Ver anexos arquivados'}
          </button>
          {archived && (
            <section aria-label="Anexos arquivados" style={{ marginTop: '12px' }}>
              {!archived.length && <p>Nenhum anexo arquivado.</p>}
              {archived.map((file) => {
                const canPurge = isOwner || (isDoctor && Boolean(file.has_exams));
                return (
                  <div
                    key={file.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 12px',
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: '6px',
                      marginBottom: '8px',
                      gap: '12px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div>
                      <strong>{file.name}</strong>{' '}
                      <small style={{ color: 'var(--text-subtle)' }}>
                        ({formatBytes(file.size)}) · {categoryNames[file.category]}
                      </small>
                      {file.category === 'exam' && (
                        <span
                          style={{
                            marginLeft: '8px',
                            fontSize: '11px',
                            padding: '2px 6px',
                            borderRadius: '4px',
                            background: file.has_exams ? 'var(--accent-soft)' : 'var(--warning-soft)',
                            color: file.has_exams ? 'var(--success)' : 'var(--warning)',
                          }}
                        >
                          {file.has_exams ? 'Exames preenchidos' : 'Sem exames preenchidos'}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => restore(file)}
                      >
                        Restaurar
                      </button>
                      {canPurge ? (
                        <button
                          className="secondary"
                          style={{ color: 'var(--danger)', borderColor: 'var(--danger-border)' }}
                          disabled={busy}
                          onClick={() => setPurgeConfirm(file)}
                          title="Excluir permanentemente do banco e armazenamento"
                        >
                          <Trash2 size={14} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
                          Excluir definitivamente
                        </button>
                      ) : (
                        isDoctor && (
                          <span
                            style={{ fontSize: '11px', color: 'var(--text-subtle)' }}
                            title="Preencha os resultados do exame no sistema para liberar a exclusão definitiva ou solicite ao administrador"
                          >
                            Exclusão requer exames preenchidos
                          </span>
                        )
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          )}
        </div>
      )}
      {error && (
        <div className="capture-error" role="alert">
          {error}
          <button onClick={() => setError('')} aria-label="Fechar aviso">
            <X size={15} />
          </button>
        </div>
      )}
      {message && (
        <p className="capture-message" role="status">
          {message}
        </p>
      )}
      {pair && (
        <div className="connection-strip">
          <Smartphone size={20} />
          <div>
            <strong>
              {expired
                ? 'Conexão expirada'
                : connected
                  ? 'Celular conectado'
                  : 'Aguardando celular'}
            </strong>
            <small>
              {expired
                ? 'Conecte novamente para enviar anexos.'
                : request?.state === 'complete'
                  ? 'Envio concluído. Solicite outro quando precisar.'
                  : requestExpired
                    ? 'Solicitação expirada. Inicie um novo envio.'
                    : `Destino: ${request?.patient_name || patient.name} · solicitação válida até ${request ? new Date(request.expires_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—'}`}
            </small>
          </div>
          <button className="secondary" onClick={() => setDialog(true)}>
            Ver conexão
          </button>
          <button className="text-button" disabled={busy} onClick={disconnect}>
            Desconectar
          </button>
        </div>
      )}
      {pending.length > 0 && (
        <section className="received-section">
          <h3>
            A conferir <span className="count">{pending.length}</span>
          </h3>
          <p>
            Recebidos do celular para {patient.name}. Abra e escolha onde
            guardar cada arquivo.
          </p>
          {pending.map(row)}
        </section>
      )}
      <section className="received-section">
        <div className="files-heading">
          <h3>
            {tab === 'exames' ? 'Exames anexados' : 'Arquivos anexados'}{' '}
            <span className="count">{accepted.length}</span>
          </h3>
          {tab === 'documentos' && (
            <select
              aria-label="Filtrar documentos"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">Todos</option>
              <option value="report">Relatórios externos</option>
              <option value="other">Outros documentos</option>
            </select>
          )}
        </div>
        {visible.length ? (
          visible.map(row)
        ) : (
          <div className="attachments-empty">
            <div className="empty-icon">
              {tab === 'exames' ? (
                <ImageIcon size={28} />
              ) : (
                <FileText size={28} />
              )}
            </div>
            <h3>
              {tab === 'exames'
                ? 'Os resultados ficam reunidos aqui'
                : 'Seus documentos em um só lugar'}
            </h3>
            <p>
              Conecte o celular para fotografar páginas ou enviar PDFs.
              <br />
              Você confere os arquivos antes de classificá-los.
            </p>
            <button className="secondary" disabled={busy} onClick={connect}>
              <Smartphone size={16} />{' '}
              {pair && !expired ? 'Solicitar envio' : 'Conectar celular'}
            </button>
          </div>
        )}
      </section>
      {tab === 'exames' && (
        <button className="text-button" onClick={() => setTab('documentos')}>
          Ver relatórios externos e outros documentos →
        </button>
      )}
      {(dialog || preview || remove || purgeConfirm) && (
        <div className="modal-backdrop">
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- onKeyDown prende o foco dentro do diálogo */}
          <section
            className={`modal ${preview ? 'file-preview-modal' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="capture-title"
            onKeyDown={modalKey}
          >
            <button
              ref={closeRef}
              className="close"
              aria-label="Fechar"
              onClick={() => {
                setDialog(false);
                setPreview(null);
                setRemove(null);
                setPurgeConfirm(null);
              }}
            >
              <X size={20} />
            </button>
            {preview ? (
              <>
                <h2 id="capture-title">{preview.file.name}</h2>
                {preview.file.mime === 'application/pdf' ? (
                  <iframe title="Prévia do PDF" src={preview.url} sandbox="" />
                ) : (
                  <img
                    className="received-preview"
                    alt={`Anexo ${preview.file.name}`}
                    src={preview.url}
                  />
                )}
                <a
                  className="secondary"
                  href={preview.url}
                  download={preview.file.name}
                >
                  <Download size={16} /> Baixar arquivo
                </a>
              </>
            ) : purgeConfirm ? (
              <>
                <h2 id="capture-title">Excluir anexo definitivamente?</h2>
                <p><strong>{purgeConfirm.name}</strong> ({formatBytes(purgeConfirm.size)})</p>
                <p>
                  O arquivo físico será removido permanentemente do armazenamento e do banco de dados para liberar espaço. Esta ação não poderá ser desfeita.
                </p>
                {error && <p role="alert" style={{ color: 'var(--danger)', margin: '8px 0' }}>{error}</p>}
                <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                  <button
                    className="primary danger"
                    style={{ margin: 0, background: 'var(--danger)' }}
                    disabled={busy}
                    onClick={() => purgeFile(purgeConfirm)}
                  >
                    Confirmar exclusão definitiva
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setPurgeConfirm(null);
                      setError('');
                    }}
                  >
                    Cancelar
                  </button>
                </div>
              </>
            ) : remove ? (
              <>
                <h2 id="capture-title">Remover este anexo?</h2>
                <p><strong>{remove.name}</strong> ({formatBytes(remove.size)})</p>
                {remove.category === 'exam' && (
                  <p style={{ fontSize: '13px', color: remove.has_exams ? 'var(--success)' : 'var(--warning)', margin: '8px 0' }}>
                    {remove.has_exams
                      ? '✓ Os resultados deste exame já estão registrados no prontuário.'
                      : 'ℹ Esta foto ainda não possui resultados de exames preenchidos no prontuário.'}
                  </p>
                )}
                <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '12px' }}>
                    <strong style={{ display: 'block', marginBottom: '4px' }}>Arquivar anexo (recomendado)</strong>
                    <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
                      O arquivo sairá da lista ativa, mas será preservado com segurança e poderá ser restaurado a qualquer momento.
                    </p>
                    <button
                      className="secondary"
                      style={{ marginTop: '10px' }}
                      disabled={busy}
                      onClick={deleteFile}
                    >
                      Arquivar anexo
                    </button>
                  </div>
                  <div style={{ border: '1px solid var(--danger-border)', borderRadius: '8px', padding: '12px', background: 'var(--danger-soft)' }}>
                    <strong style={{ display: 'block', marginBottom: '4px', color: 'var(--danger)' }}>Excluir definitivamente (liberar espaço)</strong>
                    <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-muted)' }}>
                      {isOwner
                        ? 'Como administrador, você pode excluir permanentemente do banco e do armazenamento para economizar espaço.'
                        : remove.has_exams
                          ? 'Como os exames já estão preenchidos, você pode apagar a foto para economizar espaço no armazenamento.'
                          : 'A exclusão definitiva pelo médico só é permitida após os exames estarem preenchidos no prontuário (ou por um administrador).'}
                    </p>
                    {(isOwner || (isDoctor && remove.has_exams)) ? (
                      <button
                        className="primary danger"
                        style={{ marginTop: '10px', background: 'var(--danger)' }}
                        disabled={busy}
                        onClick={() => purgeFile(remove)}
                      >
                        Excluir definitivamente
                      </button>
                    ) : (
                      <button
                        className="secondary"
                        style={{ marginTop: '10px', opacity: 0.6 }}
                        disabled
                        title="Preencha os exames antes de excluir definitivamente"
                      >
                        Exclusão bloqueada (preencha o exame antes)
                      </button>
                    )}
                  </div>
                </div>
                {error && <p role="alert" style={{ color: 'var(--danger)', marginTop: '12px' }}>{error}</p>}
              </>
            ) : (
              <>
                <div className="modal-icon">
                  <Smartphone />
                </div>
                <h2 id="capture-title">Seu celular, conectado</h2>
                <p>
                  Leia o QR code com a câmera e entre com a mesma conta
                  autorizada do site. Mantenha a página aberta para os próximos
                  envios.
                </p>
                {qr && !expired && (
                  <img
                    className="pair-qr"
                    src={qr}
                    alt="QR code para conectar o celular"
                  />
                )}
                <div className="capture-destination">
                  <span>DESTINO DESTE ENVIO</span>
                  <strong>{request?.patient_name || patient.name}</strong>
                  <small>Paciente vinculado à solicitação</small>
                </div>
                <p className="pair-status">
                  {expired
                    ? 'Conexão expirada.'
                    : connected
                      ? 'Celular conectado. Pode fotografar.'
                      : 'Aguardando conexão do celular…'}
                </p>
                <small>
                  A conexão dura até 2 horas. Cada solicitação de envio dura 15
                  minutos.
                </small>
                <div className="pair-actions">
                  <button
                    className="secondary"
                    disabled={expired}
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(link);
                        setMessage('Link de conexão copiado.');
                      } catch {
                        setMessage('Abra o link abaixo ou leia o QR code.');
                      }
                    }}
                  >
                    <Link size={15} /> Copiar link
                  </button>
                  <a href={link} target="_blank" rel="noreferrer">
                    Abrir tela do celular
                  </a>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={disconnect}
                  >
                    Desconectar
                  </button>
                </div>
                {message && <p role="status">{message}</p>}
                {error && <p role="alert">{error}</p>}
              </>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
