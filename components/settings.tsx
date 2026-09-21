'use client';
import {
  Activity,
  CalendarDays,
  Users,
  Stethoscope,
  ShieldCheck,
  Palette,
  Check,
  Sparkles,
  Sliders,
} from 'lucide-react';
import { useTheme, THEMES, type ThemeName } from '@/lib/theme';
import { TopBar } from './topbar';
import { NavigationRail } from './navigation-rail';
import type { Patient } from '@/lib/patient-fields';

export default function Settings({
  onPatients,
  onAgenda,
  onTeam,
  onOpenPatient,
}: {
  onPatients: () => void;
  onAgenda: () => void;
  onTeam: () => void;
  onOpenPatient?: (p: Patient) => void;
}) {
  const { theme, setTheme, gradient, setGradient } = useTheme();

  return (
    <div className="app-shell">
      <NavigationRail
        active="settings"
        onAgenda={onAgenda}
        onPatients={onPatients}
        onTeam={onTeam}
      />

      <div className="main-shell">
        <TopBar onSelectPatient={onOpenPatient} />

        <main>
          <div className="breadcrumb">
            <button onClick={onPatients}>Consultório</button>
            <span>›</span>
            <span>Configurações visuais</span>
          </div>

          <section className="listing">
            <div className="listing-heading">
              <div className="eyebrow">PREFERÊNCIAS DO CONSULTÓRIO</div>
              <h1>Aparência e Cores</h1>
              <p>
                Personalize a paleta visual do prontuário e o acabamento dos painéis de acordo com a identidade do seu espaço de atendimento.
              </p>
            </div>

            <div className="settings-content">
              {/* Card 1: Seleção de Paleta */}
              <section className="settings-card">
                <div className="settings-card-header">
                  <div className="settings-header-icon">
                    <Palette size={20} />
                  </div>
                  <div>
                    <h2>Paleta de Cores</h2>
                    <p>
                      Escolha o esquema de cores que melhor combina com a sua rotina médica. A alteração é instantânea.
                    </p>
                  </div>
                </div>

                <div className="theme-grid">
                  {THEMES.map((t) => {
                    const isSelected = theme === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        className={`theme-option-card ${isSelected ? 'selected' : ''}`}
                        onClick={() => setTheme(t.id as ThemeName)}
                      >
                        <div className="theme-preview-bars">
                          <span
                            className="preview-bar-header"
                            style={{ background: t.headerColor }}
                            title="Cabeçalho superior"
                          />
                          <div className="preview-body-row">
                            <span
                              className="preview-bar-rail"
                              style={{ background: t.railColor }}
                              title="Barra lateral"
                            />
                            <div
                              className="preview-bar-content"
                              style={{ background: gradient ? t.bgGradient : t.bgColor }}
                            >
                              <span
                                className="preview-chip-accent"
                                style={{ background: t.accentSoft }}
                              />
                              <span
                                className="preview-btn-primary"
                                style={{ background: t.primaryColor }}
                              />
                            </div>
                          </div>
                        </div>

                        <div className="theme-option-info">
                          <div className="theme-option-title-row">
                            <strong>{t.name}</strong>
                            {isSelected && (
                              <span className="theme-selected-badge">
                                <Check size={12} /> Ativo
                              </span>
                            )}
                          </div>
                          <p>{t.description}</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* Card 2: Estilo dos Painéis e Degradê */}
              <section className="settings-card">
                <div className="settings-card-header">
                  <div className="settings-header-icon">
                    <Sparkles size={20} />
                  </div>
                  <div>
                    <h2>Acabamento dos Painéis</h2>
                    <p>
                      Controle a textura e o degradê de fundo nos cartões de histórico, resumos e painéis informativos.
                    </p>
                  </div>
                </div>

                <div className="gradient-toggle-row">
                  <div className="gradient-toggle-desc">
                    <strong>Degradê Suave nos Painéis de Apoio</strong>
                    <p>
                      Aplica uma transição suave em degradê entre o bege/linho natural e o fundo esverdeado neutro nos cartões e caixas de informação. As áreas de digitação e prontuário permanecem com fundo branco de alto contraste para não cansar a visão clínica.
                    </p>
                  </div>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={gradient}
                    className={`custom-switch ${gradient ? 'checked' : ''}`}
                    onClick={() => setGradient(!gradient)}
                  >
                    <span className="switch-handle" />
                    <span className="switch-text">{gradient ? 'Ativado' : 'Desativado'}</span>
                  </button>
                </div>
              </section>

              {/* Card 3: Demonstração e Prévia */}
              <section className="settings-card preview-sample-card">
                <div className="settings-card-header">
                  <div className="settings-header-icon">
                    <Sliders size={20} />
                  </div>
                  <div>
                    <h2>Prévia do Visual Selecionado</h2>
                    <p>Veja abaixo uma amostra de como os elementos clínicos se comportam com as configurações atuais.</p>
                  </div>
                </div>

                <div className="sample-mockup">
                  <div className="history-card sample-card">
                    <div className="card-heading">
                      <span>Exemplo de Cartão de Histórico</span>
                      <span className="draft-chip">Rascunho Clínico</span>
                    </div>
                    <p className="sample-text">
                      Paciente atendido com queixas de cefaleia tensional. Evolução estável, orientações preventivas e agendamento de retorno registrado.
                    </p>
                    <div className="sample-actions">
                      <button type="button" className="primary">
                        Ação Primária
                      </button>
                      <button type="button" className="secondary">
                        Ação Secundária
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
