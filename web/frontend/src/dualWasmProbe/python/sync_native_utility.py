# Copyright (c) 2018-2020 Uber Technologies, Inc.
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
# THE SOFTWARE.
import openvsp as vsp_module


def get_wing_reference_quantities(wing_name=None, wing_id=None, vsp_instance=None):
    """
    Gets wing reference area, reference span, and reference chord (sref, bref, cref) from the TotalArea, TotalSpan, and
    TotalChord properties of Wing component

    :param wing_name: Name of the wing (will find the first wing with this name)
    :param wing_id: ID of the wing object, if None wing name will be used to find the wing id. Wing ID takes precedence
        over wing_name
    :param vsp_instance: optional instance of vsp if using the multifacade
    :return: sref, bref, and cref
    """
    vsp = vsp_module.get_instance(vsp_instance)
    # Check that the wing_name and wing_id are not both none
    if wing_name is None and wing_id is None:
        raise ValueError("wing_name and wing_id cannot both be None")

    # If wing_id is None, then use wing name to find the wing id
    if wing_id is None:
        found_wing_id = vsp.FindGeom(wing_name, 0)
        if not found_wing_id:
            raise ValueError("could not find wing with name \"{}\"".format(wing_name))
        wing_id = found_wing_id

    # Get reference parameters
    # TODO: Error check that the wing_id is actually the id to a wing component
    bref = vsp.GetParmVal(wing_id, "TotalSpan", "WingGeom")
    sref = vsp.GetParmVal(wing_id, "TotalArea", "WingGeom")
    cref = vsp.GetParmVal(wing_id, "TotalChord", "WingGeom")

    return sref, bref, cref
