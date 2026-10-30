jest.mock("@thallesp/nestjs-better-auth", () => ({
  Public: () => () => undefined,
}));

import { PasswordResetController } from "./password-reset.controller";

describe("PasswordResetController", () => {
  const controller = new PasswordResetController();

  it("serves a reset form with password confirmation and the required minimum", () => {
    const page = controller.getResetPasswordPage();

    expect(page).toContain('<script src="/reset-password.js" defer></script>');
    expect(page).toContain('id="password"');
    expect(page).toContain('id="confirm-password"');
    expect(page).toContain('minlength="10"');
  });

  it("submits the token and new password to Better Auth without interpolating user input", () => {
    const script = controller.getResetPasswordScript();

    expect(script).toContain('new URLSearchParams(window.location.search).get("token")');
    expect(script).toContain('fetch("/api/auth/reset-password"');
    expect(script).toContain("JSON.stringify({ newPassword: password.value, token })");
    expect(script).toContain("message.textContent = text");
    expect(() => new Function(script)).not.toThrow();
  });
});
