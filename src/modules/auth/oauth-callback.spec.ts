jest.mock("../../auth/auth", () => ({
  auth: {
    api: {
      getSession: jest.fn(),
    },
  },
}));
jest.mock("better-auth/node", () => ({
  fromNodeHeaders: jest.fn().mockReturnValue({}),
}));
jest.mock("@thallesp/nestjs-better-auth", () => ({
  Public: () => () => {},
}));

import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { DesktopAuthService } from "./desktop-auth.service";
import { OAuthCallbackController } from "./oauth-callback.controller";

describe("OAuth Callback & Desktop Exchange Authentication", () => {
  let desktopAuthService: DesktopAuthService;
  let controller: OAuthCallbackController;

  beforeEach(() => {
    desktopAuthService = new DesktopAuthService();
    controller = new OAuthCallbackController(desktopAuthService);
    jest.clearAllMocks();
  });

  describe("DesktopAuthService", () => {
    it("creates a secure 64-character hex exchange code and stores payload", () => {
      const user = { id: "usr_123", email: "google.user@example.com", name: "Google User", role: "OWNER" };
      const code = desktopAuthService.createExchangeCode("session-token-abc", user);

      expect(typeof code).toBe("string");
      expect(code).toHaveLength(64);
      expect(code).toMatch(/^[a-f0-9]{64}$/);
      expect(desktopAuthService.getPendingCodesCount()).toBe(1);
    });

    it("atomically consumes exchange code and prevents reuse (single-use)", () => {
      const user = { id: "usr_123", email: "google.user@example.com" };
      const code = desktopAuthService.createExchangeCode("session-token-xyz", user);

      const result1 = desktopAuthService.consumeExchangeCode(code);
      expect(result1.sessionToken).toBe("session-token-xyz");
      expect(result1.user.id).toBe("usr_123");
      expect(desktopAuthService.getPendingCodesCount()).toBe(0);

      // Deuxième tentative avec le même code : doit être rejetée immédiatement
      expect(() => desktopAuthService.consumeExchangeCode(code)).toThrow(UnauthorizedException);
    });

    it("rejects unknown, malformed, or missing exchange codes", () => {
      expect(() => desktopAuthService.consumeExchangeCode("")).toThrow(UnauthorizedException);
      expect(() => desktopAuthService.consumeExchangeCode("short-code")).toThrow(UnauthorizedException);
      expect(() =>
        desktopAuthService.consumeExchangeCode("0000000000000000000000000000000000000000000000000000000000000000"),
      ).toThrow(UnauthorizedException);
    });

    it("rejects expired exchange codes", () => {
      const user = { id: "usr_exp", email: "expired@example.com" };
      const code = desktopAuthService.createExchangeCode("session-token-exp", user);

      // Simule l'expiration temporelle (> 60s)
      const data = (desktopAuthService as any).pendingCodes.get(code);
      data.createdAt = Date.now() - 65_000;

      expect(() => desktopAuthService.consumeExchangeCode(code)).toThrow(UnauthorizedException);
    });
  });

  describe("OAuthCallbackController - handleOAuthCallback", () => {
    it("returns 401 HTML error page when session is not found or token missing", async () => {
      ((require("../../auth/auth").auth.api.getSession) as jest.Mock).mockResolvedValue(null);

      const mockReq: any = { headers: {} };
      const mockRes: any = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      await controller.handleOAuthCallback(mockReq, mockRes, "45211", "valid-nonce-1234567890abcdef");

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.send).toHaveBeenCalled();
      const html = mockRes.send.mock.calls[0][0];
      expect(html).toContain("Connexion non autorisée");
      expect(html).toContain("La session d'authentification n'a pas pu être validée");
    });

    it("rejects invalid desktopPort (privileged port or non-numeric)", async () => {
      ((require("../../auth/auth").auth.api.getSession) as jest.Mock).mockResolvedValue({
        session: { token: "valid-session-token" },
        user: { id: "u1", email: "test@example.com" },
      });

      const mockReq: any = { headers: {} };
      const mockRes: any = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await expect(
        controller.handleOAuthCallback(mockReq, mockRes, "80", "valid-nonce-1234567890abcdef"),
      ).rejects.toThrow(BadRequestException);

      await expect(
        controller.handleOAuthCallback(mockReq, mockRes, "not-a-port", "valid-nonce-1234567890abcdef"),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects malformed desktopNonce", async () => {
      ((require("../../auth/auth").auth.api.getSession) as jest.Mock).mockResolvedValue({
        session: { token: "valid-session-token" },
        user: { id: "u1", email: "test@example.com" },
      });

      const mockReq: any = { headers: {} };
      const mockRes: any = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      // Trop court
      await expect(controller.handleOAuthCallback(mockReq, mockRes, "45211", "short")).rejects.toThrow(
        BadRequestException,
      );

      // Caractères suspects
      await expect(
        controller.handleOAuthCallback(mockReq, mockRes, "45211", "nonce-with-<script>-attack"),
      ).rejects.toThrow(BadRequestException);
    });

    it("returns 200 HTML with loopback redirect when session and desktop params are valid", async () => {
      ((require("../../auth/auth").auth.api.getSession) as jest.Mock).mockResolvedValue({
        session: { token: "valid-session-token-desktop" },
        user: { id: "u123", email: "user@example.com", name: "User Test" },
      });

      const mockReq: any = { headers: {} };
      const mockRes: any = { status: jest.fn().mockReturnThis(), send: jest.fn() };

      await controller.handleOAuthCallback(
        mockReq,
        mockRes,
        "51234",
        "desktop-secure-nonce-123456789abcdef",
      );

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.send).toHaveBeenCalled();
      const html = mockRes.send.mock.calls[0][0];
      expect(html).toContain("Connexion réussie !");
      expect(html).toContain("http://127.0.0.1:51234/callback?code=");
      expect(html).toContain("desktop-secure-nonce-123456789abcdef");
      // Vérifier que le sessionToken réel n'est PAS exposé dans l'URL loopback
      expect(html).not.toContain("valid-session-token-desktop");
    });

    it("redirects web flow to '/' if user has businessId, or '/onboarding' if not", async () => {
      const mockReq: any = { headers: {} };
      const mockRes: any = { redirect: jest.fn() };

      // Avec businessId
      ((require("../../auth/auth").auth.api.getSession) as jest.Mock).mockResolvedValue({
        session: { token: "tok-1" },
        user: { id: "u1", email: "test@example.com", businessId: "biz-123" },
      });
      await controller.handleOAuthCallback(mockReq, mockRes);
      expect(mockRes.redirect).toHaveBeenCalledWith("/");

      // Sans businessId
      ((require("../../auth/auth").auth.api.getSession) as jest.Mock).mockResolvedValue({
        session: { token: "tok-2" },
        user: { id: "u2", email: "test2@example.com", businessId: null },
      });
      await controller.handleOAuthCallback(mockReq, mockRes);
      expect(mockRes.redirect).toHaveBeenCalledWith("/onboarding");
    });
  });

  describe("OAuthCallbackController - exchangeDesktopCode", () => {
    it("rejects exchange request without code", async () => {
      await expect(controller.exchangeDesktopCode({} as any)).rejects.toThrow(BadRequestException);
      await expect(controller.exchangeDesktopCode({ code: "" })).rejects.toThrow(BadRequestException);
    });

    it("exchanges valid code for sessionToken and user successfully", async () => {
      const code = desktopAuthService.createExchangeCode("secret-session-token-456", {
        id: "usr-456",
        email: "desktop@example.com",
      });

      const res = await controller.exchangeDesktopCode({ code });
      expect(res.ok).toBe(true);
      expect(res.sessionToken).toBe("secret-session-token-456");
      expect(res.user.id).toBe("usr-456");

      // Le code ne peut plus être réutilisé
      await expect(controller.exchangeDesktopCode({ code })).rejects.toThrow(UnauthorizedException);
    });
  });
});
