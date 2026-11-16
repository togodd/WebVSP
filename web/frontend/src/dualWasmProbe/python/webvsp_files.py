"""Browser file bridge for the live Python console.

The worker registers a small JS module; these wrappers keep the public surface
small and convert JS strings to Python ``str``. Use top-level ``await`` in the
console or a script::

    import webvsp_files
    path = await webvsp_files.open_into_engine()
    vsp.ReadVSPFile(path)

    vsp.WriteVSPFile('/home/web_user/model.vsp3')
    await webvsp_files.save_from_engine('/home/web_user/model.vsp3')
"""
import _webvsp_files_js


async def open_into_engine():
    """Ask the page for a model file and copy it into the engine file system."""
    return str(await _webvsp_files_js.open_into_engine())


async def save_from_engine(path, name=''):
    """Hand a file the engine wrote to the user (save picker or download)."""
    await _webvsp_files_js.save_from_engine(str(path), str(name))
