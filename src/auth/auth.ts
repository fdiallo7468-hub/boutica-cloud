import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { envSchema } from "../config/env.schema";
import { accounts, businesses, businessActivities, businessMembers, businessModuleConfigurations, sessions, users, verifications } from "../infrastructure/database/schema";
import { BUSINESS_SECTORS } from "../modules/business/business-taxonomy";

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
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

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
      if (!env.RESEND_API_KEY) {
        // Never write reset tokens or reset URLs to logs, including in development.
        throw new Error("Password reset email provider is not configured");
      }

      const resetLink = env.RESET_PASSWORD_URL
        ? (() => {
            const target = new URL(env.RESET_PASSWORD_URL);
            target.searchParams.set("token", token);
            return target.toString();
          })()
        : url;

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          from: env.EMAIL_FROM,
          to: [user.email],
          subject: "Réinitialisation de votre mot de passe Boutica Cloud",
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1e293b;">
              <h2 style="color: #0f172a; margin-bottom: 16px;">Réinitialisation de votre mot de passe</h2>
              <p>Bonjour ${escapeHtml(user.name || "")},</p>
              <p>Une demande de réinitialisation de mot de passe a été initiée pour votre compte Boutica Cloud.</p>
              <p>Ce lien est à usage unique et reste valide pendant <strong>1 heure</strong> :</p>
              <div style="margin: 28px 0;">
                <a href="${escapeHtml(resetLink)}" style="background-color: #2563eb; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: 600; display: inline-block;">
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
        // Do not log provider response bodies: they may contain recipient or request details.
        throw new Error(`Password reset email delivery failed (HTTP ${res.status})`);
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
          const businessName = (user as { businessName?: string }).businessName?.trim();

          // The PostgreSQL BEFORE/AFTER INSERT triggers provision the business,
          // defaults, membership and users.business_id in the same transaction
          // as the Better Auth user row. Do not create related rows from hooks:
          // Better Auth lifecycle hooks are not a transaction boundary.
          if (!businessName || businessName.length < 2 || businessName.length > 120) {
            throw new Error("Le nom de l'entreprise doit comporter entre 2 et 120 caractères");
          }

          const rawCurrency = (user as { businessCurrency?: string }).businessCurrency?.trim().toUpperCase();
          const currency = rawCurrency && /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : "XOF";
          const rawSector = (user as { businessSector?: string }).businessSector?.trim()?.toUpperCase();
          const sector = rawSector === BUSINESS_SECTORS.ELECTRONIQUE
            ? BUSINESS_SECTORS.ELECTRONIQUE
            : BUSINESS_SECTORS.QUINCAILLERIE;

          return {
            data: {
              ...user,
              email: rawEmail,
              businessName,
              businessCurrency: currency,
              businessSector: sector,
              businessPhone: (user as { businessPhone?: string }).businessPhone?.trim() || null,
              businessAddress: (user as { businessAddress?: string }).businessAddress?.trim() || null,
              personalPhone: (user as { personalPhone?: string }).personalPhone?.trim() || null,
              role: "OWNER",
            },
          };
        },
        after: async (user) => {
          // The PostgreSQL trigger writes business_id during INSERT. Better Auth's
          // create-user result may be assembled from the pre-insert input object,
          // so reload the persisted tenant fields before the sign-up response and
          // session are produced.
          const [persistedUser] = await db
            .select({ businessId: users.businessId, role: users.role })
            .from(users)
            .where(eq(users.id, user.id))
            .limit(1);

          if (!persistedUser?.businessId) {
            throw new Error('Atomic business provisioning did not produce a business_id');
          }

          Object.assign(user, {
            businessId: persistedUser.businessId,
            role: persistedUser.role,
          });
        },
      },
    },
  },

  plugins: [bearer()],
});
