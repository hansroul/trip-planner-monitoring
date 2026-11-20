#!/usr/bin/env node
// Récupère l'autorité (certificat racine auto-signé) présentée par un serveur PostgreSQL et
// affiche DB_SSL_CA / DB_SSL_HOSTNAME à coller dans .env. Aucun identifiant n'est envoyé : seule la
// poignée de main TLS a lieu.   npm run db:ca -- <hôte> <port>
// Premier contact (« confiance au premier usage ») : comparer l'empreinte affichée avec celle vue
// depuis un autre réseau si possible. Ensuite, toute substitution du certificat sera refusée.
import net from 'node:net';
import tls from 'node:tls';

const [host, portArg] = process.argv.slice(2);
const port = Number(portArg);
if (!host || !Number.isInteger(port)) {
  console.error('Usage : npm run db:ca -- <hôte> <port>   (ex. : npm run db:ca -- mainline.proxy.rlwy.net 12345)');
  process.exit(1);
}

const toPem = (raw) => `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;

const socket = net.connect(port, host, () => {
  const sslRequest = Buffer.alloc(8);
  sslRequest.writeInt32BE(8, 0);
  sslRequest.writeInt32BE(80877103, 4);
  socket.write(sslRequest);
});
socket.setTimeout(10_000, () => {
  console.error('Délai dépassé.');
  process.exit(1);
});
socket.on('error', (e) => {
  console.error(`Connexion impossible : ${e.code ?? e.message}`);
  process.exit(1);
});
socket.once('data', (d) => {
  if (d.toString() !== 'S') {
    console.error('Le serveur refuse TLS.');
    process.exit(1);
  }
  const t = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => {
    const leaf = t.getPeerCertificate(true);
    let root = leaf;
    const seen = new Set();
    while (root.issuerCertificate && !seen.has(root.fingerprint256) && root.issuerCertificate !== root) {
      seen.add(root.fingerprint256);
      if (root.issuerCertificate.fingerprint256 === root.fingerprint256) break;
      root = root.issuerCertificate;
    }
    const names = (leaf.subjectaltname ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('DNS:'))
      .map((s) => s.slice(4));
    const expected = names.includes(host) ? null : (names.find((n) => n !== 'localhost') ?? names[0] ?? null);
    console.error(`Autorité : ${root.subject?.CN ?? '?'} (valide jusqu'au ${root.valid_to})`);
    console.error(`Empreinte SHA-256 : ${root.fingerprint256}`);
    console.error(`Noms du certificat serveur : ${names.join(', ') || '-'}\n`);
    console.log(`DB_SSL_CA=${toPem(root.raw).replace(/\n/g, '\\n')}`);
    if (expected) console.log(`DB_SSL_HOSTNAME=${expected}`);
    t.end();
    process.exit(0);
  });
  t.on('error', (e) => {
    console.error(`TLS impossible : ${e.code ?? e.message}`);
    process.exit(1);
  });
});
