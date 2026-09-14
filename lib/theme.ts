'use client';
import { useEffect, useState } from 'react';

export type ThemeName = 'verde' | 'azul' | 'salvia' | 'grafite';

export type ThemeConfig = {
  id: ThemeName;
  name: string;
  description: string;
  railColor: string;
  headerColor: string;
  primaryColor: string;
  accentSoft: string;
};

export const THEMES: ThemeConfig[] = [
  {
    id: 'verde',
    name: 'Verde Clínico',
    description: 'Padrão tradicional de consultório, sóbrio e elegante em tom floresta.',
    railColor: '#143e38',
    headerColor: '#11332a',
    primaryColor: '#24583e',
    accentSoft: '#edf5ed',
  },
  {
    id: 'azul',
    name: 'Azul Hospitalar',
    description: 'Estilo médico hospitalar contemporâneo em tons de azul-marinho profundo.',
    railColor: '#102a3d',
    headerColor: '#0c202f',
    primaryColor: '#1a547e',
    accentSoft: '#eaf2f8',
  },
  {
    id: 'salvia',
    name: 'Sálvia & Linho',
    description: 'Tons orgânicos de verde sálvia com sensação aconchegante e natural.',
    railColor: '#253d32',
    headerColor: '#1d3027',
    primaryColor: '#365b47',
    accentSoft: '#edf3ef',
  },
  {
    id: 'grafite',
    name: 'Grafite & Slate',
    description: 'Visual moderno e neutro em ardósia e chumbo de alta sobriedade.',
    railColor: '#1e293b',
    headerColor: '#0f172a',
    primaryColor: '#334155',
    accentSoft: '#f1f5f9',
  },
];

const STORAGE_THEME = 'psywrite_theme';
const STORAGE_GRADIENT = 'psywrite_gradient';

export function applyTheme(theme: ThemeName, gradient: boolean) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-gradient', String(gradient));
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeName>('verde');
  const [gradient, setGradientState] = useState<boolean>(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    try {
      const savedTheme = (localStorage.getItem(STORAGE_THEME) as ThemeName) || 'verde';
      const savedGradient = localStorage.getItem(STORAGE_GRADIENT) === 'true';
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
