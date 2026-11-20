/**
 * Page de connexion : HTML statique sans script ni style en ligne (feuille servie à part sous le
 * préfixe). Le formulaire porte un jeton anti-falsification lié au cookie de flux.
 */

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function loginPage(opts: { action: string; cssHref: string; formToken: string; error?: string }): string {
  const error = opts.error ? `<p class="error" role="alert">${escapeHtml(opts.error)}</p>` : '';
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Connexion · Suivi PoppyTrip</title>
<link rel="stylesheet" href="${escapeHtml(opts.cssHref)}">
</head>
<body>
<main>
<h1>Suivi PoppyTrip</h1>
<p class="hint">Connecte-toi avec ton compte PoppyTrip.</p>
${error}
<form method="post" action="${escapeHtml(opts.action)}">
<input type="hidden" name="form_token" value="${escapeHtml(opts.formToken)}">
<label for="email">E-mail</label>
<input id="email" name="email" type="email" autocomplete="username" required maxlength="320" autofocus>
<label for="password">Mot de passe</label>
<input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024">
<button type="submit">Se connecter</button>
</form>
</main>
</body>
</html>`;
}

export const LOGIN_CSS = `:root{color-scheme:light;--page:#f9f9f7;--surface:#fcfcfb;--text:#0b0b0b;--muted:#6b6a65;--border:rgba(11,11,11,.15);--focus:#2a78d6;--accent:#2a78d6;--on-accent:#fff;--critical:#b42323}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--page:#0d0d0d;--surface:#1a1a19;--text:#f0efec;--muted:#a3a29c;--border:rgba(255,255,255,.15);--focus:#6da7ec;--accent:#3987e5;--on-accent:#fff;--critical:#f08a8a}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--page);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}
main{width:100%;max-width:360px;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:28px 24px}
h1{font-size:1.25rem;margin:0 0 4px}
.hint{color:var(--muted);margin:0 0 20px;font-size:.9rem}
.error{color:var(--critical);margin:0 0 16px;font-size:.9rem}
form{display:grid;gap:6px}
label{font-size:.85rem;color:var(--muted);margin-top:8px}
input{font:inherit;color:inherit;background:var(--page);border:1px solid var(--border);border-radius:8px;padding:10px 12px;width:100%}
input:focus-visible,button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
button{margin-top:18px;font:inherit;font-weight:600;color:var(--on-accent);background:var(--accent);border:0;border-radius:8px;padding:11px 12px;cursor:pointer}
`;
