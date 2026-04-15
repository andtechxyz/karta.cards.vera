// Transitional shim — the canonical Prisma client now lives in @vera/db.
// This re-export keeps the legacy monolith paths working while the
// per-service cuts land; delete once src/ is gone.
export { prisma } from '@vera/db';
