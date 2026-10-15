-- ===========================================================================
-- SuperHeng — Supabase auth & subscription schema
-- ===========================================================================
--
-- HOW TO RUN
--   Supabase dashboard → SQL Editor → paste this file → Run.
--   Or from a shell:  psql "$DATABASE_URL" -f schema_profiles.sql
--
--   Run this AFTER `schema.sql` (that file owns `lottery_draws`; this one owns
--   the account/entitlement tables). Both are idempotent — running either twice
--   is safe and changes nothing.
--
-- WHY THIS FILE EXISTS SEPARATELY FROM schema.sql
--   `schema.sql` describes public draw data that anyone may read. This file
--   describes *who is allowed to see what*, which is a different trust domain —
--   it references `auth.users` and is the only place in the project that decides
--   an entitlement. Keeping the two apart means the entitlement rules can be read
--   and reviewed on their own, and a change here cannot accidentally alter the
--   ledger's shape.
--
-- THE ONE RULE THIS FILE ENFORCES
--   A user may read their own profile and change their display name. A user may
--   **not** grant themselves a subscription. Nothing in this file gives
--   `anon` or `authenticated` any way to write `subscription_tier`,
--   `subscription_expiry` or `subscription_provider`; those columns are written
--   only by server-side code holding a secret key (or by the dashboard), which is
--   exactly what the Stripe webhook uses: `backend/webhook.py` calls
--   `apply_payment_event` below with `SUPABASE_SERVICE_KEY`, never with a user's
--   token.
--
--   That distinction matters because it is not obvious from an RLS policy alone:
--   a policy says *which rows* a caller may touch, not *which columns*. The
--   column-level `grant update (display_name)` below is what actually stops a
--   user from pricing their own subscription at zero by POSTing to PostgREST.
--   Both controls are needed, and the verification queries at the bottom of this
--   file check both.

-- ---------------------------------------------------------------------------
-- Table: user_profiles
-- ---------------------------------------------------------------------------
-- One row per authenticated user, keyed by the same UUID as `auth.users`.
--
-- `on delete cascade` (not a soft delete) is deliberate: Supabase's own guidance
-- for a table that extends `auth.users` is to remove the profile with the user.
-- Note what that means for accounting — deleting a user deletes the record of
-- what they were entitled to. When a real payment gateway is integrated, the
-- payment/subscription ledger must be its own table that does NOT cascade, so
-- financial history survives a user deletion. This table is the *current* state,
-- not the ledger, and says so here rather than implying more.
--
-- `id` is NOT given a `default gen_random_uuid()`. It must equal the auth user's
-- id, so generating one here would invent a profile belonging to nobody.
create table if not exists public.user_profiles (
    id                    uuid        primary key references auth.users (id) on delete cascade,

    -- Copied from `auth.users` at signup by the trigger below, so the dashboard
    -- and the operator bootstrap query can find an account by address. It is a
    -- convenience copy: `auth.users.email` remains the source of truth and is what
    -- a login is checked against. It is refreshed on email change by the trigger.
    email                 text,

    -- User-editable. The only column in this table `authenticated` may write.
    display_name          text,

    -- The entitlement. 'free' is the default so a row created by the signup
    -- trigger — or by the backfill below — is immediately valid and needs no
    -- second statement to become consistent.
    subscription_tier     text        not null default 'free',

    -- When the current paid period ends.
    --
    -- TIMESTAMPTZ rather than DATE, for the same reason `schema.sql` uses it for
    -- `created_at`: a bare date or timestamp stores no offset, so the same stored
    -- value means a different instant to a reader in a different time zone, and
    -- "is this subscription still active" would depend on where the question was
    -- asked from. An entitlement check has to compare against one unambiguous
    -- instant, so the instant is what is stored.
    --
    -- NULL means **no expiry on record**, and is treated as ACTIVE by
    -- `auth.py` when the tier is 'premium'. That is the intended meaning for a
    -- manually granted or lifetime entitlement — the founder's own account, for
    -- instance. It is deliberately not treated as expired: a NULL that lapsed
    -- every subscription would make the operator bootstrap below silently fail.
    subscription_expiry   timestamptz,

    -- Which gateway sold this period ('omise', 'stripe', ...). NULL until one is
    -- wired in. Recorded now because a webhook has to be reconcilable against the
    -- row it updated, and adding the column later means backfilling rows whose
    -- provenance is already lost.
    subscription_provider text,

    -- The Stripe Customer this account pays as. NULL until the first completed
    -- purchase.
    --
    -- It exists to be *reused*: `checkout.py` reads it back at every later
    -- checkout and hands it to Stripe, so a returning customer's payments
    -- accumulate against one Customer object instead of a new one being minted
    -- per purchase. That reuse is why the partial unique index below exists — one
    -- Customer must map to at most one account.
    --
    -- Written only by `apply_payment_event`, from the verified session's
    -- `customer` field. Stripe does not return a customer unless the session asks
    -- for one: `customer_creation` defaults to 'if_required' in `payment` mode
    -- (changed from 'always' in API version 2022-08-01), which creates none and
    -- leaves `session.customer` null. A NULL here therefore means "no recorded
    -- purchase yet", not "the integration is broken".
    stripe_customer_id    text,

    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),

    -- Refuse a typo'd tier at write time. PostgreSQL booleans or an enum would
    -- also work; a check constraint is used to match `schema.sql`'s style and so
    -- that adding a third tier later is one statement, not a type migration.
    constraint user_profiles_known_tier
        check (subscription_tier in ('free', 'premium'))
);

