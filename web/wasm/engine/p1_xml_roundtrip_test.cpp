// Phase 1 spike: side effects and roundtrip fidelity of Vehicle::EncodeXml.
//
// Builds a non-trivial model (three-section wing, control surface, point-based
// custom airfoil, propeller, and a link), serializes it to memory, measures what
// serialization changed, then reads the same text back with ReadVSPFile and
// compares the ID-free model fingerprint. Run with node; never shipped.
#include "VSP_Geom_API.h"
#include "APIErrorMgr.h"
#include "LinkMgr.h"
#include "Vehicle.h"
#include "VehicleMgr.h"
#include "ParmMgr.h"
#include "p1_xml_probe.h"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

using std::string;
using std::vector;

namespace
{
void Fail( const char *what )
{
    std::fprintf( stderr, "FAIL: %s\n", what );
    std::exit( 1 );
}

void Require( bool ok, const char *what )
{
    if ( !ok ) Fail( what );
}

void CheckErrors( const char *where )
{
    auto &errors = vsp::ErrorMgrSingleton::getInstance();
    if ( errors.GetNumTotalErrors() )
    {
        std::fprintf( stderr, "ERROR at %s: %s\n", where, errors.PopLastError().GetErrorString().c_str() );
        std::exit( 1 );
    }
}

string Quote( const string &s )
{
    string out = "\"";
    for ( char c : s )
    {
        if ( c == '"' || c == '\\' ) out += '\\';
        if ( c == '\n' ) { out += "\\n"; continue; }
        out += c;
    }
    return out + "\"";
}

vector<string> DiffLines( const string &a, const string &b )
{
    vector<string> out;
    std::vector<string> linesA, linesB;
    size_t start = 0;
    for ( size_t i = 0; i <= a.size(); ++i )
        if ( i == a.size() || a[i] == '\n' ) { linesA.push_back( a.substr( start, i - start ) ); start = i + 1; }
    start = 0;
    for ( size_t i = 0; i <= b.size(); ++i )
        if ( i == b.size() || b[i] == '\n' ) { linesB.push_back( b.substr( start, i - start ) ); start = i + 1; }
    size_t n = std::max( linesA.size(), linesB.size() );
    for ( size_t i = 0; i < n && out.size() < 8; ++i )
    {
        const string la = i < linesA.size() ? linesA[i] : string();
        const string lb = i < linesB.size() ? linesB[i] : string();
        if ( la != lb ) out.push_back( "line " + std::to_string( i ) + ": before=" + Quote( la ) + " after=" + Quote( lb ) );
    }
    return out;
}

double LinkValue( const string &parm )
{
    return parm.empty() ? -1.0 : vsp::GetParmVal( parm );
}
} // namespace

