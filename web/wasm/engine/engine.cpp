// WebVSP's engine: the OpenVSP core (and, in the GUI build, its FLTK GUI mirrored to the page)
// compiled to WebAssembly, running in the browser tab.
//
//   - OpenVSP runs on its own thread (main() runs on a pthread: -sPROXY_TO_PTHREAD), which owns
//     the model and the GUI.
//   - The page calls in from the browser's main thread through a few thread-safe functions:
//       call( id, op, a, b, value )   queue a request (the operations below)
//       callGuarded( id, op, a, b, value, expectedEpoch ) queue one epoch-guarded job
//         expectedEpoch is a canonical unsigned decimal uint64 string. Before dispatch, an
//         invalid/mismatched epoch or missing Vehicle yields error/code STALE_MODEL and
//         outcome not_written. model includes modelEpoch (decimal string; empty if no Vehicle)
//         and modelEpochValid in its existing value object, captured in the same engine job.
//         This is protocol groundwork only: not all development-time facade calls are guarded.
//       mirrorEvent( json )           input for the mirrored GUI (WebMirror's event JSON)
//       take()                        everything produced since the last take(), as JSON:
//                                       {"out":[results and model events],"mirror":[GUI output]}
//       takeBinary( id )              a request's binary result (meshes), as a Uint8Array
//   - Between requests the engine pumps the GUI and watches the model for changes made in the
//     GUI, emitting "model_changed" events.
//
// Requests (op, a, b, value) and their results (the page's side is wasmRequest, wasmEngine.ts):
//   modelingProtocol                    fixed read-protocol declaration, unguarded
//   model, modelDiscovery, geomTypes, bbox   JSON (bbox: the shown geoms', or a="all" every geom's)
//     modelDiscovery is an unguarded internal snapshot that reports serializer errors.
//   mesh(a=geom id)                     binary "VSPM" mesh (format: web/frontend/src/api/mesh.ts)
//   addGeom(a=type, b=parent)           {"id":...}
//   deleteGeoms(a=comma-separated ids), liveDeleteGeom(a=geom id, value=clone delete policy)
//   liveCompPnt01 / liveCompNorm01(a=id,b="surface index,w",value=u) -> [x,y,z]
//   liveNumMainSurfs(a=id), liveUpdateGeom(a=id), liveSetGeomParent(a=id,b=parent)
//   liveCopyGeom(a=id), liveCutGeom(a=id,value=clone policy), livePasteGeom(a=parent)
//   guardedSetGeomName(a=geom id, b=name), guardedDeleteGeom(a=geom id)
//   setParm(a=parm id, value)           legacy unscoped write
//   geomSetParm(a=geom id, b=parm id, value), xsecSetParm(a=xsec id, b=parm id, value)
//     Single scoped write, not a transaction. Success value: {actual}; failure: error,
//     outcome ("not_written", "different", or "unknown") and actual (null if unknown).
//   geomXSecs(a=geom id)                [{id, xsecs:[ids]}] in XSec surface/index order
//   fuselageXSecShapes(a=geom id)       [{id, xsecs:[{id, shape}]}] in surface/index order
//   wingXSecShapes(a=geom id)           same shape data, restricted to WING geoms
//   geomParmIDs(a=geom id), xsecParmIDs(a=xsec id)   linkable parm IDs
//   geomParm(a=geom id, b=parm id), xsecParm(a=xsec id, b=parm id)   parm metadata
//     Metadata: {id,value,type,name,group,container,lowerLimit,upperLimit,active}.
//     Non-finite numbers are null; errors are failed results, never default values.
//     Scope is precisely GetGeomParmIDs / GetXSecParmIDs (including their nested containers),
//     not every parm in the model. XSecs must be reachable from a current geom's XSec surfaces.
//     Page-side routes are defined in wasmEngine.ts; this is not a remote API.
//   guardedUpdate                        explicit Update(true), epoch-guarded and write-preflighted
//   syncProbeFile(a=random scratch path) fixed diagnostic: read and replace a bounded sentinel
//   newModel, readFile(a=path), writeFile(a=path)   (paths in the in-memory file system)
//   snapshot(a=path): copy of the model for autosave, keeping its name and unsaved state
//   restoreSnapshot(a=path, b=name): load an autosave copy as unnamed and mark it unsaved
//   pick(a=geom id, b="1" to toggle)    select as if picked in the 3D view (shift/ctrl-click)
//   origin(a=geom id)                   [x,y,z] of the geom's origin
//   move(a=ids, b="dx,dy,dz")           move geoms by an offset (one undo step)
//   duplicate(a=ids)                    copy geoms in place and select the copies; {ids}
//   drawType(a=ids, value=type)         geoms' draw type (GEOM_DRAW_WIRE=0 ... NONE=4)
//   rotate(a=ids, b="ax,ay,az", value=degrees)  rotate geoms about a world axis, each about its
//                                       own origin (one undo step)

#if defined(WEBVSP_PRODUCTION_BUILD) && (defined(WEBVSP_SCRIPT_GUARD_TEST) || defined(WEBVSP_PARM_REENTRY_TEST) || defined(WEBVSP_DELETE_GEOM_PROXY_TEST) || defined(WEBVSP_LIVE_BINARY_TEST))
#error WebVSP test hooks are forbidden in production
#endif

#include "VSP_Geom_API.h"
#include "ResultsMgr.h"
#include "APIErrorMgr.h"
#include "error_drain.h"
#include "AdvLinkMgr.h"
#include "DrawObj.h"
#include "MeshGeom.h"
#include "NGonMeshGeom.h"
#include "Vec3d.h"
#include "Vehicle.h"
#include "VehicleMgr.h"
#include "ParmMgr.h"
#include "WebProcess.h"
#include <angelscript.h>
#include "ScriptMgr.h"
#if defined(WEBVSP_SCRIPT_GUARD_TEST) && defined(WEBVSP_PARM_REENTRY_TEST)
#include "ParmMgr.h"
#include "ParmReentryTest.h"
#endif

#include <sys/stat.h>

#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <algorithm>
#include <cerrno>
#include <cctype>
#include <cstdlib>
#include <chrono>
#ifdef WEBVSP_SCRIPT_GUARD_TEST
#include <condition_variable>
#endif
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <functional>
#include <map>
#include <limits>
#include <mutex>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

using std::string;
using std::vector;

