import { defineConfig } from 'vite';

// `52u` in onboarding.css = 52 design px of the 832px-wide onboarding mock-up screen,
// scaled with the viewport through the --u custom property.
const designUnits = () => ({
  postcssPlugin: 'design-units',
  Declaration(decl) {
    if (!decl.prop.startsWith('--') && /\du\b/.test(decl.value)) {
      decl.value = decl.value.replace(/(-?\d*\.?\d+)u\b/g, 'calc($1 * var(--u))');
    }
  },
});

export default defineConfig({
  css: { postcss: { plugins: [designUnits()] } },
  server: { port: 5173, host: true },
  build: { target: 'es2020', assetsInlineLimit: 0, chunkSizeWarningLimit: 700 },
});
