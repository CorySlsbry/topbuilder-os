"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/client/api";
import SignaturePad from "@/components/SignaturePad";

/**
 * Filling in a job's forms, from a phone, on site.
 *
 * ⛔ EVERY ANSWER SAVES ON ITS OWN. The opposite choice from the template
 * builder, and for the opposite reason: a whole-form save on a roof with two
 * bars loses the whole form. One item at a time means a dropped request costs
 * one answer.
 *
 * The local state is optimistic — the tick lands immediately and the request
 * follows — because a checkbox that waits for a round trip on bad signal feels
 * broken, and the person tapping it is on a ladder.
 */

type Kind = "check" | "text" | "number" | "photo" | "signature";

interface FormItem {
  id: string;
  position: number;
  kind: Kind;
  label: string;
  hint: string;
  required: boolean;
  checked: boolean | null;
  valueText: string;
  valueNumber: number | null;
  attachmentId: string | null;
  signedName: string;
}
interface JobForm {
  id: string;
  templateId: string;
  name: string;
  status: "open" | "complete";
  requiredForCompletion: boolean;
  completedAt: string | null;
  completedBy: string;
  items: FormItem[];
  completeness: {
    total: number;
    answered: number;
    requiredTotal: number;
    requiredAnswered: number;
    canComplete: boolean;
    missing: string[];
  };
  explain: string;
}
interface Template {
  id: string;
  name: string;
  archived: boolean;
}

