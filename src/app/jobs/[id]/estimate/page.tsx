"use client";
import { use, useCallback, useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError, centsFromInput, dollars } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import PolishBox from "@/components/PolishBox";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Item {
  id: string;
  name: string;
  unit: string;
  unitPriceCents: number;
  category: string;
  hasPhoto: boolean;
}
interface Financing {
  aprBps: number;
  termMonths: number;
  applyUrl: string;
}
interface Line {
  /**
   * Stable local identity for React and for the +/− controls. A custom line
   * has no pricebook item to key on, and two custom lines can legitimately
   * share a description ("Allowance" twice), so identity cannot be derived
   * from the content.
   */
  key: string;
  /** Absent on a one-off line. The column is nullable and the API optional. */
  pricebookItemId?: string;
  description: string;
  qtyX100: number;
  unitPriceCents: number;
}

let lineSeq = 0;
const nextKey = () => `l${++lineSeq}`;

const TIERS = [
  { key: "good", title: "Good", blurb: "Gets it done right" },
  { key: "better", title: "Better", blurb: "Most popular" },
  { key: "best", title: "Best", blurb: "Top of the line" },
] as const;

/** Same amortization as the server's tested financing math. */
function monthly(principalCents: number, f: Financing): number {
  if (principalCents <= 0) return 0;
  if (f.aprBps === 0) return Math.round(principalCents / f.termMonths);
  const i = f.aprBps / 10_000 / 12;
  return Math.round((principalCents * i) / (1 - Math.pow(1 + i, -f.termMonths)));
}

