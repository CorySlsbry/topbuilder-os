"use client";
import { useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/client/api";
import PageSkeleton from "@/components/Skeleton";
import { useFirstLoad } from "@/lib/client/useFirstLoad";

/**
 * The form builder.
 *
 * ⛔ REORDER WITH BUTTONS, NOT DRAG AND DROP. Drag-and-drop needs a library
 * (which injects styles the CSP blocks), it is not keyboard-operable without
 * real work, and it is genuinely hard to use on a phone with gloves on — which
 * is the device half this product's users hold. Two arrows are boring, work
 * everywhere, and are announced correctly by a screen reader for free.
 *
 * ⛔ THE WHOLE ARRAY SAVES AT ONCE. There is no per-item endpoint, so two
 * people editing cannot produce an order neither chose. `position` is the
 * array index, assigned by the server.
 */

type Kind = "check" | "text" | "number" | "photo" | "signature";

interface Item {
  kind: Kind;
  label: string;
  hint?: string;
  required?: boolean;
}
interface Template {
  id: string;
  name: string;
  description: string;
  archived: boolean;
  requiredForCompletion: boolean;
  items: (Item & { id: string; position: number })[];
}

const KINDS: { key: Kind; label: string; blurb: string }[] = [
  { key: "check", label: "Tick box", blurb: "Confirm something was done" },
  { key: "text", label: "Short answer", blurb: "A note, a model number" },
  { key: "number", label: "Number", blurb: "A reading, a count, a torque" },
  { key: "photo", label: "Photo", blurb: "Proof of the work" },
  { key: "signature", label: "Signature", blurb: "Customer or crew sign-off" },
];

export default function FormsPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [editing, setEditing] = useState<Template | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [gate, setGate] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const showSkeleton = useFirstLoad(templates !== null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ templates: Template[] }>("/api/form-templates?archived=1");
      setTemplates(r.templates);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) router.push("/login");
      else setError("Couldn't load your forms.");
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  function startNew() {
    setEditing(null);
    setName("");
    setDescription("");
    setGate(false);
    setItems([{ kind: "check", label: "", required: true }]);
    setNote("");
  }

  function startEdit(t: Template) {
    setEditing(t);
    setName(t.name);
    setDescription(t.description);
    setGate(t.requiredForCompletion);
    setItems(t.items.map((i) => ({ kind: i.kind, label: i.label, hint: i.hint, required: i.required })));
    setNote("");
  }

  /** Swap with a neighbour. The whole array is saved, so order is never partial. */
  function moveItem(index: number, delta: number) {
    setItems((list) => {
      const next = [...list];
      const to = index + delta;
      if (to < 0 || to >= next.length) return list;
      [next[index], next[to]] = [next[to]!, next[index]!];
      return next;
    });
  }

  async function save() {
    if (!name.trim()) {
      setError("Give the form a name first.");
      return;
    }
    if (items.some((i) => !i.label.trim())) {
      setError("Every item needs a label.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = {
        name: name.trim(),
        description: description.trim(),
        requiredForCompletion: gate,
        items: items.map((i) => ({
          kind: i.kind,
          label: i.label.trim(),
          hint: (i.hint ?? "").trim(),
          required: Boolean(i.required),
        })),
      };
      if (editing) await api(`/api/form-templates/${editing.id}`, { method: "PUT", json: body });
      else await api("/api/form-templates", { method: "POST", json: body });
      setNote(editing ? "Saved." : "Form created. Add it to a job from the job screen.");
      setEditing(null);
      setItems([]);
      setName("");
      await load();
    } catch {
      setError("Couldn't save that form.");
    } finally {
      setBusy(false);
    }
  }

  async function setArchived(t: Template, archived: boolean) {
    setBusy(true);
    try {
      await api(`/api/form-templates/${t.id}`, { method: "PATCH", json: { archived } });
      setNote(
        archived
          ? "Archived. Jobs that already have it keep it."
          : "Back in use.",
      );
      await load();
    } finally {
      setBusy(false);
      await load();
    }
  }

  if (!templates) {
    return (
      <AppShell title="Forms & checklists">
        {showSkeleton && <PageSkeleton kind="list" />}
        {error && <p className="error">{error}</p>}
      </AppShell>
    );
  }

  const active = templates.filter((t) => !t.archived);
  const archived = templates.filter((t) => t.archived);

  return (
    <AppShell title="Forms & checklists">
      {error && <p className="error">{error}</p>}
      {note && <p className="gain">{note}</p>}

      <div className="card">
        <p className="muted" style={{ marginTop: 0 }}>
          Build the checklists and sign-offs your shop actually uses — a startup
          check, a safety sign-off, a photo log. Add one to a job from the job
          screen and your crew fills it in from their phone.
        </p>
        <button onClick={startNew} disabled={busy}>
          + New form
        </button>
      </div>

      {items.length > 0 && (
        <div className="card">
          <h2 style={{ marginTop: 0 }}>{editing ? `Editing: ${editing.name}` : "New form"}</h2>
          <label htmlFor="fname">Name</label>
          <input id="fname" value={name} onChange={(e) => setName(e.target.value.slice(0, 120))}
                 placeholder="Rooftop unit startup" />
          <label htmlFor="fdesc">What it&apos;s for (optional)</label>
          <input id="fdesc" value={description} onChange={(e) => setDescription(e.target.value.slice(0, 500))}
                 placeholder="Filled in before the crew leaves site" />

          <div style={{ marginTop: 12 }}>
            {items.map((it, i) => (
              <div key={i} className="card" style={{ padding: 10, marginBottom: 8 }}>
                <div className="row" style={{ alignItems: "center" }}>
                  <label htmlFor={`kind-${i}`} className="sr-only">Item type</label>
                  <select
                    id={`kind-${i}`}
                    value={it.kind}
                    onChange={(e) =>
                      setItems((l) => l.map((x, j) => (j === i ? { ...x, kind: e.target.value as Kind } : x)))
                    }
                  >
                    {KINDS.map((k) => (
                      <option key={k.key} value={k.key}>{k.label}</option>
                    ))}
                  </select>
                  <span className="grow" />
                  {/* Boring, keyboard-operable, glove-friendly. */}
                  <button className="secondary" onClick={() => moveItem(i, -1)} disabled={i === 0}
                          aria-label={`Move "${it.label || "item"}" up`}>↑</button>
                  <button className="secondary" onClick={() => moveItem(i, 1)} disabled={i === items.length - 1}
                          aria-label={`Move "${it.label || "item"}" down`}>↓</button>
                  <button className="secondary" aria-label={`Remove "${it.label || "item"}"`}
                          onClick={() => setItems((l) => l.filter((_, j) => j !== i))}>✕</button>
                </div>
                <label htmlFor={`label-${i}`} className="sr-only">What to ask</label>
                <input
                  id={`label-${i}`}
                  value={it.label}
                  placeholder={KINDS.find((k) => k.key === it.kind)?.blurb}
                  onChange={(e) =>
                    setItems((l) => l.map((x, j) => (j === i ? { ...x, label: e.target.value.slice(0, 200) } : x)))
                  }
                />
                <div className="row" style={{ alignItems: "center", marginTop: 6 }}>
                  <label style={{ display: "flex", gap: 6, alignItems: "center", margin: 0 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(it.required)}
                      onChange={(e) =>
                        setItems((l) => l.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))
                      }
                    />
                    <span>Must be answered to finish</span>
                  </label>
                </div>
              </div>
            ))}
          </div>

          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {KINDS.map((k) => (
              <button key={k.key} className="secondary"
                      onClick={() => setItems((l) => [...l, { kind: k.key, label: "", required: true }])}>
                + {k.label}
              </button>
            ))}
          </div>

          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 14 }}>
            <input type="checkbox" checked={gate} onChange={(e) => setGate(e.target.checked)} />
            <span>
              <strong>A job can&apos;t be marked complete until this form is finished.</strong>
              <br />
              <span className="muted" style={{ fontSize: "0.85rem" }}>
                This does nothing until you also switch the rule on under Team &amp;
                access — so you can set it up now and turn it on when you&apos;re ready.
              </span>
            </span>
          </label>

          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={() => void save()} disabled={busy}>
              {editing ? "Save changes" : "Create form"}
            </button>
            <button className="secondary" onClick={() => { setItems([]); setEditing(null); }} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <h2>Your forms</h2>
      <div className="card" style={{ padding: 0 }}>
        {active.map((t) => (
          <div key={t.id} className="list-item">
            <div className="row" style={{ alignItems: "center" }}>
              <div className="grow">
                <strong>{t.name}</strong>
                {t.requiredForCompletion && <span className="pill" style={{ marginLeft: 8 }}>required</span>}
                <div className="muted" style={{ fontSize: "0.85rem" }}>
                  {t.items.length} item{t.items.length === 1 ? "" : "s"}
                  {t.description ? ` · ${t.description}` : ""}
                </div>
              </div>
              <button className="secondary" onClick={() => startEdit(t)} disabled={busy}>Edit</button>
              <button className="secondary" onClick={() => void setArchived(t, true)} disabled={busy}>
                Archive
              </button>
            </div>
          </div>
        ))}
        {active.length === 0 && (
          <p className="muted" style={{ padding: 14, margin: 0 }}>
            No forms yet. Build the one your crew already carries on paper.
          </p>
        )}
      </div>

      {archived.length > 0 && (
        <>
          <h2>Archived</h2>
          <div className="card" style={{ padding: 0 }}>
            {archived.map((t) => (
              <div key={t.id} className="list-item">
                <div className="row" style={{ alignItems: "center" }}>
                  <span className="grow muted">{t.name}</span>
                  <button className="secondary" onClick={() => void setArchived(t, false)} disabled={busy}>
                    Restore
                  </button>
                </div>
              </div>
            ))}
          </div>
          <p className="muted" style={{ fontSize: "0.85rem" }}>
            Archived forms stop being offered on new jobs. Jobs that already have
            one keep it — deleting would erase what somebody was asked and signed.
          </p>
        </>
      )}
    </AppShell>
  );
}
