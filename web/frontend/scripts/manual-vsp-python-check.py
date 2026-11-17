"""WebVSP Python 控制台手测脚本。

用法：打开 http://localhost:8090/ → 顶栏「Python Console」→ 把本文件全部粘贴进去 → 回车。

脚本会清空当前内存模型，**运行前请先保存你的模型**。
每一项打印一行 PASS/FAIL，最后给出汇总。
把 `RUN_VSPAERO` 改成 True 会额外跑一次薄表面 VSPAERO（约 10-20 秒）。
"""

RUN_VSPAERO = False

import io
import json
import math

import openvsp as vsp

results = []


def check(name, action):
    try:
        detail = action()
        results.append((name, True, detail))
        print('PASS  %-38s %s' % (name, detail))
    except Exception as exc:                                  # noqa: BLE001 - 手测脚本要看到全部失败
        results.append((name, False, str(exc)))
        print('FAIL  %-38s %s: %s' % (name, type(exc).__name__, str(exc)[:160]))


def fresh():
    vsp.ClearVSPModel()


# ---------------------------------------------------------------- 1. 包
def numpy_check():
    import numpy as np
    a = np.arange(5.0) ** 2
    return 'sum=%g' % a.sum()


def scipy_check():
    from scipy.optimize import minimize_scalar
    r = minimize_scalar(lambda x: (x - 2.0) ** 2)
    return 'argmin=%.4f' % r.x


def pandas_check():
    import pandas as pd
    frame = pd.DataFrame({'cd': [0.0038, 0.0104]})
    return 'max_cd=%.4f' % frame['cd'].max()


def matplotlib_check():
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(2, 2))
    ax.plot([0.0, 1.0], [0.0, 1.0])
    buffer = io.BytesIO()
    fig.savefig(buffer, format='png')
    plt.close(fig)
    return 'png=%d bytes' % len(buffer.getvalue())


def constants_check():
    import Constants as const
    assert const.m_VSPSweepAnalysis == 'VSPAEROSweep'
    return 'colors=%d, SymFlag=%s' % (len(const.colors), const.m_SymFlagVec)


def file_check():
    from pathlib import Path
    folder = str(Path(__file__).parent)
    return '__file__ parent=%s' % folder


# ---------------------------------------------------------------- 2. 枚举与错误队列
def enum_check():
    assert vsp.ABS == 0 and vsp.REL == 1
    assert vsp.REORDER_MOVE_TOP == 2
    assert vsp.VSP_CANT_FIND_PARM > 0
    return 'ABS/REL=%d/%d, %d enums' % (vsp.ABS, vsp.REL, vsp._ENUM_COUNT)


def error_queue_check():
    manager = vsp.ErrorMgrSingleton.getInstance()
    manager.NoError()
    try:
        vsp.GetParmName('no-such-parm')
    except vsp.OpenVSPError:
        pass
    else:
        raise AssertionError('坏调用没有抛异常')
    count = manager.GetNumTotalErrors()
    err = manager.PopLastError()
    code = err.GetErrorCode()
    return 'queued=%d, code=%d (%s)' % (count, code, 'VSP_CANT_FIND_PARM' if code == vsp.VSP_CANT_FIND_PARM else 'other')


# ---------------------------------------------------------------- 3. 几何与自定义组件
def custom_geom_check():
    fresh()
    types = vsp.GetGeomTypes()
    assert 'TransportFuse' in types, '自定义组件未加载'
    geom = vsp.AddGeom('TransportFuse', '')
    vsp.Update()
    return 'type=%s, parms=%d' % (vsp.GetGeomTypeName(geom), len(vsp.GetGeomParmIDs(geom)))


def driver_group_check():
    fresh()
    wing = vsp.AddGeom('WING', '')
    # 5 个参数；3 参数的简写也能转发（原生默认值补齐），但原生会拒绝缺少配套
    # 驱动的组合，所以这里只用完整写法。
    vsp.SetDriverGroup(wing, 1, vsp.AR_WSECT_DRIVER, vsp.ROOTC_WSECT_DRIVER, vsp.TIPC_WSECT_DRIVER)
    vsp.Update()
    return 'aspect=%.3f' % vsp.GetParmVal(vsp.GetParm(wing, 'Aspect', 'XSec_1'))


def fea_check():
    fresh()
    pod = vsp.AddGeom('POD')
    vsp.Update()
    index = vsp.AddFeaStruct(pod)                          # 只用默认参数
    part = vsp.AddFeaPart(pod, index, vsp.FEA_SLICE)
    name = vsp.GetFeaStructName(pod, index)
    return 'struct=%d, part=%s, name=%s' % (index, 'ok' if part else 'none', name)


def attribute_check():
    fresh()
    pod = vsp.AddGeom('POD')
    vsp.Update()
    coll = vsp.GetChildCollection(pod)
    attr = vsp.AddAttributeDouble(coll, 'Mass', 12.5)
    values = vsp.GetAttributeDoubleVal(attr)
    return 'value=%s' % values


