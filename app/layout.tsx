import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ETHcryptohub | Market intelligence',
  description: 'Crypto market intelligence, technical indicators, and secure account tools.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