int main()
{
    vsp::VSPCheckSetup();
    vsp::ErrorMgrSingleton::getInstance().SilenceErrors();

    // ---- Fixture ----------------------------------------------------------
    const string wing = vsp::AddGeom( "WING" );
    CheckErrors( "AddGeom WING" );
    vsp::InsertXSec( wing, 1, vsp::XS_FOUR_SERIES );
    CheckErrors( "InsertXSec" );

    const string xsecSurf = vsp::GetXSecSurf( wing, 0 );
    vsp::ChangeXSecShape( xsecSurf, 1, vsp::XS_FILE_AIRFOIL );
    CheckErrors( "ChangeXSecShape" );
    const string xsec = vsp::GetXSec( xsecSurf, 1 );
    vector< vec3d > upper, lower;
    for ( int i = 0; i <= 8; ++i )
    {
        const double t = i / 8.0;
        upper.push_back( vec3d( t, 0.06 * std::sin( 3.14159265358979 * t ), 0 ) );
        lower.push_back( vec3d( t, -0.03 * std::sin( 3.14159265358979 * t ), 0 ) );
    }
    vsp::SetAirfoilPnts( xsec, upper, lower );
    CheckErrors( "SetAirfoilPnts" );

    const string control = vsp::AddSubSurf( wing, vsp::SS_CONTROL, 0 );
    CheckErrors( "AddSubSurf" );
    for ( const string &pid : vsp::GetGeomParmIDs( wing ) )
    {
        if ( vsp::GetParmName( pid ) == "UStart" ) vsp::SetParmVal( pid, 0.2 );
        if ( vsp::GetParmName( pid ) == "UEnd" ) vsp::SetParmVal( pid, 0.7 );
    }

    const string prop = vsp::AddGeom( "PROP" );
    CheckErrors( "AddGeom PROP" );

    const string wing2 = vsp::AddGeom( "WING" );
    CheckErrors( "AddGeom WING 2" );
    vsp::SetGeomName( wing2, "LinkedWing" );

    auto findSpan = []( const string &geom ) {
        for ( const string &pid : vsp::GetGeomParmIDs( geom ) )
            if ( vsp::GetParmName( pid ) == "Span" ) return pid;
        return string();
    };
    const string spanA = findSpan( wing );
    const string spanB = findSpan( wing2 );
    Require( !spanA.empty() && !spanB.empty(), "find Span parms" );
    const bool linked = LinkMgr.AddLink( spanA, spanB );
    Require( linked, "create link" );
    vsp::Update();
    CheckErrors( "Update" );

    const int geomsBefore = static_cast< int >( vsp::FindGeoms().size() );
    const int subsurfBefore = static_cast< int >( vsp::GetSubSurfIDVec( wing ).size() );
    const int upperBefore = static_cast< int >( vsp::GetAirfoilUpperPnts( xsec ).size() );
    const int linksBefore = LinkMgr.GetNumLinks();
    const double linkedValueBefore = LinkValue( spanB );

    // ---- Serialize and measure side effects -------------------------------
    // Clear the dirty flags so their change (if any) is attributable to encoding.
    ParmMgr.SetDirtyFlag( false );
    Vehicle *vehNow = VehicleMgr.GetVehicle();
    if ( vehNow ) vehNow->SetGeomMapDirtyFlag( false );

    const string fpBefore = p1probe::Fingerprint();
    const p1probe::Metrics mBefore = p1probe::TakeMetrics();

    string err;
    const string xml = p1probe::Serialize( &err, 4 * 1024 * 1024 );
    Require( err.empty() && !xml.empty(), "serialize model" );

    const string fpAfter = p1probe::Fingerprint();
    const p1probe::Metrics mAfter = p1probe::TakeMetrics();

    const vector< string > sideEffectDiff = DiffLines( fpBefore, fpAfter );
    const bool valuesUnchanged = fpBefore == fpAfter;
    const bool updateCountUnchanged = mBefore.updateCount == mAfter.updateCount;
    const bool fileNameUnchanged = mBefore.fileName == mAfter.fileName;
    const bool selectionUnchanged = mBefore.active == mAfter.active;
    const bool resultsUnchanged = mBefore.results == mAfter.results;
    const bool linksUnchanged = mBefore.links == mAfter.links && mAfter.links == linksBefore;

    // ---- Roundtrip through ReadVSPFile ------------------------------------
    const char *path = "/p1-roundtrip.vsp3";
    std::FILE *f = std::fopen( path, "wb" );
    Require( f != nullptr, "open roundtrip file" );
    const size_t written = std::fwrite( xml.data(), 1, xml.size(), f );
    std::fclose( f );
    Require( written == xml.size(), "write full roundtrip file" );

    // ReadVSPFile appends to the vehicle; emulate a fresh instance by clearing.
    vsp::DeleteGeomVec( vsp::FindGeoms() );
    vsp::Update();
    LinkMgr.CheckLinks(); // Prune links whose parms the deletion removed.
    CheckErrors( "clear before read" );

    vsp::ReadVSPFile( path );
    if ( vsp::ErrorMgrSingleton::getInstance().GetNumTotalErrors() )
    {
        std::fprintf( stderr, "READ ERROR: %s\n",
                      vsp::ErrorMgrSingleton::getInstance().PopLastError().GetErrorString().c_str() );
        return 1;
    }

    const string fpRoundtrip = p1probe::Fingerprint();
    const p1probe::Metrics mRoundtrip = p1probe::TakeMetrics();
    const vector< string > roundtripDiff = DiffLines( fpBefore, fpRoundtrip );

    const vector< string > geomsRoundtrip = vsp::FindGeoms();
    Require( !geomsRoundtrip.empty(), "roundtrip geoms" );
    const string wingAfter = geomsRoundtrip[0];
    const string xsecSurfAfter = vsp::GetXSecSurf( wingAfter, 0 );
    const string xsecAfter = vsp::GetXSec( xsecSurfAfter, 1 );
    const int geomsAfter = static_cast< int >( vsp::FindGeoms().size() );
    const int subsurfAfter = static_cast< int >( vsp::GetSubSurfIDVec( wingAfter ).size() );
    const int upperAfter = static_cast< int >( vsp::GetAirfoilUpperPnts( xsecAfter ).size() );
    const int linksAfter = LinkMgr.GetNumLinks();

    string spanBAfter;
    Link *link = LinkMgr.GetLink( 0 );
    if ( link ) spanBAfter = link->GetParmB();
    const double linkedValueAfter = LinkValue( spanBAfter );
    const bool linkValuePreserved = std::fabs( linkedValueAfter - linkedValueBefore ) < 1e-12;

    // ---- Report -----------------------------------------------------------
    string samples = "[";
    for ( size_t i = 0; i < roundtripDiff.size(); ++i )
        samples += ( i ? "," : "" ) + Quote( roundtripDiff[i] );
    samples += "]";

    string sideSamples = "[";
    for ( size_t i = 0; i < sideEffectDiff.size(); ++i )
        sideSamples += ( i ? "," : "" ) + Quote( sideEffectDiff[i] );
    sideSamples += "]";

    std::printf( "P1_XML_ROUNDTRIP={\"fixture\":{\"geoms\":%d,\"controlSurfaces\":%d,"
                 "\"airfoilPoints\":%d,\"links\":%d,\"propeller\":%s},"
                 "\"sideEffects\":{\"valuesUnchanged\":%s,\"updateCountUnchanged\":%s,"
                 "\"fileNameUnchanged\":%s,\"selectionUnchanged\":%s,\"resultsUnchanged\":%s,"
                 "\"linksUnchanged\":%s,\"parmChangesDelta\":%d,\"parmDirtyBefore\":%s,"
                 "\"parmDirtyAfter\":%s,\"geomMapDirtyBefore\":%s,\"geomMapDirtyAfter\":%s,"
                 "\"fingerprintDiff\":%s},"
                 "\"roundtrip\":{\"fingerprintEqual\":%s,\"geomsEqual\":%s,"
                 "\"controlSurfacesEqual\":%s,\"airfoilPointsEqual\":%s,"
                 "\"linksEqual\":%s,\"linkValuePreserved\":%s,\"xmlBytes\":%d,\"diff\":%s},"
                 "\"actual\":{\"geomsAfter\":%d,\"subsurfsAfter\":%d,\"airfoilPointsAfter\":%d,"
                 "\"linksAfter\":%d,\"linkedValueBefore\":%.17g,\"linkedValueAfter\":%.17g}}\n",
                 geomsBefore, subsurfBefore, upperBefore, linksBefore, prop.empty() ? "false" : "true",
                 valuesUnchanged ? "true" : "false", updateCountUnchanged ? "true" : "false",
                 fileNameUnchanged ? "true" : "false", selectionUnchanged ? "true" : "false",
                 resultsUnchanged ? "true" : "false", linksUnchanged ? "true" : "false",
                 mAfter.parmChanges - mBefore.parmChanges,
                 mBefore.parmDirty ? "true" : "false", mAfter.parmDirty ? "true" : "false",
                 mBefore.geomMapDirty ? "true" : "false", mAfter.geomMapDirty ? "true" : "false",
                 sideSamples.c_str(),
                 fpBefore == fpRoundtrip ? "true" : "false",
                 geomsAfter == geomsBefore ? "true" : "false",
                 subsurfAfter == subsurfBefore ? "true" : "false",
                 upperAfter == upperBefore ? "true" : "false",
                 linksAfter == linksBefore ? "true" : "false",
                 linkValuePreserved ? "true" : "false",
                 static_cast< int >( xml.size() ), samples.c_str(),
                 geomsAfter, subsurfAfter, upperAfter, linksAfter,
                 linkedValueBefore, linkedValueAfter );

    return 0;
}
