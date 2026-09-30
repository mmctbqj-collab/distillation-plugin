# dsh-distillation（蒸馏插件）

把 **网站、文档站、书籍、Git 仓库、ComfyUI 工作流** 变成 DSH 里**可直接调用**的 Skill —— 并且把
「调用 / 生成 / 进化」这条闭环真正跑通、看得见。

- 面向 **DeepSeek Harness** 的纯 ESM 插件，**零第三方依赖**（只用 `node:*`）
- 内置 **nuwa / cangjie / darwin** 三个蒸馏引擎与调度 Skill，**装完即用，不需要 git clone**
- 11 个 Agent 工具 + 11 个 CLI 子命令 + 一个带实时数据的侧边栏页面
- 许可证：**GPL-3.0-or-later**（内置引擎各自沿用上游 MIT，见 [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md)）

> 仓库：<https://github.com/mmctbqj-collab/distillation-plugin> · 当前版本 **1.0.0**

---

## 它解决什么问题

| 你手上有什么 | 以前要做什么 | 现在一条命令 |
|---|---|---|
| 一个文档站 | 一页页猜 URL 抓 | `docs <url>` 自动探测 `llms.txt`，列页 → 合并 / 每页一个 Skill |
| 一个网页 / 本地 md | 手动复制正文 | `source <url\|file>` readability 式提取正文 + 重试 + 多页 |
| 一个 Git 仓库 | 逐个目录翻 | `git <url\|dir>` 输出 8 节仓库分析 |
| 一个 ComfyUI 工作流 | 对着 JSON 猜参数 | `comfy <workflow.json>` 固定 8 节解析 |
| 一本书 | 手工整理成技能 | 仓颉引擎（Capability Bundle）→ `cangjie --bundle` 确定性编译成 Skill |
| 一份补充材料 | 反复改 SKILL.md | `evolve` 归档原文 + 落库材料 + 生成 darwin 评估工单 |
| 一句「该用哪些 skill」 | 凭记忆 | `route` 返回结构化路由计划（只算不执行） |

---

## 安装

三种方式任选其一（详见 [docs/INSTALL.md](./docs/INSTALL.md)）：

```bash
# 1) 从 GitHub 直接安装（无需构建）
dsh plugin --profile desktop add github:mmctbqj-collab/distillation-plugin

# 2) 用 Release 附件（.tgz）
dsh plugin --profile desktop add ./dsh-distillation-1.0.0.tgz

# 3) 从本地目录安装（开发时）
dsh plugin --profile desktop add E:/path/to/distillation-plugin
```

在 GUI 里则是 **侧边栏「插件」→ 安装组合包**，填上面同样的 spec。

安装后：

- **侧边栏出现「蒸馏」图标**，点开是实时状态页（产出清单 + 环境自检）
- **Agent 立刻获得 11 个 `distill_*` 工具**
- `skill("nuwa-skill")` / `skill("cangjie-skill")` / `skill("darwin-skill")` /
  `skill("skill-orchestrator")` / `skill("skill-distillation")` **都可加载**（内置引擎，无需额外安装）

---

## 快速开始

```bash
# 先自检：环境缺什么，它会明确告诉你并给出修复命令
node engines/skill-distillation/scripts/cli.mjs doctor

# 文档站：先看有哪些页可抓，再合并
node engines/skill-distillation/scripts/cli.mjs docs https://docs.comfy.org/zh --list --limit 20
node engines/skill-distillation/scripts/cli.mjs docs https://docs.comfy.org/zh \
     --filter '/custom-nodes/i' --limit 5 --out comfy-custom-nodes.md

# 网页 → Markdown
node engines/skill-distillation/scripts/cli.mjs source https://nodejs.org/api/fs.html --out fs.md

# 仓库 → 8 节分析
node engines/skill-distillation/scripts/cli.mjs git https://github.com/alchaincyf/darwin-skill --out darwin.md

# 落成一个 Skill（写盘即可被 DSH 发现，无需重启）
node engines/skill-distillation/scripts/cli.mjs skill --name my-notes \
     --description "Use when ..." --body-file body.md --target user
```

对 Agent 直接说自然语言也可以：「**把 docs.comfy.org 的 custom-nodes 抓下来做成技能**」。

---

## 能力矩阵

### 11 个 Agent 工具

| 工具 | 作用 |
|---|---|
| `distill_docs` | 文档站整站：探测 `llms.txt` → 列页 → 合并成一份文档 / 每页一个 Skill |
| `distill_sources` | 网页与本地 md/txt/html/json → 一份合并 Markdown（正文提取 + 重试 + 多页） |
| `distill_git` | 仓库 → 8 节分析（远端 `--depth 1` clone，本地直读） |
| `distill_comfyui` | ComfyUI 工作流（UI/API 两种格式）→ 8 节解析 |
| `distill_skill` | 把内容写成 DSH Skill 包并登记产出 |
| `distill_evolve` | 用一份 `.md` 进化已有 Skill；建分支、生成评估工单、`finalize` 归档 |
| `distill_cangjie` | Capability Bundle → 真实可安装 Skill 包（跑 cangjie CLI） |
| `distill_route` | 自然语言 → 结构化路由计划（只算不执行，含澄清门） |
| `distill_list` | 列出技能根；`generated: true` 列出本插件的产出（带来源徽标） |
| `distill_engines` | 列出/导出内置引擎（含上游 commit） |
| `distill_doctor` | 环境自检：Node / uv / Python / git / 技能根 / 引擎完整性 / 路由索引 |

### 11 个 CLI 子命令

同一套引擎，在**会话之外**也能用（不需要重启 DSH）：

