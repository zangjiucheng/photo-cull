# Docker 本地运行

## 启动

```bash
make docker-up
```

打开 <http://127.0.0.1:5000>。端口仅绑定本机，应用没有账户鉴权。

镜像在 Node 阶段构建前端和共享风格参数，再由 Flask / Gunicorn 提供页面和 RAW 处理。容器内不运行 Electron。

## 照片目录

浏览器中的目录指的是容器路径。默认上传目录为 `/app/uploads`；如需原地索引宿主机照片，请在 `docker-compose.yml` 的 `volumes` 中增加挂载，例如：

```yaml
      - /absolute/path/to/photos:/photos:ro
      - /absolute/path/to/exports:/exports
```

先在宿主机创建这些目录，然后在应用中打开 `/photos`，导出到 `/exports`。原片目录可只读挂载，输出目录需要可写。

## 数据与停止

`uploads/` 和 `data/` 位于仓库根目录，通过 volume 持久化；数据库是 `data/ai_culling.db`。RAW 缓存默认也放在数据目录中。前端资源包含在镜像内。

```bash
make docker-down
```

此命令停止容器，不删除宿主机上的照片或数据库。重新构建使用 `make docker-build`。
