'use client';
import {
  Palette,
  Check,
  Sparkles,
  Sliders,
} from 'lucide-react';
import { useTheme, THEMES, type ThemeName } from '@/lib/theme';
import { NavigationRail } from './navigation-rail';
import { useAccess } from './auth';
import { ProfessionalProfileCard } from './professional-profile';

export default function Settings({
  onPatients,
  onAgenda,
  onTeam,
}: {
  onPatients: () => void;
  onAgenda: () => void;
  onTeam: () => void;
}) {
  const { theme, setTheme, gradient, setGradient } = useTheme();
  const medical = ['owner', 'doctor'].includes(useAccess().role);

  return (
    <div className="app-shell">
      <NavigationRail
        active="settings"
        onAgenda={onAgenda}
        onPatients={onPatients}
        onTeam={onTeam}
      />

      <div className="main-shell">

        <main>
          <div className="breadcrumb">
            <button onClick={onPatients}>Consultório</button>
            <span>›</span>
            <span>Ajustes</span>
          </div>

          <section className="listing">
            <div className="listing-heading">
              <div className="eyebrow">PREFERÊNCIAS</div>
              <h1>Ajustes</h1>
              <p>
                Seus dados profissionais e a aparência do prontuário.
              </p>
            </div>

            <div className="settings-content">
              {medical && <ProfessionalProfileCard />}

              {/* Card 1: Seleção de Paleta */}
              <section className="settings-card">
                <div className="settings-card-header">
                  <div className="settings-header-icon">
                    <Palette size={20} />
                  </div>
                  <div>
                    <h2>Cor de destaque</h2>
                    <p>
                      Define a cor dos botões, do item ativo no menu e do brilho do fundo. A alteração é instantânea.
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
                        aria-label={`Tema ${t.name}`}
                        aria-pressed={isSelected}
                        onClick={() => setTheme(t.id as ThemeName)}
                      >
                        <div
                          className="theme-preview"
                          style={{
                            backgroundImage: gradient
                              ? `radial-gradient(at 0% 0%, ${t.accent}55, transparent 60%), radial-gradient(at 100% 100%, ${t.accent2}55, transparent 60%)`
                              : 'none',
                          }}
                          aria-hidden
                        >
                          <span className="theme-preview-rail">
                            <span style={{ background: t.accent }} />
                          </span>
                          <span className="theme-preview-card">
                            <span className="theme-preview-line" />
                            <span className="theme-preview-line short" />
                            <span
                              className="theme-preview-btn"
                              style={{ background: t.accent }}
                            />
                          </span>
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
                    <h2>Fundo</h2>
                    <p>
                      Liga ou desliga o degradê atrás dos painéis de vidro.
                    </p>
                  </div>
                </div>

                <div className="gradient-toggle-row">
                  <div className="gradient-toggle-desc">
                    <strong>Degradê no fundo</strong>
                    <p>
                      Com o degradê desligado, o fundo fica escuro e liso, com menos distração.
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
