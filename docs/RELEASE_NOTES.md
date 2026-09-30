# dsh-distillation 1.0.0

把 **网站、文档站、书籍、Git 仓库、ComfyUI 工作流** 变成 DSH 里可直接调用的 Skill。

## 亮点

- **11 个 Agent 工具 + 11 个 CLI 子命令**，共用同一套引擎；CLI 在会话之外也能用，不需要重启。
- **内置三个蒸馏引擎**（nuwa / cangjie / darwin）与调度 Skill：装完即用，**不需要 git clone**，
  上游 MIT 声明随包分发（`THIRD_PARTY_LICENSES.md`）。
- **文档站专用入口 `docs`**：自动探测站点的 `llms.txt`（llmstxt.org 约定），优先取 `.md` 镜像，
  支持 `--filter '/regex/i'` + `--limit`，可合并成一份文档或**每页装一个 Skill**。
  实测 `docs.comfy.org`：索引 133 页，133 页全带 `.md` 镜像。
- **网页提取**：readability 式主容器打分、指数退避重试（404 不重试）、限量多页跟随、charset 回退。
- **仓库提取**：远端 `--depth 1` clone（用完即删）/ 本地直读，输出固定 8 节分析，资源与代码分开统计。
- **进化薄封装**：git 前置硬检查 → 分支 + 基线提交 → `test-prompts.json` 骨架 → 材料合并 →
  darwin 评估工单；`finalize` 只归档结论，`revert` 只打印 `git revert`（**绝不** `reset --hard`）。
- **环境自检 `doctor`**：Node / uv / Python / git / 技能根可写 / 引擎完整性 / 引擎漂移 / 路由索引，
  每条 warn/fail 都带**可执行修复命令**。
- **侧边栏页面**：实时产出清单（来源徽标 + 时间）、一键自检面板、工具与命令速查。

## 安装

```bash
# 从 GitHub 直接安装（纯 ESM、无构建、无需放行构建脚本）
dsh plugin --profile desktop add github:mmctbqj-collab/distillation-plugin

# 或使用本 Release 的附件
dsh plugin --profile desktop add ./dsh-distillation-1.0.0.tgz
```

GUI：**侧边栏「插件」→ 安装组合包**，填同样的 spec。

## 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| DeepSeek Harness | 0.2.x | 在 `0.2.0-rc.1` 实测 |
| Node.js | ≥ 22 | Desktop 自带 |
| git | 可选 | 只有 `evolve` 与 `git` 需要 |
| uv | 可选 | 只有 `cangjie` 需要；缺它其余能力照常 |

装完先跑一次自检：

```bash
node engines/skill-distillation/scripts/cli.mjs doctor
```

## 快速开始

```bash
node engines/skill-distillation/scripts/cli.mjs docs https://docs.comfy.org/zh --list --limit 20
node engines/skill-distillation/scripts/cli.mjs docs https://docs.comfy.org/zh \
     --filter '/custom-nodes/i' --limit 5 --out comfy-custom-nodes.md
node engines/skill-distillation/scripts/cli.mjs source https://nodejs.org/api/fs.html --out fs.md
node engines/skill-distillation/scripts/cli.mjs git https://github.com/alchaincyf/darwin-skill --out darwin.md
node engines/skill-distillation/scripts/cli.mjs skill --name my-notes --description "Use when …" --body-file body.md
```

## 许可证

**GPL-3.0-or-later**（`LICENSE` 为 GNU 官方 GPLv3 全文）。

内置引擎来自以下 MIT 项目，版权归原作者所有：

- [alchaincyf/nuwa-skill](https://github.com/alchaincyf/nuwa-skill)（© 花叔 Huashu，固定在 `fe03746870`）
- [kangarooking/cangjie-skill](https://github.com/kangarooking/cangjie-skill)（固定在 `874eb414e6`）
- [alchaincyf/darwin-skill](https://github.com/alchaincyf/darwin-skill)（© alchaincyf，固定在 `8a8b66258e`）

许可原文与改写记录见 `THIRD_PARTY_LICENSES.md`；仓库内每个引擎另有 `UPSTREAM.json`（逐文件 SHA-256）。

## 已知限制

- 无 OCR / whisper / ffmpeg：扫描 PDF、图片、音视频需先外部转文本。
- 无浏览器：纯 JS 渲染的站点抓不到正文（优先用其 `llms.txt` / `.md` 镜像）。
- PDF / EPUB / DOCX 解析不在本版本范围（零依赖约束）。
- `route` 只给计划，不执行。
- 替换已加载的宿主包需要重启 DSH（客户端半边只需刷新页面）。

## 校验

```bash
sha256: <在此填入 dsh-distillation-1.0.0.tgz 的 SHA-256>
```

回归：`node verify/bundle-test.mjs` → 306 passed / 0 failed。
