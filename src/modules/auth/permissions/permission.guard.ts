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
import { and, eq } from "drizzle-orm";
import { auth } from "../../../auth/auth";
import { DatabaseService } from "../../../infrastructure/database/database";
import { businessMembers, users } from "../../../infrastructure/database/schema";
import { hasRolePermission, PermissionCode } from "./permission-catalog";
import { REQUIRED_PERMISSIONS } from "./require-permissions.decorator";

/**
 * Resolves the active tenant from the persisted user record, then verifies
 * the user's membership in that tenant before evaluating role permissions.
 * Never trusts a businessId or role supplied by the request payload.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly database: DatabaseService,
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

    const [account] = await this.database.db
      .select({ businessId: users.businessId })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);

    if (!account?.businessId) {
      throw new ForbiddenException("Aucune entreprise active pour ce compte");
    }

    const [membership] = await this.database.db
      .select({ role: businessMembers.role })
      .from(businessMembers)
      .where(and(
        eq(businessMembers.userId, session.user.id),
        eq(businessMembers.businessId, account.businessId),
      ))
      .limit(1);

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
