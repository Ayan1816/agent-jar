import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0B0E11',
        card: '#161A1E',
        gold: '#F0B90B',
        mist: '#E8EEF4',
        dim: '#C5D0DA',
      },
    },
  },
  plugins: [],
}

export default config
