import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  ServiceUnavailableException,
} from "@nestjs/common";
import { fromNodeHeaders } from "better-auth/node";
import type { Request } from "express";
import { randomUUID } from "node:crypto";
import { defer, from, lastValueFrom, Observable } from "rxjs";
import { auth, resolveTenantMembership } from "../../auth/auth";
import { TenantTransactionService } from "./tenant-transaction.service";

@Injectable()
export class TenantDatabaseInterceptor implements NestInterceptor {
  constructor(private readonly tenantTransactions: TenantTransactionService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    return defer(() =>
      from(this.withTenantContext(request, () =>
        lastValueFrom(next.handle(), { defaultValue: undefined }),
      )),
    );
  }

  private async withTenantContext<T>(request: Request, handler: () => Promise<T>): Promise<T> {
    let session: Awaited<ReturnType<typeof auth.api.getSession>>;
    try {
      session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    } catch {
      throw new ServiceUnavailableException("Unable to resolve the authenticated tenant context");
    }

    if (!session?.user?.id) return handler();

    const user = session.user as typeof session.user & { businessId?: string | null };
    if (!user.businessId) return handler();

    let membership: Awaited<ReturnType<typeof resolveTenantMembership>>;
    try {
      membership = await resolveTenantMembership(user.id, user.businessId);
    } catch {
      throw new ServiceUnavailableException("Unable to verify the tenant membership");
    }

    // Tenant-scoped controllers still reject missing membership via
    // CurrentTenant. Without a verified membership, no tenant DB context is set.
    if (!membership) return handler();

    return this.tenantTransactions.run(
      {
        businessId: user.businessId,
        actorUserId: user.id,
        requestId: randomUUID(),
      },
      handler,
    );
  }
}