-- ---------------------------------------------------------------------------
-- Migration — bring a table created before this shape up to it
-- ---------------------------------------------------------------------------
-- `create table if not exists` above does nothing to an existing table, so the
-- columns and the constraint are also applied here, idempotently. A fresh
-- database and an existing one both converge on the same shape, and a second run
-- changes nothing.
alter table public.user_profiles
    add column if not exists email                 text;
alter table public.user_profiles
    add column if not exists display_name          text;
alter table public.user_profiles
    add column if not exists subscription_tier     text not null default 'free';
alter table public.user_profiles
    add column if not exists subscription_expiry   timestamptz;
alter table public.user_profiles
    add column if not exists subscription_provider text;
alter table public.user_profiles
    add column if not exists stripe_customer_id     text;
alter table public.user_profiles
    add column if not exists created_at            timestamptz not null default now();
alter table public.user_profiles
    add column if not exists updated_at            timestamptz not null default now();

alter table public.user_profiles
    drop constraint if exists user_profiles_known_tier;
alter table public.user_profiles
    add constraint user_profiles_known_tier
        check (subscription_tier in ('free', 'premium'));

-- ---------------------------------------------------------------------------
-- One Stripe Customer per account
-- ---------------------------------------------------------------------------
-- Partial, because NULL is the normal state before a first purchase and many
-- rows may be NULL. What it prevents is the genuinely wrong shape: two accounts
-- sharing one Customer, which would make the reuse in `checkout.py` ambiguous
-- about *whose* payments a Customer object describes — and a Customer that two
-- accounts point at is a mis-billed charge waiting to be discovered.
create unique index if not exists user_profiles_stripe_customer_id_key
    on public.user_profiles (stripe_customer_id)
    where stripe_customer_id is not null;

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
-- Set by the database rather than by callers, so a row edited from the dashboard,
-- from a webhook, or by hand all record the same way. A caller-maintained
-- timestamp is the one that is wrong exactly when it matters (a webhook that
-- grants a tier and forgets the column).
create or replace function public.user_profiles_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists user_profiles_touch_updated_at on public.user_profiles;
create trigger user_profiles_touch_updated_at
    before update on public.user_profiles
    for each row
    execute procedure public.user_profiles_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Profile creation on signup
