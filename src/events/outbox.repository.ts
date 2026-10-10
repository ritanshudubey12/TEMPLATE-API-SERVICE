import type { Db } from "../db/pool";

export async function enqueueEvent(db: Db, eventType: string, payload: Record<string, unknown>): Promise<void> {
  await db.query("INSERT INTO outbox_events (event_type, payload) VALUES ($1, $2::jsonb)", [eventType, JSON.stringify(payload)]);
}
