# 质量门禁

在仓库根目录运行。CI 在 Windows 上验证 Node.js 18.19.0 和 24.22.1。Python 3.9 需安装 Pillow 10.2.0。

```powershell
npm --prefix healthy-fitness-coach-plugin/mcp/xunji ci --ignore-scripts
npm --prefix quality-tests ci --ignore-scripts
python -m pip install Pillow==10.2.0
npm --prefix quality-tests test
```

同一入口检查源码测试、Gherkin、关键变异、训练知识与工作流、SVG/PNG、视觉等价、Plugin 同步、配对评测和制品。源码测试有跳过或未决项时失败。解包验证只允许 `build-release.py` 中具名的独立 Skill 跨包例外，并在源码环境验证对应测试。

## 覆盖率

c8 从 V8 收集 JavaScript 覆盖率。统计独立 Skill 的 `references/`、`scripts/` 和训记连接器的 `src/`，包括范围内未加载的文件。测试、评测、镜像、快照、第三方依赖和 Python 文件不进入分母。

| 源码范围 | 行 | 分支 | 函数 |
| --- | ---: | ---: | ---: |
| 独立 Skill | 97.06% | 80.51% | 98.34% |
| 训记连接器 | 80.40% | 76.47% | 78.07% |

门槛取自干净的 `0483860` 源码测试基线，向下保留两位小数。两套 Node 版本测得同一基线。CI 另按 PR 目标提交或推送前提交核查改动，改动行覆盖率至少 95%，起点位于改动行上的 V8 分支覆盖率至少 90%。本地可指定同一个基准复现。

```powershell
$env:QUALITY_BASE_SHA = git rev-parse origin/main
node quality-tests/run-coverage.js
```

## 验收与变异

`run-gherkin.js` 用 Cucumber 解析功能文件，绑定步骤定义，逐步检查执行结果。歧义、未绑定、跳过、未完成或断言失败均阻断。

`run-mutation-smoke.js` 在独立进程运行原始对照，再替换单个源码片段，沿真实模块路径加载依赖。所有关键变异都必须触发行为断言失败。超时、语法、加载、执行异常和未匹配的替换均视为门禁故障。
## 历史评测与制品

CI 从固定 Git 提交重建历史 Skill，以清单校验路径、SHA-256 和隐私边界。评测需要完整 Git 历史。运行 `node healthy-fitness-coach/evals/paired-evaluation.js` 可在 `output/paired-evaluation/` 生成原始结果与人工审阅页。加 `--check` 时只执行断言。

发布构建会从 Skill 源同步 Plugin，报告 Git 基线、工作树状态和各发行件 SHA-256。中文图片标题检查要求构建环境具备 CJK 字体，可通过渲染器的字体环境变量指定。
