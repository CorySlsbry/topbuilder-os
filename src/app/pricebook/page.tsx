"use client";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError, dollars } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface Item {
  id: string;
  code: string;
  name: string;
  description: string | null;
  unit: string;
  unitPriceCents: number;
  category: string;
  hasPhoto: boolean;
}

export default function PricebookPage() {
  const router = useRouter();
  // Has the first load finished? The list state starts as [] and
  // cannot answer that on its own.
  const [loaded, setLoaded] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [cat, setCat] = useState("all");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  // add form
  const [fCode, setFCode] = useState("");
  const [fName, setFName] = useState("");
  const [fDesc, setFDesc] = useState("");
  const [fUnit, setFUnit] = useState("each");
  const [fPrice, setFPrice] = useState("");
  const [fCat, setFCat] = useState("");
  const [photoFor, setPhotoFor] = useState<string | null>(null);
  // First load only: the latch inside useFirstLoad means act()'s
  // refetch after every save never re-arms this.
  const showSkeleton = useFirstLoad(loaded);

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: Item[] }>("/api/pricebook");
      setItems(r.items);
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
  const cents = (s: string) => Math.round(Number(s.replace(/[$,]/g, "")) * 100);

  async function addItem() {
    setBusy(true);
    setError("");
    try {
      await api("/api/pricebook", {
        method: "POST",
        json: {
          code: fCode.trim(),
          name: fName.trim(),
          description: fDesc.trim() || undefined,
          unit: fUnit.trim() || "each",
          unitPriceCents: cents(fPrice),
          category: fCat.trim() || undefined,
        },
      });
      setNote("Added. Tap its card to give it a photo — pictures sell.");
      setFCode("");
      setFName("");
      setFDesc("");
      setFPrice("");
      await load();
    } catch {
      setError("Couldn't add — check the fields (code must be unique).");
    } finally {
      setBusy(false);
    }
  }

  async function uploadPhoto(itemId: string, file: File) {
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/pricebook/${itemId}/photo`, { method: "POST", body: form });
      if (!res.ok) throw new Error();
      setNote("Photo saved.");
      await load();
    } catch {
      setError("Photo didn't upload — images up to 4 MB.");
    } finally {
      setBusy(false);
      setPhotoFor(null);
    }
  }

  /**
   * Which required fields are still empty. The button used to just sit greyed
   * out, and the realistic placeholders ("RR-30", "30-yr architectural shingle
   * re-roof") read as filled-in values — so the honest reaction was "the app is
   * broken", not "I missed a field". Name the gap instead of hiding it.
   */
  const missingForAdd = [
    !fCode.trim() && "a code",
    !fName.trim() && "a name",
    !Number(fPrice.replace(/[$,]/g, "")) && "a price",
  ].filter(Boolean) as string[];

  // First paint: a wireframe of this screen, inside the shell. Never on a
  // refetch — useFirstLoad latches, so saving does not re-flash the page.
  if (!loaded) {
    return (
      <AppShell title="Pricebook">
        {showSkeleton && <PageSkeleton kind="table" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  return (
    <AppShell title="Pricebook">
      <div className="card">
        <p className="muted" style={{ margin: 0 }}>
          Your flat-rate menu. Photos and plain names sell better than line
          items — build it once, and every estimate becomes tap-tap-done.
        </p>
      </div>

      <div className="row" role="tablist" aria-label="Categories">
        {cats.map((c) => (
          <button
            key={c}
            className="chip"
            aria-pressed={cat === c}
            onClick={() => setCat(c)}
          >
            {c === "all" ? "Everything" : c}
          </button>
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
          gap: 12,
          marginTop: 12,
        }}
      >
        {shown.map((i) => (
          <div key={i.id} className="card" style={{ margin: 0, padding: 0, overflow: "hidden" }}>
            <button
              className="secondary"
              style={{
                display: "block",
                width: "100%",
                height: 120,
                padding: 0,
                border: 0,
                borderRadius: 0,
                background: "var(--panel)",
                cursor: "pointer",
              }}
              aria-label={`Photo for ${i.name}`}
              onClick={() => setPhotoFor(photoFor === i.id ? null : i.id)}
            >
              {i.hasPhoto ? (
                <img
                  src={`/api/pricebook/${i.id}/photo`}
                  alt={i.name}
                  style={{ width: "100%", height: 120, objectFit: "cover", display: "block" }}
                />
              ) : (
                <span className="muted">＋ add photo</span>
              )}
            </button>
            {photoFor === i.id && (
              <div style={{ padding: "8px 12px 0" }}>
                <input
                  type="file"
                  accept="image/*"
                  aria-label={`Upload photo for ${i.name}`}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadPhoto(i.id, f);
                  }}
                />
              </div>
            )}
            <div style={{ padding: "10px 12px 12px" }}>
              <strong style={{ display: "block" }}>{i.name}</strong>
              {i.description && <span className="muted">{i.description}</span>}
              <div className="row" style={{ marginTop: 6, justifyContent: "space-between" }}>
                <span className="gain">{dollars(i.unitPriceCents)}</span>
                <span className="muted">per {i.unit}</span>
              </div>
            </div>
          </div>
        ))}
        {shown.length === 0 && (
          <p className="muted">Nothing here yet — add your first item below.</p>
        )}
      </div>

      <h2>Add an item</h2>
      <div className="card">
        <div className="row">
          <div>
            <label htmlFor="pc">Code</label>
            <input id="pc" value={fCode} onChange={(e) => setFCode(e.target.value)} placeholder="RR-30" style={{ width: 110 }} />
          </div>
          <div className="grow">
            <label htmlFor="pn">Name (how you say it to a customer)</label>
            <input id="pn" value={fName} onChange={(e) => setFName(e.target.value)} placeholder="30-yr architectural shingle re-roof" />
          </div>
          <div>
            <label htmlFor="pp">Price</label>
            <input id="pp" value={fPrice} onChange={(e) => setFPrice(e.target.value)} placeholder="450.00" style={{ width: 110 }} />
          </div>
          <div>
            <label htmlFor="pu">Per</label>
            <input id="pu" value={fUnit} onChange={(e) => setFUnit(e.target.value)} style={{ width: 90 }} />
          </div>
          <div>
            <label htmlFor="pcat">Category</label>
            <input id="pcat" value={fCat} onChange={(e) => setFCat(e.target.value)} placeholder="Roofing" style={{ width: 130 }} />
          </div>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <input
            value={fDesc}
            onChange={(e) => setFDesc(e.target.value)}
            placeholder="One-line description the customer sees"
            aria-label="Description"
            className="grow"
          />
          <button disabled={busy || missingForAdd.length > 0} onClick={() => void addItem()}>
            Add to pricebook
          </button>
        </div>
        {missingForAdd.length > 0 && (
          <p className="muted" style={{ marginTop: 6, marginBottom: 0 }}>
            Still needs {missingForAdd.join(" and ")}. The greyed-out examples
            are just suggestions &mdash; type over them.
          </p>
        )}
      </div>

      {note && <p className="muted">{note}</p>}
      {error && <p className="error">{error}</p>}
    </AppShell>
  );
}
