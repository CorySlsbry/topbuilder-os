-- 0056 — one definition of capacity, and revenue that recognises when it is earned.
--
-- Two fixes that have nothing in common except that both were reported by an
-- audit as "the same thing computed more than one way", which is the failure
-- mode this schema keeps producing.

-- ═════════════════════════════════════ 1. HOW LONG A JOB TAKES
--
-- ⛔ NOTHING IN THE PRODUCT KNEW. Capacity was counted in SLOTS: a window
-- held `max(1, activeWorkers)` jobs, so a 1-hour capacitor swap and an
-- 8-hour changeout consumed exactly the same capacity. A shop with three
-- techs was told it could take three changeouts before lunch.
--
-- And the public self-booking page was promising STRANGERS times against
-- that number.
--
-- Appointments already carry `starts_at` and `ends_at`, so the booked side
-- of the equation was always measurable in minutes — it was simply never
-- read that way. What was missing is how long the NEXT job will take, which
-- only exists at the moment somebody books it.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS estimated_minutes int
  CHECK (estimated_minutes IS NULL OR (estimated_minutes > 0 AND estimated_minutes <= 24 * 60));

-- What a self-booked visit is assumed to take, per shop. A booking from a
-- stranger has no job behind it yet, so this is the only honest number
-- available at that moment — and being a SETTING means a roofer whose
-- smallest call is half a day is not stuck with an HVAC default.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'booking_settings') THEN
    RAISE EXCEPTION 'booking_settings missing — 0044 must run first';
  END IF;
END $$;
ALTER TABLE booking_settings ADD COLUMN IF NOT EXISTS default_job_minutes int NOT NULL DEFAULT 120
  CHECK (default_job_minutes > 0 AND default_job_minutes <= 24 * 60);

-- The working day, per shop, so capacity is measured against hours somebody
-- actually works rather than against the two hardcoded half-day windows.
-- Defaults reproduce today's 08:00-12:00 / 13:00-17:00 exactly, so nothing
-- moves until a shop changes it.
ALTER TABLE booking_settings ADD COLUMN IF NOT EXISTS am_start_hour int NOT NULL DEFAULT 8
  CHECK (am_start_hour BETWEEN 0 AND 23);
ALTER TABLE booking_settings ADD COLUMN IF NOT EXISTS am_end_hour int NOT NULL DEFAULT 12
  CHECK (am_end_hour BETWEEN 1 AND 24);
ALTER TABLE booking_settings ADD COLUMN IF NOT EXISTS pm_start_hour int NOT NULL DEFAULT 13
  CHECK (pm_start_hour BETWEEN 0 AND 23);
ALTER TABLE booking_settings ADD COLUMN IF NOT EXISTS pm_end_hour int NOT NULL DEFAULT 17
  CHECK (pm_end_hour BETWEEN 1 AND 24);

-- ═════════════════════════════════════ 2. MEMBERSHIP REVENUE RECOGNITION
--
-- ⛔ THE DOCUMENTED POLICY WAS DEAD CODE. Four separate comment blocks say a
-- membership's deferred revenue releases per completed visit. `completeVisit`
-- implements it correctly. Nothing has ever called it from a screen — the
-- only caller in the whole repo is the endpoint sweep, which is exactly why
-- it stayed green.
--
-- So the fallback path is the entire system: `rolloverDue` dumps the whole
-- year in one entry dated the plan anniversary, whether or not a single
-- tune-up happened. Eleven monthly P&Ls understate service revenue and the
-- twelfth overstates it.

-- ── the un-skip problem ──────────────────────────────────────────────────
-- Rollover marks EVERY due-or-booked visit 'skipped' with no period
-- predicate, and `completeVisit` hard-refuses a skipped visit (409). So the
-- moment a real screen exists, every visit on every agreement that has ever
-- rolled over is un-completable, with no route back. A visit that was
-- skipped by the calendar rolling over is not the same fact as a visit the
-- customer declined, and conflating them is what makes it unrecoverable.
ALTER TABLE agreement_visits ADD COLUMN IF NOT EXISTS skipped_reason text
  CHECK (skipped_reason IS NULL OR skipped_reason IN ('period-rolled','declined','unreachable','other'));

-- Backfill: everything skipped so far was skipped by a rollover, because
-- that is the only code path that has ever set the status.
UPDATE agreement_visits SET skipped_reason = 'period-rolled'
 WHERE status = 'skipped' AND skipped_reason IS NULL;

-- ── the double-release backstop ──────────────────────────────────────────
-- Per-visit release and the rollover stub cannot currently overlap, but only
-- because of arithmetic inside one function. Nothing at the DATABASE level
-- stops the same visit's revenue being recognised twice — `journal_entries`
-- has no uniqueness on (source_type, source_id) at all.
--
-- One partial unique index makes it structural. Scoped to the two membership
-- source types on purpose: other source types legitimately post more than
-- once against the same subject (a job takes many cost entries).
CREATE UNIQUE INDEX IF NOT EXISTS je_agreement_visit_once
  ON journal_entries(tenant_id, source_id)
  WHERE source_type = 'agreement-visit' AND source_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS je_agreement_rollover_once
  ON journal_entries(tenant_id, source_id, occurred_on)
  WHERE source_type = 'agreement-rollover' AND source_id IS NOT NULL;

-- ── linking a visit to the job that satisfies it ─────────────────────────
-- `agreement_visits.job_id` has existed since 0037 and nothing writes it.
-- For a job-completion hook to drive visit completion it needs an index, and
-- it needs to be impossible for one job to satisfy two visits.
CREATE UNIQUE INDEX IF NOT EXISTS agreement_visits_job_uk
  ON agreement_visits(tenant_id, job_id)
  WHERE job_id IS NOT NULL;

-- ── the discount that was sold and never applied ─────────────────────────
-- Plans carry `discount_bps`, the UI prints "15% off repairs" on every card,
-- and the invoice charges full price — because `issueInvoice` has no
-- discount parameter and `memberDiscountBps` has no caller. Recording what
-- was actually given makes the concession auditable instead of invisible.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount_cents bigint NOT NULL DEFAULT 0
  CHECK (discount_cents >= 0);
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS discount_bps int NOT NULL DEFAULT 0
  CHECK (discount_bps BETWEEN 0 AND 10000);

-- ── proof ────────────────────────────────────────────────────────────────
DO $$
DECLARE n int;
BEGIN
  SELECT COUNT(*) INTO n FROM pg_indexes WHERE indexname = 'je_agreement_visit_once';
  IF n <> 1 THEN
    RAISE EXCEPTION 'the double-release backstop did not land';
  END IF;

  SELECT COUNT(*) INTO n FROM information_schema.columns
   WHERE table_name = 'booking_settings' AND column_name = 'default_job_minutes';
  IF n <> 1 THEN
    RAISE EXCEPTION 'booking_settings.default_job_minutes did not land';
  END IF;
  RAISE NOTICE 'capacity and rev-rec schema is in place';
END $$;
