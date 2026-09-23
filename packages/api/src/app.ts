/**
 * The Express application, built as a factory so tests can mount it without
 * listening on a port or connecting to a real database.
 */
import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import {
  attachUser,
  errorHandler,
  notFound,
  originCheck,
  requestId,
} from './middleware/index.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { kitsRouter } from './modules/kits/kits.routes.js';
import { practiceRouter } from './modules/practice/practice.routes.js';

export function createApp(): Express {
  const app = express();
  const config = env();

  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(
    cors({
      origin: config.CORS_ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean),
      credentials: true,
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use(requestId);
  app.use(attachUser);
  app.use(originCheck);

  // Cheap, unauthenticated, and used by the frontend to warm a sleeping free
  // instance before the user submits anything.
  app.get('/healthz', (_req, res) => {
    res.json({ data: { ok: true, uptime: Math.round(process.uptime()) } });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/kits', kitsRouter);
  app.use('/api/practice', practiceRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
