-- The shared inbox — the front-of-house surface this system did not have.
--
-- Before this migration the product could TALK but never LISTEN. Texts were
-- outbound only (notify.ts). A Retell call collapsed into a one-line intake
-- `description` — no transcript, no recording, no voicemail. There was no
-- conversation anywhere, and no screen where a person types a message at all.
-- Every shop we are replacing (Housecall Pro especially) puts this screen at
-- the centre of the day, and the shops themselves live in it.
--
-- ── The model, and why it is shaped this way ───────────────────────────────
--
-- A CONVERSATION is one counterparty on one address — a phone number or an
-- email address. NOT one per channel: a customer who calls and then texts from
-- the same number is one human having one conversation, and splitting that
-- into an "SMS thread" and a "voice thread" is the thing office staff hate
-- most about the tools that do it. So the thread keys on the ADDRESS, and each
-- MESSAGE carries the medium it actually arrived on (sms / voice / email), plus
-- 'note' for something the office writes to itself and never sends.
--
-- A conversation may have NO customer. A stranger texting the shop's number is
-- the normal first contact, and forcing a customer record to exist before we
-- can store their message would lose messages. `customer_id` fills in the
-- moment the number matches (app.normalize_phone below) or a person links it.
--
-- ── Phone matching is a MIGRATION-LEVEL concern, not a JS concern ─────────
-- Inbound routing has to answer "whose number is this?" from a Twilio `To`
-- string against `comms_settings.sms_number`, and "which customer is this?"
-- from a `From` string against `customers.phone` — where the shop typed
-- "602-555-0134" and Twilio sends "+16025550134". If that normalization lives
-- only in TypeScript then the SQL that joins on it silently misses, so it is
-- an IMMUTABLE SQL function with matching indexes and the TS side agrees with
-- it (comms/internal/contact.ts, unit-tested against the same vectors).

