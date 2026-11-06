import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'ETHcryptohub Market Intelligence',
    short_name: 'ETHcryptohub',
    description: 'Crypto market intelligence and signal notifications.',
    start_url: '/dashboard',
    display: 'standalone',
    background_color: '#07090e',
    theme_color: '#07090e',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  };
}
