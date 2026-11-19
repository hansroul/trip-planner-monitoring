import nodemailer from 'nodemailer';
import type { AppConfig } from '../config.js';
import type { Mailer } from './alerts.js';

/** Envoi SMTP vers ADMIN_EMAIL uniquement (adresse jamais transmise au navigateur). */
export function createMailer(config: AppConfig): Mailer | null {
  const smtp = config.alerts.smtp;
  if (!config.alerts.enabled || !smtp || !smtp.from) return null;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    requireTLS: !smtp.secure,
    ...(smtp.user && smtp.password ? { auth: { user: smtp.user, pass: smtp.password } } : {}),
    tls: { rejectUnauthorized: true },
  });
  return {
    async send(subject, text) {
      await transport.sendMail({ from: smtp.from!, to: config.admin.email, subject, text });
    },
  };
}
