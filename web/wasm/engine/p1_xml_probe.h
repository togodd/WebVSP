// Measurement helpers for the P1 current-model projection spike.
//
// These are diagnostic only: they serialize the live model to memory (no file
// is written and no filename is changed) and report what that did to the model.
// Nothing here runs analyses or modifies geometry deliberately.
#ifndef WEBVSP_P1_XML_PROBE_H
#define WEBVSP_P1_XML_PROBE_H

#include <string>
#include <vector>

namespace p1probe
{

struct Metrics
{
    unsigned long updateCount = 0;
    int parmChanges = 0;
    bool parmDirty = false;
    bool geomMapDirty = false;
    std::string fileName;
    std::vector< std::string > active;
    int results = 0;
    int links = 0;
    int advLinks = 0;
    size_t parmLines = 0;
};

// Canonical, ID-free text of the geometry tree and its parameter values.
// IDs are deliberately excluded so the same text can be compared with a model
// rebuilt in another instance, where IDs are reassigned.
std::string Fingerprint();

// FNV-1a of Fingerprint(): equality across two instances, not a stable file format.
std::string FingerprintHash( const std::string &fingerprint );

// No-op counter and state snapshot.
Metrics TakeMetrics();

// Vehicle::EncodeXml into memory, as a .vsp3-shaped document. Fails closed when
// the result exceeds maxBytes or there is no vehicle.
std::string Serialize( std::string *err, size_t maxBytes );

// Runs Serialize once between two fingerprints and reports both the counters and
// the differences. Diagnostic; includeXml returns the document itself when it fits.
std::string Report( bool includeXml );

} // namespace p1probe

#endif