namespace
{

//==== Minimal JSON writing ====//

string Quote( const string &s )
{
    string out = "\"";
    for ( unsigned char c : s )
    {
        switch ( c )
        {
            case '"': out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if ( c < 0x20 )
                {
                    char buf[8];
                    snprintf( buf, sizeof( buf ), "\\u%04x", c );
                    out += buf;
                }
                else
                {
                    out += ( char ) c;
                }
        }
    }
    return out + "\"";
}

string Num( double v )
{
    if ( !std::isfinite( v ) )
    {
        return "null";
    }
    char buf[32];
    snprintf( buf, sizeof( buf ), "%.17g", v );
    return buf;
}

string StrArray( const vector< string > &v )
{
    string out = "[";
    for ( size_t i = 0; i < v.size(); i++ )
    {
        out += ( i ? "," : "" ) + Quote( v[i] );
    }
    return out + "]";
}

// API errors raised since the last call, as one message (empty if none).
string TakeErrors()
{
    string msg;
    vsp::ErrorMgrSingleton &mgr = vsp::ErrorMgrSingleton::getInstance();
    while ( mgr.GetNumTotalErrors() )
    {
        string e = mgr.PopLastError().GetErrorString();
        msg = msg.empty() ? e : e + "; " + msg;
    }
    return msg;
}

//==== Shared state (browser main thread <-> engine thread) ====//

struct Job
{
    int id;
    string op, a, b;
    double value;
    bool guarded;
    string expected_epoch;
};

std::mutex g_Mutex;
std::deque< Job > g_Jobs;
vector< string > g_Out;                              // JSON messages for take()
std::map< int, vector< uint8_t > > g_Binary;         // results for takeBinary()

#ifdef WEBVSP_SCRIPT_GUARD_TEST
// Capture only the nested probe's private result; normal output remains unchanged.
string *g_GcProbeCapture = nullptr;
#endif
void Emit( const string &json )
{
#ifdef WEBVSP_SCRIPT_GUARD_TEST
    if ( g_GcProbeCapture && json.find( "{\"t\":\"result\",\"id\":-2147483000," ) == 0 )
    {
        *g_GcProbeCapture = json;
        return;
    }
#endif
    std::lock_guard< std::mutex > lock( g_Mutex );
    g_Out.push_back( json );
}

//==== Model ====//

#ifdef WEBVSP_SCRIPT_GUARD_TEST
// One-shot, serializer-local fault; never enabled in production builds.
string g_SerializerFault;
void SerializerFault( const string &point )
{
    if ( g_SerializerFault == point )
    {
        g_SerializerFault.clear();
        vsp::ErrorMgrSingleton::getInstance().AddError( vsp::VSP_INVALID_PTR, "Injected serializer error: " + point );
    }
}
#else
void SerializerFault( const string & ) {}
#endif

// RunImpl clears the old stack at request entry. NoError only clears the flag,
// not the accumulated stack, so examine it after all serializer API calls.
// Concurrent/reentrant stack users and errors APIs never report are not covered.
void SerializerErrors( string *err )
{
    bool had_errors = vsp::ErrorMgrSingleton::getInstance().GetNumTotalErrors() != 0;
    string message = TakeErrors();
    if ( err ) *err = had_errors && message.empty() ? "OpenVSP serializer API error (no message)" : message;
}

string ModelJson( string *err = nullptr )
{
    string geoms = "[";
    vector< string > ids = vsp::FindGeoms();
    SerializerFault( "model:early" );
    for ( size_t i = 0; i < ids.size(); i++ )
    {
        const string &id = ids[i];
        string parent = vsp::GetGeomParent( id );
        SerializerFault( "model:middle" );
        vec3d color = vsp::GetGeomWireColor( id );
        geoms += i ? "," : "";
        geoms += "{\"id\":" + Quote( id ) +
                 ",\"name\":" + Quote( vsp::GetGeomName( id ) ) +
                 ",\"type\":" + Quote( vsp::GetGeomTypeName( id ) ) +
                 ",\"parent\":" + ( parent.empty() || parent == "NONE" ? string( "null" ) : Quote( parent ) ) +
                 ",\"children\":" + StrArray( vsp::GetGeomChildren( id ) ) +
                 ",\"shown\":" + ( vsp::GetSetFlag( id, vsp::SET_SHOWN ) ? "true" : "false" ) +
                 ",\"drawType\":" + std::to_string( vsp::GetGeomDrawType( id ) ) +
                 ",\"color\":[" + Num( color.x() / 255.0 ) + "," + Num( color.y() / 255.0 ) + "," +
                 Num( color.z() / 255.0 ) + "]" +
                 ",\"numXSecSurfs\":" + std::to_string( vsp::GetNumXSecSurfs( id ) ) + "}";
    }
    geoms += "]";
    string file = vsp::GetVSPFileName();
    string out = "{\"geoms\":" + geoms +
                 ",\"active\":" + StrArray( vsp::GetActiveGeoms() ) +
                 ",\"vehicleId\":" + Quote( vsp::GetVehicleID() ) +
                 ",\"fileName\":" + Quote( file ) +
                 ",\"version\":" + Quote( vsp::GetVSPVersion() ) + "}";
    SerializerFault( "model:late" );
    SerializerErrors( err );
    return out;
}

// Geoms drawn from triangles rather than surfaces (GetMeshGeomTriPnts): imported/CompGeom
// meshes, and NGon meshes such as VSPAERO's geometry.
bool IsTriMesh( const string &type )
{
    return type == "Mesh" || type == "NGonMesh";
}

void Grow( double lo[3], double hi[3], double x, double y, double z )
{
    const double p[3] = { x, y, z };
    for ( int k = 0; k < 3; k++ )
    {
        lo[k] = std::min( lo[k], p[k] );
        hi[k] = std::max( hi[k], p[k] );
    }
}

// The shown geoms' bounding box, or every geom's (hidden ones too) when all is set.
string BBoxJson( bool all = false, string *err = nullptr )
{
    double lo[3] = { INFINITY, INFINITY, INFINITY }, hi[3] = { -INFINITY, -INFINITY, -INFINITY };
    bool any = false;
    vector< string > ids = vsp::FindGeoms();
    SerializerFault( "bbox:early" );
    for ( const string &id : ids )
    {
        if ( !all && !vsp::GetSetFlag( id, vsp::SET_SHOWN ) )
        {
            continue;
        }
        int nsurf = vsp::GetTotalNumSurfs( id );
        SerializerFault( "bbox:middle" );
        for ( int s = 0; s < nsurf; s++ )
        {
            vec3d a = vsp::GetGeomBBoxMin( id, s, true ), b = vsp::GetGeomBBoxMax( id, s, true );
            Grow( lo, hi, a.x(), a.y(), a.z() );
            Grow( lo, hi, b.x(), b.y(), b.z() );
            any = true;
        }
        if ( nsurf == 0 && IsTriMesh( vsp::GetGeomTypeName( id ) ) )
        {
            vector< double > p = vsp::GetMeshGeomTriPnts( id );
            for ( size_t i = 0; i + 2 < p.size(); i += 3 )
            {
                Grow( lo, hi, p[i], p[i + 1], p[i + 2] );
                any = true;
            }
        }
    }
    SerializerFault( "bbox:late" );
    SerializerErrors( err );
    if ( !any )
    {
        return "null";
    }
    return "{\"min\":[" + Num( lo[0] ) + "," + Num( lo[1] ) + "," + Num( lo[2] ) + "],\"max\":[" +
           Num( hi[0] ) + "," + Num( hi[1] ) + "," + Num( hi[2] ) + "]}";
}

//==== Meshes: the GUI's own u/w tessellation, as a binary payload ====//

struct Surface
{
    uint32_t nu = 0, nw = 0; // nw = 0: triangle list of nu vertices
    vector< float > pos, nrm;
    vector< uint32_t > idx;
};

bool GridSurface( const string &id, int surf, Surface &out )
{
    vector< double > u, w;
    vsp::GetUWTess01( id, surf, u, w );
    if ( u.size() < 2 || w.size() < 2 )
    {
        return false;
    }
    vector< double > us, ws;
    us.reserve( u.size() * w.size() );
    ws.reserve( u.size() * w.size() );
    for ( double uu : u )
    {
        for ( double ww : w )
        {
            us.push_back( uu );
            ws.push_back( ww );
        }
    }
    vector< vec3d > p = vsp::CompVecPnt01( id, surf, us, ws );
    vector< vec3d > n = vsp::CompVecNorm01( id, surf, us, ws );
    out.nu = ( uint32_t ) u.size();
    out.nw = ( uint32_t ) w.size();
    for ( size_t k = 0; k < p.size(); k++ )
    {
        out.pos.insert( out.pos.end(), { ( float ) p[k].x(), ( float ) p[k].y(), ( float ) p[k].z() } );
        out.nrm.insert( out.nrm.end(), { ( float ) n[k].x(), ( float ) n[k].y(), ( float ) n[k].z() } );
    }
    // Two triangles per grid cell; winding made to agree with the normals overall
    // (symmetric copies are mirrored).
    double agree = 0;
    for ( uint32_t i = 0; i + 1 < out.nu; i++ )
    {
        for ( uint32_t j = 0; j + 1 < out.nw; j++ )
        {
            uint32_t a = i * out.nw + j, b = a + out.nw, c = b + 1, d = a + 1;
            out.idx.insert( out.idx.end(), { a, b, c, a, c, d } );
            vec3d fn = cross( p[b] - p[a], p[c] - p[a] );
            agree += dot( fn, n[a] + n[b] + n[c] );
        }
    }
    if ( agree < 0 )
    {
        for ( size_t t = 0; t + 2 < out.idx.size(); t += 3 )
        {
            std::swap( out.idx[t + 1], out.idx[t + 2] );
        }
    }
    return true;
}

bool TriangleSurface( const string &id, Surface &out )
{
    vector< double > p = vsp::GetMeshGeomTriPnts( id );
    if ( p.size() < 9 )
    {
        return false;
    }
    size_t nv = p.size() / 3;
    out.nu = ( uint32_t ) nv;
    out.nw = 0;
    out.pos.assign( p.begin(), p.end() );
    out.nrm.resize( p.size() );
    out.idx.resize( nv );
    for ( size_t t = 0; t + 2 < nv; t += 3 )
    {
        vec3d a( p[3 * t], p[3 * t + 1], p[3 * t + 2] );
        vec3d b( p[3 * t + 3], p[3 * t + 4], p[3 * t + 5] );
        vec3d c( p[3 * t + 6], p[3 * t + 7], p[3 * t + 8] );
        vec3d fn = cross( b - a, c - a );
        double len = fn.mag();
        if ( len > 0 )
        {
            fn = fn / len;
        }
        for ( size_t v = 0; v < 3; v++ )
        {
            out.nrm[3 * ( t + v )] = ( float ) fn.x();
            out.nrm[3 * ( t + v ) + 1] = ( float ) fn.y();
            out.nrm[3 * ( t + v ) + 2] = ( float ) fn.z();
        }
    }
    for ( size_t i = 0; i < nv; i++ )
    {
        out.idx[i] = ( uint32_t ) i;
    }
    return true;
}

// How the desktop draws a surface beyond its triangles: a colour of its own (Mesh / NGon Mesh
// tags), and the polygon edges to draw instead of the triangles' (NGon Mesh faces).
struct Part
{
    bool colored = false;
    float rgb[3] = { 0, 0, 0 };
    vector< float > edges;
};

// The geom's own wire/shade draw objects are named "<geom id>_<index>".
bool IsWireShadeObj( const string &geom_id, const string &obj_id )
{
    if ( obj_id.size() <= geom_id.size() + 1 || obj_id.compare( 0, geom_id.size(), geom_id ) != 0 ||
         obj_id[geom_id.size()] != '_' )
    {
        return false;
    }
    for ( size_t i = geom_id.size() + 1; i < obj_id.size(); i++ )
    {
        if ( !isdigit( ( unsigned char ) obj_id[i] ) )
        {
            return false;
        }
    }
    return true;
}

// A Mesh or NGon Mesh geom as the desktop draws it, from its own draw objects: one triangle
// list per tag (component), coloured round the colour wheel when the desktop colours them
// (always for NGon meshes; for Mesh geoms when they're drawn by tag), with each tag's polygon
// edges (NGon meshes draw their faces' edges, not the triangles').
bool TagSurfaces( const string &id, vector< Surface > &surfs, vector< Part > &parts )
{
    Vehicle *veh = VehicleMgr.GetVehicle();
    Geom *g = veh ? veh->FindGeom( id ) : nullptr;
    if ( !g )
    {
        return false;
    }
    bool colored = dynamic_cast< NGonMeshGeom* >( g ) != nullptr;
    if ( MeshGeom *mg = dynamic_cast< MeshGeom* >( g ) )
    {
        colored = mg->m_DrawType() == MeshGeom::DRAW_TAGS && g->m_GuiDraw.GetDispSubSurfFlag();
    }
    vector< DrawObj* > objs;
    g->LoadDrawObjs( objs );
    // An NGon mesh lists every tag's edges, then every tag's faces, in the same tag order.
    vector< DrawObj* > faces, lines;
    for ( DrawObj *d : objs )
    {
        if ( !d || !IsWireShadeObj( id, d->m_GeomID ) )
        {
            continue;
        }
        if ( d->m_Type == DrawObj::VSP_LINES )
        {
            lines.push_back( d );
        }
        else if ( d->m_Type == DrawObj::VSP_WIRE_TRIS || d->m_Type == DrawObj::VSP_HIDDEN_TRIS ||
                  d->m_Type == DrawObj::VSP_SHADED_TRIS )
        {
            faces.push_back( d );
        }
    }
    for ( size_t k = 0; k < faces.size(); k++ )
    {
        const DrawObj *d = faces[k];
        size_t nv = d->m_PntVec.size() / 3 * 3;
        if ( nv < 3 )
        {
            continue;
        }
        bool normals = d->m_NormVec.size() == d->m_PntVec.size();
        Surface sf;
        sf.nu = ( uint32_t ) nv;
        sf.nw = 0;
        for ( size_t v = 0; v < nv; v++ )
        {
            const vec3d &p = d->m_PntVec[v];
            vec3d n;
            if ( normals )
            {
                n = d->m_NormVec[v];
            }
            else
            {
                size_t t = v / 3 * 3;
                n = cross( d->m_PntVec[t + 1] - d->m_PntVec[t], d->m_PntVec[t + 2] - d->m_PntVec[t] );
                n.normalize();
            }
            sf.pos.insert( sf.pos.end(), { ( float ) p.x(), ( float ) p.y(), ( float ) p.z() } );
            sf.nrm.insert( sf.nrm.end(), { ( float ) n.x(), ( float ) n.y(), ( float ) n.z() } );
            sf.idx.push_back( ( uint32_t ) v );
        }
        Part part;
        part.colored = colored;
        for ( int c = 0; c < 3; c++ )
        {
            part.rgb[c] = ( float ) d->m_LineColor.v[c];
        }
        if ( k < lines.size() )
        {
            for ( const vec3d &p : lines[k]->m_PntVec )
            {
                part.edges.insert( part.edges.end(), { ( float ) p.x(), ( float ) p.y(), ( float ) p.z() } );
            }
        }
        surfs.push_back( std::move( sf ) );
        parts.push_back( std::move( part ) );
    }
    return !surfs.empty();
}

void Put32( vector< uint8_t > &b, uint32_t v )
{
    uint8_t bytes[4];
    memcpy( bytes, &v, 4 ); // wasm is little-endian, as the format is
    b.insert( b.end(), bytes, bytes + 4 );
}

template < class T >
void PutVec( vector< uint8_t > &b, const vector< T > &v )
{
    const uint8_t *p = reinterpret_cast< const uint8_t * >( v.data() );
    b.insert( b.end(), p, p + v.size() * sizeof( T ) );
}

vector< uint8_t > MeshBytes( const string &id )
{
    vector< Surface > surfs;
    vector< Part > parts;
    // The viewer can ask for a Geom that has just been deleted: an empty mesh, quietly.
    vector< string > geoms = vsp::FindGeoms();
    int nsurf = std::find( geoms.begin(), geoms.end(), id ) == geoms.end() ? 0 : vsp::GetTotalNumSurfs( id );
    // Per surface: 1 for a disk (a propeller in disk mode), drawn see-through when shaded.
    vector< uint32_t > flags;
    // Per OpenVSP surface: its index among the surfaces written (-1: none).
    vector< int32_t > drawn( nsurf, -1 );
    Vehicle *veh = VehicleMgr.GetVehicle();
    Geom *geom = veh && nsurf > 0 ? veh->FindGeom( id ) : nullptr;
    for ( int s = 0; s < nsurf; s++ )
    {
        Surface sf;
        if ( GridSurface( id, s, sf ) )
        {
            drawn[s] = ( int32_t ) surfs.size();
            surfs.push_back( std::move( sf ) );
            const VspSurf *vs = geom ? geom->GetSurfPtr( s ) : nullptr;
            flags.push_back( vs && vs->GetSurfType() == vsp::DISK_SURF ? 1u : 0u );
        }
    }
    if ( surfs.empty() && nsurf == 0 && std::find( geoms.begin(), geoms.end(), id ) != geoms.end() &&
         IsTriMesh( vsp::GetGeomTypeName( id ) ) && !TagSurfaces( id, surfs, parts ) )
    {
        Surface sf;
        if ( TriangleSurface( id, sf ) )
        {
            surfs.push_back( std::move( sf ) );
        }
    }
    TakeErrors();

    vector< uint8_t > b = { 'V', 'S', 'P', 'M' };
    Put32( b, ( uint32_t ) surfs.size() );
    for ( const Surface &sf : surfs )
    {
        Put32( b, sf.nu );
        Put32( b, sf.nw );
        Put32( b, ( uint32_t ) sf.idx.size() );
        PutVec( b, sf.pos );
        PutVec( b, sf.nrm );
        PutVec( b, sf.idx );
    }
    // Then the outline (feature lines), as segments: count of points, then x,y,z floats.
    vector< float > feat;
    if ( nsurf > 0 )
    {
        for ( const vec3d &p : vsp::MirrorFeatureLines( id ) )
        {
            feat.insert( feat.end(), { ( float ) p.x(), ( float ) p.y(), ( float ) p.z() } );
        }
        TakeErrors();
    }
    Put32( b, ( uint32_t ) ( feat.size() / 3 ) );
    PutVec( b, feat );
    // Then, for Mesh / NGon Mesh tags, each surface's colour and polygon edges.
    Put32( b, ( uint32_t ) parts.size() );
    for ( const Part &p : parts )
    {
        vector< float > rgb = { p.colored ? p.rgb[0] : -1.0f, p.rgb[1], p.rgb[2] };
        PutVec( b, rgb );
        Put32( b, ( uint32_t ) ( p.edges.size() / 3 ) );
        PutVec( b, p.edges );
    }
    // Then a flag per surface (bit 0: a disk); 0 or the number of surfaces.
    flags.resize( flags.empty() ? 0 : surfs.size(), 0 );
    Put32( b, ( uint32_t ) flags.size() );
    PutVec( b, flags );
    // Then the symmetric copies, per OpenVSP surface (0 entries, or one per surface): the
    // surface it was written as (-1: none), the surface it is a copy of (itself for an
    // original), how many outline points it gave (in order; all 0 if the outline can't be split
    // by surface), and its transform (main surface to world, column-major). A move previewed on
    // the original is mirrored onto each copy with copy * original^-1.
    vector< Matrix4d > trans = geom ? geom->GetTransMatVec() : vector< Matrix4d >();
    if ( geom && ( int ) trans.size() == nsurf )
    {
        vector< uint32_t > outline( nsurf, 0 );
        const vector< SimpleFeatureTess > &ft = geom->GetFeatureTessVec();
        if ( ( int ) ft.size() == nsurf )
        {
            size_t total = 0;
            for ( int s = 0; s < nsurf; s++ )
            {
                for ( const vector< vec3d > &line : ft[s].m_ptline )
                {
                    outline[s] += line.size() > 1 ? 2 * ( uint32_t ) ( line.size() - 1 ) : 0;
                }
                total += outline[s];
            }
            if ( total != feat.size() / 3 )
            {
                std::fill( outline.begin(), outline.end(), 0 );
            }
        }
        Put32( b, ( uint32_t ) nsurf );
        for ( int s = 0; s < nsurf; s++ )
        {
            vector< int > copies;
            geom->GetSymmIndexs( geom->GetMainSurfID( s ), copies );
            int original = copies.empty() ? s : copies[0];
            Put32( b, ( uint32_t ) drawn[s] );
            Put32( b, ( uint32_t ) original );
            Put32( b, outline[s] );
            double m[16];
            trans[s].getMat( m );
            vector< float > mf( m, m + 16 );
            PutVec( b, mf );
        }
    }
    else
    {
        Put32( b, 0 );
    }
    return b;
}

//==== Change detection: which geoms changed, from parm fingerprints ====//

int g_Rev = 0;
bool g_Dirty = false;
string g_TreeSig;
std::unordered_map< string, size_t > g_Fingerprints;

// What the Geom Browser shows: changes here re-send the tree.
string TreeSignature()
{
    string sig;
    for ( const string &g : vsp::FindGeoms() )
    {
        sig += g + '\x1f' + vsp::GetGeomName( g ) + '\x1f' + vsp::GetGeomParent( g ) + '\x1f' +
               ( vsp::GetSetFlag( g, vsp::SET_SHOWN ) ? "1" : "0" ) + std::to_string( vsp::GetGeomDrawType( g ) ) + '\x1e';
    }
    for ( const string &g : vsp::GetActiveGeoms() )
    {
        sig += g + ',';
    }
    return sig + vsp::GetVSPFileName();
}

// Everything that shapes a Geom's surfaces: its Parms, its XSecs' Parms, and its parent's.
size_t Fingerprint( const string &gid, std::unordered_map< string, size_t > &cache )
{
    auto hit = cache.find( gid );
    if ( hit != cache.end() )
    {
        return hit->second;
    }
    std::hash< string > hs;
    std::hash< double > hd;
    size_t h = hs( gid );
    auto mix = [&h]( size_t v ) { h ^= v + 0x9e3779b97f4a7c15ULL + ( h << 6 ) + ( h >> 2 ); };
    for ( const string &pid : vsp::GetGeomParmIDs( gid ) )
    {
        mix( hs( pid ) );
        mix( hd( vsp::GetParmVal( pid ) ) );
    }
    for ( const string &surf : vsp::GetXSecSurfIDVec( gid ) )
    {
        mix( hs( surf ) );
        for ( int xi = 0; xi < vsp::GetNumXSec( surf ); xi++ )
        {
            string xs = vsp::GetXSec( surf, xi );
            mix( hs( xs ) );
            for ( const string &pid : vsp::GetXSecParmIDs( xs ) )
            {
                mix( hs( pid ) );
                mix( hd( vsp::GetParmVal( pid ) ) );
            }
        }
    }
    string parent = vsp::GetGeomParent( gid );
    if ( !parent.empty() && parent != "NONE" )
    {
        // Children move with their parent.
        mix( Fingerprint( parent, cache ) );
    }
    cache[gid] = h;
    return h;
}

void RefreshFingerprints( vector< string > &changed, vector< string > &removed )
{
    std::unordered_map< string, size_t > cache;
    vector< string > current = vsp::FindGeoms();
    for ( const string &g : current )
    {
        size_t fp = Fingerprint( g, cache );
        auto it = g_Fingerprints.find( g );
        if ( it == g_Fingerprints.end() || it->second != fp )
        {
            changed.push_back( g );
        }
    }
    for ( const auto &kv : g_Fingerprints )
    {
        if ( !cache.count( kv.first ) )
        {
            removed.push_back( kv.first );
        }
    }
    g_Fingerprints.clear();
    for ( const string &g : current )
    {
        g_Fingerprints[g] = cache[g];
    }
    TakeErrors();
}

const char *NO_UNDO = "{\"canUndo\":false,\"canRedo\":false,\"undoLabel\":null,\"redoLabel\":null}";

void EmitModelChanged( bool tree, const vector< string > &changed, const vector< string > &removed, const string &label )
{
    g_Rev++;
    Emit( "{\"type\":\"model_changed\",\"rev\":" + std::to_string( g_Rev ) +
          ",\"tree\":" + ( tree || !removed.empty() ? "true" : "false" ) +
          ",\"changed\":" + StrArray( changed ) + ",\"removed\":" + StrArray( removed ) +
          ",\"label\":" + ( label.empty() ? string( "null" ) : Quote( label ) ) +
          ",\"undo\":" + NO_UNDO + "}" );
}

#ifdef WEBVSP_SCRIPT_GUARD_TEST
void InjectGuardedWriteScript( const char *phase );
void TestWriteBarrier( int phase );
#endif

// Every ~150 ms, and right after each edit: report what the GUI or a request changed.
void Watch( const string &label = "", bool force = false )
{
#ifdef WEBVSP_SCRIPT_GUARD_TEST
    InjectGuardedWriteScript( "post" );
    TestWriteBarrier( 1 ); // guarded Watch entry, after optional post injection
#endif
    bool updated = vsp::GetAndResetUpdateCount() > 0;
    string sig = TreeSignature();
    bool tree_changed = sig != g_TreeSig;
    if ( !updated && !tree_changed && !force )
    {
        return;
    }
    g_TreeSig = sig;
    vector< string > changed, removed;
    RefreshFingerprints( changed, removed );
    if ( !changed.empty() || !removed.empty() )
    {
        g_Dirty = true;
    }
    if ( !changed.empty() || !removed.empty() || tree_changed || force )
    {
#ifdef WEBVSP_SCRIPT_GUARD_TEST
        InjectGuardedWriteScript( "watch" );
#endif
        EmitModelChanged( tree_changed, changed, removed, label );
    }
}

//==== Requests ====//

// Only results are staged: watcher events must remain observable as they happen.
struct GuardedWriteState
{
    ScriptMgrSingleton::ExecuteScriptGuard guard;
    bool started = false;
    string result;
    GuardedWriteState() : guard( ScriptMgrSingleton::getInstance() ) {}
};
thread_local GuardedWriteState *g_GuardedWrite = nullptr;

#ifdef WEBVSP_SCRIPT_GUARD_TEST
// Test-only rendezvous uses a separate lock: take() must remain usable while
// the engine pthread is paused. The browser never waits on this condition.
std::mutex g_TestBarrierMutex;
std::condition_variable g_TestBarrierCv;
int g_TestBarrierPhase = 0; // 1: Watch entry, 2: before final guard check
int g_TestBarrierState = 0; // 0: idle, 1: armed, 2: paused, 3: timed out

bool TestBarrierArm( int phase )
{
    std::lock_guard< std::mutex > lock( g_TestBarrierMutex );
    if ( ( phase != 1 && phase != 2 ) || g_TestBarrierState != 0 ) return false;
    g_TestBarrierPhase = phase;
    g_TestBarrierState = 1;
    return true;
}

int TestBarrierState()
{
    std::lock_guard< std::mutex > lock( g_TestBarrierMutex );
    return g_TestBarrierState;
}

void TestBarrierRelease()
{
    std::lock_guard< std::mutex > lock( g_TestBarrierMutex );
    g_TestBarrierState = 0;
    g_TestBarrierCv.notify_all();
}

void TestWriteBarrier( int phase )
{
    if ( !g_GuardedWrite ) return;
    std::unique_lock< std::mutex > lock( g_TestBarrierMutex );
    if ( g_TestBarrierState != 1 || g_TestBarrierPhase != phase ) return;
    g_TestBarrierState = 2;
    if ( !g_TestBarrierCv.wait_for( lock, std::chrono::seconds( 15 ), [] { return g_TestBarrierState != 2; } ) )
        g_TestBarrierState = 3;
}

string g_InjectionArmed, g_InjectionActive, g_InjectionModule;

int ExecuteGuardedWriteInjection()
{
    return ScriptMgrSingleton::getInstance().ExecuteScript( g_InjectionModule.c_str(), "int main()" );
}

void InjectGuardedWriteScript( const char *phase )
{
    if ( g_GuardedWrite && g_InjectionActive == phase )
    {
        g_InjectionActive.clear();
        ExecuteGuardedWriteInjection();
    }
}
#endif

void PublishResult( const string &json )
{
    if ( g_GuardedWrite ) g_GuardedWrite->result = json;
    else Emit( json );
}

// Called immediately before the first potentially mutating API call.
bool BeginGuardedWrite()
{
    if ( !g_GuardedWrite ) return true;
#ifdef WEBVSP_SCRIPT_GUARD_TEST
    InjectGuardedWriteScript( "pre" );
#endif
    if ( g_GuardedWrite->guard.Attempted() ) return false;
    g_GuardedWrite->started = true;
    return true;
}

void Result( int id, const string &error, const string &value_json, bool binary = false )
{
    if ( !error.empty() )
    {
        PublishResult( "{\"t\":\"result\",\"id\":" + std::to_string( id ) + ",\"ok\":false,\"error\":" + Quote( error ) + "}" );
    }
    else
    {
        PublishResult( "{\"t\":\"result\",\"id\":" + std::to_string( id ) + ",\"ok\":true" +
              ( binary ? ",\"bin\":true" : ",\"value\":" + ( value_json.empty() ? string( "null" ) : value_json ) ) + "}" );
    }
}

// The fixed results diagnostic owns a short-lived ResultsMgr object on the engine
// thread.  The token is deliberately opaque: the native ResultsMgr ID never crosses
// the bridge, and only the fixed fields below can be queried.  The expiry is also the
// cleanup path when a Pyodide worker dies without running Python finally blocks.
struct SyncResultsFixtureState
{
    string token;
    string result_id;
    uint64_t serial = 0;
    std::chrono::steady_clock::time_point expires;
};
SyncResultsFixtureState g_SyncResultsFixture;

void ClearSyncResultsFixture()
{
    if ( !g_SyncResultsFixture.result_id.empty() )
        ResultsMgrSingleton::getInstance().DeleteResult( g_SyncResultsFixture.result_id );
    g_SyncResultsFixture.token.clear();
    g_SyncResultsFixture.result_id.clear();
    g_SyncResultsFixture.expires = std::chrono::steady_clock::time_point();
}

void ExpireSyncResultsFixture()
{
    if ( !g_SyncResultsFixture.token.empty() && std::chrono::steady_clock::now() >= g_SyncResultsFixture.expires )
        ClearSyncResultsFixture();
}

string IntArrayJson( const vector< int > &values )
{
    string out = "[";
    if ( values.size() > 64 ) return string();
    for ( size_t i = 0; i < values.size(); ++i ) out += ( i ? "," : "" ) + std::to_string( values[i] );
    return out + "]";
}

string DoubleArrayJson( const vector< double > &values )
{
    string out = "[";
    if ( values.size() > 64 ) return string();
    for ( size_t i = 0; i < values.size(); ++i )
    {
        if ( !std::isfinite( values[i] ) ) return string();
        out += ( i ? "," : "" ) + Num( values[i] );
    }
    return out + "]";
}

string DoubleMatrixJson( const vector< vector< double > > &values )
{
    if ( values.size() > 16 ) return string();
    string out = "[";
    for ( size_t r = 0; r < values.size(); ++r )
    {
        if ( values[r].size() > 16 ) return string();
        string row = DoubleArrayJson( values[r] );
        if ( row.empty() ) return string();
        out += ( r ? "," : "" ) + row;
    }
    return out + "]";
}

string Vec3dArrayJson( const vector< vec3d > &values )
{
    if ( values.size() > 64 ) return string();
    string out = "[";
    for ( size_t i = 0; i < values.size(); ++i )
    {
        if ( !std::isfinite( values[i].x() ) || !std::isfinite( values[i].y() ) || !std::isfinite( values[i].z() ) ) return string();
        out += ( i ? "," : "" ) + string( "[" ) + Num( values[i].x() ) + "," + Num( values[i].y() ) + "," + Num( values[i].z() ) + "]";
    }
    return out + "]";
}

bool SyncFixtureField( const string &name )
{
    return name == "Int_Value" || name == "String_Value" || name == "Double_Value" ||
           name == "Double_Matrix" || name == "Vec3d_Value";
}

bool SyncFixtureToken( const string &token, string &result_id )
{
    ExpireSyncResultsFixture();
    if ( token.empty() || token != g_SyncResultsFixture.token ) return false;
    result_id = g_SyncResultsFixture.result_id;
    return !result_id.empty();
}

vector< string > SplitFixtureCommand( const string &command )
{
    vector< string > parts;
    size_t start = 0;
    while ( start <= command.size() )
    {
        size_t end = command.find( ':', start );
        parts.push_back( command.substr( start, end == string::npos ? string::npos : end - start ) );
        if ( end == string::npos ) break;
        start = end + 1;
    }
    return parts;
}

bool SyncFixtureData( const string &token, string &result_id, string &err )
{
    if ( !SyncFixtureToken( token, result_id ) )
    {
        err = "Results fixture is missing or expired";
        return false;
    }
    if ( !ResultsMgrSingleton::getInstance().ValidResultsID( result_id ) )
    {
        err = "Results fixture was deleted";
        ClearSyncResultsFixture();
        return false;
    }
    return true;
}

bool SyncFixtureFieldName( const string &name )
{
    return SyncFixtureField( name ) && name.size() <= 64;
}

bool SyncFixtureError( string &err )
{
    err = TakeErrors();
    return !err.empty();
}

string SyncFixtureStringArray( const vector< string > &values )
{
    if ( values.size() > 8 ) return string();
    for ( const string &value : values ) if ( value.size() > 64 ) return string();
    return StrArray( values );
}

// Live result reads have no fixture-sized limits; the transport caps the whole
// response instead. They still fail closed on absurd sizes and non-finite values.
constexpr size_t LIVE_MAX_VALUES = 400000;
constexpr size_t LIVE_MAX_CHARS = 6 * 1024 * 1024;

string LiveStringArray( const vector< string > &values )
{
    return StrArray( values );
}

bool LiveTooLarge( size_t n, string &err )
{
    if ( n > LIVE_MAX_VALUES ) { err = "Result field too large for the synchronous transport"; return true; }
    return false;
}

string LiveIntArray( const vector< int > &values )
{
    string out = "[";
    for ( size_t i = 0; i < values.size(); ++i )
    {
        out += ( i ? "," : "" ) + std::to_string( values[i] );
        if ( out.size() > LIVE_MAX_CHARS ) return string();
    }
    return out + "]";
}

string LiveDoubleArray( const vector< double > &values )
{
    string out = "[";
    for ( size_t i = 0; i < values.size(); ++i )
    {
        if ( !std::isfinite( values[i] ) ) return string();
        out += ( i ? "," : "" ) + Num( values[i] );
        if ( out.size() > LIVE_MAX_CHARS ) return string();
    }
    return out + "]";
}

string LiveDoubleMatrix( const vector< vector< double > > &values, size_t &count )
{
    string out = "[";
    count = 0;
    for ( size_t r = 0; r < values.size(); ++r )
    {
        count += values[r].size();
        if ( count > LIVE_MAX_VALUES ) return string();
        const string row = LiveDoubleArray( values[r] );
        if ( row.empty() && !values[r].empty() ) return string();
        out += ( r ? "," : "" ) + row;
    }
    return out + "]";
}

string LiveVec3dArray( const vector< vec3d > &values )
{
    string out = "[";
    for ( size_t i = 0; i < values.size(); ++i )
    {
        if ( !std::isfinite( values[i].x() ) || !std::isfinite( values[i].y() ) || !std::isfinite( values[i].z() ) ) return string();
        out += ( i ? "," : "" ) + string( "[" ) + Num( values[i].x() ) + "," + Num( values[i].y() ) + "," + Num( values[i].z() ) + "]";
    }
    return out + "]";
}

// Phase 3 result-tree snapshot. This is a JSON control-plane optimization:
// one engine request walks the ResultsMgr graph and returns all metadata and
// fields reachable from a root. Non-finite doubles are represented as null;
// Phase 4 replaces this payload with a binary protocol that preserves them.
string LiveTreeNumber( double value )
{
    return std::isfinite( value ) ? Num( value ) : "null";
}

string LiveTreeValue( const NameValData *data )
{
    if ( !data ) return "null";
    switch ( data->GetType() )
    {
    case vsp::INT_DATA: return IntArrayJson( data->GetIntData() );
    case vsp::DOUBLE_DATA:
    {
        string out = "[";
        const auto &values = data->GetDoubleData();
        for ( size_t i = 0; i < values.size(); ++i ) out += ( i ? "," : "" ) + LiveTreeNumber( values[i] );
        return out + "]";
    }
    case vsp::STRING_DATA: return StrArray( data->GetStringData() );
    case vsp::VEC3D_DATA:
    {
        string out = "[";
        const auto &values = data->GetVec3dData();
        for ( size_t i = 0; i < values.size(); ++i )
        {
            out += ( i ? "," : "" ) + string( "[" ) + LiveTreeNumber( values[i].x() ) + "," +
                   LiveTreeNumber( values[i].y() ) + "," + LiveTreeNumber( values[i].z() ) + "]";
        }
        return out + "]";
    }
    case vsp::INT_MATRIX_DATA:
    {
        string out = "[";
        const auto &rows = data->GetIntMatData();
        for ( size_t r = 0; r < rows.size(); ++r ) out += ( r ? "," : "" ) + IntArrayJson( rows[r] );
        return out + "]";
    }
    case vsp::DOUBLE_MATRIX_DATA:
    {
        string out = "[";
        const auto &rows = data->GetDoubleMatData();
        for ( size_t r = 0; r < rows.size(); ++r )
        {
            out += ( r ? "," : "" ) + string( "[" );
            for ( size_t c = 0; c < rows[r].size(); ++c ) out += ( c ? "," : "" ) + LiveTreeNumber( rows[r][c] );
            out += "]";
        }
        return out + "]";
    }
    default: return "null";
    }
}

// VRO1 is one bounded Results object, index zero only; strings are never IDs.
// Every length is checked before copying, including metadata and empty rows.
vector< uint8_t > LiveBinaryObject( Results *result )
{
    constexpr size_t MAX_BYTES = 512 * 1024, MAX_ITEMS = 32768, MAX_FIELDS = 1024;
    vector< uint8_t > out = { 'V', 'R', 'O', '1' };
    size_t items = 0;
    auto room = [&]( size_t n ) { return n <= MAX_BYTES - out.size(); };
    auto put32 = [&]( size_t n ) { if ( n > UINT32_MAX || !room( 4 ) ) return false; Put32( out, n ); return true; };
    auto text = [&]( const string &s ) {
        if ( s.size() > MAX_BYTES - 4 || !room( 4 + s.size() ) ) return false;
        Put32( out, s.size() ); out.insert( out.end(), s.begin(), s.end() ); return true;
    };
    auto count = [&]( size_t n ) { if ( n > MAX_ITEMS - items ) return false; items += n; return true; };
    auto numeric = [&]( const auto &v ) {
        if ( !count( v.size() ) || v.size() > ( MAX_BYTES - 4 ) / sizeof( v[0] ) ||
             !room( 4 + v.size() * sizeof( v[0] ) ) ) return false;
        Put32( out, v.size() );
        if ( !v.empty() ) { const auto *p = reinterpret_cast< const uint8_t * >( v.data() ); out.insert( out.end(), p, p + v.size() * sizeof( v[0] ) ); }
        return true;
    };
    const auto names = result->GetAllDataNames();
    if ( names.size() > MAX_FIELDS || !text( result->GetName() ) || !put32( names.size() ) ) return {};
    for ( const auto &name : names )
    {
        const NameValData *d = result->FindPtr( name, 0 );
        if ( !d || !text( name ) || !put32( d->GetType() ) ) return {};
        switch ( d->GetType() )
        {
        case vsp::INT_DATA: if ( !numeric( d->GetIntData() ) ) return {}; break;
        case vsp::DOUBLE_DATA: if ( !numeric( d->GetDoubleData() ) ) return {}; break;
        case vsp::STRING_DATA:
        {
            const auto &v = d->GetStringData();
            if ( !count( v.size() ) || !put32( v.size() ) ) return {};
            for ( const auto &s : v ) if ( !text( s ) ) return {};
            break;
        }
        case vsp::DOUBLE_MATRIX_DATA:
        {
            const auto &v = d->GetDoubleMatData();
            if ( !count( v.size() ) || !put32( v.size() ) ) return {};
            for ( const auto &row : v ) if ( !numeric( row ) ) return {};
            break;
        }
        case vsp::VEC3D_DATA:
        {
            const auto &v = d->GetVec3dData();
            if ( !count( v.size() ) || v.size() > ( MAX_BYTES - 4 ) / 24 || !room( 4 + 24 * v.size() ) ) return {};
            Put32( out, v.size() );
            for ( const auto &p : v ) { const double xyz[] = { p.x(), p.y(), p.z() }; const auto *b = reinterpret_cast< const uint8_t * >( xyz ); out.insert( out.end(), b, b + sizeof( xyz ) ); }
            break;
        }
        default: return {};
        }
    }
    return out;
}

// VRB2: type, row count, row index, row length, offset, count, then
// at most 4096 native little-endian values (or UTF-8 bytes for strings).
// Empty matrices and string vectors use row == rows.
// Reading directly from NameValData avoids an unbounded intermediate copy.
vector< uint8_t > LiveBinaryField( const NameValData *data, size_t row, size_t offset )
{
    if ( !data ) return {};
    const int type = data->GetType();
    size_t rows = 0, length = 0;
    if ( type == vsp::INT_DATA || type == vsp::DOUBLE_DATA ) rows = 1;
    else if ( type == vsp::INT_MATRIX_DATA ) rows = data->GetIntMatData().size();
    else if ( type == vsp::DOUBLE_MATRIX_DATA ) rows = data->GetDoubleMatData().size();
    else if ( type == vsp::VEC3D_DATA ) rows = data->GetVec3dData().size();
    else if ( type == vsp::STRING_DATA ) rows = data->GetStringData().size();
    else return {};
    if ( rows > UINT32_MAX || row > rows || ( row == rows && ( rows != 0 || offset != 0 ) ) ) return {};
    if ( row < rows )
    {
        if ( type == vsp::INT_DATA ) length = data->GetIntData().size();
        else if ( type == vsp::DOUBLE_DATA ) length = data->GetDoubleData().size();
        else if ( type == vsp::INT_MATRIX_DATA ) length = data->GetIntMatData()[row].size();
        else if ( type == vsp::DOUBLE_MATRIX_DATA ) length = data->GetDoubleMatData()[row].size();
        else if ( type == vsp::STRING_DATA ) length = data->GetStringData()[row].size();
        else length = 3;
    }
    if ( length > UINT32_MAX || offset > length ) return {};
    const size_t count = std::min( size_t( 4096 ), length - offset );
    vector< uint8_t > out = { 'V', 'R', 'B', '2' };
    Put32( out, type ); Put32( out, rows ); Put32( out, row );
    Put32( out, length ); Put32( out, offset ); Put32( out, count );
    auto append = [&]( const auto &values ) {
        if ( count )
        {
            const uint8_t *p = reinterpret_cast< const uint8_t * >( values.data() + offset );
            out.insert( out.end(), p, p + count * sizeof( values[0] ) );
        }
    };
    if ( row < rows )
    {
        if ( type == vsp::INT_DATA ) append( data->GetIntData() );
        else if ( type == vsp::DOUBLE_DATA ) append( data->GetDoubleData() );
        else if ( type == vsp::INT_MATRIX_DATA ) append( data->GetIntMatData()[row] );
        else if ( type == vsp::DOUBLE_MATRIX_DATA ) append( data->GetDoubleMatData()[row] );
        else if ( type == vsp::STRING_DATA )
        {
            const string &value = data->GetStringData()[row];
            const size_t bytes = std::min( size_t( 4096 ), value.size() - offset );
            out.insert( out.end(), value.begin() + offset, value.begin() + offset + bytes );
        }
        else { const auto &p = data->GetVec3dData()[row]; const vector< double > xyz = { p.x(), p.y(), p.z() }; append( xyz ); }
    }
    return out;
}

void LiveTreeAppend( const string &id, std::set< string > &seen, string &out )
{
    if ( id.empty() || seen.count( id ) ) return;
    Results *result = ResultsMgrSingleton::getInstance().FindResultsPtr( id );
    if ( !result ) return;
    seen.insert( id );
    out += ( seen.size() == 1 ? "" : "," ) + string( "{\"id\":" ) + Quote( id ) +
           ",\"name\":" + Quote( result->GetName() ) + ",\"fields\":[";
    bool first = true;
    vector< string > children;
    for ( const string &name : result->GetAllDataNames() )
    {
        const int count = result->GetNumData( name );
        for ( int index = 0; index < count; ++index )
        {
            NameValData *data = result->FindPtr( name, index );
            if ( !data ) continue;
            if ( !first ) out += ",";
            first = false;
            out += "{\"name\":" + Quote( name ) + ",\"type\":" + std::to_string( data->GetType() ) +
                   ",\"index\":" + std::to_string( index ) + ",\"value\":" + LiveTreeValue( data ) + "}";
            if ( data->GetType() == vsp::STRING_DATA )
                for ( const string &child : data->GetStringData() ) if ( ResultsMgrSingleton::getInstance().FindResultsPtr( child ) ) children.push_back( child );
        }
    }
    out += "]}";
    for ( const string &child : children ) LiveTreeAppend( child, seen, out );
}

vector< string > SplitCsv( const string &s )
{
    vector< string > out;
    std::stringstream ss( s );
    string item;
    while ( std::getline( ss, item, ',' ) )
    {
        if ( !item.empty() )
        {
            out.push_back( item );
        }
    }
    return out;
}

enum class MissingParmOwner { None, Geom, XSec };

#ifdef WEBVSP_SCRIPT_GUARD_TEST
// One-shot fault at the API boundary, only for guarded parameter reads.
string g_ParmReadFault;
string g_ParmReadFaultMessage;
// Arms belong to exactly one guarded write, including early-return paths.
string g_WriteErrorArmed, g_WriteErrorMode, g_WriteErrorActive, g_WriteErrorActiveMode;
void InjectWriteError( const char *point )
{
    if ( !g_GuardedWrite || g_WriteErrorActive != point ) return;
    g_WriteErrorActive.clear();
    auto &mgr = vsp::ErrorMgrSingleton::getInstance();
    if ( g_WriteErrorActiveMode == "mixed" )
        mgr.AddError( vsp::VSP_INVALID_PTR, "Injected write error" );
    mgr.AddError( vsp::VSP_INVALID_ID, "" );
}
void InjectParmReadFault( const char *point, bool guarded )
{
    if ( guarded && g_ParmReadFault == point )
    {
        g_ParmReadFault.clear();
        vsp::ErrorMgrSingleton::getInstance().AddError( vsp::VSP_INVALID_ID, g_ParmReadFaultMessage );
    }
}
#endif

// A present error with an empty message must not look like successful enumeration.
// Preserve legacy behavior outside guarded parameter reads.
string TakeParmErrors( bool guarded )
{
    bool had_errors = guarded && vsp::ErrorMgrSingleton::getInstance().GetNumTotalErrors() != 0;
    string err = TakeErrors();
    return had_errors && err.empty() ? "OpenVSP parameter API error (no message)" : err;
}

// Strict writes must distinguish an empty error description from no error. Keep
// TakeErrors and guarded read formatting unchanged for their existing callers.
DrainedErrors TakeWriteErrors()
{
    return DrainErrors( vsp::ErrorMgrSingleton::getInstance(), "OpenVSP API error (no message)" );
}

bool TakeOwnerErrors( bool strict, bool guarded_read, string &err )
{
    if ( strict )
    {
        DrainedErrors errors = TakeWriteErrors();
        err = errors.message;
        return errors.had_errors;
    }
    err = TakeParmErrors( guarded_read );
    return !err.empty();
}

DrainedErrors TakeScopedWriteErrors( bool guarded )
{
    if ( guarded ) return TakeWriteErrors();
    DrainedErrors errors;
    errors.message = TakeErrors();
    errors.had_errors = !errors.message.empty();
    return errors;
}

// Parameter owners must be reachable from the current model, not merely registered in
// the vehicle's geom store (which also contains clipboard copies).
bool CurrentModelGeom( const string &geom, string &err, MissingParmOwner *missing = nullptr, bool strict = false )
{
    vector< string > geoms = vsp::FindGeoms();
#ifdef WEBVSP_SCRIPT_GUARD_TEST
    InjectParmReadFault( "FindGeoms", missing != nullptr );
    if ( strict ) InjectWriteError( "FindGeoms" );
#endif
    if ( TakeOwnerErrors( strict, missing != nullptr, err ) ) return false;
    if ( std::find( geoms.begin(), geoms.end(), geom ) == geoms.end() )
    {
        err = "Geom not found in the current model: " + geom;
        if ( missing ) *missing = MissingParmOwner::Geom;
        return false;
    }
    return true;
}

// Only guarded parameter reads expose owner absence as a structured code. Other failures,
// including failed enumeration, retain the ordinary engine-error result.
void ParmReadFailure( const Job &j, const string &err, MissingParmOwner missing )
{
    if ( j.guarded && missing != MissingParmOwner::None )
    {
        const char *code = missing == MissingParmOwner::Geom ? "GEOMETRY_NOT_FOUND" : "CROSS_SECTION_NOT_FOUND";
        PublishResult( "{\"t\":\"result\",\"id\":" + std::to_string( j.id ) +
                       ",\"ok\":false,\"error\":" + Quote( err ) + ",\"code\":" + Quote( code ) + "}" );
    }
    else Result( j.id, err, "" );
}

// Enumerate only live XSecs reachable through a geom; a globally registered XSec may be a
// clipboard or otherwise not part of the current model. Propagate errors even for empty lists.
bool GeomXSecs( const string &geom, string &json, bool &found, const string &wanted, string &err, bool guarded = false, bool strict = false )
{
    vector< string > surfaces = vsp::GetXSecSurfIDVec( geom );
#ifdef WEBVSP_SCRIPT_GUARD_TEST
    InjectParmReadFault( "GetXSecSurfIDVec", guarded );
    if ( strict ) InjectWriteError( "GetXSecSurfIDVec" );
#endif
    if ( TakeOwnerErrors( strict, guarded, err ) ) return false;
    json = "[";
    for ( size_t s = 0; s < surfaces.size(); ++s )
    {
        int count = vsp::GetNumXSec( surfaces[s] );
#ifdef WEBVSP_SCRIPT_GUARD_TEST
        InjectParmReadFault( "GetNumXSec", guarded );
        if ( strict ) InjectWriteError( "GetNumXSec" );
#endif
        if ( TakeOwnerErrors( strict, guarded, err ) ) return false;
        vector< string > ids;
        for ( int i = 0; i < count; ++i )
        {
            string id = vsp::GetXSec( surfaces[s], i );
#ifdef WEBVSP_SCRIPT_GUARD_TEST
            InjectParmReadFault( "GetXSec", guarded );
            if ( strict ) InjectWriteError( "GetXSec" );
#endif
            if ( TakeOwnerErrors( strict, guarded, err ) ) return false;
            ids.push_back( id );
            if ( !wanted.empty() && id == wanted ) found = true;
        }
        json += ( s ? "," : "" ) + string( "{\"id\":" ) + Quote( surfaces[s] ) +
                ",\"xsecs\":" + StrArray( ids ) + "}";
    }
    json += "]";
    return true;
}

bool ParmIDs( bool xsec, const string &owner, vector< string > &ids, string &err, MissingParmOwner *missing = nullptr, bool strict = false )
{
    if ( xsec )
    {
        vector< string > geoms = vsp::FindGeoms();
#ifdef WEBVSP_SCRIPT_GUARD_TEST
        InjectParmReadFault( "FindGeoms", missing != nullptr );
        if ( strict ) InjectWriteError( "FindGeoms" );
#endif
        if ( TakeOwnerErrors( strict, missing != nullptr, err ) ) return false;
        bool found = false;
        for ( const string &geom : geoms )
        {
            string unused;
            if ( !GeomXSecs( geom, unused, found, owner, err, missing != nullptr, strict ) ) return false;
            if ( found ) break;
        }
        if ( !found )
        {
            err = "XSec not found in the current model: " + owner;
            if ( missing ) *missing = MissingParmOwner::XSec;
            return false;
        }
        ids = vsp::GetXSecParmIDs( owner );
#ifdef WEBVSP_SCRIPT_GUARD_TEST
        if ( strict ) InjectWriteError( "GetXSecParmIDs" );
#endif
    }
    else
    {
        if ( !CurrentModelGeom( owner, err, missing, strict ) ) return false;
        ids = vsp::GetGeomParmIDs( owner );
#ifdef WEBVSP_SCRIPT_GUARD_TEST
        if ( strict ) InjectWriteError( "GetGeomParmIDs" );
#endif
    }
    return !TakeOwnerErrors( strict, missing != nullptr, err );
}

// Error stack entries persist across successful API calls, so inspect it before accepting any
// of the API's fallback values. Num renders NaN/infinity as JSON null, including for limits.
bool ParmMetadata( const string &id, string &json, string &err, bool guarded = false )
{
    double value = vsp::GetParmVal( id );
    int type = vsp::GetParmType( id );
    string name = vsp::GetParmName( id );
    string group = vsp::GetParmGroupName( id );
    string container = vsp::GetParmContainer( id );
    double lower = vsp::GetParmLowerLimit( id );
    double upper = vsp::GetParmUpperLimit( id );
    bool active = vsp::GetParmActiveFlag( id );
    if ( !( err = TakeParmErrors( guarded ) ).empty() ) return false;
    json = "{\"id\":" + Quote( id ) + ",\"value\":" + Num( value ) +
           ",\"type\":" + std::to_string( type ) + ",\"name\":" + Quote( name ) +
           ",\"group\":" + Quote( group ) + ",\"container\":" + Quote( container ) +
           ",\"lowerLimit\":" + Num( lower ) + ",\"upperLimit\":" + Num( upper ) +
           ",\"active\":" + ( active ? "true" : "false" ) + "}";
    return true;
}

// Resolve the one top-level fuselage Length parameter in a single engine job. Geometry
// linkable lists can include nested XSec containers, so name/group alone is insufficient.
// All matches are counted; silently choosing the first would hide ambiguous data.
bool FuselageLength( const string &geom, string &json, string &err, MissingParmOwner *missing = nullptr )
{
    if ( !CurrentModelGeom( geom, err, missing ) ) return false;
    Vehicle *veh = VehicleMgr.GetVehicle();
    Geom *g = veh ? veh->FindGeom( geom ) : nullptr;
    if ( !g )
    {
        err = "Geom not found in the current model: " + geom;
        return false;
    }
    if ( g->GetType().m_Type != FUSELAGE_GEOM_TYPE )
    {
        err = "Geom is not a fuselage: " + geom;
        return false;
    }
    vector< string > ids;
    if ( !ParmIDs( false, geom, ids, err, missing ) ) return false;
    std::set< string > unique;
    vector< string > matches;
    for ( const string &id : ids )
    {
        if ( id.empty() || !unique.insert( id ).second )
        {
            err = "Invalid or duplicate geometry parameter ID";
            return false;
        }
        string name = vsp::GetParmName( id );
        string group = vsp::GetParmGroupName( id );
        string container = vsp::GetParmContainer( id );
        if ( !( err = TakeParmErrors( missing != nullptr ) ).empty() ) return false;
        if ( name == "Length" && group == "Design" && container == geom ) matches.push_back( id );
    }
    if ( matches.size() != 1 )
    {
        err = "Fuselage Design/Length parameter is missing or ambiguous";
        return false;
    }
    return ParmMetadata( matches[0], json, err, missing != nullptr );
}

// Failures before the setter are known not to have written. After invoking it, even an API
// error may follow side effects; readback is informative but cannot establish atomicity.
void ParmWriteFailure( int id, const string &error, const string &outcome, const string &actual )
{
    PublishResult( "{\"t\":\"result\",\"id\":" + std::to_string( id ) +
          ",\"ok\":false,\"error\":" + Quote( error ) + ",\"outcome\":" + Quote( outcome ) +
          ",\"actual\":" + actual + "}" );
}

void ScopedParmWrite( const Job &j, bool xsec )
{
    vector< string > ids;
    string err;
    if ( !ParmIDs( xsec, j.a, ids, err, nullptr, j.guarded ) )
        return ParmWriteFailure( j.id, err, "not_written", "null" );
    if ( std::find( ids.begin(), ids.end(), j.b ) == ids.end() )
        return ParmWriteFailure( j.id, "Parm is not linkable for the requested owner: " + j.b, "not_written", "null" );

    double old = vsp::GetParmVal( j.b );
    int type = vsp::GetParmType( j.b );
    double lower = vsp::GetParmLowerLimit( j.b );
    double upper = vsp::GetParmUpperLimit( j.b );
    bool active = vsp::GetParmActiveFlag( j.b );
#ifdef WEBVSP_SCRIPT_GUARD_TEST
    InjectWriteError( "metadata" );
#endif
    DrainedErrors metadata_errors = TakeScopedWriteErrors( j.guarded );
    if ( metadata_errors.had_errors )
        return ParmWriteFailure( j.id, "Cannot read parm metadata: " + metadata_errors.message, "not_written", "null" );
    if ( !std::isfinite( j.value ) )
        return ParmWriteFailure( j.id, "Requested value must be finite", "not_written", Num( old ) );
    if ( !std::isfinite( old ) || std::isnan( lower ) || std::isnan( upper ) || lower > upper )
        return ParmWriteFailure( j.id, "Invalid parm value or limits", "not_written", Num( old ) );
    if ( !active )
        return ParmWriteFailure( j.id, "Parm is inactive", "not_written", Num( old ) );
    if ( j.value < lower || j.value > upper )
        return ParmWriteFailure( j.id, "Requested value is outside parm limits", "not_written", Num( old ) );

    switch ( type )
    {
    // The public API does not expose the quantization/paired-parameter constraints needed
    // for safe preflight; reject rather than let the setter silently change another value.
    case vsp::PARM_LIMITED_INT_TYPE:
    case vsp::PARM_POWER_INT_TYPE:
    case vsp::PARM_NOTEQ_TYPE:
        return ParmWriteFailure( j.id, "Parm type requires unsupported constraint validation", "not_written", Num( old ) );
    case vsp::PARM_INT_TYPE:
    case vsp::PARM_BOOL_TYPE:
        if ( std::trunc( j.value ) != j.value ||
             j.value < std::numeric_limits< int >::min() || j.value > std::numeric_limits< int >::max() ||
             ( type == vsp::PARM_BOOL_TYPE && j.value != 0 && j.value != 1 ) )
            return ParmWriteFailure( j.id, "Requested value is invalid for an integer or boolean parm", "not_written", Num( old ) );
        break;
    case vsp::PARM_DOUBLE_TYPE:
    case vsp::PARM_FRACTION_TYPE:
        break;
    default:
        return ParmWriteFailure( j.id, "Unsupported parm type: " + std::to_string( type ), "not_written", Num( old ) );
    }

    if ( !BeginGuardedWrite() ) return;
    vsp::SetParmValUpdate( j.b, j.value );
#ifdef WEBVSP_SCRIPT_GUARD_TEST
    InjectWriteError( "setter" );
#endif
    DrainedErrors set_error = TakeScopedWriteErrors( j.guarded );
    double actual = vsp::GetParmVal( j.b );
#ifdef WEBVSP_SCRIPT_GUARD_TEST
    InjectWriteError( "readback" );
#endif
    DrainedErrors read_error = TakeScopedWriteErrors( j.guarded );
    Watch( "Parameter change", true );
    if ( set_error.had_errors || read_error.had_errors || !std::isfinite( actual ) )
    {
        string message = !set_error.had_errors ? "" : "SetParmValUpdate failed: " + set_error.message;
        if ( read_error.had_errors ) message += ( message.empty() ? "" : "; " ) + string( "Readback failed: " ) + read_error.message;
        else if ( !std::isfinite( actual ) ) message += ( message.empty() ? "" : "; " ) + string( "Readback is non-finite" );
        return ParmWriteFailure( j.id, message, "unknown", !read_error.had_errors ? Num( actual ) : "null" );
    }
    if ( actual != j.value )
        return ParmWriteFailure( j.id, "Readback differs from requested value; update may have side effects", "different", Num( actual ) );
    Result( j.id, "", "{\"actual\":" + Num( actual ) + "}" );
}

// Parse without locale, signs, leading zeroes, or unsigned wraparound. Never access the
// Vehicle on the submitting thread; both this check and the operation run on its owner.
bool ParseModelEpoch( const string &text, uint64_t &epoch )
{
    if ( text.empty() || ( text.size() > 1 && text[0] == '0' ) ) return false;
    uint64_t n = 0;
    for ( char c : text )
    {
        if ( c < '0' || c > '9' ) return false;
        unsigned digit = static_cast< unsigned >( c - '0' );
        if ( n > ( std::numeric_limits< uint64_t >::max() - digit ) / 10 ) return false;
        n = n * 10 + digit;
    }
    epoch = n;
    return true;
}

// This diagnostic is absent unless explicitly compiled in (e.g. with
// -DWEBVSP_SCRIPT_GUARD_TEST). It accepts no script or other caller-controlled input.
#ifdef WEBVSP_SCRIPT_GUARD_TEST
// Fixed VM/cache probe; only a single engine owner job touches these fixtures.
// Diagnostic evidence only, not a safety guarantee; use an isolated test instance.
void ScriptModuleCacheGuardCheck( int id, int fault )
{
    static bool used = false;
    if ( used ) return Result( id, "Disposable probe already used; discard instance", "" );
    used = true; // Irreversible even on failure: this instance is disposable.
    ScriptMgrSingleton &mgr = ScriptMgrSingleton::getInstance();
    asIScriptEngine *engine = mgr.GetTestScriptEngine();
    const string name = "WebVSP_VMCacheProbe_f4a63be_839517";
    const string other = "WebVSP_VMCacheProbeOther_f4a63be_839517";
    const string source = "int WebVSP_VMCacheProbe_f4a63be_839517() { return 839517; }";
    const string changed = "int WebVSP_VMCacheProbe_f4a63be_839517() { return 839518; }";
    if ( !engine || asGetActiveContext() ||
         engine->GetModule( name.c_str(), asGM_ONLY_IF_EXISTS ) ||
         engine->GetModule( other.c_str(), asGM_ONLY_IF_EXISTS ) ||
         mgr.TestModuleFixtureConflict( name, other, source, changed ) )
        return Result( id, "Probe module already exists or VM unavailable", "" );

    try
    {
    const bool baseline = engine->GetModule( name.c_str(), asGM_ONLY_IF_EXISTS ) != nullptr;
    // The failure fixture has invalid syntax: builder may leave a VM module without
    // a map entry. Never discard it directly; destroy the disposable instance.
    string created = mgr.ReadScriptFromMemory( name, fault == 1 ? "int WebVSP_BrokenProbe( {" : source );
    if ( created != name ) return Result( id, "Tainted disposable instance: fixture creation failed", "" );
    asIScriptModule *module = engine->GetModule( name.c_str(), asGM_ONLY_IF_EXISTS );
    bool initial, cache_same, after_cache, changed_rejected, after_changed;
    bool remove_rejected, after_remove, sticky_after_cache, intact;
    {
        ScriptMgrSingleton::ExecuteScriptGuard guard( mgr );
        initial = guard.Attempted();
        cache_same = mgr.ReadScriptFromMemory( name, source ) == name &&
                     engine->GetModule( name.c_str(), asGM_ONLY_IF_EXISTS ) == module;
        after_cache = guard.Attempted();
        changed_rejected = mgr.ReadScriptFromMemory( other, changed ).empty() &&
                           !engine->GetModule( other.c_str(), asGM_ONLY_IF_EXISTS );
        after_changed = guard.Attempted();
        sticky_after_cache = mgr.ReadScriptFromMemory( name, source ) == name && guard.Attempted();
        remove_rejected = !mgr.RemoveScript( name );
        after_remove = guard.Attempted();
        intact = engine->GetModule( name.c_str(), asGM_ONLY_IF_EXISTS ) == module;
    }
    bool remove_initial, remove_alone_rejected, remove_alone_attempted;
    {
        ScriptMgrSingleton::ExecuteScriptGuard guard( mgr );
        remove_initial = guard.Attempted();
        remove_alone_rejected = !mgr.RemoveScript( name );
        remove_alone_attempted = guard.Attempted();
    }
    // Simulate a failed removal without mutating the fixture. No retry: discard
    // the whole instance. Real failure is handled identically.
    bool removed = fault == 2 ? false : mgr.RemoveScript( name );
    bool absent = !engine->GetModule( name.c_str(), asGM_ONLY_IF_EXISTS );
    if ( fault == 2 ) return Result( id, "Tainted disposable instance: injected cleanup failure", "" );
    if ( !removed || !absent ) return Result( id, "Tainted disposable instance: actual cleanup failed", "" );
    if ( baseline || !module || initial || !cache_same || after_cache || !changed_rejected ||
         !after_changed || !sticky_after_cache || !remove_rejected || !after_remove || !intact ||
         remove_initial || !remove_alone_rejected || !remove_alone_attempted )
        return Result( id, "Tainted disposable instance: diagnostic assertion failed", "" );
    auto b = []( bool value ) { return value ? "true" : "false"; };
    string json = string( "{\"baseline\":" ) + b( baseline ) + ",\"created\":" + b( module != nullptr ) +
        ",\"initial\":" + b( initial ) + ",\"cacheSame\":" + b( cache_same ) +
        ",\"afterCache\":" + b( after_cache ) + ",\"changedRejected\":" + b( changed_rejected ) +
        ",\"afterChanged\":" + b( after_changed ) + ",\"stickyAfterCache\":" + b( sticky_after_cache ) +
        ",\"removeRejected\":" + b( remove_rejected ) + ",\"afterRemove\":" + b( after_remove ) +
        ",\"intact\":" + b( intact ) + ",\"removeInitial\":" + b( remove_initial ) +
        ",\"removeAloneRejected\":" + b( remove_alone_rejected ) + ",\"removeAloneAttempted\":" + b( remove_alone_attempted ) +
        ",\"removed\":" + b( removed ) + ",\"absent\":" + b( absent ) + "}";
    return Result( id, "", json );
    }
    catch ( ... )
    {
        return Result( id, "Tainted disposable instance: probe exception", "" );
    }
}

// One-shot probe for a fresh, disposable module only. Empty geometry alone cannot
// prove a model is disposable: this operation must never be used on a user session.
void ScriptGcGuardCheck( int id )
{
    static bool used = false;
    Vehicle *veh = VehicleMgr.GetVehicle();
    ScriptMgrSingleton &mgr = ScriptMgrSingleton::getInstance();
    asIScriptEngine *engine = mgr.GetTestScriptEngine();
    asUINT gc_objects = 0;
    if ( engine ) engine->GetGCStatistics( &gc_objects );
    if ( used || !veh || !veh->IsModelEpochValid() || !veh->GetGeomStoreVec().empty() ||
         !vsp::FindGeoms().empty() || !AdvLinkMgr.GetLinks().empty() || !engine ||
         asGetActiveContext() || gc_objects != 0 )
        return Result( id, "Requires a fresh disposable empty test module", "" );
    used = true;

    // Cleanup runs on all ordinary exits and exceptions, with auto GC restored last.
    struct Cleanup
    {
        asIScriptEngine *engine;
        ScriptMgrSingleton &mgr;
        asPWORD auto_gc;
        string module, victim;
        ~Cleanup()
        {
            // Drain a partially constructed cycle before its module and victim disappear.
            engine->GarbageCollect( asGC_FULL_CYCLE );
            if ( !module.empty() ) mgr.RemoveScript( module );
            if ( !victim.empty() )
            {
                Vehicle *v = VehicleMgr.GetVehicle();
                if ( v && v->FindGeom( victim ) ) v->DeleteGeomVec( { victim } );
            }
            engine->SetEngineProperty( asEP_AUTO_GARBAGE_COLLECT, auto_gc );
        }
    } cleanup{ engine, mgr, engine->GetEngineProperty( asEP_AUTO_GARBAGE_COLLECT ), "", "" };

    if ( engine->SetEngineProperty( asEP_AUTO_GARBAGE_COLLECT, 0 ) < 0 )
        return Result( id, "Could not disable automatic GC", "" );
    cleanup.victim = vsp::AddGeom( "BLANK" );
    if ( cleanup.victim.empty() || !veh->FindGeom( cleanup.victim ) )
        return Result( id, "Could not create victim", "" );
    const string script = "int destroyed = 0; class Cycle { Cycle@ self; "
        "~Cycle() { destroyed++; DeleteGeom(\"" + cleanup.victim + "\"); } } "
        "int main() { Cycle@ c = Cycle(); @c.self = c; return 0; }";
    cleanup.module = mgr.ReadScriptFromMemory( "WebVSP_GcGuardProbe", script );
    if ( cleanup.module.empty() ) return Result( id, "Could not build GC fixture", "" );
    asIScriptModule *module = engine->GetModule( cleanup.module.c_str() );
    int index = module ? module->GetGlobalVarIndexByName( "destroyed" ) : -1;
    int *destroyed = index >= 0 ? static_cast< int * >( module->GetAddressOfGlobalVar( index ) ) : nullptr;
    if ( !destroyed ) return Result( id, "Could not read destructor counter", "" );
    int rc = mgr.ExecuteScript( cleanup.module.c_str(), "int main()" );
    bool alive_before = veh->FindGeom( cleanup.victim ) != nullptr;
    int before = *destroyed;
    bool initial = false, attempted = false;
    int gc_rc;
    {
        ScriptMgrSingleton::ExecuteScriptGuard guard( mgr );
        initial = guard.Attempted();
        gc_rc = engine->GarbageCollect( asGC_FULL_CYCLE );
        attempted = guard.Attempted();
    }
    int after = *destroyed;
    bool alive_after = veh->FindGeom( cleanup.victim ) != nullptr;
    auto boolean = []( bool value ) { return value ? "true" : "false"; };
    string json = "{\"executeRc\":" + std::to_string( rc ) + ",\"gcRc\":" + std::to_string( gc_rc ) +
        ",\"aliveBefore\":" + boolean( alive_before ) + ",\"aliveAfter\":" + boolean( alive_after ) +
        ",\"destroyedBefore\":" + std::to_string( before ) + ",\"destroyedAfter\":" + std::to_string( after ) +
        ",\"initial\":" + boolean( initial ) + ",\"attempted\":" + boolean( attempted ) + "}";
    string err = TakeErrors();
    return Result( id, err, json );
}

// Probe reference-count destruction, separately from cycle collection. Never run on a
// user session: empty geometry alone does not establish that a model is disposable.
void ScriptReleaseGuardCheck( int id )
{
    static bool used = false;
    Vehicle *veh = VehicleMgr.GetVehicle();
    ScriptMgrSingleton &mgr = ScriptMgrSingleton::getInstance();
    asIScriptEngine *engine = mgr.GetTestScriptEngine();
    asUINT gc_objects = 0;
    if ( engine ) engine->GetGCStatistics( &gc_objects );
    if ( used || !veh || !veh->IsModelEpochValid() || !veh->GetGeomStoreVec().empty() ||
         !vsp::FindGeoms().empty() || !AdvLinkMgr.GetLinks().empty() || !engine ||
         asGetActiveContext() || gc_objects != 0 )
        return Result( id, "Requires a fresh disposable empty test module", "" );
    used = true;

    struct Cleanup
    {
        asIScriptEngine *engine;
        ScriptMgrSingleton &mgr;
        asPWORD auto_gc;
        string module, victim;
        asITypeInfo *type = nullptr;
        void *object = nullptr;
        ~Cleanup()
        {
            if ( object ) engine->ReleaseScriptObject( object, type );
            if ( !module.empty() ) mgr.RemoveScript( module );
            if ( !victim.empty() )
            {
                Vehicle *v = VehicleMgr.GetVehicle();
                if ( v && v->FindGeom( victim ) ) v->DeleteGeomVec( { victim } );
            }
            engine->SetEngineProperty( asEP_AUTO_GARBAGE_COLLECT, auto_gc );
        }
    } cleanup{ engine, mgr, engine->GetEngineProperty( asEP_AUTO_GARBAGE_COLLECT ), "", "" };

    if ( engine->SetEngineProperty( asEP_AUTO_GARBAGE_COLLECT, 0 ) < 0 ||
         engine->GetEngineProperty( asEP_AUTO_GARBAGE_COLLECT ) != 0 )
        return Result( id, "Could not disable automatic GC", "" );
    cleanup.victim = vsp::AddGeom( "BLANK" );
    if ( cleanup.victim.empty() || !veh->FindGeom( cleanup.victim ) )
        return Result( id, "Could not create victim", "" );
    const string script = "int destroyed = 0; class Probe { ~Probe() { destroyed++; DeleteGeom(\"" +
        cleanup.victim + "\"); } }";
    cleanup.module = mgr.ReadScriptFromMemory( "WebVSP_ReleaseGuardProbe", script );
    if ( cleanup.module.empty() ) return Result( id, "Could not build release fixture", "" );
    asIScriptModule *module = engine->GetModule( cleanup.module.c_str() );
    cleanup.type = module ? module->GetTypeInfoByDecl( "Probe" ) : nullptr;
    int index = module ? module->GetGlobalVarIndexByName( "destroyed" ) : -1;
    int *destroyed = index >= 0 ? static_cast< int * >( module->GetAddressOfGlobalVar( index ) ) : nullptr;
    if ( !cleanup.type || !destroyed ) return Result( id, "Could not inspect release fixture", "" );
    cleanup.object = engine->CreateScriptObject( cleanup.type );
    if ( !cleanup.object ) return Result( id, "Could not create release fixture object", "" );
    bool alive_before = veh->FindGeom( cleanup.victim ) != nullptr;
    int before = *destroyed;
    bool initial, attempted;
    {
        ScriptMgrSingleton::ExecuteScriptGuard guard( mgr );
        initial = guard.Attempted();
        void *object = cleanup.object;
        cleanup.object = nullptr; // Ownership transfers to ReleaseScriptObject exactly once.
        engine->ReleaseScriptObject( object, cleanup.type );
        attempted = guard.Attempted();
    }
    int after = *destroyed;
    bool alive_after = veh->FindGeom( cleanup.victim ) != nullptr;
    auto boolean = []( bool value ) { return value ? "true" : "false"; };
    string json = string( "{\"aliveBefore\":" ) + boolean( alive_before ) + ",\"aliveAfter\":" + boolean( alive_after ) +
        ",\"destroyedBefore\":" + std::to_string( before ) + ",\"destroyedAfter\":" + std::to_string( after ) +
        ",\"initial\":" + boolean( initial ) + ",\"attempted\":" + boolean( attempted ) + "}";
    return Result( id, TakeErrors(), json );
}

// Test-only, fixed fixtures survive across jobs; never accepts user-supplied script.
// Use only a disposable model and do not mutate fixtures between setup and cleanup.
// Epoch, pointer/name and geom ID checks do not prevent ABA or ID reuse: cleanup
// could delete another object after intervening mutations, even in the same epoch.
string g_PreflightFixtureKind, g_PreflightFixtureGeom, g_PreflightFixtureLinkName;
AdvLink *g_PreflightFixtureLink = nullptr;
uint64_t g_PreflightFixtureEpoch = 0;

void ScriptPreflightFixture( const Job &j )
{
    Vehicle *veh = VehicleMgr.GetVehicle();
    if ( j.a != "advlink" && j.a != "custom-detached" && j.a != "cleanup" )
        return Result( j.id, "Unknown preflight fixture", "" );
    if ( j.a == "cleanup" )
    {
        if ( veh && veh->IsModelEpochValid() && veh->GetModelEpoch() == g_PreflightFixtureEpoch )
        {
            if ( !g_PreflightFixtureGeom.empty() && veh->FindGeom( g_PreflightFixtureGeom ) )
                veh->DeleteGeomVec( { g_PreflightFixtureGeom } );
            if ( g_PreflightFixtureLink )
            {
                for ( AdvLink *link : AdvLinkMgr.GetLinks() )
                    if ( link == g_PreflightFixtureLink && link->GetName() == g_PreflightFixtureLinkName )
                    {
                        AdvLinkMgr.DelLink( link );
                        break;
                    }
            }
        }
        g_PreflightFixtureKind.clear();
        g_PreflightFixtureGeom.clear();
        g_PreflightFixtureLinkName.clear();
        g_PreflightFixtureLink = nullptr;
        g_PreflightFixtureEpoch = 0;
        return Result( j.id, TakeErrors(), "{\"kind\":\"cleanup\",\"id\":\"\",\"detached\":false}" );
    }
    if ( !veh || !veh->IsModelEpochValid() ) return Result( j.id, "No valid fixture vehicle", "" );
    if ( !g_PreflightFixtureKind.empty() ) return Result( j.id, "Clean up the existing fixture first", "" );
    g_PreflightFixtureEpoch = veh->GetModelEpoch();
    if ( j.a == "advlink" )
    {
        // An unbuilt link is enough: preflight must reject any link, not just valid ones.
        g_PreflightFixtureLink = AdvLinkMgr.AddLink( "WebVSP_Preflight_Fixture" );
        if ( !g_PreflightFixtureLink ) return Result( j.id, "Could not create fixture link", "" );
        g_PreflightFixtureLinkName = g_PreflightFixtureLink->GetName();
    }
    else
    {
        // CreateGeom inserts directly into the store without attaching to the tree and
        // does not initialize or execute a custom script.
        g_PreflightFixtureGeom = veh->CreateGeom( GeomType( CUSTOM_GEOM_TYPE, "WebVSP_Preflight_Fixture" ) );
        Geom *geom = veh->FindGeom( g_PreflightFixtureGeom );
        vector< string > tree = vsp::FindGeoms();
        if ( !geom || geom->GetType().m_Type != CUSTOM_GEOM_TYPE ||
             std::find( tree.begin(), tree.end(), g_PreflightFixtureGeom ) != tree.end() )
        {
            if ( geom ) veh->DeleteGeomVec( { g_PreflightFixtureGeom } );
            g_PreflightFixtureGeom.clear();
            return Result( j.id, "Could not create detached custom fixture", "" );
        }
    }
    g_PreflightFixtureKind = j.a;
    return Result( j.id, TakeErrors(), "{\"kind\":" + Quote( j.a ) + ",\"id\":" + Quote( g_PreflightFixtureGeom ) +
                   ",\"detached\":" + ( j.a == "custom-detached" ? "true" : "false" ) + "}" );
}

// Disposable-model integration check: the script may only delete the separately
// created victim, never the geom/parm whose setter remains on the C++ stack.
// Both the script and its target are generated here, not supplied by the caller.
void AdvLinkGuardCheck( int id )
{
    const size_t before = vsp::FindGeoms().size();
    const string driver = vsp::AddGeom( "BLANK" );
    const string victim = vsp::AddGeom( "BLANK" );
    const string input = vsp::FindParm( driver, "X_Rel_Location", "XForm" );
    AdvLink *link = nullptr;
    bool built = false, initial = false, attempted = false;
    bool below_alive = false, guarded_alive = false, unguarded_alive = true;
    if ( !driver.empty() && !victim.empty() && !input.empty() )
    {
        link = AdvLinkMgr.AddLink( "WebVSP_Guard_AdvLink_Check" );
        AdvLinkMgr.AddInput( input, "input_value" );
        link->SetScriptCode( "if (input_value > 0.75) { DeleteGeom(\"" + victim + "\"); }" );
        built = link->BuildScript();
        if ( built )
        {
            auto alive = [&]() {
                vector< string > geoms = vsp::FindGeoms();
                return std::find( geoms.begin(), geoms.end(), victim ) != geoms.end();
            };
            vsp::SetParmVal( input, 0.5 );
            below_alive = alive();
            {
                ScriptMgrSingleton::ExecuteScriptGuard guard( ScriptMgrSingleton::getInstance() );
                initial = guard.Attempted();
                vsp::SetParmVal( input, 1.0 );
                attempted = guard.Attempted();
                guarded_alive = alive();
            }
            // Change the input again, rather than calling ExecuteScript directly.
            vsp::SetParmVal( input, 2.0 );
            unguarded_alive = alive();
        }
    }
    if ( link ) AdvLinkMgr.DelLink( link );
    vector< string > remaining = vsp::FindGeoms();
    vector< string > cleanup;
    for ( const string &geom : remaining )
        if ( geom == driver || geom == victim ) cleanup.push_back( geom );
    vsp::DeleteGeomVec( cleanup );
    vsp::Update();
    string err = TakeErrors();
    Watch( "Advanced link guard check", true );
    auto boolean = []( bool value ) { return value ? "true" : "false"; };
    string json = "{\"built\":" + string( boolean( built ) ) +
        ",\"belowAlive\":" + boolean( below_alive ) + ",\"initial\":" + boolean( initial ) +
        ",\"attempted\":" + boolean( attempted ) + ",\"guardedAlive\":" + boolean( guarded_alive ) +
        ",\"unguardedAlive\":" + boolean( unguarded_alive ) +
        ",\"before\":" + std::to_string( before ) + ",\"afterCleanup\":" + std::to_string( vsp::FindGeoms().size() ) + "}";
    Result( id, err, json );
}

void ScriptGuardCheck( int id )
{
    ScriptMgrSingleton &mgr = ScriptMgrSingleton::getInstance();
    // A unique fixed module; retain it for repeated checks. Never execute user input.
    const string module = mgr.ReadScriptFromMemory( "WebVSP_ExecuteScriptGuard_Check",
        "int main() { AddGeom(\"BLANK\"); return 0; } // WebVSP guard check" );
    if ( module.empty() ) return Result( id, "Could not compile fixed guard-check script", "" );
    const vector< string > before = vsp::FindGeoms();
    auto count = []() { return vsp::FindGeoms().size(); };
    auto execute = [&]() { return mgr.ExecuteScript( module.c_str(), "int main()" ); };
    int unguarded = execute();
    size_t after_unguarded = count(), after_nested, after_inner;
    int nested_rc, inner_destroyed_rc;
    bool initial, outer_attempted, inner_initial, inner_attempted, outer_nested;
    {
        ScriptMgrSingleton::ExecuteScriptGuard outer( mgr );
        initial = outer.Attempted();
        {
            ScriptMgrSingleton::ExecuteScriptGuard inner( mgr );
            inner_initial = inner.Attempted();
            nested_rc = execute();
            after_nested = count();
            inner_attempted = inner.Attempted();
            outer_nested = outer.Attempted();
        }
        outer_attempted = outer.Attempted();
        inner_destroyed_rc = execute();
        after_inner = count();
    }
    // Also unlink a non-head guard, then verify exception unwinding releases a guard.
    bool non_lifo_attempted, unwind_attempted = false;
    int non_lifo_rc, unwind_rc;
    auto *older = new ScriptMgrSingleton::ExecuteScriptGuard( mgr );
    {
        ScriptMgrSingleton::ExecuteScriptGuard newer( mgr );
        delete older;
        non_lifo_rc = execute();
        non_lifo_attempted = newer.Attempted();
    }
    try
    {
        ScriptMgrSingleton::ExecuteScriptGuard guard( mgr );
        unwind_rc = execute();
        unwind_attempted = guard.Attempted();
        throw 42;
    }
    catch ( int ) {}
    size_t after_extra_guards = count();
    int restored = execute();
    size_t after_restored = count();

    // This fixed, diagnostic-only module is removed at the end of each check, so the
    // guarded read is genuinely a new build even when the diagnostic is run again.
    const string init_name = "WebVSP_Guard_GlobalInitializer_Check";
    const string init_source =
        "string webvsp_guard_geom = AddGeom(\"BLANK\"); int main() { return 0; } // WebVSP guard initializer check";
    string blocked_module;
    bool build_initial, build_attempted;
    {
        ScriptMgrSingleton::ExecuteScriptGuard guard( mgr );
        build_initial = guard.Attempted();
        blocked_module = mgr.ReadScriptFromMemory( init_name, init_source );
        build_attempted = guard.Attempted();
    }
    size_t after_blocked_build = count();
    string init_module = mgr.ReadScriptFromMemory( init_name, init_source );
    size_t after_build = count();
    bool remove_initial, remove_attempted, blocked_remove;
    {
        ScriptMgrSingleton::ExecuteScriptGuard guard( mgr );
        remove_initial = guard.Attempted();
        blocked_remove = mgr.RemoveScript( init_module );
        remove_attempted = guard.Attempted();
    }
    // A successful call demonstrates that the rejected removal left the module intact.
    int retained_rc = init_module.empty() ? 1 : mgr.ExecuteScript( init_module.c_str(), "int main()" );
    bool removed = !init_module.empty() && mgr.RemoveScript( init_module );
    string rebuilt_module = mgr.ReadScriptFromMemory( init_name, init_source );
    size_t after_rebuild = count();
    bool removed_rebuilt = !rebuilt_module.empty() && mgr.RemoveScript( rebuilt_module );
    vector< string > after = vsp::FindGeoms();
    vector< string > added;
    for ( const string &geom : after )
        if ( std::find( before.begin(), before.end(), geom ) == before.end() ) added.push_back( geom );
    vsp::DeleteGeomVec( added );
    vsp::Update();
    string err = TakeErrors();
    Watch( "Script guard check", true );
    auto boolean = []( bool value ) { return value ? "true" : "false"; };
    string json = "{\"before\":" + std::to_string( before.size() ) +
        ",\"unguardedRc\":" + std::to_string( unguarded ) + ",\"afterUnguarded\":" + std::to_string( after_unguarded ) +
        ",\"outerInitial\":" + boolean( initial ) +
        ",\"outerAttempted\":" + boolean( outer_attempted ) +
        ",\"innerInitial\":" + boolean( inner_initial ) + ",\"nestedRc\":" + std::to_string( nested_rc ) +
        ",\"innerAttempted\":" + boolean( inner_attempted ) + ",\"outerNested\":" + boolean( outer_nested ) +
        ",\"afterNested\":" + std::to_string( after_nested ) + ",\"innerDestroyedRc\":" + std::to_string( inner_destroyed_rc ) +
        ",\"afterInner\":" + std::to_string( after_inner ) +
        ",\"nonLifoRc\":" + std::to_string( non_lifo_rc ) + ",\"nonLifoAttempted\":" + boolean( non_lifo_attempted ) +
        ",\"unwindRc\":" + std::to_string( unwind_rc ) + ",\"unwindAttempted\":" + boolean( unwind_attempted ) +
        ",\"afterExtraGuards\":" + std::to_string( after_extra_guards ) + ",\"restoredRc\":" + std::to_string( restored ) +
        ",\"afterRestored\":" + std::to_string( after_restored ) +
        ",\"buildInitial\":" + boolean( build_initial ) + ",\"buildAttempted\":" + boolean( build_attempted ) +
        ",\"buildBlocked\":" + boolean( blocked_module.empty() ) + ",\"afterBlockedBuild\":" + std::to_string( after_blocked_build ) +
        ",\"buildSucceeded\":" + boolean( !init_module.empty() ) + ",\"afterBuild\":" + std::to_string( after_build ) +
        ",\"removeInitial\":" + boolean( remove_initial ) + ",\"removeAttempted\":" + boolean( remove_attempted ) +
        ",\"removeBlocked\":" + boolean( !blocked_remove ) + ",\"retainedRc\":" + std::to_string( retained_rc ) +
        ",\"removed\":" + boolean( removed ) + ",\"rebuildSucceeded\":" + boolean( !rebuilt_module.empty() ) +
        ",\"afterRebuild\":" + std::to_string( after_rebuild ) + ",\"removedRebuilt\":" + boolean( removed_rebuilt ) +
        ",\"afterCleanup\":" + std::to_string( count() ) + "}";
    Result( id, err, json );
}
#endif

// Keep this list identical to GUARDED_OPS in wasmEngine.ts. The exported entry point
// can be called directly, bypassing the TypeScript bridge.
bool GuardedOpAllowed( const string &op )
{
    return op == "model" || op == "geomTypes" || op == "bbox" || op == "origin" || op == "move" ||
           op == "addGeom" || op == "geomXSecs" || op == "fuselageXSecShapes" || op == "wingXSecShapes" || op == "geomParmIDs" ||
           op == "xsecParmIDs" || op == "geomParm" || op == "xsecParm" ||
           op == "parm_value_id" || op == "parm_int_value_id" || op == "parm_name_id" || op == "parm_type_id" ||
           op == "fuselageLength" || op == "geomSetParm" || op == "xsecSetParm" || op == "guardedUpdate" ||
           op == "guardedSetGeomName" || op == "guardedDeleteGeom";
}

bool GuardedWrite( const string &op )
{
    return op == "move" || op == "addGeom" || op == "geomSetParm" || op == "xsecSetParm" || op == "guardedUpdate" ||
           op == "guardedSetGeomName" || op == "guardedDeleteGeom";
}

// Fail closed for future or malformed type IDs rather than treating the enum range
// as proof that a newly introduced type is safe.
bool KnownNonCustomGeomType( int type )
{
    switch ( type )
    {
    case POD_GEOM_TYPE: case FUSELAGE_GEOM_TYPE: case MS_WING_GEOM_TYPE:
    case BLANK_GEOM_TYPE: case MESH_GEOM_TYPE: case STACK_GEOM_TYPE:
    case PT_CLOUD_GEOM_TYPE: case PROP_GEOM_TYPE: case HINGE_GEOM_TYPE:
    case CONFORMAL_GEOM_TYPE: case ELLIPSOID_GEOM_TYPE: case BOR_GEOM_TYPE:
    case WIRE_FRAME_GEOM_TYPE: case HUMAN_GEOM_TYPE: case ROUTING_GEOM_TYPE:
    case AUXILIARY_GEOM_TYPE: case GEAR_GEOM_TYPE: case NGON_GEOM_TYPE:
    case COBRA_GEOM_TYPE: case CLONE_GEOM_TYPE:
        return true;
    default:
        return false;
    }
}

// Keep classification independent of Geom construction, updates, and ownership.
bool SafeGeomTypeList( const vector< int > &types )
{
    for ( int type : types )
        if ( !KnownNonCustomGeomType( type ) ) return false;
    return true;
}

bool SafeStoredGeomTypes( const vector< Geom * > &geoms )
{
    vector< int > types;
    types.reserve( geoms.size() );
    for ( Geom *geom : geoms )
    {
        if ( !geom ) return false;
        types.push_back( geom->GetType().m_Type );
    }
    return SafeGeomTypeList( types );
}

#ifdef WEBVSP_SCRIPT_GUARD_TEST
// Fixed inputs only: no fake Geom pointers, type mutation, or model updates.
void StoredGeomTypesCheck( int id )
{
    const vector< int > known = { POD_GEOM_TYPE, FUSELAGE_GEOM_TYPE, MS_WING_GEOM_TYPE,
        BLANK_GEOM_TYPE, MESH_GEOM_TYPE, STACK_GEOM_TYPE, PT_CLOUD_GEOM_TYPE,
        PROP_GEOM_TYPE, HINGE_GEOM_TYPE, CONFORMAL_GEOM_TYPE, ELLIPSOID_GEOM_TYPE,
        BOR_GEOM_TYPE, WIRE_FRAME_GEOM_TYPE, HUMAN_GEOM_TYPE, ROUTING_GEOM_TYPE,
        AUXILIARY_GEOM_TYPE, GEAR_GEOM_TYPE, NGON_GEOM_TYPE, COBRA_GEOM_TYPE, CLONE_GEOM_TYPE };
    const vector< int > rejected = { CUSTOM_GEOM_TYPE, BASE_GEOM_TYPE, XFORM_GEOM_TYPE,
        GEOM_GEOM_TYPE, NUM_GEOM_TYPE, -1, std::numeric_limits< int >::max() };
    auto boolean = []( bool value ) { return value ? "true" : "false"; };
    string json = "{\"known\":[";
    for ( size_t i = 0; i < known.size(); ++i )
    {
        if ( i ) json += ",";
        json += boolean( SafeGeomTypeList( { known[i] } ) );
    }
    json += "],\"rejected\":[";
    for ( size_t i = 0; i < rejected.size(); ++i )
    {
        if ( i ) json += ",";
        json += boolean( SafeGeomTypeList( { rejected[i] } ) );
    }
    vector< int > mixed = known;
    mixed.push_back( std::numeric_limits< int >::max() );
    json += "],\"empty\":" + string( boolean( SafeGeomTypeList( {} ) ) ) +
        ",\"allKnown\":" + boolean( SafeGeomTypeList( known ) ) +
        ",\"mixed\":" + boolean( SafeGeomTypeList( mixed ) ) +
        ",\"emptyStore\":" + boolean( SafeStoredGeomTypes( {} ) ) +
        ",\"nullStore\":" + boolean( SafeStoredGeomTypes( { nullptr } ) ) + "}";
    Result( id, "", json );
}
#endif

// This is only an initial preflight, not a complete safety guarantee or a script
// execution barrier. Other reentrant paths and side effects still require review.
bool SafeWriteContext( Vehicle *veh, const Job &j )
{
    if ( asGetActiveContext() || !AdvLinkMgr.GetLinks().empty() ) return false;
    // The store includes detached/clipboard geoms, not just FindGeoms' model tree.
    if ( !SafeStoredGeomTypes( veh->GetGeomStoreVec() ) ) return false;

    if ( j.op == "addGeom" )
    {
        // Match AddGeom's first name match exactly, including duplicate names.
        for ( int i = 0; i < veh->GetNumGeomTypes(); ++i )
        {
            GeomType type = veh->GetGeomType( i );
            if ( type.m_Name == j.a )
                return type.m_FixedFlag && KnownNonCustomGeomType( type.m_Type );
        }
        return false;
    }
    return true;
}

#ifdef WEBVSP_SCRIPT_GUARD_TEST
void ScriptNormalGcProbe( const Job &j );
#ifdef WEBVSP_PARM_REENTRY_TEST
void ScriptSetterGcProbe( const Job &j );
#endif
#endif
void RunImpl( const Job &j )
{
    if ( j.guarded )
    {
        if ( !GuardedOpAllowed( j.op ) )
        {
            PublishResult( "{\"t\":\"result\",\"id\":" + std::to_string( j.id ) +
                  ",\"ok\":false,\"error\":\"Operation is not permitted by the guarded bridge\","
                  "\"outcome\":\"not_written\",\"actual\":null}" );
            return;
        }
        uint64_t expected;
        Vehicle *veh = VehicleMgr.GetVehicle();
        if ( !ParseModelEpoch( j.expected_epoch, expected ) || !veh ||
             !veh->IsModelEpochValid() || veh->GetModelEpoch() != expected )
        {
            PublishResult( "{\"t\":\"result\",\"id\":" + std::to_string( j.id ) +
                  ",\"ok\":false,\"error\":\"STALE_MODEL\",\"code\":\"STALE_MODEL\","
                  "\"outcome\":\"not_written\",\"actual\":null}" );
            return;
        }
        if ( GuardedWrite( j.op ) && !SafeWriteContext( veh, j ) )
        {
            PublishResult( "{\"t\":\"result\",\"id\":" + std::to_string( j.id ) +
                  ",\"ok\":false,\"error\":\"UNSAFE_SCRIPT_CONTEXT\",\"code\":\"UNSAFE_SCRIPT_CONTEXT\","
                  "\"outcome\":\"not_written\",\"actual\":null}" );
            return;
        }
    }
    // Static declaration, not a model health or write-safety check. It calls no
    // model API, so leave the pre-existing global error stack untouched.
    if ( j.op == "modelingProtocol" )
        return Result( j.id, "", "{\"protocol\":\"webvsp-modeling\",\"version\":1,\"operations\":["
            "\"modelDiscovery\",\"model\",\"geomTypes\",\"bbox\",\"origin\",\"geomXSecs\","
            "\"fuselageXSecShapes\",\"wingXSecShapes\",\"geomParmIDs\",\"xsecParmIDs\","
            "\"geomParm\",\"xsecParm\",\"parm_value_id\",\"parm_int_value_id\",\"parm_name_id\",\"parm_type_id\","
            "\"fuselageLength\",\"guardedEpochV1\"]}" );
    TakeErrors();
#ifdef WEBVSP_SCRIPT_GUARD_TEST
    if ( j.op == "protocolErrorStackProbe" )
    {
        // Run both probes synchronously on the engine thread: the GUI pump and
        // watcher must not consume or add errors between injection and inspection.
        auto &mgr = vsp::ErrorMgrSingleton::getInstance();
        auto probe = [&]( const string &op )
        {
            mgr.AddError( vsp::VSP_INVALID_ID, "protocol sentinel first" );
            mgr.AddError( vsp::VSP_INVALID_PTR, "protocol sentinel second" );
            int before = mgr.GetNumTotalErrors();
            string nested;
            string *previous = g_GcProbeCapture;
            struct RestoreCapture
            {
                string *previous;
                explicit RestoreCapture( string *p ) : previous( p ) {}
                ~RestoreCapture() { g_GcProbeCapture = previous; }
            } restore( previous );
            g_GcProbeCapture = &nested;
            RunImpl( { -2147483000, op, "", "", 0, false, "" } );
            int after = mgr.GetNumTotalErrors();
            string errors = "[";
            bool first = true;
            while ( mgr.GetNumTotalErrors() )
            {
                vsp::ErrorObj error = mgr.PopLastError();
                if ( !first ) errors += ",";
                first = false;
                errors += "{\"code\":" + std::to_string( static_cast< int >( error.GetErrorCode() ) ) +
                    ",\"message\":" + Quote( error.GetErrorString() ) + "}";
            }
            errors += "]";
            return "{\"before\":" + std::to_string( before ) + ",\"after\":" + std::to_string( after ) +
                ",\"errors\":" + errors + ",\"reply\":" + ( nested.empty() ? "null" : nested ) + "}";
        };
        string protocol = probe( "modelingProtocol" );
        string control = probe( "webvspDefinitelyUnknownOperation" );
        return Result( j.id, "", "{\"protocol\":" + protocol + ",\"control\":" + control +
            ",\"firstCode\":" + std::to_string( static_cast< int >( vsp::VSP_INVALID_ID ) ) +
            ",\"secondCode\":" + std::to_string( static_cast< int >( vsp::VSP_INVALID_PTR ) ) + "}" );
    }
    if ( j.op == "guardedWriteErrorInjection" )
    {
        if ( j.a != "clear" && j.a != "FindGeoms" && j.a != "GetXSecSurfIDVec" &&
             j.a != "GetNumXSec" && j.a != "GetXSec" && j.a != "GetXSecParmIDs" && j.a != "GetGeomParmIDs" &&
             j.a != "metadata" && j.a != "setter" && j.a != "readback" &&
             j.a != "addUpdate" && j.a != "move" )
            return Result( j.id, "Invalid guarded write error point", "" );
        if ( j.a != "clear" && j.b != "empty" && j.b != "mixed" )
            return Result( j.id, "Invalid guarded write error mode", "" );
        g_WriteErrorArmed = j.a == "clear" ? "" : j.a;
        g_WriteErrorMode = j.b;
        return Result( j.id, "", "null" );
    }
    if ( j.op == "parmReadInjection" )
    {
        if ( j.a != "clear" && j.a != "FindGeoms" && j.a != "GetXSecSurfIDVec" &&
             j.a != "GetNumXSec" && j.a != "GetXSec" && j.a != "GetXSecShape" )
            return Result( j.id, "Invalid parameter read injection", "" );
        if ( j.b != "empty" && j.b != "message" && j.a != "clear" )
            return Result( j.id, "Invalid parameter read injection message", "" );
        g_ParmReadFault = j.a == "clear" ? "" : j.a;
        g_ParmReadFaultMessage = j.b == "empty" ? "" : "Injected parameter enumeration error";
        return Result( j.id, "", "null" );
    }
    if ( j.op == "serializerInjection" )
    {
        if ( j.a != "clear" && j.a != "model:early" && j.a != "model:middle" && j.a != "model:late" &&
             j.a != "bbox:early" && j.a != "bbox:middle" && j.a != "bbox:late" )
            return Result( j.id, "Invalid serializer injection", "" );
        g_SerializerFault = j.a == "clear" ? "" : j.a;
        return Result( j.id, "", "null" );
    }
    if ( j.op == "guardedWriteInjection" )
    {
        if ( j.a == "clear" )
        {
            g_InjectionArmed.clear();
            return Result( j.id, "", "{\"ok\":true}" );
        }
        if ( j.a != "pre" && j.a != "post" && j.a != "watch" && j.a != "control" )
            return Result( j.id, "Invalid injection phase", "" );
        if ( g_InjectionModule.empty() )
            g_InjectionModule = ScriptMgrSingleton::getInstance().ReadScriptFromMemory(
                "WebVSP_GuardedWriteInjection", "int main() { AddGeom(\"BLANK\"); return 0; }" );
        if ( g_InjectionModule.empty() ) return Result( j.id, "Could not compile injection script", "" );
        if ( j.a == "control" )
        {
            // Never leave a pending arm behind; execute the exact injection entry unguarded.
            g_InjectionArmed.clear();
            if ( g_GuardedWrite ) return Result( j.id, "Control requires an unguarded call", "" );
            int rc = ExecuteGuardedWriteInjection();
            string err = TakeErrors();
            if ( !err.empty() ) return Result( j.id, err, "" );
            return Result( j.id, "", "{\"rc\":" + std::to_string( rc ) + "}" );
        }
        g_InjectionArmed = j.a;
        return Result( j.id, "", "{\"ok\":true}" );
    }
    // Read-only observation; the fixture uses fixed sources and is test-build only.
    if ( j.op == "scriptSourceBuildState" )
        return Result( j.id, "", ScriptMgrSingleton::getInstance().TestSourceBuildAttempted() ? "true" : "false" );
    if ( j.op == "scriptSourceBuildFixture" )
    {
        ScriptMgrSingleton &mgr = ScriptMgrSingleton::getInstance();
        const string name = "WebVSP_SourceBuildDiagnostic";
        if ( j.a == "blocked" )
        {
            ScriptMgrSingleton::ExecuteScriptGuard guard( mgr );
            const string module = mgr.ReadScriptFromMemory( name, "int main() { return 0; } // blocked source probe" );
            return Result( j.id, "", string( "{\"blocked\":" ) + ( module.empty() ? "true" : "false" ) +
                ",\"attempted\":" + ( guard.Attempted() ? "true" : "false" ) + "}" );
        }
        if ( j.a == "failed" )
        {
            const string module = mgr.ReadScriptFromMemory( name, "int main( { invalid source probe" );
            return Result( j.id, "", string( "{\"failed\":" ) + ( module.empty() ? "true" : "false" ) + "}" );
        }
        if ( j.a == "success" )
        {
            const string module = mgr.ReadScriptFromMemory( name, "int main() { return 0; } // successful source probe" );
            const bool removed = !module.empty() && mgr.RemoveScript( module );
            return Result( j.id, "", string( "{\"success\":" ) + ( !module.empty() ? "true" : "false" ) +
                ",\"removed\":" + ( removed ? "true" : "false" ) + "}" );
        }
        return Result( j.id, "Invalid source build fixture", "" );
    }
    if ( j.op == "scriptPreflightFixture" ) return ScriptPreflightFixture( j );
    if ( j.op == "scriptModuleCacheGuardCheck" ) return ScriptModuleCacheGuardCheck( j.id, 0 );
    if ( j.op == "scriptModuleCacheGuardCreateFailure" ) return ScriptModuleCacheGuardCheck( j.id, 1 );
    if ( j.op == "scriptModuleCacheGuardRemoveFailure" ) return ScriptModuleCacheGuardCheck( j.id, 2 );
    if ( j.op == "scriptGuardCheck" ) return ScriptGuardCheck( j.id );
    if ( j.op == "scriptGcGuardCheck" ) return ScriptGcGuardCheck( j.id );
    if ( j.op == "scriptNormalGcAutoOff" || j.op == "scriptNormalGcAutoOn" || j.op == "scriptNormalGcPositive" ||
         j.op == "scriptParmGcAutoOff" || j.op == "scriptParmGcAutoOn" || j.op == "scriptParmGcPositive" ) return ScriptNormalGcProbe( j );
#ifdef WEBVSP_PARM_REENTRY_TEST
    if ( j.op == "scriptSetterGcProbe" ) return ScriptSetterGcProbe( j );
#endif
    if ( j.op == "scriptReleaseGuardCheck" ) return ScriptReleaseGuardCheck( j.id );
    if ( j.op == "advLinkGuardCheck" ) return AdvLinkGuardCheck( j.id );
    if ( j.op == "storedGeomTypesCheck" ) return StoredGeomTypesCheck( j.id );
#endif
    if ( j.op == "model" || j.op == "modelDiscovery" )
    {
        string err;
        string m = ModelJson( j.guarded || j.op == "modelDiscovery" ? &err : nullptr );
        if ( !err.empty() ) return Result( j.id, err, "" );
        // Add the engine's own bookkeeping, as session.tree() does.
        m.pop_back();
        Vehicle *veh = VehicleMgr.GetVehicle();
        m += ",\"rev\":" + std::to_string( g_Rev ) + ",\"dirty\":" + ( g_Dirty ? "true" : "false" ) +
             ",\"undo\":" + NO_UNDO +
             ",\"modelEpoch\":" + Quote( veh ? std::to_string( veh->GetModelEpoch() ) : "" ) +
             ",\"modelEpochValid\":" + ( veh && veh->IsModelEpochValid() ? "true" : "false" ) + "}";
        return Result( j.id, "", m );
    }
    if ( j.op == "fuselageLength" )
    {
        string json, err;
        MissingParmOwner missing = MissingParmOwner::None;
        if ( !FuselageLength( j.a, json, err, j.guarded ? &missing : nullptr ) ) return ParmReadFailure( j, err, missing );
        return Result( j.id, "", json );
    }
#ifdef WEBVSP_SCRIPT_GUARD_TEST
    // Test-only detached copy with known IDs; never part of the public bridge. Use only
    // in a disposable model, with no intervening geom deletion/replacement: epoch and
    // pointer checks do not exclude an ABA reuse of both an ID and an address.
    static std::map< string, std::pair< uint64_t, Geom* > > parameter_test_copies;
    if ( j.op == "parameterDetachedFixture" )
    {
        Vehicle *veh = VehicleMgr.GetVehicle();
        string err;
        if ( !CurrentModelGeom( j.a, err ) ) return Result( j.id, err, "" );
        vector< string > copies = veh->CopyGeomVec( vector< string >( 1, j.a ) );
        if ( copies.size() != 1 ) return Result( j.id, "Could not create detached geom", "" );
        vector< string > ids = vsp::GetGeomParmIDs( copies[0] );
        err = TakeErrors();
        string sections;
        bool found = false;
        if ( err.empty() ) GeomXSecs( copies[0], sections, found, "", err );
        if ( !err.empty() )
        {
            veh->DeleteGeomVec( copies );
            return Result( j.id, err, "" );
        }
        parameter_test_copies[copies[0]] = { veh->GetModelEpoch(), veh->FindGeom( copies[0] ) };
        return Result( j.id, "", "{\"id\":" + Quote( copies[0] ) + ",\"parms\":" + StrArray( ids ) + ",\"surfaces\":" + sections + "}" );
    }
    if ( j.op == "parameterDetachedCleanup" )
    {
        Vehicle *veh = VehicleMgr.GetVehicle();
        auto it = parameter_test_copies.find( j.a );
        if ( it == parameter_test_copies.end() ) return Result( j.id, "Unknown test fixture", "" );
        uint64_t epoch = it->second.first;
        Geom *original = it->second.second;
        parameter_test_copies.erase( it );
        if ( !veh || !veh->IsModelEpochValid() || veh->GetModelEpoch() != epoch ||
             veh->FindGeom( j.a ) != original )
            return Result( j.id, "Test fixture model was replaced", "" );
        string err;
        if ( CurrentModelGeom( j.a, err ) ) return Result( j.id, "Refusing to delete current model geom", "" );
        if ( err != "Geom not found in the current model: " + j.a ) return Result( j.id, err, "" );
        veh->DeleteGeomVec( vector< string >( 1, j.a ) );
        return Result( j.id, "", "null" );
    }
#endif
    if ( j.op == "fuselageXSecShapes" || j.op == "wingXSecShapes" )
    {
        string err;
        MissingParmOwner missing = MissingParmOwner::None;
        if ( !CurrentModelGeom( j.a, err, j.guarded ? &missing : nullptr ) ) return ParmReadFailure( j, err, missing );
        Vehicle *veh = VehicleMgr.GetVehicle();
        Geom *geom = veh ? veh->FindGeom( j.a ) : nullptr;
        bool wing = j.op == "wingXSecShapes";
        if ( !geom || geom->GetType().m_Type != ( wing ? MS_WING_GEOM_TYPE : FUSELAGE_GEOM_TYPE ) )
            return Result( j.id, wing ? "Geom is not a wing" : "Geom is not a fuselage", "" );
        vector< string > surfaces = vsp::GetXSecSurfIDVec( j.a );
#ifdef WEBVSP_SCRIPT_GUARD_TEST
        InjectParmReadFault( "GetXSecSurfIDVec", j.guarded );
#endif
        if ( !( err = TakeParmErrors( j.guarded ) ).empty() ) return Result( j.id, err, "" );
        std::set< string > surface_ids, xsec_ids;
        string json = "[";
        for ( size_t s = 0; s < surfaces.size(); ++s )
        {
            const string &surface = surfaces[s];
            if ( surface.empty() || !surface_ids.insert( surface ).second ) return Result( j.id, "Invalid or duplicate XSec surface", "" );
            int count = vsp::GetNumXSec( surface );
#ifdef WEBVSP_SCRIPT_GUARD_TEST
            InjectParmReadFault( "GetNumXSec", j.guarded );
#endif
            if ( !( err = TakeParmErrors( j.guarded ) ).empty() ) return Result( j.id, err, "" );
            if ( count < 0 ) return Result( j.id, "Invalid XSec count", "" );
            json += ( s ? "," : "" ) + string( "{\"id\":" ) + Quote( surface ) + ",\"xsecs\":[";
            for ( int i = 0; i < count; ++i )
            {
                string xsec = vsp::GetXSec( surface, i );
#ifdef WEBVSP_SCRIPT_GUARD_TEST
                InjectParmReadFault( "GetXSec", j.guarded );
#endif
                if ( !( err = TakeParmErrors( j.guarded ) ).empty() ) return Result( j.id, err, "" );
                if ( xsec.empty() || !xsec_ids.insert( xsec ).second ) return Result( j.id, "Invalid or duplicate XSec", "" );
                int shape = vsp::GetXSecShape( xsec );
#ifdef WEBVSP_SCRIPT_GUARD_TEST
                InjectParmReadFault( "GetXSecShape", j.guarded );
#endif
                if ( !( err = TakeParmErrors( j.guarded ) ).empty() ) return Result( j.id, err, "" );
                if ( shape == vsp::XS_UNDEFINED ) return Result( j.id, "Undefined XSec shape", "" );
                json += ( i ? "," : "" ) + string( "{\"id\":" ) + Quote( xsec ) + ",\"shape\":" + std::to_string( shape ) + "}";
            }
            json += "]}";
        }
        return Result( j.id, "", json + "]" );
    }
    if ( j.op == "geomXSecs" )
    {
        string json, err;
        MissingParmOwner missing = MissingParmOwner::None;
        if ( !CurrentModelGeom( j.a, err, j.guarded ? &missing : nullptr ) ) return ParmReadFailure( j, err, missing );
        bool found = false;
        GeomXSecs( j.a, json, found, "", err, j.guarded );
        return Result( j.id, err, json );
    }
    if ( j.op == "geomParmIDs" || j.op == "xsecParmIDs" ||
         j.op == "geomParm" || j.op == "xsecParm" )
    {
        bool xsec = j.op == "xsecParmIDs" || j.op == "xsecParm";
        bool list = j.op == "geomParmIDs" || j.op == "xsecParmIDs";
        vector< string > ids;
        string err, json;
        MissingParmOwner missing = MissingParmOwner::None;
        if ( !ParmIDs( xsec, j.a, ids, err, j.guarded ? &missing : nullptr ) ) return ParmReadFailure( j, err, missing );
        if ( list ) return Result( j.id, "", StrArray( ids ) );
        if ( std::find( ids.begin(), ids.end(), j.b ) == ids.end() )
            return Result( j.id, "Parm is not linkable for the requested owner: " + j.b, "" );
        if ( !ParmMetadata( j.b, json, err, j.guarded ) ) return Result( j.id, err, "" );
        return Result( j.id, "", json );
    }
    if ( j.op == "parm_value_id" || j.op == "parm_int_value_id" || j.op == "parm_name_id" || j.op == "parm_type_id" )
    {
        vector< string > geoms = vsp::FindGeoms();
        string err;
        if ( !TakeParmErrors( true ).empty() ) return Result( j.id, "Could not enumerate current model geometries", "" );
        bool owner_found = false;
        for ( const string &geom : geoms )
        {
            vector< string > ids;
            if ( !ParmIDs( false, geom, ids, err, nullptr ) ) return Result( j.id, err, "" );
            if ( std::find( ids.begin(), ids.end(), j.a ) != ids.end() ) { owner_found = true; break; }
        }
        if ( !owner_found )
        {
            vector< string > xsecs;
            for ( const string &geom : geoms )
            {
                string xsec_json;
                bool found = false;
                if ( !GeomXSecs( geom, xsec_json, found, "", err, true ) ) return Result( j.id, err, "" );
                vector< string > surfaces = vsp::GetXSecSurfIDVec( geom );
                if ( !TakeParmErrors( true ).empty() ) return Result( j.id, "Could not enumerate XSec surfaces", "" );
                for ( const string &surface : surfaces )
                {
                    int count = vsp::GetNumXSec( surface );
                    if ( !TakeParmErrors( true ).empty() ) return Result( j.id, "Could not enumerate XSecs", "" );
                    for ( int i = 0; i < count; ++i ) xsecs.push_back( vsp::GetXSec( surface, i ) );
                }
            }
            for ( const string &xsec : xsecs )
            {
                vector< string > ids;
                if ( !ParmIDs( true, xsec, ids, err, nullptr ) ) return Result( j.id, err, "" );
                if ( std::find( ids.begin(), ids.end(), j.a ) != ids.end() ) { owner_found = true; break; }
            }
        }
        if ( !owner_found ) return Result( j.id, "Parameter is not owned by the current model", "" );
        if ( j.op == "parm_value_id" )
        {
            double value = vsp::GetParmVal( j.a );
            if ( !( err = TakeParmErrors( true ) ).empty() ) return Result( j.id, err, "" );
            return Result( j.id, "", Num( value ) );
        }
        if ( j.op == "parm_int_value_id" )
        {
            int value = vsp::GetIntParmVal( j.a );
            if ( !( err = TakeParmErrors( true ) ).empty() ) return Result( j.id, err, "" );
            return Result( j.id, "", std::to_string( value ) );
        }
        if ( j.op == "parm_name_id" )
        {
            string value = vsp::GetParmName( j.a );
            if ( !( err = TakeParmErrors( true ) ).empty() ) return Result( j.id, err, "" );
            return Result( j.id, "", Quote( value ) );
        }
        int value = vsp::GetParmType( j.a );
        if ( !( err = TakeParmErrors( true ) ).empty() ) return Result( j.id, err, "" );
        return Result( j.id, "", std::to_string( value ) );
    }
    if ( j.op == "results_fixture_open" )
    {
        ExpireSyncResultsFixture();
        if ( !g_SyncResultsFixture.token.empty() ) return Result( j.id, "A results fixture is already active", "" );
        ResultsMgrSingleton &mgr = ResultsMgrSingleton::getInstance();
        Results *results = mgr.CreateResults( "WebVSP_ResultsFixture", "Fixed diagnostic ResultsMgr fixture" );
        if ( !results ) return Result( j.id, "Could not create results fixture", "" );
        const string result_id = results->GetID();
        results->Add( new NameValData( "Int_Value", vector< int >( 1, 42 ), "fixture integer" ) );
        results->Add( new NameValData( "String_Value", vector< string >( 1, "fixture" ), "fixture string" ) );
        results->Add( new NameValData( "Double_Value", vector< double >( 1, 3.25 ), "fixture double" ) );
        results->Add( new NameValData( "Double_Matrix", vector< vector< double > >{ { 1.0, 2.0, 3.0 }, { 4.0, 5.0, 6.0 } }, "fixture matrix" ) );
        results->Add( new NameValData( "Vec3d_Value", vector< vec3d >( 1, vec3d( 1.0, 2.0, 3.0 ) ), "fixture vector" ) );
        ++g_SyncResultsFixture.serial;
        g_SyncResultsFixture.token = "fixture-" + std::to_string( g_SyncResultsFixture.serial );
        g_SyncResultsFixture.result_id = result_id;
        g_SyncResultsFixture.expires = std::chrono::steady_clock::now() + std::chrono::seconds( 30 );
        return Result( j.id, "", Quote( g_SyncResultsFixture.token ) );
    }
    if ( j.op == "results_fixture_close" )
    {
        string result_id, err;
        if ( !SyncFixtureData( j.a, result_id, err ) ) return Result( j.id, err, "" );
        ClearSyncResultsFixture();
        return Result( j.id, "", "null" );
    }
    if ( j.op == "results_fixture_data_names" || j.op == "results_fixture_name" || j.op == "results_fixture_type" ||
         j.op == "results_fixture_int" || j.op == "results_fixture_double" || j.op == "results_fixture_string" ||
         j.op == "results_fixture_matrix" || j.op == "results_fixture_vec3d" )
    {
        string result_id, err;
        if ( !SyncFixtureData( j.a, result_id, err ) ) return Result( j.id, err, "" );
        ResultsMgrSingleton &mgr = ResultsMgrSingleton::getInstance();
        if ( j.op == "results_fixture_name" ) return Result( j.id, "", Quote( vsp::GetResultsName( result_id ) ) );
        if ( j.op == "results_fixture_data_names" ) return Result( j.id, "", SyncFixtureStringArray( vsp::GetAllDataNames( result_id ) ) );
        if ( j.b.empty() || !SyncFixtureFieldName( j.b ) ) return Result( j.id, "Unknown results fixture field", "" );
        if ( j.op == "results_fixture_type" )
        {
            int type = vsp::GetResultsType( result_id, j.b );
            if ( !TakeParmErrors( true ).empty() ) return Result( j.id, "Unknown results fixture field", "" );
            return Result( j.id, "", std::to_string( type ) );
        }
        int index = static_cast< int >( j.value );
        if ( index < 0 || index > 3 ) return Result( j.id, "Results fixture index out of range", "" );
        if ( j.op == "results_fixture_int" )
        {
            vector< int > values = vsp::GetIntResults( result_id, j.b, index );
            if ( !TakeParmErrors( true ).empty() ) return Result( j.id, "Invalid integer result field or index", "" );
            return Result( j.id, "", IntArrayJson( values ) );
        }
        if ( j.op == "results_fixture_double" )
        {
            vector< double > values = vsp::GetDoubleResults( result_id, j.b, index );
            if ( !TakeParmErrors( true ).empty() ) return Result( j.id, "Invalid double result field or index", "" );
            return Result( j.id, "", DoubleArrayJson( values ) );
        }
        if ( j.op == "results_fixture_string" )
        {
            vector< string > values = vsp::GetStringResults( result_id, j.b, index );
            if ( !TakeParmErrors( true ).empty() ) return Result( j.id, "Invalid string result field or index", "" );
            return Result( j.id, "", SyncFixtureStringArray( values ) );
        }
        if ( j.op == "results_fixture_matrix" )
        {
            vector< vector< double > > values = vsp::GetDoubleMatResults( result_id, j.b, index );
            if ( !TakeParmErrors( true ).empty() ) return Result( j.id, "Invalid matrix result field or index", "" );
            return Result( j.id, "", DoubleMatrixJson( values ) );
        }
        vector< vec3d > values = vsp::GetVec3dResults( result_id, j.b, index );
        if ( !TakeParmErrors( true ).empty() ) return Result( j.id, "Invalid vec3d result field or index", "" );
        return Result( j.id, "", Vec3dArrayJson( values ) );
    }
    // ---- Native-like in-process analysis and results access ------------------
    // Unlike the P1 diagnostic these run on the page's own model: a crash takes
    // the session with it, and analysis results stay in the page's ResultsMgr.
    if ( j.op == "liveListAnalysis" )
        return Result( j.id, "", LiveStringArray( vsp::ListAnalysis() ) );
    if ( j.op == "liveAnalysisInputNames" )
    {
        if ( j.a.empty() ) return Result( j.id, "Invalid analysis name", "" );
        return Result( j.id, "", LiveStringArray( vsp::GetAnalysisInputNames( j.a ) ) );
    }
    if ( j.op == "liveAnalysisInputType" )
    {
        if ( j.a.empty() || j.b.empty() ) return Result( j.id, "Invalid analysis input", "" );
        const int type = vsp::GetAnalysisInputType( j.a, j.b );
        TakeParmErrors( true ); // INVALID_TYPE is the discovery API's unknown-name sentinel.
        return Result( j.id, "", std::to_string( type ) );
    }
    // Length-prefixed UTF-8 packet: "<count>;<len>:<bytes>" repeated count times.
    // Lengths count bytes, so values may hold ';', ':' and newlines. Item 0 is
    // the input name; the rest are the values. The engine used a newline-joined
    // single value before, which could not carry a vector.
    const auto live_packet = []( const string &text, vector< string > &items )
    {
        size_t pos = 0;
        auto number = [&]( char stop, size_t &value )
        {
            const size_t start = pos;
            while ( pos < text.size() && text[pos] >= '0' && text[pos] <= '9' ) ++pos;
            if ( start == pos || pos >= text.size() || text[pos] != stop ) return false;
            if ( pos - start > 9 ) return false;
            value = static_cast< size_t >( std::stoul( text.substr( start, pos - start ) ) );
            ++pos;
            return true;
        };
        size_t count;
        if ( !number( ';', count ) || count > 1024 ) return false;
        items.clear();
        items.reserve( count );
        for ( size_t i = 0; i < count; ++i )
        {
            size_t len;
            if ( !number( ':', len ) || len > text.size() - pos ) return false;
            items.push_back( text.substr( pos, len ) );
            pos += len;
        }
        return pos == text.size();
    };
    if ( j.op == "liveAnalysisGetInt" || j.op == "liveAnalysisGetDouble" || j.op == "liveAnalysisGetString" ||
         j.op == "liveAnalysisSetInt" || j.op == "liveAnalysisSetDouble" || j.op == "liveAnalysisSetString" )
    {
        const bool set = j.op.find( "liveAnalysisSet" ) == 0;
        const int expected = j.op.find( "Int" ) != string::npos ? vsp::INT_DATA :
                             j.op.find( "Double" ) != string::npos ? vsp::DOUBLE_DATA : vsp::STRING_DATA;
        vector< string > items;
        string name = j.b;
        if ( set && ( !live_packet( j.b, items ) || items.empty() || items[0].empty() ) )
            return Result( j.id, "Invalid analysis input", "" );
        if ( set ) name = items[0];
        if ( j.a.empty() || name.empty() ) return Result( j.id, "Invalid analysis input", "" );
        TakeParmErrors( true );
        const int type = vsp::GetAnalysisInputType( j.a, name );
        const string typeErr = TakeParmErrors( true );
        if ( !typeErr.empty() || type != expected ) return Result( j.id, "Unsupported analysis input", "" );
        if ( !std::isfinite( j.value ) || j.value < 0 || j.value > 2147483647 || std::floor( j.value ) != j.value )
            return Result( j.id, "Invalid analysis input index", "" );
        const int index = static_cast< int >( j.value );
        const int count = vsp::GetNumAnalysisInputData( j.a, name );
        const string countErr = TakeParmErrors( true );
        if ( !countErr.empty() || index >= count ) return Result( j.id, "Invalid analysis input index", "" );
        if ( set )
        {
            std::vector< int > ints;
            std::vector< double > doubles;
            std::vector< string > strings;
            if ( expected == vsp::INT_DATA )
            {
                for ( size_t i = 1; i < items.size(); ++i )
                {
                    const string &text = items[i];
                    char *end = nullptr;
                    const long long value = std::strtoll( text.c_str(), &end, 10 );
                    if ( text.empty() || end != text.c_str() + text.size() ||
                         value < -2147483648LL || value > 2147483647LL )
                        return Result( j.id, "Invalid integer analysis input", "" );
                    ints.push_back( static_cast< int >( value ) );
                }
                vsp::SetIntAnalysisInput( j.a, name, ints, index );
            }
            else if ( expected == vsp::DOUBLE_DATA )
            {
                for ( size_t i = 1; i < items.size(); ++i )
                {
                    const string &text = items[i];
                    char *end = nullptr;
                    const double value = std::strtod( text.c_str(), &end );
                    if ( text.empty() || end != text.c_str() + text.size() || !std::isfinite( value ) )
                        return Result( j.id, "Invalid double analysis input", "" );
                    doubles.push_back( value );
                }
                vsp::SetDoubleAnalysisInput( j.a, name, doubles, index );
            }
            else
            {
                for ( size_t i = 1; i < items.size(); ++i )
                {
                    if ( items[i].find( '\0' ) != string::npos )
                        return Result( j.id, "Invalid string analysis input", "" );
                    strings.push_back( items[i] );
                }
                vsp::SetStringAnalysisInput( j.a, name, strings, index );
            }
            return Result( j.id, TakeParmErrors( true ), "null" );
        }
        string out;
        if ( expected == vsp::INT_DATA ) out = LiveIntArray( vsp::GetIntAnalysisInput( j.a, name, index ) );
        else if ( expected == vsp::DOUBLE_DATA ) out = LiveDoubleArray( vsp::GetDoubleAnalysisInput( j.a, name, index ) );
        else out = LiveStringArray( vsp::GetStringAnalysisInput( j.a, name, index ) );
        const string err = TakeParmErrors( true );
        if ( !err.empty() ) return Result( j.id, err, "" );
        if ( out.empty() ) return Result( j.id, "Analysis input cannot be represented", "" );
        return Result( j.id, "", out );
    }
    if ( j.op == "liveAnalysisDefaults" || j.op == "liveAnalysisRun" )
    {
        const bool degen = j.a == "DegenGeom", patches = j.a == "SurfacePatches", mass = j.a == "MassProp", comp = j.a == "CompGeom";
        auto &errors = vsp::ErrorMgrSingleton::getInstance();
        if ( j.op == "liveAnalysisDefaults" )
        {
            TakeParmErrors( true );
            vsp::SetAnalysisInputDefaults( j.a );
            return Result( j.id, TakeParmErrors( true ), "null" );
        }
        if ( !degen && !patches && !mass && !comp ) return Result( j.id, "Unknown analysis", "" );
        TakeParmErrors( true );
        auto setIntIfPresent = [&]( const char *name, int value )
        {
            if ( vsp::GetAnalysisInputType( j.a, name ) == vsp::INT_DATA )
                vsp::SetIntAnalysisInput( j.a, name, { value }, 0 );
        };
        if ( mass )
        {
            // Honour the caller's Set; never use modes (ModeID is a string input).
            setIntIfPresent( "UseModeFlag", 0 );
        }
        else if ( comp )
        {
            // Honour Set/DegenSet/HalfMesh/SubSurf; never write TXT/CSV or use modes.
            setIntIfPresent( "WriteTXTFlag", 0 );
            setIntIfPresent( "WriteCSVFlag", 0 );
            setIntIfPresent( "UseModeFlag", 0 );
        }
        else
        {
            // The helpers always run on the whole model, never write files, never use modes.
            setIntIfPresent( "Set", vsp::SET_ALL );
            if ( degen ) setIntIfPresent( "WriteCSVFlag", 0 );
            if ( degen ) setIntIfPresent( "WriteMFileFlag", 0 );
            setIntIfPresent( "UseModeFlag", 0 );
        }
        if ( errors.GetNumTotalErrors() ) return Result( j.id, errors.PopLastError().GetErrorString(), "" );
        const string root = vsp::ExecAnalysis( j.a );
        if ( errors.GetNumTotalErrors() ) return Result( j.id, errors.PopLastError().GetErrorString(), "" );
        if ( root.empty() ) return Result( j.id, "Analysis returned no root result", "" );
        return Result( j.id, "", Quote( root ) );
    }
#ifdef WEBVSP_LIVE_BINARY_TEST
    // Fixed, test-only data in the real ResultsMgr; no caller-controlled values.
    if ( j.op == "liveBinaryStringTestFixture" )
    {
        Results *result = ResultsMgrSingleton::getInstance().CreateResults( "LiveBinaryStrings", "test only" );
        if ( !result ) return Result( j.id, "Could not create fixture", "" );
        const string big = string( 4095, 'a' ) + "\xE2\x82\xAC" + string( 8 * 1024 * 1024, 'b' );
        result->Add( new NameValData( "strings", vector< string >{ "", big, "\xF0\x9F\x98\x80", "tail" }, "test" ) );
        result->Add( new NameValData( "empty_strings", vector< string >{}, "test" ) );
        return Result( j.id, "", Quote( result->GetID() ) );
    }
    if ( j.op == "liveBinaryTestFixture" )
    {
        Results *result = ResultsMgrSingleton::getInstance().CreateResults( "LiveBinaryFixture", "test only" );
        if ( !result ) return Result( j.id, "Could not create fixture", "" );
        const double nan = std::numeric_limits< double >::quiet_NaN();
        const double inf = std::numeric_limits< double >::infinity();
        for ( size_t n : { size_t( 0 ), size_t( 4095 ), size_t( 4096 ), size_t( 4097 ), size_t( 8193 ) } )
        {
            vector< double > values( n );
            for ( size_t i = 0; i < n; ++i ) values[i] = static_cast< double >( i );
            if ( n >= 4096 ) { values[4093] = nan; values[4094] = inf; values[4095] = -inf; }
            if ( n > 4096 ) values[4096] = nan;
            result->Add( new NameValData( "n" + std::to_string( n ), values, "test" ) );
        }
        result->Add( new NameValData( "matrix", vector< vector< double > >{ {}, { nan, inf, -inf }, {}, vector< double >( 4097, 7.0 ) }, "test" ) );
        result->Add( new NameValData( "empty_matrix", vector< vector< double > >{}, "test" ) );
        result->Add( new NameValData( "ints", vector< int >{ INT32_MIN, 0, INT32_MAX }, "test" ) );
        result->Add( new NameValData( "points", vector< vec3d >{ vec3d( nan, inf, -inf ) }, "test" ) );
        return Result( j.id, "", Quote( result->GetID() ) );
    }
#endif
    // Explicit IDs only: one job, no traversal or relationship inference. VRM1
    // contains count, then (status, byte length, VRO1 bytes) for each input.
    if ( j.op == "liveResultObjectsCapabilities" )
        return Result( j.id, "", "{\"version\":1,\"max_ids\":32,\"max_id_bytes\":128,\"max_bytes\":524288}" );
    if ( j.op == "liveResultObjects" )
    {
        constexpr size_t MAX_IDS = 32, MAX_ID_BYTES = 128, MAX_BYTES = 512 * 1024;
        vector<string> ids;
        if ( j.a.empty() ) return Result( j.id, "Invalid result IDs", "" );
        if ( !j.a.empty() )
        {
            size_t start = 0;
            while ( true )
            {
                size_t end = j.a.find( '\x1f', start );
                string id = j.a.substr( start, end == string::npos ? string::npos : end - start );
                if ( id.empty() || id.size() > MAX_ID_BYTES || ids.size() == MAX_IDS )
                    return Result( j.id, "Invalid result IDs", "" );
                for ( unsigned char c : id ) if ( c < 33 || c > 126 ) return Result( j.id, "Invalid result IDs", "" );
                ids.push_back( id );
                if ( end == string::npos ) break;
                start = end + 1;
            }
        }
        vector<uint8_t> out = { 'V', 'R', 'M', '1' };
        Put32( out, ids.size() );
        for ( size_t i = 0; i < ids.size(); ++i )
        {
            Results *r = ResultsMgrSingleton::getInstance().FindResultsPtr( ids[i] );
            vector<uint8_t> bytes = r ? LiveBinaryObject( r ) : vector<uint8_t>();
            // Reserve every remaining status header before adding a payload.
            const size_t reserved = 8 * ( ids.size() - i );
            unsigned status = !r ? 1 : ( bytes.empty() || bytes.size() > MAX_BYTES - out.size() - reserved ? 2 : 0 );
            Put32( out, status ); Put32( out, status == 0 ? bytes.size() : 0 );
            if ( status == 0 ) out.insert( out.end(), bytes.begin(), bytes.end() );
        }
        { std::lock_guard< std::mutex > lock( g_Mutex ); g_Binary[j.id] = std::move( out ); }
        return Result( j.id, "", "", true );
    }
    if ( j.op == "liveResultObject" )
    {
        Results *result = ResultsMgrSingleton::getInstance().FindResultsPtr( j.a );
        if ( !result ) return Result( j.id, "Unknown result ID", "" );
        vector< uint8_t > bytes = LiveBinaryObject( result );
        if ( bytes.empty() ) return Result( j.id, "", "null" );
        { std::lock_guard< std::mutex > lock( g_Mutex ); g_Binary[j.id] = std::move( bytes ); }
        return Result( j.id, "", "", true );
    }
    if ( j.op == "liveResultTree" )
    {
        if ( j.a.empty() || !ResultsMgrSingleton::getInstance().FindResultsPtr( j.a ) )
            return Result( j.id, "Unknown result ID", "" );
        std::set< string > seen;
        string objects;
        LiveTreeAppend( j.a, seen, objects );
        return Result( j.id, "", "{\"root\":" + Quote( j.a ) + ",\"objects\":[" + objects + "]}" );
    }
    if ( j.op == "liveResultsIds" )
        return Result( j.id, "", LiveStringArray( vsp::GetAllResultsIDs() ) );
    if ( j.op == "liveResultsNames" )
        return Result( j.id, "", LiveStringArray( vsp::GetAllResultsNames() ) );
    if ( j.op == "liveFindResultsId" )
    {
        // a = result name, value = index into results of that name.
        if ( j.a.empty() ) return Result( j.id, "Invalid result name", "" );
        if ( !std::isfinite( j.value ) || j.value < 0 || std::floor( j.value ) != j.value )
            return Result( j.id, "Invalid result index", "" );
        const string id = vsp::FindResultsID( j.a, static_cast< int >( j.value ) );
        TakeErrors(); // A missing name/index queues a native error; return "" instead.
        return Result( j.id, "", Quote( id ) );
    }
    if ( j.op == "liveFindLatestResultsId" )
    {
        if ( j.a.empty() ) return Result( j.id, "Invalid result name", "" );
        const string id = vsp::FindLatestResultsID( j.a );
        TakeErrors(); // No result of that name is reported as "" by this bridge.
        return Result( j.id, "", Quote( id ) );
    }
    if ( j.op == "liveNumResults" )
    {
        if ( j.a.empty() ) return Result( j.id, "Invalid result name", "" );
        const int count = vsp::GetNumResults( j.a );
        string err = TakeErrors();
        return Result( j.id, err, std::to_string( count ) );
    }
    if ( j.op == "liveDeleteResult" )
    {
        if ( j.a.empty() ) return Result( j.id, "Invalid result ID", "" );
        if ( !ResultsMgrSingleton::getInstance().FindResultsPtr( j.a ) )
            return Result( j.id, "", "null" ); // Unknown IDs are a no-op.
        vsp::DeleteResult( j.a );
        string err = TakeErrors();
        Watch( "Delete result", false );
        return Result( j.id, err, "null" );
    }
    if ( j.op == "liveDeleteAllResults" )
    {
        vsp::DeleteAllResults();
        string err = TakeErrors();
        Watch( "Delete all results", false );
        return Result( j.id, err, "null" );
    }
    if ( j.op == "liveResultName" || j.op == "liveResultNames" )
    {
        if ( j.a.empty() || !ResultsMgrSingleton::getInstance().FindResultsPtr( j.a ) )
            return Result( j.id, "Unknown result ID", "" );
        if ( j.op == "liveResultName" ) return Result( j.id, "", Quote( vsp::GetResultsName( j.a ) ) );
        return Result( j.id, "", LiveStringArray( vsp::GetAllDataNames( j.a ) ) );
    }
    if ( j.op == "liveResultNumData" || j.op == "liveResultType" )
    {
        if ( j.a.empty() || j.b.empty() ) return Result( j.id, "Invalid result field", "" );
        if ( j.op == "liveResultNumData" ) return Result( j.id, "", std::to_string( vsp::GetNumData( j.a, j.b ) ) );
        const int type = vsp::GetResultsType( j.a, j.b );
        if ( TakeParmErrors( true ) != "" ) return Result( j.id, "Unknown result field", "" );
        return Result( j.id, "", std::to_string( type ) );
    }
    if ( j.op == "liveResultShape" )
    {
        if ( j.a.empty() || j.b.empty() ) return Result( j.id, "Invalid result field", "" );
        const int index = static_cast< int >( j.value );
        const int type = vsp::GetResultsType( j.a, j.b );
        if ( TakeParmErrors( true ) != "" ) return Result( j.id, "Unknown result field", "" );
        size_t rows = 0, cols = 0, total = 0;
        if ( type == vsp::DOUBLE_MATRIX_DATA )
        {
            const auto m = vsp::GetDoubleMatResults( j.a, j.b, index );
            rows = m.size();
            for ( const auto &r : m ) { cols = std::max( cols, r.size() ); total += r.size(); }
        }
        else if ( type == vsp::INT_DATA ) total = vsp::GetIntResults( j.a, j.b, index ).size();
        else if ( type == vsp::DOUBLE_DATA ) total = vsp::GetDoubleResults( j.a, j.b, index ).size();
        else if ( type == vsp::STRING_DATA ) total = vsp::GetStringResults( j.a, j.b, index ).size();
        else if ( type == vsp::VEC3D_DATA ) total = vsp::GetVec3dResults( j.a, j.b, index ).size();
        if ( TakeParmErrors( true ) != "" ) return Result( j.id, "Invalid result field or index", "" );
        return Result( j.id, "", "{\"type\":" + std::to_string( type ) + ",\"rows\":" + std::to_string( rows ) +
                                 ",\"cols\":" + std::to_string( cols ) + ",\"total\":" + std::to_string( total ) + "}" );
    }
    if ( j.op == "liveResultBinaryField" )
    {
        Results *result = ResultsMgrSingleton::getInstance().FindResultsPtr( j.a );
        if ( !result ) return Result( j.id, "Unknown result ID", "" );
        if ( !std::isfinite( j.value ) || j.value < 0 || j.value > 2147483647 || std::floor( j.value ) != j.value )
            return Result( j.id, "Invalid result index", "" );
        const size_t first = j.b.find( '\x1f' ), second = j.b.find( '\x1f', first == string::npos ? 0 : first + 1 );
        if ( first == string::npos || first == 0 || second == string::npos || j.b.find( '\x1f', second + 1 ) != string::npos )
            return Result( j.id, "Invalid binary chunk request", "" );
        auto parse = []( const string &s, size_t &n ) {
            if ( s.empty() ) return false;
            n = 0;
            for ( char c : s ) { if ( c < '0' || c > '9' || n > ( UINT32_MAX - ( c - '0' ) ) / 10 ) return false; n = n * 10 + ( c - '0' ); }
            return true;
        };
        size_t row, offset;
        if ( !parse( j.b.substr( first + 1, second - first - 1 ), row ) || !parse( j.b.substr( second + 1 ), offset ) )
            return Result( j.id, "Invalid binary chunk request", "" );
        const int index = static_cast< int >( j.value );
        NameValData *data = result->FindPtr( j.b.substr( 0, first ), index );
        vector< uint8_t > bytes = LiveBinaryField( data, row, offset );
        if ( bytes.empty() ) return Result( j.id, "Unsupported binary result field", "" );
        {
            std::lock_guard< std::mutex > lock( g_Mutex );
            g_Binary[j.id] = std::move( bytes );
        }
        return Result( j.id, "", "", true );
    }
    if ( j.op == "liveResultValues" )
    {
        if ( j.a.empty() || j.b.empty() ) return Result( j.id, "Invalid result field", "" );
        // "name" or "name<US>offset<US>limit": big fields are read in chunks.
        string field = j.b;
        size_t offset = 0, limit = 0;
        const size_t sep1 = field.find( '\x1f' );
        if ( sep1 != string::npos )
        {
            const size_t sep2 = field.find( '\x1f', sep1 + 1 );
            if ( sep2 == string::npos ) return Result( j.id, "Invalid result chunk", "" );
            offset = std::stoul( field.substr( sep1 + 1, sep2 - sep1 - 1 ) );
            limit = std::stoul( field.substr( sep2 + 1 ) );
            field = field.substr( 0, sep1 );
        }
        const int index = static_cast< int >( j.value );
        if ( index < 0 ) return Result( j.id, "Invalid result index", "" );
        const int type = vsp::GetResultsType( j.a, field );
        if ( TakeParmErrors( true ) != "" ) return Result( j.id, "Unknown result field", "" );
        auto slice = [&]( size_t n, size_t &from, size_t &count ) {
            from = 0; count = n;
            if ( limit )
            {
                from = std::min( offset, n );
                count = std::min( limit, n - from );
            }
            return true;
        };
        string value;
        if ( type == vsp::INT_DATA )
        {
            const auto all = vsp::GetIntResults( j.a, field, index );
            size_t from, count; slice( all.size(), from, count );
            string err;
            if ( !limit && LiveTooLarge( all.size(), err ) ) return Result( j.id, err, "" );
            const vector< int > v( all.begin() + from, all.begin() + from + count );
            value = LiveIntArray( v );
            if ( !limit ) value += "";
        }
        else if ( type == vsp::DOUBLE_DATA )
        {
            const auto all = vsp::GetDoubleResults( j.a, field, index );
            size_t from, count; slice( all.size(), from, count );
            string err;
            if ( !limit && LiveTooLarge( all.size(), err ) ) return Result( j.id, err, "" );
            const vector< double > v( all.begin() + from, all.begin() + from + count );
            value = LiveDoubleArray( v );
            if ( value.empty() && !v.empty() ) return Result( j.id, "Result field has a non-finite value or exceeds the transport", "" );
        }
        else if ( type == vsp::STRING_DATA )
        {
            const auto all = vsp::GetStringResults( j.a, field, index );
            size_t from, count; slice( all.size(), from, count );
            value = LiveStringArray( vector< string >( all.begin() + from, all.begin() + from + count ) );
        }
        else if ( type == vsp::DOUBLE_MATRIX_DATA )
        {
            size_t count = 0;
            value = LiveDoubleMatrix( vsp::GetDoubleMatResults( j.a, field, index ), count );
            if ( value.empty() ) return Result( j.id, "Invalid or oversized double matrix result", "" );
        }
        else if ( type == vsp::VEC3D_DATA )
        {
            const auto all = vsp::GetVec3dResults( j.a, field, index );
            size_t from, count; slice( all.size(), from, count );
            value = LiveVec3dArray( vector< vec3d >( all.begin() + from, all.begin() + from + count ) );
            if ( value.empty() && !all.empty() ) return Result( j.id, "Invalid vec3d result", "" );
        }
        else if ( type == vsp::INT_MATRIX_DATA )
        {
            string out = "[";
            const auto rows = ResultsMgrSingleton::getInstance().GetIntMatResults( j.a, j.b, index );
            for ( size_t i = 0; i < rows.size(); ++i ) out += ( i ? "," : "" ) + IntArrayJson( rows[i] );
            value = out + "]";
        }
        else return Result( j.id, "Unsupported result type", "" );
        if ( TakeParmErrors( true ) != "" ) return Result( j.id, "Invalid result field or index", "" );
        return Result( j.id, "", "{\"type\":" + std::to_string( type ) + ",\"value\":" + value + "}" );
    }
    if ( j.op == "liveParmGet" || j.op == "liveParmSet" )
    {
        const size_t sep = j.b.find( '\x1f' );
        if ( sep == string::npos ) return Result( j.id, "Invalid parameter name", "" );
        const string group = j.b.substr( 0, sep ), name = j.b.substr( sep + 1 );
        const double before = vsp::GetParmVal( j.a, name, group );
        const string readErr = TakeParmErrors( true );
        if ( !readErr.empty() ) return Result( j.id, "GetParmVal(" + group + "/" + name + "): " + readErr, "" );
        if ( j.op == "liveParmGet" ) return Result( j.id, "", Num( before ) );
        const double actual = vsp::SetParmVal( j.a, name, group, j.value );
        const string writeErr = TakeParmErrors( true );
        if ( !writeErr.empty() ) return Result( j.id, "SetParmVal(" + group + "/" + name + "): " + writeErr, "" );
        return Result( j.id, "", Num( actual ) );
    }
    // ---- Live XSec / subsurface / set access (in-process mode) -------------
    if ( j.op == "liveXSecSurfIDs" )
    {
        const auto ids = vsp::GetXSecSurfIDVec( j.a );
        const string err = TakeParmErrors( true );
        return Result( j.id, err, LiveStringArray( ids ) );
    }
    if ( j.op == "liveXSecWidth" || j.op == "liveXSecHeight" )
    {
        const double value = j.op == "liveXSecWidth" ? vsp::GetXSecWidth( j.a ) : vsp::GetXSecHeight( j.a );
        const string err = TakeParmErrors( true );
        return Result( j.id, err, Num( value ) );
    }
    if ( j.op == "liveXSecParm" )
    {
        const string id = vsp::GetXSecParm( j.a, j.b );
        const string err = TakeParmErrors( true );
        return Result( j.id, err, Quote( id ) );
    }
    if ( j.op == "liveXSecSetWidth" || j.op == "liveXSecSetHeight" || j.op == "liveXSecSetWidthHeight" )
    {
        if ( !std::isfinite( j.value ) ) return Result( j.id, "Invalid XSec dimension", "" );
        if ( j.op == "liveXSecSetWidthHeight" )
        {
            char *end = nullptr;
            const double height = std::strtod( j.b.c_str(), &end );
            if ( j.b.empty() || end != j.b.c_str() + j.b.size() || !std::isfinite( height ) )
                return Result( j.id, "Invalid XSec height", "" );
            vsp::SetXSecWidthHeight( j.a, j.value, height );
        }
        else if ( j.op == "liveXSecSetWidth" ) vsp::SetXSecWidth( j.a, j.value );
        else vsp::SetXSecHeight( j.a, j.value );
        return Result( j.id, TakeParmErrors( true ), "null" );
    }
    if ( j.op == "liveXSecSurfs" )
    {
        vector< string > out;
        const int n = vsp::GetNumXSecSurfs( j.a );
        string err = TakeParmErrors( true );
        if ( !err.empty() ) return Result( j.id, err, "" );
        for ( int i = 0; i < n; ++i )
        {
            string id = vsp::GetXSecSurf( j.a, i );
            err = TakeParmErrors( true );
            if ( !err.empty() ) return Result( j.id, err, "" );
            out.push_back( id );
        }
        return Result( j.id, "", LiveStringArray( out ) );
    }
    if ( j.op == "liveXSecs" )
    {
        vector< string > out;
        const int n = vsp::GetNumXSec( j.a );
        string err = TakeParmErrors( true );
        if ( !err.empty() ) return Result( j.id, err, "" );
        for ( int i = 0; i < n; ++i )
        {
            string id = vsp::GetXSec( j.a, i );
            err = TakeParmErrors( true );
            if ( !err.empty() ) return Result( j.id, err, "" );
            out.push_back( id );
        }
        return Result( j.id, "", LiveStringArray( out ) );
    }
    if ( j.op == "liveXSecIDs" )
    {
        const auto ids = vsp::GetXSecIDVec( j.a );
        const string err = TakeParmErrors( true );
        return Result( j.id, err, LiveStringArray( ids ) );
    }
    if ( j.op == "liveXSecShape" )
    {
        const int shape = vsp::GetXSecShape( j.a );
        const string err = TakeParmErrors( true );
        return Result( j.id, err, std::to_string( shape ) );
    }
    if ( j.op == "liveXSecParmIDs" )
    {
        const auto ids = vsp::GetXSecParmIDs( j.a );
        const string err = TakeParmErrors( true );
        return Result( j.id, err, LiveStringArray( ids ) );
    }
    if ( j.op == "liveXSecAlias" || j.op == "liveXSecCurveAlias" )
    {
        const string alias = j.op == "liveXSecAlias" ? vsp::GetXSecAlias( j.a ) : vsp::GetXSecCurveAlias( j.a );
        return Result( j.id, TakeParmErrors( true ), Quote( alias ) );
    }
    if ( j.op == "liveXSecSetAlias" || j.op == "liveXSecSetCurveAlias" )
    {
        if ( j.op == "liveXSecSetAlias" ) vsp::SetXSecAlias( j.a, j.b );
        else vsp::SetXSecCurveAlias( j.a, j.b );
        return Result( j.id, TakeParmErrors( true ), "null" );
    }
    if ( j.op == "liveXSecContinuity" )
    {
        const int c = vsp::GetXSecContinuity( j.a );
        return Result( j.id, TakeParmErrors( true ), std::to_string( c ) );
    }
    if ( j.op == "liveXSecSetContinuity" )
    {
        char *end = nullptr;
        const double c = std::strtod( j.b.c_str(), &end );
        if ( j.b.empty() || end != j.b.c_str() + j.b.size() || !std::isfinite( c ) || std::floor( c ) != c )
            return Result( j.id, "Invalid XSec continuity", "" );
        vsp::SetXSecContinuity( j.a, static_cast< int >( c ) );
        return Result( j.id, TakeParmErrors( true ), "null" );
    }
    if ( j.op == "liveXSecTanAngles" || j.op == "liveXSecTanSlews" || j.op == "liveXSecTanStrengths" ||
         j.op == "liveXSecCurvatures" )
    {
        const int side = static_cast< int >( j.value );
        vector< double > values;
        if ( j.op == "liveXSecTanAngles" ) values = vsp::GetXSecTanAngles( j.a, side );
        else if ( j.op == "liveXSecTanSlews" ) values = vsp::GetXSecTanSlews( j.a, side );
        else if ( j.op == "liveXSecTanStrengths" ) values = vsp::GetXSecTanStrengths( j.a, side );
        else values = vsp::GetXSecCurvatures( j.a, side );
        const string err = TakeParmErrors( true );
        if ( !err.empty() ) return Result( j.id, err, "" );
        return Result( j.id, "", LiveDoubleArray( values ) );
    }
    if ( j.op == "liveXSecSetTanAngles" || j.op == "liveXSecSetTanSlews" || j.op == "liveXSecSetTanStrengths" ||
         j.op == "liveXSecSetCurvatures" )
    {
        // Five unit-separated fields: side, top, right, bottom, left. Numbers
        // cannot contain the separator, so no framing is needed here.
        vector< double > fields;
        size_t pos = 0;
        while ( pos <= j.b.size() )
        {
            const size_t sep = j.b.find( '\x1f', pos );
            const string text = j.b.substr( pos, sep == string::npos ? string::npos : sep - pos );
            char *end = nullptr;
            const double value = std::strtod( text.c_str(), &end );
            if ( text.empty() || end != text.c_str() + text.size() || !std::isfinite( value ) )
                return Result( j.id, "Invalid XSec curve value", "" );
            fields.push_back( value );
            if ( sep == string::npos ) break;
            pos = sep + 1;
        }
        if ( fields.size() != 5 ) return Result( j.id, "Invalid XSec curve values", "" );
        const int side = static_cast< int >( fields[0] );
        if ( j.op == "liveXSecSetTanAngles" ) vsp::SetXSecTanAngles( j.a, side, fields[1], fields[2], fields[3], fields[4] );
        else if ( j.op == "liveXSecSetTanSlews" ) vsp::SetXSecTanSlews( j.a, side, fields[1], fields[2], fields[3], fields[4] );
        else if ( j.op == "liveXSecSetTanStrengths" ) vsp::SetXSecTanStrengths( j.a, side, fields[1], fields[2], fields[3], fields[4] );
        else vsp::SetXSecCurvatures( j.a, side, fields[1], fields[2], fields[3], fields[4] );
        return Result( j.id, TakeParmErrors( true ), "null" );
    }
    // Check both transport representations before converting or calling OpenVSP.
    // stoi alone accepts prefixes such as "1.5" and "1e3".
    const auto live_int_value = []( double value ) {
        return std::isfinite( value ) && std::trunc( value ) == value &&
               value >= std::numeric_limits< int >::min() && value <= std::numeric_limits< int >::max();
    };
    const auto live_int_text = []( const string &text, int &value ) {
        size_t i = 0;
        if ( !text.empty() && ( text[0] == '-' || text[0] == '+' ) ) i = 1;
        if ( i == text.size() ) return false;
        for ( ; i < text.size(); ++i ) if ( text[i] < '0' || text[i] > '9' ) return false;
        try { value = std::stoi( text ); return true; } catch ( ... ) { return false; }
    };
    if ( j.op == "liveInsertXSec" )
    {
        int shape;
        if ( !live_int_value( j.value ) || !live_int_text( j.b, shape ) ) return Result( j.id, "Invalid XSec index or shape", "" );
        vsp::InsertXSec( j.a, static_cast< int >( j.value ), shape );
        return Result( j.id, TakeParmErrors( true ), "null" );
    }
    if ( j.op == "liveInsertXSecByID" )
    {
        int shape;
        if ( !live_int_text( j.b, shape ) ) return Result( j.id, "Invalid XSec shape", "" );
        const string id = vsp::InsertXSecByID( j.a, shape );
        const string err = TakeParmErrors( true );
        if ( !err.empty() ) return Result( j.id, err, "" );
        return Result( j.id, "", Quote( id ) );
    }
    if ( j.op == "liveDeleteXSecByID" )
    {
        vsp::CutXSecByID( j.a );
        return Result( j.id, TakeParmErrors( true ), "null" );
    }
    if ( j.op == "liveDeleteXSec" )
    {
        if ( !live_int_value( j.value ) ) return Result( j.id, "Invalid XSec index", "" );
        vsp::CutXSec( j.a, static_cast< int >( j.value ) );
        return Result( j.id, TakeParmErrors( true ), "null" );
    }
    if ( j.op == "liveCopyXSec" || j.op == "livePasteXSec" )
    {
        if ( !live_int_value( j.value ) ) return Result( j.id, "Invalid XSec index", "" );
        if ( j.op == "liveCopyXSec" ) vsp::CopyXSec( j.a, static_cast< int >( j.value ) );
        else vsp::PasteXSec( j.a, static_cast< int >( j.value ) );
        return Result( j.id, TakeParmErrors( true ), "null" );
    }
    if ( j.op == "liveCopyXSecByID" || j.op == "livePasteXSecByID" )
    {
        if ( j.op == "liveCopyXSecByID" ) vsp::CopyXSecByID( j.a );
        else vsp::PasteXSecByID( j.a );
        return Result( j.id, TakeParmErrors( true ), "null" );
    }
    if ( j.op == "liveChangeXSecShape" )
    {
        int shape;
        if ( !live_int_text( j.b, shape ) ) return Result( j.id, "Invalid XSec shape", "" );
        vsp::ChangeXSecShapeByID( j.a, shape );
        return Result( j.id, TakeParmErrors( true ), "null" );
    }
    if ( j.op == "liveSubSurfs" )
    {
        const auto ids = vsp::GetSubSurfIDVec( j.a );
        const string err = TakeParmErrors( true );
        return Result( j.id, err, LiveStringArray( ids ) );
    }
    if ( j.op == "liveSubSurfsByName" )
    {
        const auto ids = vsp::GetSubSurf( j.a, j.b );
        const string err = TakeParmErrors( true );
        return Result( j.id, err, LiveStringArray( ids ) );
    }
    if ( j.op == "liveSubSurfType" )
    {
        const int type = vsp::GetSubSurfType( j.a );
        const string err = TakeParmErrors( true );
        return Result( j.id, err, std::to_string( type ) );
    }
    if ( j.op == "liveSubSurfParmIDs" )
    {
        const auto ids = vsp::GetSubSurfParmIDs( j.a );
        const string err = TakeParmErrors( true );
        return Result( j.id, err, LiveStringArray( ids ) );
    }
    if ( j.op == "liveSubSurfName" )
    {
        const string name = vsp::GetSubSurfName( j.a );
        return Result( j.id, TakeParmErrors( true ), Quote( name ) );
    }
    if ( j.op == "liveSubSurfNameGeom" )
    {
        const string name = vsp::GetSubSurfName( j.a, j.b );
        return Result( j.id, TakeParmErrors( true ), Quote( name ) );
    }
    if ( j.op == "liveSubSurfIndex" )
    {
        const int index = vsp::GetSubSurfIndex( j.a );
        return Result( j.id, TakeParmErrors( true ), std::to_string( index ) );
    }
    if ( j.op == "liveAllSubSurfs" )
    {
        const auto ids = vsp::GetAllSubSurfIDs();
        return Result( j.id, TakeParmErrors( true ), LiveStringArray( ids ) );
    }
    if ( j.op == "liveAddSubSurf" )
    {
        int type;
        if ( !live_int_value( j.value ) || !live_int_text( j.b, type ) ) return Result( j.id, "Invalid subsurface type or index", "" );
        const string id = vsp::AddSubSurf( j.a, type, static_cast< int >( j.value ) );
        const string err = TakeParmErrors( true );
        if ( !err.empty() ) return Result( j.id, err, "" );
        if ( id.empty() ) return Result( j.id, "Could not add subsurface", "" );
        return Result( j.id, "", Quote( id ) );
    }
    if ( j.op == "liveDeleteSubSurf" )
    {
        vsp::DeleteSubSurf( j.a, j.b );
        return Result( j.id, TakeParmErrors( true ), "null" );
    }
    if ( j.op == "liveDeleteSubSurfID" )
    {
        vsp::DeleteSubSurf( j.a );
        return Result( j.id, TakeParmErrors( true ), "null" );
    }
    if ( j.op == "liveReorderSubSurf" )
    {
        if ( !live_int_value( j.value ) ) return Result( j.id, "Invalid reorder type", "" );
        vsp::ReorderSubSurf( j.a, j.b, static_cast< int >( j.value ) );
        return Result( j.id, TakeParmErrors( true ), "null" );
    }
    if ( j.op == "liveSetSubSurfName" )
    {
        const size_t sep = j.b.find( '\x1f' );
        if ( sep == string::npos ) return Result( j.id, "Invalid subsurface name", "" );
        vsp::SetSubSurfName( j.a, j.b.substr( 0, sep ), j.b.substr( sep + 1 ) );
        return Result( j.id, TakeParmErrors( true ), "null" );
    }
    if ( j.op == "liveSetSubSurfNameID" )
    {
        vsp::SetSubSurfName( j.a, j.b );
        return Result( j.id, TakeParmErrors( true ), "null" );
    }
    if ( j.op == "liveNumSets" )
        return Result( j.id, "", std::to_string( vsp::GetNumSets() ) );
    if ( j.op == "liveSetName" )
        return Result( j.id, "", Quote( vsp::GetSetName( static_cast< int >( j.value ) ) ) );
    if ( j.op == "liveSetSetName" )
    {
        vsp::SetSetName( static_cast< int >( j.value ), j.b );
        return Result( j.id, "", "null" );
    }
    if ( j.op == "liveSetIndex" )
    {
        if ( j.a.empty() ) return Result( j.id, "Invalid set name", "" );
        return Result( j.id, "", std::to_string( vsp::GetSetIndex( j.a ) ) );
    }
    if ( j.op == "liveGeomSet" )
    {
        if ( j.a.empty() ) return Result( j.id, "Invalid set name", "" );
        return Result( j.id, "", LiveStringArray( vsp::GetGeomSet( j.a ) ) );
    }
    if ( j.op == "liveGeomSetAtIndex" )
    {
        if ( !std::isfinite( j.value ) || j.value < 0 || std::floor( j.value ) != j.value )
            return Result( j.id, "Invalid set index", "" );
        return Result( j.id, "", LiveStringArray( vsp::GetGeomSetAtIndex( static_cast< int >( j.value ) ) ) );
    }
    if ( j.op == "liveGetSetFlag" )
        return Result( j.id, "", vsp::GetSetFlag( j.a, static_cast< int >( j.value ) ) ? "true" : "false" );
    if ( j.op == "liveSetSetFlag" )
    {
        vsp::SetSetFlag( j.a, static_cast< int >( j.value ), std::stoi( j.b ) != 0 );
        return Result( j.id, "", "null" );
    }
    if ( j.op == "liveParmInfo" )
    {
        if ( j.a.empty() ) return Result( j.id, "Invalid parameter ID", "" );
        Parm *p = ParmMgr.FindParm( j.a );
        if ( !p ) return Result( j.id, "Unknown parameter", "" );
        // `group` stays the display group for compatibility; `groupName` is the
        // internal group FindParm/GetParmVal expect.
        return Result( j.id, "", "{\"id\":" + Quote( j.a ) +
            ",\"name\":" + Quote( vsp::GetParmName( j.a ) ) +
            ",\"group\":" + Quote( vsp::GetParmDisplayGroupName( j.a ) ) +
            ",\"groupName\":" + Quote( vsp::GetParmGroupName( j.a ) ) +
            ",\"container\":" + Quote( vsp::GetParmContainer( j.a ) ) +
            ",\"type\":" + std::to_string( vsp::GetParmType( j.a ) ) +
            ",\"active\":" + ( vsp::GetParmActiveFlag( j.a ) ? "true" : "false" ) +
            ",\"lower\":" + Num( vsp::GetParmLowerLimit( j.a ) ) +
            ",\"upper\":" + Num( vsp::GetParmUpperLimit( j.a ) ) +
            ",\"value\":" + Num( vsp::GetParmVal( j.a ) ) + "}" );
    }
    if ( j.op == "liveParmType" )
    {
        if ( j.a.empty() || !ParmMgr.FindParm( j.a ) ) return Result( j.id, "Unknown parameter", "" );
        return Result( j.id, "", std::to_string( vsp::GetParmType( j.a ) ) );
    }
    if ( j.op == "liveParmLimits" )
    {
        if ( j.a.empty() || !ParmMgr.FindParm( j.a ) ) return Result( j.id, "Unknown parameter", "" );
        return Result( j.id, "", "{\"lower\":" + Num( vsp::GetParmLowerLimit( j.a ) ) +
                                 ",\"upper\":" + Num( vsp::GetParmUpperLimit( j.a ) ) + "}" );
    }
    if ( j.op == "liveParmActive" )
    {
        if ( j.a.empty() || !ParmMgr.FindParm( j.a ) ) return Result( j.id, "Unknown parameter", "" );
        return Result( j.id, "", vsp::GetParmActiveFlag( j.a ) ? "true" : "false" );
    }
    if ( j.op == "liveParmName" || j.op == "liveParmGroup" || j.op == "liveParmDisplayGroup" || j.op == "liveParmValueById" )
    {
        if ( j.a.empty() || !ParmMgr.FindParm( j.a ) ) return Result( j.id, "Unknown parameter", "" );
        if ( j.op == "liveParmName" ) return Result( j.id, "", Quote( vsp::GetParmName( j.a ) ) );
        if ( j.op == "liveParmGroup" ) return Result( j.id, "", Quote( vsp::GetParmGroupName( j.a ) ) );
        if ( j.op == "liveParmDisplayGroup" ) return Result( j.id, "", Quote( vsp::GetParmDisplayGroupName( j.a ) ) );
        const double value = vsp::GetParmVal( j.a );
        const string readErr = TakeParmErrors( true );
        if ( !readErr.empty() ) return Result( j.id, "GetParmVal failed: " + readErr, "" );
        return Result( j.id, "", Num( value ) );
    }
    if ( j.op == "liveParmFind" )
    {
        // b = internal group name + \x1f + parm name (same order as liveParmGet).
        const size_t sep = j.b.find( '\x1f' );
        if ( j.a.empty() || sep == string::npos || sep == 0 || sep + 1 >= j.b.size() )
            return Result( j.id, "Invalid parameter lookup", "" );
        const string group = j.b.substr( 0, sep ), name = j.b.substr( sep + 1 );
        const string id = vsp::FindParm( j.a, name, group );
        TakeErrors(); // A missing parm queues a native error; report "" instead.
        return Result( j.id, "", Quote( id ) );
    }
    if ( j.op == "liveParmSetUpdate" )
    {
        if ( j.a.empty() || !ParmMgr.FindParm( j.a ) ) return Result( j.id, "Unknown parameter", "" );
        if ( !std::isfinite( j.value ) ) return Result( j.id, "Requested value must be finite", "" );
        const double actual = vsp::SetParmValUpdate( j.a, j.value );
        const string err = TakeParmErrors( true );
        Watch( "Parameter update", true );
        if ( !err.empty() ) return Result( j.id, "SetParmValUpdate failed: " + err, "" );
        return Result( j.id, "", Num( actual ) );
    }
    if ( j.op == "liveParmSetById" )
    {
        if ( j.a.empty() ) return Result( j.id, "Invalid parameter ID", "" );
        if ( !ParmMgr.FindParm( j.a ) ) return Result( j.id, "Unknown parameter", "" );
        const double actual = vsp::SetParmVal( j.a, j.value );
        const string err = TakeParmErrors( true );
        if ( !err.empty() ) return Result( j.id, "SetParmVal failed: " + err, "" );
        return Result( j.id, "", Num( actual ) );
    }
    if ( j.op == "liveFindGeoms" )
        return Result( j.id, "", LiveStringArray( vsp::FindGeoms() ) );
    if ( j.op == "liveFindGeom" )
    {
        if ( j.a.empty() ) return Result( j.id, "Invalid geometry name", "" );
        if ( !std::isfinite( j.value ) || j.value < 0 || std::floor( j.value ) != j.value )
            return Result( j.id, "Invalid geometry index", "" );
        return Result( j.id, "", Quote( vsp::FindGeom( j.a, static_cast< int >( j.value ) ) ) );
    }
    if ( j.op == "liveGeomName" || j.op == "liveGeomTypeName" )
    {
        if ( j.a.empty() ) return Result( j.id, "Invalid geometry ID", "" );
        const string value = j.op == "liveGeomName" ? vsp::GetGeomName( j.a ) : vsp::GetGeomTypeName( j.a );
        string err = TakeErrors();
        if ( !err.empty() ) return Result( j.id, err, "" );
        return Result( j.id, "", Quote( value ) );
    }
    if ( j.op == "liveGeomParent" || j.op == "liveGeomChildren" )
    {
        if ( j.a.empty() ) return Result( j.id, "Invalid geometry ID", "" );
        if ( j.op == "liveGeomChildren" )
        {
            const vector< string > children = vsp::GetGeomChildren( j.a );
            string err = TakeErrors();
            if ( !err.empty() ) return Result( j.id, err, "" );
            return Result( j.id, "", LiveStringArray( children ) );
        }
        const string parent = vsp::GetGeomParent( j.a );
        string err = TakeErrors();
        if ( !err.empty() ) return Result( j.id, err, "" );
        return Result( j.id, "", Quote( parent ) );
    }
    if ( j.op == "liveCompPnt01" || j.op == "liveCompNorm01" )
    {
        // b holds an integer surface index and a round-trip decimal w; value holds u.
        const size_t sep = j.b.find( ',' );
        if ( j.a.empty() || sep == string::npos || sep == 0 || sep + 1 == j.b.size() || !std::isfinite( j.value ) )
            return Result( j.id, "Invalid surface query arguments", "" );
        char *end = nullptr;
        errno = 0;
        const long index = std::strtol( j.b.c_str(), &end, 10 );
        if ( errno || end != j.b.c_str() + sep || index < std::numeric_limits<int>::min() || index > std::numeric_limits<int>::max() )
            return Result( j.id, "Invalid surface index", "" );
        const char *start = j.b.c_str() + sep + 1;
        const double w = std::strtod( start, &end );
        if ( end == start || *end != '\0' || !std::isfinite( w ) )
            return Result( j.id, "Invalid surface coordinate", "" );
        const vec3d v = j.op == "liveCompPnt01" ? vsp::CompPnt01( j.a, static_cast<int>( index ), j.value, w )
                                                  : vsp::CompNorm01( j.a, static_cast<int>( index ), j.value, w );
        const string err = TakeErrors();
        if ( !err.empty() ) return Result( j.id, err, "" );
        return Result( j.id, "", "[" + Num( v.x() ) + "," + Num( v.y() ) + "," + Num( v.z() ) + "]" );
    }
    if ( j.op == "liveNumMainSurfs" )
    {
        const int count = vsp::GetNumMainSurfs( j.a );
        const string err = TakeErrors();
        if ( !err.empty() ) return Result( j.id, err, "" );
        return Result( j.id, "", std::to_string( count ) );
    }
    if ( j.op == "liveGeomDrawType" || j.op == "liveGeomDisplayType" )
    {
        const int type = j.op == "liveGeomDrawType" ? vsp::GetGeomDrawType( j.a ) : vsp::GetGeomDisplayType( j.a );
        const string err = TakeErrors();
        if ( !err.empty() ) return Result( j.id, err, "" );
        return Result( j.id, "", std::to_string( type ) );
    }
    if ( j.op == "liveGeomSetDrawType" || j.op == "liveGeomSetDisplayType" )
    {
        if ( !std::isfinite( j.value ) || std::floor( j.value ) != j.value ||
             j.value < -2147483648.0 || j.value > 2147483647.0 )
            return ParmWriteFailure( j.id, "Invalid display type", "not_written", "null" );
        if ( !BeginGuardedWrite() ) return;
        if ( j.op == "liveGeomSetDrawType" ) vsp::SetGeomDrawType( j.a, static_cast<int>( j.value ) );
        else vsp::SetGeomDisplayType( j.a, static_cast<int>( j.value ) );
        DrainedErrors errors = TakeWriteErrors();
        Watch( "Geometry display type", true );
        if ( errors.had_errors ) return ParmWriteFailure( j.id, errors.message, "unknown", "null" );
        return Result( j.id, "", "null" );
    }
    if ( j.op == "liveGeomWireColor" )
    {
        const vec3d color = vsp::GetGeomWireColor( j.a );
        const string err = TakeErrors();
        if ( !err.empty() ) return Result( j.id, err, "" );
        return Result( j.id, "", "[" + Num( color.x() ) + "," + Num( color.y() ) + "," + Num( color.z() ) + "]" );
    }
    if ( j.op == "liveGeomSetWireColor" )
    {
        // b carries three unit-separated 0-255 channels; they contain no separator.
        vector< double > channels;
        size_t pos = 0;
        while ( channels.size() < 3 )
        {
            const size_t sep = j.b.find( '\x1f', pos );
            if ( sep == string::npos ) break;
            const string text = j.b.substr( pos, sep - pos );
            char *end = nullptr;
            const double value = std::strtod( text.c_str(), &end );
            if ( text.empty() || end != text.c_str() + text.size() || !std::isfinite( value ) || std::floor( value ) != value )
                return ParmWriteFailure( j.id, "Invalid wire colour", "not_written", "null" );
            channels.push_back( value );
            pos = sep + 1;
        }
        const string last = j.b.substr( pos );
        char *end = nullptr;
        const double tail = std::strtod( last.c_str(), &end );
        if ( last.empty() || end != last.c_str() + last.size() || !std::isfinite( tail ) || std::floor( tail ) != tail )
            return ParmWriteFailure( j.id, "Invalid wire colour", "not_written", "null" );
        channels.push_back( tail );
        if ( channels.size() != 3 ) return ParmWriteFailure( j.id, "Invalid wire colour", "not_written", "null" );
        if ( !BeginGuardedWrite() ) return;
        vsp::SetGeomWireColor( j.a, static_cast<int>( channels[0] ), static_cast<int>( channels[1] ), static_cast<int>( channels[2] ) );
        DrainedErrors errors = TakeWriteErrors();
        Watch( "Geometry wire colour", true );
        if ( errors.had_errors ) return ParmWriteFailure( j.id, errors.message, "unknown", "null" );
        return Result( j.id, "", "null" );
    }
    if ( j.op == "liveGeomMaterial" )
    {
        const string name = vsp::GetGeomMaterialName( j.a );
        const string err = TakeErrors();
        if ( !err.empty() ) return Result( j.id, err, "" );
        return Result( j.id, "", Quote( name ) );
    }
    if ( j.op == "liveGeomSetMaterial" )
    {
        if ( !BeginGuardedWrite() ) return;
        vsp::SetGeomMaterialName( j.a, j.b );
        DrainedErrors errors = TakeWriteErrors();
        Watch( "Geometry material", true );
        if ( errors.had_errors ) return ParmWriteFailure( j.id, errors.message, "unknown", "null" );
        return Result( j.id, "", "null" );
    }
    if ( j.op == "liveGeomBBoxMin" || j.op == "liveGeomBBoxMax" )
    {
        // value holds the main surface index; b is "1" for the absolute frame.
        if ( !std::isfinite( j.value ) || std::floor( j.value ) != j.value ||
             j.value < -2147483648.0 || j.value > 2147483647.0 )
            return Result( j.id, "Invalid main surface index", "" );
        if ( j.b != "1" && j.b != "0" ) return Result( j.id, "Invalid reference frame", "" );
        const int surf = static_cast<int>( j.value );
        const bool absolute = j.b == "1";
        const vec3d v = j.op == "liveGeomBBoxMin" ? vsp::GetGeomBBoxMin( j.a, surf, absolute )
                                                  : vsp::GetGeomBBoxMax( j.a, surf, absolute );
        const string err = TakeErrors();
        if ( !err.empty() ) return Result( j.id, err, "" );
        return Result( j.id, "", "[" + Num( v.x() ) + "," + Num( v.y() ) + "," + Num( v.z() ) + "]" );
    }
    if ( j.op == "liveUpdateGeom" || j.op == "liveSetGeomParent" ||
         j.op == "liveCopyGeom" || j.op == "liveCutGeom" || j.op == "livePasteGeom" )
    {
        if ( j.op == "liveCutGeom" && ( !std::isfinite( j.value ) || std::floor( j.value ) != j.value ||
             j.value < 0 || j.value >= vsp::CLONE_DELETE_NUM_TYPES ) )
            return ParmWriteFailure( j.id, "Invalid clone_delete", "not_written", "null" );
        if ( !BeginGuardedWrite() ) return;
        vector< string > pasted;
        if ( j.op == "liveUpdateGeom" ) vsp::UpdateGeom( j.a );
        else if ( j.op == "liveSetGeomParent" ) vsp::SetGeomParent( j.a, j.b );
        else if ( j.op == "liveCopyGeom" ) vsp::CopyGeomToClipboard( j.a );
        else if ( j.op == "liveCutGeom" ) vsp::CutGeomToClipboard( j.a, static_cast<int>( j.value ) );
        else pasted = vsp::PasteGeomClipboard( j.a );
        DrainedErrors errors = TakeWriteErrors();
        Watch( "Geometry edit", true );
        if ( errors.had_errors ) return ParmWriteFailure( j.id, errors.message, "unknown", "null" );
        return Result( j.id, "", j.op == "livePasteGeom" ? LiveStringArray( pasted ) : "null" );
    }
    if ( j.op == "liveSetGeomName" )
    {
        // Same refusal as native for self-naming geometries; byte cap keeps the
        // request and the model's automatic naming bounded.
        if ( j.a.empty() ) return Result( j.id, "Invalid geometry ID", "" );
        if ( j.b.empty() || j.b.size() > 256 ) return Result( j.id, "Geometry name must be 1 to 256 bytes", "" );
        vsp::SetGeomName( j.a, j.b );
        string err = TakeErrors();
        Watch( "Rename", true );
        if ( !err.empty() ) return Result( j.id, err, "" );
        const string actual = vsp::GetGeomName( j.a );
        string read_err = TakeErrors();
        if ( !read_err.empty() ) return Result( j.id, read_err, "" );
        if ( actual != j.b ) return Result( j.id, "Readback differs after rename: " + actual, "" );
        return Result( j.id, "", "null" );
    }
    if ( j.op == "liveUpdate" )
    {
        vsp::Update();
        if ( vsp::ErrorMgrSingleton::getInstance().GetNumTotalErrors() )
            return Result( j.id, vsp::ErrorMgrSingleton::getInstance().PopLastError().GetErrorString(), "" );
        return Result( j.id, "", "null" );
    }
    if ( j.op == "geomTypes" )
    {
        if ( !j.guarded ) return Result( j.id, "", StrArray( vsp::GetGeomTypes() ) );
        // GetGeomTypes() calls ErrorMgr.NoError(). Copy directly from the vehicle
        // instead so this guarded query does not alter the API's error flag.
        Vehicle *veh = VehicleMgr.GetVehicle(); // validated by guarded preflight
        vector< string > types;
        const int count = veh->GetNumGeomTypes();
        for ( int i = 0; i < count; ++i ) types.push_back( veh->GetGeomType( i ).m_Name );
        return Result( j.id, "", StrArray( types ) );
    }
    if ( j.op == "bbox" )
    {
        string err;
        string box = BBoxJson( j.a == "all", j.guarded ? &err : nullptr );
        return Result( j.id, err, box );
    }
    if ( j.op == "mesh" )
    {
        vector< uint8_t > b = MeshBytes( j.a );
        {
            std::lock_guard< std::mutex > lock( g_Mutex );
            g_Binary[j.id] = std::move( b );
        }
        return Result( j.id, "", "", true );
    }
    if ( j.op == "guardedUpdate" )
    {
        // This operation is intentionally unavailable without the epoch and script guards.
        if ( !j.guarded ) return Result( j.id, "guardedUpdate requires a model guard", "" );
        if ( !BeginGuardedWrite() ) return;
        vsp::Update( true );
        DrainedErrors errors = TakeWriteErrors();
        Watch( "Update", true );
        if ( errors.had_errors ) return ParmWriteFailure( j.id, errors.message, "unknown", "null" );
        return Result( j.id, "", "null" );
    }
    if ( j.op == "guardedSetGeomName" )
    {
        if ( !j.guarded ) return Result( j.id, "guardedSetGeomName requires a model guard", "" );
        string err;
        if ( !CurrentModelGeom( j.a, err, nullptr, true ) ) return ParmWriteFailure( j.id, err, "not_written", "null" );
        Geom *geom = VehicleMgr.GetVehicle()->FindGeom( j.a );
        if ( !geom || geom->NameIsAutomatic() ) return ParmWriteFailure( j.id, "Geometry cannot be renamed", "not_written", "null" );
        if ( j.b.empty() || j.b.size() > 256 ) return ParmWriteFailure( j.id, "Geometry name must be 1 to 256 bytes", "not_written", "null" );
        if ( !BeginGuardedWrite() ) return;
        vsp::SetGeomName( j.a, j.b );
        DrainedErrors set_errors = TakeWriteErrors();
        string actual = vsp::GetGeomName( j.a );
        DrainedErrors verify_errors = TakeWriteErrors();
        Watch( "Rename geometry", true );
        if ( set_errors.had_errors || verify_errors.had_errors )
            return ParmWriteFailure( j.id, set_errors.had_errors ? set_errors.message : verify_errors.message, "unknown", "null" );
        if ( actual != j.b ) return ParmWriteFailure( j.id, "Readback differs from requested geometry name", "different", "null" );
        return Result( j.id, "", "null" );
    }
    if ( j.op == "guardedDeleteGeom" )
    {
        if ( !j.guarded ) return Result( j.id, "guardedDeleteGeom requires a model guard", "" );
        string err;
        if ( !CurrentModelGeom( j.a, err, nullptr, true ) ) return ParmWriteFailure( j.id, err, "not_written", "null" );
        if ( !BeginGuardedWrite() ) return;
        vsp::DeleteGeom( j.a, vsp::CLONE_DELETE_LEAVE_EMPTY );
        vsp::Update();
        DrainedErrors errors = TakeWriteErrors();
        Watch( "Delete geometry", true );
        if ( errors.had_errors ) return ParmWriteFailure( j.id, errors.message, "unknown", "null" );
        vector< string > remaining = vsp::FindGeoms();
        DrainedErrors read_errors = TakeWriteErrors();
        if ( read_errors.had_errors ) return ParmWriteFailure( j.id, read_errors.message, "unknown", "null" );
        if ( std::find( remaining.begin(), remaining.end(), j.a ) != remaining.end() ) return ParmWriteFailure( j.id, "Geometry remains after delete", "unknown", "null" );
        return Result( j.id, "", "{\"deleted\":true}" );
    }
    if ( j.op == "addGeom" )
    {
        // Match AddGeom's top-level parent sentinels, but reject stored clipboard
        // copies as parents. Leave the legacy bridge's semantics unchanged.
        Vehicle *veh = VehicleMgr.GetVehicle();
        if ( j.guarded && !j.b.empty() && j.b != "NONE" && j.b != veh->GetID() )
        {
            string err;
            if ( !CurrentModelGeom( j.b, err, nullptr, true ) ) return ParmWriteFailure( j.id, err, "not_written", "null" );
        }
        if ( !BeginGuardedWrite() ) return;
        string id = vsp::AddGeom( j.a, j.b );
        vsp::Update();
#ifdef WEBVSP_SCRIPT_GUARD_TEST
        InjectWriteError( "addUpdate" );
#endif
        DrainedErrors errors;
        string err;
        if ( j.guarded ) { errors = TakeWriteErrors(); err = errors.message; }
        else err = TakeErrors();
        Watch( "Add " + j.a, true );
        if ( j.guarded && ( errors.had_errors || id.empty() ) )
            return ParmWriteFailure( j.id, err.empty() ? "AddGeom returned an empty id" : err, "unknown", "null" );
        return Result( j.id, err, "{\"id\":" + Quote( id ) + "}" );
    }
    if ( j.op == "liveDeleteGeom" )
    {
        // Validate on the model thread too: callers can invoke the engine directly.
        if ( !std::isfinite( j.value ) || std::floor( j.value ) != j.value ||
             j.value < 0 || j.value >= vsp::CLONE_DELETE_NUM_TYPES )
            return ParmWriteFailure( j.id, "Invalid clone_delete", "not_written", "null" );
        string err;
        if ( !CurrentModelGeom( j.a, err, nullptr, true ) )
            return ParmWriteFailure( j.id, err, "not_written", "null" );
        if ( !BeginGuardedWrite() ) return;
        vsp::DeleteGeom( j.a, static_cast<int>( j.value ) );
        DrainedErrors errors = TakeWriteErrors();
        vsp::Update();
        DrainedErrors update_errors = TakeWriteErrors();
        Watch( "Delete", true );
        if ( errors.had_errors || update_errors.had_errors )
            return ParmWriteFailure( j.id, errors.had_errors ? errors.message : update_errors.message, "unknown", "null" );
        return Result( j.id, "", "null" );
    }
    if ( j.op == "deleteGeoms" )
    {
        vsp::DeleteGeomVec( SplitCsv( j.a ) );
        vsp::Update();
        string err = TakeErrors();
        Watch( "Delete", true );
        return Result( j.id, err, "{\"ok\":true}" );
    }
    if ( j.op == "geomSetParm" || j.op == "xsecSetParm" )
    {
        return ScopedParmWrite( j, j.op == "xsecSetParm" );
    }
    if ( j.op == "setParm" )
    {
        vsp::SetParmValUpdate( j.a, j.value );
        string err = TakeErrors();
        Watch( "Parameter change", true );
        return Result( j.id, err, "{\"ok\":true}" );
    }
    if ( j.op == "move" )
    {
        double delta[3];
        if ( j.guarded )
        {
            const char *p = j.b.c_str();
            const char *end = p + j.b.size();
            bool valid = std::none_of( j.b.begin(), j.b.end(), []( unsigned char c ) { return std::isspace( c ); } );
            for ( int i = 0; valid && i < 3; ++i )
            {
                char *next;
                errno = 0;
                delta[i] = strtod( p, &next );
                valid = next != p && errno != ERANGE && std::isfinite( delta[i] ) &&
                        ( i == 2 ? next == end : next < end && *next == ',' );
                if ( valid ) p = i == 2 ? next : next + 1;
            }
            if ( !valid )
            {
                PublishResult( "{\"t\":\"result\",\"id\":" + std::to_string( j.id ) +
                      ",\"ok\":false,\"error\":\"INVALID_ARGUMENT\",\"code\":\"INVALID_ARGUMENT\","
                      "\"outcome\":\"not_written\",\"actual\":null}" );
                return;
            }
        }
        else
        {
            vector< string > c = SplitCsv( j.b );
            delta[0] = c.size() > 0 ? atof( c[0].c_str() ) : 0;
            delta[1] = c.size() > 1 ? atof( c[1].c_str() ) : 0;
            delta[2] = c.size() > 2 ? atof( c[2].c_str() ) : 0;
        }
        vec3d d( delta[0], delta[1], delta[2] );
        vector< string > ids = SplitCsv( j.a );
        if ( j.guarded )
        {
            if ( j.a.empty() || j.a.front() == ',' || j.a.back() == ',' || j.a.find( ",," ) != string::npos )
                return ParmWriteFailure( j.id, "Move requires non-empty geom IDs", "not_written", "null" );
            string err;
            for ( const string &id : ids )
                if ( !CurrentModelGeom( id, err, nullptr, true ) ) return ParmWriteFailure( j.id, err, "not_written", "null" );
        }
        if ( !BeginGuardedWrite() ) return;
        vsp::MirrorMoveGeoms( ids, d );
#ifdef WEBVSP_SCRIPT_GUARD_TEST
        InjectWriteError( "move" );
#endif
        DrainedErrors errors;
        string err;
        if ( j.guarded ) { errors = TakeWriteErrors(); err = errors.message; }
        else err = TakeErrors();
        Watch( "Move", true );
        if ( j.guarded && errors.had_errors ) return ParmWriteFailure( j.id, err, "unknown", "null" );
        return Result( j.id, err, "{\"ok\":true}" );
    }
    if ( j.op == "duplicate" )
    {
        vector< string > copies = vsp::MirrorDuplicateGeoms( SplitCsv( j.a ) );
        // The copies become the selection, as in Blender.
        for ( size_t i = 0; i < copies.size(); i++ )
        {
            vsp::MirrorPickGeom( copies[i], i > 0 );
        }
        string err = TakeErrors();
        Watch( "Duplicate", true );
        return Result( j.id, err, "{\"ids\":" + StrArray( copies ) + "}" );
    }
    if ( j.op == "drawType" )
    {
        for ( const string &id : SplitCsv( j.a ) )
        {
            vsp::SetGeomDrawType( id, (int)j.value );
        }
        string err = TakeErrors();
        Watch( "Draw type", true );
        return Result( j.id, err, "{\"ok\":true}" );
    }
    if ( j.op == "rotate" )
    {
        vector< string > c = SplitCsv( j.b );
        vec3d axis( c.size() > 0 ? atof( c[0].c_str() ) : 0, c.size() > 1 ? atof( c[1].c_str() ) : 0,
                    c.size() > 2 ? atof( c[2].c_str() ) : 0 );
        vsp::MirrorRotateGeoms( SplitCsv( j.a ), axis, j.value );
        string err = TakeErrors();
        Watch( "Rotate", true );
        return Result( j.id, err, "{\"ok\":true}" );
    }
    if ( j.op == "origin" )
    {
        vec3d p = vsp::MirrorGeomOrigin( j.a );
        string err = TakeErrors();
        char buf[128];
        snprintf( buf, sizeof( buf ), "[%.17g,%.17g,%.17g]", p.x(), p.y(), p.z() );
        return Result( j.id, err, buf );
    }
    if ( j.op == "newModel" )
    {
        vsp::ClearVSPModel();
        string err = TakeErrors();
        if ( err.empty() )
        {
            vsp::Update();
            err = TakeErrors();
        }
        if ( !err.empty() )
        {
            // Clear or update may already have changed the model.
            g_Dirty = true;
            Watch( "New", true );
            return Result( j.id, err, "" );
        }
        g_Dirty = false;
        Watch( "New", true );
        g_Dirty = false;
        return Result( j.id, "", "{\"ok\":true}" );
    }
    if ( j.op == "syncProbeFile" )
    {
        // Fixed diagnostic only: never accept a user path or touch a linked/model file.
        const string prefix = "/tmp/webvsp-sync-probe-";
        const string suffix = ".txt";
        if ( j.a.size() != prefix.size() + 32 + suffix.size() || j.a.compare( 0, prefix.size(), prefix ) ||
             j.a.compare( j.a.size() - suffix.size(), suffix.size(), suffix ) ||
             !std::all_of( j.a.begin() + prefix.size(), j.a.end() - suffix.size(), []( char c ) { return ( c >= '0' && c <= '9' ) || ( c >= 'a' && c <= 'f' ); } ) )
            return Result( j.id, "Invalid diagnostic scratch path", "" );
        FILE *in = fopen( j.a.c_str(), "rb" );
        if ( !in ) return Result( j.id, "Diagnostic scratch file not found", "" );
        char buf[128];
        size_t count = fread( buf, 1, sizeof( buf ), in );
        const bool read_failed = ferror( in ) || !feof( in );
        fclose( in );
        if ( read_failed || string( buf, count ) != "python-to-openvsp\n" ) return Result( j.id, "Diagnostic input mismatch", "" );
        FILE *out = fopen( j.a.c_str(), "wb" );
        if ( !out ) return Result( j.id, "Diagnostic output open failed", "" );
        const string response = "openvsp-to-python\n";
        bool ok = fwrite( response.data(), 1, response.size(), out ) == response.size();
        if ( fclose( out ) != 0 ) ok = false;
        if ( !ok ) return Result( j.id, "Diagnostic output write failed", "" );
        return Result( j.id, "", "{\"matched\":true}" );
    }
    if ( j.op == "readFile" )
    {
        vsp::ClearVSPModel();
        string err = TakeErrors();
        if ( err.empty() )
        {
            vsp::ReadVSPFile( j.a );
            err = TakeErrors();
        }
        if ( err.empty() )
        {
            vsp::Update();
            err = TakeErrors();
        }
        if ( !err.empty() )
        {
            // The old model was cleared; a failed read is not rolled back.
            g_Dirty = true;
            Watch( "Open", true );
            return Result( j.id, err, "" );
        }
        Watch( "Open", true );
        g_Dirty = false;
        return Result( j.id, "", "{\"ok\":true}" );
    }
    if ( j.op == "writeFile" )
    {
        vsp::SetVSP3FileName( j.a );
        string err = TakeErrors();
        if ( !err.empty() ) return Result( j.id, err, "" );
        vsp::WriteVSPFile( j.a );
        err = TakeErrors();
        if ( !err.empty() ) return Result( j.id, err, "" );
        g_Dirty = false;
        Emit( "{\"type\":\"saved\",\"fileName\":" + Quote( j.a ) + "}" );
        return Result( j.id, "", "{\"path\":" + Quote( j.a ) + "}" );
    }
    if ( j.op == "setVspFileName" )
    {
        if ( j.a.empty() ) return Result( j.id, "Invalid file name", "" );
        vsp::SetVSP3FileName( j.a );
        string err = TakeErrors();
        Watch( "Rename model file", false );
        return Result( j.id, err, "null" );
    }
    if ( j.op == "getVspFileName" )
    {
        return Result( j.id, "", Quote( vsp::GetVSPFileName() ) );
    }
    if ( j.op == "importFile" )
    {
        // b = IMPORT_TYPE; parent geometry is not supported by this bridge.
        if ( j.a.empty() || j.b.empty() ) return Result( j.id, "Invalid import request", "" );
        int type = 0;
        try { type = std::stoi( j.b ); } catch ( ... ) { return Result( j.id, "Invalid import type", "" ); }
        const string id = vsp::ImportFile( j.a, type, "" );
        string err = TakeErrors();
        if ( err.empty() )
        {
            vsp::Update();
            err = TakeErrors();
        }
        Watch( "Import", true );
        return Result( j.id, err, Quote( id ) );
    }
    if ( j.op == "exportFile" )
    {
        // b = EXPORT_TYPE; value = set. Optional native arguments keep their defaults.
        if ( j.a.empty() || j.b.empty() ) return Result( j.id, "Invalid export request", "" );
        int type = 0;
        try { type = std::stoi( j.b ); } catch ( ... ) { return Result( j.id, "Invalid export type", "" ); }
        const int set = static_cast< int >( j.value );
        const string out = vsp::ExportFile( j.a, set, type );
        string err = TakeErrors();
        Watch( "Export", false );
        return Result( j.id, err, Quote( out ) );
    }
    if ( j.op == "snapshot" )
    {
        // Autosave: write a copy of the model to a path. WriteVSPFile renames the model (and its
        // export file names) to the path, so put the model's own name back afterwards. The unsaved
        // state is kept, and no "saved" event is sent.
        const string name = vsp::GetVSPFileName();
        const bool dirty = g_Dirty;
        vsp::WriteVSPFile( j.a );
        string err = TakeErrors();
        vsp::SetVSP3FileName( name );
        string restore_err = TakeErrors();
        g_Dirty = dirty;
        if ( !err.empty() ) return Result( j.id, err, "" );
        if ( !restore_err.empty() ) return Result( j.id, restore_err, "" );
        return Result( j.id, "", "{\"path\":" + Quote( j.a ) + ",\"name\":" + Quote( name ) + "}" );
    }
    if ( j.op == "restoreSnapshot" )
    {
        // Autosave restore: load the snapshot as an unsaved, unlinked model.
        vsp::ClearVSPModel();
        string err = TakeErrors();
        if ( err.empty() )
        {
            vsp::ReadVSPFile( j.a );
            err = TakeErrors();
        }
        if ( err.empty() )
        {
            // Browser file handles are not restored with the autosave. Never leave the old
            // virtual path as the Save target: it would silently write only to memory.
            vsp::SetVSP3FileName( "Unnamed.vsp3" );
            err = TakeErrors();
        }
        if ( err.empty() )
        {
            vsp::Update();
            err = TakeErrors();
        }
        g_Dirty = true;
        Watch( "Restore", true );
        if ( !err.empty() ) return Result( j.id, err, "" );
        return Result( j.id, "", "{\"ok\":true}" );
    }
    if ( j.op == "pick" )
    {
        vsp::MirrorPickGeom( j.a, j.b == "1" );
        return Result( j.id, TakeErrors(), "{\"ok\":true}" );
    }
    Result( j.id, "unknown request: " + j.op, "" );
}

// Keep the guard alive across preflight, mutation, readback and Watch. Publish only
// after the guard has been removed and its final attempted state has been checked.
void Run( const Job &j )
{
    if ( !j.guarded || !GuardedWrite( j.op ) )
    {
        // A nested legacy/read job must not stage its result in an outer write.
        GuardedWriteState *previous = g_GuardedWrite;
        struct RestoreState
        {
            GuardedWriteState *previous;
            explicit RestoreState( GuardedWriteState *p ) : previous( p ) {}
            ~RestoreState() { g_GuardedWrite = previous; }
        } restore( previous );
        g_GuardedWrite = nullptr;
        return RunImpl( j );
    }

#ifdef WEBVSP_SCRIPT_GUARD_TEST
    // Consume before any preflight, including stale-epoch and unsafe-context failures.
    struct RestoreWriteError
    {
        string point, mode;
        RestoreWriteError() : point( std::move( g_WriteErrorActive ) ), mode( std::move( g_WriteErrorActiveMode ) )
        {
            g_WriteErrorActive = std::move( g_WriteErrorArmed );
            g_WriteErrorActiveMode = std::move( g_WriteErrorMode );
            g_WriteErrorArmed.clear();
            g_WriteErrorMode.clear();
        }
        ~RestoreWriteError() { g_WriteErrorActive = std::move( point ); g_WriteErrorActiveMode = std::move( mode ); }
    } restore_write_error;
    string previous_injection = std::move( g_InjectionActive );
    g_InjectionActive = std::move( g_InjectionArmed );
    g_InjectionArmed.clear();
    struct RestoreInjection
    {
        string previous;
        explicit RestoreInjection( string p ) : previous( std::move( p ) ) {}
        ~RestoreInjection() { g_InjectionActive = std::move( previous ); }
    } restore_injection( std::move( previous_injection ) );
#endif
    string result;
    {
        GuardedWriteState state;
        struct ResetState
        {
            GuardedWriteState *previous;
            explicit ResetState( GuardedWriteState *p ) : previous( p ) {}
            ~ResetState() { g_GuardedWrite = previous; }
        } reset( g_GuardedWrite );
        g_GuardedWrite = &state;
        bool threw = false;
        try { RunImpl( j ); }
        catch ( ... )
        {
            // Once mutation begins, preserve the engine's fail-stop behavior.
            if ( state.started ) throw;
            threw = true;
        }

#ifdef WEBVSP_SCRIPT_GUARD_TEST
        TestWriteBarrier( 2 ); // guard still alive, before its final state is checked
#endif
        if ( state.guard.Attempted() )
            PublishResult( "{\"t\":\"result\",\"id\":" + std::to_string( j.id ) +
                ",\"ok\":false,\"error\":\"SCRIPT_REENTRY_BLOCKED\",\"code\":\"SCRIPT_REENTRY_BLOCKED\",\"outcome\":" +
                Quote( state.started ? "unknown" : "not_written" ) + ",\"actual\":null}" );
        else if ( threw )
            ParmWriteFailure( j.id, "Write operation threw an exception", state.started ? "unknown" : "not_written", "null" );
        else if ( state.result.empty() )
            ParmWriteFailure( j.id, "Write operation produced no result", state.started ? "unknown" : "not_written", "null" );
        result = std::move( state.result );
    }
    Emit( result );
}

#ifdef WEBVSP_SCRIPT_GUARD_TEST
#include "script_normal_gc_probe.inc"
#ifdef WEBVSP_PARM_REENTRY_TEST
#include "script_setter_gc_probe.inc"
#endif
#endif

bool g_Gui = false;

// Keep each turn bounded even when producers continuously enqueue work. The clock is
// sampled only between jobs: an individual OpenVSP operation must run to completion.
// BEGIN queue turn implementation (also exercised by tests/queue_turn_test.py)
template < typename Clock >
void DrainJobTurn()
{
    constexpr size_t max_jobs = 32;
    const auto deadline = Clock::now() + std::chrono::milliseconds( 8 );
    for ( size_t count = 0; count < max_jobs; ++count )
    {
        if ( count && Clock::now() >= deadline ) break;
        Job j;
        {
            std::lock_guard< std::mutex > lock( g_Mutex );
            if ( g_Jobs.empty() ) break;
            j = std::move( g_Jobs.front() );
            g_Jobs.pop_front();
        }
        Run( j );
    }
}
// END queue turn implementation

} // namespace

