// Standalone native test (from the repository root):
// c++ -std=c++11 -pthread src/util/WebProcess.cpp src/util/tests/WebProcessTest.cpp -o /tmp/webprocess-test && /tmp/webprocess-test
#include "../WebProcess.h"

#include <atomic>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

static void check( bool condition, const char *message )
{
    if ( !condition )
    {
        std::cerr << "FAIL: " << message << '\n';
        std::abort();
    }
}

int main()
{
    // Unknown ids remain harmless and cannot create a process.
    WebProcess::Exit( -100, 8 );
    check( !WebProcess::Running( -100 ) && WebProcess::ExitCode( -100 ) == -1, "unknown id" );

    int id = WebProcess::Start( "solver", {} );
    check( WebProcess::Running( id ) && WebProcess::ExitCode( id ) == -1, "initial state" );
    WebProcess::Output( id, "before" );
    WebProcess::Exit( id, 42 );
    check( !WebProcess::Running( id ) && WebProcess::ExitCode( id ) == 42, "first exit" );
    WebProcess::Exit( id, 9 );
    check( WebProcess::ExitCode( id ) == 42, "duplicate exit" );
    WebProcess::Output( id, "after" ); // Output behavior after exit is unchanged.
    char buf[32];
    int n = WebProcess::Read( id, buf, sizeof( buf ) );
    check( std::string( buf, n ) == "beforeafter", "output preserved" );

    // -1 is a valid reported exit code, not a substitute for the running flag.
    id = WebProcess::Start( "solver", {} );
    WebProcess::Exit( id, -1 );
    WebProcess::Exit( id, 0 );
    check( !WebProcess::Running( id ) && WebProcess::ExitCode( id ) == -1, "exit code -1" );

    // Simultaneously race different exit codes. Every caller must observe the same
    // winner after returning, and subsequent exits cannot replace that winner.
    const int count = 8;
    for ( int round = 0; round < 100; ++round )
    {
        id = WebProcess::Start( "solver", {} );
        std::atomic< int > ready( 0 );
        std::atomic< bool > go( false );
        int observed[count];
        std::vector< std::thread > threads;
        for ( int i = 0; i < count; ++i )
        {
            threads.emplace_back( [&, i] {
                ++ready;
                while ( !go.load() ) std::this_thread::yield();
                WebProcess::Exit( id, i + 1 );
                observed[i] = WebProcess::ExitCode( id );
            } );
        }
        while ( ready.load() != count ) std::this_thread::yield();
        go.store( true );
        for ( auto &thread : threads ) thread.join();
        int winner = WebProcess::ExitCode( id );
        check( !WebProcess::Running( id ) && winner >= 1 && winner <= count, "race winner" );
        for ( int result : observed ) check( result == winner, "race exit overwritten" );
        WebProcess::Exit( id, 99 );
        check( WebProcess::ExitCode( id ) == winner, "race winner retained" );
    }
    std::cout << "WebProcess tests passed\n";
}
