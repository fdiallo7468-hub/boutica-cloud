import {
  bigint,
  boolean,
  check,
  date,
  index,
  foreignKey,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const productStatus = pgEnum('product_status', ['ACTIVE', 'INACTIVE']);
export const saleStatus = pgEnum('sale_status', ['DRAFT', 'COMPLETED', 'CANCELLED']);
export const purchaseStatus = pgEnum('purchase_status', ['DRAFT', 'RECEIVED', 'CANCELLED']);
export const movementType = pgEnum('stock_movement_type', ['PURCHASE', 'SALE', 'RETURN', 'ADJUSTMENT', 'DAMAGE']);
export const userRole = pgEnum('user_role', ['OWNER', 'STAFF']);
export const returnStatus = pgEnum('return_status', ['COMPLETED', 'CANCELLED']);

export const businesses = pgTable('businesses', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  currency: text('currency').notNull().default('XOF'),
  phone: text('phone'),
  sector: text('sector').notNull().default('QUINCAILLERIE'),
  address: text('address'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * v3 — Physical or operational locations belonging to a business tenant.
 * A business always has one active default location; operational records
 * will progressively receive a location_id in additive follow-up migrations.
 */
export const businessLocations = pgTable(
  'business_locations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    address: text('address'),
    phone: text('phone'),
    isDefault: boolean('is_default').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    businessCodeUnique: uniqueIndex('business_locations_business_code_unique').on(t.businessId, t.code),
    businessIdIdUnique: uniqueIndex('business_locations_business_id_id_unique').on(t.businessId, t.id),
    oneDefaultPerBusiness: uniqueIndex('business_locations_one_default_per_business_unique')
      .on(t.businessId)
      .where(sql`${t.isDefault} = true`),
    businessIdx: index('business_locations_business_idx').on(t.businessId),
    activeIdx: index('business_locations_active_idx').on(t.businessId, t.isActive),
  }),
);

/**
 * Activités commerciales d'une entreprise (secteur Quincaillerie et Électronique).
 * Une entreprise peut posséder plusieurs activités compatibles.
 * Le retrait d'une activité passe is_active à false sans jamais supprimer de données historiques.
 */
export const businessActivities = pgTable(
  'business_activities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
    activity: text('activity').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    businessActivityUnique: uniqueIndex('business_activities_business_activity_unique').on(t.businessId, t.activity),
    businessIdx: index('business_activities_business_idx').on(t.businessId),
  }),
);

/**
 * Configuration modulaire dynamique par entreprise.
 * Active ou désactive les modules spécialisés (IMEI, Garanties, Unités de mesure, etc.)
 */
export const businessModuleConfigurations = pgTable(
  'business_module_configurations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
    module: text('module').notNull(),
    isEnabled: boolean('is_enabled').notNull().default(true),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    businessModuleUnique: uniqueIndex('business_modules_business_module_unique').on(t.businessId, t.module),
    businessIdx: index('business_modules_business_idx').on(t.businessId),
  }),
);

/**
 * Appartenance multi-entreprises : un utilisateur peut appartenir à plusieurs boutiques/entreprises.
 */
export const businessMembers = pgTable(
  'business_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: userRole('role').notNull().default('OWNER'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    memberUnique: uniqueIndex('business_members_unique').on(t.businessId, t.userId),
    userIdx: index('business_members_user_idx').on(t.userId),
    businessIdx: index('business_members_business_idx').on(t.businessId),
  }),
);

// v2.0 — Better Auth owns this table now (mapped via drizzleAdapter's
// `schema: { user: schema.users, ... }` option in src/auth/auth.ts).
// id/name/email/emailVerified/image/createdAt/updatedAt are Better Auth's
// required core "user" fields — do not rename or drop them. Passwords are
// NOT stored here: Better Auth keeps them on `accounts` instead (one row
// per credential/provider), which is also where a future social-login
// provider would attach without touching this table.
//
// businessId/businessName/businessCurrency/role are Boutica's own
// `additionalFields` (see src/auth/auth.ts). businessName/businessCurrency
// are write-only at sign-up time — consumed by the databaseHooks.user.
// create.before hook to create the `businesses` row and never returned to
// clients afterward — but the columns stay on this table because that's
// where Better Auth's Drizzle adapter needs to write them; there's no
// clean way to route a single field through a hook into a different table
// before the row exists yet to reference.
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    // Set by the create-hook before insert, never by client input — see
    // AUDIT_REPORT.md section H. NOT NULL is deliberate defense-in-depth:
    // if the hook is ever bypassed or refactored incorrectly, insertion
    // fails loudly instead of silently creating a tenant-less user.
    // businessId is nullable to allow Google/Apple OAuth users to exist before onboarding
    businessId: uuid('business_id').references(() => businesses.id, { onDelete: 'cascade' }),
    businessName: text('business_name'),
    businessCurrency: text('business_currency'),
    businessPhone: text('business_phone'),
    businessSector: text('business_sector'),
    businessAddress: text('business_address'),
    personalPhone: text('personal_phone'),
    role: userRole('role').notNull().default('OWNER'),
  },
  (t) => ({
    emailUnique: uniqueIndex('users_email_unique').on(t.email),
    businessIdx: index('users_business_idx').on(t.businessId),
  }),
);

