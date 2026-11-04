"use client";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

interface CostCode {
  code: string;
  name: string;
  kind: string;
  division: string | null;
  sortOrder: number;
  glAccountCode: string | null;
  isActive: boolean;
  source: string;
  useCount: number;
}
interface Preset {
  key: string;
  label: string;
  blurb: string;
  count: number;
}

const KINDS = ["labor", "material", "sub", "equipment", "other"] as const;

export default function CostCodesPage() {
  const router = useRouter();
  const [loaded, setLoaded] = useState(false);
  const [codes, setCodes] = useState<CostCode[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  // new-code form
  const [nCode, setNCode] = useState("");
  const [nName, setNName] = useState("");
  const [nKind, setNKind] = useState<string>("material");
  const [nDivision, setNDivision] = useState("");
  const showSkeleton = useFirstLoad(loaded);

  const load = useCallback(
    async (all: boolean) => {
      try {
        const r = await api<{ costCodes: CostCode[]; presets: Preset[] }>(
          `/api/cost-codes${all ? "?all=1" : ""}`,
        );
        setCodes(r.costCodes);
        setPresets(r.presets);
        setLoaded(true);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          router.push("/login");
        } else setError("Couldn't load your cost codes.");
      }
    },
    [router],
  );

  useEffect(() => {
    void load(showInactive);
  }, [load, showInactive]);

  async function seed(preset: Preset) {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ added: number; alreadyThere: number }>("/api/cost-codes", {
        method: "POST",
        json: { action: "seed", preset: preset.key },
      });
      setNote(
        r.added === 0
          ? `Nothing new — you already have all ${r.alreadyThere} of those codes.`
          : `Added ${r.added} code${r.added === 1 ? "" : "s"}${r.alreadyThere > 0 ? `, and left the ${r.alreadyThere} you already had alone` : ""}.`,
      );
      await load(showInactive);
    } catch {
      setError("Couldn't add that set — try again.");
    } finally {
      setBusy(false);
    }
  }

  async function save(input: Partial<CostCode> & { code: string; name: string; kind: string }) {
    setBusy(true);
    setError("");
    try {
      await api("/api/cost-codes", {
        method: "POST",
        json: {
          action: "upsert",
          code: input.code,
          name: input.name,
          kind: input.kind,
          division: input.division ?? undefined,
          isActive: input.isActive ?? true,
        },
      });
      setEditing(null);
      setNCode("");
      setNName("");
      setNDivision("");
      await load(showInactive);
    } catch {
      setError("Couldn't save that code.");
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return (
      <AppShell title="Cost codes">
        {showSkeleton && <PageSkeleton kind="table" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  const divisions = [...new Set(codes.map((c) => c.division?.trim() || "Other"))];

  return (
    <AppShell title="Cost codes">
      <div className="card">
        <p style={{ marginTop: 0 }}>
          A cost code says <strong>what kind of work</strong> a dollar was. They
          are what make the job-cost report, WIP, a schedule of values and your
          bonding schedule mean anything — without them every cost in the
          business lands in one bucket and the reports have nothing to say.
        </p>
        <p className="muted" style={{ marginBottom: 0 }}>
          Start from a set below, then rename, retire and add freely. Adding a
          set never overwrites a code you have already changed.
        </p>
      </div>

      {codes.length === 0 && (
        <>
          <h2>Pick a starting set</h2>
          {presets.map((p) => (
            <div key={p.key} className="card">
              <div className="row">
                <div className="grow">
                  <strong>{p.label}</strong>
                  <div className="muted">{p.blurb}</div>
                </div>
                <button disabled={busy} onClick={() => void seed(p)} style={{ alignSelf: "center" }}>
                  Use these {p.count}
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {codes.length > 0 && (
        <>
          <div className="row">
            <h2 className="grow">Your codes ({codes.filter((c) => c.isActive).length})</h2>
            <label className="muted" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
              show retired
            </label>
          </div>

          {divisions.map((div) => (
            <div key={div} className="card" style={{ padding: 0 }}>
              <div className="navgroup" style={{ padding: "10px 14px" }}>{div}</div>
              {codes
                .filter((c) => (c.division?.trim() || "Other") === div)
                .map((c) =>
                  editing === c.code ? (
                    <EditRow
                      key={c.code}
                      code={c}
                      busy={busy}
                      onCancel={() => setEditing(null)}
                      onSave={save}
                    />
                  ) : (
                    <div key={c.code} className="row" style={{ padding: "8px 14px" }}>
                      <span className="grow">
                        <strong>{c.code}</strong> · {c.name}{" "}
                        <span className="pill">{c.kind}</span>{" "}
                        {!c.isActive && <span className="pill">retired</span>}
                      </span>
                      <span className="muted">
                        {c.useCount > 0 ? `${c.useCount} cost${c.useCount === 1 ? "" : "s"}` : "unused"}
                      </span>
                      <button className="secondary" disabled={busy} onClick={() => setEditing(c.code)}>
                        Edit
                      </button>
                    </div>
                  ),
                )}
            </div>
          ))}

          <h2>Add another set</h2>
          <div className="card">
            <div className="row">
              {presets.map((p) => (
                <button key={p.key} className="secondary" disabled={busy} onClick={() => void seed(p)}>
                  + {p.label}
                </button>
              ))}
            </div>
            <p className="muted" style={{ marginBottom: 0 }}>
              Merges in anything you don&apos;t already have. Your own edits are
              never touched.
            </p>
          </div>
        </>
      )}

      <h2>Add a code of your own</h2>
      <div className="card">
        <div className="row">
          <div>
            <label htmlFor="nc">Code</label>
            <input id="nc" value={nCode} onChange={(e) => setNCode(e.target.value)} placeholder="23-700" style={{ width: 110 }} />
          </div>
          <div className="grow">
            <label htmlFor="nn">What it&apos;s for</label>
            <input id="nn" value={nName} onChange={(e) => setNName(e.target.value)} placeholder="Duct cleaning" />
          </div>
          <div>
            <label htmlFor="nk">Kind</label>
            <select id="nk" value={nKind} onChange={(e) => setNKind(e.target.value)}>
              {KINDS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="nd">Division</label>
            <input id="nd" value={nDivision} onChange={(e) => setNDivision(e.target.value)} placeholder="23 HVAC" list="divisions" />
            <datalist id="divisions">
              {divisions.map((d) => <option key={d} value={d} />)}
            </datalist>
          </div>
          <button
            style={{ alignSelf: "flex-end" }}
            disabled={busy || !nCode.trim() || !nName.trim()}
            onClick={() =>
              void save({ code: nCode, name: nName, kind: nKind, division: nDivision })
            }
          >
            Add
          </button>
        </div>
      </div>

      {note && <p className="muted">{note}</p>}
      {error && <p className="error">{error}</p>}
      <p className="muted">
        A code&apos;s number never changes once costs point at it — renaming the
        number would rewrite every report that groups by it. Retire it and add a
        new one instead.
      </p>
    </AppShell>
  );
}

function EditRow({
  code,
  busy,
  onCancel,
  onSave,
}: {
  code: CostCode;
  busy: boolean;
  onCancel: () => void;
  onSave: (c: { code: string; name: string; kind: string; division: string; isActive: boolean }) => void;
}) {
  const [name, setName] = useState(code.name);
  const [kind, setKind] = useState(code.kind);
  const [division, setDivision] = useState(code.division ?? "");
  const [isActive, setIsActive] = useState(code.isActive);

  return (
    <div className="row" style={{ padding: "8px 14px" }}>
      <strong style={{ minWidth: 70 }}>{code.code}</strong>
      <input className="grow" value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
      <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
        {KINDS.map((k) => (
          <option key={k} value={k}>{k}</option>
        ))}
      </select>
      <input value={division} onChange={(e) => setDivision(e.target.value)} aria-label="Division" style={{ width: 150 }} />
      <label className="muted" style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
        active
      </label>
      <button disabled={busy} onClick={() => onSave({ code: code.code, name, kind, division, isActive })}>
        Save
      </button>
      <button className="secondary" disabled={busy} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
