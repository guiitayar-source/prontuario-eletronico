'use client';
import { useEffect, useState } from 'react';

export type ThemeName = 'menta' | 'ceu' | 'lavanda' | 'ambar';

/** Escolha do usuário. `system` segue o claro/escuro do sistema operacional. */
export type ThemeMode = 'dark' | 'light' | 'system';

export type ThemeConfig = {
  id: ThemeName;
  name: string;
  description: string;
  /** Cor de destaque e segunda cor do degradê, usadas na prévia (modo escuro). */
  accent: string;
  accent2: string;
  /** Cor de destaque no modo claro: o mesmo tom, mais fechado (ver tokens.css). */
  accentLight: string;
};

export const THEMES: ThemeConfig[] = [
  {
    id: 'menta',
    name: 'Menta',
    description: 'Verde-menta com brilho azul-petróleo. O padrão do prontuário.',
    accent: '#7fd6a8',
    accent2: '#4fa3c7',
    accentLight: '#23805a',
  },
  {
    id: 'ceu',
    name: 'Céu',
    description: 'Azul claro e sereno sobre degradê índigo.',
    accent: '#7cc4e8',
    accent2: '#788cf0',
    accentLight: '#1f74a8',
  },
  {
    id: 'lavanda',
    name: 'Lavanda',
    description: 'Lilás suave com toques de azul, mais acolhedor.',
    accent: '#c7b3f0',
    accent2: '#9dbcff',
    accentLight: '#6c4fc0',
  },
  {
    id: 'ambar',
    name: 'Âmbar',
    description: 'Tom quente de âmbar e terracota, para quem prefere calor.',
    accent: '#e8c27c',
    accent2: '#e28c6e',
    accentLight: '#9a6410',
  },
];

export const MODES: { id: ThemeMode; name: string }[] = [
  { id: 'dark', name: 'Escuro' },
  { id: 'light', name: 'Claro' },
  { id: 'system', name: 'Automático' },
];

const DEFAULT_THEME: ThemeName = 'menta';
const DEFAULT_MODE: ThemeMode = 'dark';
const STORAGE_THEME = 'psywrite_theme';
const STORAGE_GRADIENT = 'psywrite_gradient';
const STORAGE_MODE = 'psywrite_mode';
const LIGHT_QUERY = '(prefers-color-scheme: light)';

function isThemeName(value: string | null): value is ThemeName {
  return THEMES.some((t) => t.id === value);
}

function isThemeMode(value: string | null): value is ThemeMode {
  return MODES.some((m) => m.id === value);
}

/** Converte a escolha em claro/escuro de fato. */
export function resolveMode(mode: ThemeMode): 'dark' | 'light' {
  if (mode !== 'system') return mode;
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia(LIGHT_QUERY).matches ? 'light' : 'dark';
}

export function applyTheme(theme: ThemeName, gradient: boolean, mode: ThemeMode = DEFAULT_MODE) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-gradient', String(gradient));
  root.setAttribute('data-mode', resolveMode(mode));
}

// O script inline do <head> (app/layout.tsx) repete esta lógica antes da primeira
// pintura; ao mudar chaves do localStorage ou o padrão, ajuste lá também.

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeName>(DEFAULT_THEME);
  const [gradient, setGradientState] = useState<boolean>(true);
  const [mode, setModeState] = useState<ThemeMode>(DEFAULT_MODE);
  const [resolvedMode, setResolvedMode] = useState<'dark' | 'light'>('dark');
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_THEME);
      // Nomes de temas antigos (verde, azul…) caem no padrão.
      const savedTheme = isThemeName(stored) ? stored : DEFAULT_THEME;
      const savedGradient = localStorage.getItem(STORAGE_GRADIENT) !== 'false';
      const storedMode = localStorage.getItem(STORAGE_MODE);
      const savedMode = isThemeMode(storedMode) ? storedMode : DEFAULT_MODE;
      setThemeState(savedTheme);
      setGradientState(savedGradient);
      setModeState(savedMode);
      setResolvedMode(resolveMode(savedMode));
      applyTheme(savedTheme, savedGradient, savedMode);
    } catch {
      // localStorage indisponível (privacidade/sandboxed)
    }
    setMounted(true);
  }, []);

  // No modo automático, acompanha a troca de claro/escuro do sistema.
  useEffect(() => {
    if (mode !== 'system' || typeof window === 'undefined' || !window.matchMedia) return;
    const query = window.matchMedia(LIGHT_QUERY);
    const onChange = () => {
      setResolvedMode(resolveMode('system'));
      document.documentElement.setAttribute('data-mode', resolveMode('system'));
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [mode]);

  function setTheme(newTheme: ThemeName) {
    setThemeState(newTheme);
    applyTheme(newTheme, gradient, mode);
    try {
      localStorage.setItem(STORAGE_THEME, newTheme);
    } catch {
      // ignore
    }
  }

  function setGradient(newGradient: boolean) {
    setGradientState(newGradient);
    applyTheme(theme, newGradient, mode);
    try {
      localStorage.setItem(STORAGE_GRADIENT, String(newGradient));
    } catch {
      // ignore
    }
  }

  function setMode(newMode: ThemeMode) {
    setModeState(newMode);
    setResolvedMode(resolveMode(newMode));
    applyTheme(theme, gradient, newMode);
    try {
      localStorage.setItem(STORAGE_MODE, newMode);
    } catch {
      // ignore
    }
  }

  return {
    theme,
    setTheme,
    gradient,
    setGradient,
    mode,
    setMode,
    resolvedMode,
    mounted,
  };
}