-- ---------------------------------------------------------------------------
-- `security definer` is required: the trigger runs as the `supabase_auth_admin`
-- role that GoTrue uses for `auth.users`, which has no privileges on
-- `public.user_profiles`. Without it the insert is refused and — because a
-- trigger that raises aborts the statement it is attached to — **the signup
-- itself fails**. That failure mode is why the two grants at the bottom of this
-- section exist and why the function is written to be unable to raise.
--
-- `set search_path = ''` is a hardening requirement for any `security definer`
-- function: it stops a caller from shadowing `user_profiles` with a same-named
-- object in a schema they control, which would otherwise run *their* code with
-- the definer's privileges. The cost is that every name inside must be
-- schema-qualified, which is why `public.` appears below.
--
-- `on conflict do nothing` makes the trigger safe to re-run. It matters because
-- this trigger is also recreated by this file on every run: a user created
-- between two runs is handled once by the trigger, and the backfill at the end of
-- the file will not then collide with them.
--
-- Only the id and the email are copied. Signup `raw_user_meta_data` is
-- caller-supplied and therefore untrusted: it must never be read into
-- `subscription_tier`, or a crafted signup request would set its own entitlement.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    insert into public.user_profiles (id, email)
    values (new.id, new.email)
    on conflict (id) do nothing;

    return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row
    execute procedure public.handle_new_user();

-- Keeps the copied address in step when a user changes their email. Without this
-- the copy silently drifts, and an operator looking the account up by address
-- finds a stale one.
create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.user_profiles
       set email = new.email
     where id = new.id;

    return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
    after update of email on auth.users
    for each row
    when (old.email is distinct from new.email)
    execute procedure public.handle_user_email_change();

-- ---------------------------------------------------------------------------
-- Backfill — an account created before this file existed has no profile row
-- ---------------------------------------------------------------------------
-- Without this, every account that already exists (including the operator's)
-- has no row, so its entitlement check reads a missing profile and is refused.
-- The trigger above only fires on *new* signups.
insert into public.user_profiles (id, email)
select u.id, u.email
  from auth.users u
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- Read and update are scoped to the caller's own row; insert and delete are
-- withheld entirely. Under RLS, a missing policy is a denial — so no INSERT
-- policy means a client cannot create its own profile row, which is correct
-- because the trigger owns row creation, and no DELETE policy means a client
-- cannot remove its entitlement record to force a re-grant.
--
-- `(select auth.uid())` is wrapped in a sub-select on purpose. PostgreSQL
-- evaluates a bare `auth.uid()` once per row under RLS; the sub-select form is
-- evaluated once for the whole statement and is what Supabase documents for
-- policies that run on every read. `auth.uid()` returns NULL for a request with
-- no valid token, and `NULL = id` is NULL — never true — so an unauthenticated
-- request matches no row rather than erroring. That is the desired fail-closed
-- behaviour.
alter table public.user_profiles enable row level security;

drop policy if exists "user_profiles_select_own" on public.user_profiles;
create policy "user_profiles_select_own"
    on public.user_profiles
    for select
    to authenticated
    using ((select auth.uid()) = id);

drop policy if exists "user_profiles_update_own" on public.user_profiles;
create policy "user_profiles_update_own"
    on public.user_profiles
    for update
    to authenticated
    using ((select auth.uid()) = id)
    with check ((select auth.uid()) = id);

-- ---------------------------------------------------------------------------
-- Privileges — which columns a signed-in caller may actually write
-- ---------------------------------------------------------------------------
-- Supabase grants broad privileges on new tables in `public` to `anon` and
-- `authenticated` by default, so this narrows them explicitly. A policy without
-- a matching grant is inert, and a grant without a policy is unrestricted: both
-- are needed, and getting only one right is the usual way this is misconfigured.
revoke all on table public.user_profiles from anon, authenticated;

-- The API reads this table with the *caller's own* access token (see
-- `backend/auth.py`), so the read grant is what the premium gate depends on. The
-- row is still filtered by the policy above, so this exposes nothing extra.
grant select on table public.user_profiles to authenticated;

-- Column-level on purpose. `grant update` on the table would let a signed-in
-- user PATCH `subscription_tier` — the RLS policy permits the row, so only the
-- grant stands in the way. Everything else (tier, expiry, provider, email,
-- timestamps) is writable only with a secret key, which is to say only by
-- server-side code.
grant update (display_name) on table public.user_profiles to authenticated;

-- `anon` (no token at all) gets nothing: it has no row to see.

