/**
 * Discord notification module.
 *
 * Sends a webhook message to a Discord channel whenever a strategy execution
 * is attempted. Reads DISCORD_WEBHOOK_URL from the environment at call-time so
 * the value can be injected via .env without a restart cycle.
 *
 * All errors are swallowed — a Discord outage must never block or fail a trade.
 */

import type {
  ExecutableOrder,
  OrderExecutionResult,
} from "../execution/types.ts";
import type { StrategyTriggeredEvent } from "../event-bus/event-bus.ts";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type StatusEmoji = "✅" | "⚠️" | "❌" | "⏭️" | "📋";

function statusEmoji(status: OrderExecutionResult["status"]): StatusEmoji {
  switch (status) {
    case "filled":
      return "✅";
    case "filled_unprotected":
      return "⚠️";
    case "resting":
    case "submitted":
      return "📋";
    case "skipped":
      return "⏭️";
    case "failed":
      return "❌";
  }
}

function statusLabel(status: OrderExecutionResult["status"]): string {
  switch (status) {
    case "filled":
      return "Filled";
    case "filled_unprotected":
      return "Filled (NO TP/SL ⚠️)";
    case "resting":
      return "Resting";
    case "submitted":
      return "Submitted";
    case "skipped":
      return "Skipped";
    case "failed":
      return "Failed";
  }
}

function formatOrder(
  order: ExecutableOrder,
  result: OrderExecutionResult,
): string {
  const direction = order.isLong ? "LONG" : "SHORT";
  const tp =
    order.takeProfitPct != null ? `TP +${order.takeProfitPct}%` : "no TP";
  const sl = order.stopLossPct != null ? `SL -${order.stopLossPct}%` : "no SL";

  const emoji = statusEmoji(result.status);
  const label = statusLabel(result.status);

  let line =
    `${emoji} **${order.asset}** ${direction} • $${order.sizeUsdc.toLocaleString("en-US")} USDC` +
    ` • ${order.leverage}x • ${tp} / ${sl} → **${label}**`;

  if ("venueRef" in result && result.venueRef) {
    line += ` \`${result.venueRef}\``;
  }
  if (result.status === "skipped") {
    line += `\n> Reason: ${result.reason}`;
  }
  if (result.status === "failed") {
    line += `\n> Error: ${result.error}`;
  }
  if (result.status === "filled_unprotected") {
    line += `\n> ⚠️ Position is open with NO protective orders — manual review required!`;
  }

  return line;
}

function overallColor(results: readonly OrderExecutionResult[]): number {
  // Discord embed colours: green=success, yellow=warning, red=failure
  const hasFailure = results.some((r) => r.status === "failed");
  const hasUnprotected = results.some((r) => r.status === "filled_unprotected");
  const hasSuccess = results.some(
    (r) =>
      r.status === "filled" ||
      r.status === "resting" ||
      r.status === "submitted",
  );

  if (hasFailure) return 0xe74c3c; // red
  if (hasUnprotected) return 0xe67e22; // orange
  if (hasSuccess) return 0x2ecc71; // green
  return 0x95a5a6; // grey (all skipped)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface StrategyExecutionSummary {
  readonly cause: StrategyTriggeredEvent;
  readonly venueName: string;
  readonly orders: readonly ExecutableOrder[];
  readonly results: readonly OrderExecutionResult[];
}

/**
 * Fire-and-forget: posts a Discord webhook embed summarising the strategy
 * execution. Errors are logged but never rethrown.
 */
export async function notifyDiscord(
  summary: StrategyExecutionSummary,
): Promise<void> {
  const webhookUrl = process.env["DISCORD_WEBHOOK_URL"];
  if (!webhookUrl) {
    // Not configured — silently skip.
    return;
  }

  try {
    const { cause, venueName, orders, results } = summary;

    // Build a map from orderId → ExecutableOrder for quick lookup.
    const orderMap = new Map<string, ExecutableOrder>(
      orders.map((o) => [o.id, o]),
    );

    const orderLines = results.map((result) => {
      const order = orderMap.get(result.orderId);
      if (!order) {
        return `• Order \`${result.orderId}\` — ${statusEmoji(result.status)} ${statusLabel(result.status)}`;
      }
      return formatOrder(order, result);
    });

    const filled = results.filter(
      (r) => r.status === "filled" || r.status === "filled_unprotected",
    ).length;
    const failed = results.filter((r) => r.status === "failed").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    const submitted = results.filter(
      (r) => r.status === "submitted" || r.status === "resting",
    ).length;

    const summaryLine = `Filled: **${filled}** | Submitted: **${submitted}** | Skipped: **${skipped}** | Failed: **${failed}**`;

    const user = orders[0]?.userAddress ?? "unknown";

    const embed = {
      title: `📊 Strategy Executed — \`${cause.strategyId}\``,
      color: overallColor(results),
      fields: [
        {
          name: "Venue",
          value: venueName,
          inline: true,
        },
        {
          name: "User",
          value: `\`${user}\``,
          inline: true,
        },
        {
          name: "Summary",
          value: summaryLine,
          inline: false,
        },
        {
          name: `Orders (${results.length})`,
          value: orderLines.join("\n") || "_none_",
          inline: false,
        },
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: "macro-exec",
      },
    };

    const body = JSON.stringify({ embeds: [embed] });

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "<no body>");
      console.warn(`[discord] webhook responded ${response.status}: ${text}`);
    }
  } catch (err) {
    console.warn(
      "[discord] failed to send notification:",
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
  }
}
