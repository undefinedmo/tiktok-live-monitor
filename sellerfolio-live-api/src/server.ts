// SellerFolio Live API — Fastify server.
import 'dotenv/config';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ZodError } from 'zod';
import { authenticate } from './auth';
import { registerRoutes } from './routes/v1';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

const __dirnameLocal = dirname(fileURLToPath(import.meta.url));
app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } }); // 10 MB cap
app.register(fastifyStatic, {
  root: join(__dirnameLocal, '..', 'public'),
  prefix: '/app/',
});

// Uniform validation errors
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ZodError) {
    return reply.code(400).send({ error: 'invalid_request', issues: err.issues });
  }
  app.log.error(err);
  const statusCode = (err as { statusCode?: number }).statusCode ?? 500;
  const message = err instanceof Error ? err.message : 'internal_error';
  return reply.code(statusCode).send({ error: message || 'internal_error' });
});

// Public
app.get('/health', async () => ({ ok: true, service: 'sellerfolio-live-api' }));

// Everything under /v1 requires a valid API token.
app.register(
  async (api) => {
    api.addHook('onRequest', async (req, reply) => {
      const ctx = await authenticate(req.headers.authorization);
      if (!ctx) return reply.code(401).send({ error: 'unauthorized' });
      req.ctx = ctx;
    });
    await registerRoutes(api);
  },
  { prefix: '/v1' },
);

const port = Number(process.env.PORT ?? 8788);
const host = process.env.HOST ?? '127.0.0.1';
app.listen({ port, host }).catch((e) => {
  app.log.error(e);
  process.exit(1);
});
