// Bearer-token authentication + permission checks for API routes.
import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from './db';
import { hashToken } from './tokens';
import { resolvePermissions, type PermissionKey, type Role } from './permissions';

export interface AuthContext {
  userId: string;
  organizationId: string;
  role: Role;
  tokenId: string;
  permissions: Set<PermissionKey>;
}

declare module 'fastify' {
  interface FastifyRequest {
    ctx?: AuthContext;
  }
}

/** Resolve an Authorization header into an AuthContext, or null if invalid. */
export async function authenticate(authHeader?: string): Promise<AuthContext | null> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const plain = authHeader.slice(7).trim();
  if (!plain) return null;

  const token = await prisma.apiToken.findUnique({ where: { tokenHash: hashToken(plain) } });
  if (!token || token.revokedAt || (token.expiresAt && token.expiresAt < new Date())) return null;

  const membership = await prisma.membership.findUnique({
    where: { organizationId_userId: { organizationId: token.organizationId, userId: token.userId } },
    include: { permissionOverrides: true },
  });
  if (!membership || membership.status !== 'ACTIVE') return null;

  // best-effort last-used stamp
  prisma.apiToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } }).catch(() => {});

  const permissions = resolvePermissions(
    membership.role as Role,
    membership.permissionOverrides.map((o) => ({ permissionKey: o.permissionKey, effect: o.effect })),
  );

  return { userId: token.userId, organizationId: token.organizationId, role: membership.role as Role, tokenId: token.id, permissions };
}

/** Guard a handler on a permission. Sends 403 and returns false if denied. */
export function requirePermission(req: FastifyRequest, reply: FastifyReply, permission: PermissionKey): boolean {
  if (!req.ctx || !req.ctx.permissions.has(permission)) {
    reply.code(403).send({ error: 'forbidden', permission });
    return false;
  }
  return true;
}
