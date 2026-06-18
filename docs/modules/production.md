# 生产出货模块 — 技术深度文档

> **适用范围**：`生产出货` Tab → `下单生产` 阶段（STAGES[9]）  
> **核心文件**：`src/features/detail/index.tsx` → `TabProd` 组件（约 408-930 行）  
> **状态管理**：`src/context/ProductContext.tsx` → 9 个专用 update 函数  
> **数据持久化**：SQLite `products` 表 JSON blob，经由 PUT `/api/products` 乐观锁同步

---

## 1. 模块定位

生产出货是整个 FBA 开发流程中**数据结构最复杂、计算链最深**的模块。它承载了从工厂下单到货物到达 FBA 仓库之间的完整资金流和物流流追踪，核心目标是回答三个问题：

1. **钱付了多少？** — 定金 + 尾款多笔支付的实际总额
2. **货发了多少？** — 已填实际出货日期的出货记录对应数量
3. **账结清了吗？** — 实际已付 vs 应结金额（含出货后的动态切换）

---

## 2. 数据模型

### 2.1 数据层次结构

```
Product
└── stages.production: StageData
    ├── status / startDate / endDate     ← 阶段级字段
    └── batches: Batch[]                 ← 生产批次列表

Batch
├── id / batchNo / factory
├── orderDate / expectedShip
├── qty / unitPrice                      ← 无变体时使用
├── depositPct / depositActual / depositDate
├── balancePct / balanceAmt* / balanceDate*   ← *旧字段，已被 balancePayments 替代
├── note / status
├── items: BatchItem[]                   ← SKU 明细（有变体时使用）
├── extraCosts: ExtraCost[]              ← 其他费用
├── shipments: Shipment[]                ← 出货记录
└── balancePayments: BalancePayment[]    ← 尾款支付记录（多笔）

BatchItem
└── id / variantId / variantName / qty / unitPrice

ExtraCost
└── id / name / qty / unitPrice

Shipment
├── id / status
├── expectedShip / shipDate              ← ⚠️ shipDate 是"生效开关"
├── qty                                  ← 无变体时使用
├── items: ShipmentItem[]                ← 有变体时使用
├── method / carrier / tracking
├── fbaShipId / etaDate / note
└── items[]: { id, variantId, variantName, qty }

BalancePayment
└── id / amount / date / shipmentRef / note
```

### 2.2 关键字段说明

| 字段 | 类型 | 说明 | 注意事项 |
|---|---|---|---|
| `b.qty` | number | 无变体时的总下单数量 | 有变体时此字段无效，用 `items[].qty` 之和 |
| `b.unitPrice` | number | 无变体时的单价 | 有变体时此字段无效，各 SKU 有独立单价 |
| `b.depositPct` | number | 预付款比例 (%) | 用于计算理论预付款，不影响实付判断 |
| `b.depositActual` | number | **实际**支付的预付款金额 | 影响 `actualTotalPaid` 和 `paidComplete` |
| `b.balancePct` | number | 尾款比例 (%) | 若未填则自动补为 `max(0, 100 - depositPct)` |
| `b.balancePayments[]` | array | 多笔尾款记录 | 优先于旧字段 `balanceAmt`/`balanceDate` |
| `b.balanceAmt` | number | **已废弃**，旧版单笔尾款 | 仅在 `balancePayments` 为空时作兜底 |
| `sh.shipDate` | string | **实际出货日期** | 这是整个模块最关键的字段，见第 4 节不变量 |
| `sh.expectedShip` | string | 计划出货日期 | 仅展示用，不影响任何计算 |
| `bp.shipmentRef` | string | 关联的出货记录 id | 仅记录用，当前未参与计算逻辑 |

### 2.3 存储方式

所有生产数据以 JSON blob 存储在 SQLite `products` 表的 `data` 字段中，没有独立的关系表。这意味着：

- **读写是整个产品级别**的，每次修改任意字段都触发完整产品对象的 PUT
- **没有行级锁**，并发编辑依靠乐观锁（`version` 字段）
- 批次、出货记录的 `id` 由前端 `uid()` 生成（时间戳 + 随机数），非数据库自增

