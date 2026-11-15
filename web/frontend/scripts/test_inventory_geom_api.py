import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name('inventory-geom-api.py')
spec = importlib.util.spec_from_file_location('inventory_geom_api', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ParserTests(unittest.TestCase):
    def test_multiline_signatures_and_groups(self):
        source = '''/* ignored extern void Fake(); */
/** \\ingroup GroupA */
extern std::vector<std::string> First(
    const std::string & value = "a;()"
);
/** \\ingroup GroupA */
extern void Same(int value);
/** \\ingroup GroupB */
extern void Same(double value);
'''
        records = module.parse_header(source)
        self.assertEqual([r['name'] for r in records], ['First', 'Same', 'Same'])
        self.assertEqual(records[0]['line_start'], 3)
        self.assertEqual(records[0]['line_end'], 5)
        self.assertEqual(records[0]['doxygen_group'], 'GroupA')
        self.assertEqual(records[1]['doxygen_group'], 'GroupA')
        self.assertEqual(records[2]['doxygen_group'], 'GroupB')
        self.assertIn('"a;()"', records[0]['signature'])

    def test_comment_and_literal_extern_text_is_not_declaration(self):
        source = '''const char *text = "extern void StringFake();";
// extern void LineFake();
/* extern void BlockFake(); */
extern bool Real(const char * value);
'''
        records = module.parse_header(source)
        self.assertEqual([r['name'] for r in records], ['Real'])

    def test_ambiguous_group_is_unknown(self):
        source = '''/** \\ingroup A \\ingroup B */
extern void Ambiguous();
'''
        self.assertIsNone(module.parse_header(source)[0]['doxygen_group'])

    def test_unterminated_declaration_fails(self):
        with self.assertRaises(ValueError):
            module.parse_header('extern void Broken(')


class InventoryTests(unittest.TestCase):
    def test_real_inventory_has_honest_scope_and_sync_limited_marks(self):
        data = module.build_inventory(module.ROOT)
        self.assertGreater(data['counts']['declarations'], 900)
        self.assertGreater(data['counts']['distinct_names'], 900)
        self.assertIn('limitations', data['scope'])
        self.assertEqual(data['counts']['sync_distinct_names'], 10)
        self.assertLess(data['counts']['python_names_matching_header'], data['counts']['distinct_names'])
        add = next(item for item in data['functions'] if item['name'] == 'AddGeom')
        self.assertEqual(add['sync_name_coverage'], 'present_limited')
        self.assertTrue(any(use['path'].endswith('test_degen_geom.py') for use in add['python_uses']))

    def test_check_drift_passes_for_checked_in_reports(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), '--check'],
            cwd=module.ROOT,
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_check_detects_missing_and_modified_reports_without_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for relative in (module.HEADER, module.SYNC, module.JSON_OUT):
                (root / relative).parent.mkdir(parents=True, exist_ok=True)
            (root / module.PACKAGES).mkdir(parents=True, exist_ok=True)
            (root / module.HEADER).write_text('extern void Foo();\nextern void Unused();\n')
            (root / module.SYNC).write_text(json.dumps({'apis': [{'name': 'Foo'}]}))
            (root / module.PACKAGES / 'test.py').write_text('vsp.Foo()\nhelper.Bar()\n')
            old_root = module.ROOT
            try:
                module.ROOT = root
                self.assertEqual(module.main(['--check']), 1)
                self.assertEqual(module.main([]), 0)
                synthetic = json.loads((root / module.JSON_OUT).read_text())
                self.assertEqual(synthetic['counts']['python_names_matching_header'], 1)
                self.assertEqual(module.main(['--check']), 0)
                report = root / module.JSON_OUT
                report.write_text('drift\n')
                self.assertEqual(module.main(['--check']), 1)
                self.assertEqual(report.read_text(), 'drift\n')
            finally:
                module.ROOT = old_root


if __name__ == '__main__':
    unittest.main()
