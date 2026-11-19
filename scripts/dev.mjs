// Développement local : build du front en continu + serveur relancé à chaque modification.
// Lit la configuration dans .env (jamais versionné). Base : docker compose up -d db.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

if (!existsSync('.env')) {
  console.error('Fichier .env absent : copier .env.example en .env et le compléter (voir README).');
  process.exit(1);
}
const opts = { stdio: 'inherit', shell: process.platform === 'win32' };
const children = [
  spawn('npx', ['vite', 'build', '--watch', '--mode', 'development'], opts),
  spawn('npx', ['tsx', 'watch', '--env-file=.env', 'src/server/index.ts'], opts),
];
const stop = () => {
  for (const c of children) c.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
