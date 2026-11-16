"""Example: the desktop OpenVSP Python workflow, run against WebVSP in the page.

Paste this into window.__runPython(`...`) (see the README). It uses the same
calls as desktop scripts: AddGeom, SetParmVal, Update, ExecAnalysis, result
getters, and the original degen_geom helper.
"""
import json

import openvsp as vsp
import degen_geom_parse

# --- Build a wing on the live page model --------------------------------
wing = vsp.AddGeom("WING")
vsp.SetParmVal(wing, "Span", "WingGeom", 12.0)
vsp.SetParmVal(wing, "TotalArea", "WingGeom", 24.0)
vsp.Update()

# --- Run a real analysis on that model (in this page's engine) ---------
vsp.SetAnalysisInputDefaults("DegenGeom")
vsp.SetIntAnalysisInput("DegenGeom", "Set", [vsp.SET_ALL])
root = vsp.ExecAnalysis("DegenGeom")

# --- Read results with the desktop result API --------------------------
names = vsp.GetAllDataNames(root)
objects = degen_geom_parse.parse_degen_geom(root)

summary = {
    "wing": wing,
    "geoms": vsp.FindGeoms(),
    "span": vsp.GetParmVal(wing, "Span", "WingGeom"),
    "root": root,
    "resultName": vsp.GetResultsName(root),
    "fields": names,
    "objectCount": len(objects),
    "objects": [{"name": o.name, "type": o.type.name, "geomId": o.geom_id} for o in objects],
    "degenIds": vsp.GetStringResults(root, "Degen_DegenGeoms"),
}
json.dumps(summary)
