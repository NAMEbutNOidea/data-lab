# DataLab 模块契约（子 Agent 必须严格遵守）

> 本文件是并行开发的唯一接口真相。任何模块都不得擅自改动函数签名或返回字段名。

## 0. 运行环境

- Python 解释器（**唯一允许**）：
  `C:\Users\a3141\.conda\envs\NAMEbutNOidea\python.exe`
- 已装：numpy 2.2.6 / pandas 2.3.3 / scipy 1.15.3 / matplotlib 3.10.9 / openpyxl 3.1.5
- **禁止**引入 statsmodels / sklearn / fastapi / flask（未安装，且不联网安装）
- 后端 HTTP 使用标准库 `http.server`，零额外依赖
- 项目根：`D:\A-exm\vscode_code\tools\data-lab`

## 1. 目录与职责

```
data-lab/
├─ server.py            主 Agent：HTTP 路由 + 会话缓存 + 静态服务
├─ run.bat              主 Agent：双击启动
├─ core/dataloader.py   主 Agent：xlsx/csv 解析、列类型推断
├─ core/stats_engine.py 子 Agent A：描述统计 / 不确定度 / 假设检验
├─ core/fit_engine.py   子 Agent A：曲线拟合
├─ core/plot_engine.py  子 Agent B：matplotlib 渲染 + 风格预设
└─ web/{index.html,style.css,js/01..07}  子 Agent C：前端（7 个脚本按序加载）
```

## 2. 通用约定

- 所有模块只用**模块级纯函数**，不写 class、不读全局状态、不写文件（`plot_engine` 除外，它可写 bytes 到内存）。
- 数值一律转成 **Python 原生 float / int**（`float(x)`），**禁止**直接返回 `numpy.float64`，否则 JSON 序列化失败。
- 返回 `NaN` / `inf` 时统一用 `None`（JSON 不能表示 NaN）。提供工具函数 `_f(x)` 做转换。
- 所有面向用户的文字用**简体中文**；公式用 LaTeX 字符串（不含 `$`）。
- 出错时抛 `ValueError("中文错误信息")`，由 server 捕获转成 `{"ok":false,"error":"..."}`。
- 中文注释，中文 docstring。

## 3. 数值转换工具（各模块自行复制，勿跨模块 import）

```python
import math
def _f(x):
    """numpy -> 原生 float，NaN/inf -> None"""
    try:
        v = float(x)
    except Exception:
        return None
    if math.isnan(v) or math.isinf(v):
        return None
    return v
```

## 4. core/stats_engine.py 契约

```python
describe(values: list[float]) -> dict
```

返回：
```json
{
  "n": 20, "sum": 1.0, "mean": 1.0, "median": 1.0, "mode": 1.0,
  "std": 1.0, "std_err": 1.0, "variance": 1.0, "cv": 0.01,
  "min": 0.0, "max": 1.0, "range": 1.0, "q1": 0.0, "q3": 1.0, "iqr": 1.0,
  "skewness": 0.0, "kurtosis": 0.0,
  "ci95_low": 0.0, "ci95_high": 0.0
}
```
`std` 为样本标准差（ddof=1）；`cv = std/mean`（相对标准偏差 RSD，mean=0 时为 None）。

```python
uncertainty_type_a(values: list[float]) -> dict
```
```json
{"n":20, "mean":1.0, "s":1.0, "u_a":1.0, "formula":"u_A = s / sqrt(n)"}
```

```python
uncertainty_type_b(delta: float, distribution: str = "uniform",
                   confidence: float = 0.683, custom_k: float | None = None) -> dict
```
- `distribution` ∈ `uniform|triangular|normal|rect_halfwidth`
  - uniform → k = √3（矩形/均匀分布，仪器最大允差 a）
  - triangular → k = √6
  - normal → 由 `confidence` 决定：0.683→1, 0.95→1.96, 0.9545→2, 0.99→2.576, 0.9973→3
- `custom_k` 不为 None 时直接用它
```json
{"delta":0.5, "distribution":"uniform", "k":1.7320508, "u_b":0.2886751,
 "formula":"u_B = a / k", "k_source":"均匀分布 k=√3"}
```

```python
combine_uncertainty(components: list[float], coverage_k: float = 2.0) -> dict
```
```json
{"u_c":0.3, "coverage_k":2.0, "U":0.6, "relative":null,
 "formula":"u_C = sqrt(Σu_i²) , U = k·u_C"}
```
`relative` 由调用方用平均值另行计算，这里返回 None 即可。

