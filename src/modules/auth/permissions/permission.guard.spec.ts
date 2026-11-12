import { ExecutionContext, ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { auth, resolveTenantMembership } from "../../../auth/auth";
import { PERMISSIONS } from "./permission-catalog";
import { PermissionGuard } from "./permission.guard";

jest.mock("../../../auth/auth", () => ({
  auth: { api: { getSession: jest.fn() } },
  resolveTenantMembership: jest.fn(),
}));

describe("PermissionGuard", () => {
  const handler = () => undefined;
  const controller = class TestController {};
  const reflector = { getAllAndOverride: jest.fn() } as unknown as Reflector;
  let guard: PermissionGuard;

  const context = (): ExecutionContext => ({
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization: "Bearer test" } }),
    }),
  } as unknown as ExecutionContext);

  beforeEach(() => {
    jest.clearAllMocks();
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue([PERMISSIONS.ACCOUNTING_POST]);
    guard = new PermissionGuard(reflector);
  });

  it("does not resolve a session when a route has no permission metadata", async () => {
    (reflector.getAllAndOverride as jest.Mock).mockReturnValue(undefined);
    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it("allows an authenticated owner with a persisted membership", async () => {
    (auth.api.getSession as jest.Mock).mockResolvedValue({ user: { id: "user-1", businessId: "business-1" } });
    (resolveTenantMembership as jest.Mock).mockResolvedValue({ role: "OWNER" });
    await expect(guard.canActivate(context())).resolves.toBe(true);
    expect(resolveTenantMembership).toHaveBeenCalledWith("user-1", "business-1");
  });

  it("rejects a staff member from posting accounting entries", async () => {
    (auth.api.getSession as jest.Mock).mockResolvedValue({ user: { id: "user-2", businessId: "business-1" } });
    (resolveTenantMembership as jest.Mock).mockResolvedValue({ role: "STAFF" });
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects a session whose tenant membership has been revoked", async () => {
    (auth.api.getSession as jest.Mock).mockResolvedValue({ user: { id: "user-3", businessId: "business-1" } });
    (resolveTenantMembership as jest.Mock).mockResolvedValue(null);
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects unauthenticated requests for protected routes", async () => {
    (auth.api.getSession as jest.Mock).mockResolvedValue(null);
    await expect(guard.canActivate(context())).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
