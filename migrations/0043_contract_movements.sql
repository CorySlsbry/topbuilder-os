-- A job's contract price is a HISTORY, not a scalar.
--
-- ⛔ THE BUG THIS EXISTS TO FIX
-- `approveEstimate()` did `UPDATE jobs SET contract_cents = $2`. It OVERWRITES.
-- Approve a second estimate on the same job and the first contract value is
-- gone — no record it ever existed, no way to reconstruct it, and every number
-- downstream (WIP percent-complete, earned revenue, over/under-billing, the
-- CPA pack) silently re-bases onto the new figure.
--
-- Worse, it is reachable by the CUSTOMER: `portalApproveEstimate()` calls the
-- same function from `/api/public/portal/[token]` with aal1, no financials
-- wall, and no second factor. A homeowner clicking "approve" on a second
-- proposal could destroy the contract value of the first one.
--
-- `wip.ts:19` has said the intended semantics out loud the whole time —
-- "Contract price including APPROVED change orders only" — and
-- `money-core.test.ts` already contains a test named "approved change order
-- raises the contract and earned revenue" that bumps a pure input, because
-- nothing in the application could produce that bump. This migration makes
-- that test describe reality.
--
-- ── The model ─────────────────────────────────────────────────────────────
-- Every movement of the contract is an append-only row with a SIGNED delta:
-- the original award, then one per approved change order. `contract_cents`
-- becomes a cached SUM, and a trigger refuses to let it disagree.
--
-- Why keep the column at all rather than compute it: eleven call sites read
-- `jobs.contract_cents` (WIP, costing, snapshots, the CPA pack, three
-- screens), and a job's contract is read far more often than it moves. The
-- cache is the right trade — as long as it cannot rot, which is what the
-- trigger is for.

CREATE TABLE contract_movements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id       uuid NOT NULL,
  -- Per-job sequence. 1 is always the original award.
  seq          int NOT NULL CHECK (seq > 0),
  kind         text NOT NULL CHECK (kind IN ('award','change-order','correction')),
  -- SIGNED. A deductive change order is negative; that is the whole point of
  -- storing movements instead of a running total.
  delta_cents  bigint NOT NULL,
  reason       text NOT NULL DEFAULT '',
  -- What caused it, so a movement is always traceable to a document.
  estimate_id      uuid,
  change_order_id  uuid,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, job_id, seq),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs (tenant_id, id)
);
ALTER TABLE contract_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE contract_movements FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contract_movements
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
-- Append-only, like every other money table here: INSERT and SELECT only, and
-- the existing ledger trigger refuses UPDATE. A contract history that can be
-- edited is not a history.
GRANT SELECT, INSERT ON contract_movements TO app_user;
CREATE TRIGGER contract_movements_immutable
  BEFORE UPDATE OR DELETE ON contract_movements
  FOR EACH ROW EXECUTE FUNCTION app.forbid_ledger_change();
CREATE INDEX contract_movements_job_idx ON contract_movements (tenant_id, job_id, seq);

-- ── Backfill: every job that already has a contract gets its award ────────
-- Per-tenant GUC because FORCE RLS binds even the owner on Cloud SQL — the
-- law that has now cost this build four outages. An unscoped INSERT here
-- writes nothing and reports success.
DO $$
DECLARE t record; n int;
BEGIN
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.current_tenant', t.id::text, true);
    INSERT INTO contract_movements
      (tenant_id, job_id, seq, kind, delta_cents, reason, created_by, created_at)
    SELECT t.id, j.id, 1, 'award', j.contract_cents,
           'Original contract, recorded when the movement ledger was added',
           'migration:0043', j.created_at
      FROM jobs j
     WHERE j.contract_cents > 0
       AND NOT EXISTS (SELECT 1 FROM contract_movements m WHERE m.job_id = j.id);
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN RAISE NOTICE 'tenant %: % contract award(s) backfilled', t.id, n; END IF;
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);
END $$;

-- ── The tie-out ───────────────────────────────────────────────────────────
-- `jobs.contract_cents` may only be whatever the movements say it is.
--
-- The exemption is deliberate and is asserted by a test so nobody "tightens"
-- it later: a job with NO movements can still have its contract set directly.
-- That is how a job created with a contract on day one keeps working, and
-- inventing a movement for it would be inventing history nobody recorded.
CREATE OR REPLACE FUNCTION app.tie_out_contract() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
DECLARE v_sum bigint;
BEGIN
  IF NEW.contract_cents IS NOT DISTINCT FROM OLD.contract_cents THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(sum(delta_cents), 0) INTO v_sum
    FROM contract_movements WHERE job_id = NEW.id;
  IF NOT EXISTS (SELECT 1 FROM contract_movements WHERE job_id = NEW.id) THEN
    RETURN NEW;  -- no history yet; a direct set is still legitimate
  END IF;
  IF NEW.contract_cents <> v_sum THEN
    RAISE EXCEPTION
      'contract_cents (%) must equal the sum of contract_movements (%) for job %',
      NEW.contract_cents, v_sum, NEW.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER jobs_contract_ties_out
  BEFORE UPDATE OF contract_cents ON jobs
  FOR EACH ROW EXECUTE FUNCTION app.tie_out_contract();

COMMENT ON TABLE contract_movements IS
  'Append-only history of a job''s contract price: the original award plus one '
  'signed row per approved change order. jobs.contract_cents is a cached SUM '
  'of these, enforced by app.tie_out_contract(). See migration 0043 — before '
  'it, approving a second estimate silently destroyed the first contract, and '
  'a CUSTOMER could trigger that from the portal.';
