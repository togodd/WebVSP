// A disposable OpenVSP instance, NOT the page engine. Only built-in fixed models
// and two analyses are accepted. Never load page files or link this into vsp_wasm.
// callMain(["WING"|"PROP", "DegenGeom"|"SurfacePatches"]). On success one
// WEBVSP_P1_RESULT= JSON line; all other output is diagnostic, not a result.
#include "VSP_Geom_API.h"
#include "APIErrorMgr.h"
#include "ResultsMgr.h"
#include "p1_xml_probe.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>
#include <set>

using std::string;
using std::vector;

namespace
{
constexpr size_t MAX_BYTES = 8 * 1024 * 1024;
constexpr size_t MAX_RESULTS = 4096;
constexpr size_t MAX_FIELDS = 100000;
constexpr size_t MAX_VALUES = 500000;

struct Writer
{
    string data;
    size_t values = 0, fields = 0;
    void add( const string &s )
    {
        if ( s.size() > MAX_BYTES - data.size() ) throw std::runtime_error( "snapshot byte budget exceeded" );
        data += s;
    }
    void quote( const string &s )
    {
        add( "\"" );
        for ( unsigned char c : s )
        {
            if ( c == '"' ) add( "\\\"" );
            else if ( c == '\\' ) add( "\\\\" );
            else if ( c < 32 )
            {
                char b[7]; std::snprintf( b, sizeof b, "\\u%04x", c ); add( b );
            }
            else add( string( 1, static_cast< char >( c ) ) );
        }
        add( "\"" );
    }
    void count() { if ( ++values > MAX_VALUES ) throw std::runtime_error( "snapshot value budget exceeded" ); }
    void number( double n )
    {
        count();
        if ( !std::isfinite( n ) ) throw std::runtime_error( "non-finite result value" );
        char b[32]; std::snprintf( b, sizeof b, "%.17g", n ); add( b );
    }
    void integer( int n ) { count(); add( std::to_string( n ) ); }
    void text( const string &s ) { count(); quote( s ); }
    template<class T, class F> void array( const vector<T> &v, F f )
    {
        if ( v.size() > MAX_VALUES ) throw std::runtime_error( "snapshot array budget exceeded" );
        add( "[" );
        for ( size_t i = 0; i < v.size(); ++i ) { if ( i ) add( "," ); f( v[i] ); }
        add( "]" );
    }
    void field( const NameValData &d )
    {
        switch ( d.GetType() )
        {
        case vsp::INT_DATA: array( d.GetIntData(), [&]( int x ) { integer( x ); } ); break;
        case vsp::DOUBLE_DATA: array( d.GetDoubleData(), [&]( double x ) { number( x ); } ); break;
        case vsp::STRING_DATA: array( d.GetStringData(), [&]( const string &x ) { text( x ); } ); break;
        case vsp::VEC3D_DATA:
            array( d.GetVec3dData(), [&]( const vec3d &p ) { add( "[" ); number( p.x() ); add( "," ); number( p.y() ); add( "," ); number( p.z() ); add( "]" ); } ); break;
        case vsp::INT_MATRIX_DATA:
            array( d.GetIntMatData(), [&]( const vector<int> &r ) { array( r, [&]( int x ) { integer( x ); } ); } ); break;
        case vsp::DOUBLE_MATRIX_DATA:
            array( d.GetDoubleMatData(), [&]( const vector<double> &r ) { array( r, [&]( double x ) { number( x ); } ); } ); break;
        default: throw std::runtime_error( "unsupported result data type" );
        }
    }
};

void check_errors( const char *where )
{
    auto &errors = vsp::ErrorMgrSingleton::getInstance();
    if ( errors.GetNumTotalErrors() ) throw std::runtime_error( string( where ) + ": " + errors.PopLastError().GetErrorString() );
}

// IDs added during this single-threaded, disposable analysis belong to this run.
// An allocation failure can prevent enumeration/cleanup; worker destruction is
// the final isolation boundary, not this best-effort guard.
struct OwnedResults
{
    std::set<string> before;
    bool cleaned = false;
    OwnedResults() { for ( const auto &id : ResultsMgr.GetAllResultsIDs() ) before.insert( id ); }
    OwnedResults( const OwnedResults & ) = delete;
    OwnedResults &operator=( const OwnedResults & ) = delete;
    OwnedResults( OwnedResults && ) = delete;
    OwnedResults &operator=( OwnedResults && ) = delete;
    vector<string> ids() const
    {
        vector<string> owned;
        for ( const auto &id : ResultsMgr.GetAllResultsIDs() ) if ( !before.count( id ) ) owned.push_back( id );
        return owned;
    }
    void cleanup()
    {
        if ( cleaned ) return;
        for ( const auto &id : ids() ) ResultsMgr.DeleteResult( id );
        cleaned = true;
    }
    ~OwnedResults() noexcept { try { cleanup(); } catch ( ... ) {} }
};

string snapshot( const string &model, const string &analysis, const string &root, const vector<string> &ids,
                 const string &modelFingerprint = string(), int modelFingerprintLines = 0 )
{
    if ( ids.size() > MAX_RESULTS ) throw std::runtime_error( "snapshot results budget exceeded" );
    if ( std::set<string>( ids.begin(), ids.end() ).count( root ) != 1 ) throw std::runtime_error( "analysis root missing" );
    Writer w;
    w.add( "{\"protocol\":\"webvsp-p1-analysis\",\"version\":1,\"model\":" ); w.quote( model );
    w.add( ",\"analysis\":" ); w.quote( analysis ); w.add( ",\"root\":" ); w.quote( root );
    if ( !modelFingerprint.empty() )
    {
        w.add( ",\"modelFingerprint\":" ); w.quote( modelFingerprint );
        w.add( ",\"modelFingerprintLines\":" ); w.integer( modelFingerprintLines );
    }
    w.add( ",\"results\":[" );
    for ( size_t i = 0; i < ids.size(); ++i )
    {
        Results *r = ResultsMgr.FindResultsPtr( ids[i] );
        if ( !r ) throw std::runtime_error( "result disappeared" );
        if ( i ) w.add( "," );
        w.add( "{\"id\":" ); w.quote( ids[i] ); w.add( ",\"name\":" ); w.quote( r->GetName() ); w.add( ",\"fields\":[" );
        bool first = true;
        for ( const string &name : r->GetAllDataNames() )
        {
            int count = r->GetNumData( name );
            if ( count < 0 || static_cast<size_t>( count ) > MAX_FIELDS ) throw std::runtime_error( "invalid field count" );
            for ( int index = 0; index < count; ++index )
            {
                if ( ++w.fields > MAX_FIELDS ) throw std::runtime_error( "snapshot fields budget exceeded" );
                NameValData *d = r->FindPtr( name, index );
                if ( !d ) throw std::runtime_error( "result field missing" );
                if ( !first ) w.add( "," ); first = false;
                w.add( "{\"name\":" ); w.quote( name ); w.add( ",\"type\":" ); w.add( std::to_string( d->GetType() ) );
                w.add( ",\"index\":" ); w.add( std::to_string( index ) ); w.add( ",\"value\":" ); w.field( *d ); w.add( "}" );
            }
        }
        w.add( "]}" );
    }
    w.add( "]}" );
    return w.data;
}
}