-- ---------------------------------------------------------------------------
-- Operator bootstrap — granting a tier by hand
-- ---------------------------------------------------------------------------
-- Entitlements are written only by trusted code, and until the gateway exists
-- that means this. Run it from the dashboard's SQL editor, which connects with
-- privileges that bypass RLS.
--
--   update public.user_profiles
--      set subscription_tier     = 'premium',
--          subscription_expiry   = now() + interval '1 year',
--          subscription_provider = 'manual'
--    where email = 'you@example.com';
--
-- To revoke, set the tier back — do not delete the row, or the next login has no
-- profile to read:
--
--   update public.user_profiles
--      set subscription_tier   = 'free',
--          subscription_expiry = null
--    where email = 'you@example.com';

-- ---------------------------------------------------------------------------
-- Table: payment_events — the ledger of what each gateway told us
-- ---------------------------------------------------------------------------
-- One row per webhook delivery, the ledger `user_profiles` explicitly is not. It
-- is a different trust domain from the profile for three reasons:
--
--   * **It does not cascade.** `user_id` is `on delete set null`, not
--     `on delete cascade`. Deleting an account must not delete the record that
--     money was taken: a refund dispute, a revenue report or a VAT question all
--     arrive after the user is gone, and a cascade would have destroyed the only
--     evidence. The profile is *current state*; this table is *history*.
--   * **It is the idempotency mechanism, not a log of one.** `id` is the
--     gateway's own event id and the primary key. Inserting it is how a delivery
--     is claimed, so a Stripe retry — which Stripe performs for up to three days
--     in live mode, and may do more than once even when nothing failed — cannot
--     extend a subscription a second time. That only works because the key is
--     enforced by the database rather than by a set in a process that can restart.
--   * **No signed-in user may read it.** What an account has paid is not part of
--     the product's API, and the table gives a would-be attacker a map of who is
--     worth targeting. The grants at the bottom of this section remove it from
--     `anon` and `authenticated` entirely.
--
-- The primary key is **(provider, id)** rather than `id` alone: `evt_...` ids are
-- unique per gateway, not across gateways, and `subscription_provider` already
-- anticipates a second one. A single-column key would have to be migrated the day
-- Omise is added, after rows exist.
create table if not exists public.payment_events (
    provider      text        not null default 'stripe',
    id            text        not null,

    -- The gateway's event type ('checkout.session.completed', ...). Recorded so a
    -- row can be read without knowing the gateway's vocabulary at read time.
    event_type    text        not null,

    -- Nullable, and set to NULL rather than deleting the row when the account goes.
    user_id       uuid        references auth.users (id) on delete set null,

    session_id    text,
    plan_id       text,

    -- How long the entitlement was extended by, in days. NULL means this event
    -- granted nothing (see `result`), which is different from "zero days".
    period_days   integer,

    -- What was paid, in the currency's minor unit: 9900 is ฿99.00. BIGINT rather
    -- than INTEGER because a currency's minor unit is not bounded by 2^31 in
    -- general, and a column that is too small is a class of bug that surfaces
    -- once, in production, with real money.
    amount_minor  bigint,
    currency      text,

    -- Whether the gateway was in live mode. Kept so a test-mode payment that
    -- reached production can be recognised afterwards, which is otherwise
    -- indistinguishable from a real one in this table.
    livemode      boolean,

    -- What this event did, in one word:
    --   pending      claimed, grant in progress (never the final state)
    --   applied      the entitlement was written
    --   duplicate    already claimed; nothing was written this time
    --   unknown_user no profile row to update — the account was deleted
    --   recorded     deliberately granted nothing (unpaid, expired, unknown plan)
    result        text        not null default 'pending',

    -- The sentence the handler decided on, e.g. 'payment_status=\'unpaid\':
    -- recorded, not granted'. Free text on purpose: it exists to explain a row to
    -- a human reconciling payments, not to be parsed.
    note          text,

    received_at   timestamptz not null default now(),

    primary key (provider, id),

    constraint payment_events_known_result
        check (result in ('pending', 'applied', 'duplicate', 'unknown_user', 'recorded')),

    -- A period outside this band is not a period this product sells. The bound
    -- exists because `period_days` reaches `make_interval` below: an absurd value
    -- would be accepted and write an expiry centuries away, and 10 years exceeds
    -- any plan the catalogue can produce.
    constraint payment_events_sane_period
        check (period_days is null or (period_days >= 1 and period_days <= 3660))
);

