# FlowTest-Lite

个人使用的本地 HTTP 接口工作台。保存和调试接口，在画布上把业务请求连成流程，运行后查看每一步的实际请求、响应和断言。

## 本机启动

准备 Python 3.13 或更新版本、[uv](https://docs.astral.sh/uv/) 和 Node.js 20.19.x 或 22.12+。首次从源码准备运行环境时，在仓库目录执行以下命令。

```sh
uv sync --locked
npm --prefix frontend ci
npm --prefix frontend run build
```

以后打开工具，只需在仓库目录运行以下命令，然后访问 [本地工作台](http://127.0.0.1:8765)。

```sh
uv run --locked python -m app
```

通过 `--port 8766` 可指定其他端口。服务只监听回环地址。数据默认写入用户主目录的 `.flowtest-lite/library.sqlite3`，可通过环境变量 `FLOWTEST_DATA_DIR` 指定数据目录。构建和启动使用可跨平台的命令。当前在 macOS arm64 实际验证。

开发前端时，可在另一个终端运行 `npm --prefix frontend run dev`。Vite 将 API 请求转发到默认端口 8765。日常运行由 Python 服务同时提供已构建页面和 API。

## 接口

- 新建接口，填写完整 HTTP(S) URL 或相对路径。接口可按名称、路径、方法和分组查找，支持分组管理、多选移动、标签切换、编辑、复制和删除。保存后可预览、导出 cURL 或发送，查看状态码、响应头、响应体、耗时、提取值和断言。会话内可回看同一接口最近的请求。
- 相对路径可使用环境基础地址、接口默认基础地址或公共基础地址，按此顺序选择第一个已配置的地址。完整 URL 使用它自身的地址。路径、Query、Headers、Body 及 Auth 支持 `{{名称}}`，接口变量可覆盖公共及环境变量，运行时值优先。
- 可配置 Bearer、Basic、API Key 及 Cookie，支持 JSON、raw、URL 编码表单和 multipart。上传附件后，在 Body 的 form-data 中选择文件。接口可保存状态码、耗时、Header、JSONPath、JMESPath、Schema 和响应文件相关断言。
- 导入支持粘贴 cURL、导入 OpenAPI/Swagger、Postman、HAR 和 Bruno。先预览，再保存选中的接口。OpenAPI 可从本地文档或 HTTP(S) 文档 URL 导入，支持文档内部的引用。导入后按需补充样例参数、鉴权和附件。

## 流程

- 新建流程后，选择已保存的接口添加到画布。可从节点库搜索、点击添加或拖入画布。可移动节点、重接端口、撤销、重做或整理布局，点选节点和连线在侧栏配置。接口节点在每次运行开始时读取当前保存的接口，可覆盖 Query、Headers 和 Body。
- 通过连线映射或提取节点传递上游结果。例如用 JMESPath `body.token` 提取 `token`，后续请求可使用 `{{token}}`。流程输入值随定义保存，运行时也可通过 API 提供。条件节点分别提供真、假出口，等待及内联控制块提供固定次数、集合及条件循环等控制。
- 应用节点修改并保存流程，然后运行。可取消运行。在运行视图中通过画布和时间线选择节点，查看错误、实际请求、响应、预期值和实际值。运行记录保留在当前服务进程，最多保留 12 次、并发运行最多 4 次。保存的接口和流程在重启后可重新打开。
- 页面与其他调用方共用同一个本地 API 和执行核心。服务启动后可在 [本地 API 文档](http://127.0.0.1:8765/docs) 查看路径和请求模型。

## Codex 本地插件

完成「本机启动」中的依赖安装和前端构建。从仓库目录执行以下命令，把 FlowTest-Lite 添加到本机 Codex 插件。命令需要可用的 `codex` CLI。

```sh
uv run --locked --extra mcp python -m app.codex_plugin
```

在 Codex 新会话中选择 **FlowTest-Lite**，然后说「打开 FlowTest-Lite 本地工作台」。Codex 首次连接插件的 `stdio` 服务时，Lite 会启动或复用已有实例。`workbench_open` 可在浏览器打开接口页或流程页。服务可在会话结束后继续供浏览器使用。启动错误可在数据目录的 `launch-<端口>.log` 中查看，默认端口为 `8765`。

插件使用本机的当前仓库和 Python 环境。更换仓库位置、端口或数据目录后，重新执行安装命令。使用 `--port` 和 `--data-dir` 可连接自定义实例。安装产物默认保存在 `~/.flowtest-lite/codex-marketplace`，同一命令可更新插件。正在运行的旧版实例可供打开工作台和读取数据，完成已有执行后可重启到新版以启用写入、执行和服务端运行摘要。见 [Codex 插件打包文档](https://developers.openai.com/plugins/build/plugins)。

### MCP 工具

- **接口管理**用 `api_list`、`api_get`、`api_create`、`api_update`、`api_delete`。`api_update` 只修改 `changes` 提供的字段。导入用 `api_import_preview` 和 `api_import_save`，调试用 `api_preview` 和 `api_send`。
- **流程编排**用 `workflow_list`、`workflow_get`、`workflow_create`、`workflow_update`、`workflow_delete`。可替换完整的 `definition`，或通过 `graph` 在一次保存中增删改主画布节点和连线。删除节点时同时列出需要删除的连线。内联区域和运行设置可用完整定义修改，结构可用 `workflow_validate` 提前检查。
- **流程运行**用 `workflow_run` 启动，`workflow_run_get` 查看进度和结果，`workflow_run_cancel` 取消。用 `environment_list` 查环境 ID。读取运行结果时指定 `node_id` 可查看该步实际请求、响应、提取和断言。保存的数据在页面刷新后可见。

更新和删除接口或流程时传入最近读取的 `revision`。默认遮蔽专用鉴权配置和常见凭据字段。确需查看原值时，相关读取工具可显式传 `include_sensitive: true`。请求体、响应体、变量和断言可能包含业务数据。查看大量响应时可用 `api_send` 的 `detail: "summary"`，流程运行默认先返回状态摘要。

其他 MCP 客户端也可在仓库目录运行 `uv run --locked --extra mcp python -m app.mcp_server --auto-start`。可追加与 Web 服务一致的 `--port`。

## 当前限制

- 旧流程中的平台资源、固定发布版本、引用型子流程、外部协议和数据节点会报错。内联区域支持本地 HTTP 与流程控制。
- 单个上传、每个 multipart 请求的附件总量和解码后的响应体上限均为 10 MiB。发送接口和执行流程时保留 HTTP 重定向响应。业务凭据保存在本地 SQLite 中，运行详情会显示实际请求值。
- cURL 导入解析命令文本，不调用 shell。请在界面中重新选择 cURL 或集合文档引用的本地附件。导入器无法替你完成复杂鉴权或补齐外部 OpenAPI 引用。

## 源码来源

从 [FlowTest](https://github.com/a3384379/FlowTest) 的 `main` 提取，基线为 [`7119fa6b912a0a3db288fd5587a580d20c8e46f1`](https://github.com/a3384379/FlowTest/commit/7119fa6b912a0a3db288fd5587a580d20c8e46f1)。沿用上游代码的来源与已有版权声明。该基线未提供许可证，本仓库未新增授权条款。
