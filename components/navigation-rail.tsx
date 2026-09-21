'use client';
import { useAccess } from './auth';
import {
  Activity,
  CalendarDays,
  Users,
  Stethoscope,
  ShieldCheck,
  Palette,
  Upload,
} from 'lucide-react';

export type NavigationItem =
  | 'agenda'
  | 'patients'
  | 'consultation'
  | 'team'
  | 'imports'
  | 'settings';

export type NavigationRailProps = {
  active: NavigationItem;
  onAgenda?: () => void;
  onPatients?: () => void;
  onConsultation?: () => void;
  onTeam?: () => void;
  onImports?: () => void;
  onSettings?: () => void;
  disabled?: boolean;
  roleLabelOverride?: string;
};

const defaultRoleLabels: Record<string, string> = {
  owner: 'Proprietário',
  doctor: 'Médico',
  secretary: 'Secretária',
};

export function NavigationRail({
  active,
  onAgenda,
  onPatients,
  onConsultation,
  onTeam,
  onImports,
  onSettings,
  disabled = false,
  roleLabelOverride,
}: NavigationRailProps) {
  const { role } = useAccess();
  const displayRole =
    roleLabelOverride || defaultRoleLabels[role] || (role ? role : 'Médico');

  return (
    <aside className="rail">
      <div className="brand">
        <Activity size={23} />
      </div>
      <nav aria-label="Navegação principal">
        <button
          className={active === 'agenda' ? 'nav-item active' : 'nav-item'}
          onClick={active !== 'agenda' ? onAgenda : undefined}
          disabled={disabled || (active !== 'agenda' && !onAgenda)}
          aria-current={active === 'agenda' ? 'page' : undefined}
        >
          <CalendarDays size={21} />
          <span>Agenda</span>
        </button>

        <button
          className={active === 'patients' ? 'nav-item active' : 'nav-item'}
          onClick={active !== 'patients' ? onPatients : undefined}
          disabled={disabled || (active !== 'patients' && !onPatients)}
          aria-current={active === 'patients' ? 'page' : undefined}
        >
          <Users size={21} />
          <span>Pacientes</span>
        </button>

        <button
          className={active === 'consultation' ? 'nav-item active' : 'nav-item'}
          onClick={
            active !== 'consultation'
              ? onConsultation || onPatients
              : undefined
          }
          disabled={
            disabled ||
            (active !== 'consultation' && !onConsultation && !onPatients)
          }
          aria-current={active === 'consultation' ? 'page' : undefined}
        >
          <Stethoscope size={21} />
          <span>Consulta</span>
        </button>

        {(onTeam || active === 'team') && (
          <button
            className={active === 'team' ? 'nav-item active' : 'nav-item'}
            onClick={active !== 'team' ? onTeam : undefined}
            disabled={disabled || (active !== 'team' && !onTeam)}
            aria-current={active === 'team' ? 'page' : undefined}
          >
            <ShieldCheck size={21} />
            <span>Equipe</span>
          </button>
        )}

        {active === 'imports' && (
          <button className="nav-item active" aria-current="page">
            <Upload size={21} />
            <span>Importar</span>
          </button>
        )}

        {(onSettings || active === 'settings') && (
          <button
            className={active === 'settings' ? 'nav-item active' : 'nav-item'}
            onClick={active !== 'settings' ? onSettings : undefined}
            disabled={disabled || (active !== 'settings' && !onSettings)}
            aria-current={active === 'settings' ? 'page' : undefined}
          >
            <Palette size={21} />
            <span>Ajustes</span>
          </button>
        )}
      </nav>
      <div className="rail-bottom">
        <span className="avatar doctor">G</span>
        <span>{displayRole}</span>
      </div>
    </aside>
  );
}

export default NavigationRail;