```python
full_uncertainty(values: list[float], delta: float | None = None,
                 distribution: str = "uniform", confidence: float = 0.683,
                 custom_k: float | None = None,
                 coverage_k: float = 2.0) -> dict
```
综合报告，返回包含 `mean, n, s, u_a, u_b, u_c, coverage_k, U, relative_U, result_str`，
其中 `result_str` 形如 `"12.345 ± 0.012 (k=2, P=95%)"`。`delta` 为 None 时 `u_b=None` 且 `u_c=u_a`。

```python
hypothesis_test(x: list[float], y: list[float] | None = None,
                test: str = "ttest_1samp", mu: float = 0.0,
                alpha: float = 0.05, alternative: str = "two-sided",
                equal_var: bool = True) -> dict
```
- `test` ∈
  `ttest_1samp | ttest_ind | ttest_rel | ftest | anova | shapiro | levene |
   pearson | spearman | mannwhitney | wilcoxon | chisq_gof`
- `alternative` ∈ `two-sided | less | greater`
- `anova` 时 `x` 为第一组、`y` 传第二组；三组以上用 `hypothesis_test_groups`
```json
{"test":"ttest_ind", "test_name":"独立样本 t 检验", "statistic":2.31, "p_value":0.031,
 "dof":18.0, "alpha":0.05, "significant":true,
 "effect_size":0.98, "effect_size_name":"Cohen's d",
 "h0":"两总体均值相等", "h1":"两总体均值不等",
 "conclusion":"p = 0.0310 < α = 0.05，拒绝原假设：两组均值差异显著"}
```
- `ftest` 返回 `effect_size=None`，`statistic` 为 F = s1²/s2²
- `shapiro` / `levene` 的 `h0` 为“数据服从正态分布 / 各组方差相等”
- `pearson` / `spearman` 的 `statistic` 为相关系数 r，`dof = n-2`
- `chisq_gof`：`x` 为观测频数，`y` 为期望频数（可为 None 表示等概率）

```python
hypothesis_test_groups(groups: list[list[float]], test: str = "anova",
                       alpha: float = 0.05) -> dict
```
仅支持 `anova`（单因素方差分析，含组间/组内平方和）与 `kruskal`。
额外字段：`"groups":[{"name":"G1","n":10,"mean":1.0,"std":1.0}, ...]`、`"ss_between"`、`"ss_within"`、`"eta_squared"`。

## 5. core/fit_engine.py 契约

```python
MODELS: dict  # 模型注册表，见下
fit(x: list[float], y: list[float], model: str = "linear",
    deg: int = 2, yerr: list[float] | None = None,
    p0: list[float] | None = None) -> dict
```

`MODELS` 必须包含（key 为英文 id）：

| id | 表达式 | 参数名 |
|---|---|---|
| `linear` | `a*x + b` | a, b |
| `poly` | `a_n*x^n + ... + a_0` | c0..cn（升幂） |
| `exp` | `a*exp(b*x)` | a, b |
| `exp_offset` | `a*exp(b*x) + c` | a, b, c |
| `power` | `a*x^b` | a, b |
| `log` | `a*ln(x) + b` | a, b |
| `gaussian` | `a*exp(-(x-mu)^2/(2*s^2))` | a, mu, s |
| `lorentz` | `a/(1+((x-x0)/w)^2)` | a, x0, w |
| `sine` | `a*sin(w*x + phi) + c` | a, w, phi, c |

`MODELS[id]` 是 dict：`{"name":"线性","func":callable,"params":["a","b"],"guess":callable|None,"latex":str}`

`fit()` 返回：
```json
{
  "model":"linear", "model_name":"线性拟合",
  "params":[{"name":"a","value":1.0,"stderr":0.01,"latex":"a"}, ...],
  "param_values":{"a":1.0,"b":0.0},
  "equation_latex":"y = 1.0000x + 0.0000",
  "equation_plain":"y = 1.0000x + 0.0000",
  "n":20, "dof":18, "r2":0.99, "adj_r2":0.99,
  "chi2":0.1, "chi2_red":0.005, "rmse":0.01, "sse":0.001,
  "curve":{"x":[..],"y":[..],"y_lower":[..],"y_upper":[..]},
  "residuals":[..], "fitted":[..]
}
```
- 用 `scipy.optimize.curve_fit`，`absolute_sigma=True`（当给了 yerr）
- `curve` 覆盖数据 x 范围的 200 个点；`y_lower/y_upper` 为 **95% 预测带**（用参数协方差传播，`2*sqrt(diag(J·cov·Jᵀ) + sigma²)`）；算不出时置 None
- 无法收敛时抛 `ValueError`
- 参数名显示：把 `a,b,c` 换成 `a, b, c`，poly 的 `c0..cn` 在 equation 里按 `x^n` 降幂拼接

