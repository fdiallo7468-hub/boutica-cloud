import { createParamDecorator, ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import type { Request } from "express";
import { auth, resolveTenantMembership } from "../../auth/auth";
import { Tenant, UserRole } from "./tenant.type";

/**
 * Resolves the authenticated tenant context (userId, businessId, role).
 *
 * If an authenticated user has not yet completed the onboarding of their business,
 * user.businessId is null. In this case, access to multi-tenant resources is blocked
 * with an explicit, structured BUSINESS_ONBOARDING_REQUIRED error instructing the client
 * to redirect the user to the business onboarding screen.
 */
export const CurrentTenant = createParamDecorator(async (_data: unknown, ctx: ExecutionContext): Promise<Tenant> => {
  const req = ctx.switchToHttp().getRequest<Request>();
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });

  if (!session) {
    throw new UnauthorizedException("Session authentifiée manquante");
  }

  const user = session.user as typeof session.user & {
    businessId?: string | null;
    role?: UserRole;
  };

  if (!user.businessId) {
    throw new UnauthorizedException({
      code: "BUSINESS_ONBOARDING_REQUIRED",
      message: "Aucune entreprise n'est rattachée à ce compte. Veuillez finaliser la création de votre entreprise.",
    });
  }

  // A session businessId is a tenant selector, not an authorization grant.
  // Re-check the persisted membership on every tenant-scoped request and use
  // its role instead of trusting the potentially stale session user field.
  const membership = await resolveTenantMembership(user.id, user.businessId);
  if (!membership) {
    throw new ForbiddenException({
      code: "BUSINESS_MEMBERSHIP_REQUIRED",
      message: "Vous n'êtes plus membre de cette entreprise ou l'accès n'est pas autorisé.",
    });
  }

  return {
    userId: user.id,
    businessId: user.businessId,
    role: membership.role,
  };
});
