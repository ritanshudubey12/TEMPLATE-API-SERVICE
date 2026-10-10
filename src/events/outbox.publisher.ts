import type { Pool } from "pg";
import { withTransaction } from "../db/pool";
import type { Logger } from "../observability/logger";

type Options = { pool: Pool; logger: Logger; intervalMs: number; webhookUrl?: string };

/** Polls the outbox and delivers events at-least-once (consumers must be idempotent on event_id). */
export function startOutboxPublisher({ pool, logger, intervalMs, webhookUrl }: Options) {
  let running = false;

  async function deliver(eventId: string, type: string, payload: unknown) {
    if (!webhookUrl) {
      logger.info({ eventId, type }, "outbox event");
      return;
    }
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-event-id": eventId, "x-event-type": type },
      body: JSON.stringify({ eventId, type, payload }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`webhook responded ${res.status}`);
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      await withTransaction(pool, async (c) => {
        const { rows } = await c.query(
          `SELECT id::text AS id, event_id::text AS "eventId", event_type AS type, payload, attempts
             FROM outbox_events
            WHERE published_at IS NULL AND next_attempt_at <= now()
            ORDER BY id LIMIT 50 FOR UPDATE SKIP LOCKED`,
        );
        for (const row of rows) {
          try {
            await deliver(row.eventId, row.type, row.payload);
            await c.query("UPDATE outbox_events SET published_at = now(), attempts = attempts + 1 WHERE id = $1::bigint", [row.id]);
          } catch (err) {
            const delaySeconds = Math.min(2 ** Math.min(row.attempts, 10) * 5, 3600);
            await c.query(
              `UPDATE outbox_events
                  SET attempts = attempts + 1, last_error = $2,
                      next_attempt_at = now() + make_interval(secs => $3)
                WHERE id = $1::bigint`,
              [row.id, (err as Error).message.slice(0, 500), delaySeconds],
            );
          }
        }
      });
    } catch (err) {
      logger.error({ err: (err as Error).message }, "outbox publisher tick failed");
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
}
