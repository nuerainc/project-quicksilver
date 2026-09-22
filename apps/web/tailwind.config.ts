import type { Config } from 'tailwindcss'

export default {
  content: ['./app/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        quicksilver: {
          bg: '#0a0a0f',
          panel: '#13131a',
          border: '#1f1f2a',
          accent: '#a8a8b3',
          signal: '#e6e6ed',
          quicksilver: '#c8c8d0',
        },
      },
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'monospace'],
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
    },
  },
  plugins: [],
} satisfies Config