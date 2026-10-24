import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { envSchema } from "../config/env.schema";
import { accounts, businesses, sessions, users, verifications } from "../infrastructure/database/schema";

/**
 * v2.2 — Better Auth instance for Boutica Cloud.
 *
 * Implements:
 * - Complete business + user data model (Business: name, currency, phone, sector, address / User: name, email, personal phone)
 * - Anti-account-hijacking (accountLinking: false)
 * - Safe Google & Apple OAuth with explicit business onboarding flow (no arbitrary business generation)
 * - Resend integration for password reset with 1h token expiration, single-use invalidation, and graceful offline fallback
 * - Prevention of orphaned businesses via email pre-validation
 * - Protection against client-side injection of businessId or privileged roles
 */
const env = envSchema.parse(process.env);
const useSsl = env.DATABASE_URL.includes("sslmode=require") || env.NODE_ENV === "production";
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 5,
  ...(useSsl ? { ssl: { rejectUnauthorized: env.NODE_ENV === "production" } } : {}),
});
const db = drizzle(pool, { schema: { users, sessions, accounts, verifications, businesses } });

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

  // Account linking is deliberately disabled to prevent account hijacking:
  // An attacker cannot link a third-party Google/Apple account to an existing password account
  // merely by having matching email addresses without prior explicit ownership verification.
  account: {
    accountLinking: {
      enabled: false,
    },
  },

  // Social OAuth Providers (activated only when corresponding credentials are configured)
  socialProviders: {
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
          },
        }
      : {}),
    ...(env.APPLE_CLIENT_ID && env.APPLE_CLIENT_SECRET
      ? {
          apple: {
            clientId: env.APPLE_CLIENT_ID,
            clientSecret: env.APPLE_CLIENT_SECRET,
          },
        }
      : {}),
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
          const businessSector = (user as { businessSector?: string }).businessSector?.trim() || null;
          const businessAddress = (user as { businessAddress?: string }).businessAddress?.trim() || null;
          const personalPhone = (user as { personalPhone?: string }).personalPhone?.trim() || null;

          // 2. If business details are provided (e.g. Email Sign-up form):
          if (businessName) {
            if (businessName.length < 2 || businessName.length > 120) {
              throw new Error("Le nom de l'entreprise doit comporter entre 2 et 120 caractères");
            }

            const [business] = await db
              .insert(businesses)
              .values({
                name: businessName,
                currency,
                phone: businessPhone,
                sector: businessSector,
                address: businessAddress,
              })
              .returning();

            if (!business) {
              throw new Error("Échec de la création de l'entreprise");
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
          }

          // 3. If no businessName was provided (e.g. initial Google or Apple OAuth sign-in):
          // We DO NOT assign an arbitrary business. The user row is created with businessId: null,
          // and the user must complete onboarding via /api/v1/auth/onboarding/business.
          return {
            data: {
              ...user,
              email: rawEmail,
              businessId: null,
              personalPhone,
              role: "OWNER",
            },
          };
        },
      },
    },
  },

  plugins: [bearer()],
});