// Better Auth "session" core model.
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ userIdx: index('sessions_user_idx').on(t.userId) }),
);

// Better Auth "account" core model — one row per credential/provider per
// user. For email+password (the only provider this app enables), this is
// where the password hash actually lives (Better Auth's own scrypt-based
// hashing, not bcrypt — see AUDIT_REPORT.md section H for why bcrypt was
// dropped rather than kept alongside it).
export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    password: text('password'),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ userIdx: index('accounts_user_idx').on(t.userId) }),
);

// Better Auth "verification" core model — required by the adapter even
// though this app doesn't enable email verification or password-reset
// emails today (no email-sending infrastructure exists); Better Auth
// writes to it internally regardless of which features are switched on.
export const verifications = pgTable(
  'verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ identifierIdx: index('verifications_identifier_idx').on(t.identifier) }),
);

export const products = pgTable(
  'products',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    name: text('name').notNull(),
    description: text('description'),
    category: text('category'),
    brand: text('brand'),
    status: productStatus('status').notNull().default('ACTIVE'),
    imageUrl: text('image_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ businessNameIdx: index('products_business_name_idx').on(t.businessId, t.name) }),
);

export const variants = pgTable(
  'variants',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // Denormalized on purpose: the inventory/sales/purchasing hot paths key
    // directly off variantId with no join to products, so businessId must
    // live here too or tenant filtering on those paths is impossible
    // without a join on every single query. See AUDIT_REPORT.md P0-1/P0-2.
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    productId: uuid('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    attributes: jsonb('attributes').$type<Record<string, string>>().notNull().default({}),
    purchasePrice: numeric('purchase_price', { precision: 14, scale: 2 }).notNull().default('0'),
    sellingPrice: numeric('selling_price', { precision: 14, scale: 2 }).notNull().default('0'),
    imageUrl: text('image_url'),
    // Nouveaux champs modulaires compatibles Quincaillerie & Électronique
    unit: text('unit'), // Ex: "Sac", "Barre", "Mètre", "Pièce", "Carton", "Rouleau", "Kg"
    hasSerial: boolean('has_serial').notNull().default(false), // Requis pour Électronique (appareils, TV, PC)
    hasImei: boolean('has_imei').notNull().default(false), // Requis pour Téléphonie (Smartphones, tablettes)
    warrantyMonths: integer('warranty_months').notNull().default(0), // Durée de garantie en mois
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // FIX: SKU used to be globally unique across ALL tenants, which makes
    // the product unusable by more than one business at a time (two
    // unrelated shops both want to use "SKU-001"). Scoped to the business
    // instead. See AUDIT_REPORT.md P1-1.
    skuPerBusinessIdx: uniqueIndex('variants_business_sku_unique').on(t.businessId, t.sku),
    productIdx: index('variants_product_idx').on(t.productId),
    businessIdx: index('variants_business_idx').on(t.businessId),
    businessIdIdUnique: uniqueIndex('variants_business_id_id_unique').on(t.businessId, t.id),
    sellingGtePurchase: check('variant_selling_gte_purchase', sql`${t.sellingPrice} >= ${t.purchasePrice}`),
    pricesNonNegative: check('variant_prices_non_negative', sql`${t.purchasePrice} >= 0 AND ${t.sellingPrice} >= 0`),
  }),
);

/**
 * Traçabilité unitaire des numéros de série et IMEI (Secteur Électronique).
 * Permet le suivi individuel de chaque appareil vendu, la validation de garantie et le SAV.
 */
export const deviceSerials = pgTable(
  'device_serials',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
    variantId: uuid('variant_id').notNull().references(() => variants.id, { onDelete: 'cascade' }),
    serialNumber: text('serial_number'),
    imei: text('imei'),
    status: text('status').notNull().default('IN_STOCK'), // 'IN_STOCK', 'SOLD', 'DEFECTIVE', 'REPAIR'
    warrantyMonths: integer('warranty_months').notNull().default(0),
    saleItemId: uuid('sale_item_id'),
    soldAt: timestamp('sold_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    businessIdx: index('device_serials_business_idx').on(t.businessId),
    variantIdx: index('device_serials_variant_idx').on(t.variantId),
    serialUnique: uniqueIndex('device_serials_business_serial_unique').on(t.businessId, t.serialNumber),
    imeiUnique: uniqueIndex('device_serials_business_imei_unique').on(t.businessId, t.imei),
  }),
);

export const stock = pgTable(
  'stock',
  {
    variantId: uuid('variant_id').primaryKey().references(() => variants.id, { onDelete: 'cascade' }),
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    quantity: integer('quantity').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    businessIdx: index('stock_business_idx').on(t.businessId),
    // Last-resort, defence-in-depth invariant: even if application-level
    // locking is ever bypassed or buggy, Postgres itself will refuse to let
    // stock go negative. See AUDIT_REPORT.md P0-2.
    quantityNonNegative: check('stock_quantity_non_negative', sql`${t.quantity} >= 0`),
  }),
);

