'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/supabase/http';
import {
  ShieldCheck,
  AlertTriangle,
  X,
  Copy,
  Check,
  RefreshCw,
  FileText,
  Lock,
  ExternalLink,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import type { EvolutionVerificationResult } from '@/lib/signature/types';

interface EvolutionSignatureDetailsModalProps {
  evolutionId: string;
  onClose: () => void;
}

export function EvolutionSignatureDetailsModal({
  evolutionId,
  onClose,
}: EvolutionSignatureDetailsModalProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [verification, setVerification] =
    useState<EvolutionVerificationResult | null>(null);
  const [copiedHash, setCopiedHash] = useState(false);
  const [showCanonicalJson, setShowCanonicalJson] = useState(false);

  async function loadDetails() {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(
        `/api/digital-signature/evolution-details?evolutionId=${encodeURIComponent(evolutionId)}`
      );
      const data = (await res.json()) as {
        verification?: EvolutionVerificationResult;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(data.error || 'Falha ao carregar detalhes da assinatura.');
      }
      setVerification(data.verification || null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Erro ao verificar assinatura digital.'
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadDetails();
  }, [evolutionId]);

  function copyToClipboard(textToCopy: string) {
    void navigator.clipboard.writeText(textToCopy);
    setCopiedHash(true);
    setTimeout(() => setCopiedHash(false), 2000);
  }

  const formatDate = (d: string | Date | undefined) => {
    if (!d) return '—';
    return new Date(d).toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      dateStyle: 'medium',
      timeStyle: 'medium',
    });
  };

  const formatCpf = (cpf: string | null | undefined) => {
    if (!cpf) return 'Não identificado';
    const clean = cpf.replace(/\D/g, '');
    if (clean.length !== 11) return cpf;
    return clean.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  };

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="modal signature-audit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="signature-dialog-title"
      >
        <button
          className="close"
          aria-label="Fechar modal de assinatura"
          onClick={onClose}
        >
          <X size={20} />
        </button>

        <div className="signature-modal-header">
          <div className="signature-modal-icon-badge">
            <ShieldCheck size={28} />
          </div>
          <div>
            <h2 id="signature-dialog-title">Assinatura Digital ICP-Brasil</h2>
            <p className="signature-modal-subtitle">
              Registro Eletrônico Nativo de Prontuário • Assinado com Certificado em Nuvem Bird ID
            </p>
          </div>
        </div>

        {loading ? (
          <div className="signature-loading-state">
            <RefreshCw size={24} className="spin" />
            <p>Verificando integridade criptográfica da evolução…</p>
          </div>
        ) : error ? (
          <div className="signature-error-state">
            <AlertTriangle size={24} />
            <div>
              <strong>Não foi possível validar a assinatura</strong>
              <p>{error}</p>
            </div>
            <button className="secondary" onClick={() => void loadDetails()}>
              Tentar novamente
            </button>
          </div>
        ) : verification ? (
          <div className="signature-audit-content">
            {verification.isValid ? (
              <div className="signature-status-banner valid">
                <div className="status-badge-icon">
                  <Check size={18} />
                </div>
                <div>
                  <strong>Assinatura Válida e Íntegra</strong>
                  <p>
                    O resumo criptográfico (SHA-256) dos dados atuais confere
                    integralmente com a assinatura CMS registrada. O registro não
                    sofreu nenhuma alteração posterior.
                  </p>
                </div>
              </div>
            ) : (
              <div className="signature-status-banner invalid">
                <div className="status-badge-icon">
                  <AlertTriangle size={18} />
                </div>
                <div>
                  <strong>Falha na Verificação de Integridade</strong>
                  <p>
                    {verification.error ||
                      'O conteúdo da evolução ou metadados divergem do registro assinado.'}
                  </p>
                </div>
              </div>
            )}

            <div className="signature-details-grid">
              <div className="signature-detail-group">
                <div className="detail-group-title">
                  <Lock size={15} /> Signatário (Titular ICP-Brasil)
                </div>
                <div className="detail-row">
                  <span className="detail-label">Nome:</span>
                  <span className="detail-value font-medium">
                    {verification.signerName}
                  </span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">CPF:</span>
                  <span className="detail-value">
                    {formatCpf(verification.signerCpf)}
                  </span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Data e Hora da Assinatura:</span>
                  <span className="detail-value">
                    {formatDate(verification.signedAt)} (Horário de Brasília)
                  </span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Subject DN:</span>
                  <span className="detail-value small-mono">
                    {verification.certificateSubject}
                  </span>
                </div>
              </div>

              <div className="signature-detail-group">
                <div className="detail-group-title">
                  <FileText size={15} /> Certificado Digital X.509
                </div>
                <div className="detail-row">
                  <span className="detail-label">Autoridade Certificadora:</span>
                  <span className="detail-value">
                    {verification.certificateIssuer}
                  </span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Número de Série:</span>
                  <span className="detail-value small-mono">
                    {verification.certificateSerial || 'Disponível na cadeia'}
                  </span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Validade do Certificado:</span>
                  <span className="detail-value">
                    {formatDate(verification.validFrom)} até{' '}
                    {formatDate(verification.validTo)}
                  </span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Fingerprint (SHA-256):</span>
                  <span className="detail-value small-mono">
                    {verification.certificateFingerprint}
                  </span>
                </div>
              </div>

              <div className="signature-detail-group full-width">
                <div className="detail-group-title">
                  <ShieldCheck size={15} /> Operação Criptográfica & Integridade
                </div>
                <div className="detail-row">
                  <span className="detail-label">Padrão da Assinatura:</span>
                  <span className="detail-value">
                    CMS / PKCS#7 Detached (Conforme DOC-ICP-01 e RFC 5652)
                  </span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Provedor Remoto:</span>
                  <span className="detail-value">
                    Bird ID Cloud HSM (Soluti Certificadora)
                  </span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Algoritmo de Digest:</span>
                  <span className="detail-value">SHA-256</span>
                </div>
                <div className="detail-row hash-row">
                  <div className="hash-header">
                    <span className="detail-label">
                      Hash SHA-256 da Representação Canônica:
                    </span>
                    <button
                      type="button"
                      className="copy-hash-btn"
                      onClick={() => copyToClipboard(verification.documentHash)}
                      title="Copiar hash SHA-256"
                    >
                      {copiedHash ? (
                        <>
                          <Check size={13} /> Copiado!
                        </>
                      ) : (
                        <>
                          <Copy size={13} /> Copiar Hash
                        </>
                      )}
                    </button>
                  </div>
                  <div className="hash-box">{verification.documentHash}</div>
                </div>
              </div>
            </div>

            {verification.canonicalData && (
              <div className="canonical-inspection-section">
                <button
                  type="button"
                  className="canonical-toggle-btn"
                  onClick={() => setShowCanonicalJson(!showCanonicalJson)}
                >
                  <span>
                    Inspecionar dados canônicos assinados (schema_version:{' '}
                    {(verification.canonicalData as { schema_version?: number })
                      .schema_version || 1}
                    )
                  </span>
                  {showCanonicalJson ? (
                    <ChevronUp size={16} />
                  ) : (
                    <ChevronDown size={16} />
                  )}
                </button>

                {showCanonicalJson && (
                  <pre className="canonical-json-viewer">
                    {JSON.stringify(verification.canonicalData, null, 2)}
                  </pre>
                )}
              </div>
            )}

            <div className="legal-immutability-note">
              <p>
                <strong>Garantia de Imutabilidade Jurídica:</strong> Esta
                evolução clínica é um registro nativo protegido por restrições
                em nível de banco de dados (triggers de imutabilidade). Conforme a
                MP 2.200-2/2001 e Resoluções CFM, nenhuma alteração ou exclusão é
                permitida. Informações complementares devem ser registradas via
                adendos.
              </p>
            </div>
          </div>
        ) : null}

        <footer className="signature-modal-footer">
          <button
            type="button"
            className="secondary"
            onClick={() => void loadDetails()}
            disabled={loading}
          >
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
            Revalidar integridade
          </button>
          <button type="button" className="primary" onClick={onClose}>
            Fechar
          </button>
        </footer>
      </section>
    </div>
  );
}
