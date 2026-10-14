---
name: video-gen
description: Use for AI video generation in any project - image-to-video (making a still image, character art or CG move), text-to-video, cutscenes, animated portraits, trailer or placeholder motion, several seed variants to pick from. Drives the user's local H3 Studio, which runs MiniMax H3 ComfyUI workflows on a Modal GPU or another ComfyUI. Covers checking Studio, choosing a workflow or one of the user's tuned presets, a dry run for count, time and cost before spending GPU credits, submitting, waiting through slow downloads, copying the videos into the project with a record of every parameter, and reviewing frames. H3 prompts themselves are written with the h3-prompt skill.
---

# 通用 AI 视频生成

一条路：**查 Studio → 读工程约定 → 选预设或工作流 → 写提示词 → dry-run 报价 → 用户同意后提交 → 等待并取回 → 看帧挑选 → 交给工程入库**。

后端是用户本机的 **H3 Studio**（默认 `http://127.0.0.1:53290`，随开机启动）。Studio 负责把 ComfyUI 工作流转成 API、提交到云端或本地 ComfyUI、下载视频并记下全部参数。本 skill 只通过它的 HTTP 接口工作，脚本是 `<skill>/scripts/video.mjs`（Node 18+，无依赖）。

## 0. 查 Studio（每个会话第一次生成前）

```bash
node <skill>/scripts/video.mjs status
```

| 结果 | 怎么做 |
|---|---|
| 退出码 0 | 记下 target：`Modal 云端批处理` 按 GPU 时间花用户的额度；`ComfyUI 队列` 是本地或别的机器。 |
| 退出码 2（连不上） | 告诉用户 Studio 没在跑，请用户启动（它的 `scripts/start_server.bat`），或用 `H3_STUDIO_URL` 指到它在的地址。 |
| 退出码 1（没设 ComfyUI 地址 / 缺 object_info） | 请用户在 Studio 设置页处理。Agent 不改 Studio 设置，不运行 `modal deploy/run`。 |

## 1. 读工程约定

在工程的 `AGENTS.md` / `CLAUDE.md` 里找 video-gen 一节（模板见 [project-section.md](references/project-section.md)）：输出目录、默认预设、预算和审批方式、入库方式。

- 没有约定：视频放 `tmp/video_explore/<YYYYMMDD>_<主题>/`（确认它被 git 忽略），不往工程资产目录里写。
- `--project` 默认是当前 git 仓库名。同一工程的所有生成都进 Studio 里的 `Agent · <project>` 工作区，用户能在 Studio 的画布和产出页接着看、接着调。

## 2. 选预设或工作流

```bash
node <skill>/scripts/video.mjs presets                 # 用户在 Studio 画布上调好的卡片
node <skill>/scripts/video.mjs workflows               # cloud/ 下的工作流（已部署、验证过）；--all 列出全部
node <skill>/scripts/video.mjs params --card <id|名字>  # 或 --workflow <路径>：可改的参数、当前值、开关
```

- **优先用预设**（`--card`）：用户指定了卡片、或工程约定写了默认预设时一定用它。预设带着用户调好的模型、LoRA 和强度，卡片所在工作区的时长和分辨率也一起带上。
- 没有合适的预设才用 `--workflow`，参数保持工作流默认值。
- 只在用户要求或任务明确需要时改参数：`--duration 秒`、`--mp 百万像素`、`--set <参数id>=<值>`、`--on <开关>` / `--off <开关>`。参数 id 和开关名照 `params` 的输出原样写。
- 图生视频要 `--image`；`params` 里带 `<image>` / `<prompt>` 的就是要填的输入。

## 3. 写提示词

- H3 工作流用 **h3-prompt** skill 写（首帧描述、动作节拍、镜头、声音）。
- 提示词写进文件，用 `--prompt-file` 传。记录文件里也会存一份全文，以后能原样重出。
- 图生视频先看清输入图，提示词跟图里已有的主体、构图和风格一致。

## 4. dry-run 报价，用户同意后再提交