//==== Engine thread ====//

int main()
{
    vsp::VSPCheckSetup();
    // Errors are collected per request (TakeErrors) and returned to the page, not printed.
    vsp::ErrorMgrSingleton::getInstance().SilenceErrors();
    // VSPAERO's programs, compiled to WebAssembly, are run by the page (WebProcess.h):
    // OpenVSP only checks that they exist, so give it a folder with placeholders.
    mkdir( "/bin", 0755 );
    for ( const char *exe : { "/bin/vspaero", "/bin/vsploads", "/bin/vspviewer" } )
    {
        if ( FILE *f = fopen( exe, "w" ) )
        {
            fputs( "run by the web page\n", f );
            fclose( f );
        }
    }
    vsp::SetVSPAEROPath( "/bin" );
#ifdef VSP_WASM_GUI
    vsp::InitGUI();
    vsp::MirrorEnable();
    g_Gui = true;
#endif
    TakeErrors();
    g_TreeSig = TreeSignature();
    vector< string > changed, removed;
    RefreshFingerprints( changed, removed );
    Emit( "{\"type\":\"engine_ready\",\"gui\":" + string( g_Gui ? "true" : "false" ) + "}" );

    auto last_watch = std::chrono::steady_clock::now();
    while ( true )
    {
        // Requests first, then let the GUI process timers/events and produce its diff.
        // DrainJobTurn preserves FIFO, never abandons a queued job, and yields after a
        // small count/time budget so GUI/watch work cannot starve under a request flood.
        DrainJobTurn< std::chrono::steady_clock >();
        ExpireSyncResultsFixture();
        if ( g_Gui )
        {
            vsp::MirrorPump( 0.005 );
        }
        else
        {
            std::this_thread::sleep_for( std::chrono::milliseconds( 5 ) );
        }
        auto now = std::chrono::steady_clock::now();
        if ( now - last_watch > std::chrono::milliseconds( 150 ) )
        {
            last_watch = now;
            Watch();
        }
    }
    return 0;
}