```
comfy  <workflow.json> [--out f.md] [--title T] [--print]
source <url|file>... --out f.md [--title T] [--follow N] [--print]
git    <url|dir> --out f.md [--branch B] [--title T] [--max-files N]
docs   <url> [--list] [--filter S|/regex/] [--limit N] [--out f.md | --per-page]
skill  --name <kebab> --description <text> [--body-file F] [--target user|project]
evolve --skill <id|dir> (--from doc.md | --text md) [--git-init] [--judges N] [--dry-run]
evolve --skill <id|dir> --finalize --decision keep|revert [--run-id R]
cangjie --bundle <verified dir> [--variant single|pack|auto] [--out DIR] [--target user|project]
route  --request "..." [--cwd DIR] [--json]
list   [--cwd DIR] [--json] [--generated]
engines list | export --target user|project [--overwrite]
doctor [--cwd DIR] [--json]
```

---

## 内置引擎（这是"装完即用"的关键）

插件包里带了一个裁剪并**已按 DSH 约定改写**的引擎目录 `engines/`，插件的 SkillProvider 把它作为
**rank 150 的技能根**直接暴露：

| 引擎 | 上游（MIT） | 固定在 |
|---|---|---|
| `nuwa-skill` | alchaincyf/nuwa-skill | `fe03746870` |
| `cangjie-skill` | kangarooking/cangjie-skill | `874eb414e6` |
| `darwin-skill` | alchaincyf/darwin-skill | `8a8b66258e` |
| `skill-orchestrator` | 本项目自有（路由索引） | — |
| `skill-distillation` | 本项目自有（SOP + CLI） | — |

- 唯一事实来源：`build/vendor-engines.mjs`（裁剪 + 改写 + `UPSTREAM.json` 逐文件哈希）。
  `--check` 可检测漂移，`--source <目录>` 可从新克隆的上游重新生成。
- 上游文档里的 `~/.claude/skills` 已统一改写为 DSH 技能根；**DSH 不读** `~/.claude/skills`。
- 需要把引擎落到磁盘（给 DSH 官方目录或其他工具用）时：`engines export --target user`。

### 技能根优先级

| rank | 根 | 说明 |
|---|---|---|
| 0 | DSH bundled | asar 内置 |
| 100 | `<cwd>/.dsh/skills` | 项目级（最高） |
| **150** | **本插件 `engines/`** | 内置引擎 |
| 200 | `<cwd>/.agents/skills` | 项目级 |
| 300 | `extraSkillDirs` 配置 | 自定义 |
| 400 | `$DSH_HOME/skills` | 用户级 |
| 500 | `$DSH_HOME/agents/skills` | 用户级 |

同名时 rank 小者胜。`config.bundledEngines: false` 可关闭内置根，让你自己的副本优先。

---

## 页面

侧边栏「蒸馏」+ 主面板，并在 **设置 → 插件** 里保留一个标签页：

- **实时状态**：版本、内置引擎数、技能根数
- **本插件产出的技能**：名称 / 来源（`distill_skill` / `evolve` / `cangjie-compile` / `distill_docs`）/ 时间 / 描述
- **环境自检**：一键运行 `doctor`，未通过项直接给出修复命令
- 工具说明、可复制的 CLI 命令与自然语言示例
- **可选总入口**：`dsh-skill-hub`（浏览/启停全量技能、市场）—— 与本插件互补，不重复实现

数据来自宿主注册的只读路由 `GET /dsh-distillation/status`（同源，仅回环）。

---

## 目录结构

```
distillation-plugin/            ← 仓库根 = 可安装包根
├── package.json                # dsh.bundle.patch / dsh.client / files
├── cordis.patch.yml            # 插入一行 id: distillation
├── index.js                    # 宿主半边：11 个工具 + SkillProvider + 状态路由
├── core.mjs                    # 纯逻辑（提取/分析/路由/进化/编译/仓库/文档站）
├── client.js                   # 客户端半边：侧边栏图标 + 主面板 + 设置页
├── locale/{zh,en}.json         # 插件卡片文案
├── engines/                    # 内置引擎（含 UPSTREAM.json 与 .dsh-engines.json）
├── docs/                       # 中文文档（安装/使用/SOP/FAQ/变更）
├── verify/bundle-test.mjs      # 密闭离线断言，不依赖本机
├── build/                      # vendor-engines.mjs / sync-core.mjs / asar.mjs / 诊断脚本
├── LICENSE                     # GPLv3 全文
└── THIRD_PARTY_LICENSES.md     # 生成：三个 MIT 引擎的声明与许可原文
```

---

## 自检与回归

```bash
node verify/bundle-test.mjs            # 离线断言：schema、提取、路由、进化、编译、仓库、文档站、页面契约
node build/vendor-engines.mjs --check  # 内置引擎与 vendoring 记录是否一致
node build/sync-core.mjs --check       # core.mjs 的多份副本是否字节一致
```

---

## 明确不承诺的事

- 无 OCR / whisper / ffmpeg：**扫描版 PDF、图片、音视频必须先外部转成文本**
- 无浏览器：纯 JS 渲染的站点抓不到正文（请优先用站点的 `llms.txt` / `.md` 镜像）
- 无云端：所有处理都在本机
- `route` 只给计划，不替你执行
- PDF / EPUB / DOCX 解析不在本版本范围（零依赖约束）

---

## 许可证与致谢

本项目以 **GPL-3.0-or-later** 发布，见 [LICENSE](./LICENSE)。

内置引擎来自以下 MIT 项目，版权归原作者所有，声明与许可原文见
[THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md)：

- [alchaincyf/nuwa-skill](https://github.com/alchaincyf/nuwa-skill)（© 花叔 Huashu）
- [kangarooking/cangjie-skill](https://github.com/kangarooking/cangjie-skill)
- [alchaincyf/darwin-skill](https://github.com/alchaincyf/darwin-skill)（© alchaincyf）
