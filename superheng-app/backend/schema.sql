-- ===========================================================================
-- SuperHeng — Supabase (PostgreSQL) schema · Day 2
-- ===========================================================================
--
-- HOW TO RUN
--   Supabase dashboard → SQL Editor → paste this file → Run.
--   Or from a shell:  psql "$SUPABASE_DB_URL" -f schema.sql
--
-- This file is IDEMPOTENT: running it twice is safe and creates nothing twice.
--
-- DESIGN NOTE — why `(lottery_type, draw_date)` is UNIQUE, not `draw_date`
--   The natural key of a draw is the country it belongs to **and** its date. A
--   bare `draw_date` key cannot hold two ledgers: Laos and Vietnam (Hanoi) draw
--   on the same calendar dates as Thailand, so a date-only key would make one
--   country's insert overwrite another's row, and the premium per-country
--   analysis would then train on a mixture of two lotteries.
--
--   The pair is also the conflict target the ingestion engine upserts on. If it
--   were not UNIQUE, PostgREST's `on_conflict=lottery_type,draw_date` would fail
--   with 42P10, so the scraper and this index are a matched pair. Do not drop the
--   index without changing scraper.py's `CONFLICT_TARGET`.
--
--   Checked against the dated Lao archive before relying on it: Kapook lists one
--   result per draw date (1, 2, 5, 6, 7, 8, 9, 12 and 13 Oct 2026, Mon-Fri, no
--   date twice), so one row per (lottery_type, draw_date) describes the Lao ledger
--   as published today. If a second daily draw (a morning and an evening slot)
--   ever appears, this key cannot hold both and a `draw_slot` column has to join
--   it — the ingestion script upserts on this pair, so such a change is a schema
--   change, not a config tweak.

-- ---------------------------------------------------------------------------
-- Table: lottery_draws
-- ---------------------------------------------------------------------------
-- `id` defaults to gen_random_uuid(), which is built into PostgreSQL 13+.
-- Supabase runs PostgreSQL 15+, so no pgcrypto extension is required.
--
-- One deliberate deviation from the Day 2 spec: `created_at` is TIMESTAMPTZ
-- rather than TIMESTAMP. A bare TIMESTAMP stores no offset, so the same row
-- renders as a different instant depending on the reader's session zone. The
-- draw dates here are Thailand-local, so an unambiguous instant matters.
create table if not exists public.lottery_draws (
    id           uuid        primary key default gen_random_uuid(),
    -- Which country's lottery this row belongs to. Existing rows are Thai by
    -- definition, so the default backfills them correctly.
    lottery_type varchar(16) not null default 'thai',
    draw_date    date        not null,
    first_prize  varchar(6)  not null,
    bottom_two   varchar(2)  not null,
    created_at   timestamptz not null default now(),

    -- Prize numbers are stored as zero-padded strings ("001973"), never as
    -- integers, which would lose the leading zeros. These constraints refuse
    -- anything that is not exactly the right shape, so a parser bug or a
    -- partner's format change fails at write time instead of silently
    -- poisoning the historical ledger.
    --
    -- `first_prize` is 5 or 6 digits because the ledgers differ: Thailand's
    -- รางวัลที่ 1 and Laos's first prize are six digits, Vietnam's giải đặc biệt is
    -- five. It is NOT padded to six — a padding zero would be published by the
    -- premium model as a position with a 100% posterior. `lottery_type` says which
    -- length to expect; the check is the looser of the two so the row is still
    -- refused when it is neither.
    constraint lottery_draws_first_prize_is_5_or_6_digits
        check (first_prize ~ '^[0-9]{5,6}$'),
    constraint lottery_draws_bottom_two_is_2_digits
        check (bottom_two ~ '^[0-9]{2}$')
);

-- ---------------------------------------------------------------------------
-- Migration — bring a ledger created before this shape up to it
-- ---------------------------------------------------------------------------
-- `create table if not exists` above does nothing to an existing table, so the
-- column, the key and the constraints are also applied here, idempotently.
-- Running this file on a fresh database and on the live one both converge on the
-- same shape, and running it twice changes nothing.
--
-- The one statement to reach for when applying this to the live database by hand
-- is the two-column block below (`lottery_type` + the unique index); the rest is
-- idempotent housekeeping that this file performs on every run.
alter table public.lottery_draws
    add column if not exists lottery_type varchar(16) not null default 'thai';

-- The original table had `draw_date` UNIQUE, which PostgreSQL names
-- `lottery_draws_draw_date_key`. Drop it, or every non-Thai draw would collide
-- with the Thai draw on the same date.
alter table public.lottery_draws
    drop constraint if exists lottery_draws_draw_date_key;

