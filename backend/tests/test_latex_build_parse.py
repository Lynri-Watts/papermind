"""latex_build.parse_log_errors 纯函数单测（不实际编译）。"""
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from services.latex_build import MAIN_TEX, PARSE_ERROR_LIMIT, parse_log_errors  # noqa: E402


class TestParseLogErrors(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(parse_log_errors(""), [])

    def test_file_line_error_form(self):
        log = (
            "This is XeTeX, Version 3.14\n"
            "./sub/intro.tex:12: Undefined control sequence.\n"
            "l.12 \\badcmd\n"
        )
        errors = parse_log_errors(log)
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0], {
            "file": "sub/intro.tex",
            "line": 12,
            "kind": "error",
            "text": "Undefined control sequence",
        })

    def test_windows_separator_normalized(self):
        errors = parse_log_errors(r".\chapters\a.tex:5: Something broke.")
        self.assertEqual(errors[0]["file"], "chapters/a.tex")
        self.assertEqual(errors[0]["line"], 5)

    def test_bang_with_lline_attributes_main(self):
        log = (
            "! Undefined control sequence.\n"
            "l.42 \\badcmd\n"
        )
        errors = parse_log_errors(log)
        self.assertEqual(errors, [{
            "file": MAIN_TEX,
            "line": 42,
            "kind": "error",
            "text": "Undefined control sequence",
        }])

    def test_orphan_bang_without_lline_kept(self):
        errors = parse_log_errors("! LaTeX Error: File `foo.sty' not found.\n\n")
        self.assertEqual(len(errors), 1)
        self.assertIsNone(errors[0]["line"])
        self.assertEqual(errors[0]["file"], MAIN_TEX)
        self.assertIn("foo.sty", errors[0]["text"])

    def test_warnings_ignored(self):
        log = (
            "LaTeX Warning: Reference `x' on page 1 undefined on input line 3.\n"
            "LaTeX Font Warning: Some font shape warning.\n"
        )
        self.assertEqual(parse_log_errors(log), [])

    def test_dedup_preserves_order(self):
        log = (
            "a.tex:1: First error.\n"
            "b.tex:2: Second error.\n"
            "a.tex:1: First error.\n"
        )
        errors = parse_log_errors(log)
        self.assertEqual([(e["file"], e["line"]) for e in errors],
                         [("a.tex", 1), ("b.tex", 2)])

    def test_limit_cap(self):
        log = "".join(f"f{i}.tex:1: Error number {i}.\n"
                      for i in range(PARSE_ERROR_LIMIT + 5))
        errors = parse_log_errors(log)
        self.assertEqual(len(errors), PARSE_ERROR_LIMIT)


if __name__ == "__main__":
    unittest.main()
