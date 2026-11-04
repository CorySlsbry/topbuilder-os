-- 0016: dispatch — appointments get a worker assignment.
--
-- The board is appointments × workers × days. Assignment carries no money,
-- so the Dispatcher agent's dispatch.assign kind is the first NON-HITL,
-- UNDOABLE kind: auto mode may execute it, and undo simply unassigns.

ALTER TABLE appointments
  ADD COLUMN worker_id uuid,
  ADD CONSTRAINT appointments_worker_fk
    FOREIGN KEY (tenant_id, worker_id) REFERENCES workers (tenant_id, id);

CREATE INDEX appointments_board ON appointments (tenant_id, starts_at);