-- A unique *index* rather than a constraint: it is what PostgREST matches an
-- `on_conflict=lottery_type,draw_date` upsert against, and it is created here for
-- both the fresh and the migrated path in one statement.
create unique index if not exists lottery_draws_type_date_key
    on public.lottery_draws (lottery_type, draw_date);

-- Widen `first_prize` for the five-digit ledgers (Vietnam's giải đặc biệt). The
-- original table only ever saw six-digit Thai prizes, so the old constraint has to
-- go before the replacement can exist — a table may hold both at once on a
-- half-applied run, and the loose check is what makes that run still safe.
alter table public.lottery_draws
    drop constraint if exists lottery_draws_first_prize_is_6_digits;
alter table public.lottery_draws
    drop constraint if exists lottery_draws_first_prize_is_5_or_6_digits;
alter table public.lottery_draws
    add constraint lottery_draws_first_prize_is_5_or_6_digits
        check (first_prize ~ '^[0-9]{5,6}$');

-- Refuse a typo'd or unplanned lottery at write time. A new country means a new
-- value here, deliberately, rather than a new string appearing in the ledger.
alter table public.lottery_draws
    drop constraint if exists lottery_draws_known_type;
alter table public.lottery_draws
    add constraint lottery_draws_known_type
        check (lottery_type in ('thai', 'laos', 'vietnam'));

comment on table  public.lottery_draws                 is 'Official lottery draw results, one ledger per country. One row per (lottery_type, draw_date); immutable history, upserted on that pair.';
comment on column public.lottery_draws.lottery_type    is 'Which lottery this row belongs to: thai (GLO 1st/16th, the default), laos (Lao Development Lottery, Mon-Fri), or vietnam (the northern XSMB draw, daily). See lottery_draws_known_type.';
comment on column public.lottery_draws.draw_date       is 'Draw date in the lottery''s local calendar, ISO-8601. Half of the natural key; the upsert conflict target is (lottery_type, draw_date).';
comment on column public.lottery_draws.first_prize is 'The lottery''s top prize, zero-padded: รางวัลที่ 1 (thai) and the Lao first prize are 6 digits; Vietnam''s giải đặc biệt is 5. Never left-padded to a common width — see lottery_draws_first_prize_is_5_or_6_digits.';
comment on column public.lottery_draws.bottom_two  is 'The published 2-digit prize, exactly 2 digits. For thai this is เลขท้าย 2 ตัว, SEPARATELY DRAWN and not the tail of the first prize. For laos and vietnam the source publishes only the tail (ຫວຍພັດທະນາ''s เลขท้าย 2 ตัว, Vietnam''s đề), so this column holds a DERIVED tail there and the ingestion script says so per source.';
comment on column public.lottery_draws.created_at  is 'Row insert time. Note: an upsert of an existing draw_date updates the prizes but leaves created_at at its original value.';

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
-- Read is public (the app needs the ledger); write is not.
--
-- There is deliberately NO insert/update/delete policy. Under RLS that means
-- the `anon` and `authenticated` keys cannot write: requests fail closed with
-- a 42501 permission error. Only the `service_role` key — used by
-- server-side ingestion and never shipped to the client — can write, because
-- it bypasses RLS by design.
--
-- This is the correct default. If you ever add a client-side write path, add
-- a narrow policy for it rather than loosening this one.
alter table public.lottery_draws enable row level security;

drop policy if exists "lottery_draws_public_read" on public.lottery_draws;
create policy "lottery_draws_public_read"
    on public.lottery_draws
    for select
    to anon, authenticated
    using (true);

-- ---------------------------------------------------------------------------
-- Verification
-- ---------------------------------------------------------------------------
-- After the ingestion scripts have run, this should report a non-zero count and
-- the digit width each ledger is actually stored at — 6 for thai and laos, 5 for
-- vietnam. A wrong width here means the scraper wrote the wrong prize:
--
--   select lottery_type,
--          count(*)                     as draws,
--          min(draw_date)               as oldest,
--          max(draw_date)               as newest,
--          min(length(first_prize))     as min_digits,
--          max(length(first_prize))     as max_digits
--   from   public.lottery_draws
--   group  by lottery_type
--   order  by lottery_type;
--
-- And this must return zero rows — any row here violates a documented rule:
--
--   select *
--   from   public.lottery_draws
--   where  first_prize !~ '^[0-9]{5,6}$'
--      or  bottom_two  !~ '^[0-9]{2}$'
--      or  (lottery_type = 'vietnam' and length(first_prize) <> 5)
--      or  (lottery_type in ('thai', 'laos') and length(first_prize) <> 6);
