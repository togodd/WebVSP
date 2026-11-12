#include "Parm.h"
#include "ParmContainer.h"
#include "ParmReentryTest.h"

#include <cstdlib>
#include <iostream>
#include <stdexcept>

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

struct Container : ParmContainer
{
    int notifications = 0;
    void ParmChanged( Parm*, int ) override { ++notifications; }
};

struct State
{
    Container* container;
    int calls = 0;
    double observed = 0;
    int notifications_at_hook = -1;
    bool recurse = false;
};

void callback( Parm* parm, void* context )
{
    State& state = *static_cast<State*>( context );
    ++state.calls;
    state.observed = parm->Get();
    state.notifications_at_hook = state.container->notifications;
    if ( state.recurse )
    {
        parm->SetFromDevice( 3 );
    }
}

void throwing_callback( Parm*, void* context )
{
    ++*static_cast<int*>( context );
    throw std::runtime_error( "hook exception" );
}
}

int main()
{
    Container container;
    Parm target, other;
    target.Init( "target", "test", &container, 0, 0, 10 );
    other.Init( "other", "test", &container, 0, 0, 10 );
    container.notifications = 0;
    State state{ &container };

    webvsp::ArmParmReentry( &target, callback, &state );
    other.SetFromDevice( 1 );
    target.SetFromDevice( 0 ); // No change: leave the arm intact.
    check( state.calls == 0, "other target and unchanged value do not fire" );
    const int before = container.notifications;
    target.SetFromDevice( 20 );
    check( state.calls == 1 && state.observed == 10, "hook observes clamped value" );
    check( state.notifications_at_hook == before, "hook precedes container notification" );
    target.SetFromDevice( 9 );
    check( state.calls == 1, "arm fires only once" );

    state.recurse = true;
    webvsp::ArmParmReentry( &target, callback, &state );
    target.SetFromDevice( 4 );
    check( state.calls == 2 && target.Get() == 3, "arm is cleared before recursive setter" );
    state.recurse = false;
    webvsp::ArmParmReentry( &target, callback, &state );
    webvsp::ArmParmReentry( nullptr, nullptr, nullptr );
    target.SetFromDevice( 5 );
    check( state.calls == 2, "explicit clear cancels the arm" );
    webvsp::ArmParmReentry( &target, callback, &state );
    webvsp::ArmParmReentry( &other, callback, &state );
    target.SetFromDevice( 6 );
    check( state.calls == 2, "new arm replaces previous target" );
    other.SetFromDevice( 2 );
    check( state.calls == 3, "replacement target fires" );

    // SetValCheckLimits compares the requested value before clamping: an exact
    // no-op preserves the arm, but a different request clamped to the current
    // limit still reaches the hook.
    target.SetFromDevice( 10 );
    const int before_noop_notifications = container.notifications;
    webvsp::ArmParmReentry( &target, callback, &state );
    target.SetFromDevice( 10 );
    check( state.calls == 3 && container.notifications == before_noop_notifications,
           "exact no-op neither fires nor notifies" );
    target.SetFromDevice( 20 );
    check( state.calls == 4 && state.observed == 10,
           "different request clamped to current limit fires" );

    // Either null argument cancels; the surviving argument must not be retained.
    webvsp::ArmParmReentry( &target, callback, &state );
    webvsp::ArmParmReentry( &target, nullptr, &state );
    target.SetFromDevice( 8 );
    check( state.calls == 4, "null callback cancels the arm" );
    webvsp::ArmParmReentry( &target, callback, &state );
    webvsp::ArmParmReentry( nullptr, callback, &state );
    target.SetFromDevice( 7 );
    check( state.calls == 4, "null target cancels the arm" );

    // The hook disarms before invocation, including when it exits by exception.
    // Do not infer undo behavior from this interrupted setter.
    int throws = 0;
    webvsp::ArmParmReentry( &target, throwing_callback, &throws );
    bool caught = false;
    try
    {
        target.SetFromDevice( 6 );
    }
    catch ( const std::runtime_error& )
    {
        caught = true;
    }
    check( caught && throws == 1, "hook exception propagates once" );
    target.SetFromDevice( 5 );
    check( throws == 1, "throwing hook remains disarmed on next change" );
    std::cout << "parm reentry tests passed\n";
}
