// Included only by a WEBVSP_SCRIPT_GUARD_TEST engine, after Run is defined.
// One owner-thread job, fixed fixtures only; never use with a user model.
void ScriptNormalGcProbe( const Job &j )
{
    static bool used = false;
    const bool positive = j.op == "scriptNormalGcPositive";
    const bool auto_on = j.op == "scriptNormalGcAutoOn";
    if ( ( !positive && !auto_on && j.op != "scriptNormalGcAutoOff" ) ||
         !j.a.empty() || !j.b.empty() || j.value != 0 || j.guarded )
        return Result( j.id, "Invalid fixed GC probe request", "" );

    Vehicle *veh = VehicleMgr.GetVehicle();
    ScriptMgrSingleton &mgr = ScriptMgrSingleton::getInstance();
    asIScriptEngine *engine = mgr.GetTestScriptEngine();
    asUINT initial_objects = 0;
    if ( engine ) engine->GetGCStatistics( &initial_objects );
    if ( used || !veh || !veh->IsModelEpochValid() || !veh->GetGeomStoreVec().empty() ||
         !vsp::FindGeoms().empty() || !AdvLinkMgr.GetLinks().empty() || !engine ||
         asGetActiveContext() || initial_objects != 0 )
        return Result( j.id, "Requires a fresh disposable empty test module", "" );
    used = true;
    struct Cleanup
    {
        asIScriptEngine *engine;
        ScriptMgrSingleton &mgr;
        asPWORD original;
        string module;
        ~Cleanup()
        {
            engine->SetEngineProperty( asEP_AUTO_GARBAGE_COLLECT, 0 );
            engine->GarbageCollect( asGC_FULL_CYCLE );
            if ( !module.empty() ) mgr.RemoveScript( module );
            engine->SetEngineProperty( asEP_AUTO_GARBAGE_COLLECT, original );
        }
    } cleanup{ engine, mgr, engine->GetEngineProperty( asEP_AUTO_GARBAGE_COLLECT ), "" };

    if ( engine->SetEngineProperty( asEP_AUTO_GARBAGE_COLLECT, 0 ) < 0 ||
         engine->GetEngineProperty( asEP_AUTO_GARBAGE_COLLECT ) != 0 )
        return Result( j.id, "Could not disable automatic GC for fixture", "" );
    const string source = "int destroyed = 0; class Cycle { Cycle@ self; "
        "~Cycle() { destroyed++; } } int main() { Cycle@ c = Cycle(); @c.self = c; return 0; }";
    cleanup.module = mgr.ReadScriptFromMemory( "WebVSP_NormalGcProbe", source );
    if ( cleanup.module.empty() ) return Result( j.id, "Could not build GC fixture", "" );
    asIScriptModule *module = engine->GetModule( cleanup.module.c_str() );
    int index = module ? module->GetGlobalVarIndexByName( "destroyed" ) : -1;
    int *destroyed = index >= 0 ? static_cast< int * >( module->GetAddressOfGlobalVar( index ) ) : nullptr;
    if ( !destroyed ) return Result( j.id, "Could not inspect GC fixture", "" );
    int execute_rc = mgr.ExecuteScript( cleanup.module.c_str(), "int main()" );
    if ( execute_rc != 0 || *destroyed != 0 || asGetActiveContext() ||
         !AdvLinkMgr.GetLinks().empty() || !veh->GetGeomStoreVec().empty() || !vsp::FindGeoms().empty() )
        return Result( j.id, "GC fixture or preflight invalid", "" );
    const asPWORD desired = auto_on ? 1 : 0;
    if ( engine->SetEngineProperty( asEP_AUTO_GARBAGE_COLLECT, desired ) < 0 ||
         engine->GetEngineProperty( asEP_AUTO_GARBAGE_COLLECT ) != desired )
        return Result( j.id, "Could not set requested automatic GC", "" );

    auto stats = [engine]() {
        asUINT current = 0, destroyed_count = 0, detected = 0, newer = 0, new_destroyed = 0;
        engine->GetGCStatistics( &current, &destroyed_count, &detected, &newer, &new_destroyed );
        return string( "{\"current\":" ) + std::to_string( current ) +
            ",\"destroyed\":" + std::to_string( destroyed_count ) +
            ",\"detected\":" + std::to_string( detected ) +
            ",\"newObjects\":" + std::to_string( newer ) +
            ",\"newDestroyed\":" + std::to_string( new_destroyed ) + "}";
    };
    asUINT before_objects = 0;
    engine->GetGCStatistics( &before_objects );
    int before = *destroyed;
    string before_stats = stats();
    if ( before != 0 || before_objects == 0 )
        return Result( j.id, "Fixture was collected or absent before operation", "" );
    string operation_result = "null";
    int gc_rc = 0;
    if ( positive )
        gc_rc = engine->GarbageCollect( asGC_FULL_CYCLE );
    else
    {
        // Capture only the internal result, never another job or Watch event. Run,
        // rather than RunImpl, exercises the actual guard and preflight.
        string captured;
        struct Capture
        {
            explicit Capture( string *p ) { g_GcProbeCapture = p; }
            ~Capture() { g_GcProbeCapture = nullptr; }
        } capture( &captured );
        Job inner{ -2147483000, "addGeom", "FUSELAGE", "", 0, true,
                   std::to_string( veh->GetModelEpoch() ) };
        Run( inner );
        if ( captured.empty() ) return Result( j.id, "Guarded operation produced no captured result", "" );
        operation_result = captured;
    }
    int after = *destroyed;
    string after_stats = stats();
    string err = TakeErrors();
    string json = string( "{\"scenario\":" ) + Quote( j.op ) +
        ",\"executeRc\":" + std::to_string( execute_rc ) +
        ",\"autoGc\":" + std::to_string( engine->GetEngineProperty( asEP_AUTO_GARBAGE_COLLECT ) ) +
        ",\"destroyedBefore\":" + std::to_string( before ) +
        ",\"destroyedAfter\":" + std::to_string( after ) +
        ",\"gcBefore\":" + before_stats + ",\"gcAfter\":" + after_stats +
        ",\"gcRc\":" + ( positive ? std::to_string( gc_rc ) : "null" ) +
        ",\"operation\":" + operation_result + ",\"errors\":" + Quote( err ) + "}";
    return Result( j.id, "", json );
}
