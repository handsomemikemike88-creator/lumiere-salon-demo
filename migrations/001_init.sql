-- Lumiere salon app v4: initial PostgreSQL schema.
create sequence staff_seq; create sequence customer_seq; create sequence lead_seq; create sequence booking_seq; create sequence reminder_seq; create sequence payment_seq;

create table services (
  id text primary key, name text not null, kind text not null check (kind in ('trial','single','package')),
  price_hkd integer not null check (price_hkd in (0, 288, 688, 8800)), active boolean not null default true, sort integer not null default 0
);

create table staff (
  id text primary key default ('S' || lpad(nextval('staff_seq')::text, 4, '0')),
  name text not null, email text not null unique check (email = lower(email)),
  pw_hash text not null, role text not null default 'staff' check (role in ('admin','staff')),
  status text not null default 'pending' check (status in ('pending','active','disabled')),
  failed_logins integer not null default 0, locked_until timestamptz, last_login_at timestamptz,
  pw_changed_at timestamptz not null default now(), invited_by text, created_at timestamptz not null default now()
);

create table customers (
  id text primary key default ('C' || lpad(nextval('customer_seq')::text, 4, '0')),
  name text not null, email text unique check (email is null or email = lower(email)), phone text unique,
  pw_hash text, failed_logins integer not null default 0, locked_until timestamptz,
  consent_at timestamptz, pw_changed_at timestamptz not null default now(), created_at timestamptz not null default now(), anonymised_at timestamptz
);

create table sessions (
  id bigserial primary key, token_hash text not null unique, kind text not null check (kind in ('staff','customer')),
  user_id text not null, created_at timestamptz not null default now(), last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null, ip_tag text, revoked_at timestamptz
);
create index sessions_user_idx on sessions(kind, user_id);
create index sessions_expiry_idx on sessions(expires_at);

create table invitations (
  id text primary key, email text not null check (email = lower(email)), role text not null default 'staff' check (role in ('staff')),
  token_hash text not null unique, created_by text not null, created_at timestamptz not null default now(),
  expires_at timestamptz not null, used_at timestamptz, used_by text, revoked_at timestamptz
);
create index invitations_email_idx on invitations(email);

create table password_resets (
  id bigserial primary key, kind text not null check (kind in ('staff','customer')), user_id text not null,
  token_hash text not null unique, created_at timestamptz not null default now(), expires_at timestamptz not null, used_at timestamptz
);
create index password_resets_user_idx on password_resets(kind, user_id);

create table leads (
  id text primary key default ('L' || lpad(nextval('lead_seq')::text, 4, '0')),
  name text not null, phone text not null, email text, source text not null default 'website',
  service_id text not null references services(id), price_hkd integer not null,
  stage text not null default 'New Trial Lead' check (stage in ('New Trial Lead','Reminder Sent','Confirmed','Attended','Package Consultation','Package Sold','Lost')),
  consent_pics boolean not null default false, consent_at timestamptz,
  marketing_opt_in boolean not null default false, marketing_at timestamptz,
  customer_id text references customers(id) on delete set null,
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','paid','refunded')),
  is_sample boolean not null default false, sample_sale boolean not null default false,
  anonymised_at timestamptz, created_at timestamptz not null default now()
);
create index leads_stage_idx on leads(stage);
create index leads_phone_idx on leads(phone);
create index leads_email_idx on leads(email);
create index leads_customer_idx on leads(customer_id);
create index leads_created_idx on leads(created_at desc);

create table lead_notes (
  id bigserial primary key, lead_id text not null references leads(id) on delete cascade,
  at timestamptz not null default now(), by_name text not null, text text not null
);
create index lead_notes_lead_idx on lead_notes(lead_id);

create table lead_history (
  id bigserial primary key, lead_id text not null references leads(id) on delete cascade,
  kind text not null default 'stage' check (kind in ('stage','payment')),
  from_stage text, to_stage text, at timestamptz not null default now(), by_name text not null default '系統', why text not null default '', payload jsonb
);
create index lead_history_lead_idx on lead_history(lead_id);
create index lead_history_to_idx on lead_history(to_stage);

create table bookings (
  id text primary key default ('BK' || lpad(nextval('booking_seq')::text, 4, '0')),
  lead_id text not null references leads(id) on delete cascade, service_id text not null references services(id), price_hkd integer not null,
  date date not null, time text not null check (time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  status text not null default 'booked' check (status in ('booked','attended','no-show','cancelled')),
  manage_token_hash text, created_at timestamptz not null default now()
);
create index bookings_slot_idx on bookings(date, time);
create index bookings_lead_idx on bookings(lead_id);
create index bookings_status_idx on bookings(status);

create table slot_caps (date date not null, time text not null, capacity integer not null check (capacity between 0 and 20), primary key (date, time));

create table reminders (
  id text primary key default ('R' || lpad(nextval('reminder_seq')::text, 4, '0')),
  booking_id text not null references bookings(id) on delete cascade,
  kind text not null check (kind in ('confirmation','day-before','same-day')),
  state text not null default 'pending' check (state in ('pending','drafted','sent','failed')),
  scheduled_for timestamptz not null, void boolean not null default false,
  draft_whatsapp text, draft_email_subject text, draft_email_body text,
  sent_via text, sent_by text, sent_at timestamptz,
  approved_by text, approved_at timestamptz,
  delivery_channel text, delivery_status text, delivery_provider text, delivery_message_id text, delivery_error text, delivery_updated_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (booking_id, kind)
);
create index reminders_state_idx on reminders(state, scheduled_for);

create table reminder_deliveries (
  id bigserial primary key, reminder_id text not null references reminders(id) on delete cascade, channel text not null,
  provider text not null, status text not null, provider_message_id text, error text, dry_run boolean not null default false, created_by text,
  created_at timestamptz not null default now()
);
create index reminder_deliveries_idx on reminder_deliveries(reminder_id);

-- Unsubscribe / suppression list. Only a SHA-256 of the normalised address is stored.
create table suppression_list (
  id bigserial primary key, channel text not null check (channel in ('email','whatsapp','all')), address_hash text not null,
  reason text not null default 'unsubscribe', created_by text, created_at timestamptz not null default now(),
  unique (channel, address_hash)
);

create table payments (
  id text primary key default ('P' || lpad(nextval('payment_seq')::text, 4, '0')),
  lead_id text not null references leads(id) on delete cascade, booking_id text references bookings(id) on delete set null,
  session_id text not null unique, payment_intent_id text,
  status text not null check (status in ('pending','paid','failed','expired','refunded')),
  amount_minor integer not null, currency text not null, livemode boolean not null,
  checkout_url text, expires_at timestamptz, created_by text, verified_via text,
  last_error text, last_rejection jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  paid_at timestamptz, failed_at timestamptz, expired_at timestamptz, refunded_at timestamptz
);
create index payments_lead_idx on payments(lead_id);
create index payments_pi_idx on payments(payment_intent_id);
create unique index payments_one_pending on payments(lead_id) where status = 'pending';
create unique index payments_one_paid on payments(lead_id) where status = 'paid';

-- Stripe webhook idempotency: an event id is processed at most once.
create table processed_events (event_id text primary key, type text not null, processed_at timestamptz not null default now(), result text);

create table audit_log (
  id bigserial primary key, at timestamptz not null default now(), actor_kind text not null, actor_id text, actor_name text,
  action text not null, target_type text, target_id text, detail jsonb, ip_tag text
);
create index audit_at_idx on audit_log(at desc);
create index audit_action_idx on audit_log(action);

create table settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now(), updated_by text);
