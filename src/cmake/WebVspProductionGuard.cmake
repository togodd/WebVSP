# Release-only guard for compiler-wide flags and toolchain-provided definitions.
OPTION( WEBVSP_PRODUCTION_BUILD "Reject test hooks in production builds" OFF )

FUNCTION( WEBVSP_CHECK_PRODUCTION_BUILD )
    IF( NOT WEBVSP_PRODUCTION_BUILD )
        RETURN()
    ENDIF()
    IF( WEBVSP_PARM_REENTRY_TEST OR WEBVSP_SCRIPT_GUARD_TEST OR WEBVSP_DELETE_GEOM_PROXY_TEST )
        MESSAGE( FATAL_ERROR "WEBVSP_PRODUCTION_BUILD forbids test-hook options" )
    ENDIF()

    INCLUDE( CheckCXXSourceCompiles )
    INCLUDE( CMakePushCheckState )
    # Other feature checks may have set CMAKE_REQUIRED_* for their own probes;
    # these values are not necessarily applied to production targets.
    CMAKE_PUSH_CHECK_STATE( RESET )
    # Functions scope these changes: never link an executable and always test the
    # Release flags even for multi-config generators or another active build type.
    SET( CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY )
    SET( CMAKE_TRY_COMPILE_CONFIGURATION Release )
    # Do not trust a result left by a previous configure (including a failed one).
    UNSET( WEBVSP_PRODUCTION_MACROS_CLEAN CACHE )
    UNSET( WEBVSP_PRODUCTION_MACROS_CLEAN )
    CHECK_CXX_SOURCE_COMPILES( "
#if defined(WEBVSP_SCRIPT_GUARD_TEST) || defined(WEBVSP_PARM_REENTRY_TEST) || defined(WEBVSP_DELETE_GEOM_PROXY_TEST)
#error WebVSP test hooks are forbidden in production
#endif
int webvsp_production_guard() { return 0; }
" WEBVSP_PRODUCTION_MACROS_CLEAN )
    CMAKE_POP_CHECK_STATE()
    IF( NOT WEBVSP_PRODUCTION_MACROS_CLEAN )
        MESSAGE( FATAL_ERROR "WEBVSP_PRODUCTION_BUILD compiler check failed: test hooks may be defined or the compiler cannot compile. Inspect the CMake configure log." )
    ENDIF()
ENDFUNCTION()
