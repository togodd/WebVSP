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
//   model, geomTypes, bbox              JSON (bbox: the shown geoms', or a="all" every geom's)
//   mesh(a=geom id)                     binary "VSPM" mesh (format: web/frontend/src/api/mesh.ts)
//   addGeom(a=type, b=parent)           {"id":...}
//   deleteGeoms(a=comma-separated ids)
//   setParm(a=parm id, value)           legacy unscoped write
//   geomSetParm(a=geom id, b=parm id, value), xsecSetParm(a=xsec id, b=parm id, value)
//     Single scoped write, not a transaction. Success value: {actual}; failure: error,
//     outcome ("not_written", "different", or "unknown") and actual (null if unknown).
//   geomXSecs(a=geom id)                [{id, xsecs:[ids]}] in XSec surface/index order
//   geomParmIDs(a=geom id), xsecParmIDs(a=xsec id)   linkable parm IDs
//   geomParm(a=geom id, b=parm id), xsecParm(a=xsec id, b=parm id)   parm metadata
//     Metadata: {id,value,type,name,group,container,lowerLimit,upperLimit,active}.
//     Non-finite numbers are null; errors are failed results, never default values.
//     Scope is precisely GetGeomParmIDs / GetXSecParmIDs (including their nested containers),
//     not every parm in the model. XSecs must be reachable from a current geom's XSec surfaces.
//     Page-side routes are defined in wasmEngine.ts; this is not a remote API.
//   newModel, readFile(a=path), writeFile(a=path)   (paths in the in-memory file system)
//   pick(a=geom id, b="1" to toggle)    select as if picked in the 3D view (shift/ctrl-click)
//   origin(a=geom id)                   [x,y,z] of the geom's origin
//   move(a=ids, b="dx,dy,dz")           move geoms by an offset (one undo step)
//   duplicate(a=ids)                    copy geoms in place and select the copies; {ids}
//   drawType(a=ids, value=type)         geoms' draw type (GEOM_DRAW_WIRE=0 ... NONE=4)
//   rotate(a=ids, b="ax,ay,az", value=degrees)  rotate geoms about a world axis, each about its
//                                       own origin (one undo step)

#include "VSP_Geom_API.h"
#include "APIErrorMgr.h"
#include "AdvLinkMgr.h"
#include "DrawObj.h"
#include "MeshGeom.h"
#include "NGonMeshGeom.h"
#include "Vec3d.h"
#include "Vehicle.h"
#include "VehicleMgr.h"
#include "WebProcess.h"
#include <angelscript.h>
#include "ScriptMgr.h"

#include <sys/stat.h>

#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <algorithm>
#include <cerrno>
#include <cctype>
#include <cstdlib>
#include <chrono>
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

void Emit( const string &json )
{
    std::lock_guard< std::mutex > lock( g_Mutex );
    g_Out.push_back( json );
}

//==== Model ====//

