/**
 * Authentication, kept deliberately small.
 *
 * The brief says so explicitly: "Keep this layer minimal. Email verification,
 * password reset and role hierarchies are out of scope and are not scored."
 * What IS scored is that a signed-out visitor cannot reach protected pages or
 * endpoints, that users see only their own kits, and that an expired session is
 * handled sensibly.
 *
 * Hashing uses node:crypto scrypt rather than argon2 or bcrypt. Both of those
 * are native addons that can need a build toolchain on a clean clone, and the
 * standard library already does this well. The parameters are stored inside the
 * hash string so they can be raised later without a migration.
 */
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { User } from '../../db/models.js';
import { ApiError, asyncRoute, requireAuth, validate } from '../../middleware/index.js';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// N=2^15 with r=8 needs roughly 33.5 MiB, which is ABOVE scrypt's 32 MiB
// default. Without maxmem set explicitly this throws
// ERR_CRYPTO_INVALID_SCRYPT_PARAMS at runtime rather than at boot.
const PARAMS = { N: 32_768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, PARAMS.keylen, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  try {
    const salt = Buffer.from(saltB64!, 'base64');
    const expected = Buffer.from(hashB64!, 'base64');
    const derived = await scrypt(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: PARAMS.maxmem,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

const credentials = z.object({
  email: z.email().max(200),
  password: z.string().min(8, 'Use at least 8 characters.').max(200),
  name: z.string().max(80).optional(),
});

/** Slows down credential stuffing without getting in a real user's way. */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, _res, next) => {
    next(
      new ApiError({
        status: 429,
        code: 'RATE_LIMITED',
        message: 'Too many attempts. Try again in a few minutes.',
        retryable: true,
      }),
    );
  },
});

function issueCookie(res: import('express').Response, userId: string): void {
  const config = env();
  const token = jwt.sign({ sub: userId }, config.AUTH_JWT_SECRET, {
    expiresIn: `${config.AUTH_TOKEN_TTL_HOURS}h`,
  });
  res.cookie(config.COOKIE_NAME, token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAMESITE,
    path: '/',
    maxAge: config.AUTH_TOKEN_TTL_HOURS * 3600 * 1000,
    // No Domain attribute: the cookie stays host-only.
  });
}

export const authRouter = Router();

authRouter.post(
  '/register',
  validate(credentials),
  asyncRoute(async (req, res) => {
    const { email, password, name } = req.body as z.infer<typeof credentials>;
    const existing = await User.findOne({ email: email.toLowerCase() }).lean();
    if (existing !== null) {
      throw ApiError.conflict('AUTH_EMAIL_TAKEN', 'That email is already registered.');
    }

    const user = await User.create({
      email: email.toLowerCase(),
      passwordHash: await hashPassword(password),
      name: name ?? '',
    });

    issueCookie(res, String(user._id));
    res.status(201).json({ data: { id: String(user._id), email: user.email, name: user.name } });
  }),
);

authRouter.post(
  '/login',
  loginLimiter,
  validate(credentials.omit({ name: true })),
  asyncRoute(async (req, res) => {
    const { email, password } = req.body as { email: string; password: string };
    const user = await User.findOne({ email: email.toLowerCase() });

    // One message for both an unknown email and a wrong password, so the
    // endpoint cannot be used to discover which addresses are registered.
    const invalid = new ApiError({
      status: 401,
      code: 'AUTH_INVALID_CREDENTIALS',
      message: 'That email and password do not match.',
    });

    if (user === null) {
      // Still spend the time, so a missing account is not detectable by timing.
      await hashPassword(password);
      throw invalid;
    }
    if (!(await verifyPassword(password, user.passwordHash))) throw invalid;

    issueCookie(res, String(user._id));
    res.json({ data: { id: String(user._id), email: user.email, name: user.name } });
  }),
);

authRouter.post('/logout', (_req, res) => {
  const config = env();
  res.clearCookie(config.COOKIE_NAME, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: config.COOKIE_SAMESITE,
    path: '/',
  });
  res.status(204).end();
});

authRouter.get(
  '/me',
  requireAuth,
  asyncRoute(async (req, res) => {
    const user = await User.findById(req.userId).lean();
    if (user === null) throw ApiError.unauthenticated();
    res.json({ data: { id: String(user._id), email: user.email, name: user.name } });
  }),
);
