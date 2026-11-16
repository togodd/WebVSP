"""Exercise the bundled upstream logging adapter without a network or Pyodide."""
import io
import logging
import sys
from pathlib import Path

native = Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python/packages'
sys.path.insert(0, str(native / 'utilities'))
from utilities.uberlogging import StyleAdapter

stream = io.StringIO()
logger = logging.getLogger('webvsp.native.uberlogging.test')
logger.handlers.clear()
logger.propagate = False
logger.setLevel(logging.INFO)
handler = logging.StreamHandler(stream)
handler.setFormatter(logging.Formatter('%(message)s'))
logger.addHandler(handler)

adapter = StyleAdapter(logger)
adapter.info('percent %s', 'works')
adapter.info('brace {}', 'works', style='{')
StyleAdapter(logger, default_style='{').info('default {}', 'works')
assert stream.getvalue().splitlines() == ['percent works', 'brace works', 'default works']
logger.removeHandler(handler)
handler.close()
print('Bundled native uberlogging adapter works')
