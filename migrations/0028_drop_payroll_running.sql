-- Payroll leaves the system (Cory 2026-07-26).
--
-- Salisbury Bookkeeping is already an ADP partner and ADP handles certified
-- payroll, so running payroll here would duplicate a system the customer
-- already trusts with their filings — and take on the liability that comes
-- with it (multi-state withholding, penalties, Davis-Bacon certification).
--
-- What we keep is the part nobody else has: burdened labor attributed to the
-- JOB. Hours still post at wage + payroll taxes + workers' comp by class +
-- overtime past 40, because that is what makes "what did this job make me" an
-- honest number. The accrual clears when ADP's bank debit is reconciled, which
-- is the path that already exists.
--
-- Dropped here rather than left dangling: an unused table still appears in
-- "download everything", still needs an RLS policy reviewed, and still invites
-- someone to wire it back up by accident.

-- Certified payroll (added earlier today, 0027) — ADP produces WH-347.
DROP TABLE IF EXISTS certified_payrolls;

ALTER TABLE jobs
  DROP COLUMN IF EXISTS prevailing_wage,
  DROP COLUMN IF EXISTS contract_number,
  DROP COLUMN IF EXISTS project_location;

ALTER TABLE workers
  DROP COLUMN IF EXISTS identifying_number,
  DROP COLUMN IF EXISTS address;

-- The payroll RUN ledger. Nothing writes it now; the accrual is cleared
-- through bank reconciliation instead.
DROP TRIGGER IF EXISTS payroll_runs_immutable ON payroll_runs;
DROP TABLE IF EXISTS payroll_runs;