export default function JobForms({ jobId }: { jobId: string }) {
  const [forms, setForms] = useState<JobForm[] | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [f, t] = await Promise.all([
        api<{ forms: JobForm[] }>(`/api/jobs/${jobId}/forms`),
        api<{ templates: Template[] }>("/api/form-templates"),
      ]);
      setForms(f.forms);
      setTemplates(t.templates.filter((x) => !x.archived));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 403)) setError("Couldn't load this job's forms.");
      setForms([]);
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Save one answer.
   *
   * The local update happens FIRST and is not rolled back on failure — the
   * error line says what happened and the value stays on screen, because
   * silently reverting a tick somebody made is how a checklist ends up
   * disagreeing with the person who filled it in.
   */
  async function answer(formId: string, itemId: string, patch: Partial<FormItem>) {
    setBusyItem(itemId);
    setError("");
    setForms((list) =>
      (list ?? []).map((f) =>
        f.id !== formId
          ? f
          : { ...f, items: f.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) },
      ),
    );
    try {
      await api(`/api/job-form-items/${itemId}`, {
        method: "PATCH",
        json: {
          checked: patch.checked ?? null,
          valueText: patch.valueText ?? "",
          valueNumber: patch.valueNumber ?? null,
          attachmentId: patch.attachmentId ?? null,
          signedName: patch.signedName ?? "",
        },
      });
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "form_already_complete"
          ? "This form is finished — reopen it to change an answer."
          : "That answer didn't save. It's still on screen; try again when you have signal.",
      );
    } finally {
      setBusyItem(null);
    }
  }

  /** A photo or a signature PNG goes through the SAME upload path as any other
   *  job attachment — proven, size-limited, and content-type checked. */
  async function upload(formId: string, item: FormItem, file: File) {
    setBusyItem(item.id);
    setError("");
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("kind", "photo");
      const res = await fetch(`/api/jobs/${jobId}/attachments`, { method: "POST", body });
      if (!res.ok) throw new Error("upload_failed");
      const { id } = (await res.json()) as { id: string };
      await answer(formId, item.id, { attachmentId: id });
    } catch {
      setError("That photo didn't upload. Try again when you have signal.");
      setBusyItem(null);
    }
  }

  async function decide(formId: string, action: "complete" | "reopen") {
    setError("");
    try {
      await api(`/api/job-forms/${formId}`, { method: "POST", json: { action } });
      setNote(action === "complete" ? "Form finished." : "Reopened — you can edit it again.");
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code?.startsWith("form_incomplete")
          ? `Still needed: ${e.code.split(":")[1]}`
          : "That didn't work.",
      );
    }
  }

  async function attach(templateId: string) {
    setError("");
    try {
      await api(`/api/jobs/${jobId}/forms`, { method: "POST", json: { templateId } });
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError && e.code === "form_already_on_this_job"
          ? "That form is already on this job."
          : "Couldn't add that form.",
      );
    }
  }

  if (!forms) return null;

  return (
    <div className="card">
      <h2 style={{ marginTop: 0 }}>Forms &amp; checklists</h2>
      {error && <p className="error">{error}</p>}
      {note && <p className="gain">{note}</p>}

      {forms.map((f) => (
        <div key={f.id} className="card" style={{ padding: 12, marginBottom: 10 }}>
          <div className="row" style={{ alignItems: "center" }}>
            <strong className="grow">{f.name}</strong>
            {f.status === "complete" ? (
              <span className="pill" style={{ background: "#dcefe4" }}>finished ✓</span>
            ) : (
              <span className="pill">
                {f.completeness.requiredAnswered}/{f.completeness.requiredTotal} required
              </span>
            )}
          </div>
          <p className="muted" style={{ margin: "4px 0 10px" }}>{f.explain}</p>

          {f.items.map((it) => (
            <div key={it.id} style={{ padding: "8px 0", borderTop: "1px solid var(--line, #eee)" }}>
              <div className="row" style={{ alignItems: "flex-start" }}>
                <div className="grow">
                  <label htmlFor={`i-${it.id}`}>
                    {it.label} {it.required && <span aria-label="required">*</span>}
                  </label>
                  {it.hint && (
                    <div className="muted" style={{ fontSize: "0.82rem" }}>{it.hint}</div>
                  )}
                </div>
              </div>

              {it.kind === "check" && (
                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    id={`i-${it.id}`}
                    type="checkbox"
                    checked={it.checked === true}
                    disabled={f.status === "complete" || busyItem === it.id}
                    onChange={(e) => void answer(f.id, it.id, { checked: e.target.checked })}
                  />
                  <span className="muted" style={{ fontSize: "0.85rem" }}>
                    {it.checked === true ? "Done" : "Not done yet"}
                  </span>
                </label>
              )}

              {it.kind === "text" && (
                <input
                  id={`i-${it.id}`}
                  defaultValue={it.valueText}
                  disabled={f.status === "complete" || busyItem === it.id}
                  // On blur, not on every keystroke: one save per answer, not
                  // one per letter typed with a glove on.
                  onBlur={(e) =>
                    e.target.value !== it.valueText &&
                    void answer(f.id, it.id, { valueText: e.target.value })
                  }
                />
              )}

              {it.kind === "number" && (
                <input
                  id={`i-${it.id}`}
                  inputMode="decimal"
                  defaultValue={it.valueNumber === null ? "" : String(it.valueNumber)}
                  disabled={f.status === "complete" || busyItem === it.id}
                  onBlur={(e) => {
                    const raw = e.target.value.trim();
                    // "" clears it; "0" is a real answer and must not be
                    // treated as empty.
                    const n = raw === "" ? null : Number(raw);
                    if (raw !== "" && !Number.isFinite(n)) return;
                    if (n !== it.valueNumber) void answer(f.id, it.id, { valueNumber: n });
                  }}
                />
              )}

              {it.kind === "photo" && (
                <div>
                  {it.attachmentId ? (
                    /* A plain <img>: these bytes come from an AUTHENTICATED
                       route, and next/image fetches server-side without the
                       session, so the optimizer cannot load them. Same reason
                       the inbox uses one. */
                    <img
                      src={`/api/attachments/${it.attachmentId}`}
                      alt={`Photo for ${it.label}`}
                      style={{ maxWidth: 220, borderRadius: 8, display: "block" }}
                    />
                  ) : (
                    <input
                      id={`i-${it.id}`}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      disabled={f.status === "complete" || busyItem === it.id}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void upload(f.id, it, file);
                      }}
                    />
                  )}
                </div>
              )}

              {it.kind === "signature" && (
                <div>
                  {it.attachmentId || it.signedName ? (
                    <div className="muted">
                      {it.signedName ? `Signed: ${it.signedName}` : "Signed."}
                    </div>
                  ) : (
                    <SignaturePad
                      disabled={f.status === "complete" || busyItem === it.id}
                      onTyped={(nm) => nm && void answer(f.id, it.id, { signedName: nm })}
                      onDrawn={(png) => {
                        // The PNG goes through the ordinary attachment route.
                        // `image/svg+xml` is not an allowed upload — correctly,
                        // it is a script vector — which is why the pad is a
                        // canvas and not vector output.
                        void fetch(png)
                          .then((r) => r.blob())
                          .then((b) =>
                            upload(f.id, it, new File([b], "signature.png", { type: "image/png" })),
                          );
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          ))}

          <div className="row" style={{ marginTop: 10 }}>
            {f.status === "open" ? (
              <button
                onClick={() => void decide(f.id, "complete")}
                disabled={!f.completeness.canComplete}
                title={f.completeness.canComplete ? undefined : f.explain}
              >
                Finish this form
              </button>
            ) : (
              <button className="secondary" onClick={() => void decide(f.id, "reopen")}>
                Reopen
              </button>
            )}
          </div>
        </div>
      ))}

      {forms.length === 0 && (
        <p className="muted">No forms on this job yet.</p>
      )}

      {templates.length > 0 && (
        <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          {templates
            .filter((t) => !forms.some((f) => f.templateId === t.id))
            .map((t) => (
              <button key={t.id} className="secondary" onClick={() => void attach(t.id)}>
                + {t.name}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
