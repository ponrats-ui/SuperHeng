"""Static guards on `schema_profiles.sql`.

WHY THESE TESTS ARE NOT SQL EXECUTION, AND WHAT THEY ARE WORTH
--------------------------------------------------------------
The honest position first: **the schema has not been executed anywhere by this
project.** There is no PostgreSQL server, no Docker and no `psql` on the machine
this was written on, and Supabase's own `auth` schema cannot be recreated by
vanilla Postgres anyway without stubbing `auth.users` and `auth.uid()`. So nothing
here proves the file *runs*.

What these tests do is protect the properties that decide who gets paid for. They
read the file as text and assert the security invariants that a well-meaning later
edit is most likely to break — the ones whose absence is invisible in review
because the SQL still runs perfectly:

  * a `grant update` wide enough to let a signed-in user set their own tier to
    `premium`. The RLS policy would still permit the row; only the grant stops it.
    This is the single most valuable assertion in the file.
  * an INSERT policy on `user_profiles`, which would let a client create its own
    entitlement row.
  * reading `raw_user_meta_data` inside the signup trigger, which would let a
    crafted signup request choose its own `subscription_tier`.
  * a policy granted `to anon`, which would expose every profile row to anyone.
  * an `apply_payment_event` executable by `anon` or `authenticated`. PostgreSQL
    grants EXECUTE to PUBLIC on a new function and PostgREST exposes every function
    in the served schema, so a missing REVOKE is a self-service premium upgrade
    endpoint reachable with the app's *public* anon key. This is the newest and the
    most valuable of the set.

These are text assertions, not semantic ones: a cleverly reformatted statement
could satisfy them while doing something else. They are a tripwire, not a prover.
Running the file against a real Postgres (or the Supabase SQL editor) is still the
only thing that establishes it works.
"""

from __future__ import annotations

import re
from pathlib import Path

SCHEMA = Path(__file__).resolve().parent.parent / "schema_profiles.sql"


def normalised() -> str:
    """The file with comments stripped and whitespace collapsed.

    Comments must go before the assertions: the file's own explanatory notes quote
    the statements they warn about, so a naive search would match the warning
    rather than the code. Line comments are the `--` form; there are no block
    comments in this file, and a dollar-quoted function body never contains `--`.
    """
    lines = []
    for line in SCHEMA.read_text(encoding="utf-8").splitlines():
        stripped = line.split("--", 1)[0]
        lines.append(stripped)
    return re.sub(r"\s+", " ", " ".join(lines)).strip().lower()


def test_the_schema_file_exists():
    assert SCHEMA.is_file(), f"missing {SCHEMA}"


def functions() -> dict[str, str]:
    """Each `create or replace function` statement, keyed by name.

    Per-function rather than counted across the file: a count says how many there
    are, not which one is missing a guard, so it becomes a test that has to be
    edited every time a function is added — which is exactly when it stops being
    read.
    """
    sql = normalised()
    found: dict[str, str] = {}
    for match in re.finditer(r"create or replace function public\.(\w+)\(", sql):
        start = match.start()
        found[match.group(1)] = sql[start : sql.index("$$;", start) + 3]
    return found


# ---------------------------------------------------------------------------
# The table itself
# ---------------------------------------------------------------------------
def test_the_table_is_keyed_to_the_auth_user_and_cascades():
    sql = normalised()

    assert "create table if not exists public.user_profiles" in sql
    assert "references auth.users (id) on delete cascade" in sql


def test_the_tier_defaults_to_free_and_is_constrained():
    sql = normalised()

    assert "subscription_tier text not null default 'free'" in sql
    assert "constraint user_profiles_known_tier" in sql
    assert "check (subscription_tier in ('free', 'premium'))" in sql


def test_the_expiry_is_a_timestamp_with_a_zone():
    """A bare DATE would make 'still active?' depend on the reader's time zone."""
    sql = normalised()

    assert "subscription_expiry timestamptz" in sql


# ---------------------------------------------------------------------------
# Row-level security
# ---------------------------------------------------------------------------
def test_row_level_security_is_enabled():
    assert "alter table public.user_profiles enable row level security;" in normalised()


def test_the_caller_may_read_only_their_own_row():
    sql = normalised()

    assert "create policy \"user_profiles_select_own\"" in sql
    assert "for select to authenticated using ((select auth.uid()) = id)" in sql


def test_the_caller_may_update_only_their_own_row():
    sql = normalised()

    assert "create policy \"user_profiles_update_own\"" in sql
    assert "for update to authenticated using ((select auth.uid()) = id)" in sql
    # `with check` is what stops a user from rewriting the row to point at someone
    # else, or at an id they do not own. A policy with only `using` allows it.
    assert "with check ((select auth.uid()) = id)" in sql


