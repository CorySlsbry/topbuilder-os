// field-ops module — public port.
//
// Jobs are the central noun (retail | insurance-restoration | solar-financed),
// with light scheduling, the append-only job-cost ledger (posts to the GL in
// the SAME transaction), the one-screen-per-job read, receipt attachments,
// the recoverable-depreciation nudge, and the onboarding tax-profile wiring.
export {
  addAttachment,
  captureCost,
  createCustomer,
  createJob,
  DEFAULT_OWNER_ACCOUNTS,
  DEFAULT_POSTING_ACCOUNTS,
  FieldOpsError,
  getAttachment,
  getJobCustomerId,
  getJobScreen,
  listAttachments,
  listJobs,
  scheduleAppointment,
  setJobStatus,
  updateJob,
  upsertTaxProfile,
} from "./internal/store";
export type {
  AttachmentMeta,
  CaptureCostInput,
  JobListRow,
  JobScreen,
  JobStatus,
  JobType,
  NewCustomer,
  JobPatch,
  NewJob,
  TaxProfileInput,
} from "./internal/store";

// ------------------------------------------------------- the field board
// What the FIELD side looks at in the morning, and the counterpart to the
// owner's operating dashboard. PURE and money-free by construction: nothing in
// these shapes can hold a dollar amount, because the `field` wall exists to
// keep the ledger away from the crew and a screen that strips money in the
// browser has already put it on the wire.
export { buildFieldTasks, nothingToDo } from "./internal/field-board";
export type {
  FieldAppointment,
  FieldFacts,
  FieldIntake,
  FieldJob,
  FieldTask,
} from "./internal/field-board";

// Equipment: the units a shop maintains, per customer, with per-unit job
// history. Anchors service agreements; never deleted, only retired.
export {
  createEquipment,
  EQUIPMENT_KINDS,
  linkJobEquipment,
  listEquipment,
  updateEquipment,
} from "./internal/equipment";
export type { EquipmentInput, EquipmentKind, EquipmentRow } from "./internal/equipment";

// ------------------------------------------------------------- job forms
// Template-driven checklists and sign-offs. The template is edited as a whole
// ordered document (no per-item ordering race); a form is FILLED one item at a
// time (a roof with two bars must not lose a whole form to one failed save).
export {
  archiveTemplate,
  answerItem,
  attachForm,
  checkJobCompletionGate,
  completeForm,
  FormError,
  getFormSettings,
  listJobForms,
  listTemplates,
  reopenForm,
  saveTemplate,
  setFormSettings,
} from "./internal/forms/store";
export type {
  AnswerInput,
  FormSettings,
  JobFormRow,
  TemplateInput,
  TemplateItemInput,
  TemplateRow,
} from "./internal/forms/store";
export {
  completeness,
  explainCompleteness,
  isAnswered,
  jobCompletionGate,
} from "./internal/forms/completeness";
export type {
  Completeness,
  FormItemAnswer,
  FormItemKind,
  JobFormState,
  JobGateResult,
} from "./internal/forms/completeness";
