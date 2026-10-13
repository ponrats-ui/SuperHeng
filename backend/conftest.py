"""Makes `backend/` importable for the test suite.

pytest inserts the *rootdir* of a collected test file into `sys.path`. Without a
conftest.py sitting in `backend/`, that would be `backend/tests/`, and
`import services` inside the tests would fail. An empty file here is the
conventional fix; `main.py` and `services.py` are imported by design.
"""
