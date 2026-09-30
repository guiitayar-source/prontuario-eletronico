'use client';
import { useEffect, useState } from 'react';

export type ThemeName = 'menta' | 'ceu' | 'lavanda' | 'ambar';

export type ThemeConfig = {
  id: ThemeName;
  name: string;
  description: string;
  /** Cor de destaque e segunda cor do degradê, usadas na prévia. */
  accent: string;
  accent2: string;
};

export const THEMES: ThemeConfig[] = [
  {
    id: 'menta',
    name: 'Menta',
    description: 'Verde-menta com brilho azul-petróleo. O padrão do prontuário.',
    accent: '#7fd6a8',
    accent2: '#4fa3c7',
  },
  {
    id: 'ceu',
    name: 'Céu',
    description: 'Azul claro e sereno sobre degradê índigo.',
    accent: '#7cc4e8',
    accent2: '#788cf0',
  },
  {
    id: 'lavanda',
    name: 'Lavanda',
    description: 'Lilás suave com toques de azul, mais acolhedor.',
    accent: '#c7b3f0',
    accent2: '#9dbcff',
  },
  {
    id: 'ambar',
    name: 'Âmbar',
    description: 'Tom quente de âmbar e terracota, para quem prefere calor.',
    accent: '#e8c27c',
    accent2: '#e28c6e',
  },
];

const DEFAULT_THEME: ThemeName = 'menta';
const STORAGE_THEME = 'psywrite_theme';
const STORAGE_GRADIENT = 'psywrite_gradient';

function isThemeName(value: string | null): value is ThemeName {
  return THEMES.some((t) => t.id === value);
}

export function applyTheme(theme: ThemeName, gradient: boolean) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-gradient', String(gradient));
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeName>(DEFAULT_THEME);
  const [gradient, setGradientState] = useState<boolean>(true);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_THEME);
      // Nomes de temas antigos (verde, azul…) caem no padrão.
      const savedTheme = isThemeName(stored) ? stored : DEFAULT_THEME;
      const savedGradient = localStorage.getItem(STORAGE_GRADIENT) !== 'false';
      setThemeState(savedTheme);
      setGradientState(savedGradient);
      applyTheme(savedTheme, savedGradient);
    } catch {
      // localStorage indisponível (privacidade/sandboxed)
    }
    setMounted(true);
  }, []);

  function setTheme(newTheme: ThemeName) {
    setThemeState(newTheme);
    applyTheme(newTheme, gradient);
    try {
      localStorage.setItem(STORAGE_THEME, newTheme);
    } catch {
      // ignore
    }
  }

  function setGradient(newGradient: boolean) {
    setGradientState(newGradient);
    applyTheme(theme, newGradient);
    try {
      localStorage.setItem(STORAGE_GRADIENT, String(newGradient));
    } catch {
      // ignore
    }
  }

  return {
    theme,
    setTheme,
    gradient,
    setGradient,
    mounted,
  };
}
