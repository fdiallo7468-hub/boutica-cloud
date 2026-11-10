import { SetMetadata } from "@nestjs/common";
import type { PermissionCode } from "./permission-catalog";

export const REQUIRED_PERMISSIONS = "boutica:required-permissions";

export const RequirePermissions = (...permissions: PermissionCode[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);