string ModelJson()
{
    string geoms = "[";
    vector< string > ids = vsp::FindGeoms();
    for ( size_t i = 0; i < ids.size(); i++ )
    {
        const string &id = ids[i];
        string parent = vsp::GetGeomParent( id );
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
    TakeErrors();
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
string BBoxJson( bool all = false )
{
    double lo[3] = { INFINITY, INFINITY, INFINITY }, hi[3] = { -INFINITY, -INFINITY, -INFINITY };
    bool any = false;
    for ( const string &id : vsp::FindGeoms() )
    {
        if ( !all && !vsp::GetSetFlag( id, vsp::SET_SHOWN ) )
        {
            continue;
        }
        int nsurf = vsp::GetTotalNumSurfs( id );
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
    TakeErrors();
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
#endif

// Every ~150 ms, and right after each edit: report what the GUI or a request changed.
void Watch( const string &label = "", bool force = false )
{
#ifdef WEBVSP_SCRIPT_GUARD_TEST
    InjectGuardedWriteScript( "post" );
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
string g_InjectionArmed, g_InjectionActive, g_InjectionModule;

void InjectGuardedWriteScript( const char *phase )
{
    if ( g_GuardedWrite && g_InjectionActive == phase )
    {
        g_InjectionActive.clear();
        ScriptMgrSingleton::getInstance().ExecuteScript( g_InjectionModule.c_str(), "int main()" );
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

// Parameter owners must be reachable from the current model, not merely registered in
// the vehicle's geom store (which also contains clipboard copies).
bool CurrentModelGeom( const string &geom, string &err )
{
    vector< string > geoms = vsp::FindGeoms();
    if ( !( err = TakeErrors() ).empty() ) return false;
    if ( std::find( geoms.begin(), geoms.end(), geom ) == geoms.end() )
    {
        err = "Geom not found in the current model: " + geom;
        return false;
    }
    return true;
}

// Enumerate only live XSecs reachable through a geom; a globally registered XSec may be a
// clipboard or otherwise not part of the current model. Propagate errors even for empty lists.
bool GeomXSecs( const string &geom, string &json, bool &found, const string &wanted, string &err )
{
    vector< string > surfaces = vsp::GetXSecSurfIDVec( geom );
    if ( !( err = TakeErrors() ).empty() ) return false;
    json = "[";
    for ( size_t s = 0; s < surfaces.size(); ++s )
    {
        int count = vsp::GetNumXSec( surfaces[s] );
        if ( !( err = TakeErrors() ).empty() ) return false;
        vector< string > ids;
        for ( int i = 0; i < count; ++i )
        {
            string id = vsp::GetXSec( surfaces[s], i );
            if ( !( err = TakeErrors() ).empty() ) return false;
            ids.push_back( id );
            if ( !wanted.empty() && id == wanted ) found = true;
        }
        json += ( s ? "," : "" ) + string( "{\"id\":" ) + Quote( surfaces[s] ) +
                ",\"xsecs\":" + StrArray( ids ) + "}";
    }
    json += "]";
    return true;
}

bool ParmIDs( bool xsec, const string &owner, vector< string > &ids, string &err )
{
    if ( xsec )
    {
        vector< string > geoms = vsp::FindGeoms();
        if ( !( err = TakeErrors() ).empty() ) return false;
        bool found = false;
        for ( const string &geom : geoms )
        {
            string unused;
            if ( !GeomXSecs( geom, unused, found, owner, err ) ) return false;
            if ( found ) break;
        }
        if ( !found )
        {
            err = "XSec not found in the current model: " + owner;
            return false;
        }
        ids = vsp::GetXSecParmIDs( owner );
    }
    else
    {
        if ( !CurrentModelGeom( owner, err ) ) return false;
        ids = vsp::GetGeomParmIDs( owner );
    }
    err = TakeErrors();
    return err.empty();
}

// Error stack entries persist across successful API calls, so inspect it before accepting any
// of the API's fallback values. Num renders NaN/infinity as JSON null, including for limits.
bool ParmMetadata( const string &id, string &json, string &err )
{
    double value = vsp::GetParmVal( id );
    int type = vsp::GetParmType( id );
    string name = vsp::GetParmName( id );
    string group = vsp::GetParmGroupName( id );
    string container = vsp::GetParmContainer( id );
    double lower = vsp::GetParmLowerLimit( id );
    double upper = vsp::GetParmUpperLimit( id );
    bool active = vsp::GetParmActiveFlag( id );
    if ( !( err = TakeErrors() ).empty() ) return false;
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
bool FuselageLength( const string &geom, string &json, string &err )
{
    vector< string > ids;
    if ( !ParmIDs( false, geom, ids, err ) ) return false;
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
        if ( !( err = TakeErrors() ).empty() ) return false;
        if ( name == "Length" && group == "Design" && container == geom ) matches.push_back( id );
    }
    if ( matches.size() != 1 )
    {
        err = "Fuselage Design/Length parameter is missing or ambiguous";
        return false;
    }
    return ParmMetadata( matches[0], json, err );
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
    if ( !ParmIDs( xsec, j.a, ids, err ) )
        return ParmWriteFailure( j.id, err, "not_written", "null" );
    if ( std::find( ids.begin(), ids.end(), j.b ) == ids.end() )
        return ParmWriteFailure( j.id, "Parm is not linkable for the requested owner: " + j.b, "not_written", "null" );

    double old = vsp::GetParmVal( j.b );
    int type = vsp::GetParmType( j.b );
    double lower = vsp::GetParmLowerLimit( j.b );
    double upper = vsp::GetParmUpperLimit( j.b );
    bool active = vsp::GetParmActiveFlag( j.b );
    if ( !( err = TakeErrors() ).empty() )
        return ParmWriteFailure( j.id, "Cannot read parm metadata: " + err, "not_written", "null" );
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
    string set_error = TakeErrors();
    double actual = vsp::GetParmVal( j.b );
    string read_error = TakeErrors();
    Watch( "Parameter change", true );
    if ( !set_error.empty() || !read_error.empty() || !std::isfinite( actual ) )
    {
        string message = set_error.empty() ? "" : "SetParmValUpdate failed: " + set_error;
        if ( !read_error.empty() ) message += ( message.empty() ? "" : "; " ) + string( "Readback failed: " ) + read_error;
        else if ( !std::isfinite( actual ) ) message += ( message.empty() ? "" : "; " ) + string( "Readback is non-finite" );
        return ParmWriteFailure( j.id, message, "unknown", read_error.empty() ? Num( actual ) : "null" );
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
    return op == "model" || op == "bbox" || op == "origin" || op == "move" ||
           op == "addGeom" || op == "geomXSecs" || op == "geomParmIDs" ||
           op == "xsecParmIDs" || op == "geomParm" || op == "xsecParm" ||
           op == "fuselageLength" || op == "geomSetParm" || op == "xsecSetParm";
}

bool GuardedWrite( const string &op )
{
    return op == "move" || op == "addGeom" || op == "geomSetParm" || op == "xsecSetParm";
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

// This is only an initial preflight, not a complete safety guarantee or a script
// execution barrier. Other reentrant paths and side effects still require review.
bool SafeWriteContext( Vehicle *veh, const Job &j )
{
    if ( asGetActiveContext() || !AdvLinkMgr.GetLinks().empty() ) return false;
    // The store includes detached/clipboard geoms, not just FindGeoms' model tree.
    for ( Geom *geom : veh->GetGeomStoreVec() )
        if ( !geom || !KnownNonCustomGeomType( geom->GetType().m_Type ) ) return false;

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
    TakeErrors();
#ifdef WEBVSP_SCRIPT_GUARD_TEST
    if ( j.op == "guardedWriteInjection" )
    {
        if ( j.a == "clear" )
        {
            g_InjectionArmed.clear();
            return Result( j.id, "", "{\"ok\":true}" );
        }
        if ( j.a != "pre" && j.a != "post" && j.a != "watch" )
            return Result( j.id, "Invalid injection phase", "" );
        if ( g_InjectionModule.empty() )
            g_InjectionModule = ScriptMgrSingleton::getInstance().ReadScriptFromMemory(
                "WebVSP_GuardedWriteInjection", "int main() { AddGeom(\"BLANK\"); return 0; }" );
        if ( g_InjectionModule.empty() ) return Result( j.id, "Could not compile injection script", "" );
        g_InjectionArmed = j.a;
        return Result( j.id, "", "{\"ok\":true}" );
    }
    if ( j.op == "scriptPreflightFixture" ) return ScriptPreflightFixture( j );
    if ( j.op == "scriptGuardCheck" ) return ScriptGuardCheck( j.id );
    if ( j.op == "scriptGcGuardCheck" ) return ScriptGcGuardCheck( j.id );
    if ( j.op == "advLinkGuardCheck" ) return AdvLinkGuardCheck( j.id );
#endif
    if ( j.op == "model" )
    {
        string m = ModelJson();
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
        FuselageLength( j.a, json, err );
        return Result( j.id, err, json );
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
    if ( j.op == "geomXSecs" )
    {
        string json, err;
        if ( !CurrentModelGeom( j.a, err ) ) return Result( j.id, err, "" );
        bool found = false;
        GeomXSecs( j.a, json, found, "", err );
        return Result( j.id, err, json );
    }
    if ( j.op == "geomParmIDs" || j.op == "xsecParmIDs" ||
         j.op == "geomParm" || j.op == "xsecParm" )
    {
        bool xsec = j.op == "xsecParmIDs" || j.op == "xsecParm";
        bool list = j.op == "geomParmIDs" || j.op == "xsecParmIDs";
        vector< string > ids;
        string err, json;
        if ( !ParmIDs( xsec, j.a, ids, err ) ) return Result( j.id, err, "" );
        if ( list ) return Result( j.id, "", StrArray( ids ) );
        if ( std::find( ids.begin(), ids.end(), j.b ) == ids.end() )
            return Result( j.id, "Parm is not linkable for the requested owner: " + j.b, "" );
        if ( !ParmMetadata( j.b, json, err ) ) return Result( j.id, err, "" );
        return Result( j.id, "", json );
    }
    if ( j.op == "geomTypes" )
    {
        return Result( j.id, "", StrArray( vsp::GetGeomTypes() ) );
    }
    if ( j.op == "bbox" )
    {
        return Result( j.id, "", BBoxJson( j.a == "all" ) );
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
    if ( j.op == "addGeom" )
    {
        if ( !BeginGuardedWrite() ) return;
        string id = vsp::AddGeom( j.a, j.b );
        vsp::Update();
        string err = TakeErrors();
        Watch( "Add " + j.a, true );
        if ( j.guarded && ( !err.empty() || id.empty() ) )
            return ParmWriteFailure( j.id, err.empty() ? "AddGeom returned an empty id" : err, "unknown", "null" );
        return Result( j.id, err, "{\"id\":" + Quote( id ) + "}" );
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
        if ( !BeginGuardedWrite() ) return;
        vsp::MirrorMoveGeoms( ids, d );
        string err = TakeErrors();
        Watch( "Move", true );
        if ( j.guarded && !err.empty() ) return ParmWriteFailure( j.id, err, "unknown", "null" );
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

bool g_Gui = false;

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
        while ( true )
        {
            Job j;
            {
                std::lock_guard< std::mutex > lock( g_Mutex );
                if ( g_Jobs.empty() )
                {
                    break;
                }
                j = std::move( g_Jobs.front() );
                g_Jobs.pop_front();
            }
            Run( j );
        }
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
}
