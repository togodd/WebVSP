"""Characterise the bundled original atmosphere/rotor calculators on host CPython.

The modules are shipped byte-identical to upstream and load SciPy in the browser
on demand. This host run checks the numeric behaviour the browser should
reproduce; it is not a Pyodide execution.
"""
import math
import sys
import unittest
from pathlib import Path

import numpy as np

native = Path(__file__).resolve().parents[1] / 'src/dualWasmProbe/python/packages'
sys.path.insert(0, str(native / 'utilities'))

import utilities.atmosphere as atm  # noqa: E402
import utilities.simple_rotor_calcs as rotor  # noqa: E402
import utilities.units as units  # noqa: E402


class AtmosphereTest(unittest.TestCase):
    def test_sea_level_and_stratosphere(self):
        std = atm.stdatm1976(0.0)
        self.assertAlmostEqual(float(std.T(0.0)), 288.15, places=6)
        self.assertAlmostEqual(float(std.P(0.0)), 101325.0, places=3)
        self.assertAlmostEqual(float(std.rho(0.0)), 1.225, places=6)
        self.assertAlmostEqual(float(std.sos(0.0)), 340.294, places=5)
        # Geometric 10 km becomes ~9.98 km geopotential; values match the 1976 tables.
        self.assertAlmostEqual(float(std.T(10000.0)), 223.25, delta=0.2)
        self.assertAlmostEqual(float(std.P(10000.0)), 26499.7, delta=60.0)
        self.assertAlmostEqual(float(std.rho(10000.0)), 0.4135, delta=0.003)

    def test_off_standard_days(self):
        for cls in (atm.Hot, atm.Cold, atm.Tropical, atm.Polar):
            self.assertGreater(float(cls().rho(1000.0)), 0.0, cls.__name__)

    def test_integer_vector_input_truncates_ratios_upstream(self):
        std = atm.stdatm1976(0.0)
        floats = std.getRatios(np.array([0.0, 1000.0]))
        self.assertGreater(float(floats[1][1]), 0.8)
        # Upstream seeds its ratio arrays with the input dtype, so integer input
        # truncates sigma/delta to 0 at altitude. Characterised, not patched:
        # the bundled source stays byte-identical.
        ints = std.getRatios(np.array([0, 1000], dtype=int))
        self.assertEqual(int(ints[1][1]), 0)

    def test_density_altitude_round_trip(self):
        std = atm.stdatm1976(0.0)
        for altitude in (2000.0, 5000.0):
            density_alt = atm.geomAlt2DensAlt(std, altitude)
            self.assertAlmostEqual(float(atm.densAlt2GeomAlt(std, density_alt)), altitude, delta=1.0)
        # Sea level is outside what upstream's Newton solve accepts: it steps to a
        # negative geopotential altitude. Characterised as an upstream limitation.
        with self.assertRaises(ValueError):
            atm.geomAlt2DensAlt(std, 0.0)


class RotorTest(unittest.TestCase):
    def test_ct_uses_slug_per_cubic_foot(self):
        std = atm.stdatm1976(0.0)
        rpm, radius_ft, thrust_lb = 2000.0, 5.0, 1000.0
        omega = rpm * units.rpm2rad_s
        rho_slugcf = float(std.rho(0.0)) * units.kgcm2slugcf
        expected = thrust_lb / (rho_slugcf * math.pi * radius_ft ** 2 * (omega * radius_ft) ** 2)
        self.assertAlmostEqual(float(rotor.ct(thrust_lb, 0.0, rpm, radius_ft)), expected, delta=expected * 1e-9)
        self.assertGreater(float(rotor.cq(100.0, 0.0, rpm, radius_ft)), 0.0)


if __name__ == '__main__':
    unittest.main()