/** Per-location stock balance. The legacy stock table remains the compatibility aggregate during v3 rollout. */
export const inventoryBalances = pgTable(
  'inventory_balances',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    quantity: integer('quantity').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    scopeUnique: uniqueIndex('inventory_balances_scope_unique').on(t.businessId, t.locationId, t.variantId),
    businessVariantIdx: index('inventory_balances_business_variant_idx').on(t.businessId, t.variantId),
    businessLocationIdx: index('inventory_balances_business_location_idx').on(t.businessId, t.locationId),
    quantityNonNegative: check('inventory_balances_quantity_non_negative', sql`${t.quantity} >= 0`),
  }),
);

export const stockMovements = pgTable(
  'stock_movements',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    locationId: uuid('location_id').notNull(),
    variantId: uuid('variant_id').notNull().references(() => variants.id),
    type: movementType('type').notNull(),
    quantity: integer('quantity').notNull(),
    referenceId: uuid('reference_id'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    variantDateIdx: index('stock_movements_variant_date_idx').on(t.variantId, t.createdAt),
    businessIdx: index('stock_movements_business_idx').on(t.businessId),
  }),
);

export const suppliers = pgTable('suppliers', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').notNull().references(() => businesses.id),
  name: text('name').notNull(),
  phone: text('phone'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ businessIdIdUnique: uniqueIndex('suppliers_business_id_id_unique').on(t.businessId, t.id) }));

export const purchases = pgTable('purchases', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').notNull().references(() => businesses.id),
  locationId: uuid('location_id').notNull(),
  supplierId: uuid('supplier_id').references(() => suppliers.id),
  status: purchaseStatus('status').notNull().default('DRAFT'),
  total: numeric('total', { precision: 14, scale: 2 }).notNull().default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const purchaseItems = pgTable('purchase_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  purchaseId: uuid('purchase_id').notNull().references(() => purchases.id, { onDelete: 'cascade' }),
  variantId: uuid('variant_id').notNull().references(() => variants.id),
  quantity: integer('quantity').notNull(),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
}, (t) => ({
  quantityPositive: check('purchase_items_quantity_positive', sql`${t.quantity} > 0`),
}));

export const customers = pgTable('customers', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').notNull().references(() => businesses.id),
  name: text('name').notNull(),
  phone: text('phone'),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({ businessIdIdUnique: uniqueIndex('customers_business_id_id_unique').on(t.businessId, t.id) }));

export const sales = pgTable(
  'sales',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    locationId: uuid('location_id').notNull(),
    customerId: uuid('customer_id').references(() => customers.id),
    status: saleStatus('status').notNull().default('DRAFT'),
    subtotal: numeric('subtotal', { precision: 14, scale: 2 }).notNull().default('0'),
    discount: numeric('discount', { precision: 14, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 14, scale: 2 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    discountWithinSubtotal: check('sales_discount_within_subtotal', sql`${t.discount} >= 0 AND ${t.discount} <= ${t.subtotal}`),
  }),
);

export const saleItems = pgTable('sale_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  saleId: uuid('sale_id').notNull().references(() => sales.id, { onDelete: 'cascade' }),
  variantId: uuid('variant_id').notNull().references(() => variants.id),
  quantity: integer('quantity').notNull(),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
  // NEW (v2.0) — the variant's purchasePrice *at the moment of this sale*,
  // captured once and never updated again. Fixes the caveat flagged in
  // AUDIT_REPORT.md round 2 (R2-5): margin/profit reporting used to read
  // variants.purchasePrice, the CURRENT cost, so an old sale's reported
  // margin would silently drift if the variant's cost changed later.
  // Nullable only because rows created before this migration have no
  // historical value to backfill; every new sale populates it.
  costAtSale: numeric('cost_at_sale', { precision: 14, scale: 2 }),
}, (t) => ({
  quantityPositive: check('sale_items_quantity_positive', sql`${t.quantity} > 0`),
}));

export const loyaltyConfigurations = pgTable('loyalty_configurations', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  earnPointsPer1000: integer('earn_points_per_1000').notNull().default(1),
  pointValue: numeric('point_value', { precision: 14, scale: 4 }).notNull().default('1'),
  minimumRedemptionPoints: integer('minimum_redemption_points').notNull().default(100),
  expiryDays: integer('expiry_days'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  businessUnique: uniqueIndex('loyalty_configurations_business_unique').on(t.businessId),
  validEarnRate: check('loyalty_configurations_earn_rate_non_negative', sql`${t.earnPointsPer1000} >= 0`),
  validPointValue: check('loyalty_configurations_point_value_positive', sql`${t.pointValue} > 0`),
  validMinimum: check('loyalty_configurations_minimum_non_negative', sql`${t.minimumRedemptionPoints} >= 0`),
  validExpiry: check('loyalty_configurations_expiry_positive', sql`${t.expiryDays} IS NULL OR ${t.expiryDays} > 0`),
}));

