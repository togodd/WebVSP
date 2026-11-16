"""Pyodide entry point: final expression is the P1 JSON summary.

The host must inject p1_snapshot and install NumPy, six, the original native
helper modules and their utilities/degen_geom dependencies on sys.path.
"""
import p1_analysis

p1_analysis.run()
