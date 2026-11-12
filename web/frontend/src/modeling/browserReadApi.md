# Browser modeling read API v1

The page installs `window.__webvspModelingReadV1` synchronously at startup. Registration makes no engine request. Each explicit call creates a fresh browser modeling service, forwards its arguments, and closes the service when the call settles. All methods return promises, including `capabilities()`.

`capabilities()` describes the frontend facade, not the current engine's readiness or version: a feature marked supported can still fail against an older or unavailable engine. `protocol()` and `declaredCapabilities()` describe engine-declared operations, not verified availability, safety, or authorization.

Available methods: `model.getInfo`, `model.getSelection`, `model.getVisibleSurfaceBounds`; `geometry.list`, `geometry.listTypes`, `geometry.get`; `parameter.listSurfaces`, `parameter.getFuselageLength`, `parameter.listGeometryParameterIds`, `parameter.listCrossSectionParameterIds`, `parameter.getGeometryParameter`, `parameter.getCrossSectionParameter`; `wing.get`, `fuselage.get`; `capabilities`, `protocol`, and `declaredCapabilities`. Obtain an identity from `model.getInfo()` and pass it to methods requiring one; signatures and result types follow the modeling service.

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

The scoped calls take the identity as their final argument: `model.getSelection(token)`, `model.getVisibleSurfaceBounds(token)`, `geometry.list(token)`, `geometry.listTypes(token)`, `geometry.get(geometryId, token)`, `parameter.listSurfaces(geometryId, token)`, `parameter.getFuselageLength(geometryId, token)`, `parameter.listGeometryParameterIds(geometryId, token)`, `parameter.listCrossSectionParameterIds(xsecId, token)`, `parameter.getGeometryParameter(geometryId, parmId, token)`, `parameter.getCrossSectionParameter(xsecId, parmId, token)`, `wing.get(geometryId, token)`, and `fuselage.get(geometryId, token)`. `model.getInfo()` obtains an identity; `model.getInfo(token)` checks an existing one. On `STALE_MODEL`, discard old IDs and discover the model again; do not automatically retry an operation using stale IDs. The epoch is not an object-generation identifier: after deletion or structural edits, discard affected IDs and rediscover even if the epoch is unchanged. In particular, an Insert can reuse a deleted geometry's ID, making an old ID refer to a different object.

This convenience whitelist is **not a security boundary or authentication mechanism**. Page scripts, including same-origin code able to access this window, may read sensitive model data. The existing `window.__webvspEngine.request` raw interface also permits writes. A read can trigger engine work and side effects; it is not guaranteed to be observationally pure. Multiple requests are not an atomic snapshot and can observe intervening edits. Identity/epoch guards detect model replacement at engine jobs, not all concurrent edits or reentrancy; they do not establish a stable snapshot. Calls pending indefinitely are not automatically cancelled by this wrapper: cleanup occurs only when they settle. No writes or general operation dispatcher are exposed by this particular interface.