/** Append-only points ledger. Corrections are compensating entries, never updates. */
export const loyaltyLedger = pgTable('loyalty_ledger', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
  customerId: uuid('customer_id').notNull().references(() => customers.id, { onDelete: 'restrict' }),
  actorUserId: text('actor_user_id'),
  pointsDelta: integer('points_delta').notNull(),
  eventType: text('event_type').notNull(),
  sourceId: uuid('source_id').notNull(),
  relatedSaleId: uuid('related_sale_id').references(() => sales.id, { onDelete: 'restrict' }),
  idempotencyKey: text('idempotency_key').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  businessIdempotencyUnique: uniqueIndex('loyalty_ledger_business_idempotency_unique').on(t.businessId, t.idempotencyKey),
  customerTimeIdx: index('loyalty_ledger_customer_time_idx').on(t.businessId, t.customerId, t.createdAt),
  saleIdx: index('loyalty_ledger_sale_idx').on(t.businessId, t.relatedSaleId),
  nonZeroDelta: check('loyalty_ledger_non_zero_delta', sql`${t.pointsDelta} <> 0`),
  validEvent: check('loyalty_ledger_event_type_valid', sql`${t.eventType} IN ('SALE_EARN','RETURN_REVERSAL','SALE_CANCELLATION_REVERSAL','MANUAL_ADJUSTMENT')`),
}));

export const expenses = pgTable('expenses', {
  id: uuid('id').defaultRandom().primaryKey(),
  businessId: uuid('business_id').notNull().references(() => businesses.id),
  locationId: uuid('location_id').notNull(),
  category: text('category').notNull(),
  description: text('description'),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// NEW — Returns did not exist at all. See AUDIT_REPORT.md P0-3.
export const returns = pgTable(
  'returns',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    saleId: uuid('sale_id').notNull().references(() => sales.id),
    status: returnStatus('status').notNull().default('COMPLETED'),
    total: numeric('total', { precision: 14, scale: 2 }).notNull().default('0'),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    businessIdx: index('returns_business_idx').on(t.businessId),
    saleIdx: index('returns_sale_idx').on(t.saleId),
  }),
);

export const returnItems = pgTable('return_items', {
  id: uuid('id').defaultRandom().primaryKey(),
  returnId: uuid('return_id').notNull().references(() => returns.id, { onDelete: 'cascade' }),
  saleItemId: uuid('sale_item_id').notNull().references(() => saleItems.id),
  variantId: uuid('variant_id').notNull().references(() => variants.id),
  quantity: integer('quantity').notNull(),
  unitPrice: numeric('unit_price', { precision: 14, scale: 2 }).notNull(),
  // RESTOCK -> goes back into sellable stock. DAMAGED -> logged as a DAMAGE
  // stock movement, never re-enters sellable stock.
  condition: text('condition').notNull().default('RESTOCK'),
}, (t) => ({
  quantityPositive: check('return_items_quantity_positive', sql`${t.quantity} > 0`),
  conditionValid: check('return_items_condition_valid', sql`${t.condition} IN ('RESTOCK','DAMAGED')`),
}));

// NEW — supports the Idempotency-Key handling for Create Sale / Receive
// Purchase / Create Return. See AUDIT_REPORT.md P0-5.
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    endpoint: text('endpoint').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    scopeUnique: uniqueIndex('idempotency_keys_scope_unique').on(t.businessId, t.endpoint, t.key),
  }),
);

/**
 * ---------------------------------------------------------------------------
 * PARTIE 5 — NOTIFICATION OUTBOX (NOVU WORKER ENGINE)
 * Table d'outbox persistante transactionnelle avec déduplication et retry exponentiel.
 * ---------------------------------------------------------------------------
 */
export const notificationOutbox = pgTable(
  'notification_outbox',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    deduplicationKey: text('deduplication_key').notNull(),
    payload: jsonb('payload').notNull().default({}),
    status: text('status').notNull().default('PENDING'), // 'PENDING', 'PROCESSING', 'DELIVERED', 'FAILED'
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).defaultNow().notNull(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => ({
    deduplicationKeyUnique: uniqueIndex('notification_outbox_business_dedup_unique').on(t.businessId, t.deduplicationKey),
    statusIdx: index('notification_outbox_status_idx').on(t.status),
    availableAtIdx: index('notification_outbox_available_at_idx').on(t.availableAt),
    businessIdx: index('notification_outbox_business_idx').on(t.businessId),
  }),
);

export const pushDevices = pgTable(
  'push_devices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    token: text('token').notNull(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
    stockAlerts: boolean('stock_alerts').notNull().default(true),
    salesAlerts: boolean('sales_alerts').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    businessIdx: index('push_devices_business_idx').on(t.businessId),
    userIdx: index('push_devices_user_idx').on(t.userId),
  }),
);

/**
 * ---------------------------------------------------------------------------
 * PARTIE 6 — MODULE CRÉANCES & PAIEMENTS
 * Gestion financière rigoureuse des règlements intégraux, partiels et différés.
 * Précision monétaire numeric(14, 2) et traçabilité complète.
 * ---------------------------------------------------------------------------
 */