export default function EstimateComposerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = use(params);
  const router = useRouter();
  // Has the first load finished? The list state starts as [] and
  // cannot answer that on its own.
  const [loaded, setLoaded] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [financing, setFinancing] = useState<Financing | null>(null);
  const [cat, setCat] = useState("all");
  const [tier, setTier] = useState<(typeof TIERS)[number]["key"]>("better");
  const [lines, setLines] = useState<Record<string, Line[]>>({ good: [], better: [], best: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [customName, setCustomName] = useState("");
  const [customPrice, setCustomPrice] = useState("");
  const [customQty, setCustomQty] = useState("1");
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(loaded);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: Item[]; financing: Financing }>("/api/pricebook");
      setItems(r.items);
      setFinancing(r.financing);
        setLoaded(true);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.push("/login");
      else setError("Couldn't load the pricebook.");
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const cats = ["all", ...new Set(items.map((i) => i.category).filter(Boolean))];
  const shown = items.filter((i) => cat === "all" || i.category === cat);
  const totals = useMemo(
    () =>
      Object.fromEntries(
        TIERS.map((t) => [
          t.key,
          lines[t.key]!.reduce((s, l) => s + Math.round((l.qtyX100 * l.unitPriceCents) / 100), 0),
        ]),
      ) as Record<string, number>,
    [lines],
  );

  function add(item: Item) {
    setLines((prev) => {
      const cur = [...prev[tier]!];
      const hit = cur.findIndex((l) => l.pricebookItemId === item.id);
      if (hit >= 0) cur[hit] = { ...cur[hit]!, qtyX100: cur[hit]!.qtyX100 + 100 };
      else
        cur.push({
          key: nextKey(),
          pricebookItemId: item.id,
          description: item.name,
          qtyX100: 100,
          unitPriceCents: item.unitPriceCents,
        });
      return { ...prev, [tier]: cur };
    });
  }

  /**
   * A one-off line: the thing that isn't in the pricebook and never will be —
   * a custom fabrication, a crane day, a permit, an allowance the customer
   * asked for. Deliberately NOT deduped against anything: two "Allowance"
   * lines on one option are a normal way to quote.
   */
  function addCustom() {
    const cents = centsFromInput(customPrice);
    const qty = Number(customQty);
    if (!customName.trim() || cents === null || !Number.isFinite(qty) || qty <= 0) return;
    setLines((prev) => ({
      ...prev,
      [tier]: [
        ...prev[tier]!,
        {
          key: nextKey(),
          description: customName.trim(),
          qtyX100: Math.round(qty * 100),
          unitPriceCents: cents,
        },
      ],
    }));
    setCustomName("");
    setCustomPrice("");
    setCustomQty("1");
  }

  function bump(tierKey: string, idx: number, delta: number) {
    setLines((prev) => {
      const cur = [...prev[tierKey]!];
      const next = cur[idx]!.qtyX100 + delta * 100;
      if (next <= 0) cur.splice(idx, 1);
      else cur[idx] = { ...cur[idx]!, qtyX100: next };
      return { ...prev, [tierKey]: cur };
    });
  }

  async function createEstimate() {
    setBusy(true);
    setError("");
    try {
      const options = TIERS.filter((t) => lines[t.key]!.length > 0).map((t) => ({
        tier: t.key,
        title: t.title,
        summary: t.blurb,
        // `key` is local bookkeeping; send only what the API models.
        lines: lines[t.key]!.map((l) => ({
          description: l.description,
          qtyX100: l.qtyX100,
          unitPriceCents: l.unitPriceCents,
          ...(l.pricebookItemId ? { pricebookItemId: l.pricebookItemId } : {}),
        })),
      }));
      await api(`/api/jobs/${jobId}/estimates`, { method: "POST", json: { options } });
      router.push(`/jobs/${jobId}`);
    } catch {
      setError("Couldn't create the estimate — each option needs at least one line.");
      setBusy(false);
    }
  }

  const anyLines = TIERS.some((t) => lines[t.key]!.length > 0);

  // What the custom line is still waiting on, in the user's words rather than
  // field names — and a live total so the number is confirmed BEFORE it lands
  // in the quote, not after.
  const customCents = centsFromInput(customPrice);
  const customQtyNum = Number(customQty);
  const missingForCustom = [
    !customName.trim() && "a name",
    customCents === null && "a price",
    (!Number.isFinite(customQtyNum) || customQtyNum <= 0) && "a quantity",
  ].filter(Boolean) as string[];
  const customPreview =
    customCents !== null && Number.isFinite(customQtyNum) && customQtyNum > 0
      ? `Adds ${dollars(Math.round(customQtyNum * customCents))}`
      : "";

  // First paint: a wireframe of this screen, inside the shell. Never on a
  // refetch — useFirstLoad latches, so saving does not re-flash the page.
  if (!loaded) {
    return (
      <AppShell title="Build an estimate">
        {showSkeleton && <PageSkeleton kind="form" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Build the estimate">
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          Tap items from your pricebook into an option. Give the customer a
          choice of three — shops that present good-better-best close bigger
          jobs. The customer approves from their portal with one tap.
        </p>
      </div>

      <div className="row" role="tablist" aria-label="Option being built">
        {TIERS.map((t) => (
          <button
            key={t.key}
            className="chip"
            aria-pressed={tier === t.key}
            onClick={() => setTier(t.key)}
          >
            {t.title} · {dollars(totals[t.key] ?? 0)}
          </button>
        ))}
      </div>

      <div className="row" style={{ marginTop: 10 }} aria-label="Categories">
        {cats.map((c) => (
          <button key={c} className="chip" aria-pressed={cat === c} onClick={() => setCat(c)}>
            {c === "all" ? "Everything" : c}
          </button>
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
          gap: 10,
          marginTop: 12,
        }}
      >
        {shown.map((i) => (
          <button
            key={i.id}
            className="secondary"
            style={{ textAlign: "left", padding: 0, overflow: "hidden", borderRadius: 12, minHeight: 0 }}
            onClick={() => add(i)}
            aria-label={`Add ${i.name} to ${tier}`}
          >
            {i.hasPhoto && (
              <img src={`/api/pricebook/${i.id}/photo`} alt="" style={{ width: "100%", height: 84, objectFit: "cover", display: "block" }} />
            )}
            <span style={{ display: "block", padding: "8px 10px 10px" }}>
              <strong style={{ display: "block", fontSize: "0.85rem" }}>{i.name}</strong>
              <span className="muted">{dollars(i.unitPriceCents)} / {i.unit}</span>
            </span>
          </button>
        ))}
        {shown.length === 0 && (
          <p className="muted">
            Pricebook is empty — add items on the Pricebook page first.
          </p>
        )}
      </div>

      {/*
        The one-off line. Every real quote has one: a crane day, a permit, a
        custom return plenum, an allowance the customer asked for. Without this
        the tech's only options are to abandon the estimate or to pollute the
        pricebook with a single-use item — and the second one is how a pricebook
        turns into a junk drawer.
      */}
      <div className="card" style={{ marginTop: 14 }}>
        <h2 style={{ marginTop: 0, fontSize: "1rem" }}>
          Something not in your pricebook?
        </h2>
        <p className="muted" style={{ marginTop: 0 }}>
          Add a one-off line to <strong>{TIERS.find((t) => t.key === tier)!.title}</strong>.
          It stays on this estimate — your pricebook is left alone.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(160px, 2fr) minmax(90px, 1fr) minmax(80px, 0.7fr)",
            gap: 10,
            alignItems: "end",
          }}
        >
          <div>
            <label htmlFor="custom-name">What is it?</label>
            <input
              id="custom-name"
              value={customName}
              onChange={(e) => setCustomName(e.target.value.slice(0, 300))}
              placeholder="Crane rental — rooftop set"
              onKeyDown={(e) => {
                if (e.key === "Enter") addCustom();
              }}
            />
            {/* This line is printed on a proposal a homeowner reads. Trade
                shorthand is what the tech types; plain English is what wins
                the job. The rewrite still cannot invent a price — the figure
                firewall would throw it out. */}
            <PolishBox
              text={customName}
              surface="estimate"
              showTone={false}
              label="✨ Say it plainer"
              onUse={(polished: string) => setCustomName(polished.slice(0, 300))}
            />
          </div>
          <div>
            <label htmlFor="custom-price">Price each</label>
            <input
              id="custom-price"
              value={customPrice}
              onChange={(e) => setCustomPrice(e.target.value)}
              inputMode="decimal"
              placeholder="$1,850.00"
              onKeyDown={(e) => {
                if (e.key === "Enter") addCustom();
              }}
            />
          </div>
          <div>
            <label htmlFor="custom-qty">Qty</label>
            <input
              id="custom-qty"
              value={customQty}
              onChange={(e) => setCustomQty(e.target.value.replace(/[^\d.]/g, "").slice(0, 6))}
              inputMode="decimal"
              placeholder="1"
              onKeyDown={(e) => {
                if (e.key === "Enter") addCustom();
              }}
            />
          </div>
        </div>
        <div className="row" style={{ marginTop: 12, alignItems: "center" }}>
          <button onClick={addCustom} disabled={missingForCustom.length > 0}>
            Add to {TIERS.find((t) => t.key === tier)!.title}
          </button>
          {/* A disabled control names what would enable it — the pricebook
              screen taught us what a silent grey button reads as. */}
          {missingForCustom.length > 0 ? (
            <span className="muted" style={{ fontSize: "0.9rem" }}>
              Still needs {missingForCustom.join(" and ")}
            </span>
          ) : (
            <span className="muted" style={{ fontSize: "0.9rem" }}>
              {customPreview}
            </span>
          )}
        </div>
      </div>

      {TIERS.map((t) =>
        lines[t.key]!.length === 0 ? null : (
          <div key={t.key}>
            <h2>
              {t.title} — {dollars(totals[t.key]!)}
              {financing && totals[t.key]! > 0 && (
                <span className="muted" style={{ fontWeight: 400 }}>
                  {" "}· as low as <strong className="gain">{dollars(monthly(totals[t.key]!, financing))}/mo</strong> for {financing.termMonths} mo*
                </span>
              )}
            </h2>
            <div className="card">
              {lines[t.key]!.map((l, idx) => (
                <div key={l.key} className="row" style={{ padding: "4px 0" }}>
                  <span className="grow">
                    {l.description}
                    {!l.pricebookItemId && (
                      // Worth distinguishing at review time: a one-off has no
                      // pricebook entry behind it, so nothing else validates
                      // its price.
                      <span className="muted" style={{ fontSize: "0.8rem" }}>
                        {" "}· one-off @ {dollars(l.unitPriceCents)}
                      </span>
                    )}
                  </span>
                  <button className="secondary" style={{ minHeight: 36, padding: "4px 12px" }} onClick={() => bump(t.key, idx, -1)} aria-label={`Less ${l.description}`}>−</button>
                  <span style={{ minWidth: 44, textAlign: "center" }}>{(l.qtyX100 / 100).toFixed(0)}</span>
                  <button className="secondary" style={{ minHeight: 36, padding: "4px 12px" }} onClick={() => bump(t.key, idx, 1)} aria-label={`More ${l.description}`}>＋</button>
                  <span style={{ minWidth: 90, textAlign: "right" }}>
                    {dollars(Math.round((l.qtyX100 * l.unitPriceCents) / 100))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ),
      )}

      <div className="row" style={{ marginTop: 16 }}>
        <button disabled={busy || !anyLines} onClick={() => void createEstimate()}>
          Create estimate{anyLines ? ` (${TIERS.filter((t) => lines[t.key]!.length > 0).length} option${TIERS.filter((t) => lines[t.key]!.length > 0).length === 1 ? "" : "s"})` : ""}
        </button>
      </div>
      {financing && (
        <p className="muted" style={{ marginTop: 10 }}>
          *Payment shown for comparison at {(financing.aprBps / 100).toFixed(2)}% APR — the
          financing decision itself always comes from the financing partner
          {financing.applyUrl ? "" : " (application link activates when the partner account is connected)"}.
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </AppShell>
  );
}
