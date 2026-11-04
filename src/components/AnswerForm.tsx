"use client";
import { useState } from "react";
import CategoryPicker, { type CategoryOption } from "@/components/CategoryPicker";

/**
 * One bank line, one answer — the whole point of the redesign.
 *
 * Before this, the row showed a job dropdown and a "Job cost" button ALWAYS,
 * with a raw account-code text box beside it, and there was no way to say
 * "this one isn't a job cost, it's just fuel". You had to know which of the
 * two halves to ignore. Now the four answers are a single choice, and only
 * the fields belonging to that choice are on screen:
 *
 *     Category    — the ordinary one, and the default
 *     Job cost    — money that belongs to a specific job
 *     Personal    — the owner's, not the business's
 *     Not ours    — a duplicate, or somebody else's line entirely
 *
 * Used in both places on purpose: answering a line for the first time and
 * CORRECTING one that is already posted run the same form, because "recode
 * it" and "code it" are the same decision. The only difference is that a
 * correction has to say why (`requireReason`), which is what turns the audit
 * trail into something a person can actually read later.
 */

export interface JobOption {
  id: string;
  jobNo: number;
  name: string;
}
export interface CostCodeOption {
  code: string;
  name: string;
  kind: string;
}

export type SplitLine =
  | { type: "expense"; accountCode: string; amountCents: number }
  | {
      type: "job-cost";
      jobId: string;
      costCode: string;
      kind: "labor" | "material" | "sub" | "equipment" | "other";
      amountCents: number;
    };

export type AnswerAction =
  | { type: "expense"; accountCode: string; remember?: boolean }
  | {
      type: "job-cost";
      jobId: string;
      costCode: string;
      kind: "labor" | "material" | "sub" | "equipment" | "other";
      remember?: boolean;
    }
  | { type: "personal" }
  | { type: "exclude" }
  | { type: "split"; lines: SplitLine[] }
  | { type: "transfer"; otherAccountId: string };

type Mode = "category" | "job" | "split" | "transfer" | "personal" | "exclude";

/** One editable row of a split, before it is validated into a SplitLine. */
interface SplitDraft {
  kind: "category" | "job";
  accountCode: string;
  jobId: string;
  costCode: string;
  costKind: "labor" | "material" | "sub" | "equipment" | "other";
  amount: string;
}

const KINDS = ["labor", "material", "sub", "equipment", "other"] as const;

export interface AccountOption {
  id: string;
  name: string;
  kind: string;
}

