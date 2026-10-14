# 工程约定模板

在工程的 `AGENTS.md` 或 `CLAUDE.md` 里加一节，video-gen 开工时读它。没有的项可以删掉，video-gen 会用默认值或问用户。

```markdown
## 视频生成（video-gen）

- Studio 目录：`D:\tools\h3-studio`（每条命令加 `--studio`；用户设了 `H3_STUDIO_ROOT` 可省略）
- Studio 地址：`http://127.0.0.1:53290`（默认，可省略；不同端口时设 `H3_STUDIO_URL`）
- 工作区名：`Agent · <名字>`，`--project <名字>`（默认是仓库名）
- 默认预设：`<卡片名或 id>`（用户在 Studio 画布上调好的）；动作幅度大的镜头用 `<另一张卡片>`
- 提示词：用 h3-prompt skill；角色设定见 `docs/characters/`
- 输入图：`art/anchors/`（已确认的角色图）
- 探索目录：`tmp/video_explore/<YYYYMMDD>_<主题>/`（git 忽略）
- 正式候选：`video/_incoming/<镜头ID>/`（git 忽略）
- 入库：选中的视频由 `<脚本或步骤>` 转码 / 裁剪后放进 `<正式资产目录>`
- 预算：单次不超过 $1 或 10 条可直接提交，超出先问；（不写 = 每次都先问）
```
