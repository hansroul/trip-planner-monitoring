import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Le build ne contient AUCUN préfixe ni URL : chemins relatifs (base './'). Le serveur injecte
// le préfixe d'administration dans la page au moment de la servir.
export default defineConfig({
  root: 'src/client',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    sourcemap: false,
    // Pas de ressources en data: (la politique de contenu n'autorise que 'self') ni de
    // script en ligne.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
});
