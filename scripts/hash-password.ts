// Produit l'empreinte argon2id à mettre dans ADMIN_PASSWORD_HASH (alternative : copier la colonne
// password_hash de ton compte PoppyTrip). Le mot de passe est lu sur l'entrée standard, jamais
// passé en argument (il resterait dans l'historique du terminal).
//   npm run hash-password
import { createInterface } from 'node:readline';
import { MAX_PASSWORD_LENGTH, hashPassword } from '../src/server/auth/password.js';

const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
process.stderr.write('Mot de passe (puis Entrée) : ');
rl.once('line', (line) => {
  rl.close();
  if (line.length < 12 || line.length > MAX_PASSWORD_LENGTH) {
    console.error('\nMot de passe refusé : au moins 12 caractères.');
    process.exit(1);
  }
  void hashPassword(line).then((phc) => {
    process.stderr.write('\nADMIN_PASSWORD_HASH=');
    console.log(phc);
  });
});
