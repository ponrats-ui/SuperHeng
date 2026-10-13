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
-- DESIGN NOTE — why `draw_date` is UNIQUE
--   `draw_date` is the natural key of a draw and it is also the conflict target
--   the ingestion engine upserts on. If it were not UNIQUE, PostgREST's
--   `on_conflict=draw_date` would fail with 42P10, so the ingestion script and
--   this constraint are a matched pair. Do not drop the constraint without
--   changing scraper.py's `upsert(..., on_conflict="draw_date")` call.

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
    id          uuid        primary key default gen_random_uuid(),
    draw_date   date        not null unique,
    first_prize varchar(6)  not null,
    bottom_two  varchar(2)  not null,
    created_at  timestamptz not null default now(),

    -- Prize numbers are stored as zero-padded strings ("001973"), never as
    -- integers, which would lose the leading zeros. These constraints refuse
    -- anything that is not exactly the right shape, so a parser bug or a
    -- partner's format change fails at write time instead of silently
    -- poisoning the historical ledger.
    constraint lottery_draws_first_prize_is_6_digits
        check (first_prize ~ '^[0-9]{6}$'),
    constraint lottery_draws_bottom_two_is_2_digits
        check (bottom_two ~ '^[0-9]{2}$')
);

comment on table  public.lottery_draws            is 'Official Thai GLO draw results. One row per draw date; immutable history, upserted on draw_date.';
comment on column public.lottery_draws.draw_date  is 'Draw date (Thailand local), ISO-8601. Natural key and upsert conflict target.';
comment on column public.lottery_draws.first_prize is 'รางวัลที่ 1 — first prize, exactly 6 digits, zero-padded.';
comment on column public.lottery_draws.bottom_two  is 'เลขท้าย 2 ตัว — the SEPARATELY DRAWN 2-digit prize, exactly 2 digits.';
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
-- After the ingestion script has run, this should report a non-zero count:
--
--   select count(*)                        as draws,
--          min(draw_date)                  as oldest,
--          max(draw_date)                  as newest
--   from   public.lottery_draws;
--
-- And this must return zero rows — any row here violates a documented rule:
--
--   select *
--   from   public.lottery_draws
--   where  first_prize !~ '^[0-9]{6}$'
--      or  bottom_two  !~ '^[0-9]{2}$';