export default function AnswerForm({
  amountCents,
  categories,
  costCodes,
  jobs,
  accounts = [],
  thisAccountId,
  busy,
  requireReason = false,
  submitLabel = "Save",
  onSubmit,
  onCancel,
}: {
  amountCents: number;
  categories: CategoryOption[];
  costCodes: CostCodeOption[];
  jobs: JobOption[];
  /** The shop's other accounts, for the transfer answer. */
  accounts?: AccountOption[];
  thisAccountId?: string;
  busy: boolean;
  requireReason?: boolean;
  submitLabel?: string;
  onSubmit: (action: AnswerAction, reason: string) => void;
  onCancel?: () => void;
}) {
  const isOut = amountCents < 0;
  const [mode, setMode] = useState<Mode>("category");
  const [categoryCode, setCategoryCode] = useState("");
  const [jobId, setJobId] = useState(jobs[0]?.id ?? "");
  const [costCode, setCostCode] = useState(costCodes[0]?.code ?? "");
  const [kind, setKind] = useState<(typeof KINDS)[number]>("material");
  const [remember, setRemember] = useState(true);
  const [reason, setReason] = useState("");
  const others = accounts.filter((a) => a.id !== thisAccountId);
  const [transferTo, setTransferTo] = useState(others[0]?.id ?? "");
  // A split starts as two rows, because one row is not a split.
  const [splits, setSplits] = useState<SplitDraft[]>(() => {
    const blank: SplitDraft = {
      kind: "job",
      accountCode: "",
      jobId: jobs[0]?.id ?? "",
      costCode: costCodes[0]?.code ?? "",
      costKind: "material",
      amount: "",
    };
    return [blank, { ...blank }];
  });

  const abs = Math.abs(amountCents);
  const splitTotal = splits.reduce(
    (t, r) => t + Math.round((Number(r.amount) || 0) * 100),
    0,
  );
  // Shown live: "$4,120.88 charge, $2,000 and $1,500 entered, $620.88 left to
  // place" is the only feedback that makes a split finishable without a
  // calculator, and a split that does not add up puts the difference
  // somewhere nobody chose.
  const splitRemainder = abs - splitTotal;

  // Money IN cannot be a job cost or an owner draw — the server rejects both,
  // so the buttons are not offered rather than offered and then refused.
  const modes: { key: Mode; label: string }[] = [
    { key: "category", label: "Category" },
    ...(isOut ? ([{ key: "job" as const, label: "Job cost" }]) : []),
    { key: "split", label: "Split it" },
    // Only offered when there IS another account to move money to.
    ...(others.length > 0 ? ([{ key: "transfer" as const, label: "Transfer" }]) : []),
    ...(isOut ? ([{ key: "personal" as const, label: "Personal" }]) : []),
    { key: "exclude", label: "Not ours / duplicate" },
  ];

  function pickCostCode(code: string) {
    setCostCode(code);
    // The code carries its own default kind, so choosing "Subcontractors"
    // does not leave the kind on "material" and quietly mis-split the job's
    // labor-vs-sub breakdown.
    const found = costCodes.find((c) => c.code === code);
    if (found && (KINDS as readonly string[]).includes(found.kind)) {
      setKind(found.kind as (typeof KINDS)[number]);
    }
  }

  const splitReady =
    splits.length >= 2 &&
    splitRemainder === 0 &&
    splits.every(
      (r) =>
        Math.round((Number(r.amount) || 0) * 100) > 0 &&
        (r.kind === "category" ? r.accountCode !== "" : r.jobId !== "" && r.costCode !== ""),
    );

  const ready =
    mode === "category"
      ? categoryCode !== ""
      : mode === "job"
        ? jobId !== "" && costCode !== ""
        : mode === "split"
          ? splitReady
          : mode === "transfer"
            ? transferTo !== ""
            : true;
  const reasonOk = !requireReason || reason.trim().length > 0;

  function submit() {
    const action: AnswerAction =
      mode === "category"
        ? { type: "expense", accountCode: categoryCode, remember }
        : mode === "job"
          ? { type: "job-cost", jobId, costCode, kind, remember }
          : mode === "split"
            ? {
                type: "split",
                lines: splits.map((r) =>
                  r.kind === "category"
                    ? {
                        type: "expense" as const,
                        accountCode: r.accountCode,
                        amountCents: Math.round(Number(r.amount) * 100),
                      }
                    : {
                        type: "job-cost" as const,
                        jobId: r.jobId,
                        costCode: r.costCode,
                        kind: r.costKind,
                        amountCents: Math.round(Number(r.amount) * 100),
                      },
                ),
              }
            : mode === "transfer"
              ? { type: "transfer", otherAccountId: transferTo }
              : mode === "personal"
                ? { type: "personal" }
                : { type: "exclude" };
    onSubmit(action, reason.trim());
  }

  return (
    <div style={{ marginTop: 10 }}>
      {/* The mode switch. `.chip` + aria-pressed is the same control the inbox
          filters use — a real toggle to a screen reader, and it wraps onto two
          rows on a phone instead of overflowing. */}
      <div className="row" role="group" aria-label="How should this be recorded?">
        {modes.map((m) => (
          <button
            key={m.key}
            type="button"
            className="chip"
            aria-pressed={mode === m.key}
            onClick={() => setMode(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === "category" && (
        <div className="row" style={{ marginTop: 8 }}>
          <div className="grow">
            <CategoryPicker
              categories={categories}
              value={categoryCode}
              onChange={setCategoryCode}
              direction={isOut ? "out" : "in"}
              label={isOut ? "Expense category" : "Income category"}
            />
          </div>
        </div>
      )}

      {mode === "job" && (
        <div className="row" style={{ marginTop: 8 }}>
          <div className="grow">
            <label className="muted" htmlFor="af-job">Job</label>
            <select id="af-job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
              {jobs.length === 0 && <option value="">No open jobs</option>}
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>#{j.jobNo} {j.name}</option>
              ))}
            </select>
          </div>
          <div className="grow">
            <label className="muted" htmlFor="af-code">Cost code</label>
            <select id="af-code" value={costCode} onChange={(e) => pickCostCode(e.target.value)}>
              {costCodes.length === 0 && <option value="">No cost codes</option>}
              {costCodes.map((c) => (
                <option key={c.code} value={c.code}>{c.name} ({c.code})</option>
              ))}
            </select>
          </div>
          <div>
            <label className="muted" htmlFor="af-kind">Type of cost</label>
            <select
              id="af-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </div>
        </div>
      )}


      {mode === "split" && (
        <div style={{ marginTop: 8 }}>
          <p className="muted" style={{ marginTop: 0 }}>
            One charge, several answers — a supply-house run that covered three
            jobs. The parts have to add up to the charge{" "}
            <strong>exactly</strong>.
          </p>
          {splits.map((r, i) => (
            <div key={i} className="row" style={{ marginBottom: 6 }}>
              <select
                aria-label={`Part ${i + 1} type`}
                value={r.kind}
                onChange={(e) =>
                  setSplits((s) =>
                    s.map((x, j) =>
                      j === i ? { ...x, kind: e.target.value as "category" | "job" } : x,
                    ),
                  )
                }
              >
                <option value="job">Job cost</option>
                <option value="category">Category</option>
              </select>
              {r.kind === "job" ? (
                <>
                  <select
                    aria-label={`Part ${i + 1} job`}
                    className="grow"
                    value={r.jobId}
                    onChange={(e) =>
                      setSplits((s) =>
                        s.map((x, j) => (j === i ? { ...x, jobId: e.target.value } : x)),
                      )
                    }
                  >
                    {jobs.map((j) => (
                      <option key={j.id} value={j.id}>#{j.jobNo} {j.name}</option>
                    ))}
                  </select>
                  <select
                    aria-label={`Part ${i + 1} cost code`}
                    value={r.costCode}
                    onChange={(e) => {
                      const found = costCodes.find((c) => c.code === e.target.value);
                      setSplits((s) =>
                        s.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                costCode: e.target.value,
                                costKind:
                                  found && (KINDS as readonly string[]).includes(found.kind)
                                    ? (found.kind as SplitDraft["costKind"])
                                    : x.costKind,
                              }
                            : x,
                        ),
                      );
                    }}
                  >
                    {costCodes.map((c) => (
                      <option key={c.code} value={c.code}>{c.code} · {c.name}</option>
                    ))}
                  </select>
                </>
              ) : (
                <div className="grow">
                  <CategoryPicker
                    categories={categories}
                    value={r.accountCode}
                    onChange={(code) =>
                      setSplits((s) =>
                        s.map((x, j) => (j === i ? { ...x, accountCode: code } : x)),
                      )
                    }
                    direction={isOut ? "out" : "in"}
                    label={`Part ${i + 1} category`}
                  />
                </div>
              )}
              <input
                aria-label={`Part ${i + 1} amount`}
                inputMode="decimal"
                placeholder="0.00"
                style={{ width: 110 }}
                value={r.amount}
                onChange={(e) =>
                  setSplits((s) =>
                    s.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)),
                  )
                }
              />
              {splits.length > 2 && (
                <button
                  className="secondary"
                  aria-label={`Remove part ${i + 1}`}
                  onClick={() => setSplits((s) => s.filter((_, j) => j !== i))}
                >
                  &#10005;
                </button>
              )}
            </div>
          ))}
          <div className="row">
            <button
              className="secondary"
              onClick={() =>
                setSplits((s) => [
                  ...s,
                  {
                    kind: "job",
                    accountCode: "",
                    jobId: jobs[0]?.id ?? "",
                    costCode: costCodes[0]?.code ?? "",
                    costKind: "material",
                    // Pre-filled with whatever is left, so the LAST part of a
                    // split needs no arithmetic at all.
                    amount: splitRemainder > 0 ? (splitRemainder / 100).toFixed(2) : "",
                  },
                ])
              }
            >
              + Another part
            </button>
            <span className="grow" />
            <strong style={{ alignSelf: "center" }} aria-live="polite">
              {splitRemainder === 0
                ? "Adds up"
                : splitRemainder > 0
                  ? `$${(splitRemainder / 100).toFixed(2)} left to place`
                  : `$${(-splitRemainder / 100).toFixed(2)} over`}
            </strong>
          </div>
        </div>
      )}

      {mode === "transfer" && (
        <div style={{ marginTop: 8 }}>
          <label className="muted" htmlFor="af-transfer">
            {amountCents < 0 ? "Money went TO" : "Money came FROM"}
          </label>
          <select
            id="af-transfer"
            value={transferTo}
            onChange={(e) => setTransferTo(e.target.value)}
          >
            {others.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.kind && a.kind !== "checking" ? ` (${a.kind.replace("-", " ")})` : ""}
              </option>
            ))}
          </select>
          <p className="muted" style={{ marginBottom: 0 }}>
            ⛔ Use this for paying the credit card, or moving money to savings.
            It touches no income or expense account — a transfer moves your
            money around, it does not change what the business is worth.
            Coding it as an expense on one side and income on the other
            overstates your profit by twice the payment.
          </p>
        </div>
      )}

      {mode === "personal" && (
        <p className="muted" style={{ marginTop: 8 }}>
          Recorded as money the owner took out. It never touches profit or any
          job, and the bank still balances to the penny.
        </p>
      )}

      {mode === "exclude" && (
        <p className="muted" style={{ marginTop: 8 }}>
          Nothing posts. Use this for a duplicate line or a transfer that is
          already on the books somewhere else.
        </p>
      )}

      {requireReason && (
        <div style={{ marginTop: 8 }}>
          <label className="muted" htmlFor="af-reason">
            Why are you changing this?
          </label>
          <input
            id="af-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Went to the wrong job — this was the Nguyen re-roof"
          />
        </div>
      )}

      <div className="row" style={{ marginTop: 10 }}>
        <button disabled={busy || !ready || !reasonOk} onClick={submit}>
          {submitLabel}
        </button>
        {onCancel && (
          <button className="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
        {(mode === "category" || mode === "job") && (
          <label className="muted" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            remember this for next time
          </label>
        )}
      </div>
    </div>
  );
}
