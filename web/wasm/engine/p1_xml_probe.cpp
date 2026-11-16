#include "p1_xml_probe.h"

#include "VSP_Geom_API.h"
#include "APIUpdateCountMgr.h"
#include "LinkMgr.h"
#include "AdvLinkMgr.h"
#include "ParmMgr.h"
#include "ResultsMgr.h"
#include "Vehicle.h"
#include "VehicleMgr.h"
#include "XmlUtil.h"
#include "Geom.h"

#include <libxml/tree.h>

#include <algorithm>
#include <cstdio>
#include <map>
#include <set>
#include <sstream>
#include <vector>

using std::string;
using std::vector;

namespace p1probe
{
namespace
{
constexpr size_t MAX_XML_BYTES = 4 * 1024 * 1024;

string Number( double v )
{
    char b[40];
    std::snprintf( b, sizeof b, "%.17g", v );
    return b;
}

string Quote( const string &s )
{
    string out = "\"";
    for ( unsigned char c : s )
    {
        if ( c == '"' ) out += "\\\"";
        else if ( c == '\\' ) out += "\\\\";
        else if ( c == '\n' ) out += "\\n";
        else if ( c == '\r' ) out += "\\r";
        else if ( c == '\t' ) out += "\\t";
        else if ( c < 32 )
        {
            char b[7];
            std::snprintf( b, sizeof b, "\\u%04x", c );
            out += b;
        }
        else out += static_cast< char >( c );
    }
    return out + "\"";
}

vector<string> SplitLines( const string &s )
{
    vector<string> lines;
    std::istringstream in( s );
    string line;
    while ( std::getline( in, line ) ) lines.push_back( line );
    return lines;
}

size_t CountParmLines( const string &fp )
{
    size_t n = 0;
    for ( const string &line : SplitLines( fp ) ) if ( line.rfind( "P ", 0 ) == 0 ) ++n;
    return n;
}

string MetricsJson( const Metrics &m )
{
    string out = "{\"updateCount\":" + std::to_string( m.updateCount ) +
                 ",\"parmChanges\":" + std::to_string( m.parmChanges ) +
                 ",\"parmDirty\":" + ( m.parmDirty ? "true" : "false" ) +
                 ",\"geomMapDirty\":" + ( m.geomMapDirty ? "true" : "false" ) +
                 ",\"fileName\":" + Quote( m.fileName ) +
                 ",\"active\":[";
    for ( size_t i = 0; i < m.active.size(); ++i ) out += ( i ? "," : "" ) + Quote( m.active[i] );
    out += "],\"results\":" + std::to_string( m.results ) +
           ",\"links\":" + std::to_string( m.links ) +
           ",\"advLinks\":" + std::to_string( m.advLinks ) +
           ",\"parmLines\":" + std::to_string( m.parmLines ) + "}";
    return out;
}
} // namespace

string Fingerprint()
{
    vector< string > ids = vsp::FindGeoms();
    std::map< string, int > index;
    for ( size_t i = 0; i < ids.size(); ++i ) index[ids[i]] = static_cast< int >( i );

    string out = "geoms " + std::to_string( ids.size() ) + "\n";
    for ( size_t i = 0; i < ids.size(); ++i )
    {
        const string &id = ids[i];
        const string parent = vsp::GetGeomParent( id );
        int parentIndex = -1;
        auto it = index.find( parent );
        if ( it != index.end() ) parentIndex = it->second;

        out += "G " + std::to_string( i ) + " " + vsp::GetGeomName( id ) + " " +
               vsp::GetGeomTypeName( id ) + " xsecs=" + std::to_string( vsp::GetNumXSecSurfs( id ) ) +
               " parent=" + std::to_string( parentIndex ) + "\n";

        // Parameters keyed by display group and name: IDs differ after a reload.
        vector< string > parms;
        for ( const string &pid : vsp::GetGeomParmIDs( id ) )
        {
            parms.push_back( "P " + vsp::GetParmDisplayGroupName( pid ) + "/" + vsp::GetParmName( pid ) +
                             "=" + Number( vsp::GetParmVal( pid ) ) + " t" +
                             std::to_string( static_cast< int >( vsp::GetParmType( pid ) ) ) );
        }
        std::sort( parms.begin(), parms.end() );
        for ( const string &p : parms ) out += p + "\n";

        // Subsurface parameters are part of GetGeomParmIDs above; count them too.
        out += "subsurfs " + std::to_string( vsp::GetSubSurfIDVec( id ).size() ) + "\n";
    }

    // Selection is deliberately excluded: it is UI state, not geometry, and an
    // isolated instance starts with nothing selected.
    return out;
}

Metrics TakeMetrics()
{
    Metrics m;
    m.updateCount = vsp::UpdateCountMgr.GetUpdateCount();
    m.parmChanges = ParmMgr.GetNumParmChanges();
    m.parmDirty = ParmMgr.GetDirtyFlag();
    m.fileName = vsp::GetVSPFileName();
    m.active = vsp::GetActiveGeoms();
    m.results = static_cast< int >( ResultsMgr.GetAllResultsIDs().size() );
    m.links = LinkMgr.GetNumLinks();
    m.advLinks = static_cast< int >( AdvLinkMgr.GetLinks().size() );
    Vehicle *veh = VehicleMgr.GetVehicle();
    m.geomMapDirty = veh ? veh->GetGeomMapDirtyFlag() : false;
    return m;
}

string Serialize( string *err, size_t maxBytes )
{
    Vehicle *veh = VehicleMgr.GetVehicle();
    if ( !veh )
    {
        if ( err ) *err = "NO_MODEL";
        return "";
    }

    xmlDocPtr doc = xmlNewDoc( BAD_CAST "1.0" );
    xmlNodePtr root = xmlNewNode( nullptr, BAD_CAST "Vsp_Geometry" );
    xmlDocSetRootElement( doc, root );
    XmlUtil::AddIntNode( root, "Version", CURRENT_FILE_VER );
    veh->EncodeXml( root, vsp::SET_ALL );

    xmlChar *buffer = nullptr;
    int size = 0;
    xmlDocDumpFormatMemory( doc, &buffer, &size, 1 );
    xmlFreeDoc( doc );
    if ( !buffer || size <= 0 )
    {
        if ( buffer ) xmlFree( buffer );
        if ( err ) *err = "SERIALIZE_FAILED";
        return "";
    }
    string xml( reinterpret_cast< const char * >( buffer ), static_cast< size_t >( size ) );
    xmlFree( buffer );
    if ( xml.size() > maxBytes )
    {
        if ( err ) *err = "MODEL_XML_TOO_LARGE";
        return "";
    }
    return xml;
}

string FingerprintHash( const string &fingerprint )
{
    // FNV-1a 64-bit; only equality across two instances matters.
    unsigned long long hash = 1469598103934665603ULL;
    for ( unsigned char c : fingerprint )
    {
        hash ^= c;
        hash *= 1099511628211ULL;
    }
    char b[24];
    std::snprintf( b, sizeof b, "%016llx", hash );
    return b;
}

// Deliberately narrow: only geometry whose state is fully serialized and whose
// analysis does not depend on external files or scripts.
bool SupportedGeomType( int type )
{
    switch ( type )
    {
    case POD_GEOM_TYPE:
    case FUSELAGE_GEOM_TYPE:
    case MS_WING_GEOM_TYPE:
    case BLANK_GEOM_TYPE:
    case PROP_GEOM_TYPE:
    case STACK_GEOM_TYPE:
        return true;
    default:
        return false;
    }
}

string Report( bool includeXml )
{
    const vector< string > ids = vsp::FindGeoms();
    string unsupported = "[";
    bool supported = !ids.empty();
    for ( size_t i = 0; i < ids.size(); ++i )
    {
        Geom *geom = VehicleMgr.GetVehicle() ? VehicleMgr.GetVehicle()->FindGeom( ids[i] ) : nullptr;
        const int type = geom ? geom->GetType().m_Type : -1;
        const string name = geom ? geom->GetType().m_Name : string( "?" );
        const string parent = vsp::GetGeomParent( ids[i] );
        const bool attached = !parent.empty() && parent != "NONE";
        if ( !geom || !SupportedGeomType( type ) || attached )
        {
            supported = false;
            if ( unsupported.size() > 1 ) unsupported += ",";
            unsupported += "{\"name\":" + Quote( vsp::GetGeomName( ids[i] ) ) +
                           ",\"type\":" + Quote( name ) +
                           ",\"attached\":" + ( attached ? "true" : "false" ) + "}";
        }
    }
    unsupported += "]";

    if ( !supported )
    {
        return "{\"ok\":false,\"error\":" + Quote( ids.empty() ? "EMPTY_MODEL" : "UNSUPPORTED_GEOM" ) +
               ",\"unsupported\":" + unsupported + ",\"geoms\":" + std::to_string( ids.size() ) + "}";
    }

    Metrics before = TakeMetrics();
    string fpBefore = Fingerprint();
    before.parmLines = CountParmLines( fpBefore );

    string err;
    const string xml = Serialize( &err, MAX_XML_BYTES );

    Metrics after = TakeMetrics();
    string fpAfter = Fingerprint();
    after.parmLines = CountParmLines( fpAfter );

    vector< string > a = SplitLines( fpBefore ), b = SplitLines( fpAfter );
    std::multiset< string > left( a.begin(), a.end() ), right( b.begin(), b.end() );
    vector< string > removed, added;
    for ( const string &line : left )
    {
        auto it = right.find( line );
        if ( it == right.end() ) removed.push_back( line );
        else right.erase( it );
    }
    for ( const string &line : right ) added.push_back( line );

    string samples = "[";
    for ( size_t i = 0; i < removed.size() && i < 8; ++i )
        samples += ( i ? "," : "" ) + string( "{\"op\":\"removed\",\"line\":" ) + Quote( removed[i] ) + "}";
    for ( size_t i = 0; i < added.size() && i < 8; ++i )
        samples += ( samples.size() > 1 ? "," : "" ) + string( "{\"op\":\"added\",\"line\":" ) + Quote( added[i] ) + "}";
    samples += "]";

    string out = "{\"ok\":true,\"error\":";
    out += err.empty() ? "null" : Quote( err );
    out += ",\"before\":" + MetricsJson( before );
    out += ",\"after\":" + MetricsJson( after );
    out += ",\"delta\":{\"updateCount\":" + std::to_string( static_cast< long long >( after.updateCount ) -
                                                          static_cast< long long >( before.updateCount ) ) +
           ",\"parmChanges\":" + std::to_string( after.parmChanges - before.parmChanges ) +
           ",\"results\":" + std::to_string( after.results - before.results ) +
           ",\"links\":" + std::to_string( after.links - before.links ) +
           ",\"advLinks\":" + std::to_string( after.advLinks - before.advLinks ) +
           ",\"fileNameChanged\":" + ( after.fileName == before.fileName ? "false" : "true" ) +
           ",\"activeChanged\":" + ( after.active == before.active ? "false" : "true" ) +
           ",\"fingerprintChanged\":" + ( fpBefore == fpAfter ? "false" : "true" ) +
           ",\"parmLinesRemoved\":" + std::to_string( removed.size() ) +
           ",\"parmLinesAdded\":" + std::to_string( added.size() ) + "}";
    out += ",\"samples\":" + samples;
    out += ",\"fingerprintHash\":" + Quote( FingerprintHash( fpBefore ) );
    out += ",\"fingerprintLines\":" + std::to_string( std::count( fpBefore.begin(), fpBefore.end(), '\n' ) );
    out += ",\"types\":[";
    {
        const vector< string > ids = vsp::FindGeoms();
        for ( size_t i = 0; i < ids.size(); ++i )
            out += ( i ? "," : "" ) + Quote( vsp::GetGeomTypeName( ids[i] ) );
        out += "]";
    }
    out += ",\"xmlBytes\":" + std::to_string( xml.size() );
    if ( includeXml && !xml.empty() ) out += ",\"xml\":" + Quote( xml );
    out += "}";
    return out;
}

} // namespace p1probe
