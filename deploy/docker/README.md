# Docker Desktop Trial Deployment

在 Windows Docker Desktop 的 **Linux containers** 模式下运行。项目可放在
WSL 的 `~/WebVSP`，从该目录执行以下命令即可；无需在宿主机安装 Emscripten 或 PowerShell。

## Build and start

```bash
cd ~/WebVSP
docker compose up -d --build
docker compose ps
```

在 **Windows 浏览器**打开 <http://localhost:8090>。默认仅监听 Windows 本机回环地址，
不向局域网开放；WSL 的 `localhost` 不一定能访问 Docker Desktop 的发布端口。
首次构建会下载工具链并编译完整 OpenVSP/VSPAERO，耗时取决于网络与机器性能。
默认最多 4 个并行构建任务，避免耗尽 Docker Desktop 内存。

如果 Windows 代理监听在 `127.0.0.1:10808`，构建容器中应使用
`host.docker.internal:10808`，而不是容器自己的 `127.0.0.1`：

```bash
docker compose build \
  --build-arg HTTP_PROXY=http://host.docker.internal:10808 \
  --build-arg HTTPS_PROXY=http://host.docker.internal:10808 \
  --build-arg http_proxy=http://host.docker.internal:10808 \
  --build-arg https_proxy=http://host.docker.internal:10808
docker compose up -d
```

这些预定义 build args 仅供构建阶段使用，不会写入运行容器的环境配置。
基础镜像拉取由 Docker Desktop 自身的代理设置管理，与 build args 不同。

WSL/Bash 下可通过环境变量修改端口及编译并发：

```bash
WEBVSP_PORT=8091 WEBVSP_BUILD_JOBS=2 docker compose up -d --build
```

也可在仓库根目录新建 `.env` 并设置 `WEBVSP_PORT`、`WEBVSP_BUILD_JOBS`。

## Stop and restart

```bash
docker compose stop
docker compose start
docker compose logs --tail=100 web
```

删除此项目的运行容器与网络（保留镜像和源码）：

```bash
docker compose down
```

## Validation

Windows PowerShell：

```powershell
curl.exe -I http://localhost:8090/
curl.exe -I http://localhost:8090/wasm/vsp.wasm
```

应返回 HTTP 200，WASM 类型为 `application/wasm`，并带有：

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

浏览器需要 WebGL2、WebAssembly 和跨源隔离后的 SharedArrayBuffer。使用 `localhost`
是为了满足浏览器安全上下文要求；不要改成局域网 HTTP 地址直接访问。

试用操作：添加 Wing/Fuselage → 修改参数 → File / Save As 保存 `.vsp3`。
模型和分析在浏览器内存中运行，**容器不保存工程文件**；关闭标签页之前应显式保存。
STEP 导出、多线程 VSPAERO 等上游限制仍然存在。

## Build provenance

镜像从本地 fork 源码构建，不下载线上演示站的 WASM。工具链沿用上游固定版本
Emscripten 6.0.12 / CMake 4.4.4，前端使用仓库的 npm lockfile。运行时仅为 nginx
静态资源服务；没有数据库、后端 API 或账号系统。`/LICENSE`、`/SOURCE.txt` 随镜像提供。
这些文件不是对外分发修改版时完整源码交付义务的替代；对外分发前应另行审核许可。