-- ─────────────────────────────────────────────────── phone normalization
-- North-American-centric on purpose: this product sells to US trades shops.
-- Anything that isn't a recognisable NANP number keeps its digits with a '+'
-- so it still threads consistently rather than collapsing to one bucket.
CREATE OR REPLACE FUNCTION app.normalize_phone(p text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN p IS NULL OR btrim(p) = '' THEN ''
    WHEN length(regexp_replace(p, '\D', '', 'g')) = 10
      THEN '+1' || regexp_replace(p, '\D', '', 'g')
    WHEN length(regexp_replace(p, '\D', '', 'g')) = 11
         AND left(regexp_replace(p, '\D', '', 'g'), 1) = '1'
      THEN '+' || regexp_replace(p, '\D', '', 'g')
    WHEN regexp_replace(p, '\D', '', 'g') = '' THEN ''
    ELSE '+' || regexp_replace(p, '\D', '', 'g')
  END
$$;
REVOKE ALL ON FUNCTION app.normalize_phone(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.normalize_phone(text) TO app_user;

-- Customer-by-number is the hot path on every inbound message.
CREATE INDEX IF NOT EXISTS customers_phone_norm_idx
  ON customers (tenant_id, app.normalize_phone(phone))
  WHERE phone <> '';

-- ───────────────────────────────────────────────────────── conversations
CREATE TABLE conversations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- NULL = we don't know who this is yet. That is a normal, permanent state
  -- for a wrong number and a temporary one for a new customer.
  customer_id   uuid,
  contact_kind  text NOT NULL CHECK (contact_kind IN ('phone','email')),
  -- Normalized: +1XXXXXXXXXX for phones, lower-cased for email. The thread key.
  contact       text NOT NULL,
  -- Best known display name. From the customer record when linked, otherwise
  -- whatever the caller gave (Retell captures a name; SMS gives us nothing).
  contact_name  text NOT NULL DEFAULT '',
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  -- Membership user_id, or '' for unassigned. Deliberately NOT a FK: an
  -- offboarded person's threads must not cascade-delete or block their removal.
  assigned_to   text NOT NULL DEFAULT '',
  last_message_at timestamptz NOT NULL DEFAULT now(),
  last_inbound_at timestamptz,
  -- Unread INBOUND messages. The badge the office actually looks at.
  unread        int NOT NULL DEFAULT 0 CHECK (unread >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- One thread per person per address, forever. `ON CONFLICT` on this is what
  -- makes inbound routing idempotent under concurrent messages.
  UNIQUE (tenant_id, contact_kind, contact),
  FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id)
);
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversations
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON conversations TO app_user;
-- The inbox's default query: open threads, newest activity first.
CREATE INDEX conversations_inbox_idx
  ON conversations (tenant_id, status, last_message_at DESC);
CREATE INDEX conversations_customer_idx
  ON conversations (tenant_id, customer_id) WHERE customer_id IS NOT NULL;

-- ───────────────────────────────────────────────────────────── messages
CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('inbound','outbound')),
  channel         text NOT NULL CHECK (channel IN ('sms','voice','email','note')),
  body            text NOT NULL DEFAULT '',
  subject         text NOT NULL DEFAULT '',
  -- queued → sent | failed is the outbound lifecycle. It exists because the
  -- row is committed BEFORE the carrier call: if the process dies mid-send,
  -- the shop must still see that a message was attempted. A row that only
  -- appears after a successful send cannot record a failure at all.
  status          text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','queued','sent','failed','logged')),
  -- Why a send failed, in the operator's words. Empty on success.
  error           text NOT NULL DEFAULT '',
  -- Provider id (Twilio MessageSid, Retell call_id). The dedupe anchor: a
  -- retried webhook must land exactly one row.
  external_id     text NOT NULL DEFAULT '',
  -- Voice extras. A voicemail is a message whose body IS the transcript.
  recording_url   text NOT NULL DEFAULT '',
  duration_seconds int,
  -- Who pressed send. '' for inbound and for machine-logged rows.
  author_uid      text NOT NULL DEFAULT '',
  -- TRUE when the text was rewritten by the polish helper before sending.
  -- Recorded because "did a machine write this?" is a question a shop owner
  -- is entitled to answer about their own outbound messages.
  polished        boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
);
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON messages
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
-- No DELETE, and UPDATE only on the delivery outcome. A message log whose
-- BODY can be quietly edited is not a record of what was said — a correction
-- is a new message. But `queued → sent | failed` has to be writable, so the
-- grant is COLUMN-LEVEL rather than a blanket UPDATE. Postgres enforces that
-- for us; a comment would not.
GRANT SELECT, INSERT ON messages TO app_user;
GRANT UPDATE (status, error, external_id) ON messages TO app_user;
CREATE INDEX messages_thread_idx ON messages (tenant_id, conversation_id, created_at);
-- Webhook dedupe. Partial, because '' is the normal value for outbound rows
-- and internal notes and must not collide.
CREATE UNIQUE INDEX messages_external_idx
  ON messages (tenant_id, external_id) WHERE external_id <> '';

-- ─────────────────────────────────────────────────────────────── media
-- Customers text PHOTOS. In HVAC the picture of the rusted coil or the model
-- plate is often the whole message, and a webhook that stored the caption and
-- dropped the image would be losing the useful half.
--
-- Twilio's own media URLs require account credentials to fetch and expire, so
-- they are pulled into our storage at receipt and served back through an
-- authorized route — the same rule as job attachments: never a public URL.
CREATE TABLE message_media (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id   uuid NOT NULL,
  storage_key  text NOT NULL,
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  bytes        int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id)
);
ALTER TABLE message_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_media FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_media
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT ON message_media TO app_user;
CREATE INDEX message_media_msg_idx ON message_media (tenant_id, message_id);

