/**
 * Boutica Cloud v3 permission catalogue and initial role policy.
 *
 * Permissions are checked server-side. OWNER is unrestricted within its
 * tenant; STAFF receives an explicit least-privilege operational baseline.
 * Fine-grained per-member grants can be layered on this stable catalogue later.
 */
export const PERMISSIONS = {
  ORGANIZATION_READ: "organization:read",
  ORGANIZATION_UPDATE: "organization:update",
  MEMBERS_READ: "members:read",
  MEMBERS_MANAGE: "members:manage",
  LOCATIONS_READ: "locations:read",
  LOCATIONS_MANAGE: "locations:manage",
  CATALOG_READ: "catalog:read",
  CATALOG_MANAGE: "catalog:manage",
  INVENTORY_READ: "inventory:read",
  INVENTORY_MANAGE: "inventory:manage",
  PURCHASING_READ: "purchasing:read",
  PURCHASING_MANAGE: "purchasing:manage",
  SALES_READ: "sales:read",
  SALES_CREATE: "sales:create",
  SALES_CANCEL: "sales:cancel",
  CUSTOMERS_READ: "customers:read",
  CUSTOMERS_MANAGE: "customers:manage",
  FINANCE_READ: "finance:read",
  FINANCE_MANAGE: "finance:manage",
  ACCOUNTING_READ: "accounting:read",
  ACCOUNTING_MANAGE: "accounting:manage",
  ACCOUNTING_POST: "accounting:post",
  REPORTS_READ: "reports:read",
  REPORTS_EXPORT: "reports:export",
  CRM_READ: "crm:read",
  CRM_MANAGE: "crm:manage",
  PAYMENTS_READ: "payments:read",
  PAYMENTS_MANAGE: "payments:manage",
  INTEGRATIONS_MANAGE: "integrations:manage",
  AUDIT_READ: "audit:read",
  SUBSCRIPTIONS_MANAGE: "subscriptions:manage",
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export type PermissionRole = "OWNER" | "STAFF";

const permissionCodes = new Set<string>(Object.values(PERMISSIONS));

export const ROLE_PERMISSIONS: Record<PermissionRole, readonly PermissionCode[]> = {
  OWNER: Object.values(PERMISSIONS),
  STAFF: [
    PERMISSIONS.ORGANIZATION_READ,
    PERMISSIONS.LOCATIONS_READ,
    PERMISSIONS.CATALOG_READ,
    PERMISSIONS.INVENTORY_READ,
    PERMISSIONS.INVENTORY_MANAGE,
    PERMISSIONS.PURCHASING_READ,
    PERMISSIONS.SALES_READ,
    PERMISSIONS.SALES_CREATE,
    PERMISSIONS.CUSTOMERS_READ,
    PERMISSIONS.CUSTOMERS_MANAGE,
    PERMISSIONS.REPORTS_READ,
    PERMISSIONS.CRM_READ,
    PERMISSIONS.PAYMENTS_READ,
  ],
};

export function hasRolePermission(
  role: PermissionRole,
  requiredPermission: PermissionCode,
): boolean {
  return permissionCodes.has(requiredPermission) &&
    ROLE_PERMISSIONS[role].includes(requiredPermission);
}

export function hasPermission(
  grantedPermissions: readonly string[],
  requiredPermission: PermissionCode,
): boolean {
  return permissionCodes.has(requiredPermission) &&
    grantedPermissions.includes(requiredPermission);
}

export function isPermissionCode(value: string): value is PermissionCode {
  return permissionCodes.has(value);
}