---

## 3. 核心计算链

### 3.1 变量依赖关系图

```mermaid
graph TD
    A["b.qty / b.items[].qty<br/>b.unitPrice / b.items[].unitPrice"] -->|"无/有变体分支"| B["skuSubtotal<br/>SKU小计"]
    C["b.extraCosts[].qty<br/>b.extraCosts[].unitPrice"] --> D["extraSubtotal<br/>其他费用小计"]
    B --> E["skuTotal<br/>订单金额 = skuSubtotal + extraSubtotal"]
    D --> E

    F["b.shipments[]<br/>.filter(sh => !!sh.shipDate)"] --> G["validShipments<br/>有效出货记录"]
    G -->|"无变体: sh.qty × b.unitPrice<br/>有变体: Σ si.qty × 匹配SKU单价"| H["actualShippedValue<br/>实际出货金额（不含extraCosts）"]

    H -->|"> 0"| I{"effectiveTotal<br/>结算基准"}
    E -->|"= 0"| I
    I -->|"有出货时"| J["= actualShippedValue"]
    I -->|"无出货时"| K["= skuTotal"]

    L["b.depositActual"] --> N["actualTotalPaid<br/>已付总金额"]
    M["Σ balancePayments[].amount<br/>（兼容旧 balanceAmt）"] --> N

    N --> O{"paidComplete"}
    I --> O
    O -->|"actualTotalPaid ≥ effectiveTotal"| P["✓ 已付清"]
    O -->|"0 < actualTotalPaid < effectiveTotal"| Q["未付清 ¥差额"]
    O -->|"actualTotalPaid = 0"| R["未付款"]

    style I fill:#f90,color:#fff
    style H fill:#e88,color:#fff
    style N fill:#6b9,color:#fff
```

### 3.2 金额计算链（完整公式）

**第一层：订单金额**
```
skuSubtotal  = 有变体 ? Σ(item.qty × item.unitPrice)
                       : b.qty × b.unitPrice

extraSubtotal = Σ(cost.qty × cost.unitPrice)

skuTotal = skuSubtotal + extraSubtotal          ← "订单金额"字段展示值
```

**第二层：实际出货金额**
```
validShipments = b.shipments.filter(sh => !!sh.shipDate)

actualShippedValue（无变体）= Σ validShipments: sh.qty × b.unitPrice
actualShippedValue（有变体）= Σ validShipments: Σ sh.items:
                                si.qty × b.items.find(variantId).unitPrice

⚠️ actualShippedValue 故意不含 extraCosts
```

**第三层：结算基准切换（最关键的逻辑）**
```
effectiveTotal = actualShippedValue > 0 ? actualShippedValue
                                        : skuTotal
```

**第四层：付款核算**
```
effBps = balancePayments.length > 0 ? balancePayments
                                     : balanceAmt > 0 ? [{ amount: balanceAmt }]  ← 旧字段兜底
                                                      : []

tailPaid        = Σ effBps.amount
actualTotalPaid = depositActual + tailPaid

paidComplete    = effectiveTotal > 0 && actualTotalPaid >= effectiveTotal
```

**理论金额（仅展示，不影响付清判断）**
```
theorDeposit = skuTotal × depositPct / 100
theorBalance = skuTotal × balancePct / 100      ← ⚠️ 注意：基于 skuTotal 而非 effectiveTotal
```

### 3.3 数量计算链

```
orderQty（无变体）= b.qty
orderQty（有变体）= Σ b.items[].qty

shippedQty（无变体）= Σ validShipments: sh.qty
shippedQty（有变体）= Σ validShipments: Σ sh.items[].qty

pendingQty = orderQty - shippedQty
  pendingQty > 0   → 待出货 N pcs
  pendingQty = 0   → ✓ 全部出货
  pendingQty < 0   → ⚠️ 超出订单数量
```

### 3.4 标题行汇总（跨批次聚合）

