// Permission catalog + role defaults. Effective permissions are resolved in code:
//   role defaults  +  per-member PermissionOverride (ALLOW/DENY)
// This mirrors the proven v2 model but is keyed off typed constants.

export const PERMISSIONS = {
  // org & team
  'org.manage': 'Edit organization settings',
  'org.billing': 'Manage billing & subscription',
  'members.view': 'View team members',
  'members.invite': 'Invite team members',
  'members.manage': 'Change roles / remove members',
  // connections
  'connections.view': 'View platform connections',
  'connections.manage': 'Connect / disconnect platforms',
  // data
  'orders.view': 'View orders',
  'orders.manage': 'Edit / sync orders',
  'shows.view': 'View shows',
  'shipments.view': 'View shipments',
  'shipments.manage': 'Create / edit shipments',
  // live & AI
  'live.monitor': 'Use the live monitor',
  'receipts.view': 'View video receipts',
  'receipts.transcribe': 'Run AI transcription',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export type Role = 'OWNER' | 'ADMIN' | 'MANAGER' | 'VIEWER';

const ALL: PermissionKey[] = Object.keys(PERMISSIONS) as PermissionKey[];

// Default permission set per role.
export const ROLE_DEFAULTS: Record<Role, PermissionKey[]> = {
  OWNER: ALL,
  ADMIN: ALL.filter((p) => p !== 'org.billing'),
  MANAGER: [
    'members.view',
    'connections.view',
    'connections.manage',
    'orders.view',
    'orders.manage',
    'shows.view',
    'shipments.view',
    'shipments.manage',
    'live.monitor',
    'receipts.view',
    'receipts.transcribe',
  ],
  VIEWER: [
    'members.view',
    'connections.view',
    'orders.view',
    'shows.view',
    'shipments.view',
    'receipts.view',
  ],
};

export interface Override {
  permissionKey: string;
  effect: 'ALLOW' | 'DENY';
}

/** Resolve a member's effective permissions: role defaults, then apply overrides. */
export function resolvePermissions(role: Role, overrides: Override[] = []): Set<PermissionKey> {
  const set = new Set<PermissionKey>(ROLE_DEFAULTS[role]);
  for (const o of overrides) {
    const key = o.permissionKey as PermissionKey;
    if (!(key in PERMISSIONS)) continue;
    if (o.effect === 'ALLOW') set.add(key);
    else set.delete(key);
  }
  return set;
}

/** Authorization check used by API routes. */
export function can(role: Role, overrides: Override[], permission: PermissionKey): boolean {
  return resolvePermissions(role, overrides).has(permission);
}
