import {
  hasPermission,
  isPermissionCode,
  PERMISSIONS,
} from "./permission-catalog";

describe("v3 permission catalogue", () => {
  it("exposes unique, stable permission codes", () => {
    const codes = Object.values(PERMISSIONS);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).toContain("organization:read");
    expect(codes).toContain("accounting:post");
    expect(codes).toContain("audit:read");
  });

  it("recognizes only declared permission codes", () => {
    expect(isPermissionCode(PERMISSIONS.LOCATIONS_MANAGE)).toBe(true);
    expect(isPermissionCode("root:access")).toBe(false);
  });

  it("grants access only when the required permission is explicit", () => {
    expect(
      hasPermission(
        [PERMISSIONS.SALES_READ, PERMISSIONS.SALES_CREATE],
        PERMISSIONS.SALES_CREATE,
      ),
    ).toBe(true);
    expect(
      hasPermission([PERMISSIONS.SALES_READ], PERMISSIONS.SALES_CANCEL),
    ).toBe(false);
  });
});