export const receivables = pgTable(
  'receivables',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').notNull(),
    customerId: uuid('customer_id').notNull().references(() => customers.id),
    saleId: uuid('sale_id').notNull().references(() => sales.id, { onDelete: 'cascade' }),
    initialAmount: numeric('initial_amount', { precision: 14, scale: 2 }).notNull(),
    paidAmount: numeric('paid_amount', { precision: 14, scale: 2 }).notNull().default('0'),
    remainingBalance: numeric('remaining_balance', { precision: 14, scale: 2 }).notNull(),
    dueDate: timestamp('due_date', { withTimezone: true }),
    status: text('status').notNull().default('PENDING'), // 'PENDING', 'PARTIALLY_PAID', 'OVERDUE', 'PAID', 'CANCELLED'
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    businessIdx: index('receivables_business_idx').on(t.businessId),
    customerIdx: index('receivables_customer_idx').on(t.customerId),
    saleIdx: index('receivables_sale_idx').on(t.saleId),
    statusIdx: index('receivables_status_idx').on(t.status),
    dueDateIdx: index('receivables_due_date_idx').on(t.dueDate),
  }),
);

export const payments = pgTable(
  'payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
    locationId: uuid('location_id').notNull(),
    customerId: uuid('customer_id').notNull().references(() => customers.id),
    saleId: uuid('sale_id').references(() => sales.id),
    receivableId: uuid('receivable_id').references(() => receivables.id),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    paymentMethod: text('payment_method').notNull().default('CASH'), // CASH, ORANGE_MONEY, MOOV_MONEY, BANK_TRANSFER, CARD, WAVE, OTHER
    transactionReference: text('transaction_reference'),
    recordedBy: text('recorded_by').references(() => users.id),
    status: text('status').notNull().default('CONFIRMED'), // 'CONFIRMED', 'CANCELLED'
    receiptNumber: text('receipt_number').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    businessIdx: index('payments_business_idx').on(t.businessId),
    customerIdx: index('payments_customer_idx').on(t.customerId),
    saleIdx: index('payments_sale_idx').on(t.saleId),
    receivableIdx: index('payments_receivable_idx').on(t.receivableId),
    statusIdx: index('payments_status_idx').on(t.status),
    receiptUnique: uniqueIndex('payments_receipt_number_unique').on(t.businessId, t.receiptNumber),
  }),
);

export const paymentCancellations = pgTable(
  'payment_cancellations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
    paymentId: uuid('payment_id').notNull().references(() => payments.id, { onDelete: 'cascade' }),
    cancelledBy: text('cancelled_by').notNull().references(() => users.id),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    businessIdx: index('payment_cancellations_business_idx').on(t.businessId),
    paymentIdx: index('payment_cancellations_payment_idx').on(t.paymentId),
  }),
);

/**
 * ---------------------------------------------------------------------------
 * PARTIE 7 — MODE HORS LIGNE & SYNCHRONISATION (OFFLINE-FIRST)
 * Suivi des appareils enregistrés et journal d'idempotence des opérations locales.
 * ---------------------------------------------------------------------------
 */
export const syncDevices = pgTable(
  'sync_devices',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull(),
    deviceType: text('device_type').notNull().default('DESKTOP'), // 'DESKTOP', 'MOBILE'
    deviceName: text('device_name'),
    appVersion: text('app_version'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    deviceScopeUnique: uniqueIndex('sync_devices_scope_unique').on(t.businessId, t.deviceId),
    businessIdx: index('sync_devices_business_idx').on(t.businessId),
  }),
);

export const offlineOperationsLog = pgTable(
  'offline_operations_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull(),
    clientOperationId: text('client_operation_id').notNull(),
    operationType: text('operation_type').notNull(), // 'CREATE_SALE', 'RECORD_PAYMENT', etc.
    status: text('status').notNull().default('COMMITTED'), // 'COMMITTED', 'REJECTED', 'CONFLICT_RESOLVED'
    clientTimestamp: timestamp('client_timestamp', { withTimezone: true }).notNull(),
    serverTimestamp: timestamp('server_timestamp', { withTimezone: true }).defaultNow().notNull(),
    payload: jsonb('payload').notNull().default({}),
    conflictDetails: jsonb('conflict_details'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    opUnique: uniqueIndex('offline_ops_client_op_unique').on(t.businessId, t.clientOperationId),
    businessIdx: index('offline_ops_business_idx').on(t.businessId),
    deviceIdx: index('offline_ops_device_idx').on(t.deviceId),
  }),
);



/**
 * ---------------------------------------------------------------------------
 * PARTIE 8 — COMPTABILITÉ GÉNÉRALE SYSCOHADA (Phase 4)
 * Les règles métier et la validation réglementaire résident dans le module
 * accounting. Les montants des futures écritures utiliseront NUMERIC.
 * ---------------------------------------------------------------------------
 */
