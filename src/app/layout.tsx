import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'RB-BOX',
  description:
    'Instruction brain for the Icelandic AEC industry — RB blöð, HMS leiðbeiningar, and community-contributed manuals in one searchable box.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="is" suppressHydrationWarning>
      <head>
        {/* Read theme preference before paint to avoid flash */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var t = localStorage.getItem('rb-theme') || 'system';
                  var isDark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
                  if (isDark) document.documentElement.classList.add('dark');
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