int main( int argc, char **argv )
{
    if ( argc != 3 || ( string( argv[1] ) != "WING" && string( argv[1] ) != "PROP" && string( argv[1] ) != "FILE" ) ||
         ( string( argv[2] ) != "DegenGeom" && string( argv[2] ) != "SurfacePatches" ) )
    {
        std::fprintf( stderr, "Usage: vsp_p1_analysis WING|PROP|FILE DegenGeom|SurfacePatches\n" );
        return 2;
    }
    try
    {
        const string mode = argv[1], analysis = argv[2];
        const string model = mode == "FILE" ? "MODEL" : mode;
        vsp::VSPCheckSetup();
        vsp::ErrorMgrSingleton::getInstance().SilenceErrors();
        check_errors( "setup" );
        if ( mode != "FILE" )
        {
            string geom = vsp::AddGeom( model );
            check_errors( "AddGeom" );
            if ( geom.empty() ) throw std::runtime_error( "AddGeom returned no geometry" );
            vsp::Update(); check_errors( "Update" );
        }
        string fingerprint;
        int fingerprintLines = 0;
        if ( mode == "FILE" )
        {
            // The page writes exactly this path into this disposable instance.
            const string path = "/p1-input.vsp3";
            std::FILE *f = std::fopen( path.c_str(), "rb" );
            if ( !f ) throw std::runtime_error( "model input missing" );
            std::fseek( f, 0, SEEK_END );
            const long size = std::ftell( f );
            std::fclose( f );
            if ( size <= 0 || size > 4L * 1024 * 1024 ) throw std::runtime_error( "model input size invalid" );
            vsp::ReadVSPFile( path ); // Appends; this instance starts empty.
            check_errors( "ReadVSPFile" );
            if ( vsp::FindGeoms().empty() ) throw std::runtime_error( "model input has no geometry" );
            const string text = p1probe::Fingerprint();
            fingerprint = p1probe::FingerprintHash( text );
            fingerprintLines = static_cast< int >( std::count( text.begin(), text.end(), '\n' ) );
        }
        string json;
        {
            OwnedResults owned;
            vsp::SetAnalysisInputDefaults( analysis ); check_errors( "analysis defaults" );
            vsp::SetIntAnalysisInput( analysis, "Set", { vsp::SET_ALL } ); check_errors( "Set input" );
            if ( analysis == "DegenGeom" )
            {
                vsp::SetIntAnalysisInput( analysis, "WriteCSVFlag", { 0 } ); check_errors( "WriteCSVFlag input" );
                vsp::SetIntAnalysisInput( analysis, "WriteMFileFlag", { 0 } ); check_errors( "WriteMFileFlag input" );
                vsp::SetIntAnalysisInput( analysis, "UseModeFlag", { 0 } ); check_errors( "UseModeFlag input" );
            }
            string root = vsp::ExecAnalysis( analysis ); check_errors( "analysis" );
            json = snapshot( model, analysis, root, owned.ids(), fingerprint, fingerprintLines );
            owned.cleanup(); // A cleanup failure must not publish success.
        }
        std::printf( "WEBVSP_P1_RESULT=%s\n", json.c_str() );
        return 0;
    }
    catch ( const std::exception &e ) { std::fprintf( stderr, "P1 analysis failed: %s\n", e.what() ); return 1; }
    catch ( ... ) { std::fprintf( stderr, "P1 analysis failed: unknown exception\n" ); return 1; }
}
