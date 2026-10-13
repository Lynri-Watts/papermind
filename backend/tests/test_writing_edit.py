"""writing_edit 纯函数层单测：唯一锚点编辑、原子批、EOL、反向还原、行号切片。"""
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from services.writing_edit import (  # noqa: E402
    ActionFailure,
    ApplyResult,
    EditEngineError,
    apply_actions,
    content_hash,
    detect_eol,
    normalize_eol,
    numbered_slice,
    remove_block,
    restore_eol,
    reverse_replace,
)

DOC = "line one\nline two\nline three\n"


class TestEol(unittest.TestCase):
    def test_normalize_crlf_and_cr(self):
        self.assertEqual(normalize_eol("a\r\nb\rc\r\n"), "a\nb\nc\n")

    def test_detect_majority(self):
        self.assertEqual(detect_eol("a\r\nb\r\nc\n"), "\r\n")
        self.assertEqual(detect_eol("a\r\nb\nc\n"), "\n")
        # 平局归 LF
        self.assertEqual(detect_eol("a\r\nb\n"), "\n")

    def test_restore_roundtrip(self):
        raw = "a\r\nb\r\nc\r\n"
        lf = normalize_eol(raw)
        self.assertEqual(restore_eol(lf, detect_eol(raw)), raw)

    def test_hash_independent_of_eol(self):
        lf = "alpha\nbeta\n"
        self.assertEqual(content_hash(lf), content_hash(lf.replace("\n", "\r\n")))


class TestApplyActions(unittest.TestCase):
    def test_single_replace_ok(self):
        result = apply_actions(DOC, [{"old": "line two", "new": "LINE 2"}])
        self.assertIsInstance(result, ApplyResult)
        assert isinstance(result, ApplyResult)  # 类型收窄
        self.assertEqual(result.text, "line one\nLINE 2\nline three\n")
        self.assertEqual(len(result.applied), 1)
        edit = result.applied[0]
        self.assertEqual((edit.old_start, edit.old_lines), (2, 1))
        self.assertEqual((edit.new_start, edit.new_lines), (2, 1))
        self.assertEqual(edit.old_text, "line two")
        self.assertEqual(edit.new_text, "LINE 2")

    def test_not_found_is_predicted_failure(self):
        # 与第 2 行仅一字符之差，similar_lines 应给出行 2 作为候选
        result = apply_actions(DOC, [{"old": "line too", "new": "x"}])
        self.assertIsInstance(result, list)
        assert isinstance(result, list)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0].index, 0)
        self.assertEqual(result[0].code, "not_found")
        self.assertIn(2, result[0].candidates)
        # to_dict 结构（回 LLM 的载荷）
        self.assertEqual(set(result[0].to_dict().keys()),
                         {"index", "code", "occurrences", "candidates"})

    def test_multiple_occurrences_reports_lines(self):
        text = "dup\nmid\ndup\n"
        result = apply_actions(text, [{"old": "dup", "new": "x"}])
        self.assertIsInstance(result, list)
        failures = result  # type: list[ActionFailure]
        assert isinstance(failures, list)
        self.assertEqual(failures[0].code, "multiple")
        self.assertEqual(failures[0].occurrences, [1, 3])

    def test_batch_atomic_second_failure_leaves_text_untouched(self):
        # 第一个锚点合法、第二个失配 → 整批不应用
        result = apply_actions(DOC, [
            {"old": "line one", "new": "FIRST"},
            {"old": "no such line", "new": "SECOND"},
        ])
        self.assertIsInstance(result, list)
        self.assertEqual([f.code for f in result], ["not_found"])  # type: ignore[union-attr]

    def test_batch_multiple_failures_all_reported(self):
        result = apply_actions(DOC, [
            {"old": "missing-a", "new": "x"},
            {"old": "missing-b", "new": "y"},
        ])
        self.assertIsInstance(result, list)
        self.assertEqual([f.index for f in result], [0, 1])  # type: ignore[union-attr]
        self.assertTrue(all(f.code == "not_found" for f in result))  # type: ignore[union-attr]

    def test_sequential_application_later_action_sees_earlier_result(self):
        # 第二个锚点只有在第一个替换发生后才存在 → 顺序预演必须通过
        result = apply_actions(DOC, [
            {"old": "line two", "new": "fresh anchor"},
            {"old": "fresh anchor", "new": "line two v2"},
        ])
        self.assertIsInstance(result, ApplyResult)
        assert isinstance(result, ApplyResult)
        self.assertEqual(result.text, "line one\nline two v2\nline three\n")
        # 第二个动作的 old_start 在中间态上计算
        self.assertEqual(result.applied[1].old_start, 2)

    def test_multiblock_replace_line_numbers(self):
        result = apply_actions("a\nb\nc\nd\n", [{
            "old": "b\nc",
            "new": "b1\nc1\nc2",
        }])
        assert isinstance(result, ApplyResult)
        edit = result.applied[0]
        self.assertEqual((edit.old_start, edit.old_lines), (2, 2))
        self.assertEqual((edit.new_start, edit.new_lines), (2, 3))

    def test_empty_block_and_same_codes(self):
        r1 = apply_actions(DOC, [{"old": "   ", "new": "x"}])
        self.assertIsInstance(r1, list)
        self.assertEqual(r1[0].code, "empty_block")  # type: ignore[index]

        r2 = apply_actions(DOC, [{"old": "line one", "new": "line one"}])
        self.assertIsInstance(r2, list)
        self.assertEqual(r2[0].code, "same")  # type: ignore[index]

    def test_insert_before_and_after(self):
        before = apply_actions(DOC, [{
            "kind": "insert_before", "anchor": "line two", "text": "NEW",
        }])
        assert isinstance(before, ApplyResult)
        self.assertEqual(before.text, "line one\nNEW\nline two\nline three\n")

        after = apply_actions(DOC, [{
            "kind": "insert_after", "anchor": "line two", "text": "NEW",
        }])
        assert isinstance(after, ApplyResult)
        self.assertEqual(after.text, "line one\nline two\nNEW\nline three\n")

        # text 自带前导换行时不重复补
        after2 = apply_actions(DOC, [{
            "kind": "insert_after", "anchor": "line two", "text": "\nNEW",
        }])
        assert isinstance(after2, ApplyResult)
        self.assertEqual(after2.text, "line one\nline two\nNEW\nline three\n")

    def test_unknown_kind_raises(self):
        with self.assertRaises(EditEngineError):
            apply_actions(DOC, [{"kind": "bogus", "old": "a", "new": "b"}])

    def test_invalid_invocation_raises(self):
        with self.assertRaises(EditEngineError):
            apply_actions(DOC, [])
        with self.assertRaises(EditEngineError):
            apply_actions(DOC, "not-a-list")  # type: ignore[arg-type]


