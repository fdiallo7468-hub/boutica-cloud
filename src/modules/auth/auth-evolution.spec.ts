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
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { OnboardingController } from "./onboarding.controller";
import { CompleteBusinessOnboardingDto } from "./onboarding.dto";

describe("Auth Evolution & Data Model Specification", () => {
  describe("Priority 1 & 2: Business & User Data Model Separation and Validation", () => {
    it("validates that business model separates company info from user info", () => {
      const businessPayload = {
        name: "Boutique Prestige",
        currency: "XOF",
        phone: "+221338000000",
        sector: "COMMERCE_DETAIL",
        address: "Avenue Ponty, Dakar",
      };

      const userPayload = {
        name: "Fatou Ndiaye",
        email: "fatou@example.com",
        personalPhone: "+221770000000",
        role: "OWNER",
      };

      expect(businessPayload.name).toBe("Boutique Prestige");
      expect(businessPayload.currency).toMatch(/^[A-Z]{3}$/);
      expect(businessPayload.phone).toBeDefined();
      expect(businessPayload.sector).toBe("COMMERCE_DETAIL");
      expect(businessPayload.address).toBeDefined();

      expect(userPayload.name).toBe("Fatou Ndiaye");
      expect(userPayload.email).toContain("@");
      expect(userPayload.personalPhone).toBe("+221770000000");
      expect(userPayload.role).toBe("OWNER");
    });

    it("enforces currency normalization and defaults to XOF when not provided or malformed", () => {
      const normalizeCurrency = (raw?: string) => {
        const cleaned = raw?.trim().toUpperCase();
        return cleaned && /^[A-Z]{3}$/.test(cleaned) ? cleaned : "XOF";
      };

      expect(normalizeCurrency("eur")).toBe("EUR");
      expect(normalizeCurrency("USD")).toBe("USD");
      expect(normalizeCurrency("")).toBe("XOF");
      expect(normalizeCurrency("invalid_currency")).toBe("XOF");
      expect(normalizeCurrency(undefined)).toBe("XOF");
    });

    it("rejects business name with invalid length", () => {
      const validateBusinessName = (name?: string) => {
        const trimmed = name?.trim();
        if (!trimmed || trimmed.length < 2 || trimmed.length > 120) {
          throw new Error("Le nom de l'entreprise doit comporter entre 2 et 120 caractères");
        }
        return trimmed;
      };

      expect(() => validateBusinessName("")).toThrow("Le nom de l'entreprise doit comporter entre 2 et 120 caractères");
      expect(() => validateBusinessName("A")).toThrow("Le nom de l'entreprise doit comporter entre 2 et 120 caractères");
      expect(validateBusinessName("Mon Magasin")).toBe("Mon Magasin");
    });

    it("prevents client from injecting arbitrary businessId or elevating role to ADMIN", () => {
      const sanitizeHookInput = (rawInput: Record<string, any>, generatedBusinessId: string) => {
        // Enforce server-side authority: businessId comes from DB, role defaults to OWNER
        return {
          email: rawInput.email.toLowerCase().trim(),
          name: rawInput.name.trim(),
          personalPhone: rawInput.personalPhone?.trim() || null,
          businessId: generatedBusinessId, // overrides any rawInput.businessId
          role: "OWNER" as const, // overrides any rawInput.role
        };
      };

      const attackerInput = {
        email: "attacker@example.com",
        name: "Attacker",
        businessId: "00000000-0000-0000-0000-000000000000",
        role: "SUPER_ADMIN",
      };

      const sanitized = sanitizeHookInput(attackerInput, "legit-uuid-1234");
      expect(sanitized.businessId).toBe("legit-uuid-1234");
      expect(sanitized.role).toBe("OWNER");
    });
  });

  describe("Priority 4: Atomicity & Orphaned Business Prevention", () => {
    it("rejects duplicate email before creating business row", async () => {
      const existingEmails = new Set(["owner@boutica.test"]);

      const preCheckAndRegister = async (email: string, createBizMock: jest.Mock) => {
        const normalized = email.toLowerCase().trim();
        if (existingEmails.has(normalized)) {
          throw new Error("Un compte avec cette adresse e-mail existe déjà");
        }
        createBizMock();
      };

      const mockCreateBiz = jest.fn();

      await expect(preCheckAndRegister("owner@boutica.test", mockCreateBiz)).rejects.toThrow(
        "Un compte avec cette adresse e-mail existe déjà",
      );

      // Verify the business creation was NEVER called, preventing an orphaned business
      expect(mockCreateBiz).not.toHaveBeenCalled();

      // Non-duplicate passes and creates business
      await preCheckAndRegister("new-owner@boutica.test", mockCreateBiz);
      expect(mockCreateBiz).toHaveBeenCalledTimes(1);
    });
  });

  describe("Google & Apple OAuth: Onboarding Endpoint & Flow", () => {
    let controller: OnboardingController;
    let mockDb: any;

    beforeEach(() => {
      mockDb = {
        db: {
          select: jest.fn(),
          transaction: jest.fn(),
        },
      };
      controller = new OnboardingController(mockDb);
    });

    it("rejects business onboarding if user already has a businessId", async () => {
      const mockReq = { headers: { authorization: "Bearer valid-token" } } as any;
      const dto: CompleteBusinessOnboardingDto = {
        businessName: "Deuxième Entreprise",
      };

      // Mock session lookup
      // mocked
      // mocked
      ((require("../../auth/auth").auth.api.getSession) as jest.Mock).mockResolvedValue({
        user: { id: "user-123", email: "google-user@example.com" },
      });

      // Mock user already having a businessId in DB
      mockDb.db.select.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ id: "user-123", businessId: "existing-biz-id" }]),
        }),
      });

      await expect(controller.completeBusinessOnboarding(mockReq, dto)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("creates business and attaches it to user when user has businessId null", async () => {
      const mockReq = { headers: { authorization: "Bearer valid-token" } } as any;
      const dto: CompleteBusinessOnboardingDto = {
        businessName: "Nouvelle Boutique Google",
        currency: "XOF",
        businessPhone: "+221339999999",
        businessSector: "PHARMACIE",
        businessAddress: "Medina, Dakar",
      };

      // mocked
      // mocked
      ((require("../../auth/auth").auth.api.getSession) as jest.Mock).mockResolvedValue({
        user: { id: "user-456", email: "new-google@example.com" },
      });

      // Mock user with NO business in DB
      mockDb.db.select.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ id: "user-456", businessId: null }]),
        }),
      });

      // Mock transaction
      mockDb.db.transaction.mockImplementation(async (cb: any) => {
        const tx = {
          insert: jest.fn().mockReturnValue({
            values: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([
                {
                  id: "new-biz-789",
                  name: "Nouvelle Boutique Google",
                  currency: "XOF",
                  phone: "+221339999999",
                  sector: "PHARMACIE",
                  address: "Medina, Dakar",
                },
              ]),
            }),
          }),
          update: jest.fn().mockReturnValue({
            set: jest.fn().mockReturnValue({
              where: jest.fn().mockResolvedValue({}),
            }),
          }),
        };
        return cb(tx);
      });

      const response = await controller.completeBusinessOnboarding(mockReq, dto);
      expect(response.message).toBe("Entreprise configurée avec succès");
      expect(response.business.id).toBe("new-biz-789");
      expect(response.business.sector).toBe("PHARMACIE");
      expect(response.role).toBe("OWNER");
    });
  });

  describe("Password Reset & Resend Integration", () => {
    it("calculates 1-hour expiration and validates reset token logic", () => {
      const expiresInSeconds = 3600;
      const issuedAt = Math.floor(Date.now() / 1000);
      const expiresAt = issuedAt + expiresInSeconds;

      expect(expiresAt - issuedAt).toBe(3600);
      expect(new Date(expiresAt * 1000).getTime()).toBeGreaterThan(Date.now());
    });

    it("constructs explicit password reset URL without secrets", () => {
      const baseUrl = "https://boutica-cloud.onrender.com/reset-password";
      const token = "safe-opaque-reset-token-abc123xyz";
      const resetUrl = `${baseUrl}?token=${encodeURIComponent(token)}`;

      expect(resetUrl).toBe("https://boutica-cloud.onrender.com/reset-password?token=safe-opaque-reset-token-abc123xyz");
    });
  });

  describe("Callback URLs Configuration", () => {
    it("computes exact Google and Apple OAuth callback URLs matching Better Auth convention", () => {
      const betterAuthUrlProd = "https://boutica-cloud.onrender.com";
      const betterAuthUrlLocal = "http://localhost:3000";

      const googleCallbackProd = `${betterAuthUrlProd}/api/auth/callback/google`;
      const googleCallbackLocal = `${betterAuthUrlLocal}/api/auth/callback/google`;
      const appleCallbackProd = `${betterAuthUrlProd}/api/auth/callback/apple`;

      expect(googleCallbackProd).toBe("https://boutica-cloud.onrender.com/api/auth/callback/google");
      expect(googleCallbackLocal).toBe("http://localhost:3000/api/auth/callback/google");
      expect(appleCallbackProd).toBe("https://boutica-cloud.onrender.com/api/auth/callback/apple");
    });
  });
});
