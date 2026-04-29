import {
  pgTable,
  text,
  timestamp,
  index,
  boolean,
  integer,
  numeric,
  uuid,
  real,
} from "drizzle-orm/pg-core";

export const apiWallets = pgTable(
  "api_wallets",
  {
    /** The user's address — the master account on Hyperliquid */
    userAddress: text("user_address").notNull(),
    /** The generated API wallet public address (agent wallet) — unique per keypair */
    apiWalletAddress: text("api_wallet_address").primaryKey(),
    /** Encrypted private key of the API wallet — used to sign orders on behalf of the user */
    privateKey: text("private_key").notNull(),
    /** Auto-generated name: {userAddress}-{n} */
    name: text("name").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    /** Index for looking up all wallets belonging to a user */
    index("idx_api_wallets_user").on(table.userAddress),
  ],
);

export type ApiWallet = typeof apiWallets.$inferSelect;
export type NewApiWallet = typeof apiWallets.$inferInsert;

/**
 * Server-issued nonces for signature-based authentication.
 * A nonce must be issued via GET /wallets/:userAddress/nonce before
 * it can be used in a signed request. Burned (usedAt set) on consumption.
 */
export const nonces = pgTable("nonces", {
  /** The nonce value — unique globally */
  nonce: text("nonce").primaryKey(),
  /** The user this nonce was issued for */
  userAddress: text("user_address").notNull(),
  /** When this nonce was issued */
  issuedAt: timestamp("issued_at").defaultNow().notNull(),
  /** When this nonce was consumed — null means still valid */
  usedAt: timestamp("used_at"),
});

export type Nonce = typeof nonces.$inferSelect;

/**
 * A strategy groups one or more orders submitted together with a shared
 * trigger condition. Created atomically with its orders.
 */
export const strategies = pgTable(
  "strategies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The owning user (master account) */
    userAddress: text("user_address").notNull(),
    /** Strategy name supplied by the user */
    strategyName: text("strategy_name").notNull(),
    /** Trigger source description */
    triggerSource: text("trigger_source").notNull(),
    /** Trigger probability threshold (0–1) */
    triggerProbability: real("trigger_probability").notNull(),
    /** Trigger direction: ">=" or "<=" */
    triggerDirection: text("trigger_direction").notNull(),
    /** Nonce used for the signed create message */
    createNonce: text("create_nonce").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [index("idx_strategies_user").on(table.userAddress)],
);

export type Strategy = typeof strategies.$inferSelect;
export type NewStrategy = typeof strategies.$inferInsert;

/**
 * User-submitted orders awaiting execution.
 * The user signs the order payload with their master account; the server verifies
 * the signature, persists the order, and (eventually) executes it via the
 * user's API wallet when conditions are met.
 */
export const orders = pgTable(
  "orders",
  {
    /** Unique server-generated id */
    id: uuid("id").primaryKey().defaultRandom(),
    /** The owning user (master account) — must match the recovered signer */
    userAddress: text("user_address").notNull(),
    /** Asset symbol, e.g. "BTC", "ETH" */
    asset: text("asset").notNull(),
    /** true = long, false = short */
    isLong: boolean("is_long").notNull(),
    /** Position size denominated in USDC (stored as numeric string for precision) */
    sizeUsdc: numeric("size_usdc", { precision: 38, scale: 8 }).notNull(),
    /** Leverage multiplier (whole number, e.g. 1, 5, 25) */
    leverage: integer("leverage").notNull(),
    /** Take-profit, expressed as percent gain (e.g. 12.5 = +12.5%). Nullable. */
    takeProfitPct: numeric("take_profit_pct", { precision: 10, scale: 4 }),
    /** Stop-loss, expressed as percent loss (e.g. 5 = -5%). Nullable. */
    stopLossPct: numeric("stop_loss_pct", { precision: 10, scale: 4 }),
    /** Reduce-only flag */
    reduceOnly: boolean("reduce_only").notNull().default(false),
    /** FK to the strategy this order belongs to */
    strategyId: uuid("strategy_id")
      .notNull()
      .references(() => strategies.id, { onDelete: "cascade" }),
    /** Unix timestamp (ms) past which the order can no longer be executed */
    orderDeadline: timestamp("order_deadline").notNull(),
    /** Lifecycle status */
    status: text("status").notNull().default("pending"),
    /** Whether the order has been executed on-chain */
    isExecuted: boolean("is_executed").notNull().default(false),
    /** Nonce used for the signed create message (one-time, burned) */
    createNonce: text("create_nonce").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_orders_user").on(table.userAddress),
    index("idx_orders_status").on(table.status),
    index("idx_orders_deadline").on(table.orderDeadline),
  ],
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
