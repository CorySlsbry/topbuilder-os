// What "finished" means for a job form — pure, no I/O, decided in one place.
//
// This is small and it is the most consequential function in the feature,
// because a per-tenant setting can make it the thing that stops a crew marking
// a job complete. A rule that can strand somebody at 6pm on a Friday gets to
// be explicit, tested, and readable by the person it stops.

export type FormItemKind = "check" | "text" | "number" | "photo" | "signature";

export interface FormItemAnswer {
  kind: FormItemKind;
  label: string;
  required: boolean;
  checked?: boolean | null;
  valueText?: string;
  valueNumber?: number | null;
  attachmentId?: string | null;
  /** The typed-name fallback for a signature. */
  signedName?: string;
}

/**
 * Is this ONE item answered?
 *
 * The subtle cases are the point:
 *
 * - **check**: only `true` counts. An unticked box on a safety form is not an
 *   answer of "no" — it is the absence of one. A shop that genuinely means
 *   "no" needs a text or a number item, and saying so beats silently treating
 *   `false` as done.
 * - **number**: `0` IS an answer. `!value` would reject it, and "0 leaks
 *   found" is exactly the answer a safety checklist wants.
 * - **text**: whitespace is not an answer.
 * - **signature**: a drawn PNG *or* a typed name. Both count, deliberately —
 *   requiring a drawn squiggle makes a motor path the only way to finish a
 *   job, and some hands and some gloves cannot produce one.
 */
export function isAnswered(item: FormItemAnswer): boolean {
  switch (item.kind) {
    case "check":
      return item.checked === true;
    case "text":
      return (item.valueText ?? "").trim().length > 0;
    case "number":
      return item.valueNumber !== null && item.valueNumber !== undefined;
    case "photo":
      return Boolean(item.attachmentId);
    case "signature":
      return Boolean(item.attachmentId) || (item.signedName ?? "").trim().length > 0;
  }
}

export interface Completeness {
  total: number;
  answered: number;
  requiredTotal: number;
  requiredAnswered: number;
  /** Every required item answered. Optional items never block. */
  canComplete: boolean;
  /** The labels still missing, so the screen can name them instead of saying "incomplete". */
  missing: string[];
}

export function completeness(items: FormItemAnswer[]): Completeness {
  const required = items.filter((i) => i.required);
  const missing = required.filter((i) => !isAnswered(i)).map((i) => i.label);
  return {
    total: items.length,
    answered: items.filter(isAnswered).length,
    requiredTotal: required.length,
    requiredAnswered: required.length - missing.length,
    canComplete: missing.length === 0,
    missing,
  };
}

/**
 * The plain sentence a person reads when they cannot finish yet.
 *
 * ⛔ It NAMES the items. "This form is incomplete" is the message that makes
 * somebody hunt through twenty rows on a phone in the sun; "Still needed:
 * Torque check, Customer signature" is the message that gets a job finished.
 */
export function explainCompleteness(c: Completeness): string {
  if (c.requiredTotal === 0) {
    return c.total === 0
      ? "This form has no items yet."
      : `Nothing on this form is required — ${c.answered} of ${c.total} filled in.`;
  }
  if (c.canComplete) {
    return `All ${c.requiredTotal} required item${c.requiredTotal === 1 ? "" : "s"} answered. Ready to finish.`;
  }
  const names = c.missing.slice(0, 4).join(", ");
  const more = c.missing.length > 4 ? ` and ${c.missing.length - 4} more` : "";
  return `Still needed: ${names}${more}.`;
}

/**
 * Can this JOB be marked complete?
 *
 * Only forms whose template is marked required-for-completion can block, and
 * only when the tenant has switched the gate on at all. Both conditions are
 * checked here rather than at the call site so there is exactly one answer to
 * "why can't I close this job".
 */
export interface JobFormState {
  formId: string;
  name: string;
  requiredForCompletion: boolean;
  status: "open" | "complete";
}

export interface JobGateResult {
  blocked: boolean;
  /** Form names standing in the way. Empty when nothing is. */
  blockedBy: string[];
  explain: string;
}

export function jobCompletionGate(
  gateEnabled: boolean,
  forms: JobFormState[],
): JobGateResult {
  if (!gateEnabled) {
    return { blocked: false, blockedBy: [], explain: "" };
  }
  const blockedBy = forms
    .filter((f) => f.requiredForCompletion && f.status !== "complete")
    .map((f) => f.name);
  if (blockedBy.length === 0) {
    return { blocked: false, blockedBy: [], explain: "" };
  }
  return {
    blocked: true,
    blockedBy,
    // Names the forms, and says who can change the rule. A crew member hitting
    // this at 6pm should know instantly whether to finish the form or call the
    // office, rather than deciding the software is broken.
    explain: `This job needs ${blockedBy.join(" and ")} finished first. An owner or admin can turn this requirement off under Team & access.`,
  };
}
