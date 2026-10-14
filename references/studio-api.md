# H3 Studio 的 Agent 接口

`video.mjs` 只是这些接口的包装。不方便跑 Node 时可以直接调。都是 JSON，只监听 127.0.0.1。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 设置（ComfyUI 地址、每小时价格）、`runMode`（`cloud-batch` = Modal，`queue` = 其他 ComfyUI）、有没有 object_info |
| GET | `/api/agent/workflows[?all=1]` | 工作流：`needs {image, prompt}`、`defaults {duration, megapixels}`、`switches` |
| GET | `/api/agent/presets` | 画布上的所有卡片：`id, name, workspace, workflow, note` |
| GET | `/api/agent/params?workflow=…` 或 `?card=…` | 参数 `fields [{id, label, type, role, switch, value, options, min, max}]` 和开关 `switches [{title, on}]` |
| POST | `/api/images` | 请求体是图片原始字节，头 `x-filename: <URL 编码的文件名>`；返回 `{id}`，按内容去重 |
| POST | `/api/agent/runs` | 提交（见下） |
| GET | `/api/agent/jobs?ids=a,b` | 每条的 `state`、`error`、`batch {done, total}`、`downloadSeconds`、`result {id, path, url, seconds}` |
| POST | `/api/agent/cancel` | `{ids}`；云端的会取消它所在的整批 |
| GET | `/files/outputs/<文件>` | 视频文件（支持 Range） |

`POST /api/agent/runs` 的请求体：

```json
{
  "project": "my-game",
  "card": "卡片 id 或唯一的名字",
  "workflow": "cloud/xxx.json",
  "imageId": "<上传返回的 id>",
  "prompt": "…",
  "seeds": [1, 2],
  "count": 2, "seedStart": 100,
  "duration": 5, "megapixels": 0.6,
  "values": { "187:strength_model": 0.5 },
  "groups": { "动作推理 VBVR": false },
  "name": "卡片名（可选）",
  "dryRun": true
}
```

- `card` 和 `workflow` 二选一；`seeds` 和 `count` + `seedStart` 二选一（都不给就随机一个种子）。
- 输入图、提示词和种子不能放进 `values`，要用各自的字段传。
- dry-run 返回 `{count, seeds, reused, joined, estimate, mode}`，不保存任何东西。
- 正式提交返回 `{jobs, reused, batchId, mode, card, workspace}`。`reused` 是同样组合已经有的视频，`jobs` 里包括新建的和正在生成、被并入的。
- 参数有问题时返回 400，`error` 里逐行写出原因。
