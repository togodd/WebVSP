# Internal modeling API: design and implementation status

This document defines the scope and safety rules for WebVSP's browser-local modeling service. It is not an MCP server or a remote-control endpoint. OpenVSP running in the current tab remains the authoritative model; a service must not maintain a second geometric model.

## Delivery sequence

Each increment is committed separately, after its tests pass. Existing GUI behavior and uncommitted work must be preserved. Capabilities are exposed only when implemented and tested; proposed operations below are not promises of current support.

1. Establish typed contracts, explicit capabilities and errors, and an injectable engine adapter. Add fast contract tests.
2. Add read-only model, geometry, selection and bounds queries. Validate their behavior against the real browser engine and GUI updates.
3. Add selected basic writes only where results can be verified. Validate input and explicit parent identity; report before/after and unknown outcomes honestly. Exercise persistence and conflicts.
4. Investigate and, where safe, add parameter discovery, readback and controlled writes; then add narrowly scoped wing, fuselage and attachment operations. Operations with unverified semantics stay unavailable.
5. Run unit, integration and browser regression suites, document supported operations, and add a final verification record. MCP protocol, transport, remote access, AI and arbitrary file paths are out of scope.

## Contract principles

- Inputs and results must be serializable, versioned where externally useful, and independent of FLTK widget IDs or screen coordinates.
- Geom names are not unique identifiers. IDs are scoped to a live model and must not be assumed stable after reload, replacement, copy, or structural edits.
- Expose unavailable or unknown information as such. Native unit conventions are not inferred; report coordinate frames and model-native values explicitly.
- A completed request is not proof of the requested geometric effect. For writes, validate, execute, and read back actual state. If a timeout or interruption makes the result uncertain, do not claim failure or retry blindly.
- A parent-child tree relation does not imply translation or rotation attachment.
- Do not assert transactionality, rollback, or undo unless that specific operation has been verified. Multi-step partial execution must be reported.
- Model revision and dirty/undo fields in the current engine are bookkeeping, not established strong concurrency or persistence guarantees. Atomic revision checks require engine-side implementation and tests covering GUI changes; client-side checks alone cannot provide them.
- Browser sessions and model replacements need explicit identity. Do not conflate a page lifetime, a file name, and a model identity. If trustworthy replacement detection cannot be implemented, expose that limitation rather than inventing a guarantee.
- Schema and capability definitions must match the running implementation and tests. Never advertise a planned feature as supported.

## Current baseline

The existing `src/api/client.ts` provides model tree, geometry types, bounds, selection, origin, move, rotate and duplicate calls. `src/api/wasmEngine.ts` also routes add, delete and parameter writes. Those are implementation primitives, not yet a safe domain API. Engine requests and GUI events share an OpenVSP thread, but `engine.cpp` revision detection is based on polling and fingerprints, and the model response currently contains a placeholder undo state. A parameter write currently returns only a generic acknowledgement. These facts prohibit assuming atomic concurrency protection, complete undo, or validated readback.

## Acceptance

The first end-to-end scenario is to create a fuselage and explicitly parent a wing, move it, compare engine and GUI state, save, reopen and verify. Parent attachment is a distinct feature and is not implied by the tree. Parameter and domain operations need their own positive, invalid-input, stale-reference, GUI-interference and persistence tests. Any capability that cannot meet its stated contract remains unsupported and its specific blocker is documented.
