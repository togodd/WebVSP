// White-box test of the production implementation, compiled only by explicit target.
// Replace its ResultsMgr expression only in this translation unit. The proxy
// forwards to the real manager except at explicitly armed failure points.
#include "VSP_Geom_API.h"
#include "APIErrorMgr.h"
#include "ResultsMgr.h"
#include <stdexcept>
#include <cstdio>

namespace test_injection
{
int enumerate_calls = 0, delete_calls = 0, fail_enumerate_from = 0, fail_delete_from = 0, published = 0;
vector<string> delete_attempts, deleted_ids;
struct Manager
{
    vector<string> GetAllResultsIDs()
    {
        if ( ++enumerate_calls >= fail_enumerate_from && fail_enumerate_from ) throw std::runtime_error( "injected enumeration failure" );
        return ResultsMgrSingleton::getInstance().GetAllResultsIDs();
    }
    void DeleteResult( const string &id )
    {
        delete_attempts.push_back( id );
        if ( ++delete_calls >= fail_delete_from && fail_delete_from ) throw std::runtime_error( "injected deletion failure" );
        ResultsMgrSingleton::getInstance().DeleteResult( id );
        deleted_ids.push_back( id );
    }
    Results *FindResultsPtr( const string &id ) { return ResultsMgrSingleton::getInstance().FindResultsPtr( id ); }
} manager;
void reset() { enumerate_calls = delete_calls = fail_enumerate_from = fail_delete_from = published = 0; delete_attempts.clear(); deleted_ids.clear(); }
// The only printf in the included implementation publishes the success line.
const char *capture_publish( const char *, const char * ) { ++published; return ""; }
}
#undef ResultsMgr
#define ResultsMgr test_injection::manager
#define printf(...) printf("%s", test_injection::capture_publish(__VA_ARGS__))
#define main p1_analysis_production_main
#include "p1_analysis.cpp"
#undef main
#undef printf
#undef ResultsMgr
#define ResultsMgr ResultsMgrSingleton::getInstance()

#include <cstdlib>
#include <limits>
#include <type_traits>
static_assert( !std::is_copy_constructible<OwnedResults>::value && !std::is_move_constructible<OwnedResults>::value,
               "OwnedResults must not have multiple owners" );
static_assert( std::is_nothrow_destructible<OwnedResults>::value, "cleanup guard must not throw during unwinding" );

static void require( bool ok, const char *what )
{
    if ( !ok ) { std::fprintf( stderr, "FAIL: %s\n", what ); std::exit( 1 ); }
}

template<class F> static void fails( F f, const char *message )
{
    try { f(); }
    catch ( const std::runtime_error &e ) { require( string( e.what() ) == message, message ); return; }
    require( false, message );
}

