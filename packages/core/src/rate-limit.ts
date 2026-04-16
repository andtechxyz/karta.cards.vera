import rateLimit from 'express-rate-limit';

/** Strict rate limiter for auth endpoints: 10 requests per minute per IP */
export const authRateLimit = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many requests, try again later' } },
});

/** Standard rate limiter for API endpoints: 100 requests per minute per IP */
export const apiRateLimit = rateLimit({
  windowMs: 60_000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many requests' } },
});
