/**
 * Boutica Cloud v3 permission catalogue.
 *
 * This file is intentionally declarative: it defines stable permission codes
 * without changing current route authorization. Route enforcement will be
 * introduced incrementally after the role/permission matrix and membership
 * migration are reviewed.
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

const permissionCodes = new Set<string>(Object.values(PERMISSIONS));

/** Returns true only for a permission explicitly present in the resolved grant set. */
export function hasPermission(
  grantedPermissions: readonly string[],
  requiredPermission: PermissionCode,
): boolean {
  return (
    permissionCodes.has(requiredPermission) &&
    grantedPermissions.includes(requiredPermission)
  );
}

/** Rejects unknown permission strings before persisting or applying grants. */
export function isPermissionCode(value: string): value is PermissionCode {
  return permissionCodes.has(value);
}
