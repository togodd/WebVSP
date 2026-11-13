#ifndef WEBVSP_ERROR_DRAIN_H
#define WEBVSP_ERROR_DRAIN_H

#include <string>

// Drain in occurrence order. Empty descriptions still represent distinct errors.
// On exception the stack may be partially drained; this does not reset manager flags.
struct DrainedErrors
{
    bool had_errors = false;
    std::string message;
};

template <typename ErrorManager>
DrainedErrors DrainErrors( ErrorManager &mgr, const char *empty_description )
{
    DrainedErrors result;
    while ( mgr.GetNumTotalErrors() )
    {
        std::string message = mgr.PopLastError().GetErrorString();
        if ( message.empty() ) message = empty_description;
        result.message = result.had_errors ? message + "; " + result.message : message;
        result.had_errors = true;
    }
    return result;
}

#endif
