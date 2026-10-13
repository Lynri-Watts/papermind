"""bibtex 纯函数层单测：转义、cite key、条目生成、查重、文献方案与接线动作。"""
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from services import bibtex  # noqa: E402
from services.writing_edit import ApplyResult, apply_actions  # noqa: E402

ARXIV_PAPER = {
    "id": 1,
    "source": "arxiv",
    # 与 providers/arxiv._extract_id_from_abs_url 的真实产物一致：裸 ID
    "external_id": "2401.01234",
    "title": "Deep Learning for Everything",
    "authors": ["Jane Doe", "John Roe"],
    "year": 2024,
    "doi": "",
    "url": "https://arxiv.org/abs/2401.01234",
}
JOURNAL_PAPER = {
    "id": 2,
    "source": "openalex",
    "external_id": "",
    "title": "A Study of Attention & Mechanisms",
    "authors": ["Smith, Alice"],
    "year": 2023,
    "doi": "10.1000/abc.123",
    "url": "",
}


class TestEscape(unittest.TestCase):
    def test_special_chars(self):
        out = bibtex.escape_value(r"A&B 100% $x_{i}$ #a ~b ^c d\e")
        # 反斜杠必须最先替换，否则会二次转义
        self.assertIn(r"\textbackslash{}e", out)
        for ch in "&%$#_{}":
            self.assertIn("\\" + ch, out)
        self.assertIn(r"\textasciitilde{}", out)
        self.assertIn(r"\textasciicircum{}", out)
        # 原始裸字符不应残留（替换序列本身除外）
        self.assertNotIn("&", out.replace(r"\&", ""))


class TestCiteKey(unittest.TestCase):
    def test_surname_year_first_content_word(self):
        used: set[str] = set()
        key = bibtex.make_cite_key(ARXIV_PAPER, used)
        # 停用词 Deep? 不是停用词；标题首词 "Deep" 直接入 key
        self.assertEqual(key, "doe2024deep")
        self.assertIn("doe2024deep", used)

    def test_stop_words_skipped_and_comma_author_format(self):
        used: set[str] = set()
        paper = {"authors": ["Smith, Alice"], "year": 2020,
                 "title": "The a an of Novel Method"}
        # "the"/"a"/"an"/"of" 均被跳过，第一个实词是 Novel
        self.assertEqual(bibtex.make_cite_key(paper, used), "smith2020novel")

    def test_collision_suffix(self):
        used = {"doe2024deep"}
        key = bibtex.make_cite_key(ARXIV_PAPER, used)
        self.assertEqual(key, "doe2024deepa")
        key2 = bibtex.make_cite_key(ARXIV_PAPER, used)
        self.assertEqual(key2, "doe2024deepb")

    def test_anonymous_fallback(self):
        key = bibtex.make_cite_key({"authors": [], "title": "", "year": ""}, set())
        self.assertTrue(key.startswith("anon"))


class TestBuildEntry(unittest.TestCase):
    def test_arxiv_is_misc_with_eprint(self):
        entry = bibtex.build_entry(ARXIV_PAPER, "doe2024deep")
        self.assertTrue(entry.startswith("@misc{doe2024deep,"))
        self.assertIn("eprint = {2401.01234}", entry)
        self.assertIn("archivePrefix = {arXiv}", entry)
        self.assertIn("author = {Jane Doe and John Roe}", entry)
        self.assertTrue(entry.endswith("}\n"))

    def test_eprint_id_variants(self):
        # 前缀写法 / 版本尾缀 / 旧版分类 ID（前缀分类必须保留）
        self.assertEqual(bibtex._eprint_id("arXiv:2401.01234v2"), "2401.01234")
        self.assertEqual(bibtex._eprint_id("hep-ph/0304186v1"), "hep-ph/0304186")
        old_style = {**ARXIV_PAPER, "external_id": "hep-ph/0304186v1"}
        entry = bibtex.build_entry(old_style, "k")
        self.assertIn("eprint = {hep-ph/0304186}", entry)

    def test_journal_is_article_with_escaped_title(self):
        key = bibtex.make_cite_key(JOURNAL_PAPER, set())
        entry = bibtex.build_entry(JOURNAL_PAPER, key)
        self.assertTrue(entry.startswith("@article{"))
        self.assertIn(r"Attention \& Mechanisms", entry)
        self.assertIn("doi = {10.1000/abc.123}", entry)

    def test_missing_optional_fields_omitted(self):
        entry = bibtex.build_entry({"title": "Only Title"}, "k")
        self.assertIn("title = {Only Title}", entry)
        self.assertNotIn("author", entry)
        self.assertNotIn("year", entry)
        self.assertNotIn("doi", entry)


