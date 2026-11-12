// Test-only SetFromDevice reentry injection. Never available in production builds.
#pragma once

#ifdef WEBVSP_PARM_REENTRY_TEST
class Parm;

namespace webvsp
{
using ParmReentryCallback = void (*)( Parm*, void* );

// Owner thread only. Replaces the current arm; a null target or callback clears it.
// The target and context must remain alive until the arm fires or is cleared.
// If it fires, the target and its container must remain alive until the enclosing
// SetFromDevice returns. The callback must not delete either; exceptions escape
// after the value changed and can leave undo and notifications incomplete.
// A later arm replaces the earlier one; unconditional clearing can cancel it.
void ArmParmReentry( Parm* target, ParmReentryCallback callback, void* context );
}
#endif
