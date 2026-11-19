#!/usr/bin/env node
/**
 * Détection de secrets (complément de gitleaks, sans dépendance) :
 *   node scripts/check-secrets.mjs            → tous les fichiers versionnés
 *   node scripts/check-secrets.mjs --staged   → fichiers indexés (hook de pré-commit)
 *
 * Bloque : clés privées, clés d'API connues, jetons JWT, URL avec mot de passe, affectations de
 * secrets non fictives, et toute adresse e-mail réelle (l'adresse autorisée ne doit apparaître
 * dans AUCUN fichier versionné ; seuls les domaines réservés aux exemples sont acceptés).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Valeur manifestement fictive : mot-clé d'exemple, variable, ou suite de mots en minuscules. */
export function isFakeValue(v) {
  if (/fictif|exemple|example|changeme|remplacer|xxxx|\$\{|<|process\.env|dev-only-/i.test(v)) return true;
  return /^[a-z]+(?:[-_][a-z]+)+$/.test(v);
}

export const RULES = [
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { id: 'anthropic-key', re: /sk-ant-(?:admin|api)\d{2}-[A-Za-z0-9_-]{20,}/ },
  { id: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{30,}\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'stripe-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  // URL avec identifiants (postgres://user:motdepasse@hôte) hors valeurs fictives.
  {
    id: 'url-credentials',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:([^\s@'"`]{6,})@[^\s'"`]+/i,
    allow: (m) => /dev-only-|fictif|changeme|motdepasse|password|\$\{|<|example|postgres:postgres@/i.test(m[0]),
  },
  // NOM_SECRET=valeur (fichier d'environnement) ou nomSecret: 'valeur' (littéral dans du code),
  // si la valeur n'est ni fictive, ni une suite de mots (« test-client-secret-value »).
  {
    id: 'secret-assignment',
    re: /^\s*(?:export\s+)?([A-Z0-9_]*(?:SECRET|PASSWORD|API_KEY|ADMIN_KEY|TOKEN|PRIVATE_KEY)[A-Z0-9_]*)\s*=\s*['"]?([^\s'"#]{16,})/,
    allow: (m) => isFakeValue(m[2]),
  },
  {
    id: 'secret-assignment',
    re: /\b([A-Za-z0-9_]*(?:secret|password|apiKey|api_key|adminKey|token|SECRET|PASSWORD|API_KEY|ADMIN_KEY|TOKEN)[A-Za-z0-9_]*)['"]?\s*[:=]\s*['"`]([^'"`\s]{16,})['"`]/,
    allow: (m) => isFakeValue(m[2]),
  },
  // Adresses e-mail réelles (les domaines réservés RFC 2606 et l'adresse technique Git sont acceptés).
  {
    id: 'email-address',
    re: /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/,
    allow: (m) => /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i.test(m[1]) || m[0] === 'noreply@anthropic.com',
  },
];

const SKIP = [/^package-lock\.json$/, /\.(png|jpg|jpeg|gif|ico|woff2?|ttf)$/i];

export function scanText(text, file = '') {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes('check-secrets: allow')) return;
    for (const rule of RULES) {
      const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
      for (const m of line.matchAll(re)) {
        if (rule.allow && rule.allow(m)) continue;
        findings.push({ file, line: i + 1, rule: rule.id });
      }
    }
  });
  return findings;
}

export function listFiles(staged) {
  const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'] : ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  return execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);
}

export function scanFiles(files, read = (f) => readFileSync(f, 'utf8')) {
  const findings = [];
  for (const file of files) {
    if (SKIP.some((re) => re.test(file))) continue;
    if (/(^|\/)\.env($|\.)/.test(file) && file !== '.env.example') {
      findings.push({ file, line: 0, rule: 'env-file-versioned' });
      continue;
    }
    let text;
    try {
      text = read(file);
    } catch {
      continue;
    }
    findings.push(...scanText(text, file));
  }
  return findings;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const staged = process.argv.includes('--staged');
  const findings = scanFiles(listFiles(staged));
  if (findings.length) {
    console.error('Secrets ou données personnelles potentiels détectés (valeurs non affichées) :');
    for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.rule}]`);
    process.exit(1);
  }
  console.log('Aucun secret détecté.');
}
