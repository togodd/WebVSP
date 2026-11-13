// From the repository root, link the real manager and its dependencies:
// g++ -std=c++11 -Isrc/geom_api -Isrc/util_api -Isrc/util \
//   web/wasm/tests/error_drain_real_test.cpp src/geom_api/APIErrorMgr.cpp \
//   src/util_api/MessageMgr.cpp src/util/StringUtil.cpp -o <test-executable>
#include "../engine/error_drain.h"
#include "APIErrorMgr.h"

#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

namespace
{
const char *const fallback = "OpenVSP parameter API error (no message)";

void Check( bool ok, const char *label )
{
    if ( !ok ) { std::cerr << "FAIL: " << label << '\n'; std::exit( 1 ); }
}

void Case( vsp::ErrorMgrSingleton &mgr, const std::vector<std::string> &entries,
           const std::string &expected, bool clear_flag_before_drain )
{
    Check( mgr.GetNumTotalErrors() == 0, "initial stack empty" );
    mgr.NoError();
    for ( const std::string &entry : entries ) mgr.AddError( vsp::VSP_CANT_FIND_PARM, entry );
    Check( mgr.GetNumTotalErrors() == static_cast<int>( entries.size() ), "queued count" );
    Check( mgr.GetErrorLastCallFlag() == !entries.empty(), "flag after add" );
    if ( clear_flag_before_drain ) mgr.NoError();
    const bool flag_before = mgr.GetErrorLastCallFlag();

    DrainedErrors result = DrainErrors( mgr, fallback );
    Check( result.had_errors == !entries.empty(), "presence" );
    Check( result.message == expected, "message/order" );
    Check( mgr.GetNumTotalErrors() == 0, "drain clears stack" );
    Check( mgr.GetErrorLastCallFlag() == flag_before, "drain preserves flag" );

    result = DrainErrors( mgr, fallback );
    Check( !result.had_errors && result.message.empty(), "second drain empty" );
    Check( mgr.GetNumTotalErrors() == 0, "second drain leaves stack empty" );
    Check( mgr.GetErrorLastCallFlag() == flag_before, "second drain preserves flag" );
}
}

int main()
{
    vsp::ErrorMgrSingleton &mgr = vsp::ErrorMgrSingleton::getInstance();
    mgr.SilenceErrors();
    const std::string f = fallback;
    Case( mgr, {}, "", false );
    Case( mgr, { "" }, f, false );
    Case( mgr, { "", "" }, f + "; " + f, false );
    Case( mgr, { "first", "second" }, "first; second", false );
    Case( mgr, { "", "diagnostic" }, f + "; diagnostic", false );
    Case( mgr, { "diagnostic", "" }, "diagnostic; " + f, false );
    Case( mgr, { "first", "", "last" }, "first; " + f + "; last", true );
    mgr.NoError();
    mgr.PrintOnErrors();
    std::cout << "real APIErrorMgr drain tests passed\n";
}
