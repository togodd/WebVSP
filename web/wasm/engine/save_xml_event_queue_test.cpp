#include "save_xml_event_queue.h"

#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>
#include <utility>
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

void deterministic_rejection_and_reuse_test()
{
    using Queue = webvsp::SaveXmlEventQueue<2, 3>;
    using Result = Queue::PushResult;
    Queue q;
    Queue::Event out;
    check( q.try_push( "abc", true ) == Result::accepted, "boundary path accepted" );
    check( q.try_push( "b", false ) == Result::accepted, "queue filled" );
    check( q.try_push( "c", true ) == Result::full, "first full rejection" );
    check( q.try_push( "d", true ) == Result::full, "second full rejection" );
    check( q.try_push( "abcd", true ) == Result::path_too_long, "oversize wins when full" );
    auto counts = q.rejections();
    check( counts.full == 2 && counts.path_too_long == 1, "rejections counted separately" );
    counts = q.rejections();
    check( counts.full == 2 && counts.path_too_long == 1, "reading counts does not reset them" );
    check( q.try_pop( out ) && out.path_view() == "abc" && out.ok, "first accepted event preserved" );
    check( q.try_push( "e", true ) == Result::accepted, "drained slot reused" );
    check( q.try_pop( out ) && out.path_view() == "b" && !out.ok, "second accepted event preserved" );
    check( q.try_pop( out ) && out.path_view() == "e" && out.ok, "reused slot follows older event" );
    check( !q.try_pop( out ), "reused queue drained" );
    check( q.try_push( "abcd", false ) == Result::path_too_long, "oversize rejected when empty" );
    counts = q.rejections();
    check( counts.full == 2 && counts.path_too_long == 2, "counts persist after drain and reuse" );
    check( !q.try_pop( out ), "rejected oversize leaves queue empty" );

    using ZeroQueue = webvsp::SaveXmlEventQueue<1, 0>;
    ZeroQueue zero;
    check( zero.try_push( "x", false ) == ZeroQueue::PushResult::path_too_long,
           "nonempty path rejected with zero limit" );
    check( zero.try_push( "", true ) == ZeroQueue::PushResult::accepted,
           "empty path accepted with zero limit" );
    ZeroQueue::Event zero_out;
    check( zero.try_pop( zero_out ) && zero_out.path_view().empty() && zero_out.ok,
           "zero-limit event intact" );
    const auto zero_counts = zero.rejections();
    check( zero_counts.full == 0 && zero_counts.path_too_long == 1,
           "zero-limit rejection counted" );
}