-- Migration for a table created by an earlier run of this file.
alter table public.payment_events
    add column if not exists provider      text not null default 'stripe';
alter table public.payment_events
    add column if not exists event_type    text;
alter table public.payment_events
    add column if not exists user_id       uuid;
alter table public.payment_events
    add column if not exists session_id    text;
alter table public.payment_events
    add column if not exists plan_id       text;
alter table public.payment_events
    add column if not exists period_days   integer;
alter table public.payment_events
    add column if not exists amount_minor  bigint;
alter table public.payment_events
    add column if not exists currency      text;
alter table public.payment_events
    add column if not exists livemode      boolean;
alter table public.payment_events
    add column if not exists result        text not null default 'pending';
alter table public.payment_events
    add column if not exists note          text;
alter table public.payment_events
    add column if not exists received_at   timestamptz not null default now();

-- "Money came in for this account" is the query this table will actually be used
-- for, so it gets an index rather than a sequential scan over every payment.
create index if not exists payment_events_user_received_idx
    on public.payment_events (user_id, received_at desc);

-- ---------------------------------------------------------------------------
-- Function: apply_payment_event — record a delivery and grant, atomically
-- ---------------------------------------------------------------------------
-- THIS IS THE ONLY CODE THAT EVER WRITES `subscription_tier`.
--
-- Why a function rather than two PostgREST calls from `webhook.py`:
--
--   1. **Atomicity.** Claiming the event and extending the subscription must
--      succeed or fail together. Split across two requests, a crash between them
--      leaves an event claimed with no grant — the customer paid and has nothing,
--      and the retry is refused as a duplicate. Both statements live in one
--      function body, so one transaction covers both.
--   2. **The race.** Two deliveries of the same event arriving at once: the first
--      INSERT claims the key and the second blocks on it, then sees the conflict
--      and inserts nothing. `row_count` is 0, which is the duplicate answer. A
--      read-then-write in the application has a window between the read and the
--      write where both callers believe they are first, and both extend.
--   3. **One place to review the arithmetic.** The expiry computation sits next to
--      the columns it writes, where it can be read against the schema.
--
-- `p_period_days` is NULL to mean **record without granting**. That is how the
-- handler logs an event that arrived but entitles nobody to anything (a failed
-- payment, an expired session, a session naming a plan this build does not sell)
-- without a second entry point that could be called in a granting way by mistake.
--
-- `security invoker` (the default, and deliberately not overridden): the function
-- runs as whoever called it, so it needs the service key's own table privileges
-- and cannot be used to escalate. `set search_path = ''` is set anyway, so that if
-- it is ever changed to `security definer` it is already immune to a caller
-- shadowing `user_profiles` with an object of their own.
-- `create or replace` cannot change a function's signature: it would add a new
-- overload and leave the previous one live, still holding its `service_role`
-- grant. So the 10-argument form (without `p_stripe_customer_id`) is dropped
-- explicitly first. Its grants go with it, and the GRANT below re-establishes
-- them for the new signature only.
drop function if exists public.apply_payment_event(
    text, text, uuid, text, text, integer, bigint, text, boolean, text
);