def test_no_policy_grants_anything_to_anon():
    """`anon` has no token, so it has no identity and no row to see."""
    sql = normalised()

    assert "to anon" not in sql
    assert "to anon, authenticated" not in sql


def test_there_is_no_insert_policy():
    """The signup trigger owns row creation; a client must not be able to make one."""
    sql = normalised()

    assert "for insert" not in sql
    assert "on conflict (id) do nothing" in sql  # the trigger's insert, not a policy


def test_there_is_no_delete_policy():
    """Deleting one's own row would remove the record of a lapse and force a re-grant."""
    sql = normalised()

    assert "for delete" not in sql


def test_no_policy_grants_all_commands():
    assert "for all" not in normalised()


def test_no_policy_is_a_blanket_allow():
    """`using (true)` on this table would expose every user's subscription to everyone."""
    assert "using (true)" not in normalised()


def test_exactly_two_policies_exist_and_they_are_the_expected_ones():
    sql = normalised()

    commands = re.findall(r"create policy \"([a-z_]+)\" on public.user_profiles for (\w+)", sql)
    assert sorted(commands) == [("user_profiles_select_own", "select"), ("user_profiles_update_own", "update")]


# ---------------------------------------------------------------------------
# Privileges — the assertion that matters most
# ---------------------------------------------------------------------------
def test_the_tier_columns_are_not_writable_by_a_signed_in_user():
    """An RLS policy says *which row*; only a grant says *which column*.

    Without the column-level grant, `PATCH /rest/v1/user_profiles?id=eq.<own id>`
    with `{"subscription_tier": "premium"}` succeeds and the paywall is decorative.
    """
    sql = normalised()

    # A table-wide update grant would cover subscription_tier, subscription_expiry
    # and subscription_provider.
    assert "grant update on table public.user_profiles" not in sql
    assert "grant update on public.user_profiles" not in sql


def test_the_only_writable_column_is_the_display_name():
    sql = normalised()

    assert "grant update (display_name) on table public.user_profiles to authenticated" in sql
    for forbidden in ("subscription_tier", "subscription_expiry", "subscription_provider", "email"):
        pattern = re.compile(rf"grant update \([^)]*{forbidden}[^)]*\)")
        assert not pattern.search(sql), f"{forbidden} must not be in a grant update column list"


def test_the_api_can_read_the_table_with_the_callers_own_token():
    """`auth.py` reads this table with the user's token, so the grant is load-bearing."""
    assert "grant select on table public.user_profiles to authenticated" in normalised()


def test_broad_default_privileges_are_revoked_first():
    assert "revoke all on table public.user_profiles from anon, authenticated" in normalised()


# ---------------------------------------------------------------------------
# Triggers
# ---------------------------------------------------------------------------
def test_the_signup_trigger_creates_the_profile_row():
    sql = normalised()

    assert "create trigger on_auth_user_created" in sql
    assert "after insert on auth.users" in sql
    assert "execute procedure public.handle_new_user()" in sql


def test_the_trigger_never_reads_untrusted_signup_metadata():
    """`raw_user_meta_data` is caller-supplied: reading it into a tier would let a
    crafted signup request grant itself a subscription."""
    sql = normalised()

    assert "raw_user_meta_data" not in sql
    assert "raw_app_meta_data" not in sql


def test_the_trigger_body_inserts_only_the_id_and_email():
    """Asserted against the trigger body specifically, so an entitlement column
    appearing there cannot hide behind the file's other inserts."""
    body = re.search(
        r"create or replace function public\.handle_new_user\(\).*?insert into public\.user_profiles \((.*?)\)",
        normalised(),
    )

    assert body is not None, "could not locate the signup trigger's insert"
    assert body.group(1).strip() == "id, email"


def test_the_security_definer_functions_pin_their_search_path():
    """Without it, a caller can shadow `user_profiles` with a table in a schema they
    control and have it run with the definer's privileges.

    Asserted per function rather than by counting occurrences across the file. The
    count version only holds while every function pins the path, so the first
    function that legitimately pins it *without* being a definer (which is what
    `apply_payment_event` does) breaks the arithmetic while the security property is
    untouched — and the tempting fix is to weaken the assertion.
    """
    definers = {
        name: body for name, body in functions().items() if "security definer" in body
    }

    assert len(definers) >= 2, "the signup and email-copy triggers should be definers"
    for name, body in definers.items():
        assert "set search_path = ''" in body, f"{name} runs as its definer unguarded"