```bash
node <skill>/scripts/video.mjs run --card <预设> --image in.png --prompt-file p.txt --count 3 --out <目录> --dry-run
```

dry-run 不生成，也不改 Studio 的画布（只把输入图存进 Studio 的图库）。它会给出：新生成几条、种子、能直接复用的已有视频、预计生成时间和费用。

- target 是 Modal 时，**把条数、时间、费用告诉用户，等用户同意再去掉 `--dry-run` 正式提交**。工程约定里写了预算的，在预算内可以直接提交，超出仍要问。
- 预估不含下载时间，只算生成。冷启动约 1.5 分钟；1 MP × 5 秒的视频，每条通常 45–90 秒。网速慢时，每条视频下载要好几分钟。
- 同一工作流、参数、输入图、提示词和种子的组合，只会生成一次：再提交时直接复用已有的视频；如果还在生成，就等那一条，不会重复花钱。想要新变体，就换种子（`--seeds 1,2,3` 或 `--count N --seed-start S`）。

## 5. 提交、等待、取回

```bash
node <skill>/scripts/video.mjs run ... --out <目录>              # 提交后立即返回，写 <目录>/video_run_<时间>.json
node <skill>/scripts/video.mjs wait <目录> --timeout-min 9       # 等最新一次提交；也可以给 json 路径
node <skill>/scripts/video.mjs cancel <目录>                     # 取消；云端会停掉这一整批
```

- `wait` 每 30 秒查一次。完成一条，就把视频复制到输出目录，文件名是 `<时间>_seed<种子>_<结果id>.mp4`，进度也同步写回记录文件。中断后重跑 `wait` 会从上次停下的地方继续。
- 宿主命令有时间上限时（例如 10 分钟），用 `--timeout-min 9` 分几次等，或者放到后台跑。退出码 5 表示还没跑完，再运行一次 `wait` 即可。
- 状态含义：`waiting` 在排队或等容器启动；`running` 正在生成；`downloading` 云端已经生成好，正在下载到本机；`done` 已完成；`failed` / `canceled` 失败或已取消。

| 退出码 | 含义 |
|---|---|
| 0 | 全部拿到 |
| 1 | 请求有误或 Studio 报错（信息里写了原因，比如参数 id 不存在、缺输入图） |
| 2 | 连不上 Studio |
| 4 | 有的失败了（逐条列出种子和错误） |
| 5 | 超时，还在跑 |

失败时如实告诉用户哪几条、错误摘要。**不要悄悄换工作流、预设或改参数重试**。换了会改变效果，要先问用户。

## 6. 看结果、挑选

视频没法直接"看"：先抽帧拼成一张图，再看这张图。

```bash
python <skill>/scripts/frames.py <目录>/*.mp4 --frames 6 --out <目录>/_sheet.png
```

每条视频占一行，按时间均匀取帧，第一列就是首帧，所以几个种子可以上下直接对比。脚本需要 Pillow，再加 OpenCV 或 ffmpeg 其中之一（ffmpeg 可以在 PATH 上，也可以用 imageio-ffmpeg 自带的）。

- 先查硬伤：首帧和输入图对不上、人脸或身份漂移、服装或物件中途变样、肢体错乱、画面闪烁或崩坏、动作和提示词不符、主体被裁出画面。
- 声音和动作是否自然，抽帧看不出来。请用户在 Studio 产出页对比：左侧工作区选 `Agent · <project>`，几条视频同步播放。
- 拿不准的时候不要替用户拍板：给出拼图、推荐哪条和理由，请用户选。

## 7. 声明分级和边界

生成出来只代表**有了候选**。选定、入库、在工程里真正用上，各要各的证据，不越级声明。

- 不改 Studio 设置，不删 Studio 里的结果，不运行任何 `modal` 命令。
- 不把候选手工覆盖进工程的正式资产目录。入库按工程约定或工程自己的 skill 走。
- 记录文件（`video_run_*.json`）里有提示词全文和输入图路径。工程不打算公开这些时，确认输出目录被 git 忽略。
- 直接调 Studio HTTP 接口（不用脚本）的写法见 [studio-api.md](references/studio-api.md)。
