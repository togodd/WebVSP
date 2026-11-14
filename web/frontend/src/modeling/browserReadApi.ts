import { createBrowserModelingService } from './index'

/** A convenience interface, not an authorization or security boundary. */
export function createBrowserReadApi(factory: typeof createBrowserModelingService = createBrowserModelingService) {
  async function run<T>(read: (service: ReturnType<typeof createBrowserModelingService>) => T | Promise<T>): Promise<Awaited<T>> {
    const service = factory()
    try { return await read(service) } finally { service.close() }
  }
  return {
    /** Static description of this wrapper, not a probe of the service or engine. */
    async describeSurface() {
      return {
        version: 1 as const,
        methods: {
          root: ['describeSurface', 'capabilities', 'protocol', 'declaredCapabilities'],
          model: ['getInfo', 'getSelection', 'getVisibleSurfaceBounds'],
          geometry: ['list', 'listTypes', 'get'],
          parameter: ['listSurfaces', 'getFuselageLength', 'listGeometryParameterIds', 'listCrossSectionParameterIds', 'getGeometryParameter', 'getCrossSectionParameter'],
          wing: ['get', 'getSectionDimensions'],
          fuselage: ['get'],
        },
        limitations: {
          writesExposed: false,
          generalDispatcherExposed: false,
          engineAvailabilityVerified: false,
          atomicSnapshot: false,
          readsGuaranteedSideEffectFree: false,
          securityBoundary: false,
        },
      }
    },
    capabilities: () => run(s => s.capabilities()),
    protocol: () => run(s => s.protocol()),
    declaredCapabilities: () => run(s => s.declaredCapabilities()),
    model: {
      getInfo: (...args: Parameters<ReturnType<typeof createBrowserModelingService>['model']['getInfo']>) => run(s => s.model.getInfo(...args)),
      getSelection: (...args: Parameters<ReturnType<typeof createBrowserModelingService>['model']['getSelection']>) => run(s => s.model.getSelection(...args)),
      getVisibleSurfaceBounds: (...args: Parameters<ReturnType<typeof createBrowserModelingService>['model']['getVisibleSurfaceBounds']>) => run(s => s.model.getVisibleSurfaceBounds(...args)),
    },
    geometry: {
      list: (...args: Parameters<ReturnType<typeof createBrowserModelingService>['geometry']['list']>) => run(s => s.geometry.list(...args)),
      listTypes: (...args: Parameters<ReturnType<typeof createBrowserModelingService>['geometry']['listTypes']>) => run(s => s.geometry.listTypes(...args)),
      get: (...args: Parameters<ReturnType<typeof createBrowserModelingService>['geometry']['get']>) => run(s => s.geometry.get(...args)),
    },
    parameter: {
      listSurfaces: (...args: Parameters<ReturnType<typeof createBrowserModelingService>['parameter']['listSurfaces']>) => run(s => s.parameter.listSurfaces(...args)),
      getFuselageLength: (...args: Parameters<ReturnType<typeof createBrowserModelingService>['parameter']['getFuselageLength']>) => run(s => s.parameter.getFuselageLength(...args)),
      listGeometryParameterIds: (...args: Parameters<ReturnType<typeof createBrowserModelingService>['parameter']['listGeometryParameterIds']>) => run(s => s.parameter.listGeometryParameterIds(...args)),
      listCrossSectionParameterIds: (...args: Parameters<ReturnType<typeof createBrowserModelingService>['parameter']['listCrossSectionParameterIds']>) => run(s => s.parameter.listCrossSectionParameterIds(...args)),
      getGeometryParameter: (...args: Parameters<ReturnType<typeof createBrowserModelingService>['parameter']['getGeometryParameter']>) => run(s => s.parameter.getGeometryParameter(...args)),
      getCrossSectionParameter: (...args: Parameters<ReturnType<typeof createBrowserModelingService>['parameter']['getCrossSectionParameter']>) => run(s => s.parameter.getCrossSectionParameter(...args)),
    },
    wing: {
      get: (...args: Parameters<ReturnType<typeof createBrowserModelingService>['wing']['get']>) => run(s => s.wing.get(...args)),
      getSectionDimensions: (...args: Parameters<ReturnType<typeof createBrowserModelingService>['wing']['getSectionDimensions']>) => run(s => s.wing.getSectionDimensions(...args)),
    },
    fuselage: { get: (...args: Parameters<ReturnType<typeof createBrowserModelingService>['fuselage']['get']>) => run(s => s.fuselage.get(...args)) },
  }
}

export type BrowserReadApiV1 = ReturnType<typeof createBrowserReadApi>
declare global {
  interface Window { __webvspModelingReadV1: BrowserReadApiV1 }
}

/** Register synchronously; registration does not create a service or query the engine. */
export function installBrowserReadApi(target: Window = window, factory: typeof createBrowserModelingService = createBrowserModelingService): void {
  target.__webvspModelingReadV1 = createBrowserReadApi(factory)
}