## 6. core/plot_engine.py 契约

```python
THEMES: dict      # 风格预设
PALETTES: dict    # 配色方案
render_png(spec: dict) -> bytes
render_bytes(spec: dict, fmt: str = "png", dpi: int = 300) -> bytes
```

`spec`（前端传入的完整绘图指令）：
```json
{
  "kind": "line",
  "theme": "paper_nature",
  "palette": "npg",
  "title": "标题", "xlabel": "X 轴", "ylabel": "Y 轴",
  "xscale": "linear", "yscale": "linear",
  "grid": true, "legend": true, "legend_loc": "upper right",
  "figsize": [6.4, 4.2], "dpi": 300,
  "canvas_grow": true,
  "xlim": [0, 10], "ylim": null,
  "font_size": 11, "line_width": 1.6, "marker_size": 5,
  "series": [
    {"name":"S1","x":[...],"y":[...],"kind":"line","color":"#E64B35",
     "linestyle":"-","marker":"o","yerr":[...],"xerr":[...],"alpha":1.0,
     "label":"y=ax+b"}
  ],
  "fit": { ...fit() 的返回值... } | null,
  "annotations": [{"x":1,"y":2,"text":"abc","arrow":false}],
  "table": null,
  "extra": {"show_ci":true,"hist_bins":20,"kde":true,"residual":false,"qq":false}
}
```

`kind` ∈ `line | scatter | line_marker | errorbar | bar | bar_grouped | bar_stacked |
hist | box | violin | residual | qq | heatmap | pie`

- `heatmap` 时 `series` 只有一项，额外要求 `spec["matrix"]={"labels":[...],"values":[[...]]}`
- `residual` 时用 `spec["fit"]["residuals"]` 与 x 绘制，并画 y=0 参考线
- `qq` 时用 `spec["series"][0]["y"]` 做 Q-Q 图
- `bar_grouped`：每个 series 是一组，x 为类别标签（字符串数组）
- 图例、标题、公式标注用 `spec["fit"]["equation_latex"]` 渲染 mathtext（`r"$y = ax+b$"`）

**多子图的画布与清晰度（`canvas_grow`，默认 `true`）**

多面板时 `figsize` 表示「**一格**的图幅」，总画布 = `figsize × [cols, rows]`。
这样每格的物理英寸恒定，配同样的 dpi 每格像素就恒定 —— 子图从 1 个加到 16 个，
单条曲线的清晰度不变，`font_size` 也不需要跟着缩。
若为 `false`（期刊限整图宽时），总画布钉死在 `figsize`，此时才启用按格子尺寸
缩字号的兜底逻辑（`_panel_font_scale`，参考边长 2.0 in、下限 0.42）。

- `canvas_grow=true` → `_build_panel_figure` **不得**改写 `merged["font_size"]`
- `canvas_grow=false` → 才按 `min(pw,ph)/2.0` 缩，且不低于 4.2 pt

**位图输出尺寸保护**：`figsize × dpi` 可能超出浏览器能解码的图片尺寸，
因此 `render_bytes_meta(spec, fmt, dpi, max_px=None)` 在 `fmt=="png"` 时调用
`_fit_dpi(w, h, dpi, limit_px)` 把 dpi 收敛到安全范围（默认上限 2.4 亿像素、
单边 16000 px）。**只降 dpi 不动图幅** —— 图幅是版式，改动会让字相对变大。
矢量格式（svg/pdf/eps）没有采样密度概念，不受此限制，也不许砍用户 dpi。

返回值 `meta` 一律带：
`{"panels_geo", "panels_dropped", "figsize_used", "dpi_used", "dpi_capped", "canvas_grown"}`。
前端**必须**显示这些实际生效值，而不是请求里发的那个 `figsize`/`dpi`——
否则会在界面上承诺一张根本渲染不出来的图（20×20 in @1200 dpi = 5.76 亿像素）。

`THEMES` 至少 8 个，key 与中文名对应：
`paper_nature`(Nature 论文), `paper_aps`(APS 物理), `ieee`(IEEE 单栏), `modern_light`(现代浅色),
`dark`(深色演示), `minimal`(极简), `notebook`(笔记本), `poster`(海报)

每个主题是 dict：
```python
{"name":"Nature 论文", "font":"serif", "font_family":["Times New Roman","SimHei"],
 "font_size":10, "axes_linewidth":0.8, "grid":False, "grid_style":"--",
 "tick_direction":"in", "spines_top":True, "spines_right":True,
 "lines_linewidth":1.2, "bg":"#FFFFFF", "fg":"#000000",
 "legend_frame":False, "description":"双栏期刊，细线内向刻度"}
```