```
totalOrderQty  = Σ all batches: orderQty(b)
totalSettlement = Σ all batches: effectiveTotal(b)

skuQtyMap（有变体时）= { variantId → { name, qty: Σ across batches } }
                      → 用于悬浮 tooltip 展示各 SKU 总下单数
```

---

## 4. 业务流程

### 4.1 标准生命周期

```mermaid
sequenceDiagram
    participant U as 用户
    participant S as 系统

    U->>S: 创建生产批次（填批次号/工厂/下单日期）
    S-->>U: 显示空批次卡片，订单金额=0，状态=未付款

    U->>S: 填写 SKU 明细或数量+单价（+其他费用）
    S-->>U: 实时计算 skuTotal，展示订单金额

    U->>S: 填写预付款比例 + 实际预付款
    S-->>U: effectiveTotal=skuTotal（无出货），已付=depositActual

    U->>S: 添加出货记录（仅填预计出货日期，shipDate留空）
    S-->>U: 出货记录创建，但 validShipments 仍为空，所有计算不变

    U->>S: 填写实际出货日期（shipDate）
    S-->>U: ⚡ validShipments 更新 → actualShippedValue 重算
    Note over S: 若 actualShippedValue < skuTotal<br/>effectiveTotal 切换为 actualShippedValue

    U->>S: 添加尾款支付记录（金额+日期）
    S-->>U: tailPaid 更新 → actualTotalPaid 重算 → 判断是否付清
```

### 4.2 effectiveTotal 切换逻辑

```mermaid
flowchart TD
    A[批次创建] --> B{是否有 validShipments?}
    B -->|否 shipDate全为空| C["effectiveTotal = skuTotal<br/>按全额订单结算"]
    B -->|是 至少一条有shipDate| D["effectiveTotal = actualShippedValue<br/>按实际出货金额结算"]
    D --> E{actualShippedValue vs skuTotal}
    E -->|相等 全量出货且无extraCosts| F["绿色显示，已全额结算"]
    E -->|不等 部分出货或有extraCosts| G["橙色显示，差额待结算"]
    C --> H{actualTotalPaid vs effectiveTotal}
    D --> H
    H -->|">="| I["✓ 已付清（绿色）"]
    H -->|"> 0 且 <"| J["未付清 ¥X（橙色）"]
    H -->|"= 0"| K["未付款（橙色）"]
```

### 4.3 付款状态判定树

```mermaid
flowchart LR
    A["effectiveTotal = 0?"] -->|是，未填定价| B["不显示付款状态"]
    A -->|否| C["actualTotalPaid ≥ effectiveTotal?"]
    C -->|是| D["✓ 已付清"]
    C -->|否| E["actualTotalPaid > 0?"]
    E -->|是| F["未付清 ¥差额"]
    E -->|否| G["未付款"]
```

---

## 5. 关键不变量

> 这三条规则是整个模块的设计基础，违反任何一条都会导致计算错误。

**不变量 1：shipDate 是唯一生效开关**
```
只有 shipDate 非空的出货记录才计入以下所有计算：
- shippedQty（已出货数量）
- actualShippedValue（实际出货金额）
- effectiveTotal（当 > 0 时切换基准）

预先创建的"计划中"出货记录（shipDate 为空）对任何数字均无影响。
```

**不变量 2：actualShippedValue 不含 extraCosts**
```
actualShippedValue = Σ validShipments: 出货数量 × SKU单价

其他费用（代采配件/国内运费等）不随出货记录分摊，
始终体现在 skuTotal 中，不进入 effectiveTotal 的出货分支。

⚠️ 业务影响：如果工厂分批出货，effectiveTotal 会低于 skuTotal，
   差额（其他费用部分）暂无对应的结算金额，需要注意是否符合实际付款协议。
```

**不变量 3：balancePayments 的兼容降级顺序**
```
effBps = balancePayments.length > 0
         ? balancePayments                          ← 优先使用多笔记录
         : balanceAmt > 0
           ? [{ amount: balanceAmt, date: balanceDate }]  ← 旧版单笔兜底
           : []                                     ← 无尾款记录

此逻辑在 batchMeta 和 payment section 中各出现一次，
两处必须保持一致，修改时需同步更新。
```