int main()
{
    {
        Writer w;
        w.add( string( MAX_BYTES - 1, 'a' ) ); w.add( "b" );
        require( w.data.size() == MAX_BYTES && w.data.back() == 'b', "exact byte limit" );
        fails( [&] { w.add( "x" ); }, "snapshot byte budget exceeded" );
        require( w.data.size() == MAX_BYTES, "rejected add is atomic" );
    }
    {
        Writer w;
        w.quote( string( "\"\\\n\t\0", 5 ) + "\xc3\xa9" );
        require( w.data == "\"\\\"\\\\\\u000a\\u0009\\u0000\xc3\xa9\"", "escaping and UTF-8 bytes" );
        Writer b; b.add( string( MAX_BYTES - 6, 'x' ) );
        fails( [&] { b.quote( "\n" ); }, "snapshot byte budget exceeded" );
    }
    {
        Writer w; w.values = MAX_VALUES - 1; w.integer( -7 );
        require( w.values == MAX_VALUES && w.data == "-7", "exact value limit" );
        fails( [&] { w.text( "x" ); }, "snapshot value budget exceeded" );
        Writer a; vector<int> at( MAX_VALUES, 0 );
        a.array( at, [&]( int x ) { a.integer( x ); } );
        require( a.values == MAX_VALUES && a.data.size() == 2 * MAX_VALUES + 1, "array exact limit" );
        at.push_back( 0 ); Writer b;
        fails( [&] { b.array( at, [&]( int x ) { b.integer( x ); } ); }, "snapshot array budget exceeded" );
        require( b.data.empty(), "oversized array rejected before writing" );
        Writer c; c.values = MAX_VALUES - 1;
        fails( [&] { c.array( vector<int>{1, 2}, [&]( int x ) { c.integer( x ); } ); }, "snapshot value budget exceeded" );
        for ( double n : { std::numeric_limits<double>::infinity(), -std::numeric_limits<double>::infinity(), std::numeric_limits<double>::quiet_NaN() } )
        {
            Writer d; fails( [&] { d.number( n ); }, "non-finite result value" );
        }
    }
    {
        NameValData ints( "i", vector<int>{1, -2}, "" );
        NameValData doubles( "d", vector<double>{1.5, -2}, "" );
        NameValData strings( "s", vector<string>{"a\"", "b"}, "" );
        NameValData points( "p", vector<vec3d>{vec3d( 1, 2, 3 )}, "" );
        NameValData im( "im", vector<vector<int>>{{1, 2}, {}, {-3}}, "" );
        NameValData dm( "dm", vector<vector<double>>{{1.5}, {2.25}}, "" );
        Writer w; w.field( ints ); w.field( doubles ); w.field( strings ); w.field( points ); w.field( im ); w.field( dm );
        require( w.data == "[1,-2][1.5,-2][\"a\\\"\",\"b\"][[1,2,3]][[1,2],[],[-3]][[1.5],[2.25]]", "all supported field types" );
        require( w.values == 14, "nested elements count as values" );
        ints.SetType( -999 );
        fails( [&] { w.field( ints ); }, "unsupported result data type" );
    }
    {
        Results *r = ResultsMgr.CreateResults( "test", "" );
        require( r != nullptr, "create result" );
        const string id = r->GetID();
        r->Add( new NameValData( "entry", vector<int>{3, 4}, "" ) );
        const string baseline = snapshot( "M", "A", id, {id} );
        require( baseline.find( "\"value\":[3,4]" ) != string::npos, "snapshot serializes real field" );
        const size_t padding = MAX_BYTES - baseline.size();
        require( snapshot( string( padding + 1, 'M' ), "A", id, {id} ).size() == MAX_BYTES, "snapshot exact byte limit" );
        fails( [&] { snapshot( string( padding + 2, 'M' ), "A", id, {id} ); }, "snapshot byte budget exceeded" );
        vector<string> ids( MAX_RESULTS, id );
        require( !snapshot( "M", "A", id, ids ).empty(), "exact results cap" );
        ids.push_back( id );
        fails( [&] { snapshot( "M", "A", id, ids ); }, "snapshot results budget exceeded" );
        fails( [&] { snapshot( "M", "A", "missing", {id} ); }, "analysis root missing" );
        fails( [&] { snapshot( "M", "A", "missing", {"missing"} ); }, "result disappeared" );
        ResultsMgr.DeleteResult( id );
    }
    {
        // Reuse one actual result to exercise the global field budget without
        // allocating 100,000 distinct ResultsMgr records or exceeding MAX_RESULTS.
        Results *r = ResultsMgr.CreateResults( "fields", "" );
        const string id = r->GetID();
        for ( int i = 0; i < 25; ++i ) r->Add( new NameValData( "x", vector<int>{}, "" ) );
        vector<string> ids( MAX_FIELDS / 25, id );
        require( !snapshot( "M", "A", id, ids ).empty(), "exact global fields cap" );
        ids.push_back( id );
        fails( [&] { snapshot( "M", "A", id, ids ); }, "snapshot fields budget exceeded" );
        ResultsMgr.DeleteResult( id );
    }
    {
        Results *existing = ResultsMgr.CreateResults( "existing", "" );
        require( existing != nullptr, "create existing result" );
        const string existing_id = existing->GetID();
        string owned_id;
        {
            OwnedResults owned;
            Results *created = ResultsMgr.CreateResults( "owned", "" );
            require( created != nullptr, "create owned result" );
            owned_id = created->GetID();
            require( owned.ids() == vector<string>{owned_id}, "find owned result" );
            owned.cleanup();
            owned.cleanup(); // Explicit cleanup is idempotent before publishing.
        }
        require( ResultsMgr.FindResultsPtr( existing_id ) != nullptr, "existing result preserved" );
        require( ResultsMgr.FindResultsPtr( owned_id ) == nullptr, "owned result deleted on success" );
        try
        {
            OwnedResults owned;
            Results *created = ResultsMgr.CreateResults( "owned_exception", "" );
            require( created != nullptr, "create exception result" );
            owned_id = created->GetID();
            throw std::runtime_error( "test unwind" );
        }
        catch ( const std::runtime_error & ) {}
        require( ResultsMgr.FindResultsPtr( existing_id ) != nullptr, "existing result preserved on exception" );
        require( ResultsMgr.FindResultsPtr( owned_id ) == nullptr, "owned result deleted on exception" );
        ResultsMgr.DeleteResult( existing_id );
    }
    {
        // Explicit failure propagates; a permanently failing retry in the
        // noexcept destructor must not replace it or terminate unwinding.
        for ( bool fail_enumeration : {true, false} )
        {
            test_injection::reset();
            Results *existing = ResultsMgr.CreateResults( "failure_existing", "" );
            const string existing_id = existing->GetID();
            string owned_id;
            try
            {
                OwnedResults owned;
                owned_id = ResultsMgr.CreateResults( "failure_owned", "" )->GetID();
                if ( fail_enumeration ) test_injection::fail_enumerate_from = test_injection::enumerate_calls + 1;
                else test_injection::fail_delete_from = 1;
                owned.cleanup();
                require( false, "cleanup must throw" );
            }
            catch ( const std::runtime_error &e )
            {
                require( string( e.what() ) == ( fail_enumeration ? "injected enumeration failure" : "injected deletion failure" ), "original cleanup exception survives destructor" );
            }
            require( fail_enumeration ? test_injection::enumerate_calls == 3 : test_injection::delete_calls == 2, "destructor retried failing cleanup" );
            test_injection::reset();
            require( ResultsMgr.FindResultsPtr( existing_id ) && ResultsMgr.FindResultsPtr( owned_id ), "failed cleanup leaves records intact" );
            ResultsMgr.DeleteResult( owned_id ); ResultsMgr.DeleteResult( existing_id );
        }
    }
    {
        // Exercise the actual publication boundary, not a facsimile of main.
        // Enumeration calls are constructor, snapshot, then explicit cleanup.
        test_injection::reset();
        {
            char name[] = "p1", model[] = "WING", analysis[] = "SurfacePatches";
            char *args[] = {name, model, analysis};
            require( p1_analysis_production_main( 3, args ) == 0 && test_injection::published == 1, "successful main publishes exactly once" );
        }
        for ( bool fail_enumeration : {true, false} )
        {
            test_injection::reset();
            if ( fail_enumeration ) test_injection::fail_enumerate_from = 3;
            else test_injection::fail_delete_from = 1;
            char name[] = "p1", model[] = "WING", analysis[] = "SurfacePatches";
            char *args[] = {name, model, analysis};
            require( p1_analysis_production_main( 3, args ) == 1, "cleanup failure returns failure" );
            require( test_injection::published == 0, "cleanup failure must not publish success" );
            require( fail_enumeration ? test_injection::enumerate_calls >= 4 : test_injection::delete_calls >= 2, "main destructor retries cleanup" );
            test_injection::reset();
            // These intentionally leaked test records normally disappear with the worker.
            for ( const auto &id : ResultsMgr.GetAllResultsIDs() ) ResultsMgr.DeleteResult( id );
        }
    }
    {
        // The real analysis produces multiple records. Delete one successfully,
        // then keep failing through explicit cleanup and the destructor retry.
        test_injection::reset();
        Results *existing = ResultsMgr.CreateResults( "partial_existing", "" );
        require( existing != nullptr, "create partial-cleanup sentinel" );
        const string existing_id = existing->GetID();
        existing->Add( new NameValData( "sentinel", vector<int>{42}, "" ) );
        const vector<string> before_ids = ResultsMgr.GetAllResultsIDs();
        const std::set<string> before( before_ids.begin(), before_ids.end() );
        test_injection::fail_delete_from = 2;
        char name[] = "p1", model[] = "WING", analysis[] = "SurfacePatches";
        char *args[] = {name, model, analysis};
        require( p1_analysis_production_main( 3, args ) == 1, "partial deletion failure returns failure" );
        require( test_injection::published == 0, "partial deletion failure does not publish" );
        require( test_injection::delete_calls == 3 && test_injection::deleted_ids.size() == 1 &&
                 test_injection::delete_attempts.size() == 3, "one deletion succeeds then both attempts fail" );
        const string deleted_id = test_injection::deleted_ids[0];
        const string failed_id = test_injection::delete_attempts[1];
        require( test_injection::delete_attempts[0] == deleted_id &&
                 test_injection::delete_attempts[2] == failed_id && deleted_id != failed_id,
                 "destructor retries the remaining failed result" );
        require( !before.count( deleted_id ) && !before.count( failed_id ), "only new results targeted" );
        require( !ResultsMgr.FindResultsPtr( deleted_id ) && ResultsMgr.FindResultsPtr( failed_id ),
                 "successful deletion persists and failed result remains" );
        Results *sentinel = ResultsMgr.FindResultsPtr( existing_id );
        require( sentinel && sentinel->FindPtr( "sentinel", 0 ) &&
                 sentinel->FindPtr( "sentinel", 0 )->GetIntData() == vector<int>{42}, "existing result and data preserved" );
        vector<string> residual;
        for ( const auto &id : ResultsMgr.GetAllResultsIDs() ) if ( !before.count( id ) ) residual.push_back( id );
        require( !residual.empty(), "failed cleanup leaves owned residuals" );
        for ( const auto &id : before ) require( ResultsMgr.FindResultsPtr( id ), "all preexisting results preserved" );
        // Disable injection and explicitly remove only this run's residuals and sentinel.
        test_injection::reset();
        for ( const auto &id : residual ) ResultsMgr.DeleteResult( id );
        ResultsMgr.DeleteResult( existing_id );
        for ( const auto &id : residual ) require( !ResultsMgr.FindResultsPtr( id ), "residual explicitly removed" );
        require( !ResultsMgr.FindResultsPtr( existing_id ), "sentinel explicitly removed" );
    }
    std::puts( "p1_snapshot_test: PASS" );
    return 0;
}