def test_the_granting_function_pins_its_search_path_without_being_a_definer():
    """It reaches `subscription_tier`, so it is the function that would be worth
    hijacking — but it does not need the definer's privileges and must not have
    them. Pinning the path anyway costs nothing and means a later change to
    `security definer` cannot silently introduce the shadowing hole.
    """
    body = functions()["apply_payment_event"]

    assert "set search_path = ''" in body
    assert "security definer" not in body


def test_updated_at_is_maintained_by_the_database_not_by_callers():
    sql = normalised()

    assert "create trigger user_profiles_touch_updated_at" in sql
    assert "before update on public.user_profiles" in sql


def test_the_email_copy_is_kept_in_step():
    sql = normalised()

    assert "create trigger on_auth_user_email_updated" in sql
    assert "when (old.email is distinct from new.email)" in sql


# ---------------------------------------------------------------------------
# The payment ledger, and the one function that grants an entitlement
# ---------------------------------------------------------------------------
def test_the_ledger_does_not_cascade_on_user_delete():
    """The opposite of `user_profiles`, deliberately. Deleting an account must not
    delete the record that money was taken: the refund dispute, the revenue report
    and the VAT question all arrive after the user is gone."""
    sql = normalised()
    start = sql.index("create table if not exists public.payment_events")
    table = sql[start : sql.index(");", start)]

    assert "on delete set null" in table
    assert "on delete cascade" not in table


def test_the_ledger_is_keyed_by_the_gateway_event_id():
    """This, and only this, is what makes a redelivery detectable. Stripe retries
    for up to three days and can deliver the same event more than once even when
    nothing failed."""
    sql = normalised()

    assert "primary key (provider, id)" in sql


def test_a_retried_delivery_is_detected_by_the_insert_itself():
    """Claim-then-apply, in one statement. A read-then-write in the application has
    a window between the read and the write in which two concurrent deliveries both
    believe they are first — and both extend the subscription."""
    body = functions()["apply_payment_event"]

    assert "on conflict (provider, id) do nothing" in body
    assert "get diagnostics v_claimed = row_count" in body
    assert "if v_claimed = 0 then" in body


def test_a_renewal_extends_from_the_existing_expiry():
    """`now() + interval '30 days'` — the obvious version, and what the integration
    was specified as — silently discards whatever time the customer had already paid
    for. A renewal with 10 days left would leave them with 30 instead of 40, and
    nothing would look wrong. The period is added to the later of now and the
    current expiry instead."""
    body = functions()["apply_payment_event"]

    assert "greatest(now(), coalesce(subscription_expiry, now()))" in body
    assert "make_interval(days => p_period_days)" in body


def test_an_unbounded_entitlement_is_not_reduced_by_a_purchase():
    """The schema defines a NULL expiry on a premium row as an unbounded grant (a
    lifetime or manually issued entitlement). Someone with unlimited access who buys
    a month must not end up with 30 days."""
    body = functions()["apply_payment_event"]

    assert "subscription_tier = 'premium' and subscription_expiry is null then null" in body


def test_a_missing_customer_on_an_event_does_not_erase_a_stored_one():
    """Stripe sends `customer` per session, and a session that neither created nor
    reused one leaves it absent. A bare assignment would blank a good id on such a
    delivery and send the next purchase back to minting a duplicate Customer — from a
    NULL that was itself correct."""
    body = functions()["apply_payment_event"]

    assert "stripe_customer_id = coalesce(p_stripe_customer_id, stripe_customer_id)" in body


def test_one_stripe_customer_belongs_to_at_most_one_account():
    """The id is handed back to Stripe at checkout, so two accounts sharing a
    Customer would make "whose payments are these" unanswerable — and a Customer two
    accounts point at is a mis-billed charge waiting to be found. The index is
    partial because a NULL (no purchase yet) is the ordinary state of most rows."""
    sql = normalised()

    assert "create unique index if not exists user_profiles_stripe_customer_id_key" in sql
    assert "on public.user_profiles (stripe_customer_id)" in sql
    assert "where stripe_customer_id is not null" in sql


def test_the_granting_function_is_not_executable_by_anon_or_authenticated():
    """**The most valuable assertion in this file.** PostgreSQL grants EXECUTE to
    PUBLIC on a newly created function, and PostgREST exposes every function in the
    schema it serves. Without this REVOKE, anyone holding the app's *public* anon
    key could POST to `/rest/v1/rpc/apply_payment_event` and grant themselves a
    subscription."""
    sql = normalised()

    assert "revoke all on function public.apply_payment_event(" in sql
    assert "from public, anon, authenticated;" in sql