---

## 6. 已知问题

### P1 — `shippedQty` 在同一批次内重复计算（代码质量）

**位置**：`index.tsx` ~507 行（batchMeta 区域）和 ~795 行（出货明细区块）

```tsx
// 第一次（~507）
const validShipments = (b.shipments||[]).filter((sh: any) => !!sh.shipDate);
const shippedQty = validShipments.reduce(...)

// 第二次（~795，重新从 b.shipments 过滤）
const shippedQty = (b.shipments||[]).filter((sh: any) => !!sh.shipDate).reduce(...)
```

相同逻辑写两遍，维护时改一处容易漏另一处。**建议**：提取为批次级别的局部计算对象，全批次复用。

---

### P2 — `tailRemain` 死代码（代码质量）

**位置**：`index.tsx` ~686 行（付款条款 IIFE 内）

```tsx
const tailRemain = theorBalance - tailPaid;  // 计算后从未使用
```

`theorBalance` 基于 `skuTotal × balancePct%`，而"应结尾款"实际展示的是 `effectiveTotal - depositActual`，两者语义不同，`tailRemain` 是遗留变量。**建议**：直接删除。

---

### P3 — `balancePayments` 兼容逻辑重复（可维护性）

**位置**：`index.tsx` ~523 行（`effBpsMeta`）和 ~681 行（`effBps`）

两处实现完全相同但变量名不同，若未来旧字段迁移完成需要删除兼容逻辑，容易遗漏其中一处。**建议**：提取为 `getEffectiveBalancePayments(b)` 工具函数。

---

### P4 — `theorBalance` 基于 `skuTotal` 而非 `effectiveTotal`（业务逻辑）

**位置**：`index.tsx` ~503 行

```tsx
const theorBalance = +(skuTotal * balancePct / 100).toFixed(2);  // 基于订单金额
// 但"应结尾款"展示的是：
Math.max(0, effectiveTotal - depositActual)                       // 基于结算基准
```

两个"尾款"概念并存：理论尾款（基于订单）和实际应结尾款（基于 effectiveTotal）。当有部分出货时，两者会出现差异，容易造成用户困惑。**建议**：统一口径，"应结尾款"改为 `max(0, effectiveTotal - depositActual)`（现已如此），将 `theorBalance` 仅用于"理论参考值"并在 UI 上明确标注。

---

### P5 — 无定价时付款状态误报"未付款"（用户体验）

**位置**：`index.tsx` ~540 行

当批次刚创建、单价未填时 `effectiveTotal = 0`，此时：
```tsx
paidComplete = effectiveTotal > 0 && ...  // false
paidClass = 'rmc-warn'                    // 橙色
显示 "未付款"
```

批次刚建还没填价格，就显示橙色"未付款"，误导性强。**建议**：增加判断，`effectiveTotal = 0` 时不渲染付款状态 chip。

---

### P6 — 整个模块零 TypeScript 类型约束（类型安全）

**位置**：`types.ts`、`ProductContext.tsx`、`index.tsx`

`stages: Record<string, any>` 导致 `b`、`sh`、`bp` 等全为 `any`，编译器无法发现：
- 字段名拼写错误（如 `sh.shipdate` vs `sh.shipDate`）
- 数值/字符串混用（如 `b.qty` 有时是 `""` 空字符串）
- 删除字段后引用处未同步更新

**建议**：为生产模块定义专用接口（见第 7 节），优先级可以排在功能稳定后。

---

## 7. 优化建议

### 7.1 代码层面（优先级：高）

**重构：提取批次计算函数**

当前批次内的所有计算（~20 个变量）散落在一个大 `map` 回调里，且部分重复。建议提取为纯函数：

