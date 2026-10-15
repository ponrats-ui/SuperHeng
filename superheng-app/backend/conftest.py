"""Makes `backend/` importable for the test suite, and owns the shared auth seam.

pytest inserts the *rootdir* of a collected test file into `sys.path`. Without a
conftest.py sitting in `backend/`, that would be `backend/tests/`, and
`import services` inside the tests would fail. A file here is the conventional
fix; `main.py` and `services.py` are imported by design.

WHAT ELSE LIVES HERE, AND WHY
------------------------------
`/api/predict/premium` is the one endpoint behind an entitlement check, and the
suites that exercise its *model* — `test_bayesian.py`, `test_lottery_types.py`,
`test_rolling_window.py`, `test_backtest.py` — have nothing to say about the door.
Before this fixture existed they called it anonymously and got 200; now they get
401 unless they sign in, which is the correct new behaviour of a changed contract
but says nothing about the maths they exist to check.

So `premium_account` (and the bare `grant_premium()` for the two suites that build
their client inside a plain helper function rather than a fixture) installs a
FastAPI dependency override for `main.require_premium_user`.

**The override replaces only the identity lookup, never the gate.** The route still
asks for `require_premium_user`; a test that removes the override is back to the
real token validation, which is exactly what `test_auth.py` does. That keeps the
"is the endpoint actually protected" question answerable — a suite where the
protection is bypassed *by construction* would happily pass if the protection had
been deleted from `main.py` too.

An override of `require_premium_user` deliberately does **not** sign the caller in
for `require_user`: `GET /api/me` and `POST /api/checkout/create-session` depend on
the latter and are meant to keep answering 401 to these anonymous-model suites.
"""

from __future__ import annotations

import pytest

import main
import payments
from auth import AuthenticatedUser

#: A premium subscriber, used as the default signed-in caller. The id is a
#: syntactically valid UUIDv4 and the domain is `.test` (reserved by RFC 2606), so
#: neither can be mistaken for a real account if one of these ever reaches a log.
PREMIUM_TEST_USER = AuthenticatedUser(
    user_id="11111111-1111-4111-8111-111111111111",
    email="premium@example.test",
    tier="premium",
    subscription_expiry=None,
    subscription_provider="test",
    claims={
        "sub": "11111111-1111-4111-8111-111111111111",
        "email": "premium@example.test",
        "role": "authenticated",
        "aud": "authenticated",
    },
)


def grant_premium(user: AuthenticatedUser = PREMIUM_TEST_USER) -> AuthenticatedUser:
    """Sign the app in as ``user`` for premium endpoints, returning them.

    For suites that construct their `TestClient` inside a helper function rather
    than a fixture (`test_lottery_types.served`, `test_rolling_window.served`) and
    so cannot ask for `premium_account`. Cleanup is not this function's job — the
    autouse `_isolate_dependency_overrides` below removes the override after every
    test, whether or not the test cleaned up itself.
    """
    main.app.dependency_overrides[main.require_premium_user] = lambda: user
    return user


def revoke_premium() -> None:
    """Restore the real gate. Needed only by a test that wants both behaviours."""
    main.app.dependency_overrides.pop(main.require_premium_user, None)


@pytest.fixture(autouse=True)
def _isolate_dependency_overrides():
    """No test may leave an auth override behind for the next one.

    Teardown-only on purpose: it takes no part in setting anything up, so it
    cannot make a failing test pass. It exists because the override is registered
    on the module-level `app`, which every `TestClient` in the suite shares — an
    override that outlived its test would silently authenticate the next suite's
    requests, and the failure would look like a passing test somewhere unrelated.
    """
    yield
    main.app.dependency_overrides.clear()


#: Every environment variable that would let this suite reach a real Stripe
#: account. Read from `payments` rather than repeated as string literals, so a
#: rename cannot leave one of them live in the tests.
_PAYMENT_ENV_VARS = (
    payments.SECRET_KEY_ENV,
    payments.WEBHOOK_SECRET_ENV,
    payments.API_VERSION_ENV,
    payments.PAYMENT_METHODS_ENV,
    payments.TIMEOUT_ENV,
)


@pytest.fixture(autouse=True)
def _no_live_payment_credentials(monkeypatch: pytest.MonkeyPatch):
    """No test may reach a real payment gateway, whatever is in backend/.env.

    `main.py` calls `load_dotenv` at import, so a developer with a live
    `STRIPE_SECRET_KEY` in their environment would otherwise have this suite
    creating real Checkout Sessions against their account the moment any test
    happened to build one. `payments` reads its configuration when it is called,
    so deleting the variables here is enough.

    The effect is that "no gateway configured" is the default state of every test,
    and a suite that wants the configured path has to ask for it explicitly — which
    is the safer way round: a test that forgets is a test that cannot charge anyone.
    """
    for name in _PAYMENT_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    yield


@pytest.fixture()
def premium_account():
    """Request this to call the gated endpoints as a subscriber."""
    yield grant_premium()
