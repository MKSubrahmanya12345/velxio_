"""
CompileResponse carries the failure class every caller used to re-derive.

_classify_compile_error() has always mapped compiler output to a stable
error_kind, but only the analytics event ever saw it. Anything reading the
API (the editor, the agent, an MCP client) had to grep stderr again, and a
grep is where "the build server could not install the core" turns into "your
sketch is wrong". The class now rides the response, filled in by the model
validator so no construction site can forget it.

Run from the repo root:
    python -m pytest test/backend/unit/test_compile_error_kind.py -v
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent / 'backend'))

from app.api.routes.compile import CompileResponse, _classify_compile_error

KINDS = {
    "missing_library", "core_install_failed", "linker_error",
    "syntax_error", "compile_error", "unknown",
}


def failure(stderr: str = "", error: str | None = None, **kw) -> CompileResponse:
    return CompileResponse(success=False, stdout="", stderr=stderr, error=error, **kw)


class ClassifierTests(unittest.TestCase):
    def test_every_class_is_one_of_the_closed_six(self):
        samples = [
            "fatal error: DHT.h: No such file or directory",
            "Failed to install core esp32:esp32",
            "undefined reference to `setup'",
            "error: expected ';' before '}' token",
            "error: 'digitalWrite' was not declared in this scope",
            "the build stopped for reasons nobody wrote down",
        ]
        got = {_classify_compile_error(s, None) for s in samples}
        self.assertEqual(got, KINDS)

    def test_the_kinds_that_change_what_a_caller_should_do(self):
        # A missing header is the agent's to fix (declare the library); a core
        # install failure is the build server's and rewriting code cannot fix
        # it. Telling them apart is the whole point of the field.
        self.assertEqual(
            _classify_compile_error("fatal error: DHT.h: No such file or directory", None),
            "missing_library",
        )
        self.assertEqual(
            _classify_compile_error("", "Failed to install required core: esp32:esp32"),
            "core_install_failed",
        )


class ResponseTests(unittest.TestCase):
    def test_a_failed_response_carries_the_class(self):
        self.assertEqual(
            failure(stderr="fatal error: Adafruit_GFX.h: No such file or directory").error_kind,
            "missing_library",
        )
        self.assertEqual(
            failure(error="Failed to install required core: esp32:esp32").error_kind,
            "core_install_failed",
        )
        self.assertEqual(failure(stderr="undefined reference to `loop'").error_kind, "linker_error")
        self.assertEqual(failure(stderr="error: expected ';' before '}'").error_kind, "syntax_error")
        self.assertEqual(failure(stderr="nothing recognisable here").error_kind, "unknown")

    def test_success_never_carries_a_class(self):
        ok = CompileResponse(
            success=True, stdout="Sketch uses 1234 bytes", stderr="error: this is stale output",
            hex_content="abc",
        )
        self.assertIsNone(ok.error_kind)

    def test_an_explicit_class_is_kept(self):
        # The compilers may know better than a regex over their own output.
        self.assertEqual(failure(stderr="fatal error: x.h", error_kind="linker_error").error_kind,
                         "linker_error")

    def test_the_field_survives_the_serialisation_the_api_and_the_job_store_use(self):
        # Async compiles are handed back through model_dump(), so a field that
        # only existed on the object would reach half the callers.
        dumped = failure(stderr="fatal error: DHT.h: No such file or directory").model_dump()
        self.assertEqual(dumped["error_kind"], "missing_library")
        self.assertEqual(CompileResponse(**dumped).error_kind, "missing_library")

    def test_negative_control_the_classifier_is_what_fills_it(self):
        # If the validator stopped calling the classifier, this stderr (which
        # only the classifier can read) would come back as None or "unknown"
        # and the assertion above would be the only thing to notice.
        self.assertIsNone(CompileResponse(success=True, stdout="", stderr="").error_kind)
        self.assertEqual(failure(stderr="").error_kind, "unknown")


if __name__ == "__main__":
    unittest.main()