def test_the_granting_function_is_executable_by_the_service_role_only():
    sql = normalised()

    assert "grant execute on function public.apply_payment_event(" in sql
    assert "to service_role;" in sql
    # The REVOKE must come first: a later grant to PUBLIC would undo it regardless
    # of how the file reads top to bottom in review.
    assert sql.index("revoke all on function public.apply_payment_event(") < sql.index(
        "grant execute on function public.apply_payment_event("
    )


def test_the_ledger_is_not_readable_by_a_signed_in_user():
    """What an account has paid is not part of the product's API, and the table
    would otherwise be a map of who is worth targeting."""
    sql = normalised()

    assert "revoke all on table public.payment_events from anon, authenticated;" in sql


def test_the_granting_function_is_given_no_privilege_beyond_what_it_needs():
    """It is `security invoker`, so it runs with the caller's own privileges rather
    than the definer's. Combined with the REVOKE, that is two independent controls:
    the revoke keeps the call from happening, and the invoker mode means that even
    if it did, the caller still could not write `subscription_tier`."""
    body = functions()["apply_payment_event"]

    assert "security definer" not in body


# ---------------------------------------------------------------------------
# Idempotency — the file is documented as safe to run twice
# ---------------------------------------------------------------------------
def test_every_create_is_guarded_so_a_second_run_is_a_no_op():
    sql = normalised()

    # Stated as "no unguarded CREATE TABLE exists" rather than "this one table is
    # guarded": the original form only ever checked the table that existed when it
    # was written, so a new table could be added unguarded and the test would still
    # pass.
    assert re.findall(r"create table(?! if not exists)", sql) == []
    assert "create table if not exists public.user_profiles" in sql
    assert "create table if not exists public.payment_events" in sql
    # Functions are `create or replace`, triggers and policies are dropped first.
    assert "create function public." not in sql
    assert set(functions()) == {
        "user_profiles_touch_updated_at",
        "handle_new_user",
        "handle_user_email_change",
        "apply_payment_event",
    }
    for name in (
        "user_profiles_touch_updated_at",
        "on_auth_user_created",
        "on_auth_user_email_updated",
        "user_profiles_select_own",
        "user_profiles_update_own",
    ):
        assert f"drop trigger if exists {name}" in sql or f"drop policy if exists \"{name}\"" in sql


def test_every_added_column_and_constraint_is_guarded():
    sql = normalised()

    for column in (
        "email",
        "display_name",
        "subscription_tier",
        "subscription_expiry",
        "subscription_provider",
        "stripe_customer_id",
        "created_at",
        "updated_at",
    ):
        assert f"add column if not exists {column}" in sql, column
    assert "drop constraint if exists user_profiles_known_tier" in sql


def test_existing_accounts_are_backfilled():
    """Every account created before this file ran has no row, so its entitlement
    check finds nothing. The trigger only covers new signups."""
    sql = normalised()

    assert "insert into public.user_profiles (id, email) select u.id, u.email from auth.users u" in sql


# ---------------------------------------------------------------------------
# Syntax sanity
# ---------------------------------------------------------------------------
def test_the_dollar_quotes_are_balanced():
    """A missing `$$;` swallows the rest of the file into a function body, which
    fails in a way that reads as an unrelated syntax error at the wrong line."""
    raw = SCHEMA.read_text(encoding="utf-8")

    assert raw.count("$$") % 2 == 0
    assert raw.count("$$") > 0


def test_the_file_ends_with_a_terminated_statement():
    """A missing final `;` makes the last statement vanish silently on paste, which
    is the failure that looks like nothing happened at all."""
    raw = SCHEMA.read_text(encoding="utf-8")
    tail = [line.split("--", 1)[0].strip() for line in raw.splitlines()]
    tail = [line for line in tail if line]

    assert tail[-1].endswith(";"), tail[-1]


def test_every_statement_has_balanced_parentheses():
    """A statement-level check rather than a per-line one.

    Multi-line statements are the norm here, so requiring every line to end in `;`
    would fail on correct SQL. Splitting on `;` — after removing comments and the
    dollar-quoted bodies, whose contents are not SQL this parser can reason about —
    catches the mistake that actually matters: a missing or stray bracket, which
    shifts where the statement ends and turns the *next* statement into a syntax
    error at a line that looks fine.
    """
    raw = SCHEMA.read_text(encoding="utf-8")
    without_comments = "\n".join(line.split("--", 1)[0] for line in raw.splitlines())
    outside_bodies = ";".join(without_comments.split("$$")[::2])

    for statement in outside_bodies.split(";"):
        code = statement.strip()
        if not code:
            continue
        assert code.count("(") == code.count(")"), f"unbalanced parentheses in: {code[:120]!r}"
