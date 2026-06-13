# macro-exec

**macro-exec** is an automated trading executor that bridges two markets: it watches
**Polymarket** prediction-market order books in real time, converts them into implied
probabilities, and — when a user-defined threshold is crossed — places leveraged
perpetual orders on **Hyperliquid**.

In one sentence: _"When Polymarket's probability for event X reaches Y%, open these
trades on Hyperliquid."_

---

## Table of contents

- [What the system does](#what-the-system-does)
- [Architecture at a glance](#architecture-at-a-glance)
- [The strategy lifecycle](#the-strategy-lifecycle)
- [Running it](#running-it)
- [Module reference table](#module-reference-table)
- [Technical breakdown by subsystem](#technical-breakdown-by-subsystem)
- [Design principles & safety model](#design-principles--safety-model)

---

## What the system does

A **strategy** is a user-defined rule stored in PostgreSQL. It says:

> _Watch this Polymarket market. When the YES outcome's implied probability goes
> `>=` (or `<=`) some threshold, execute the orders attached to this strategy on
> Hyperliquid._

Each strategy owns one or more **orders** (asset, direction, USDC size, leverage,
optional take-profit / stop-loss). The executor monitors the relevant Polymarket
markets continuously, and the instant a threshold is crossed it routes the strategy's
orders to a venue (currently Hyperliquid), signs them with the user's encrypted API
wallet, and places them on-chain.

The whole thing runs as a single long-lived Node/Bun process. There is no HTTP API —
strategies are created by another service writing to the shared database; macro-exec
polls for new and deleted rows and reconciles its in-memory state every couple of
seconds.

---

## Architecture at a glance

The system is built around an **in-process event bus**. Each subsystem only knows
about the bus and its own narrow job; nothing imports another subsystem's internals.
This keeps a fault in one feed or one venue from cascading into the rest.

**Data flows in one direction through the bus:**

1. **Facts in** — Polymarket pushes book/price updates over WebSocket.
2. **Facts → decisions** — the engine maintains a live book, computes the YES-token
   mid-price (= implied probability), and decides whether any armed strategy fires.
3. **Decisions → actions** — a fired strategy becomes a `StrategyTriggeredEvent`; the
   executor picks it up, applies safety checks, and hands the orders to a venue.
4. **Actions out** — the venue signs and places the orders on Hyperliquid.

---

## The strategy lifecycle

### Phase 1 — Boot

The **cold-book gate** is the key boot subtlety: macro-exec deliberately fetches a
REST snapshot of every order book _before_ it lets the first WebSocket tick reach the
engine. Without it, the first live tick would be evaluated against an empty book and
could produce a garbage probability.

### Phase 2 — Live monitoring

Each WebSocket message follows this path:

1. `WssManager` normalizes the raw payload into a `WssMarketEvent` and publishes it on the bus.
2. `StrategyEngine` receives it. `BookStore` ingests the snapshot or delta immediately — even if no probability can be computed yet, the book stays current.
3. If the YES token for this market has been resolved and it was touched by this event, `ProbabilityExtractor` computes the mid. If the book looks corrupt (crossed, out-of-range, large jump) it requests a REST resync and returns null.
4. For each armed strategy on this trigger: skip if past `triggerEndDateTime`, check the `>=` / `<=` threshold. On a match, publish a `StrategyTriggeredEvent`, remove the strategy from the index (fire-once), and if that empties the trigger, close the feed.

### Phase 3 — Execution

Each `StrategyTriggeredEvent` goes through the following gauntlet:

1. **Circuit breaker** — if 5 consecutive hard failures have been recorded, the executor is paused and the event is dropped.
2. **In-flight dedup** — if this strategy ID is already being dispatched, the duplicate is silently dropped.
3. **DB re-read** — the strategy row is re-fetched. If it no longer exists (deleted between arming and firing), execution is aborted with no latch.
4. **Order load + validation** — pending orders are loaded. If all rows fail validation (e.g. every order exceeds the size cap), the executor refuses to latch and flags operator investigation.
5. **CAS latch** — `hasBeenAttempted` is flipped to `true` with `UPDATE ... WHERE has_been_attempted = false`. If another process already won this race, the update returns zero rows and execution is skipped.
6. **Venue execution** — orders are sent to Hyperliquid. Per-order errors are captured as results, not exceptions, so one bad leg can't abort the others. A filled entry whose subsequent TP/SL placement fails is returned as `filled_unprotected`.
7. **Persist + notify** — each order's status is written to the DB and a Discord summary is posted.

**The most important invariant in the whole system:** the strategy is latched as
`hasBeenAttempted = true` _before_ any order touches the venue, using a compare-and-swap
(`UPDATE ... WHERE has_been_attempted = false`). This guarantees **at-most-once**
execution. A crash after latching means a missed trade (acceptable); a crash after
executing without latching would mean a double trade on restart (not acceptable).

### Phase 4 — Reconciliation & teardown

The 2-second poll loop keeps in-memory state in sync with the database:

- **New strategies** created after boot are picked up, their YES token resolved, their
  book tracked, a WebSocket opened, and the strategy armed — no restart needed.
- **Deleted strategies** are evicted from the engine, and if that empties a market's
  trigger, its WebSocket feed and book tracking are torn down.
- **Expired strategies** are skipped on the hot path (the engine checks
  `triggerEndDateTime` on every tick), so post-resolution book noise can never trip a
  stale rule.

A **heartbeat watchdog** forces a full REST book resync if no WebSocket events arrive
for 60s while subscriptions are open — protection against a silently stalled socket.

---

## Running it

```bash
bun install
bun run start          # or: ./start.sh
bun run dev            # watch mode
bun test               # unit tests (note: crypto.test.ts hits a live DB)
```

### Environment variables

| Variable              | Required | Purpose                                                                                                             |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | ✅       | PostgreSQL connection string (strategies, orders, wallets, nonces).                                                 |
| `MASTER_KEY`          | ✅       | Base64 32-byte key that unwraps per-record DEKs for API-wallet decryption. Generate with `openssl rand -base64 32`. |
| `CLOB_HOST`           | —        | Polymarket CLOB REST host. Defaults to `https://clob.polymarket.com`.                                               |
| `DISCORD_WEBHOOK_URL` | —        | If set, execution summaries are posted here. Failures never block trades.                                           |

Both required vars are validated at module load, so misconfiguration fails the process
immediately rather than deep in a call stack.

---

## Module reference table

| Module                                              | What it does                                                                                                        | Why it's needed                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `index.ts`                                          | Bootstraps and wires every subsystem; owns the boot sequence, poll loop, heartbeat watchdog, and graceful shutdown. | Single composition root — the only place that knows how the parts connect.          |
| `db/client.ts`                                      | Lazy Drizzle + `pg.Pool` singleton with idle-error handling.                                                        | One resilient DB connection that survives transient drops without crashing.         |
| `db/schema.ts`                                      | Drizzle table definitions: `api_wallets`, `nonces`, `strategies`, `orders`.                                         | The shared source of truth between macro-exec and whatever creates strategies.      |
| `event-bus/event-bus.ts`                            | In-process pub/sub with hierarchical topics and a typed event union.                                                | Decouples subsystems so they integrate through events, not direct imports.          |
| `wss/triggers/trigger-key.ts`                       | Parses `provider:slug:conditionId` strings into normalized `TriggerKey`s.                                           | Gives every market a stable dedup identity so one market = one connection.          |
| `wss/triggers/repository.ts`                        | Loads deduplicated trigger keys from unattempted strategies.                                                        | Tells the boot sequence which markets to subscribe to.                              |
| `wss/token-resolver.ts`                             | `PolymarketMarketResolver`: one CLOB lookup → all token IDs (for the feed) **and** the YES token (for probability). | Resolves market identity once; backs both the WSS and strategy layers.              |
| `wss/polymarket-connection.ts`                      | Owns a single WebSocket: subscribe handshake, heartbeat, idle timeout, backoff reconnect.                           | Isolates all reliability concerns for one feed so a bad market can't affect others. |
| `wss/wss-manager.ts`                                | Refcounted pool of connections, one per unique trigger; fans events out to listeners.                               | Prevents duplicate sockets and tears a feed down only when nothing needs it.        |
| `strategy/types.ts`                                 | `LoadedStrategy` and direction types.                                                                               | The in-memory shape the engine evaluates on the hot path.                           |
| `strategy/repository.ts`                            | DB reads for strategies (all, new, by-id, attempted-ids) with safe row parsing.                                     | Loads and refreshes strategies without letting one bad row crash startup.           |
| `strategy/book-state.ts`                            | In-memory order book for a single asset (bid/ask maps, best-price scans).                                           | The price-level math needed to compute a live mid.                                  |
| `strategy/book-store.ts`                            | A collection of `BookState`s keyed by asset; ingests raw Polymarket payloads.                                       | Parses Polymarket's several wire formats into clean book mutations.                 |
| `strategy/book-synchronizer.ts`                     | Periodic + on-demand REST resync; owns the warmup promise.                                                          | The integrity guarantee that local books converge with upstream truth.              |
| `strategy/probability-extractor.ts`                 | Turns a WSS event into an implied probability, with thin-book/jump filters.                                         | Converts noisy market data into a trustworthy number to threshold against.          |
| `strategy/strategy-engine.ts`                       | Subscribes to `wss.*`, evaluates armed strategies, publishes triggers (fire-once).                                  | The decision core: facts in, `StrategyTriggeredEvent`s out.                         |
| `execution/types.ts`                                | `ExecutableOrder`, `OrderExecutionResult`, and the `Venue` interface.                                               | The contract every exchange backend implements.                                     |
| `execution/order-repository.ts`                     | Loads/validates pending orders; CAS strategy latch; order status writes.                                            | Enforces at-most-once execution and per-order safety caps.                          |
| `execution/wallet-loader.ts`                        | Resolves a user → decrypted, signing-ready viem account (TTL-cached).                                               | Bridges encrypted DB storage and on-chain signing, validated against Hyperliquid.   |
| `execution/executor.ts`                             | Subscribes to `strategy.*`; orchestrates latch, routing, venue call, persistence, circuit breaker.                  | Venue-agnostic safety and dispatch logic, separate from any exchange.               |
| `execution/venues/hyperliquid/hyperliquid-venue.ts` | Places IOC entry + grouped TP/SL on Hyperliquid per order.                                                          | The concrete exchange implementation behind the `Venue` seam.                       |
| `execution/venues/hyperliquid/asset-resolver.ts`    | Symbol → assetId/szDecimals and live mid prices (cached).                                                           | Translates user symbols into native exchange units.                                 |
| `execution/venues/hyperliquid/formatters.ts`        | Pure math: aggressive limit price, USDC→size, %TP/SL → trigger price.                                               | Encapsulates Hyperliquid tick/sig-fig rules in testable functions.                  |
| `lib/crypto.ts`                                     | Two-layer libsodium AEAD: master key wraps a DEK, DEK wraps the secret.                                             | Never stores or logs plaintext private keys; supports key rotation.                 |
| `lib/discord.ts`                                    | Fire-and-forget webhook embeds summarizing each execution.                                                          | Operator visibility without ever blocking or failing a trade.                       |
| `lib/constants/*`                                   | Hyperliquid market metadata, default slippage, max order notional.                                                  | Centralized tunables shared across the execution path.                              |

---

## Technical breakdown by subsystem

### The event bus (`event-bus/`)

The architectural backbone. `InMemoryEventBus` is a synchronous pub/sub with
**hierarchical dot-delimited topics**:

- `wss.<triggerId>.price_change` — a price update from a specific market
- `strategy.<strategyId>.triggered` — a strategy crossed its threshold

Subscribers match exact topics, prefix wildcards (`wss.*`), or the global wildcard
(`*`). The event payload is a typed discriminated union — `WssMarketEvent`,
`WssErrorEvent`, `StrategyTriggeredEvent` — so handlers narrow safely. Fan-out is
synchronous and a throwing handler is isolated so it can never break the publisher or
its siblings. Handlers needing async work schedule it themselves.

### The WebSocket layer (`wss/`)

This layer turns "a strategy references market X" into a reliable stream of book
updates.

- **`trigger-key.ts`** parses the DB string `polymarket:<slug>:<conditionId>` into a
  `TriggerKey`. Its `id` (`provider:conditionId`, lowercased) is the dedup key, so two
  strategies on the same market — even via different slugs — share one connection.
- **`token-resolver.ts`** (`PolymarketMarketResolver`) makes a single
  `getClobMarketInfo` call per market and caches it forever (token assignments never
  change). It exposes `resolve()` → all token IDs (what the WS feed subscribes to) and
  `resolveYes()` / `getYes()` → the YES token (whose price is the probability). For
  Yes/No markets the explicit "Yes" token is used; for paired markets (Up/Down) it
  falls back to the first-listed outcome and logs a warning.
- **`polymarket-connection.ts`** owns exactly one socket. It performs the subscribe
  handshake, sends `PING` heartbeats every 10s, force-closes on a 30s idle timeout, and
  reconnects with capped exponential backoff plus jitter (so many feeds dropping at
  once don't reconnect in a thundering herd). It is deliberately ignorant of consumers,
  the DB, and other connections.
- **`wss-manager.ts`** is the pool. It maintains one connection per `TriggerKey` and
  **reference-counts consumers**, so a feed lives exactly as long as something needs it
  and is torn down the moment the last subscriber leaves. It takes a `TokenResolver`
  interface (not the concrete class) so it can be unit-tested without the SDK.

### The strategy / probability layer (`strategy/`)

This is where raw market data becomes a trading decision.

**Maintaining a live book.** Polymarket sends two kinds of updates: `book` (a full
snapshot) and `price_change` (a single-level delta). `BookState` holds one asset's
book as `Map<price, size>` and computes best bid/ask via a linear scan (books are
small). `BookStore` keeps one `BookState` per asset and parses Polymarket's several
`price_change` wire formats (live, legacy-batched, legacy-flat) plus `last_trade_price`
into clean mutations. Maintaining this locally is the only way to get a _realtime_ mid
— otherwise the price would only refresh when Polymarket happened to resend a snapshot.

**Keeping books honest.** `BookSynchronizer` is the integrity layer. It refreshes every
tracked book from REST every 5 minutes (staggered with jitter), and exposes
`requestResync()` for on-demand refreshes triggered by reconnects or suspect data.
Concurrent calls coalesce and rapid calls debounce. It also owns the `warmupComplete`
promise that gates the WSS→engine bridge at boot.

**Computing probability.** `PolymarketProbabilityExtractor` ingests each event into the
book, finds the YES asset, and computes a mid. It applies guards: reject crossed or
negative-spread books, reject mids outside `[0,1]`, and (configurably) reject single
ticks that jump more than a threshold — each of these requests a REST resync rather
than trusting corrupt local state. At the tail extremes (0% / 100%) the production
config loosens `requireBothSides` and widens `maxSpread` so genuine tail-probability
triggers can still fire. It depends only on a minimal `YesTokenSource` interface, so
it's trivially testable.

**Deciding.** `StrategyEngine` subscribes to `wss.*`, indexes strategies by trigger id,
and on each event evaluates only the strategies for that market. It skips any strategy
past its `triggerEndDateTime`, checks the `>=` / `<=` threshold, and on a match
publishes a `StrategyTriggeredEvent`. In `fireOnce` mode (the default) the strategy is
removed from the index immediately so it can never double-fire; an `onStrategyFired`
callback lets the host tear down the WSS feed and book tracking when a market's last
strategy fires. The engine never executes anything itself — its single responsibility
is _facts → decisions_.

### The execution layer (`execution/`)

This is where decisions become signed, on-chain orders — and where almost all the
safety machinery lives.

**`executor.ts`** subscribes to `strategy.*` and, per trigger:

1. Checks the **circuit breaker** (after 5 consecutive hard failures it pauses all
   execution until manually reset).
2. Dedups **in-flight** strategies.
3. **Re-reads the strategy from the DB** at dispatch time — the user may have deleted
   it (don't execute) or changed its `userAddress` (honor the DB value).
4. Loads and validates the pending orders. If rows exist but _all_ fail validation
   (e.g. oversized), it refuses to latch and flags operator investigation.
5. **CAS-latches** `hasBeenAttempted = true` _before_ calling the venue.
6. Calls the venue, persists per-order results, and fires a Discord summary.

**`order-repository.ts`** holds the latch (`markStrategyAttempted` throws
`StrategyAlreadyLatched` if it lost the race), the order loader (filters out expired /
executed / cancelled orders and caps notional at `MAX_ORDER_USDC`), and best-effort
status writes (which never throw — the order is already on-chain, so DB drift beats
crashing).

**`wallet-loader.ts`** turns a master `userAddress` into a signing-ready viem account.
It cross-references the user's Hyperliquid-registered "extra agents" against the DB rows,
picks the first valid one, decrypts its private key in memory, hands it to viem, and
never logs or persists it again. Accounts are cached with a 5-minute TTL, so key
rotation is picked up automatically.

**The Hyperliquid venue** implements the `Venue` interface. Per order it resolves the
asset (symbol → assetId/szDecimals via `asset-resolver.ts`), reads the live mid,
computes an aggressive IOC limit price and a slippage-buffered size (via the pure
functions in `formatters.ts`), best-effort updates leverage, and submits the entry. If
the IOC fills and TP/SL are configured, it submits them as a `positionTpsl` group so
they auto-resize with the position. Crucially, every per-order error is caught and
returned as a `failed`/`skipped` result — one broken symbol never aborts the rest of a
multi-leg strategy. A filled entry whose TP/SL submission fails returns the distinct
`filled_unprotected` status so operators are alerted that a position is open with no
protection.

### Shared libraries (`lib/`)

- **`crypto.ts`** — envelope encryption with libsodium. The `MASTER_KEY` wraps a
  per-record DEK; the DEK wraps the actual private key. Decryption unwraps both layers
  and zeroes the plaintext bytes after use. This two-layer design means key rotation
  touches only the master key, not every stored secret.
- **`discord.ts`** — color-coded webhook embeds summarizing each execution
  (filled / submitted / skipped / failed). Reads the webhook URL at call time, bounds
  the request with a 5s timeout, and swallows all errors — a Discord outage must never
  affect trading.
- **`constants/`** — Hyperliquid per-asset metadata (szDecimals, leverage limits),
  default slippage (50 bps), and the max order notional cap.

---

## Design principles & safety model

The module count is intentional. This system signs transactions and moves money, and
the boundaries exist to contain faults:

- **The event bus is the only integration seam.** Subsystems never import each other's
  internals, so each is independently testable and replaceable.
- **At-most-once execution** is enforced by a DB compare-and-swap latch written _before_
  the venue is touched. Missed trades are tolerable; double trades are not.
- **One bad input can't break the batch.** Bad rows are skipped at load, faulty bus
  handlers are isolated, per-order venue errors are captured as results, and one stalled
  WebSocket can't affect the others.
- **The cold-book gate** ensures no decision is ever made against an unwarmed book.
- **The circuit breaker** stops the executor from hammering a degraded venue.
- **The `Venue` interface** keeps exchange-specific code behind a stable contract —
  adding a new venue means dropping a new implementation under
  `execution/venues/<name>` and registering it, with zero changes to the dispatch or
  latching logic.
- **Secrets never live in plaintext** on disk or in logs; they are decrypted inline,
  used to sign, and dropped.

The system is designed to keep running through transient failures (DB drops, socket
stalls, venue hiccups) and to fail _safe_ — toward a missed opportunity, never toward an
unintended or duplicated trade.