`PALETTES` 至少 8 个：`npg`(Nature 配色), `science`(Science), `lancet`, `nejm`,
`highcontrast`(高对比), `grayscale`(灰度/黑白打印), `cool`(冷色), `warm`(暖色)。
每个是颜色 hex 列表。

**字体要求**：必须自行探测中文字体，按优先级
`C:/Windows/Fonts/msyh.ttc`(微软雅黑) → `simhei.ttf`(黑体) → `simsun.ttc`(宋体) → `Deng.ttf`。
用 `matplotlib.font_manager.fontManager.addfont()` 注册，并设置 `rcParams["font.sans-serif"]`，
`rcParams["axes.unicode_minus"] = False`。找不到任何中文字体时降级为英文，并在返回值之外不报错。
必须使用 `matplotlib.use("Agg")`，线程安全：每次渲染用独立 `Figure`，渲染完 `plt.close(fig)`。

**矢量/多轴/三维扩展**（见下列三节）：
`kind` 的完整集合以 `plot_engine.SUPPORTED_KINDS` 为准，`plot_engine.KINDS` 是元数据源，
`server.py` 通过 `/api/themes` 的 `kinds` 原样下发给前端（新增图型只需改 `KINDS` 一处）。

### 6.1 双纵轴（次要 Y 轴）

`series` 项新增字段 `"axis": "left" | "right"`（缺省 `"left"`）。
`spec` 新增字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `y2label` | str | 右轴标签，空串不显示 |
| `y2scale` | `"linear"` \| `"log"` \| `"symlog"` | 右轴刻度，缺省 `linear` |
| `y2lim` | `[a,b]` \| null | 右轴范围 |
| `y2_color` | `"#rrggbb"` \| null | 右轴（脊柱/刻度/标签）配色，见下 |

引擎行为（`core/plot_engine.py`）：

- 只有当 **`spec["series"]` 里存在 `axis=="right"` 且 kind ∈ `_TWIN_OK_KINDS`** 时才建双轴；
  `_TWIN_OK_KINDS = ("line", "scatter", "line_marker", "errorbar", "bar")`。
  其余图型（含 pie / heatmap / box / violin / hist / qq / residual / 全部 3D）**忽略** `axis`，
  照旧全画在左轴，不得报 ValueError。
- 双轴时 `ax2 = ax.twinx()`；左侧画 `axis=="left"` 的序列，右侧画 right 的。
- **颜色不能撞车**：右侧调色板整体旋转 nLeft 位
  （`pal[nLeft:] + pal[:nLeft]`），使右侧第 i 条拿到 `pal[(nLeft+i) % len(pal)]`。
  用户对某条序列显式指定了 `color` 时，以显式值为准（`_color()` 已经是这个语义）。
- 右轴配色 `y2_color` 缺省取**右侧第一条序列最终实际使用的颜色**；
  一条右侧序列都没有时取 `palette[1 % len(palette)]`。
  右轴 spine / tick_params / ylabel 全部用这一种颜色画，左轴保持主题前景色 —— 这就是
  「用颜色区分左右轴」的完整含义。
- 图例**合并画在左轴 `ax` 上**（把左右两边的 handles/labels 拼起来），避免出现两个图例框。
- `spec["fit"]` 的拟合曲线与公式标注只画在左轴。
- 右轴的 log / 范围处理与左轴同源，但读 `y2scale` / `y2lim`。
- **单、多子图两条分支都必须支持**：建议抽一个公用的 `_draw_with_twin()`，
  由 `render_bytes_meta` 与 `_build_panel_figure` 各自调用。
- `panels_geo` 结构与数量不变（一个面板仍然只有一个矩形）。

### 6.2 三维图（`projection="3d"`）

新增 4 个 kind，`group` 一律 `"三维"`，`need_fit` 一律 `False`：

| kind | name | need_x | need_z | need_matrix | 说明 |
|---|---|---|---|---|---|
| `scatter3d` | 三维散点 | True | True | False | X/Y/Z 三列的点云 |
| `line3d` | 三维折线 | True | True | False | X/Y/Z 三列的空间曲线 |
| `surface3d` | 三维曲面 | True | False | True | 矩阵 Z，`plot_surface` + colorbar |
| `bar3d` | 三维柱状 | True | False | True | 矩阵 Z，`bar3d` 逐柱绘制 |

数据格式：

