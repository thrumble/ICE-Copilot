/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#f6f5f1',
        panel: '#ffffff',
        line: { DEFAULT: '#e6e4de', strong: '#d5d2c9' },
        ink: {
          DEFAULT: '#1c1b17',
          soft: '#57544c',
          faint: '#98948a'
        },
        moss: {
          DEFAULT: '#22604b',
          deep: '#1a4c3b',
          mist: '#e7efe9'
        }
      },
      fontFamily: {
        sans: ['"ID Grotesk"', '"Plus Jakarta Sans"', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        serif: ['"Instrument Serif"', 'Georgia', 'serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace']
      }
    }
  },
  plugins: []
};