export const accountingProfiles = pgTable(
  'accounting_profiles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
    countryCode: text('country_code').notNull().default('ML'),
    framework: text('framework').notNull().default('SYSCOHADA_REVISED'),
    accountingSystem: text('accounting_system').notNull().default('NORMAL'),
    currency: text('currency').notNull().default('XOF'),
    chartVersion: text('chart_version').notNull().default('SYSCOHADA_2017'),
    configuredAt: timestamp('configured_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    businessUnique: uniqueIndex('accounting_profiles_business_unique').on(t.businessId),
    countryCheck: check('accounting_profiles_country_check', sql`${t.countryCode} ~ '^[A-Z]{2}$'`),
    frameworkCheck: check('accounting_profiles_framework_check', sql`${t.framework} = 'SYSCOHADA_REVISED'`),
    systemCheck: check('accounting_profiles_system_check', sql`${t.accountingSystem} IN ('NORMAL', 'SMT')`),
    currencyCheck: check('accounting_profiles_currency_check', sql`${t.currency} ~ '^[A-Z]{3}$'`),
  }),
);

export const accountingAccounts = pgTable(
  'accounting_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
    accountNumber: text('account_number').notNull(),
    label: text('label').notNull(),
    class: integer('class').notNull(),
    parentAccountId: uuid('parent_account_id'),
    normalBalance: text('normal_balance').notNull(),
    isPostable: boolean('is_postable').notNull().default(true),
    isActive: boolean('is_active').notNull().default(true),
    sourceFramework: text('source_framework').notNull().default('SYSCOHADA_REVISED'),
    sourceVersion: text('source_version').notNull().default('SYSCOHADA_2017'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    businessNumberUnique: uniqueIndex('accounting_accounts_business_number_unique').on(t.businessId, t.accountNumber),
    businessIdIdUnique: uniqueIndex('accounting_accounts_business_id_id_unique').on(t.businessId, t.id),
    businessClassIdx: index('accounting_accounts_business_class_idx').on(t.businessId, t.class, t.accountNumber),
    businessParentIdx: index('accounting_accounts_business_parent_idx').on(t.businessId, t.parentAccountId),
    classCheck: check('accounting_accounts_class_check', sql`${t.class} BETWEEN 1 AND 9`),
    numberCheck: check('accounting_accounts_number_check', sql`${t.accountNumber} ~ '^[0-9]{1,20}$'`),
    labelCheck: check('accounting_accounts_label_check', sql`length(btrim(${t.label})) BETWEEN 2 AND 180`),
    balanceCheck: check('accounting_accounts_balance_check', sql`${t.normalBalance} IN ('DEBIT', 'CREDIT')`),
    frameworkCheck: check('accounting_accounts_framework_check', sql`${t.sourceFramework} = 'SYSCOHADA_REVISED'`),
    parentFk: foreignKey({
      name: 'accounting_accounts_parent_fk',
      columns: [t.businessId, t.parentAccountId],
      foreignColumns: [t.businessId, t.id],
    }),
    noSelfParent: check('accounting_accounts_no_self_parent', sql`${t.parentAccountId} IS NULL OR ${t.parentAccountId} <> ${t.id}`),
  }),
);

export const accountingFiscalYears = pgTable(
  'accounting_fiscal_years',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    label: text('label').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    status: text('status').notNull().default('OPEN'),
    openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    businessCodeUnique: uniqueIndex('accounting_fiscal_years_business_code_unique').on(t.businessId, t.code),
    businessIdIdUnique: uniqueIndex('accounting_fiscal_years_business_id_id_unique').on(t.businessId, t.id),
    businessDatesIdx: index('accounting_fiscal_years_business_dates_idx').on(t.businessId, t.startDate, t.endDate),
    datesCheck: check('accounting_fiscal_years_dates_check', sql`${t.endDate} >= ${t.startDate}`),
    statusCheck: check('accounting_fiscal_years_status_check', sql`${t.status} IN ('OPEN', 'CLOSING', 'CLOSED')`),
  }),
);

export const accountingPeriods = pgTable(
  'accounting_periods',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull(),
    fiscalYearId: uuid('fiscal_year_id').notNull(),
    code: text('code').notNull(),
    label: text('label').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    status: text('status').notNull().default('OPEN'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    businessCodeUnique: uniqueIndex('accounting_periods_business_code_unique').on(t.businessId, t.code),
    businessIdIdUnique: uniqueIndex('accounting_periods_business_id_id_unique').on(t.businessId, t.id),
    businessYearDatesIdx: index('accounting_periods_business_year_dates_idx').on(t.businessId, t.fiscalYearId, t.startDate, t.endDate),
    datesCheck: check('accounting_periods_dates_check', sql`${t.endDate} >= ${t.startDate}`),
    statusCheck: check('accounting_periods_status_check', sql`${t.status} IN ('OPEN', 'CLOSED', 'LOCKED')`),
    fiscalYearFk: foreignKey({
      name: 'accounting_periods_fiscal_year_fk',
      columns: [t.businessId, t.fiscalYearId],
      foreignColumns: [accountingFiscalYears.businessId, accountingFiscalYears.id],
    }),
  }),
);

