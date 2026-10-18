# Photo Cull

[![CI](https://github.com/zangjiucheng/photo-cull/actions/workflows/ci.yml/badge.svg)](https://github.com/zangjiucheng/photo-cull/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/zangjiucheng/photo-cull)](https://github.com/zangjiucheng/photo-cull/releases/latest)

本地照片选片与 RAW 调色工具。面向 DJI 航拍照片，把评分、相似照片筛选、快速调整和成片导出放在一个工作区里。

**选片 → 自动增强 → 拖几下滑杆 → 导出。**

## 安装

从 [GitHub Releases](https://github.com/zangjiucheng/photo-cull/releases/latest) 下载 macOS Apple Silicon（arm64）DMG，打开后将 **AI Photo Culling.app** 拖到 Applications。

基础评分、RAW 编辑与导出所需的 Python 后端包含在安装包中，无需另外安装 Python。当前发布流程未配置 Developer ID 签名和公证，首次打开可能受到 macOS 安全检查限制。

应用每次启动都会检查 GitHub Releases 上的新版本，也可以通过菜单 **AI Photo Culling → Check for Updates...** 手动检查。确认更新后，应用会下载对应架构的 zip，按 `SHA256SUMS.txt` 做校验，然后在退出时替换当前的 `.app` 并重新启动。自动替换要求应用位于可写目录，例如 `/Applications`；如果是直接从 DMG 中运行，会改为打开发布页。设置 `AI_CULLING_DISABLE_UPDATES=1` 可以关闭更新检查。Intel Mac、Windows 和 Linux 尚未提供已验证的安装包。

## 功能

| 环节 | 能做什么 |
| --- | --- |
| 选片 | 文件夹工作区、照片评分、星级、筛选与逐张查看 |
| 相似照片 | 检索相似/重复照片，比较后决定保留哪些 |
| 快速调色 | 大图即时预览，曝光、鲜明度、高光、阴影、自然饱和度、冷暖六个常用滑杆 |
| 自动增强 | 保守的明暗与色彩建议，可调强度，结果可继续手动修改 |
| 风格 | Original、Natural、Warm sunset、Cool、Black & white，当前照片缩略图与独立强度 |
| 精调 | 对比、黑位、去雾、饱和度、色调、细节、剪裁警示 |
| 构图 | 非破坏裁切、常用画幅、±15° 拉直和三分网格 |
| 批量编辑 | 选择性复制/粘贴调整、应用到导出队列、设备个人预设 |
| 导出 | sRGB JPEG、16 位 sRGB TIFF，逐片配方、尺寸与质量设置、文件名避让 |

普通编辑在本地进行，打开文件夹会原地索引照片；编辑参数单独保存，导出不会覆盖原片。可选 AI runtime 需要联网安装依赖和获取模型，不是基础调色的前置条件。

## 快速使用

1. **Open Folder** 打开照片目录，等待索引完成。
2. 在 **Browse / Review / Similarity** 评分、比较照片，将要处理的照片加入队列。
3. 打开 **Enhance & Export**，点 **Auto**，再按需要拖动常用滑杆或选择风格。
4. 展开 **Crop & straighten** 调整构图；需要统一观感时，在 **Copy adjustments & presets** 选择要复制的调整组。默认保留各片独立的曝光、白平衡和裁切。
5. 选择 **Share JPEG** 或 **Archive TIFF**，设置输出目录，点击 **Export**。每张照片使用自己的配方；导出预设也属于逐片设置，可通过复制调整中的 **Export settings** 同步到队列。

编辑参数会自动保存，底栏显示保存状态。关闭后可恢复配方；撤销历史只保留在当前会话中，最多 50 步。个人预设保存在当前设备的本地存储中。

| 操作 | 快捷方式 |
| --- | --- |
| 撤销 / 重做 | `⌘/Ctrl+Z` / `⇧+⌘/Ctrl+Z` |
| 临时查看原图 | 按住 `\` 或画布下方的对比按钮 |
| 单项复位 | 双击滑杆 |
| 切换照片 | 左右方向键 |
| 保存工作区入口文件 | 桌面版 `⌘/Ctrl+S`；入口文件记录目录，不打包照片或编辑数据库 |

## RAW、色彩与输出说明

- 新配方使用 rawpy 16 位显影，固定曝光、相机白平衡，后续基础处理保留 float32。GPU 预览与 CPU 导出共享风格数据和调整数学；浏览缩略图仍使用快速预览。
- 冷暖是相对相机白平衡的调整，不是以 Kelvin 为单位重新显影。高光控制不能恢复传感器已饱和的细节。
- 常规缩放、锐化和裁切保持浮点，最终写入 JPEG 时量化到 8 位，TIFF 时量化到 16 位。预览和全尺寸导出的插值、细节处理可能存在差异。
- 输出带 sRGB ICC，保留受支持的相机、曝光、日期、作者元数据，更新方向和尺寸；不复制 GPS、XMP 或 MakerNote。
- 旧版未标记版本的配方继续使用旧算法；在编辑区可主动切换到新控制，从中性基准开始。
- 降噪使用传统滤波，界面报告 OpenCV 非局部均值或 Pillow 回退；Real-ESRGAN 放大需要可选 runtime。两者默认关闭，启用后会经过 8 位处理。
- 本软件输出的 16 位 TIFF 可保留精度重新导入；带其他 ICC 配置文件的 16 位 TIFF 暂不支持。

本轮已用 24 张 DJI FC3170 / 4000×3000 DNG 做初步检查。高 ISO 真夜景、48 MP RAW、长期大量切图的内存占用，以及可选模型 runtime 尚未完成全面验收。详细证据见 [实现与验收记录](docs/validation/quick-raw-editor.md)。

## 开发运行

已验证 Python **3.11**；CI 使用 Node.js **24** 和 npm。macOS 桌面开发需要 Electron，首次安装会下载其运行文件。

```bash
git clone https://github.com/zangjiucheng/photo-cull.git
cd photo-cull
python3.11 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements-dev.txt
cd frontend
npm ci
cd ..
make dev PYTHON="$PWD/.venv/bin/python"
```

仅在浏览器中调试：

```bash
make dev-web PYTHON="$PWD/.venv/bin/python"
```

打开 `http://127.0.0.1:5050`。浏览器模式的目录输入需要填写后端机器可访问的路径。

```bash
make test PYTHON="$PWD/.venv/bin/python"
make build-web
```

可选 AI 评分与 FAISS 相似检索依赖分别在 `requirements-ai.txt`、`requirements-faiss.txt` 中；也可在桌面版的 Debug 页面安装 AI runtime。基础编辑不需要这些大模型依赖。

## 构建与发布

在 macOS 上构建本机架构的 DMG：

```bash
make package-dmg PYTHON=python3.11
```

此命令创建独立打包环境，以 PyInstaller 打包后端，再用 electron-builder 构建桌面应用；产物位于 `release/`。`make package-dir` 生成供本地检查的未封装应用目录。

GitHub Actions 在 `main` 的 push / PR 上运行后端测试、前端测试与生产构建。推送 `v*` 标签触发 macOS 发布流程：校验、构建 DMG 和应用内更新所用的 zip、生成 SHA-256 校验文件并上传 GitHub Release。版本来自标签，发布配置见 [release.yml](.github/workflows/release.yml)。

Docker 用于本机浏览器模式，启动方法、照片目录挂载和数据持久化见 [Docker 说明](docker/README.md)。此应用未实现账户鉴权，Docker 默认仅绑定本机回环地址。

## 数据与目录

macOS 桌面数据默认保存在 `~/Library/Application Support/AI Photo Culling/`，包含 SQLite 工作区数据库、预览缓存和日志。备份时请同时保留数据库和照片目录；工作区入口文件只保存目录引用。安装新版本不会主动清除这些数据。

| 环境变量 | 用途 |
| --- | --- |
| `DB_PATH` | 覆盖 SQLite 数据库路径 |
| `UPLOAD_FOLDER` | 浏览器后端的上传目录；桌面版由应用管理 |
| `RAW_RENDER_CACHE` | RAW 浏览预览缓存目录 |
| `FLASK_HOST` / `FLASK_PORT` | 浏览器后端绑定地址与端口；开发默认 `127.0.0.1:5050` |

主要代码：`frontend/src` 为 React / TypeScript 编辑界面，`frontend/electron` 为桌面壳，`server` 为 Flask、RAW 处理和导出队列。研究依据见 [快速 RAW 调色研究](docs/research/quick-raw-editing.md)；开发 GPU 对比入口及复现方法见 [验收记录](docs/validation/quick-raw-editor.md)。
