/** @type {import('tailwindcss').Config} */

// Every colour resolves through a CSS variable rather than a literal hex. Two things fall out
// of that: one `dark` class on <html> re-themes the entire app including the existing
// bg-gray-50 / text-gray-900 / border-gray-200 usage in the views, and a deployment can
// override any value at runtime (see --accent) without a rebuild.
const ramp = (name, steps) =>
  Object.fromEntries(
    steps.map((step) => [step, `rgb(var(--color-${name}-${step}) / <alpha-value>)`]),
  );

const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

export default {
  content: [
    './index.html',
    './src/**/*.{vue,js,ts,jsx,tsx}',
  ],
  // Toggled by adding/removing `dark` on <html>, so the theme can also be forced
  // regardless of the OS preference.
  darkMode: 'class',
  // The `.dark` block in style.css carries the dark token values. It is a class selector that
  // never appears in a template - JavaScript toggles it - so without this Tailwind discards it
  // as unused and the theme silently does nothing.
  safelist: ['dark'],
  theme: {
    extend: {
      colors: {
        gray: ramp('gray', STEPS),
        primary: ramp('primary', STEPS),
        success: ramp('success', STEPS),
        warning: ramp('warning', STEPS),
        danger: ramp('danger', STEPS),
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          foreground: 'rgb(var(--accent-fg) / <alpha-value>)',
        },
        // Semantic surfaces. `white` is deliberately left alone because `text-white` on a
        // primary button must stay white in both themes; the card/table surfaces use these
        // instead so they can invert.
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          muted: 'rgb(var(--surface-muted) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['InterVariable', 'Inter', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'JetBrains Mono', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        // Softer than Tailwind's default shadow-sm, which reads heavy on the card borders.
        card: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
        pop: '0 8px 24px -6px rgb(0 0 0 / 0.18)',
      },
      borderRadius: {
        card: '0.625rem',
      },
    },
  },
  plugins: [],
}