create or replace function public.apply_payment_event(
    p_event_id           text,
    p_event_type         text,
    p_user_id            uuid,
    p_session_id         text,
    p_plan_id            text,
    p_period_days        integer,
    p_amount_minor       bigint,
    p_currency           text,
    p_livemode           boolean,
    p_note               text,
    -- Defaulted so the existing 10-argument call sites and the verification
    -- snippets below keep working unchanged, and so "no customer on this event"
    -- is expressed by omitting it rather than by sending NULL.
    p_stripe_customer_id text default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
    v_claimed integer;
    v_expiry  timestamptz;
    v_tier    text;
begin
    -- 1. Claim the delivery. This INSERT is the idempotency check; the primary
    --    key is what makes it one, and `do nothing` turns a redelivery into a
    --    no-op rather than an error the caller would have to classify.
    insert into public.payment_events (
        provider, id, event_type, user_id, session_id, plan_id,
        period_days, amount_minor, currency, livemode, result, note
    )
    values (
        'stripe', p_event_id, p_event_type, p_user_id, p_session_id, p_plan_id,
        p_period_days, p_amount_minor, p_currency, p_livemode,
        -- A granting call lands in 'pending' so a row can never claim 'applied'
        -- before the update that earns it has run.
        case when p_period_days is null then 'recorded' else 'pending' end,
        p_note
    )
    on conflict (provider, id) do nothing;

    get diagnostics v_claimed = row_count;

    if v_claimed = 0 then
        return jsonb_build_object('result', 'duplicate', 'event_id', p_event_id);
    end if;

    -- 2. Nothing to grant: the row IS the outcome.
    if p_period_days is null then
        return jsonb_build_object('result', 'recorded', 'event_id', p_event_id);
    end if;

    -- 3. Grant.
    --
    -- The period is added to the LATER of now and the current expiry, so a
    -- renewal grants a full period on top of time already paid for instead of
    -- discarding it. `now() + interval '30 days'` — the obvious version — is a
    -- silent refund of whatever remained, and it is the customer who loses.
    --
    -- The exception is a NULL expiry on an already-premium row, which the schema
    -- defines as an unbounded grant (a lifetime or manually issued entitlement).
    -- That is preserved rather than replaced: a customer with unlimited access who
    -- buys a month must not end up with 30 days.
    update public.user_profiles
       set subscription_tier     = 'premium',
           subscription_expiry   = case
               when subscription_tier = 'premium' and subscription_expiry is null then null
               else greatest(now(), coalesce(subscription_expiry, now()))
                    + make_interval(days => p_period_days)
           end,
           subscription_provider = 'stripe',
           -- `coalesce(new, existing)`, never a bare assignment: an event that
           -- carries no customer must not erase one already recorded. Stripe's
           -- `customer` field is populated per session, and a session that did not
           -- create or reuse a customer would otherwise blank a good id and send
           -- the next purchase back to creating a duplicate Customer.
           stripe_customer_id    = coalesce(p_stripe_customer_id, stripe_customer_id)
     where id = p_user_id
    returning subscription_expiry, subscription_tier into v_expiry, v_tier;

    if not found then
        -- No profile row: the account was deleted between the payment and this
        -- event. The money is real and the ledger keeps it; there is simply
        -- nothing to entitle, and saying so is better than a silent success.
        update public.payment_events
           set result = 'unknown_user'
         where provider = 'stripe' and id = p_event_id;

        return jsonb_build_object(
            'result', 'unknown_user',
            'event_id', p_event_id,
            'user_id', p_user_id
        );
    end if;

    update public.payment_events
       set result = 'applied'
     where provider = 'stripe' and id = p_event_id;

    return jsonb_build_object(
        'result', 'applied',
        'event_id', p_event_id,
        'user_id', p_user_id,
        'tier', v_tier,
        'expiry', v_expiry
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges for the ledger — and why the REVOKE is the security control
-- ---------------------------------------------------------------------------
-- PostgreSQL grants EXECUTE on a new function to PUBLIC by default, and
-- PostgREST exposes every function in the schema it serves. Without the first
-- REVOKE below, `apply_payment_event` would be callable by anyone holding the
-- app's *public* anon key at POST /rest/v1/rpc/apply_payment_event — a
-- grant-yourself-premium endpoint shipped to the internet.
--
-- That call would still fail today, and it is worth being precise about why,
-- because "it happens to fail" is not the same as "it is safe". The function is
-- `security invoker`, so the caller's own privileges apply: `authenticated` may
-- not write `subscription_tier` (the column-level grant above), and may not
-- insert into `payment_events` at all (the revoke below). Two independent
-- controls, either of which stops it. Remove the REVOKE and a single later change
-- — flipping the function to `security definer` to "fix" something — makes the
-- escalation real. Verification query 6 below checks the fence, not the luck.
revoke all on function public.apply_payment_event(
    text, text, uuid, text, text, integer, bigint, text, boolean, text, text
) from public, anon, authenticated;

grant execute on function public.apply_payment_event(
    text, text, uuid, text, text, integer, bigint, text, boolean, text, text
) to service_role;

-- The ledger is not readable or writable by a signed-in user, only by server-side
-- code holding a service key. Note this is broader than the profile's grants on
-- purpose: a profile exposes `display_name` to its owner, whereas there is no
-- column here a user has any business seeing.
revoke all on table public.payment_events from anon, authenticated;
grant select, insert, update on table public.payment_events to service_role;

comment on table  public.payment_events is 'Payment ledger: one row per gateway webhook delivery, keyed by (provider, event id). Doubles as the idempotency mechanism, so a retried delivery cannot grant twice. Does NOT cascade on user delete — financial history outlives the account.';
comment on column public.payment_events.id            is 'The gateway''s own event id. Part of the primary key, which is what makes a redelivery detectable.';
comment on column public.payment_events.user_id       is 'The credited account, taken from client_reference_id. ON DELETE SET NULL, not CASCADE: deleting a user must not delete the record of their payment.';
comment on column public.payment_events.period_days   is 'Days the entitlement was extended by; NULL means the event granted nothing (see result). Bounded by payment_events_sane_period.';
comment on column public.payment_events.amount_minor  is 'Amount in the currency''s minor unit (9900 = ฿99.00). BIGINT, and an integer — never a float.';
comment on column public.payment_events.livemode      is 'Whether the gateway was in live mode, so a test payment that reached production is recognisable afterwards.';
comment on column public.payment_events.result        is 'applied | duplicate | unknown_user | recorded | pending. What this delivery actually did.';
comment on column public.payment_events.note          is 'Human-readable reason for the result, for whoever reconciles payments later.';
comment on function public.apply_payment_event(text, text, uuid, text, text, integer, bigint, text, boolean, text, text) is 'The only code that writes subscription_tier. Claims the event id and extends the subscription in one transaction, so a retried webhook cannot grant twice. EXECUTE is revoked from PUBLIC/anon/authenticated and granted to service_role only.';

comment on table  public.user_profiles is 'One row per authenticated user (1:1 with auth.users). Current subscription state only — the payment history lives in public.payment_events, which deliberately does not cascade so it survives a user deletion.';
comment on column public.user_profiles.id                    is 'Same UUID as auth.users.id. Cascades on user delete; no default, because a generated id would describe a profile belonging to nobody.';
comment on column public.user_profiles.email                 is 'Copy of auth.users.email for operator lookup. auth.users remains the source of truth for login; the on_auth_user_email_updated trigger keeps this copy in step.';
comment on column public.user_profiles.display_name          is 'The only column authenticated may write, via the column-level grant on this table.';
comment on column public.user_profiles.subscription_tier     is 'Entitlement: free or premium. Never writable by anon/authenticated — see user_profiles_known_tier and the column-level grants.';
comment on column public.user_profiles.subscription_expiry   is 'End of the current paid period, UTC instant. NULL means no expiry is on record and is treated as ACTIVE while the tier is premium (a manual/lifetime grant).';
comment on column public.user_profiles.subscription_provider is 'Which gateway sold this period (omise, stripe, manual); NULL until one is wired in.';
comment on column public.user_profiles.stripe_customer_id    is 'The Stripe Customer this account pays as, reused at every later checkout so returns attach to one Customer. NULL until the first completed purchase. Unique when set, so two accounts cannot share a Customer.';
comment on column public.user_profiles.created_at            is 'Row insert time, set at signup by the on_auth_user_created trigger or by the backfill.';
comment on column public.user_profiles.updated_at            is 'Last write time, maintained by the user_profiles_touch_updated_at trigger rather than by callers.';

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
-- 1. Every auth user has a profile, and no profile describes a missing user.
--    Both counts must be 0:
--
--   select count(*) as users_without_profile
--   from   auth.users u
--   where  not exists (select 1 from public.user_profiles p where p.id = u.id);
--
--   select count(*) as profiles_without_user
--   from   public.user_profiles p
--   where  not exists (select 1 from auth.users u where u.id = p.id);
--
-- 2. The entitlement columns are writable ONLY by a secret key. Run this in a
--    browser console on the deployed app while signed in as an ordinary user
--    (paste the access token from a session); both statements must be refused,
--    the first with a permission error for the column:
--
--   -- must NOT change the tier; expect a 42501 privilege error
--   fetch('<SUPABASE_URL>/rest/v1/user_profiles?id=eq.<your-uid>', {
--     method: 'PATCH',
--     headers: { apikey: '<anon key>', Authorization: 'Bearer <access token>',
--                'Content-Type': 'application/json' },
--     body: JSON.stringify({ subscription_tier: 'premium' }),
--   })
--
--   -- must NOT return another user's row; expect []
--   fetch('<SUPABASE_URL>/rest/v1/user_profiles?id=eq.<another-uid>', {
--     headers: { apikey: '<anon key>', Authorization: 'Bearer <access token>' },
--   })
--
-- 3. Applying this file twice must change nothing. Run it a second time and
--    expect no error and no new rows:
--
--   select count(*) from public.user_profiles;
--
-- 4. There must be no insert or delete policy on this table:
--
--   select cmd, policyname
--   from   pg_policies
--   where  schemaname = 'public' and tablename = 'user_profiles'
--   order  by cmd;
--   -- expect exactly: SELECT user_profiles_select_own, UPDATE user_profiles_update_own
--
-- 5. The ledger must be invisible and untouchable to a signed-in user. Every
--    one of these must be `false`:
--
--   select has_table_privilege('authenticated', 'public.payment_events', 'select') as auth_can_read,
--          has_table_privilege('authenticated', 'public.payment_events', 'insert') as auth_can_insert,
--          has_table_privilege('anon',          'public.payment_events', 'select') as anon_can_read,
--          has_table_privilege('service_role',  'public.payment_events', 'insert') as service_can_insert;
--   -- expect: false, false, false, true
--
-- 6. **The one to run before going live.** `apply_payment_event` must not be
--    executable by anyone holding the app's public anon key. PostgreSQL grants
--    EXECUTE to PUBLIC on new functions, and PostgREST exposes every function in
--    the served schema, so a missing REVOKE is a self-service upgrade endpoint:
--
--   select has_function_privilege('anon',          'public.apply_payment_event(text, text, uuid, text, text, integer, bigint, text, boolean, text, text)', 'execute') as anon_can_call,
--          has_function_privilege('authenticated', 'public.apply_payment_event(text, text, uuid, text, text, integer, bigint, text, boolean, text, text)', 'execute') as auth_can_call,
--          has_function_privilege('service_role',  'public.apply_payment_event(text, text, uuid, text, text, integer, bigint, text, boolean, text, text)', 'execute') as service_can_call;
--   -- expect: false, false, true
--
--    And the same thing over HTTP, which is how it would actually be attacked.
--    Signed in as any ordinary user, this must NOT return `applied`:
--
--   fetch('<SUPABASE_URL>/rest/v1/rpc/apply_payment_event', {
--     method: 'POST',
--     headers: { apikey: '<anon key>', Authorization: 'Bearer <access token>',
--                'Content-Type': 'application/json' },
--     body: JSON.stringify({ p_event_id: 'evt_forged', p_event_type: 'checkout.session.completed',
--                            p_user_id: '<your-uid>', p_period_days: 3650 }),
--   })
--   -- expect a 403/401 or an error, and subscription_tier still 'free'
--
-- 7. Idempotency, proved rather than assumed. Run this from the SQL editor (which
--    bypasses RLS) against your own account, twice. The first call must apply and
--    the second must refuse:
--
--   select public.apply_payment_event(
--       'evt_verification_1', 'checkout.session.completed',
--       (select id from auth.users order by created_at limit 1),
--       'cs_test_verification', 'premium_monthly', 30, 9900, 'thb', false, 'verification');
--   -- expect {"result": "applied", "tier": "premium", "expiry": ...}
--
--   select public.apply_payment_event(
--       'evt_verification_1', 'checkout.session.completed',
--       (select id from auth.users order by created_at limit 1),
--       'cs_test_verification', 'premium_monthly', 30, 9900, 'thb', false, 'verification');
--   -- expect exactly {"result": "duplicate"} — and the expiry UNCHANGED from above
--
--   delete from public.payment_events where id = 'evt_verification_1';
--   -- then set your own tier back with the operator bootstrap above
--
-- 8. The ledger must survive a user deletion while the profile does not. With a
--    throwaway account that has a payment row, deleting the auth user must leave
--    the payment with a NULL user_id rather than removing it:
--
--   select count(*) from public.payment_events where user_id is null;
--   -- expect this to be non-zero after deleting a user who had paid