-- ────────────────────────────────────────── inbound tenant resolution
-- Twilio posts to ONE webhook URL and tells us which of OUR numbers was
-- texted. Resolving that to a tenant happens BEFORE any session exists — the
-- same problem the directory tables already solve, and it has to be solved the
-- same way.
--
-- ⚠️ THE TRAP, caught by scripts/inbound-proof.mjs against a real database:
-- the obvious implementation reads comms_settings inside a SECURITY DEFINER
-- function. That looks right and returns NOTHING. SECURITY DEFINER runs as the
-- table's owner, and comms_settings is FORCE ROW LEVEL SECURITY — which is
-- precisely the setting that makes RLS bind the owner too. With no tenant GUC
-- (there is no session yet, that is the whole point) the policy matches zero
-- rows, the lookup returns NULL, and every inbound text is silently dropped as
-- "unknown number". A 200 to Twilio, nothing in the inbox, no error anywhere.
--
-- This is the same law the schema already encodes for `tenants` and
-- `memberships`: a table used to RESOLVE tenancy cannot be FORCE-scoped BY
-- tenancy. So the number→tenant map is its own directory table, ENABLE-only,
-- kept in step by a trigger.
--
-- It buys a correctness property comms_settings never had, too: the number is
-- the PRIMARY KEY, so two tenants cannot claim the same one — which would
-- otherwise route a shop's customers into a competitor's inbox.
CREATE TABLE tenant_sms_numbers (
  number     text PRIMARY KEY,   -- normalized (+1XXXXXXXXXX)
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- ENABLE, deliberately NOT FORCE — see above. The policy still scopes the APP
-- role; only the owner (migrations, and the definer function below) sees all.
ALTER TABLE tenant_sms_numbers ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_sms_numbers
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT ON tenant_sms_numbers TO app_user;

-- comms_settings stays the operator-facing record; this is its index.
CREATE OR REPLACE FUNCTION app.sync_tenant_sms_number() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $fn$
BEGIN
  DELETE FROM tenant_sms_numbers WHERE tenant_id = NEW.tenant_id;
  IF NEW.sms_number <> '' THEN
    INSERT INTO tenant_sms_numbers (number, tenant_id)
    VALUES (app.normalize_phone(NEW.sms_number), NEW.tenant_id)
    ON CONFLICT (number) DO UPDATE
      SET tenant_id = EXCLUDED.tenant_id, updated_at = now();
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER comms_settings_sms_number
  AFTER INSERT OR UPDATE OF sms_number ON comms_settings
  FOR EACH ROW EXECUTE FUNCTION app.sync_tenant_sms_number();

-- Backfill anything already configured.
INSERT INTO tenant_sms_numbers (number, tenant_id)
SELECT app.normalize_phone(sms_number), tenant_id
  FROM comms_settings WHERE sms_number <> ''
ON CONFLICT (number) DO NOTHING;

-- Returns ONLY an id, like app.tenant_id_by_slug. The argument space is phone
-- numbers we ourselves provisioned, so this is not a general "look up a tenant
-- by anything" oracle.
CREATE OR REPLACE FUNCTION app.tenant_id_by_sms_number(p_number text)
RETURNS uuid
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, app
AS $$
  SELECT tenant_id FROM tenant_sms_numbers
   WHERE number = app.normalize_phone(p_number)
$$;
REVOKE ALL ON FUNCTION app.tenant_id_by_sms_number(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_id_by_sms_number(text) TO app_user;

-- Retell posts a call_id and a phone number, not one of our numbers, so voice
-- keeps resolving by tenant slug (as it already does) — no new lookup needed.

-- ────────────────────────────────────────────── the polish helper's log
-- The FIRST large-language-model call in this system. Everything else here is
-- deterministic on purpose, so the one exception gets its own ledger: what was
-- asked for, how long, what it cost, and whether the numeric firewall had to
-- reject the rewrite. An owner can answer "how much is the AI costing me and
-- has it ever tried to change a number?" from one table.
CREATE TABLE assist_usage (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  uid           text NOT NULL,
  kind          text NOT NULL DEFAULT 'polish',
  model         text NOT NULL DEFAULT '',
  input_tokens  int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  -- 'ok' | 'figure_violation' (rewrite rejected) | 'error'
  outcome       text NOT NULL DEFAULT 'ok',
  detail        text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE assist_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE assist_usage FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assist_usage
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT ON assist_usage TO app_user;
CREATE INDEX assist_usage_day_idx ON assist_usage (tenant_id, created_at DESC);

-- ══════════════════════════════════════════════════════════ DEMO SEED
-- Desert Aire is the public demo tenant and the inbox is the screen a visitor
-- is most likely to open first, so it cannot be empty. These are the same
-- fictional customers already seeded (602-555-0134 etc.), having the
-- conversations a Phoenix HVAC shop actually has in August.
--
-- Per-tenant GUC inside the loop: on Cloud SQL `postgres` is NOT a true
-- superuser, so FORCE RLS binds even the table owner and an unscoped INSERT
-- here silently writes nothing (learned the hard way in 0034 and 0037).
DO $$
DECLARE
  v_tenant uuid;
  v_conv   uuid;
  v_cust   uuid;
  v_msg    uuid;
BEGIN
  SELECT id INTO v_tenant FROM tenants WHERE slug = 'desert-aire';
  IF v_tenant IS NULL THEN
    RAISE NOTICE 'desert-aire not present; inbox demo seed skipped';
    RETURN;
  END IF;
  PERFORM set_config('app.current_tenant', v_tenant::text, true);

  -- The shop's own number. Without a comms_settings row the demo has no
  -- sender at all, and this row was outstanding anyway.
  INSERT INTO comms_settings (tenant_id, sms_number, sms_status, google_review_url)
  VALUES (v_tenant, '+16025550100', 'none',
          'https://g.page/r/desert-aire-mechanical/review')
  ON CONFLICT (tenant_id) DO NOTHING;

  -- ── Ruth Delgado: the AC-is-dead text, already handled ────────────────
  SELECT id INTO v_cust FROM customers
   WHERE tenant_id = v_tenant AND app.normalize_phone(phone) = '+16025550134'
   LIMIT 1;
  INSERT INTO conversations
    (tenant_id, customer_id, contact_kind, contact, contact_name, status,
     last_message_at, last_inbound_at, unread)
  VALUES (v_tenant, v_cust, 'phone', '+16025550134', 'Ruth Delgado', 'open',
          now() - interval '2 hours', now() - interval '2 hours', 1)
  ON CONFLICT (tenant_id, contact_kind, contact) DO NOTHING
  RETURNING id INTO v_conv;
  IF v_conv IS NOT NULL THEN
    INSERT INTO messages (tenant_id, conversation_id, direction, channel, body, status, created_at)
    VALUES
      (v_tenant, v_conv, 'inbound', 'sms',
       'Hi, the AC quit sometime last night. House is 92 inside and I have my mom staying with me. Any chance someone can come today?',
       'received', now() - interval '9 hours'),
      (v_tenant, v_conv, 'outbound', 'sms',
       'Ruth - got you on the board for this afternoon between 1 and 5. Miguel will text when he is on the way. Keep the blinds closed on the west side until then, it helps more than you would think.',
       'sent', now() - interval '8 hours'),
      (v_tenant, v_conv, 'inbound', 'sms',
       'Thank you!! You are lifesavers.',
       'received', now() - interval '8 hours'),
      (v_tenant, v_conv, 'inbound', 'sms',
       'Quick question, the invoice says recoverable depreciation - is that something my home warranty pays or do I?',
       'received', now() - interval '2 hours');
  END IF;
  v_conv := NULL;

  -- ── Gary Pearce: a replacement quote going cold ───────────────────────
  SELECT id INTO v_cust FROM customers
   WHERE tenant_id = v_tenant AND app.normalize_phone(phone) = '+14805550171'
   LIMIT 1;
  INSERT INTO conversations
    (tenant_id, customer_id, contact_kind, contact, contact_name, status,
     last_message_at, last_inbound_at, unread)
  VALUES (v_tenant, v_cust, 'phone', '+14805550171', 'Gary Pearce', 'open',
          now() - interval '1 day', now() - interval '1 day', 1)
  ON CONFLICT (tenant_id, contact_kind, contact) DO NOTHING
  RETURNING id INTO v_conv;
  IF v_conv IS NOT NULL THEN
    INSERT INTO messages (tenant_id, conversation_id, direction, channel, body, status, created_at)
    VALUES
      (v_tenant, v_conv, 'outbound', 'sms',
       'Gary - proposal for the furnace changeout is in your portal, three options. Happy to walk through the differences whenever.',
       'sent', now() - interval '4 days'),
      (v_tenant, v_conv, 'inbound', 'sms',
       'Looking at it now. The middle one - does that price include hauling the old one off?',
       'received', now() - interval '1 day');
    -- An internal note: the thing a shop scribbles on a sticky note today.
    INSERT INTO messages (tenant_id, conversation_id, direction, channel, body, status, created_at)
    VALUES (v_tenant, v_conv, 'outbound', 'note',
       'Sal: yes, haul-off is in all three. Also mentioned his sister in Gilbert needs a tune-up.',
       'logged', now() - interval '20 hours');
  END IF;
  v_conv := NULL;

  -- ── Amy Chow: a voicemail with a transcript (the Retell shape) ────────
  SELECT id INTO v_cust FROM customers
   WHERE tenant_id = v_tenant AND app.normalize_phone(phone) = '+16025550148'
   LIMIT 1;
  INSERT INTO conversations
    (tenant_id, customer_id, contact_kind, contact, contact_name, status,
     last_message_at, last_inbound_at, unread)
  VALUES (v_tenant, v_cust, 'phone', '+16025550148', 'Amy Chow', 'open',
          now() - interval '5 hours', now() - interval '5 hours', 1)
  ON CONFLICT (tenant_id, contact_kind, contact) DO NOTHING
  RETURNING id INTO v_conv;
  IF v_conv IS NOT NULL THEN
    INSERT INTO messages
      (tenant_id, conversation_id, direction, channel, body, status,
       duration_seconds, created_at)
    VALUES (v_tenant, v_conv, 'inbound', 'voice',
       'Hi, this is Amy Chow, I am on the Comfort Club. My fall tune-up - I think it is due? Nobody has called me. Also the upstairs unit is making a rattling noise when it kicks on. Call me back at this number, thanks.',
       'received', 34, now() - interval '5 hours');
  END IF;
  v_conv := NULL;

  -- ── An unknown number: the normal shape of a first contact ────────────
  INSERT INTO conversations
    (tenant_id, customer_id, contact_kind, contact, contact_name, status,
     last_message_at, last_inbound_at, unread)
  VALUES (v_tenant, NULL, 'phone', '+16235550119', '', 'open',
          now() - interval '40 minutes', now() - interval '40 minutes', 1)
  ON CONFLICT (tenant_id, contact_kind, contact) DO NOTHING
  RETURNING id INTO v_conv;
  IF v_conv IS NOT NULL THEN
    INSERT INTO messages (tenant_id, conversation_id, direction, channel, body, status, created_at)
    VALUES (v_tenant, v_conv, 'inbound', 'sms',
       'Do you all service Trane rooftop units? Got your number from Ruth down the street.',
       'received', now() - interval '40 minutes');
  END IF;

  PERFORM set_config('app.current_tenant', '', true);
  RAISE NOTICE 'desert-aire inbox seeded';
END $$;

COMMENT ON TABLE conversations IS
  'One thread per counterparty ADDRESS (phone or email), not per channel — a '
  'customer who calls and then texts from the same number is one conversation.';
COMMENT ON TABLE messages IS
  'Append-only. No UPDATE or DELETE is granted: a message log that can be '
  'edited is not a record of what was said. A correction is a new message.';