void byte_and_copy_boundaries_test()
{
    using Queue = webvsp::SaveXmlEventQueue<1, 4>;
    using Result = Queue::PushResult;
    Queue q;
    Queue::Event out;
    out.path = {'s', '\0', static_cast<char>( 0xff ), 't'};
    out.path_size = 3;
    out.ok = true;
    const auto sentinel = out;
    check( !q.try_pop( out ) && out.path == sentinel.path &&
           out.path_size == sentinel.path_size && out.ok == sentinel.ok,
           "empty pop preserves every output field and byte" );

    const char bytes[] = {'\0', static_cast<char>( 0xff ), static_cast<char>( 0x80 ), '\0'};
    const std::string_view path( bytes, sizeof bytes );
    check( q.try_push( path, false ) == Result::accepted, "maximum length arbitrary bytes accepted" );
    check( q.try_pop( out ) && out.path_view() == path && !out.ok,
           "NUL and non-UTF8 bytes preserved at maximum length" );
    const auto saved = out;
    const auto saved_view = out.path_view();
    check( q.try_push( "next", true ) == Result::accepted, "reuse popped slot" );
    check( out.path == saved.path && out.path_size == saved.path_size && out.ok == saved.ok &&
           saved_view == path, "slot reuse does not alter popped event or its view" );
    out.path[0] = 'X';
    out.path_size = 1;
    out.ok = false;
    Queue::Event next;
    check( q.try_pop( next ) && next.path_view() == "next" && next.ok,
           "modifying popped copy does not alter queued event" );
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
    std::atomic<int> too_long{0};
    std::vector<std::thread> threads;
    for ( int p = 0; p < producers; ++p )
    {
        threads.emplace_back( [&, p] {
            for ( int i = 0; i < per_producer; ++i )
            {
                if ( i % 10 == 0 )
                {
                    const auto result = q.try_push( std::string( 33, 'x' ), false );
                    check( result == Queue::PushResult::path_too_long, "concurrent oversize rejected" );
                    ++too_long;
                }
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
    std::vector<int> last( producers, -1 );
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
            check( i > last[p], "each producer's accepted events are FIFO" );
            last[p] = i;
            seen[p][i] = true;
            ++consumed;
        }
        else if ( all_finished ) break;
        else std::this_thread::yield();
    }
    for ( auto& thread : threads ) thread.join();
    check( accepted + rejected == producers * per_producer, "all pushes reported" );
    check( consumed == accepted, "all accepted events consumed" );
    const auto counts = q.rejections();
    check( counts.full == static_cast<std::uint64_t>( rejected.load() ) &&
           counts.path_too_long == static_cast<std::uint64_t>( too_long.load() ),
           "concurrent rejection counters match returned results" );
}

void multiple_consumers_test()
{
    using Queue = webvsp::SaveXmlEventQueue<16, 32>;
    constexpr int producers = 4;
    constexpr int consumers = 4;
    constexpr int per_producer = 2000;
    Queue q;
    std::atomic<int> finished{0};
    // Each producer owns one row; readers inspect it only after all joins.
    std::vector<std::vector<unsigned char>> accepted( producers, std::vector<unsigned char>( per_producer, 0 ) );
    // Each consumer owns its output vector, avoiding shared packed bits and locks.
    std::vector<std::vector<std::pair<int, int>>> received( consumers );
    std::vector<std::thread> threads;
    for ( int p = 0; p < producers; ++p )
    {
        threads.emplace_back( [&, p] {
            for ( int i = 0; i < per_producer; ++i )
            {
                const auto path = std::to_string( p ) + ":" + std::to_string( i );
                const auto result = q.try_push( path, ( i % 2 ) != 0 );
                if ( result == Queue::PushResult::accepted ) accepted[p][i] = 1;
                else check( result == Queue::PushResult::full, "unexpected oversize in multi-consumer test" );
            }
            ++finished;
        } );
    }
    for ( int c = 0; c < consumers; ++c )
    {
        threads.emplace_back( [&, c] {
            Queue::Event event;
            while ( true )
            {
                const bool all_finished = finished.load() == producers;
                if ( q.try_pop( event ) )
                {
                    const std::string path( event.path_view() );
                    const auto colon = path.find( ':' );
                    check( colon != std::string::npos, "valid multi-consumer path" );
                    const int p = std::stoi( path.substr( 0, colon ) );
                    const int i = std::stoi( path.substr( colon + 1 ) );
                    check( p >= 0 && p < producers && i >= 0 && i < per_producer,
                           "valid multi-consumer identifiers" );
                    check( event.ok == ( ( i % 2 ) != 0 ), "multi-consumer payload intact" );
                    received[c].emplace_back( p, i );
                }
                else if ( all_finished ) break;
                else std::this_thread::yield();
            }
        } );
    }
    for ( auto& thread : threads ) thread.join();
    std::vector<std::vector<int>> seen( producers, std::vector<int>( per_producer, 0 ) );
    for ( const auto& events : received )
        for ( const auto& id : events ) ++seen[id.first][id.second];
    for ( int p = 0; p < producers; ++p )
        for ( int i = 0; i < per_producer; ++i )
            check( seen[p][i] == accepted[p][i], "accepted events consumed exactly once; rejected never consumed" );
}
} // namespace

int main()
{
    basic_test();
    deterministic_rejection_and_reuse_test();
    byte_and_copy_boundaries_test();
    concurrent_test();
    multiple_consumers_test();
    std::cout << "save XML event queue tests passed\n";
}
