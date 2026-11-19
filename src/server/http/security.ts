import helmet from '@fastify/helmet';
import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * En-têtes de sécurité. Politique de contenu stricte : aucun script ni style en ligne, aucune
 * ressource externe (default-src 'none'). Les graphiques sont des SVG dessinés avec des
 * attributs de présentation (fill, width…), jamais des attributs style : « style-src 'self' »
 * suffit, sans 'unsafe-inline'.
 */
export const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'autoplay=()',
  'browsing-topics=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=()',
  'fullscreen=()',
  'geolocation=()',
  'gyroscope=()',
  'hid=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'picture-in-picture=()',
  'publickey-credentials-get=()',
  'screen-wake-lock=()',
  'serial=()',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ');

export function applyExtraHeaders(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store, max-age=0');
  reply.header('Pragma', 'no-cache');
  reply.header('Expires', '0');
  reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  reply.header('Permissions-Policy', PERMISSIONS_POLICY);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.removeHeader('X-Powered-By');
  reply.removeHeader('Server');
}

export async function registerSecurityHeaders(app: FastifyInstance, production: boolean): Promise<void> {
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        ...(production ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: { maxAge: 63_072_000, includeSubDomains: true, preload: false },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginEmbedderPolicy: { policy: 'require-corp' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    xContentTypeOptions: true,
    xDnsPrefetchControl: { allow: false },
    xPermittedCrossDomainPolicies: { permittedPolicies: 'none' },
    xDownloadOptions: true,
    originAgentCluster: true,
    xXssProtection: true,
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    applyExtraHeaders(reply);
    return payload;
  });
}
