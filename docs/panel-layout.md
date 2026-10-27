# 多子图布局约定（跨面板 / 拖拽重排）

本文件是 `core/plot_engine.py` + `server.py`（后端）与 `web/js/03,04,05,07`（前端）
之间的接口契约。两边必须同时满足，任何一侧单独实现都会对不上。

## 一、数据模型

### 1.1 网格

- `grid_shape: [rows, cols]`，均为 1–4 的整数，最多 16 格。
- 网格是"画布"，格数 ≠ 面板数：面板可以跨格占位，所以 `len(panels) ≤ rows*cols`。

### 1.2 面板占位

每个面板带一个 `area`：

```json
"area": [row, col, rowSpan, colSpan]
```

- 全部是 **0 基整数**，单位是网格格。
- 合法条件：`0 ≤ row`，`0 ≤ col`，`row + rowSpan ≤ rows`，`col + colSpan ≤ cols`，`rowSpan ≥ 1`，`colSpan ≥ 1`。
- 缺省 `area`（老前端 / 老会话）时，后端按"从上到下、从左到右的第一个空闲格"自动放 1×1。
- **不变量：同一网格内任意两个 area 不得重叠。**

### 1.3 放置顺序与编号

- 面板编号 `(a)(b)(c)…` 按 **area 的阅读顺序**（先 `row` 再 `col`）分配，**不是**数组下标。
- 前端始终显式下发 `panel_label`，后端不要自己重排编号。

### 1.4 无法放置的面板

- 后端遇到"格子已被占 / area 越界且修不回来"的面板时：**跳过它**（不渲染），
  计入 `dropped`，绝不覆盖别的面板、也不报错。
- 前端可能保留"暂时没位置"的面板（例如用户把 (a) 扩成跨两列、(b) 被挤掉）。
  这类面板 `area = null`，不参与渲染、不出现在面板条里，但**留在 `state.panels` 里**，
  布局放大后可以重新放回去（撤销也要能还原）。

## 二、后端职责

### 2.1 `server._sanitize_spec()`

- 解析 `grid_shape`（沿用现有 `_clamp`，1–4）。
- 逐面板调用 `_sanitize_panel()`，其中 **新增 `area` 解析**：

```python
out["area"] = _sanitize_area(p.get("area"), rows, cols)
# 返回 [row, col, rowSpan, colSpan] 或 None；越界一律收敛到网格内
```

- 全部面板过完后做一次**占位裁决**（放在 `_sanitize_spec` 里，因为它知道 rows/cols）：

```python
occupied = [[False] * cols for _ in range(rows)]
kept, dropped = [], 0
for panel in panels:
    area = panel.get("area")
    if area and _area_free(occupied, area):
        _mark(occupied, area); panel["area"] = area; kept.append(panel)
    else:
        spot = _first_free(occupied, rows, cols,                    # 优先按原 span 找空位
                           area[2] if area else 1, area[3] if area else 1)
        if spot:
            _mark(occupied, spot); panel["area"] = spot; kept.append(panel)
        else:
            dropped += 1
spec["panels"] = kept
spec["panels_dropped"] = dropped
```

- `spec["grid"]` 仍然输出 `[rows, cols]`（list 表示形状，bool 表示网格线，引擎里一键两义，
  这个约定不变）。

### 2.2 `plot_engine._build_panel_figure()`

- 改用 `GridSpec`：

```python
fig = plt.figure(figsize=(w, h), dpi=dpi, facecolor=bg)
gs = fig.add_gridspec(rows, cols, wspace=..., hspace=...)
ax = fig.add_subplot(gs[r:r + rs, c:c + cs])
```

- **不再** `plt.subplots(rows, cols)`，也不再"多余 ax 隐藏"——没被占用的格子根本不建 ax。
- `share_axes` 为真时，后续 ax 传 `sharex=first_ax, sharey=first_ax`；共用失败（类别轴等）
  仍然退化为不共享。
- 每个面板的绘制流程保持不变：`_DRAWERS[kind]` → `_draw_fit` → `_draw_annotations` →
  `_finalize` → `_draw_panel_label`。
- `fig.tight_layout()` 之后（**必须是之后**，否则 axes 位置还没定）收集几何信息：

```python
geo.append({
    "index": i,                       # 在 panels 数组里的下标
    "area": [r, c, rs, cs],
    "label": label,                   # "(a)"
    "rect": [x0, y0, w0, h0],         # ax.get_position()，figure 比例，原点左下
})
```

### 2.3 渲染响应

`/api/plot/render` 与 `/api/plot/export` 的返回体新增：

```json
"panels_geo": [{"index": 0, "area": [0,0,1,2], "label": "(a)", "rect": [0.09,0.55,0.42,0.38]}],
"panels_dropped": 0
```

- `rect` 是 **figure 比例**（0–1），原点在**左下**（matplotlib 约定）。
- 前端换算成 CSS：`left = x0*W`，`top = (1 - y0 - h0)*H`，`width = w0*W`，`height = h0*H`。
- 单图（无 panels）时 `panels_geo` 返回 `[]`。

## 三、前端职责

### 3.1 布局选择

- 保留现有 `1×1 / 1×2 / 2×1 / 2×2` 快捷按钮。
- 新增**自定义行列**：两个 1–4 的数字步进（行 / 列），改完立即重排。
- 切布局时尽量保留已有 `area`：放得下就留着，放不下就重新找空位，实在没位置就
  `area = null`（不渲染但保留配置）。

### 3.2 跨格

- 面板条上给"当前面板"两个开关：**跨 2 列 / 跨 2 行**（可同时开 = 2×2 大图）。
- 打开时会**吃掉**被覆盖的面板：那些面板 `area = null`（留在 `state.panels`，不渲染）。
- 关闭时把 span 收回 1，被吃掉的面板若还有空位就自动放回去。
- 跨格受网格边界限制（2 列的最后一行不能再跨列）。

### 3.3 鼠标拖拽（画布上直接拖子图）

- 渲染成功后，用 `panels_geo` 在画布上叠一层**透明占位层**，每个面板一个 div，
  尺寸/位置与图上子图一致（image 与占位层必须在**同一个 transform 容器**里，
  否则缩放后错位；`applyZoom()` 改成变换外层容器 `#chartStage`，img 和占位层都在里面）。
- 左键按住某个面板拖动：
  - 悬停到**另一个面板**上松手 → 两者交换 `area`（位置和大小都换，内容跟着面板走）。
  - 悬停到**空格子**上松手 → 该面板移到该格（span 保持，放不下就按 1×1）。
  - 松手后 `pushHistory('移动面板')` + `scheduleRender(0)`。
- 拖动过程中目标区域要有可视化高亮；拖动中不重新渲染。
- **平移冲突**：多子图时左键拖动归"移动面板"，按住 `Shift` 才是平移画布；
  滚轮缩放保持不变。

### 3.4 兼容

- 单图（1×1，不发 `panels`）时：不建占位层、拖拽禁用、行为与现在完全一致。
- 会话恢复 / 撤销重做要把 `area` 一起存进快照。

## 四、验收

- 后端：`tests/run_all.py` 原有 50 例全过；新增 `tests/test_panel_area.py`，至少覆盖：
  合法 area 渲染、重叠 area 被裁决、越界 area 被收敛、span 2×2、dropped 计数、
  `panels_geo` 的 rect 数量与面积合理性（`w0>0`、`h0>0`、互不重叠）。
- 前端：`launcher/ui/ui_check3.js` 原有 63 断言全过；新增一节验证
  "2×2 里 (a) 跨两列 → 出 3 个面板 + 两张小图在下面"，以及"拖拽交换两个面板的 area"。