def measure_check():
    fresh()
    a = vsp.AddGeom('POD')
    b = vsp.AddGeom('POD')
    vsp.SetParmVal(b, 'Z_Rel_Location', 'XForm', 4.0)
    vsp.Update()
    ruler = vsp.AddRuler(a, 0, 0.2, 0.3, b, 0, 0.2, 0.3, 'Ruler')
    vsp.Update()
    distance = vsp.GetParmVal(vsp.FindParm(ruler, 'Distance', 'Measure'))
    return 'rulers=%d, distance=%.4f' % (len(vsp.GetAllRulers()), distance)


def point_cloud_check():
    points = [(0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (1.0, 0.0, 0.0)]
    unique = vsp.UniquePts(points, 1e-6)
    return 'unique=%d' % len(unique)


def surface_query_check():
    fresh()
    pod = vsp.AddGeom('POD')
    vsp.Update()
    point = vsp.CompPnt01(pod, 0, 0.3, 0.7)
    normal = vsp.CompNorm01(pod, 0, 0.3, 0.7)
    tangent = vsp.CompTanU01(pod, 0, 0.3, 0.7)
    return 'point=(%.3f,%.3f,%.3f), |n|=%.3f, |du|=%.3f' % (
        point.x(), point.y(), point.z(),
        math.sqrt(normal.x() ** 2 + normal.y() ** 2 + normal.z() ** 2),
        math.sqrt(tangent.x() ** 2 + tangent.y() ** 2 + tangent.z() ** 2))


def editable_curve_check():
    fresh()
    fuse = vsp.AddGeom('FUSELAGE')
    vsp.Update()
    surf = vsp.GetXSecSurf(fuse, 0)
    xsec = vsp.GetXSec(surf, 2)
    vsp.ChangeXSecShapeByID(xsec, vsp.XS_EDIT_CURVE)
    vsp.Update()
    points = vsp.GetEditXSecCtrlVec(xsec)
    return 'control points=%d' % len(points)


def file_roundtrip_check():
    fresh()
    vsp.AddGeom('WING')
    vsp.Update()
    path = '/work/manual-check/model.vsp3'
    vsp.WriteVSPFile(path, vsp.SET_ALL)
    vsp.ClearVSPModel()
    vsp.ReadVSPFile(path)
    return 'geoms after reload=%d' % len(vsp.FindGeoms())


# ---------------------------------------------------------------- 4. 可选：VSPAERO
def vspaero_check():
    fresh()
    wing = vsp.AddGeom('WING')
    vsp.Update()
    vsp.SetVSP3FileName('/work/manual-check/thin.vsp3')

    vsp.SetAnalysisInputDefaults('VSPAEROComputeGeometry')
    vsp.SetIntAnalysisInput('VSPAEROComputeGeometry', 'GeomSet', [vsp.SET_NONE], 0)
    vsp.SetIntAnalysisInput('VSPAEROComputeGeometry', 'ThinGeomSet', [vsp.SET_ALL], 0)
    vsp.ExecAnalysis('VSPAEROComputeGeometry')

    vsp.SetAnalysisInputDefaults('VSPAEROSweep')
    vsp.SetIntAnalysisInput('VSPAEROSweep', 'GeomSet', [vsp.SET_NONE], 0)
    vsp.SetIntAnalysisInput('VSPAEROSweep', 'ThinGeomSet', [vsp.SET_ALL], 0)
    vsp.SetIntAnalysisInput('VSPAEROSweep', 'AlphaNpts', [1])
    vsp.SetDoubleAnalysisInput('VSPAEROSweep', 'MachNpts', [1.0])   # 整型输入，double setter 也能接受
    root = vsp.ExecAnalysis('VSPAEROSweep')
    history = vsp.FindResultsID('VSPAERO_History', 0)
    cl = vsp.GetDoubleResults(history, 'CLtot', 0) if history else []
    return 'root=%s, CLtot=%s' % (bool(root), ['%.4f' % v for v in cl[-2:]])


# ---------------------------------------------------------------- 运行
print('WebVSP Python 手测（会清空当前模型）\n')

for name, action in (
    ('numpy', numpy_check),
    ('scipy', scipy_check),
    ('pandas', pandas_check),
    ('matplotlib (PNG)', matplotlib_check),
    ('Constants 模块', constants_check),
    ('__file__ 路径', file_check),
    ('原生枚举', enum_check),
    ('错误队列', error_queue_check),
    ('自定义组件', custom_geom_check),
    ('SetDriverGroup', driver_group_check),
    ('FEA 结构与部件', fea_check),
    ('属性', attribute_check),
    ('测量工具', measure_check),
    ('点云', point_cloud_check),
    ('表面查询', surface_query_check),
    ('可编辑曲线', editable_curve_check),
    ('文件往返', file_roundtrip_check),
):
    check(name, action)

if RUN_VSPAERO:
    check('VSPAERO 薄表面扫描', vspaero_check)

passed = sum(1 for _, ok, _ in results if ok)
print('\n汇总：%d/%d 通过' % (passed, len(results)))
if passed != len(results):
    print('失败项：')
    for name, ok, detail in results:
        if not ok:
            print('  - %s: %s' % (name, detail))
else:
    print('全部通过。')
