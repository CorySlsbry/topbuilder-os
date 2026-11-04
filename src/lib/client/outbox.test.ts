import { describe, expect, it } from "vitest";
import { enqueue, flush, readQueue, type KV, type QueuedCost } from "./outbox";

function memKv(): KV {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => void m.set(k, v),
  };
}

function item(id: string): QueuedCost {
  return {
    id,
    jobId: "job-1",
    jobName: "Smith re-roof",
    costCode: "4100",
    kind: "material",
    amountCents: 84200,
    occurredOn: "2026-08-01",
    queuedAt: "2026-08-01T12:00:00Z",
  };
}

describe("offline outbox", () => {
  it("enqueues once per id (retry-safe)", () => {
    const kv = memKv();
    enqueue(kv, item("a"));
    enqueue(kv, item("a"));
    expect(readQueue(kv)).toHaveLength(1);
  });

  it("survives corrupted storage (fails to empty, never throws)", () => {
    const kv = memKv();
    kv.set("tb.outbox.costs.v1", "{not json");
    expect(readQueue(kv)).toEqual([]);
  });

  it("flush: ok leaves the queue, retry stays, rejected leaves as failed", async () => {
    const kv = memKv();
    enqueue(kv, item("ok1"));
    enqueue(kv, item("retry1"));
    enqueue(kv, item("bad1"));
    const result = await flush(kv, async (q) =>
      q.id === "ok1" ? "ok" : q.id === "bad1" ? "rejected" : "retry",
    );
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.remaining.map((q) => q.id)).toEqual(["retry1"]);
  });

  it("flush: a thrown network error keeps the item queued", async () => {
    const kv = memKv();
    enqueue(kv, item("net1"));
    const result = await flush(kv, async () => {
      throw new Error("offline");
    });
    expect(result.sent).toBe(0);
    expect(result.remaining).toHaveLength(1);
  });
});
