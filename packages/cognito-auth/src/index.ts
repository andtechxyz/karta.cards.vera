import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { RequestHandler, Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CognitoUser {
  /** Cognito user pool subject (UUID). */
  sub: string;
  /** Email claim — present if the user pool includes it. */
  email?: string;
  /** Cognito groups the user belongs to (from `cognito:groups` claim). */
  groups: string[];
}

export interface CognitoAuthConfig {
  /** Cognito User Pool ID, e.g. "ap-southeast-2_Db4d1vpIV". */
  userPoolId: string;
  /** App client ID used as the JWT audience. */
  clientId: string;
  /** AWS region — defaults to the region prefix of userPoolId. */
  region?: string;
  /**
   * If set, the user must be a member of this Cognito group.  Rejects with
   * 403 if the group claim is missing or does not include this value.
   */
  requiredGroup?: string;
}

// ---------------------------------------------------------------------------
// Augment Express Request so downstream handlers see `req.cognitoUser`.
// ---------------------------------------------------------------------------

declare global {
  namespace Express {
    interface Request {
      cognitoUser?: CognitoUser;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates Express middleware that verifies AWS Cognito JWTs.
 *
 * - Reads `Authorization: Bearer <token>` from the request.
 * - Fetches the JWKS from the Cognito well-known endpoint (cached by `jose`).
 * - Validates signature, expiry, issuer, and audience/client_id.
 * - On success: populates `req.cognitoUser` and calls `next()`.
 * - On failure: responds with a 401 JSON error.
 */
export function createCognitoAuthMiddleware(config: CognitoAuthConfig): RequestHandler {
  const region = config.region ?? config.userPoolId.split('_')[0];
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${config.userPoolId}`;
  const jwksUrl = new URL(`${issuer}/.well-known/jwks.json`);

  // `createRemoteJWKSet` handles fetching + caching automatically.
  const jwks = createRemoteJWKSet(jwksUrl);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'missing_token', message: 'Authorization Bearer token required' });
      return;
    }

    const token = auth.slice(7);

    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        audience: config.clientId,
      });

      const user = extractUser(payload);

      // Enforce group membership if configured
      if (config.requiredGroup && !user.groups.includes(config.requiredGroup)) {
        res.status(403).json({
          error: 'forbidden',
          message: `Requires membership in '${config.requiredGroup}' group`,
        });
        return;
      }

      req.cognitoUser = user;
      next();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Token verification failed';
      res.status(401).json({ error: 'invalid_token', message });
    }
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractUser(payload: JWTPayload): CognitoUser {
  const rawGroups = payload['cognito:groups'];
  const groups = Array.isArray(rawGroups)
    ? rawGroups.filter((g): g is string => typeof g === 'string')
    : [];

  return {
    sub: payload.sub ?? '',
    email: typeof payload.email === 'string' ? payload.email : undefined,
    groups,
  };
}
