import { GeistSans } from 'geist/font/sans';
import Script from 'next/script';

import type { Viewport } from 'next';
import './globals.css';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
};

export const metadata = {
  title: 'Orbit',
  description: 'Control centre for AI representatives',
  icons: { icon: '/icon.svg' },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#fff" />
        <Script src="/theme.js" strategy="beforeInteractive" />
      </head>
      <body className={GeistSans.variable}>{children}</body>
    </html>
  );
}
