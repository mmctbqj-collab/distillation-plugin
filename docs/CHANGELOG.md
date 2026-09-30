# 变更记录

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## 1.0.0 — 2026-09-29

首个公开发布版本。目标读者：**任何 DSH 0.2.x 用户，装完即可用。**

### 新增：11 个 Agent 工具

| 工具 | 说明 |
|---|---|
| `distill_docs` | 文档站整站：探测 `llms.txt`（llmstxt.org 约定）→ 列页 → 合并成一份文档 / 每页一个 Skill |
| `distill_sources` | 网页与本地 md/txt/html/json → 一份合并 Markdown（readability 式正文提取 + 指数退避重试 + 限量多页 + charset 处理） |
| `distill_git` | 仓库 → 固定 8 节分析（远端 `--depth 1` clone 到临时目录并清理；本地路径直读） |
| `distill_comfyui` | ComfyUI 工作流（UI / API 两种格式）→ 8 节解析 |
| `distill_skill` | 把内容写成 DSH Skill 包，并写产出登记 sidecar |
| `distill_evolve` | 用一份 `.md` 进化已有 Skill：git 前置硬检查 → `auto-optimize/<stamp>` 分支 + 基线提交 → `test-prompts.json` 骨架 → 材料合并（备份 + `references/` + 幂等标记块）→ `evolution/<run-id>/plan.md` 评估工单 + `results.tsv`；`finalize` 归档结论 |
| `distill_cangjie` | 已验证 Capability Bundle → 真实可安装 Skill 包（`uv run --with pyyaml python cangjie.py compile`），默认拒绝覆盖 |
| `distill_route` | 自然语言 → 结构化路由计划（只算不执行）：整词 2 分 / 分词 1 分、通用词失效、person 与 content 互斥、同分澄清门 |
| `distill_list` | 列出技能根；`generated: true` 列出本插件产出（来源/工具/时间/来源文档） |
| `distill_engines` | 列出内置引擎（含上游 commit），或导出到技能根 |
| `distill_doctor` | 环境自检：Node / 内置引擎完整性 / 引擎漂移 / uv / Python+PyYAML / git / `cangjie.py` 定位 / 技能根可写 / 路由索引，**每条 warn/fail 都带修复命令** |

### 新增：11 个 CLI 子命令

`comfy` `source` `git` `docs` `skill` `evolve` `cangjie` `route` `list` `engines` `doctor`
—— 与会话内工具共用同一套 `core.mjs`，**会话之外可用、无需重启**。

### 新增：内置引擎（"装完即用"）

- 包内 `engines/` 提供 **nuwa-skill / cangjie-skill / darwin-skill / skill-orchestrator /
  skill-distillation**，由插件自己的 SkillProvider 以 **rank 150** 暴露，无需 git clone、无需复制。
- 三个上游引擎全部裁剪（去掉图片、promo、示例、预构建产物；总体积 1.5 MB）并**按 DSH 约定改写**：
  `~/.claude/skills` / `.claude/skills` / `/Users/<u>/.claude/skills` / Python 的
  `Path.home()/".claude"/"skills"` → DSH 技能根。
- 来源与改写可审计：每个引擎带 `UPSTREAM.json`（上游仓库、**固定提交号**、逐文件 SHA-256、
  逐文件改写记录），`build/vendor-engines.mjs --check` 可检测漂移。
- `distill_engines` / `engines export` 可按需导出到技能根（可选，不是必需）。

### 新增：客户端页面

- 侧边栏「蒸馏」+ 主面板 + **设置 → 插件** 标签页。
- **实时状态**：版本 / 内置引擎数 / 技能根数。
- **产出清单**：本插件生成或改动过的技能（名称、来源徽标、时间、描述）。
- **环境自检面板**：一键运行 `doctor`，未通过项显示修复命令。
- 数据来自宿主注册的**只读**路由 `GET /dsh-distillation/status`（同源、仅回环、无写操作）。
- 宿主未响应时如实提示"需重启 DSH"，并给出免重启的 CLI 命令（不假装空列表）。
- 中英双语（`ctx.locale`）；样式只用官方 `--dsw-alias-*` 主题 token。

### 兼容性与硬约束

- 目标运行时：**DSH 0.2.x**（在 `0.2.0-rc.1` / Electron 44 / Node 24 上实测）。
- **零第三方依赖**：宿主半边只 import `node:*` 与自身的 `core.mjs`
  （`link:` 安装下第三方包与 `@deepseek-ai/*` 都无法从真实路径解析）。
- 技能 id 契约：`^[a-z0-9]+(?:-[a-z0-9]+)*$`；中文标题会改由 URL 路径推导 ASCII id。

### 已知限制（明确不承诺）

- 无 OCR / whisper / ffmpeg：扫描 PDF、图片、音视频**必须先外部转成文本**。
- 无浏览器：纯 JS 渲染的站点抓不到正文（优先用站点的 `llms.txt` / `.md` 镜像）。
- PDF / EPUB / DOCX 解析不在范围内（零依赖约束）。
- `route` 只给计划，不执行。
- 替换已加载的宿主包需要**重启 DSH**。

### 许可

- 本项目：**GPL-3.0-or-later**（`LICENSE` 为 GNU 官方 GPLv3 全文）。
- 内置引擎：各自沿用上游 **MIT**，声明与许可原文见 `THIRD_PARTY_LICENSES.md`（由
  `build/vendor-engines.mjs` 生成，不会与实现漂移）。
