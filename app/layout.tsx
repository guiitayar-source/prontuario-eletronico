import type { Metadata } from 'next';
import './globals.css';
import AuthGate from '@/components/auth';
export const metadata: Metadata = {title:'Meu Prontuário',description:'Prontuário eletrônico do consultório.'};
// Aplica tema, degradê e modo claro/escuro antes da primeira pintura (mesma lógica de lib/theme.ts).
// No modo automático, acompanha a troca de claro/escuro do sistema em qualquer tela.
const themeScript = `try{var d=document.documentElement,s=localStorage,q='(prefers-color-scheme: light)';var t=s.getItem('psywrite_theme');if(t)d.setAttribute('data-theme',t);if(s.getItem('psywrite_gradient')==='false')d.setAttribute('data-gradient','false');var m=s.getItem('psywrite_mode');var l=m==='light'||(m==='system'&&window.matchMedia&&window.matchMedia(q).matches);d.setAttribute('data-mode',l?'light':'dark');if(window.matchMedia)window.matchMedia(q).addEventListener('change',function(e){try{if(s.getItem('psywrite_mode')==='system')d.setAttribute('data-mode',e.matches?'light':'dark');}catch(_){}});}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <AuthGate>{children}</AuthGate>
      </body>
    </html>
  );
}
