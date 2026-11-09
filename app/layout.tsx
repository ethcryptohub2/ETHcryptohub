import type { Metadata } from 'next';
import Script from 'next/script';
import { PanelNavigation } from './panel-navigation';
import './globals.css';

export const metadata: Metadata = {
  title: 'ETHcryptohub | Market intelligence',
  description: 'Crypto market intelligence, technical indicators, and secure account tools.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" suppressHydrationWarning>
    <head>
      <Script id="theme-init" strategy="beforeInteractive">{`
        try {
          document.documentElement.dataset.theme =
            localStorage.getItem('ethcryptohub-theme') === 'dark' ? 'dark' : 'light';
          document.documentElement.style.setProperty(
            '--sidebar-width',
            localStorage.getItem('ethcryptohub-sidebar') === 'collapsed' ? '76px' : '256px'
          );
        } catch {
          document.documentElement.dataset.theme = 'light';
          document.documentElement.style.setProperty('--sidebar-width', '256px');
        }
      `}</Script>
    </head>
    <body><div className="app-frame"><PanelNavigation />{children}</div></body>
  </html>;
}