//==== Called from the browser's main thread ====//

namespace
{

void Call( int id, const string &op, const string &a, const string &b, double value )
{
    std::lock_guard< std::mutex > lock( g_Mutex );
    g_Jobs.push_back( { id, op, a, b, value, false, "" } );
}

void CallGuarded( int id, const string &op, const string &a, const string &b, double value,
                  const string &expected_epoch )
{
    // The guard travels in the very same queued job as the operation, not a separate request.
    std::lock_guard< std::mutex > lock( g_Mutex );
    g_Jobs.push_back( { id, op, a, b, value, true, expected_epoch } );
}

void MirrorEvent( const string &json )
{
    vsp::MirrorPostEvent( json ); // thread-safe: queued for the engine thread
}

string Take()
{
    string out;
    {
        std::lock_guard< std::mutex > lock( g_Mutex );
        out = "{\"out\":[";
        for ( size_t i = 0; i < g_Out.size(); i++ )
        {
            out += ( i ? "," : "" ) + g_Out[i];
        }
        g_Out.clear();
    }
    out += "],\"mirror\":" + vsp::MirrorTakeOutput() + ",\"proc\":" + WebProcess::TakeRequests() + "}";
    return out;
}

// A program's output and exit, from the page (see WebProcess.h).
void ProcessOutput( int id, const string &text )
{
    WebProcess::Output( id, text );
}

void ProcessExit( int id, int code )
{
    WebProcess::Exit( id, code );
}

emscripten::val TakeBinary( int id )
{
    vector< uint8_t > b;
    {
        std::lock_guard< std::mutex > lock( g_Mutex );
        auto it = g_Binary.find( id );
        if ( it == g_Binary.end() )
        {
            return emscripten::val::null();
        }
        b = std::move( it->second );
        g_Binary.erase( it );
    }
    // Copied into an ordinary (non-shared) buffer owned by JS.
    return emscripten::val::global( "Uint8Array" ).new_( emscripten::typed_memory_view( b.size(), b.data() ) );
}

void RequestFull()
{
    vsp::MirrorRequestFull();
}

} // namespace

EMSCRIPTEN_BINDINGS( openvsp )
{
    emscripten::function( "call", &Call );
    emscripten::function( "callGuarded", &CallGuarded );
    emscripten::function( "mirrorEvent", &MirrorEvent );
    emscripten::function( "take", &Take );
    emscripten::function( "takeBinary", &TakeBinary );
    emscripten::function( "requestFull", &RequestFull );
    emscripten::function( "processOutput", &ProcessOutput );
    emscripten::function( "processExit", &ProcessExit );
#ifdef WEBVSP_SCRIPT_GUARD_TEST
    emscripten::function( "testBarrierArm", &TestBarrierArm );
    emscripten::function( "testBarrierState", &TestBarrierState );
    emscripten::function( "testBarrierRelease", &TestBarrierRelease );
#endif
}
