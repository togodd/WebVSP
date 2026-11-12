// Both test macros required. Runs synchronously on the engine owner pthread.
// A disposable fresh worker is mandatory; this never accepts a script or IDs.
struct SetterGcProbeState
{
    asIScriptEngine *engine;
    int hits = 0;
    int gc_rc = -999;
    bool guard_present = false;
    bool attempted_before = false;
    bool attempted_after = false;
};

void SetterGcProbeCallback( Parm *, void *opaque )
{
    SetterGcProbeState &state = *static_cast< SetterGcProbeState * >( opaque );
    ++state.hits;
    state.guard_present = g_GuardedWrite != nullptr;
    if ( state.guard_present ) state.attempted_before = g_GuardedWrite->guard.Attempted();
    state.gc_rc = state.engine->GarbageCollect( asGC_FULL_CYCLE );
    if ( state.guard_present ) state.attempted_after = g_GuardedWrite->guard.Attempted();
}

void ScriptSetterGcProbe( const Job &j )
{
    static bool used = false;
    if ( j.a != "disposable-empty-model" || !j.b.empty() || j.value != 0 || j.guarded || !j.expected_epoch.empty() )
        return Result( j.id, "Invalid fixed setter GC probe request", "" );
    if ( used ) return Result( j.id, "Requires a fresh disposable empty test module", "" );
    used = true;
    Vehicle *veh = VehicleMgr.GetVehicle();
    ScriptMgrSingleton &mgr = ScriptMgrSingleton::getInstance();
    asIScriptEngine *engine = mgr.GetTestScriptEngine();
    asUINT objects = 0;
    if ( engine ) engine->GetGCStatistics( &objects );
    if ( !veh || !veh->IsModelEpochValid() || !veh->GetGeomStoreVec().empty() ||
         !vsp::FindGeoms().empty() || !AdvLinkMgr.GetLinks().empty() || !engine ||
         asGetActiveContext() || objects != 0 )
        return Result( j.id, "Requires a fresh disposable empty test module", "" );

    struct Cleanup
    {
        asIScriptEngine *engine;
        ScriptMgrSingleton &mgr;
        asPWORD auto_gc;
        string module;
        ~Cleanup()
        {
            webvsp::ArmParmReentry( nullptr, nullptr, nullptr );
            engine->SetEngineProperty( asEP_AUTO_GARBAGE_COLLECT, 0 );
            engine->GarbageCollect( asGC_FULL_CYCLE );
            if ( !module.empty() ) mgr.RemoveScript( module );
            engine->SetEngineProperty( asEP_AUTO_GARBAGE_COLLECT, auto_gc );
        }
    } cleanup{ engine, mgr, engine->GetEngineProperty( asEP_AUTO_GARBAGE_COLLECT ), "" };
    if ( engine->SetEngineProperty( asEP_AUTO_GARBAGE_COLLECT, 0 ) < 0 ||
         engine->GetEngineProperty( asEP_AUTO_GARBAGE_COLLECT ) != 0 )
        return Result( j.id, "Could not disable automatic GC", "" );
    const string target = vsp::AddGeom( "FUSELAGE", "" );
    const string victim = vsp::AddGeom( "BLANK", "" );
    vsp::Update();
    const string parm_id = vsp::FindParm( target, "Length", "Design" );
    Parm *parm = ParmMgr.FindParm( parm_id );
    string setup_error = TakeErrors();
    if ( target.empty() || victim.empty() || target == victim || !veh->FindGeom( target ) ||
         !veh->FindGeom( victim ) || !parm || !setup_error.empty() )
        return Result( j.id, "Could not create independent fixed fixtures: " + setup_error, "" );
    const string source = "int destroyed = 0; class Cycle { Cycle@ self; "
        "~Cycle() { destroyed++; DeleteGeom(\"" + victim + "\"); } } "
        "int main() { Cycle@ c = Cycle(); @c.self = c; return 0; }";
    cleanup.module = mgr.ReadScriptFromMemory( "WebVSP_SetterGcProbe", source );
    if ( cleanup.module.empty() ) return Result( j.id, "Could not build GC fixture", "" );
    asIScriptModule *module = engine->GetModule( cleanup.module.c_str() );
    int index = module ? module->GetGlobalVarIndexByName( "destroyed" ) : -1;
    int *destroyed = index >= 0 ? static_cast< int * >( module->GetAddressOfGlobalVar( index ) ) : nullptr;
    if ( !destroyed ) return Result( j.id, "Could not inspect GC fixture", "" );
    int execute_rc = mgr.ExecuteScript( cleanup.module.c_str(), "int main()" );
    engine->GetGCStatistics( &objects );
    if ( execute_rc != 0 || *destroyed != 0 || objects == 0 || asGetActiveContext() ||
         !veh->FindGeom( victim ) || !AdvLinkMgr.GetLinks().empty() )
        return Result( j.id, "GC fixture preflight invalid", "" );

    SetterGcProbeState state{ engine };
    string captured;
    {
        struct CaptureAndArm
        {
            string *previous;
            CaptureAndArm( string *capture, Parm *target_parm, SetterGcProbeState *state ) : previous( g_GcProbeCapture )
            {
                g_GcProbeCapture = capture;
                webvsp::ArmParmReentry( target_parm, SetterGcProbeCallback, state );
            }
            ~CaptureAndArm()
            {
                webvsp::ArmParmReentry( nullptr, nullptr, nullptr );
                g_GcProbeCapture = previous;
            }
        } arm( &captured, parm, &state );
        Run( { -2147483000, "geomSetParm", target, parm_id, 12.0, true,
               std::to_string( veh->GetModelEpoch() ) } );
    }
    auto boolean = []( bool value ) { return value ? "true" : "false"; };
    const int after = *destroyed;
    const bool victim_alive = veh->FindGeom( victim ) != nullptr;
    const bool target_alive = veh->FindGeom( target ) != nullptr;
    string err = TakeErrors();
    string json = string( "{\"executeRc\":" ) + std::to_string( execute_rc ) +
        ",\"setterHits\":" + std::to_string( state.hits ) +
        ",\"gcRc\":" + ( state.hits ? std::to_string( state.gc_rc ) : "null" ) +
        ",\"destroyedBefore\":0,\"destroyedAfter\":" + std::to_string( after ) +
        ",\"guardPresent\":" + boolean( state.guard_present ) +
        ",\"attemptedBefore\":" + boolean( state.attempted_before ) +
        ",\"attemptedAfter\":" + boolean( state.attempted_after ) +
        ",\"victimAliveBefore\":true,\"victimAliveAfter\":" + boolean( victim_alive ) +
        ",\"targetAliveAfter\":" + boolean( target_alive ) +
        ",\"reply\":" + ( captured.empty() ? "null" : captured ) + ",\"errors\":" + Quote( err ) + "}";
    return Result( j.id, "", json );
}