class TestReverseAndRemove(unittest.TestCase):
    def test_reverse_replace_ok(self):
        text = "a\nNEW\nc\n"
        count, restored = reverse_replace(text, "NEW", "old")
        self.assertEqual(count, 1)
        self.assertEqual(restored, "a\nold\nc\n")

    def test_reverse_zero_and_multiple_no_change(self):
        count, same = reverse_replace("a\na\n", "zzz", "x")
        self.assertEqual((count, same), (0, "a\na\n"))
        count2, same2 = reverse_replace("dup\ndup\n", "dup", "x")
        self.assertEqual(count2, 2)
        self.assertEqual(same2, "dup\ndup\n")

    def test_remove_block_collapses_blank_runs(self):
        text = "keep\n\n\nAPPENDED\n"
        count, out = remove_block(text, "\n\nAPPENDED\n")
        self.assertEqual(count, 1)
        self.assertEqual(out, "keep\n")

    def test_remove_block_non_unique(self):
        count, same = remove_block("x\nx\n", "x")
        self.assertEqual(count, 2)
        self.assertEqual(same, "x\nx\n")


class TestNumberedSlice(unittest.TestCase):
    # 注意：尾换行在 split("\n") 下会多出一个空行，切片用无尾换行文本
    TEXT = "line one\nline two\nline three"

    def test_slice_full_and_range(self):
        body, total, chars = numbered_slice(self.TEXT, None, None)
        self.assertEqual(total, 3)
        self.assertIn("1\tline one", body)
        self.assertIn("3\tline three", body)
        self.assertEqual(chars, len(body))

        body2, total2, _ = numbered_slice(self.TEXT, 2, 2)
        self.assertEqual(total2, 3)
        self.assertEqual(body2, "2\tline two")

    def test_bad_ranges_raise(self):
        with self.assertRaises(EditEngineError):
            numbered_slice(self.TEXT, 0, 1)
        with self.assertRaises(EditEngineError):
            numbered_slice(self.TEXT, 2, 1)
        with self.assertRaises(EditEngineError):
            numbered_slice(self.TEXT, 1, 99)


if __name__ == "__main__":
    unittest.main()