export const accountingJournals = pgTable(
  'accounting_journals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
    locationId: uuid('location_id'),
    code: text('code').notNull(),
    label: text('label').notNull(),
    journalType: text('journal_type').notNull(),
    sequencePrefix: text('sequence_prefix').notNull(),
    nextSequence: bigint('next_sequence', { mode: 'number' }).notNull().default(1),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    businessCodeUnique: uniqueIndex('accounting_journals_business_code_unique').on(t.businessId, t.code),
    businessIdIdUnique: uniqueIndex('accounting_journals_business_id_id_unique').on(t.businessId, t.id),
    businessTypeIdx: index('accounting_journals_business_type_idx').on(t.businessId, t.journalType, t.isActive),
    sequenceCheck: check('accounting_journals_sequence_check', sql`${t.nextSequence} > 0`),
    typeCheck: check('accounting_journals_type_check', sql`${t.journalType} IN ('PURCHASE', 'SALES', 'CASH', 'BANK', 'GENERAL', 'OPENING', 'CLOSING', 'PAYROLL')`),
    locationFk: foreignKey({
      name: 'accounting_journals_location_fk',
      columns: [t.businessId, t.locationId],
      foreignColumns: [businessLocations.businessId, businessLocations.id],
    }),
  }),
);

export const accountingEntries = pgTable(
  'accounting_entries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull().references(() => businesses.id, { onDelete: 'restrict' }),
    journalId: uuid('journal_id').notNull(),
    periodId: uuid('period_id').notNull(),
    locationId: uuid('location_id'),
    entryNumber: text('entry_number').notNull(),
    entryDate: date('entry_date').notNull(),
    description: text('description').notNull(),
    status: text('status').notNull().default('DRAFT'),
    sourceType: text('source_type'),
    sourceId: text('source_id'),
    idempotencyKey: text('idempotency_key'),
    requestHash: text('request_hash'),
    reversalOfEntryId: uuid('reversal_of_entry_id'),
    postedAt: timestamp('posted_at', { withTimezone: true }).defaultNow().notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    businessIdIdUnique: uniqueIndex('accounting_entries_business_id_id_unique').on(t.businessId, t.id),
    businessNumberUnique: uniqueIndex('accounting_entries_business_number_unique').on(t.businessId, t.entryNumber),
    sourceUnique: uniqueIndex('accounting_entries_source_unique').on(t.businessId, t.sourceType, t.sourceId),
    idempotencyUnique: uniqueIndex('accounting_entries_idempotency_unique').on(t.businessId, t.idempotencyKey),
    reversalUnique: uniqueIndex('accounting_entries_single_reversal_unique').on(t.businessId, t.reversalOfEntryId),
    businessDateIdx: index('accounting_entries_business_date_idx').on(t.businessId, t.entryDate, t.id),
    businessPeriodIdx: index('accounting_entries_business_period_idx').on(t.businessId, t.periodId, t.entryDate),
    businessLocationDateIdx: index('accounting_entries_business_location_date_idx').on(t.businessId, t.locationId, t.entryDate),
    journalFk: foreignKey({ name: 'accounting_entries_journal_fk', columns: [t.businessId, t.journalId], foreignColumns: [accountingJournals.businessId, accountingJournals.id] }),
    periodFk: foreignKey({ name: 'accounting_entries_period_fk', columns: [t.businessId, t.periodId], foreignColumns: [accountingPeriods.businessId, accountingPeriods.id] }),
    locationFk: foreignKey({ name: 'accounting_entries_location_fk', columns: [t.businessId, t.locationId], foreignColumns: [businessLocations.businessId, businessLocations.id] }),
    reversalFk: foreignKey({ name: 'accounting_entries_reversal_fk', columns: [t.businessId, t.reversalOfEntryId], foreignColumns: [t.businessId, t.id] }),
    statusCheck: check('accounting_entries_status_check', sql`${t.status} IN ('DRAFT', 'POSTED')`),
    sourcePairCheck: check('accounting_entries_source_pair_check', sql`(${t.sourceType} IS NULL) = (${t.sourceId} IS NULL)`),
    descriptionCheck: check('accounting_entries_description_check', sql`length(btrim(${t.description})) BETWEEN 2 AND 240`),
  }),
);

export const accountingEntryLines = pgTable(
  'accounting_entry_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull(),
    entryId: uuid('entry_id').notNull(),
    lineNumber: integer('line_number').notNull(),
    accountId: uuid('account_id').notNull(),
    description: varchar('description', { length: 240 }),
    customerId: uuid('customer_id'),
    supplierId: uuid('supplier_id'),
    debit: numeric('debit', { precision: 18, scale: 2 }).notNull().default('0'),
    credit: numeric('credit', { precision: 18, scale: 2 }).notNull().default('0'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    entryLineUnique: uniqueIndex('accounting_entry_lines_entry_line_unique').on(t.entryId, t.lineNumber),
    businessAccountIdx: index('accounting_entry_lines_business_account_idx').on(t.businessId, t.accountId, t.entryId),
    entryFk: foreignKey({ name: 'accounting_entry_lines_entry_fk', columns: [t.businessId, t.entryId], foreignColumns: [accountingEntries.businessId, accountingEntries.id] }),
    accountFk: foreignKey({ name: 'accounting_entry_lines_account_fk', columns: [t.businessId, t.accountId], foreignColumns: [accountingAccounts.businessId, accountingAccounts.id] }),
    customerFk: foreignKey({ name: 'accounting_entry_lines_customer_fk', columns: [t.businessId, t.customerId], foreignColumns: [customers.businessId, customers.id] }),
    supplierFk: foreignKey({ name: 'accounting_entry_lines_supplier_fk', columns: [t.businessId, t.supplierId], foreignColumns: [suppliers.businessId, suppliers.id] }),
    customerIdx: index('accounting_entry_lines_customer_idx').on(t.businessId, t.customerId, t.entryId),
    supplierIdx: index('accounting_entry_lines_supplier_idx').on(t.businessId, t.supplierId, t.entryId),
    auxiliaryCheck: check('accounting_entry_lines_single_auxiliary_check', sql`${t.customerId} IS NULL OR ${t.supplierId} IS NULL`),
    lineNumberCheck: check('accounting_entry_lines_line_number_check', sql`${t.lineNumber} > 0`),
    amountsCheck: check('accounting_entry_lines_amounts_check', sql`${t.debit} >= 0 AND ${t.credit} >= 0 AND ((${t.debit} > 0 AND ${t.credit} = 0) OR (${t.credit} > 0 AND ${t.debit} = 0))`),
  }),
);


