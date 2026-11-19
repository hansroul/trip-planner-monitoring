import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Fichiers du front construit, chargés en mémoire au démarrage (quelques centaines de Ko).
 * La recherche se fait dans une table : aucun chemin fourni par le client n'atteint le disque.
 *
 * Le build ne contient pas le préfixe d'administration (chemins relatifs) : le serveur
 * l'injecte dans la page à la place du marqueur APP_BASE_MARKER.
 */
export const APP_BASE_MARKER = '<!--app-base-->';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export interface StaticFile {
  body: Buffer;
  type: string;
}

export interface ClientBundle {
  index: string;
  files: Map<string, StaticFile>;
}

async function walk(dir: string, base: string, out: Map<string, StaticFile>): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, base, out);
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      const type = TYPES[ext];
      if (!type || ext === '.map') continue;
      const rel = path.relative(base, full).split(path.sep).join('/');
      out.set(rel, { body: await readFile(full), type });
    }
  }
}

export async function loadClientBundle(dir: string): Promise<ClientBundle> {
  const indexPath = path.join(dir, 'index.html');
  if (!existsSync(indexPath)) throw new Error('Front non construit : lancer « npm run build »');
  const files = new Map<string, StaticFile>();
  await walk(dir, dir, files);
  const index = (await readFile(indexPath, 'utf8'));
  if (!index.includes(APP_BASE_MARKER)) throw new Error('index.html : marqueur du préfixe absent');
  files.delete('index.html');
  return { index, files };
}

/** Page servie : le préfixe (validé : [A-Za-z0-9_-]) est injecté à l'exécution. */
export function renderIndex(template: string, basePath: string): string {
  const base = `${basePath}/`;
  return template.replace(
    APP_BASE_MARKER,
    `<base href="${base}"><meta name="app-base" content="${base}">`,
  );
}