```tsx
function computeBatch(b: Batch, hasVariants: boolean, variants: Variant[]) {
  const skuSubtotal = ...;
  const extraSubtotal = ...;
  const skuTotal = ...;
  const validShipments = ...;
  const shippedQty = ...;
  const actualShippedValue = ...;
  const effectiveTotal = ...;
  const orderQty = ...;
  const pendingQty = ...;
  const effBps = getEffectiveBalancePayments(b);
  const tailPaid = ...;
  const actualTotalPaid = ...;
  const paidComplete = ...;
  return { skuSubtotal, skuTotal, effectiveTotal, shippedQty, actualTotalPaid, paidComplete, ... };
}
```

好处：消除重复计算，单元测试友好，逻辑一处维护。

**删除死代码**

```tsx
// 删除以下两行：
const tailRemain = theorBalance - tailPaid;
// theorBalance 若仅用于展示可保留，否则一并删除
```

**提取兼容函数**

```tsx
function getEffectiveBalancePayments(b: any) {
  const bps = b.balancePayments || [];
  if (bps.length > 0) return bps;
  if (Number(b.balanceAmt) > 0)
    return [{ id: b.id + '-bp0', amount: Number(b.balanceAmt), date: b.balanceDate || '', note: '' }];
  return [];
}
```

### 7.2 业务逻辑层面（优先级：中）

**明确 extraCosts 的结算归属**

当前其他费用不计入 `actualShippedValue`。需要与实际业务对齐：

- **方案 A（现状）**：其他费用一次性全额在订单签订时确认，不随出货分摊 → `effectiveTotal` 在部分出货时只含 SKU 金额，其他费用差额需单独追踪
- **方案 B**：其他费用按出货比例分摊 → `actualShippedValue += extraSubtotal × (shippedQty / orderQty)`

**增加无定价保护**

```tsx
// 建议修改付款 chip 渲染条件：
{effectiveTotal > 0 && orderQty > 0 && <span ...>...</span>}
//                    ↑ 增加：有下单数量才显示，否则可能是空批次
```

### 7.3 类型安全（优先级：低，但长期价值高）

建议在 `types.ts` 中补充：

```typescript
interface BatchItem {
  id: string;
  variantId: string;
  variantName: string;
  qty: number;
  unitPrice: number;
}

interface ExtraCost {
  id: string;
  name: string;
  qty: number;
  unitPrice: number;
}

interface ShipmentItem {
  id: string;
  variantId: string;
  variantName: string;
  qty: number;
}

interface Shipment {
  id: string;
  status: string;
  expectedShip: string;
  shipDate: string;          // 核心字段：非空才生效
  qty: number;               // 无变体时
  items: ShipmentItem[];     // 有变体时
  method: string;
  carrier: string;
  tracking: string;
  fbaShipId: string;
  etaDate: string;
  note: string;
}

interface BalancePayment {
  id: string;
  amount: number;
  date: string;
  shipmentRef: string;
  note: string;
}

interface ProductionBatch {
  id: string;
  batchNo: string;
  factory: string;
  orderDate: string;
  expectedShip: string;
  qty: number;
  unitPrice: number;
  depositPct: number;
  depositActual: number;
  depositDate: string;
  balancePct: number;
  balanceAmt?: number;       // 废弃字段，保留兼容
  balanceDate?: string;      // 废弃字段，保留兼容
  status: string;
  note: string;
  items: BatchItem[];
  extraCosts: ExtraCost[];
  shipments: Shipment[];
  balancePayments: BalancePayment[];
}
```

---

## 8. 模块健康度评估

| 维度 | 评分 | 说明 |
|---|---|---|
| 业务逻辑完整性 | ★★★★☆ | 核心流程完整，extraCosts 结算归属有歧义 |
| 代码可维护性 | ★★★☆☆ | 计算逻辑重复、类型全 any、单函数过长 |
| 类型安全 | ★★☆☆☆ | 全模块 any，编译器无保护 |
| 用户体验 | ★★★★☆ | 信息密度高，空批次状态误报是主要问题 |
| 数据一致性 | ★★★★☆ | 乐观锁保证多人协作，单人使用无问题 |

---

*文档生成日期：2026-06-18 | 对应代码版本：commit f0c327e 之后*  
*关联文档：`docs/business-overview.md` §2.2-2.3 / `CLAUDE.md` §已知大文件*
