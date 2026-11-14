# syntax=docker/dockerfile:1

FROM mcr.microsoft.com/powershell:7.5-ubuntu-24.04 AS powershell

FROM emscripten/emsdk:6.0.12 AS engine
COPY --from=powershell /opt/microsoft/powershell/7 /opt/microsoft/powershell/7
ENV PATH="/opt/build-tools/bin:/opt/microsoft/powershell/7:${PATH}"
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ccache ninja-build python3-venv libicu74 libssl3t64 libgssapi-krb5-2 \
    && python3 -m venv /opt/build-tools \
    && /opt/build-tools/bin/pip install --no-cache-dir cmake==4.4.4 \
    && rm -rf /var/lib/apt/lists/*

ARG BUILD_JOBS=4
ENV CMAKE_BUILD_PARALLEL_LEVEL=${BUILD_JOBS} \
    CCACHE_DIR=/root/.cache/ccache \
    CCACHE_MAXSIZE=2G \
    CCACHE_COMPILERCHECK=content
WORKDIR /src
COPY Libraries/ Libraries/
COPY src/ src/
COPY web/wasm/ web/wasm/
RUN --mount=type=cache,target=/root/.cache/ccache \
    /bin/bash -c 'source /emsdk/emsdk_env.sh && pwsh -NoProfile -File web/wasm/build_wasm.ps1 -Stage libs'
RUN --mount=type=cache,target=/root/.cache/ccache \
    /bin/bash -c 'source /emsdk/emsdk_env.sh && pwsh -NoProfile -File web/wasm/build_wasm.ps1 -Stage fltk'
COPY examples/ examples/
COPY TestXSec.fxs LICENSE README.md CHANGELOG.md vspIcon.png ./
RUN --mount=type=cache,target=/root/.cache/ccache \
    /bin/bash -c 'source /emsdk/emsdk_env.sh && pwsh -NoProfile -File web/wasm/build_wasm.ps1 -Stage vsp'
RUN test -s web/frontend/public/wasm/vsp.wasm \
    && test -s web/frontend/public/wasm/vspaero.wasm \
    && test -s web/frontend/public/wasm/vsploads.wasm

FROM node:22-alpine AS frontend
WORKDIR /app
COPY web/frontend/package.json web/frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY web/frontend/ ./
COPY --from=engine /src/web/frontend/public/wasm/ public/wasm/
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=frontend /app/dist/ /usr/share/nginx/html/
# Keep the upstream license and source URL available with the distributed build.
COPY LICENSE /usr/share/nginx/html/LICENSE
COPY deploy/docker/SOURCE.txt /usr/share/nginx/html/SOURCE.txt
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
