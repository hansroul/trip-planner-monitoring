// Active les hooks Git du dépôt (.githooks) ; sans effet hors d'un dépôt Git (image Docker…).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

if (existsSync('.git')) {
  try {
    execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'ignore' });
  } catch {
    // Git absent : rien à faire.
  }
}