class TestDedup(unittest.TestCase):
    def test_existing_index_extracts_sets(self):
        existing = (
            "@article{smith2020x,\n  doi = {10.1000/XYZ},\n}\n"
            "@misc{doe2024deep,\n  eprint = {2401.01234},\n}\n"
        )
        keys, dois, eprints = bibtex.existing_index(existing)
        self.assertEqual(keys, {"smith2020x", "doe2024deep"})
        self.assertEqual(dois, {"10.1000/xyz"})
        self.assertEqual(eprints, {"2401.01234"})

    def test_duplicate_by_doi_and_eprint(self):
        existing = (
            "@article{k1,\n  doi = {10.1000/ABC.123},\n}\n"
            "@misc{k2,\n  eprint = {2401.01234},\n}\n"
        )
        results = bibtex.build_entries([JOURNAL_PAPER, ARXIV_PAPER], existing)
        self.assertEqual(results[0]["status"], "duplicate")
        self.assertEqual(results[0]["reason"], "doi")
        self.assertEqual(results[0]["key"], "")
        self.assertEqual(results[1]["status"], "duplicate")
        self.assertEqual(results[1]["reason"], "eprint")

    def test_added_status_and_key_collision_with_existing(self):
        existing = "@misc{doe2024deepa,\n}\n"
        results = bibtex.build_entries([ARXIV_PAPER], existing)
        # 基础 key doe2024deep 不在集合 → 直接用基础 key（existing 的是 ...deepa）
        self.assertEqual(results[0]["status"], "added")
        self.assertEqual(results[0]["key"], "doe2024deep")


class TestSchemeAndResourceEdits(unittest.TestCase):
    def test_detect_scheme(self):
        self.assertEqual(bibtex.detect_bib_scheme(r"\usepackage{biblatex}"), "biblatex")
        self.assertEqual(
            bibtex.detect_bib_scheme(r"\usepackage[backend=biber]{biblatex}"),
            "biblatex")
        self.assertEqual(
            bibtex.detect_bib_scheme(r"\bibliography{refs}"), "classic")
        self.assertIsNone(bibtex.detect_bib_scheme(r"\begin{document}hi\end{document}"))

    def test_biblatex_wire_from_scratch(self):
        main = (
            "\\documentclass{article}\n"
            "\\usepackage[backend=biber]{biblatex}\n"
            "\\begin{document}\nbody\n\\end{document}\n"
        )
        actions = bibtex.resource_edits(main, "biblatex", "refs.bib")
        self.assertEqual(len(actions), 2)
        kinds = [a["kind"] for a in actions]
        self.assertEqual(kinds, ["insert_after", "insert_before"])
        self.assertIn(r"\addbibresource{refs.bib}", actions[0]["text"])
        self.assertIn(r"\printbibliography", actions[1]["text"])
        # 动作必须能在原文上唯一落地
        result = apply_actions(main, actions)
        self.assertIsInstance(result, ApplyResult)

    def test_biblatex_already_wired_is_noop(self):
        main = (
            "\\usepackage{biblatex}\n"
            "\\addbibresource{refs.bib}\n"
            "\\begin{document}\n\\printbibliography\n\\end{document}\n"
        )
        self.assertEqual(bibtex.resource_edits(main, "biblatex", "refs.bib"), [])

    def test_biblatex_missing_end_raises(self):
        with self.assertRaises(ValueError):
            bibtex.resource_edits(r"\usepackage{biblatex}", "biblatex", "r.bib")

    def test_classic_extends_existing_bibliography(self):
        main = "body\n\\bibliography{old}\n\\end{document}\n"
        actions = bibtex.resource_edits(main, "classic", "refs.bib")
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0]["kind"], "replace")
        self.assertIn(r"\bibliography{old,refs}", actions[0]["new"])
        result = apply_actions(main, actions)
        self.assertIsInstance(result, ApplyResult)

    def test_classic_already_contains_name_noop(self):
        main = "\\bibliography{old, refs}\n\\end{document}\n"
        self.assertEqual(bibtex.resource_edits(main, "classic", "refs.bib"), [])

    def test_no_scheme_inserts_bibliography_before_end(self):
        main = "\\begin{document}\nbody\n\\end{document}\n"
        actions = bibtex.resource_edits(main, None, "sub/refs.bib")
        self.assertEqual(len(actions), 1)
        # classic 命令使用不带 .bib 后缀的名字（但保留相对目录）
        self.assertEqual(actions[0]["text"], "\\bibliography{sub/refs}\n")
        result = apply_actions(main, actions)
        self.assertIsInstance(result, ApplyResult)
        assert isinstance(result, ApplyResult)
        self.assertIn(r"\bibliography{sub/refs}", result.text)


if __name__ == "__main__":
    unittest.main()
