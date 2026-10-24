import { createParamDecorator, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import type { Request } from "express";
import { auth } from "../../auth/auth";
import { Tenant, UserRole } from "./tenant.type";

/**
 * Resolves the authenticated tenant context (userId, businessId, role).
 *
 * If a user is authenticated via OAuth (Google / Apple) but has not yet completed
 * the onboarding of their business, user.businessId is null. In this case,
 * access to multi-tenant resources is blocked with an explicit, structured
 * BUSINESS_ONBOARDING_REQUIRED error instructing the client to redirect the user
 * to the business onboarding screen.
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

  return {
    userId: user.id,
    businessId: user.businessId,
    role: user.role ?? "OWNER",
  };
});
