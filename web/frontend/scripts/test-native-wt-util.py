"""Host tests for the bundled, unmodified utilities.wt_util module."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python/native'))
from utilities import wt_util


class WtUtilTest(unittest.TestCase):
    def test_find_nearest(self):
        self.assertEqual(wt_util.find_nearest([0, 2, 4], 3), 1)
        self.assertEqual(wt_util.find_nearest([0, 2, 4], 3.9), 2)

    def test_file_helpers_in_temporary_directory(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'a.txt').write_text('alpha\n')
            (root / 'b.txt').write_text('beta\n')
            merged = root / 'merged'
            wt_util.merge_files([str(root / 'a.txt'), str(root / 'b.txt')], str(merged))
            self.assertEqual(merged.read_text(), 'alpha\nbeta\n')
            archived = Path(wt_util.archive_file(str(merged), 'v1'))
            self.assertEqual(archived.read_text(), merged.read_text())
            wt_util.archive(str(root), 'v2')
            self.assertEqual((root / 'v2' / 'ver').read_text(), 'v2')
            self.assertEqual((root / 'v2' / 'a.txt').read_text(), 'alpha\n')
            wt_util.remove_files(str(root / '*.txt'))
            self.assertFalse((root / 'a.txt').exists())
            wt_util.remove_file(str(merged))
            wt_util.remove_file(str(merged))
            self.assertFalse(merged.exists())


if __name__ == '__main__':
    unittest.main()
