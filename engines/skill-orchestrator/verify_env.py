#!/usr/bin/env python3
"""skill-orchestrator 自检工具（零第三方依赖，纯标准库）。

用途：
  1. 检查运行前置（Python / PyYAML / git / 目标目录是否 git 仓库）
  2. 检查三个子 Skill 是否已安装，并校验其 SKILL.md frontmatter
  3. 校验 skills.index.json 自身合法性与一致性
  4. 用 --record 把探测结果回写进 skills.index.json

用法：
  python verify_env.py                        # 全量自检
  python verify_env.py --json                 # 机器可读输出
  python verify_env.py --record               # 自检并把 installed 写回 registry
  python verify_env.py --skills-dir <dir>     # 指定子 Skill 安装目录
  python verify_env.py --check-updates        # 附带上游更新检查（需 git + 网络）

退出码：0 = 无 error；1 = 有 error（warning 不影响退出码）。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REGISTRY = HERE / "skills.index.json"

# skill 名合法性：DSH/Cherry 加载器会在非法时静默忽略整个 skill
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def default_skills_dir() -> Path:
    """Cherry Studio 与 Claude Code 共用 $DSH_HOME/skills/ 约定。"""
    for env in ("SKILL_ORCHESTRATOR_SKILLS_DIR", "CLAUDE_SKILLS_DIR"):
        if os.environ.get(env):
            return Path(os.environ[env]).expanduser()
    return Path(os.environ.get("DSH_HOME") or os.path.expanduser("~/.dsh")) / "skills"


def run(cmd: list[str], cwd: Path | None = None, timeout: int = 15):
    try:
        p = subprocess.run(
            cmd, cwd=str(cwd) if cwd else None, capture_output=True,
            text=True, timeout=timeout,
        )
        return p.returncode, (p.stdout or "").strip(), (p.stderr or "").strip()
    except FileNotFoundError:
        return 127, "", "not found"
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except Exception as e:  # noqa: BLE001
        return 1, "", str(e)


def parse_frontmatter(path: Path):
    """极简 YAML frontmatter 解析：只取顶层标量与块标量，够用即可。

    返回 (data, body) 或 (None, reason)。
    """
    try:
        text = path.read_text(encoding="utf-8")
    except Exception as e:  # noqa: BLE001
        return None, f"读取失败: {e}"
    if not text.startswith("---"):
        return None, "缺少 YAML frontmatter（必须首行是 ---）"
    lines = text.split("\n")
    end = None
    for i in range(1, len(lines)):
        if lines[i].replace("\r", "") == "---":
            end = i
            break
    if end is None:
        return None, "frontmatter 未闭合"
    data: dict[str, str] = {}
    key = None
    for raw in lines[1:end]:
        line = raw.rstrip("\r")
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        m = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", line)
        if m and not line.startswith((" ", "\t")):
            key, val = m.group(1), m.group(2).strip()
            if val in ("|", ">", "|-", ">-"):
                data[key] = ""  # 块标量，后续行填充
            else:
                data[key] = val.strip("'\"")
        elif key and raw.startswith((" ", "\t")):
            data[key] = (data.get(key, "") + " " + line.strip()).strip()
    return data, "\n".join(lines[end + 1:])


def check_runtime() -> list[dict]:
    checks = []

    v = sys.version_info
    ok = v >= (3, 10)
    checks.append({
        "name": "Python 版本", "status": "ok" if ok else "error",
        "detail": f"{v.major}.{v.minor}.{v.micro}" + ("" if ok else "（cangjie 需要 3.10+）"),
    })

    try:
        import yaml  # noqa: F401
        checks.append({"name": "PyYAML", "status": "ok", "detail": "已安装"})
    except ImportError:
        checks.append({
            "name": "PyYAML", "status": "error",
            "detail": "未安装 → cangjie 的 scripts/cangjie.py 无法启动。修: pip install PyYAML",
        })

    rc, out, _ = run(["git", "--version"])
    checks.append({
        "name": "git", "status": "ok" if rc == 0 else "error",
        "detail": out if rc == 0 else "未找到 → darwin 无法回滚（致命）",
    })
    return checks


def check_git_repo(target: Path) -> dict:
    rc, _, _ = run(["git", "rev-parse", "--git-dir"], cwd=target)
    return {
        "name": "工作目录是 git 仓库", "status": "ok" if rc == 0 else "warn",
        "detail": str(target) if rc == 0 else
                  "否 → darwin 只能写 .bak 备份，无法 git revert。修: git init",
    }


def add_problem(res: dict, level: str, msg: str) -> None:
    """level: error=阻塞 / warn=需知情 / info=仅提示。"""
    res["problems"].append({"level": level, "msg": msg})


def check_skill(entry: dict, skills_dir: Path) -> dict:
    sid = entry["id"]
    d = skills_dir / sid
    res = {"id": sid, "path": str(d), "installed": False,
           "problems": [], "frontmatter": None}

    if not d.exists():
        add_problem(res, "error", f"目录不存在: {d}")
        return res

    skill_md = d / "SKILL.md"
    if not skill_md.exists():
        add_problem(res, "error", "缺少 SKILL.md")
        return res

    fm, body = parse_frontmatter(skill_md)
    if fm is None:
        add_problem(res, "error", f"frontmatter 无效: {body}")
        return res

    name = fm.get("name", "")
    desc = fm.get("description", "")
    if not name:
        add_problem(res, "error", "frontmatter 缺少 name")
    elif not NAME_RE.match(name):
        add_problem(res, "error",
                    f"name 非法: {name!r} → 加载器会静默忽略整个 skill（需 ^[a-z0-9][a-z0-9-]*$）")
    if not desc:
        add_problem(res, "error", "frontmatter 缺少 description")
    elif len(desc) < 20:
        add_problem(res, "warn", "description 过短，可能无法被触发")

    res["frontmatter"] = {"name": name, "description_len": len(desc)}
    if name and name != sid:
        add_problem(res, "info",
                    f"frontmatter name={name!r} 与目录名 {sid!r} 不同（路由以目录名为准）")
    if not body.strip():
        add_problem(res, "error", "frontmatter 之后正文为空")

    res["installed"] = not any(p["level"] == "error" for p in res["problems"])
    return res


def load_registry() -> dict:
    if not REGISTRY.exists():
        raise SystemExit(f"[error] 找不到 registry: {REGISTRY}")
    try:
        return json.loads(REGISTRY.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise SystemExit(f"[error] registry JSON 非法: {e}") from e


def validate_registry(reg: dict) -> list[dict]:
    checks = []
    skills = reg.get("skills")
    if not isinstance(skills, list) or not skills:
        return [{"name": "registry 结构", "status": "error",
                 "detail": "skills 缺失或为空"}]

    ids = [s.get("id") for s in skills]
    dupes = {i for i in ids if ids.count(i) > 1}
    checks.append({
        "name": "registry 结构", "status": "error" if dupes else "ok",
        "detail": f"{len(skills)} 个条目" + (f"；重复 id: {dupes}" if dupes else ""),
    })

    required = {"id", "kind", "triggers", "requires", "produces", "priority"}
    missing = [f"{s.get('id')}:{sorted(required - set(s))}"
               for s in skills if required - set(s)]
    checks.append({
        "name": "必填字段", "status": "warn" if missing else "ok",
        "detail": "; ".join(missing) if missing else "完整",
    })

    all_triggers: dict[str, list[str]] = {}
    for s in skills:
        for t in s.get("triggers", []):
            all_triggers.setdefault(t.lower(), []).append(s.get("id"))
    collide = {t: v for t, v in all_triggers.items() if len(set(v)) > 1}
    checks.append({
        "name": "触发词唯一性", "status": "warn" if collide else "ok",
        "detail": f"冲突: {collide}" if collide else f"{len(all_triggers)} 个触发词无冲突",
    })
    return checks


def check_updates(reg: dict) -> list[dict]:
    out = []
    for s in reg.get("skills", []):
        repo = s.get("repo")
        if not repo:
            continue
        rc, sha, _ = run(["git", "ls-remote", f"https://github.com/{repo}", "HEAD"], timeout=30)
        out.append({
            "id": s["id"], "repo": repo,
            "status": "ok" if rc == 0 else "unknown",
            "remote_head": sha.split()[0][:12] if rc == 0 and sha else None,
        })
    return out


def record(reg: dict, results: list[dict]) -> None:
    now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    by_id = {r["id"]: r for r in results}
    for s in reg.get("skills", []):
        r = by_id.get(s["id"])
        if r is None:
            continue
        was = s.get("installed", False)
        s["installed"] = bool(r["installed"])
        s["last_checked"] = now
        if s["installed"] and not was:
            print(f"  [record] {s['id']}: installed=false → true")
    reg["updated"] = now[:10]
    REGISTRY.write_text(
        json.dumps(reg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[ok] 已回写 {REGISTRY.name}（updated={reg['updated']}）")


def main() -> int:
    ap = argparse.ArgumentParser(description="skill-orchestrator 环境与安装自检")
    ap.add_argument("--skills-dir", type=Path, default=None,
                    help="子 Skill 安装目录，默认 $DSH_HOME/skills")
    ap.add_argument("--record", action="store_true", help="把探测结果回写 registry")
    ap.add_argument("--check-updates", action="store_true", help="附带上游更新检查")
    ap.add_argument("--json", action="store_true", help="JSON 输出")
    args = ap.parse_args()

    skills_dir = (args.skills_dir or default_skills_dir()).expanduser()
    reg = load_registry()

    report = {
        "skills_dir": str(skills_dir),
        "runtime": check_runtime(),
        "git_repo": check_git_repo(HERE),
        "registry": validate_registry(reg),
        "skills": [check_skill(s, skills_dir) for s in reg.get("skills", [])],
    }
    if args.check_updates:
        report["updates"] = check_updates(reg)

    errors = [c for c in report["runtime"] if c["status"] == "error"]
    for s in report["skills"]:
        errors += [{"name": f"{s['id']}: {p['msg']}", "status": "error"}
                   for p in s["problems"] if p["level"] == "error"]
    report["exit_code"] = 1 if errors else 0

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        icon = {"ok": "✅", "warn": "⚠️ ", "error": "❌", "info": "ℹ️ "}
        print(f"skill-orchestrator 自检  |  子 Skill 目录: {skills_dir}")
        print("=" * 62)
        for grp in ("runtime", "git_repo", "registry"):
            print(f"\n[{grp}]")
            items = report[grp]
            if isinstance(items, dict):
                items = [items]
            for c in items:
                print(f"  {icon[c['status']]} {c['name']}: {c['detail']}")
        print("\n[skills]")
        for s in report["skills"]:
            mark = "✅" if s["installed"] else "❌"
            fm = s.get("frontmatter") or {}
            extra = f" (name={fm.get('name')})" if fm.get("name") else ""
            print(f"  {mark} {s['id']}{extra}")
            for p in s["problems"]:
                print(f"       {icon[p['level']]} {p['msg']}")
        if args.check_updates:
            print("\n[updates]")
            for u in report["updates"]:
                print(f"  {icon['ok'] if u['status'] == 'ok' else icon['warn']} "
                      f"{u['id']} @{u['remote_head']} ({u['repo']})")
        print("\n" + "=" * 62)
        print(f"结论: {'❌ 存在阻塞项，见上' if errors else '✅ 全部前置就绪'}")
        if not skills_dir.exists():
            print(f"\n提示: {skills_dir} 不存在。安装子 Skill 见 master-skill/SKILL.md 第 4 节。")

    if args.record:
        record(reg, report["skills"])
    return report["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
