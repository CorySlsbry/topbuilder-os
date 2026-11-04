// Offline outbox for field cost capture.
//
// No signal on the roof is normal: captures queue locally and flush when the
// connection returns. The queue logic is pure over an injected storage so it
// is unit-testable; the browser wiring (localStorage + online events) is a
// thin shell. Photos require a connection in v1 — costs never do.

export interface QueuedCost {
  id: string; // client-generated, for de-dupe/display
  jobId: string;
  jobName: string;
  costCode: string;
  kind: "labor" | "material" | "sub" | "equipment" | "other";
  amountCents: number;
  occurredOn: string;
  memo?: string;
  queuedAt: string;
}

export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const KEY = "tb.outbox.costs.v1";

export function readQueue(kv: KV): QueuedCost[] {
  try {
    const raw = kv.get(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as QueuedCost[]) : [];
  } catch {
    return [];
  }
}

export function enqueue(kv: KV, item: QueuedCost): QueuedCost[] {
  const queue = readQueue(kv);
  if (!queue.some((q) => q.id === item.id)) queue.push(item);
  kv.set(KEY, JSON.stringify(queue));
  return queue;
}

export function remove(kv: KV, id: string): QueuedCost[] {
  const queue = readQueue(kv).filter((q) => q.id !== id);
  kv.set(KEY, JSON.stringify(queue));
  return queue;
}

export interface FlushResult {
  sent: number;
  failed: number;
  remaining: QueuedCost[];
}

/**
 * Try to send every queued item. An item leaves the queue ONLY after the
 * server confirms (2xx). A 4xx (bad data) also leaves the queue but counts
 * as failed-permanent so the UI can say so; network errors/5xx keep it queued.
 */
export async function flush(
  kv: KV,
  send: (item: QueuedCost) => Promise<"ok" | "rejected" | "retry">,
): Promise<FlushResult> {
  let sent = 0;
  let failed = 0;
  for (const item of readQueue(kv)) {
    let outcome: "ok" | "rejected" | "retry";
    try {
      outcome = await send(item);
    } catch {
      outcome = "retry";
    }
    if (outcome === "ok") {
      remove(kv, item.id);
      sent += 1;
    } else if (outcome === "rejected") {
      remove(kv, item.id);
      failed += 1;
    }
    // "retry" → stays queued
  }
  return { sent, failed, remaining: readQueue(kv) };
}
