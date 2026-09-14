import type { Metadata } from 'next';
import './globals.css';
import AuthGate from '@/components/auth';
export const metadata: Metadata = {title:'Meu Prontuário · Protótipo',description:'Protótipo de atendimento com dados inteiramente fictícios.'};
const themeScript = `try{var t=localStorage.getItem('psywrite_theme');if(t)document.documentElement.setAttribute('data-theme',t);var g=localStorage.getItem('psywrite_gradient');if(g==='true')document.documentElement.setAttribute('data-gradient','true');}catch(e){}`;

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