- `need_z` 的图型：`series` 每项用 `{"name","x":[...],"y":[...],"z":[...]}`，三条数组必须等长。
- `need_matrix` 的图型：`spec["matrix"] = {"values": [[z...]...],
  "xlabels": [...], "ylabels": [...]}`，`values` 第 i 行第 j 列对应 `(xlabels[j], ylabels[i])`。
  找不到 `xlabels`/`ylabels` 时退回 `labels`，再退回列序号 `0,1,2…`（字符串化）。
- `spec["zlabel"]` 是 Z 轴标签，缺省用 Y 轴标签同名文案或空串。

渲染要求：

- 单图分支：`kind` 属于 3D 时用
  `plt.subplots(figsize=..., dpi=..., subplot_kw={"projection": "3d"})`。
- 多面板分支：**必须先解析出 `merged["kind"]` 再决定 `add_subplot` 的 projection**，
  现在是先建 ax 后解析 —— 三维进来会画成二维（必须调整语句顺序）。
- `_finalize` 对 3D 分支的特殊处理（共享 `if kind in _KINDS_3D:` 判断）：
  - **跳过** scale（`set_zscale` / log 不支持）、**跳过** `set_axisbelow`、
    **跳过** 隐藏/着色 top/right spine
  - `set_zlabel(zlabel, color=fg, fontsize=fs)`；`tick_params` 照常（labelsize 与 2D 一致）
  - `ax.grid(bool(use_grid))` 直接调用，不用 `linestyle` 参数组合
  - 标题 pad 保持 `10`，但画完后 `fig.subplots_adjust(top=0.90)` 让标题不压坐标轴（仅 3D）
- 视角：`spec["extra"]["elev"]` / `["azim"]`，缺省 24 / -60，放在 draw 之前 `ax.view_init`。
- colorbar 只有 `surface3d` / `bar3d` 有：`fig.colorbar(surf, ax=ax, shrink=0.62, pad=0.10)`。
- `bar3d` 的柱子宽深：按 x/y 相邻间距的 0.6 倍，退化到 1 列时用 0.6。
- mplot3d 随 matplotlib 自带，不必额外安装；mpl 3.10 下 `Axes3D` **有** `spines` 与
  `tick_params`（已实测），但语义与 2D 不同，所以按上面规则跳过。

### 6.3 server.py 侧必须同步的校验

`_sanitize_series()` 目前逐字段清洗 x/y/yerr/color，新增两个字段的清洗规则：

- `axis`：`str(...).lower()`，只接受 `"left" | "right"`，其余一律落成 `"left"`
- `z`：存在且是 list 时过 `_clean_values()`，并按与 x/y 相同的方式截断到
  `min(len(x), len(y), len(z))`；没有 z 时**不要**塞 `"z": []` 空列表占位
  （3D 之外的图型后端不得出现空 z）

`spec` 顶层的 `y2label` / `y2scale` / `y2lim` / `zlabel` 需在 `_sanitize_spec()` 里做类型收敛：
字符串截断 80 字符；`y2scale` 只接受 `"linear" | "log" | "symlog"`；
`y2lim`/`zlim` 是两元数值数组。面板级字段在 `_sanitize_panel()` 里同样收敛，
并且与 `xscale`/`yscale` 一样，**不得进入 `_PANEL_LOCKED`**（要允许逐子图不同）。

## 7. server.py 契约（子 Agent 只读了解，不修改）

统一响应包：`{"ok":true, ...}` / `{"ok":false,"error":"..."}`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 返回 web/index.html |
| GET | `/static/<path>` | 静态资源（web 目录） |
| POST | `/api/upload` | `{filename, data_b64}` → 数据集清单 |
| POST | `/api/preview` | `{ds, sheet, limit}` → 前 N 行 + 列信息 |
| POST | `/api/stats/describe` | `{ds, sheet, cols}` |
| POST | `/api/stats/uncertainty` | 不确定度综合 |
| POST | `/api/stats/test` | 假设检验 |
| POST | `/api/stats/fit` | 拟合 |
| POST | `/api/plot/render` | 返回 `{png_b64, svg, spec}` |
| POST | `/api/plot/export` | 保存到 output/，返回绝对路径 |
| POST | `/api/data/export` | 导出处理后数据 xlsx/csv |
| GET | `/api/themes` | 主题 + 配色 + 模型清单 |

## 8. 子 Agent 交付要求

- 只写自己负责的文件，**不要**碰别人的文件，**不要**改 server.py / dataloader.py
- 写完必须自测：用 `C:\Users\a3141\.conda\envs\NAMEbutNOidea\python.exe` 跑一个临时脚本验证（临时脚本放 `%TEMP%`，不要留在项目里）
- 报告：文件路径、行数、导出的函数清单、自测结果摘要（含实际跑出的数值）
