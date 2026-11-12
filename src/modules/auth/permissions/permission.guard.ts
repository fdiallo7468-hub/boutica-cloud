import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { fromNodeHeaders } from "better-auth/node";
import type { Request } from "express";
import { auth, resolveTenantMembership } from "../../../auth/auth";
import { hasRolePermission, PermissionCode } from "./permission-catalog";
import { REQUIRED_PERMISSIONS } from "./require-permissions.decorator";

/**
 * Resolves the tenant selected by the authenticated session, then verifies
 * the persisted membership in an RLS-scoped transaction before evaluating permissions.
 * Never trusts a businessId or role supplied by the request payload.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionCode[]>(
      REQUIRED_PERMISSIONS,
      [context.getHandler(), context.getClass()],
    );

    if (!required?.length) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(request.headers),
    });

    if (!session?.user?.id) {
      throw new UnauthorizedException("Session authentifiée requise");
    }

    const sessionBusinessId = (session.user as typeof session.user & {
      businessId?: string | null;
    }).businessId;

    if (!sessionBusinessId) {
      throw new ForbiddenException("Aucune entreprise active pour ce compte");
    }

    // Guards execute before interceptors. Resolve membership in its own
    // transaction-scoped RLS context instead of querying business_members
    // through an unscoped runtime connection.
    const membership = await resolveTenantMembership(session.user.id, sessionBusinessId);
    if (!membership) {
      throw new ForbiddenException("L'appartenance à cette entreprise n'est pas valide");
    }

    const allowed = required.every((permission) =>
      hasRolePermission(membership.role, permission),
    );

    if (!allowed) {
      throw new ForbiddenException("Permission insuffisante pour cette opération");
    }

    return true;
  }
}
