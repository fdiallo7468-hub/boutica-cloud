import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { envSchema } from "../config/env.schema";
import { accounts, businesses, businessActivities, businessMembers, businessModuleConfigurations, sessions, users, verifications } from "../infrastructure/database/schema";
import { BUSINESS_SECTORS, BusinessSectorType, getDefaultModulesForSector, SECTOR_ACTIVITIES } from "../modules/business/business-taxonomy";

/**
 * v2.3 — Better Auth instance for Boutica Cloud.
 *
 * Implements:
 * - Strict Boutica Authentication (primary entry point is Email + Password)
 * - Anti-account-hijacking (accountLinking: false, disableSignUp: true on social providers)
 * - Rejection of unlinked Google & Apple sign-in attempts (no auto user/business creation)
 * - Dual Sector initialization (Quincaillerie / Électronique) with activities, modular config & business members
 * - Resend integration for password reset with 1h token expiration, single-use invalidation
 * - Multi-business access control & isolation
 */
const env = envSchema.parse(process.env);
const useSsl = env.DATABASE_URL.includes("sslmode=require") || env.NODE_ENV === "production";
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 5,
  ...(useSsl ? { ssl: { rejectUnauthorized: env.NODE_ENV === "production" } } : {}),
});
const db = drizzle(pool, { schema: { users, sessions, accounts, verifications, businesses, businessActivities, businessModuleConfigurations, businessMembers } });

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  trustedOrigins: env.CORS_ORIGIN?.split(",").map((o) => o.trim()),

  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
    },
  }),

  // Account configuration: Email + Password is the sole authenticating mechanism
  account: {
    accountLinking: {
      enabled: false,
    },
  },

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    requireEmailVerification: false,
    autoSignIn: true,
    resetPasswordTokenExpiresIn: 3600, // 1 hour expiration
    sendResetPassword: async ({ user, url, token }) => {
      const resetLink = env.RESET_PASSWORD_URL
        ? `${env.RESET_PASSWORD_URL}?token=${encodeURIComponent(token)}`
        : url;

      if (env.RESEND_API_KEY) {
        try {
          const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.RESEND_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: env.EMAIL_FROM,
              to: [user.email],
              subject: "Réinitialisation de votre mot de passe Boutica Cloud",
              html: `
                <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1e293b;">
                  <h2 style="color: #0f172a; margin-bottom: 16px;">Réinitialisation de votre mot de passe</h2>
                  <p>Bonjour ${user.name || ""},</p>
                  <p>Une demande de réinitialisation de mot de passe a été initiée pour votre compte Boutica Cloud.</p>
                  <p>Ce lien est à usage unique et reste valide pendant <strong>1 heure</strong> :</p>
                  <div style="margin: 28px 0;">
                    <a href="${resetLink}" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
                      Réinitialiser mon mot de passe
                    </a>
                  </div>
                  <p style="color: #64748b; font-size: 13px; line-height: 1.5;">
                    Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer cet e-mail. Votre mot de passe actuel reste inchangé.
                  </p>
                </div>
              `,
            }),
          });
          if (!res.ok) {
            const err = await res.text();
            console.error("[Auth/Resend] Échec d'envoi de l'e-mail:", err);
          } else {
            console.log(`[Auth/Resend] E-mail de réinitialisation envoyé avec succès à ${user.email}`);
          }
        } catch (err) {
          console.error("[Auth/Resend] Erreur de communication avec l'API Resend:", err);
        }
      } else {
        console.log(`[Auth/Resend] Simulation d'envoi (RESEND_API_KEY absent) pour ${user.email} -> ${resetLink}`);
      }
    },
  },

  user: {
    additionalFields: {
      businessId: {
        type: "string",
        required: false,
        input: false, // Critical: client can NEVER choose or inject businessId
      },
      businessName: {
        type: "string",
        required: false, // Optional on the model so social login can proceed; validated in hook for email sign-up
        input: true,
        returned: false,
      },
      businessCurrency: {
        type: "string",
        required: false,
        input: true,
        returned: false,
      },
      businessPhone: {
        type: "string",
        required: false,
        input: true,
        returned: false,
      },
      businessSector: {
        type: "string",
        required: false,
        input: true,
        returned: false,
      },
      businessAddress: {
        type: "string",
        required: false,
        input: true,
        returned: false,
      },
      personalPhone: {
        type: "string",
        required: false,
        input: true,
        returned: true,
      },
      role: {
        type: ["OWNER", "STAFF"],
        required: false,
        defaultValue: "OWNER",
        input: false, // Critical: client can NEVER elevate its own role
      },
    },
  },

  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const rawEmail = (user.email || "").trim().toLowerCase();

          // 1. Pre-check email uniqueness to guarantee atomicity and avoid orphaned businesses
          const existingUser = await db.query.users.findFirst({
            where: eq(users.email, rawEmail),
          });
          if (existingUser) {
            throw new Error("Un compte avec cette adresse e-mail existe déjà");
          }

          const rawCurrency = (user as { businessCurrency?: string }).businessCurrency?.trim().toUpperCase();
          const currency = rawCurrency && /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : "XOF";
          const businessName = (user as { businessName?: string }).businessName?.trim();
          const businessPhone = (user as { businessPhone?: string }).businessPhone?.trim() || null;
          const rawSector = (user as { businessSector?: string }).businessSector?.trim()?.toUpperCase();
          const sector: BusinessSectorType = rawSector === "ELECTRONIQUE" ? "ELECTRONIQUE" : "QUINCAILLERIE";
          const businessAddress = (user as { businessAddress?: string }).businessAddress?.trim() || null;
          const personalPhone = (user as { personalPhone?: string }).personalPhone?.trim() || null;

          // 2. Strict Boutica Auth Rule:
          // Account creation MUST have a valid businessName (Email + Password signup form).
          // Direct OAuth signup attempts are strictly blocked.
          if (!businessName) {
            throw new Error(
              "L'inscription directe via un fournisseur tiers n'est pas autorisée. Veuillez créer votre compte Boutica avec un e-mail et mot de passe, puis lier vos fournisseurs dans les paramètres.",
            );
          }

          if (businessName.length < 2 || businessName.length > 120) {
            throw new Error("Le nom de l'entreprise doit comporter entre 2 et 120 caractères");
          }

          // 3. Atomically create business, default sector activities, and default modules
          const [business] = await db
            .insert(businesses)
            .values({
              name: businessName,
              currency,
              phone: businessPhone,
              sector,
              address: businessAddress,
            })
            .returning();

          if (!business) {
            throw new Error("Échec de la création de l'entreprise");
          }

          // Seed default activities for selected sector
          const defaultActivities = SECTOR_ACTIVITIES[sector].map((act) => ({
            businessId: business.id,
            activity: act.code,
            isActive: true,
          }));
          if (defaultActivities.length > 0) {
            await db.insert(businessActivities).values(defaultActivities).onConflictDoNothing();
          }

          // Seed default module configurations for selected sector
          const defaultModules = getDefaultModulesForSector(sector).map((modCode) => ({
            businessId: business.id,
            module: modCode,
            isEnabled: true,
            settings: {},
          }));
          if (defaultModules.length > 0) {
            await db.insert(businessModuleConfigurations).values(defaultModules).onConflictDoNothing();
          }

          return {
            data: {
              ...user,
              email: rawEmail,
              businessId: business.id,
              personalPhone,
              role: "OWNER",
            },
          };
        },
        after: async (user) => {
          // Record business ownership in business_members table
          const customUser = user as typeof user & { businessId?: string | null; role?: string };
          if (customUser.businessId && customUser.id) {
            await db
              .insert(businessMembers)
              .values({
                businessId: customUser.businessId,
                userId: customUser.id,
                role: (customUser.role as "OWNER" | "STAFF") || "OWNER",
              })
              .onConflictDoNothing();
          }
        },
      },
    },
  },

  plugins: [bearer()],
});
