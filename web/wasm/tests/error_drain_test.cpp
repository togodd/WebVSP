// Standalone native test; no OpenVSP, Emscripten, or third-party libraries needed.
#include "../engine/error_drain.h"
#include <cstdlib>
#include <iostream>
#include <vector>

struct Error
{
    std::string text;
    std::string GetErrorString() { return text; }
};

struct Manager
{
    std::vector<Error> stack;
    int GetNumTotalErrors() { return static_cast<int>( stack.size() ); }
    Error PopLastError() { Error e = stack.back(); stack.pop_back(); return e; }
    void Add( const char *text ) { stack.push_back( Error{ text } ); }
};

void Check( bool ok, const char *label )
{
    if ( !ok ) { std::cerr << "FAIL: " << label << '\n'; std::exit( 1 ); }
}

const char *const fallback = "OpenVSP parameter API error (no message)";

void Case( const std::vector<const char *> &entries, const std::string &expected )
{
    Manager mgr;
    for ( const char *entry : entries ) mgr.Add( entry );
    DrainedErrors result = DrainErrors( mgr, fallback );
    Check( result.had_errors == !entries.empty(), "presence" );
    Check( result.message == expected, "message/order" );
    Check( mgr.GetNumTotalErrors() == 0, "drain clears stack" );
    DrainedErrors again = DrainErrors( mgr, fallback );
    Check( !again.had_errors && again.message.empty(), "second drain empty" );
}

// These fakes throw at explicitly defined points, not inside real manager methods.
struct FakeException {};

enum class ThrowPoint { count_after_pop, pop_before_removal, string_after_removal };

struct ThrowingError
{
    std::string text;
    bool should_throw;
    FakeException *exception;
    std::string GetErrorString()
    {
        if ( should_throw ) throw exception;
        return text;
    }
};

struct ThrowingManager
{
    std::vector<std::string> stack = { "first", "second", "third" };
    ThrowPoint point;
    FakeException exception;
    int count_calls = 0;
    int pop_calls = 0;

    explicit ThrowingManager( ThrowPoint p ) : point( p ) {}
    int GetNumTotalErrors()
    {
        if ( ++count_calls == 2 && point == ThrowPoint::count_after_pop ) throw &exception;
        return static_cast<int>( stack.size() );
    }
    ThrowingError PopLastError()
    {
        ++pop_calls;
        if ( pop_calls == 2 && point == ThrowPoint::pop_before_removal ) throw &exception;
        std::string text = stack.back();
        stack.pop_back();
        return { text, pop_calls == 2 && point == ThrowPoint::string_after_removal, &exception };
    }
};

void ExceptionCase( ThrowPoint point, const std::vector<std::string> &remaining )
{
    ThrowingManager mgr( point );
    bool caught = false;
    try
    {
        (void)DrainErrors( mgr, fallback );
    }
    catch ( FakeException *exception )
    {
        caught = true;
        Check( exception == &mgr.exception, "same exception propagated" );
    }
    Check( caught, "fake exception propagated" );
    Check( mgr.stack == remaining, "remaining fake stack" );
}

// This models the caller contract; it is not an integration test of engine.cpp.
std::string Phase( Manager &mgr, bool setter_started )
{
    DrainedErrors errors = DrainErrors( mgr, fallback );
    if ( !errors.had_errors ) return "success";
    return setter_started ? "unknown" : "not_written";
}

int main()
{
    const std::string f = fallback;
    Case( {}, "" );
    Case( { "" }, f );
    Case( { "", "" }, f + "; " + f );
    Case( { "first", "second" }, "first; second" );
    Case( { "", "diagnostic" }, f + "; diagnostic" );
    Case( { "diagnostic", "" }, "diagnostic; " + f );
    Case( { "first", "", "last" }, "first; " + f + "; last" );

    ExceptionCase( ThrowPoint::count_after_pop, { "first", "second" } );
    ExceptionCase( ThrowPoint::pop_before_removal, { "first", "second" } );
    ExceptionCase( ThrowPoint::string_after_removal, { "first" } );

    Manager mgr;
    mgr.Add( "" );
    Check( Phase( mgr, false ) == "not_written", "preflight error" );
    mgr.Add( "" );
    Check( Phase( mgr, true ) == "unknown", "setter error" );
    mgr.Add( "" );
    Check( Phase( mgr, true ) == "unknown", "readback error" );
    Check( Phase( mgr, false ) == "success", "clean phase" );
    std::cout << "error drain tests passed\n";
}
