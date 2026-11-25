"""Regression checks for the inputs and outputs of the release builder."""

import pathlib
import tempfile
import unittest
import zipfile
import importlib.util
import runpy


spec = importlib.util.spec_from_file_location(
    'fitness_release', pathlib.Path(__file__).with_name('build-release.py')
)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_share_renderers_use_distinct_chinese_glyphs_for_titles(self):
        for script in ('render-share-card.py', 'render-visual-composition.py'):
            with self.subTest(script=script):
                renderer = runpy.run_path(str(release.SOURCE / 'scripts' / script))
                face = renderer['font'](64, bold=True)
                masks = [bytes(face.getmask(character)) for character in '\u8bad\u7ec3\u590d\u76d8']
                self.assertTrue(all(any(mask) for mask in masks), 'The title font must draw Chinese text')
                self.assertEqual(len(set(masks)), 4, 'The title font must not substitute missing-glyph boxes')

    def test_checkout_line_endings_do_not_change_the_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            source = root / 'sample.md'
            package = root / 'package.zip'
            source.write_bytes(b'# Skill\r\nABC\r\n')
            release.write_archive(package, [('skill/sample.md', release.audited_bytes(source))])
            first = package.read_bytes()
            source.write_bytes(b'# Skill\nABC\n')
            release.write_archive(package, [('skill/sample.md', release.audited_bytes(source))])
            self.assertEqual(first, package.read_bytes())
            with zipfile.ZipFile(package) as archive:
                self.assertEqual(b'# Skill\nABC\n', archive.read('skill/sample.md'))

    def test_archive_rejects_secrets_and_reports_only_rule_and_filename(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = pathlib.Path(temporary) / 'sample.md'
            marker = 'ghp_' + 'q' * 36
            source.write_text(marker, encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'GitHub token') as failure:
                release.audited_bytes(source)
            self.assertNotIn(marker, str(failure.exception))

    def test_archive_rejects_duplicate_and_out_of_tree_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            package = pathlib.Path(temporary) / 'bad.zip'
            for paths in [['../unsafe'], ['skill/same', 'skill/same']]:
                with self.subTest(paths=paths):
                    with self.assertRaises(ValueError):
                        release.write_archive(package, [(name, b'payload') for name in paths])


if __name__ == '__main__':
    unittest.main()
