# Adapted from OpenVSP src/python_api/packages/openvsp/openvsp/utilities.py.
# Copyright (c) 2018-2020 Uber Technologies, Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
# THE SOFTWARE.
import openvsp_wasm as vsp_module


async def get_wing_reference_quantities(wing_name=None, wing_id=None, vsp_instance=None):
    """Return (reference area, span, chord) for a wing in the current model.

    Async adaptation of the native utility. Multi-facade instances are not supported.
    """
    if vsp_instance is not None:
        raise ValueError("vsp_instance is not supported")
    vsp = vsp_module
    # Check that the wing_name and wing_id are not both none
    if wing_name is None and wing_id is None:
        raise ValueError("wing_name and wing_id cannot both be None")

    # If wing_id is None, then use wing name to find the wing id
    if wing_id is None:
        found_wing_id = await vsp.FindGeom(wing_name, 0)
        if not found_wing_id:
            raise ValueError("could not find wing with name \"{}\"".format(wing_name))
        wing_id = found_wing_id

    # Get reference parameters
    # TODO: Error check that the wing_id is actually the id to a wing component
    values = await vsp.GetGeomNamedParmValues(wing_id, ("TotalSpan", "TotalArea", "TotalChord"), "WingGeom")
    bref = values["TotalSpan"]
    sref = values["TotalArea"]
    cref = values["TotalChord"]

    return sref, bref, cref
