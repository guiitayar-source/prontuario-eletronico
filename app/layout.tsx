import type { Metadata } from 'next';
import './globals.css';
import AuthGate from '@/components/auth';
export const metadata: Metadata = {title:'Meu Prontuário · Protótipo',description:'Protótipo de atendimento com dados inteiramente fictícios.'};
export default function RootLayout({children}: Readonly<{children:React.ReactNode}>){return <html lang="pt-BR"><body><AuthGate>{children}</AuthGate></body></html>;}
