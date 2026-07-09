import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: [
    './src/app/**/*.{ts,tsx}',
    './src/components/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Brick red — the RB-BOX brand accent
        brick: {
          50:  '#FCEBEB',
          100: '#F5CFCF',
          200: '#E9A5A5',
          300: '#DB7C7C',
          400: '#C4514F',
          500: '#A32D2D', // primary
          600: '#8A2323',
          700: '#701C1C',
          800: '#501313',
          900: '#380D0D',
        },
        // Warm paper / bone tones for the light theme
        paper: {
          bg:      '#FAFAF7',
          surface: '#FFFFFF',
          border:  'rgba(0,0,0,0.08)',
          muted:   '#F1EFE8',
          text:    '#2C2C2A',
          soft:    '#5F5E5A',
          faint:   '#888780',
        },
        // Ink / charcoal for dark theme
        ink: {
          bg:      '#141416',
          surface: '#1D1D22',
          border:  'rgba(255,255,255,0.06)',
          muted:   '#26262C',
          text:    '#EDEDE8',
          soft:    '#A0A099',
          faint:   '#6E6E68',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        xl: '12px',
      },
      boxShadow: {
        spotlight: '0 20px 60px -20px rgba(0,0,0,0.25), 0 8px 24px -8px rgba(0,0,0,0.15)',
      },
    },
  },
  plugins: [],
};

export default config;
