#include "save_xml_event_queue.h"

#include <atomic>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

namespace
{
void check( bool condition, const char* message )
{
    if ( !condition )
    {
        std::cerr << "FAIL: " << message << '\n';
        std::abort();
    }
}

void basic_test()
{
    using Queue = webvsp::SaveXmlEventQueue<2, 4>;
    using Result = Queue::PushResult;
    Queue q;
    Queue::Event out;
    out.ok = true;
    check( !q.try_pop( out ) && out.ok, "empty pop leaves output unchanged" );
    check( q.try_push( "abcd", true ) == Result::accepted, "maximum path accepted" );
    const char binary[] = {'a', '\0', 'b'};
    check( q.try_push( std::string_view( binary, 3 ), false ) == Result::accepted, "binary path accepted" );
    check( q.try_push( "x", true ) == Result::full, "full reported" );
    check( q.try_push( "abcde", true ) == Result::path_too_long, "oversize reported when full" );
    check( q.try_pop( out ) && out.path_view() == "abcd" && out.ok, "first event intact" );
    check( q.try_push( "", true ) == Result::accepted, "wraparound and empty path" );
    check( q.try_pop( out ) && out.path_view() == std::string_view( binary, 3 ) && !out.ok, "second event intact" );
    check( q.try_pop( out ) && out.path_view().empty() && out.ok, "wrapped event intact" );
    check( !q.try_pop( out ), "queue drained" );
    check( q.try_push( "12345", true ) == Result::path_too_long, "oversize rejected when empty" );
    check( !q.try_pop( out ), "oversize did not enqueue" );
    const auto rejections = q.rejections();
    check( rejections.full == 1 && rejections.path_too_long == 2, "separate cumulative rejection counters" );
    webvsp::SaveXmlEventQueue<1, 0> zero_path;
    check( zero_path.try_push( "", false ) == decltype( zero_path )::PushResult::accepted, "zero path limit" );
}

void concurrent_test()
{
    using Queue = webvsp::SaveXmlEventQueue<16, 32>;
    Queue q;
    constexpr int producers = 4;
    constexpr int per_producer = 2000;
    std::atomic<int> finished{0};
    std::atomic<int> accepted{0};
    std::atomic<int> rejected{0};
    std::vector<std::thread> threads;
    for ( int p = 0; p < producers; ++p )
    {
        threads.emplace_back( [&, p] {
            for ( int i = 0; i < per_producer; ++i )
            {
                const auto path = std::to_string( p ) + ":" + std::to_string( i );
                auto result = q.try_push( path, ( i % 2 ) != 0 );
                if ( result == Queue::PushResult::accepted ) ++accepted;
                else if ( result == Queue::PushResult::full ) ++rejected;
                else check( false, "unexpected oversize" );
            }
            ++finished;
        } );
    }
    std::vector<std::vector<bool>> seen( producers, std::vector<bool>( per_producer, false ) );
    int consumed = 0;
    Queue::Event event;
    while ( true )
    {
        // Observe producer completion before the empty check: after all producers
        // finish, an empty pop proves no later event can be enqueued.
        const bool all_finished = finished.load() == producers;
        if ( q.try_pop( event ) )
        {
            const std::string path( event.path_view() );
            const auto colon = path.find( ':' );
            check( colon != std::string::npos, "valid concurrent path" );
            const int p = std::stoi( path.substr( 0, colon ) );
            const int i = std::stoi( path.substr( colon + 1 ) );
            check( p >= 0 && p < producers && i >= 0 && i < per_producer, "valid concurrent identifiers" );
            check( !seen[p][i] && event.ok == ( ( i % 2 ) != 0 ), "unique and consistent event" );
            seen[p][i] = true;
            ++consumed;
        }
        else if ( all_finished ) break;
        else std::this_thread::yield();
    }
    for ( auto& thread : threads ) thread.join();
    check( accepted + rejected == producers * per_producer, "all pushes reported" );
    check( consumed == accepted, "all accepted events consumed" );
}
} // namespace

int main()
{
    basic_test();
    concurrent_test();
    std::cout << "save XML event queue tests passed\n";
}