/** Explicit, tenant-owned posting rules for operational accounting events. */
export const accountingEventMappings = pgTable(
  'accounting_event_mappings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull(),
    sourceType: text('source_type').notNull(),
    sourceCategory: text('source_category').notNull(),
    journalId: uuid('journal_id').notNull(),
    debitAccountId: uuid('debit_account_id'),
    creditAccountId: uuid('credit_account_id'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    businessCategoryUnique: uniqueIndex('accounting_event_mappings_business_category_unique').on(t.businessId, t.sourceType, t.sourceCategory),
    businessIdIdUnique: uniqueIndex('accounting_event_mappings_business_id_id_unique').on(t.businessId, t.id),
    journalFk: foreignKey({ name: 'accounting_event_mappings_journal_fk', columns: [t.businessId, t.journalId], foreignColumns: [accountingJournals.businessId, accountingJournals.id] }),
    debitAccountFk: foreignKey({ name: 'accounting_event_mappings_debit_account_fk', columns: [t.businessId, t.debitAccountId], foreignColumns: [accountingAccounts.businessId, accountingAccounts.id] }),
    creditAccountFk: foreignKey({ name: 'accounting_event_mappings_credit_account_fk', columns: [t.businessId, t.creditAccountId], foreignColumns: [accountingAccounts.businessId, accountingAccounts.id] }),
    distinctAccounts: check('accounting_event_mappings_distinct_accounts_check', sql`${t.debitAccountId} <> ${t.creditAccountId}`),
    sourceTypeCheck: check('accounting_event_mappings_source_type_check', sql`${t.sourceType} IN ('EXPENSE', 'SALE')`),
    categoryCheck: check('accounting_event_mappings_category_check', sql`length(btrim(${t.sourceCategory})) BETWEEN 1 AND 80`),
  }),
);


/** Ordered debit/credit lines for a tenant-owned operational posting template. */
export const accountingEventMappingLines = pgTable(
  'accounting_event_mapping_lines',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    businessId: uuid('business_id').notNull(),
    mappingId: uuid('mapping_id').notNull(),
    lineNumber: integer('line_number').notNull(),
    accountId: uuid('account_id').notNull(),
    side: text('side').notNull(),
    amountBasis: text('amount_basis').notNull(),
    percentage: numeric('percentage', { precision: 7, scale: 4 }).notNull().default('100.0000'),
    auxiliaryType: text('auxiliary_type'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    mappingLineUnique: uniqueIndex('accounting_event_mapping_lines_unique').on(t.businessId, t.mappingId, t.lineNumber),
    businessMappingIdx: index('accounting_event_mapping_lines_business_mapping_idx').on(t.businessId, t.mappingId, t.lineNumber),
    mappingFk: foreignKey({ name: 'accounting_event_mapping_lines_mapping_fk', columns: [t.businessId, t.mappingId], foreignColumns: [accountingEventMappings.businessId, accountingEventMappings.id], onDelete: 'cascade' }),
    accountFk: foreignKey({ name: 'accounting_event_mapping_lines_account_fk', columns: [t.businessId, t.accountId], foreignColumns: [accountingAccounts.businessId, accountingAccounts.id] }),
    lineNumberCheck: check('accounting_event_mapping_lines_number_check', sql`${t.lineNumber} > 0`),
    sideCheck: check('accounting_event_mapping_lines_side_check', sql`${t.side} IN ('DEBIT', 'CREDIT')`),
    amountBasisCheck: check('accounting_event_mapping_lines_basis_check', sql`${t.amountBasis} IN ('EXPENSE_AMOUNT', 'SALE_TOTAL', 'SALE_SUBTOTAL', 'SALE_DISCOUNT', 'SALE_COST_AT_SALE')`),
    percentageCheck: check('accounting_event_mapping_lines_percentage_check', sql`${t.percentage} > 0 AND ${t.percentage} <= 100`),
    auxiliaryCheck: check('accounting_event_mapping_lines_auxiliary_check', sql`${t.auxiliaryType} IS NULL OR ${t.auxiliaryType} IN ('CUSTOMER', 'SUPPLIER')`),
  }),
);
