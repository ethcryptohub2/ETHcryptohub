import type { Metadata } from 'next';
import './globals.css';
import '../smartexit/apps/web/src/styles.css';
import '../smartexit/apps/web/src/ethcryptohub-theme.css';

export const metadata: Metadata = {
  title: 'ETHcryptohub | Market intelligence',
  description: 'Crypto market intelligence and paper-trading risk tools.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
