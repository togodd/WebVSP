# Browser modeling read API v1

The page installs `window.__webvspModelingReadV1` synchronously at startup. Registration makes no engine request. Except for `describeSurface()`, each call creates a fresh browser modeling service, forwards its arguments, and closes the service when the call settles. All methods return promises, including `describeSurface()` and `capabilities()`.

`await api.describeSurface()` returns a fresh static description of this particular wrapper: `version: 1`, `methods` (method names grouped by `root`, `model`, `geometry`, `parameter`, `wing`, and `fuselage`), and `limitations`. The latter reports `writesExposed`, `generalDispatcherExposed`, `engineAvailabilityVerified`, `atomicSnapshot`, `readsGuaranteedSideEffectFree`, and `securityBoundary` as `false`. These describe this surface, not all other interfaces in the page. The description does not create a service or query the engine; listed methods can still fail. Mutating a returned description does not change the API or later descriptions.

For compatibility, `capabilities()` remains the underlying modeling service's feature-category description, **not** a list of methods exposed by this read wrapper: it may report write features as supported even though this wrapper exposes no write methods. It is not a probe of the current engine's readiness or version. `protocol()` and `declaredCapabilities()` describe engine-declared operations, not verified availability, safety, or authorization. Use `describeSurface()` to discover this wrapper's callable methods, not those other three APIs.

Available methods: `model.getInfo`, `model.getSelection`, `model.getVisibleSurfaceBounds`; `geometry.list`, `geometry.listTypes`, `geometry.get`; `parameter.listSurfaces`, `parameter.getFuselageLength`, `parameter.listGeometryParameterIds`, `parameter.listCrossSectionParameterIds`, `parameter.getGeometryParameter`, `parameter.getCrossSectionParameter`; `wing.get`, `wing.getSectionDimensions`, `fuselage.get`; `describeSurface`, `capabilities`, `protocol`, and `declaredCapabilities`. Obtain an identity from `model.getInfo()` and pass it to methods requiring one; signatures and result types follow the modeling service.

`geometry.listTypes(identity)` returns the engine's available geometry type names as a `string[]`, not the types of geometries currently in the model. It requires a current identity like other scoped reads; engine availability and errors follow the underlying service.

Example (run only in a trusted same-origin page):

```js
const api = window.__webvspModelingReadV1
const model = await api.model.getInfo()
const token = model.identity
const geometries = await api.geometry.list(token)
const geometryTypes = await api.geometry.listTypes(token)
// Geometry IDs come from the returned model/list, not from names.
if (model.geometries.length) {
  const geometry = await api.geometry.get(model.geometries[0].id, token)
  console.log(geometry)
}
console.log(geometries, geometryTypes)
```

The scoped calls take the identity as their final argument: `model.getSelection(token)`, `model.getVisibleSurfaceBounds(token)`, `geometry.list(token)`, `geometry.listTypes(token)`, `geometry.get(geometryId, token)`, `parameter.listSurfaces(geometryId, token)`, `parameter.getFuselageLength(geometryId, token)`, `parameter.listGeometryParameterIds(geometryId, token)`, `parameter.listCrossSectionParameterIds(xsecId, token)`, `parameter.getGeometryParameter(geometryId, parmId, token)`, `parameter.getCrossSectionParameter(xsecId, parmId, token)`, `wing.get(geometryId, token)`, `wing.getSectionDimensions(geometryId, sectionId, token)`, and `fuselage.get(geometryId, token)`. `model.getInfo()` obtains an identity; `model.getInfo(token)` checks an existing one. On `STALE_MODEL`, discard old IDs and discover the model again; do not automatically retry an operation using stale IDs. The epoch is not an object-generation identifier: after deletion or structural edits, discard affected IDs and rediscover even if the epoch is unchanged. In particular, an Insert can reuse a deleted geometry's ID, making an old ID refer to a different object.

`wing.getSectionDimensions` reads native section span, root chord and tip chord in model-native length units; `sectionId` is the outboard XSec ID of a non-root station from `wing.get`. These are sequential guarded reads, not a snapshot: topology and parameter ownership can change between them, and epoch does not prevent ID reuse. It does not report driver state or establish editability. The caller must coordinate GUI and other model mutations.

This convenience whitelist is **not a security boundary or authentication mechanism**. Page scripts, including same-origin code able to access this window, may read sensitive model data. The existing `window.__webvspEngine.request` raw interface also permits writes. A read can trigger engine work and side effects; it is not guaranteed to be observationally pure. Multiple requests are not an atomic snapshot and can observe intervening edits. Identity/epoch guards detect model replacement at engine jobs, not all concurrent edits or reentrancy; they do not establish a stable snapshot. Calls pending indefinitely are not automatically cancelled by this wrapper: cleanup occurs only when they settle. No writes or general operation dispatcher are exposed by this particular interface.
