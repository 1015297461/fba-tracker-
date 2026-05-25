/* eslint-disable no-undef */
// FBA Tracker — data model with editable per-stage status + dates

const STAGES = [{
  key: 'initiation',
  name: '选品立项',
  short: '立项',
  color: '#3b82f6',
  tab: 'eval'
}, {
  key: 'research',
  name: '竞品调研',
  short: '调研',
  color: '#6366f1',
  tab: 'eval'
}, {
  key: 'profit',
  name: '利润测算',
  short: '利润',
  color: '#8b5cf6',
  tab: 'eval'
}, {
  key: 'bom',
  name: 'BOM成本拆解',
  short: 'BOM',
  color: '#a855f7',
  tab: 'eval'
}, {
  key: 'supplier',
  name: '供应商开发',
  short: '供应商',
  color: '#d946ef',
  tab: 'sup'
}, {
  key: 'sampling',
  name: '打样/改版',
  short: '打样',
  color: '#ec4899',
  tab: 'sup'
}, {
  key: 'cert',
  name: '认证合规',
  short: '认证',
  color: '#f43f5e',
  tab: 'sup'
}, {
  key: 'packaging',
  name: '包装设计',
  short: '包装',
  color: '#f97316',
  tab: 'design'
}, {
  key: 'visuals',
  name: '视觉素材',
  short: '视觉',
  color: '#f59e0b',
  tab: 'design'
}, {
  key: 'production',
  name: '下单生产',
  short: '生产',
  color: '#eab308',
  tab: 'prod'
}, {
  key: 'qc',
  name: '品控验货',
  short: '品控',
  color: '#84cc16',
  tab: 'prod'
}, {
  key: 'shipment',
  name: '出货物流',
  short: '出货',
  color: '#22c55e',
  tab: 'prod'
}, {
  key: 'keywords',
  name: '关键词研究',
  short: '关键词',
  color: '#10b981',
  tab: 'ops'
}, {
  key: 'listing',
  name: 'Listing上架',
  short: '上架',
  color: '#14b8a6',
  tab: 'ops'
}, {
  key: 'handover',
  name: '产品交接',
  short: '交接',
  color: '#06b6d4',
  tab: 'ops'
}, {
  key: 'promotion',
  name: '广告推广',
  short: '推广',
  color: '#0ea5e9',
  tab: 'ops'
}, {
  key: 'reorder',
  name: '返单管理',
  short: '返单',
  color: '#0284c7',
  tab: 'review'
}, {
  key: 'review',
  name: '产品复盘',
  short: '复盘',
  color: '#64748b',
  tab: 'review'
}];
const TABS = [{
  key: 'eval',
  icon: '📋',
  name: '立项评估'
}, {
  key: 'sup',
  icon: '🏭',
  name: '供应商/打样'
}, {
  key: 'design',
  icon: '🎨',
  name: '内容设计'
}, {
  key: 'prod',
  icon: '📦',
  name: '生产出货'
}, {
  key: 'ops',
  icon: '🛒',
  name: '上架运营'
}, {
  key: 'review',
  icon: '🔄',
  name: '返单复盘'
}];
const STAGE_STATUSES = [{
  value: 'idle',
  label: '未开始',
  color: '#9a9a96',
  bg: 'rgba(154,154,150,0.15)'
}, {
  value: 'active',
  label: '进行中',
  color: '#ea580c',
  bg: 'rgba(234,88,12,0.13)'
}, {
  value: 'done',
  label: '已完成',
  color: '#16a34a',
  bg: 'rgba(22,163,74,0.13)'
}, {
  value: 'hold',
  label: '暂停',
  color: '#9333ea',
  bg: 'rgba(147,51,234,0.13)'
}];
const STATUS_LABELS = {
  all: {
    label: '全部',
    color: '#6b6b6b'
  },
  active: {
    label: '进行中',
    color: '#16a34a'
  },
  hold: {
    label: '已暂停',
    color: '#ea580c'
  },
  done: {
    label: '已完成',
    color: '#2563eb'
  },
  cancel: {
    label: '已取消',
    color: '#9a9a96'
  }
};

// helper to build a stage with status/dates
function S(opts) {
  return Object.assign({
    status: 'idle',
    startDate: '',
    endDate: ''
  }, opts || {});
}

// ====== PRODUCTS ======
const PRODUCTS = [{
  id: 'p001',
  name: '便携式手持挂烫机 V2',
  sku: 'HS-PRT-240',
  category: '小家电 / 衣物护理',
  status: 'active',
  lead: '张明',
  createdAt: '2026-01-08',
  currentStage: 'production',
  progress: 56,
  stages: {
    initiation: S({
      status: 'done',
      startDate: '2026-01-08',
      endDate: '2026-01-09',
      lead: '张明',
      source: '关键词工具 / Helium 10',
      market: '美国 US',
      reason: '搜索量同比上升 43%, 评论多痛点 (加热慢/漏水)，差异化空间足'
    }),
    research: S({
      status: 'done',
      startDate: '2026-01-10',
      endDate: '2026-01-12',
      monthSales: 18420,
      competitorCount: 32,
      avgPrice: 39.99,
      topAsin: 'B09XYZK123',
      avgRating: 4.1,
      painPoints: '加热慢、漏水、续航差',
      opportunity: 'A'
    }),
    profit: S({
      status: 'done',
      startDate: '2026-01-13',
      endDate: '2026-01-15',
      targetPrice: 42.99,
      taxRate: 13,
      taxIncl: 48.58,
      cogs: 9.80,
      shipping: 2.10,
      fbaFee: 5.85,
      referralPct: 15,
      adPct: 12,
      otherCost: 0.80,
      decision: 'pass',
      decisionNote: '净利率 12.5%, 通过, 等 BOM 二轮拆解'
    }),
    bom: S({
      status: 'done',
      startDate: '2026-01-16',
      endDate: '2026-01-18',
      items: [{
        id: 'b1',
        name: '陶瓷加热板 800W',
        spec: '85×40mm / 220V',
        cat: '电源/电池',
        qty: 1,
        unitCost: 2.40
      }, {
        id: 'b2',
        name: '微型水泵',
        spec: 'DC 3.7V 静音型',
        cat: '电机/马达',
        qty: 1,
        unitCost: 1.20
      }, {
        id: 'b3',
        name: '锂电池组',
        spec: '2200mAh 18650 ×1',
        cat: '电源/电池',
        qty: 1,
        unitCost: 1.85
      }, {
        id: 'b4',
        name: 'ABS+PC 外壳',
        spec: '注塑 阻燃 V0',
        cat: '模具/外壳',
        qty: 1,
        unitCost: 1.05
      }, {
        id: 'b5',
        name: '硅胶水箱',
        spec: '120ml 食品级',
        cat: '面料/布料',
        qty: 1,
        unitCost: 0.45
      }, {
        id: 'b6',
        name: '电源开关组件',
        spec: '三档 LED 指示',
        cat: '开关/控制',
        qty: 1,
        unitCost: 0.32
      }, {
        id: 'b7',
        name: 'Type-C 接口板',
        spec: 'PD 18W',
        cat: 'LED/灯珠',
        qty: 1,
        unitCost: 0.55
      }, {
        id: 'b8',
        name: '雾化喷头',
        spec: '0.3mm 不锈钢',
        cat: '其他',
        qty: 1,
        unitCost: 0.40
      }, {
        id: 'b9',
        name: '彩盒+说明书',
        spec: '300g 白卡 4C 印刷',
        cat: '包装材料',
        qty: 1,
        unitCost: 0.85
      }, {
        id: 'b10',
        name: 'FCC+ETL 认证摊销',
        spec: '按 2000pcs 摊',
        cat: '认证费',
        qty: 1,
        unitCost: 0.45
      }, {
        id: 'b11',
        name: '头程海运摊销',
        spec: 'FOB → FBA',
        cat: '物流/运费',
        qty: 1,
        unitCost: 0.10
      }],
      notes: '整体覆盖率 98%, 雾化喷头已找到二供报价更低'
    }),
    supplier: S({
      status: 'done',
      startDate: '2026-01-19',
      endDate: '2026-01-25',
      suppliers: [{
        id: 's1',
        name: '宁波昇泰电器',
        contact: '陈经理 138****2891',
        price: 9.20,
        moq: 500,
        lead: 28,
        score: 92,
        selected: true
      }, {
        id: 's2',
        name: '深圳麦腾科技',
        contact: 'Linda 139****5520',
        price: 8.80,
        moq: 1000,
        lead: 35,
        score: 84,
        selected: false
      }, {
        id: 's3',
        name: '广州永盛塑业',
        contact: '王生 137****1188',
        price: 9.85,
        moq: 300,
        lead: 22,
        score: 81,
        selected: false
      }, {
        id: 's4',
        name: '东莞宏达制造',
        contact: '李厂长 136****9090',
        price: 10.20,
        moq: 200,
        lead: 25,
        score: 76,
        selected: false
      }, {
        id: 's5',
        name: '苏州创联电子',
        contact: 'Tony 135****3344',
        price: 9.50,
        moq: 800,
        lead: 30,
        score: 79,
        selected: false
      }],
      finalNote: '账期: 30%定金+70%发货前 · 质保: 12 个月 · 包装: 双瓦楞外箱+珍珠棉'
    }),
    sampling: S({
      status: 'done',
      startDate: '2026-01-28',
      endDate: '2026-02-28',
      rounds: [{
        id: 'r1',
        round: 1,
        orderDate: '2026-01-28',
        qty: 3,
        cost: 320,
        receivedDate: '2026-02-08',
        result: '加热功率偏低, 漏水',
        isFinal: false,
        status: 'done'
      }, {
        id: 'r2',
        round: 2,
        orderDate: '2026-02-10',
        qty: 3,
        cost: 340,
        receivedDate: '2026-02-18',
        result: '密封改良, 续航不足',
        isFinal: false,
        status: 'done'
      }, {
        id: 'r3',
        round: 3,
        orderDate: '2026-02-20',
        qty: 5,
        cost: 480,
        receivedDate: '2026-02-28',
        result: '全部通过, 确认大货版',
        isFinal: true,
        status: 'done'
      }]
    }),
    cert: S({
      status: 'done',
      startDate: '2026-02-01',
      endDate: '2026-03-10',
      types: 'FCC, ETL, FDA',
      agency: 'SGS · 上海',
      cost: 1850,
      expectedDate: '2026-03-15',
      doneDate: '2026-03-10'
    }),
    packaging: S({
      status: 'done',
      startDate: '2026-02-25',
      endDate: '2026-03-15',
      rounds: [{
        id: 'pk1',
        round: 1,
        briefDate: '2026-02-25',
        designer: '王凯 (外包)',
        draftDate: '2026-03-04',
        confirmDate: '2026-03-08',
        isFinal: false,
        status: 'done'
      }, {
        id: 'pk2',
        round: 2,
        briefDate: '2026-03-10',
        designer: '王凯 (外包)',
        draftDate: '2026-03-13',
        confirmDate: '2026-03-15',
        isFinal: true,
        status: 'done'
      }]
    }),
    visuals: S({
      status: 'done',
      startDate: '2026-03-15',
      endDate: '2026-03-28',
      rounds: [{
        id: 'v1',
        round: 1,
        briefDate: '2026-03-15',
        designer: '光合影像工作室',
        shootDate: '2026-03-20',
        mainImgCount: 7,
        aPlusDate: '2026-03-28',
        isFinal: true,
        status: 'done'
      }]
    }),
    production: S({
      status: 'active',
      startDate: '2026-05-02',
      endDate: '',
      batches: [{
        id: 'bt1',
        batchNo: 'B1',
        orderDate: '2026-05-02',
        factory: '宁波昇泰电器',
        qty: 2000,
        unitPrice: 9.20,
        depositAmt: 5520,
        depositPct: 30,
        expectedShip: '2026-06-05',
        status: 'active',
        note: '60% 已下线, 预计 6/3 完工'
      }]
    }),
    qc: S({
      status: 'idle',
      startDate: '',
      endDate: '',
      records: []
    }),
    shipment: S({
      status: 'idle',
      startDate: '',
      endDate: '',
      records: []
    }),
    keywords: S({
      status: 'idle'
    }),
    listing: S({
      status: 'idle'
    }),
    handover: S({
      status: 'idle'
    }),
    promotion: S({
      status: 'idle'
    }),
    reorder: S({
      status: 'idle',
      records: []
    }),
    review: S({
      status: 'idle'
    })
  },
  logs: [{
    id: 'l1',
    date: '2026-05-18',
    text: '工厂确认 60% 货已下线, QC 安排在 5/28'
  }, {
    id: 'l2',
    date: '2026-05-09',
    text: '打样三版通过, 已签 PI 付定金 30%'
  }, {
    id: 'l3',
    date: '2026-04-22',
    text: 'FCC 证书拿到, ETL 还需 2 周'
  }]
}, {
  id: 'p002',
  name: '宠物自动喂食器 5L',
  sku: 'PET-FDR-500',
  category: '宠物用品 / 喂养',
  status: 'active',
  lead: '李婷',
  createdAt: '2025-11-20',
  currentStage: 'promotion',
  progress: 89,
  stages: {
    initiation: S({
      status: 'done',
      startDate: '2025-11-20',
      endDate: '2025-11-20',
      lead: '李婷',
      source: '卖家精灵',
      market: '美国 US',
      reason: '宠物经济持续增长, 智能喂食搜索量 +28%'
    }),
    research: S({
      status: 'done',
      startDate: '2025-11-21',
      endDate: '2025-11-25',
      monthSales: 9200,
      competitorCount: 24,
      avgPrice: 72.99,
      topAsin: 'B0CXX1A123',
      avgRating: 4.2,
      opportunity: 'A',
      painPoints: '卡粮、噪音、APP 不稳定'
    }),
    profit: S({
      status: 'done',
      startDate: '2025-11-26',
      endDate: '2025-11-28',
      targetPrice: 79.99,
      taxRate: 13,
      taxIncl: 90.39,
      cogs: 22.40,
      shipping: 4.20,
      fbaFee: 11.50,
      referralPct: 15,
      adPct: 10,
      otherCost: 1.20,
      decision: 'pass'
    }),
    bom: S({
      status: 'done',
      endDate: '2025-12-02',
      items: [{
        id: 'b1',
        name: '步进电机',
        spec: '5V 28BYJ-48',
        cat: '电机/马达',
        qty: 1,
        unitCost: 3.40
      }, {
        id: 'b2',
        name: '5L 食品级粮仓',
        spec: 'PP 透明',
        cat: '模具/外壳',
        qty: 1,
        unitCost: 5.20
      }, {
        id: 'b3',
        name: 'WiFi 模块',
        spec: 'ESP32-S3',
        cat: '开关/控制',
        qty: 1,
        unitCost: 4.80
      }, {
        id: 'b4',
        name: '锂电池',
        spec: '2×2600mAh',
        cat: '电源/电池',
        qty: 1,
        unitCost: 3.60
      }, {
        id: 'b5',
        name: '摄像头',
        spec: '1080P 广角',
        cat: 'LED/灯珠',
        qty: 1,
        unitCost: 2.80
      }, {
        id: 'b6',
        name: '外壳+底座',
        spec: 'ABS 烤漆',
        cat: '模具/外壳',
        qty: 1,
        unitCost: 1.85
      }]
    }),
    supplier: S({
      status: 'done',
      endDate: '2025-12-15',
      suppliers: [{
        id: 's1',
        name: '深圳宠智科技',
        contact: '刘总 139****6677',
        price: 21.80,
        moq: 500,
        lead: 35,
        score: 90,
        selected: true
      }, {
        id: 's2',
        name: '东莞智宠制造',
        contact: 'Eva 138****4422',
        price: 23.50,
        moq: 300,
        lead: 30,
        score: 82,
        selected: false
      }]
    }),
    sampling: S({
      status: 'done',
      endDate: '2026-01-30',
      rounds: [{
        id: 'r1',
        round: 1,
        orderDate: '2025-12-18',
        qty: 2,
        cost: 280,
        receivedDate: '2025-12-30',
        result: 'WiFi 不稳, 卡粮 2 次',
        isFinal: false,
        status: 'done'
      }, {
        id: 'r2',
        round: 2,
        orderDate: '2026-01-05',
        qty: 2,
        cost: 280,
        receivedDate: '2026-01-15',
        result: 'WiFi 改 ESP32, 出粮顺畅, 噪音偏大',
        isFinal: false,
        status: 'done'
      }, {
        id: 'r3',
        round: 3,
        orderDate: '2026-01-18',
        qty: 3,
        cost: 360,
        receivedDate: '2026-01-28',
        result: '静音齿轮, 全部通过',
        isFinal: true,
        status: 'done'
      }]
    }),
    cert: S({
      status: 'done',
      endDate: '2026-02-25',
      types: 'FCC, RoHS',
      agency: 'TÜV',
      cost: 2200,
      doneDate: '2026-02-25'
    }),
    packaging: S({
      status: 'done',
      endDate: '2026-03-04',
      rounds: [{
        id: 'pk1',
        round: 1,
        briefDate: '2026-02-26',
        designer: '小敏',
        draftDate: '2026-03-01',
        confirmDate: '2026-03-04',
        isFinal: true,
        status: 'done'
      }]
    }),
    visuals: S({
      status: 'done',
      endDate: '2026-03-20',
      rounds: [{
        id: 'v1',
        round: 1,
        briefDate: '2026-03-06',
        designer: '光合影像',
        shootDate: '2026-03-12',
        mainImgCount: 7,
        aPlusDate: '2026-03-20',
        isFinal: true,
        status: 'done'
      }]
    }),
    production: S({
      status: 'done',
      endDate: '2026-04-12',
      batches: [{
        id: 'bt1',
        batchNo: 'B1',
        orderDate: '2026-03-01',
        factory: '深圳宠智科技',
        qty: 1500,
        unitPrice: 21.80,
        depositAmt: 9810,
        depositPct: 30,
        expectedShip: '2026-04-12',
        status: 'done'
      }]
    }),
    qc: S({
      status: 'done',
      endDate: '2026-04-25',
      records: [{
        id: 'q1',
        date: '2026-04-22',
        inspector: '第三方 / 商通',
        result: '通过',
        issues: 'AQL 2.5 抽检 80pcs, 0 缺陷',
        status: 'done'
      }]
    }),
    shipment: S({
      status: 'done',
      endDate: '2026-05-02',
      records: [{
        id: 'sh1',
        shipDate: '2026-04-26',
        method: '海运',
        carrier: '马士基',
        tracking: 'MAEU-887****',
        qty: 1500,
        etaPort: '2026-05-15',
        etaFBA: '2026-05-22',
        status: 'done'
      }]
    }),
    keywords: S({
      status: 'done',
      endDate: '2026-04-18',
      tool: 'Helium 10',
      mainKw: 'automatic pet feeder',
      kwCount: 180
    }),
    listing: S({
      status: 'done',
      endDate: '2026-05-10',
      asin: 'B0DXX9YZ12',
      sku: 'PET-FDR-500',
      launchDate: '2026-05-10',
      price: 79.99
    }),
    handover: S({
      status: 'done',
      endDate: '2026-05-11',
      from: '李婷',
      to: '运营组-Mark'
    }),
    promotion: S({
      status: 'active',
      startDate: '2026-05-12',
      adBudget: 80,
      strategy: '自动 SP $30 + 手动 SP $40 + 品牌 SB $10'
    }),
    reorder: S({
      status: 'idle',
      records: []
    }),
    review: S({
      status: 'idle'
    })
  },
  logs: [{
    id: 'l1',
    date: '2026-05-19',
    text: 'Vine 投放 30 套, 首条 4★ 评价已到'
  }, {
    id: 'l2',
    date: '2026-05-12',
    text: '广告上线, 日预算 $80, ACoS 控制在 35%'
  }]
}, {
  id: 'p003',
  name: 'LED 化妆镜 Pro',
  sku: 'BTY-MIR-LED',
  category: '美妆 / 镜子',
  status: 'active',
  lead: '王芳',
  createdAt: '2025-09-05',
  currentStage: 'reorder',
  progress: 100,
  stages: {
    initiation: S({
      status: 'done',
      endDate: '2025-09-05',
      lead: '王芳',
      source: '品类雷达',
      market: '美国 US',
      reason: '美妆镜复购高, 评分痛点突出'
    }),
    research: S({
      status: 'done',
      endDate: '2025-09-10',
      monthSales: 22000,
      competitorCount: 48,
      avgPrice: 39.99,
      avgRating: 4.0,
      opportunity: 'B'
    }),
    profit: S({
      status: 'done',
      endDate: '2025-09-12',
      targetPrice: 49.99,
      taxRate: 13,
      taxIncl: 56.49,
      cogs: 11.20,
      shipping: 2.50,
      fbaFee: 6.20,
      referralPct: 15,
      adPct: 8,
      otherCost: 0.60,
      decision: 'pass'
    }),
    bom: S({
      status: 'done',
      endDate: '2025-09-18',
      items: [{
        id: 'b1',
        name: '圆形 LED 灯环',
        spec: 'D=200mm 36 灯',
        cat: 'LED/灯珠',
        qty: 1,
        unitCost: 2.80
      }, {
        id: 'b2',
        name: '高清玻璃镜面',
        spec: 'D=180mm 防雾',
        cat: '其他',
        qty: 1,
        unitCost: 3.20
      }, {
        id: 'b3',
        name: '金属支架',
        spec: '锌合金 拉丝',
        cat: '模具/外壳',
        qty: 1,
        unitCost: 2.40
      }, {
        id: 'b4',
        name: '触控开关',
        spec: '三档调光',
        cat: '开关/控制',
        qty: 1,
        unitCost: 0.80
      }]
    }),
    supplier: S({
      status: 'done',
      endDate: '2025-09-28',
      suppliers: [{
        id: 's1',
        name: '广州美丽佳工厂',
        contact: '刘姐 138****0011',
        price: 10.80,
        moq: 500,
        lead: 25,
        score: 88,
        selected: true
      }]
    }),
    sampling: S({
      status: 'done',
      endDate: '2025-10-30',
      rounds: [{
        id: 'r1',
        round: 1,
        orderDate: '2025-10-01',
        qty: 3,
        cost: 120,
        receivedDate: '2025-10-12',
        result: '灯光偏黄',
        isFinal: false,
        status: 'done'
      }, {
        id: 'r2',
        round: 2,
        orderDate: '2025-10-18',
        qty: 3,
        cost: 120,
        receivedDate: '2025-10-30',
        result: '通过',
        isFinal: true,
        status: 'done'
      }]
    }),
    cert: S({
      status: 'done',
      endDate: '2025-11-20'
    }),
    packaging: S({
      status: 'done',
      endDate: '2025-11-25',
      rounds: [{
        id: 'pk1',
        round: 1,
        briefDate: '2025-11-20',
        designer: '内部',
        draftDate: '2025-11-22',
        confirmDate: '2025-11-25',
        isFinal: true,
        status: 'done'
      }]
    }),
    visuals: S({
      status: 'done',
      endDate: '2025-12-10',
      rounds: [{
        id: 'v1',
        round: 1,
        briefDate: '2025-12-01',
        designer: '外包',
        shootDate: '2025-12-06',
        mainImgCount: 7,
        aPlusDate: '2025-12-10',
        isFinal: true,
        status: 'done'
      }]
    }),
    production: S({
      status: 'done',
      endDate: '2026-01-15',
      batches: [{
        id: 'bt1',
        batchNo: 'B1',
        orderDate: '2025-12-15',
        factory: '广州美丽佳工厂',
        qty: 3000,
        unitPrice: 10.80,
        depositAmt: 9720,
        depositPct: 30,
        expectedShip: '2026-01-15',
        status: 'done'
      }]
    }),
    qc: S({
      status: 'done',
      endDate: '2026-01-28',
      records: [{
        id: 'q1',
        date: '2026-01-26',
        inspector: '内部 QC',
        result: '通过',
        issues: '2pcs 镜面划痕已剔除',
        status: 'done'
      }]
    }),
    shipment: S({
      status: 'done',
      endDate: '2026-02-05',
      records: [{
        id: 'sh1',
        shipDate: '2026-01-30',
        method: '海运',
        carrier: '达飞',
        tracking: 'CMAU-712****',
        qty: 3000,
        etaFBA: '2026-02-22',
        status: 'done'
      }]
    }),
    keywords: S({
      status: 'done',
      endDate: '2026-01-25'
    }),
    listing: S({
      status: 'done',
      endDate: '2026-02-18',
      asin: 'B0CXX1A2B3',
      launchDate: '2026-02-18',
      price: 49.99
    }),
    handover: S({
      status: 'done',
      endDate: '2026-02-19'
    }),
    promotion: S({
      status: 'done',
      endDate: '2026-03-10',
      adBudget: 60
    }),
    reorder: S({
      status: 'active',
      records: [{
        id: 'ro1',
        orderNo: 'RO-2026-01',
        supplier: '广州美丽佳工厂',
        orderDate: '2026-03-10',
        triggerInv: 600,
        qty: 2000,
        unitPrice: 10.50,
        taxRate: 13,
        taxIncl: 11.87,
        totalAmount: 23730,
        shipDate: '2026-04-05',
        method: '海运',
        carrier: '马士基',
        etaDate: '2026-04-28',
        actualEta: '2026-04-30',
        status: 'done',
        subShipments: [{
          id: 'ss1',
          batchNo: 'A',
          qty: 1200,
          shipDate: '2026-04-05',
          method: '海运',
          carrier: '马士基',
          tracking: 'MAEU-901****',
          etaDate: '2026-04-28',
          actualEta: '2026-04-30',
          status: 'done'
        }, {
          id: 'ss2',
          batchNo: 'B',
          qty: 800,
          shipDate: '2026-04-12',
          method: '空运',
          carrier: 'DHL',
          tracking: 'JJD-0011****',
          etaDate: '2026-04-22',
          actualEta: '2026-04-23',
          status: 'done'
        }]
      }, {
        id: 'ro2',
        orderNo: 'RO-2026-02',
        supplier: '广州美丽佳工厂',
        orderDate: '2026-04-28',
        triggerInv: 550,
        qty: 3000,
        unitPrice: 10.30,
        taxRate: 13,
        taxIncl: 11.64,
        totalAmount: 34920,
        shipDate: '2026-05-20',
        method: '海运',
        carrier: '达飞',
        etaDate: '2026-06-15',
        actualEta: '',
        status: 'active',
        subShipments: [{
          id: 'ss1',
          batchNo: 'A',
          qty: 1500,
          shipDate: '2026-05-20',
          method: '海运',
          carrier: '达飞',
          tracking: 'CMAU-833****',
          etaDate: '2026-06-15',
          actualEta: '',
          status: 'active'
        }, {
          id: 'ss2',
          batchNo: 'B',
          qty: 1500,
          shipDate: '',
          method: '',
          carrier: '',
          tracking: '',
          etaDate: '',
          actualEta: '',
          status: 'idle'
        }]
      }]
    }),
    review: S({
      status: 'done',
      endDate: '2026-05-15',
      monthSales3: 5400,
      actualMargin: 24,
      rating: 4.5,
      successPoints: '灯光均匀,主图差异化,Vine 评价质量高',
      issues: '物流二段晚 2 天',
      improvements: '下一代加可拆电池'
    })
  },
  logs: [{
    id: 'l1',
    date: '2026-05-15',
    text: '月销稳定 1800 单, 评分 4.5, 触发第二次返单 3000pcs'
  }, {
    id: 'l2',
    date: '2026-04-28',
    text: '库存低于 600, 已下返单 PO'
  }]
}, {
  id: 'p004',
  name: '硅胶折叠水壶 800ml',
  sku: 'OUT-BTL-800',
  category: '户外 / 水具',
  status: 'active',
  lead: '陈雷',
  createdAt: '2026-03-12',
  currentStage: 'sampling',
  progress: 28,
  stages: {
    initiation: S({
      status: 'done',
      endDate: '2026-03-12',
      lead: '陈雷',
      source: 'TikTok 爆款',
      market: '美国 US',
      reason: '露营品类增长, 硅胶水壶轻便'
    }),
    research: S({
      status: 'done',
      endDate: '2026-03-18',
      monthSales: 6800,
      competitorCount: 18,
      avgPrice: 16.99,
      avgRating: 4.3,
      opportunity: 'B'
    }),
    profit: S({
      status: 'done',
      endDate: '2026-03-22',
      targetPrice: 18.99,
      taxRate: 13,
      taxIncl: 21.46,
      cogs: 4.10,
      shipping: 0.80,
      fbaFee: 3.20,
      referralPct: 15,
      adPct: 12,
      otherCost: 0.20,
      decision: 'pass'
    }),
    bom: S({
      status: 'done',
      endDate: '2026-03-28',
      items: [{
        id: 'b1',
        name: '食品级硅胶杯身',
        spec: '800ml 折叠式',
        cat: '面料/布料',
        qty: 1,
        unitCost: 2.20
      }, {
        id: 'b2',
        name: 'PP 盖+提手',
        spec: '扣式',
        cat: '模具/外壳',
        qty: 1,
        unitCost: 0.90
      }, {
        id: 'b3',
        name: '卡扣弹簧',
        spec: '304 不锈钢',
        cat: '其他',
        qty: 1,
        unitCost: 0.30
      }]
    }),
    supplier: S({
      status: 'done',
      endDate: '2026-04-15',
      suppliers: [{
        id: 's1',
        name: '东莞硅美科技',
        contact: '阿May 138****8888',
        price: 4.05,
        moq: 1000,
        lead: 20,
        score: 85,
        selected: true
      }]
    }),
    sampling: S({
      status: 'active',
      startDate: '2026-04-20',
      rounds: [{
        id: 'r1',
        round: 1,
        orderDate: '2026-04-20',
        qty: 3,
        cost: 60,
        receivedDate: '2026-04-30',
        result: '盖子卡扣偏紧',
        isFinal: false,
        status: 'done'
      }, {
        id: 'r2',
        round: 2,
        orderDate: '2026-05-04',
        qty: 3,
        cost: 60,
        receivedDate: '2026-05-12',
        result: '漏水问题已解决, 等待密封测试报告',
        isFinal: false,
        status: 'active'
      }]
    }),
    cert: S({
      status: 'idle'
    }),
    packaging: S({
      status: 'idle',
      rounds: []
    }),
    visuals: S({
      status: 'idle',
      rounds: []
    }),
    production: S({
      status: 'idle',
      batches: []
    }),
    qc: S({
      status: 'idle',
      records: []
    }),
    shipment: S({
      status: 'idle',
      records: []
    }),
    keywords: S({
      status: 'idle'
    }),
    listing: S({
      status: 'idle'
    }),
    handover: S({
      status: 'idle'
    }),
    promotion: S({
      status: 'idle'
    }),
    reorder: S({
      status: 'idle',
      records: []
    }),
    review: S({
      status: 'idle'
    })
  },
  logs: [{
    id: 'l1',
    date: '2026-05-12',
    text: '二版打样到货, 漏水问题已解决, 等待密封测试报告'
  }]
}, {
  id: 'p005',
  name: '便携蓝牙投影仪 mini',
  sku: 'AV-PRJ-MNI',
  category: '影音 / 投影',
  status: 'hold',
  lead: '张明',
  createdAt: '2026-02-01',
  currentStage: 'profit',
  progress: 18,
  stages: {
    initiation: S({
      status: 'done',
      endDate: '2026-02-01',
      lead: '张明',
      source: '关键词工具',
      market: '美国 US'
    }),
    research: S({
      status: 'done',
      endDate: '2026-02-08',
      monthSales: 4200,
      competitorCount: 60,
      avgPrice: 119.99,
      avgRating: 3.9,
      opportunity: 'C'
    }),
    profit: S({
      status: 'hold',
      startDate: '2026-02-12',
      targetPrice: 129.99,
      taxRate: 13,
      cogs: 55.00,
      shipping: 6.00,
      fbaFee: 14.50,
      referralPct: 15,
      adPct: 15,
      otherCost: 2.00,
      decision: 'hold',
      decisionNote: '净利率仅 6%, 暂缓推进, 等供应商二轮报价'
    }),
    bom: S({
      status: 'idle',
      items: []
    }),
    supplier: S({
      status: 'idle',
      suppliers: []
    }),
    sampling: S({
      status: 'idle',
      rounds: []
    }),
    cert: S({
      status: 'idle'
    }),
    packaging: S({
      status: 'idle',
      rounds: []
    }),
    visuals: S({
      status: 'idle',
      rounds: []
    }),
    production: S({
      status: 'idle',
      batches: []
    }),
    qc: S({
      status: 'idle',
      records: []
    }),
    shipment: S({
      status: 'idle',
      records: []
    }),
    keywords: S({
      status: 'idle'
    }),
    listing: S({
      status: 'idle'
    }),
    handover: S({
      status: 'idle'
    }),
    promotion: S({
      status: 'idle'
    }),
    reorder: S({
      status: 'idle',
      records: []
    }),
    review: S({
      status: 'idle'
    })
  },
  logs: [{
    id: 'l1',
    date: '2026-03-02',
    text: '利润测算净利率仅 6%, 暂缓推进, 等供应商二轮报价'
  }]
}, {
  id: 'p006',
  name: '厨房硅胶刮刀套装 6 件',
  sku: 'KIT-SPL-006',
  category: '厨具 / 餐具',
  status: 'done',
  lead: '李婷',
  createdAt: '2025-06-10',
  currentStage: 'review',
  progress: 100,
  stages: {
    initiation: S({
      status: 'done',
      endDate: '2025-06-10'
    }),
    research: S({
      status: 'done',
      endDate: '2025-06-14',
      avgPrice: 14.99
    }),
    profit: S({
      status: 'done',
      endDate: '2025-06-18',
      targetPrice: 16.99,
      taxRate: 13,
      cogs: 2.80,
      shipping: 0.50,
      fbaFee: 3.80,
      referralPct: 15,
      adPct: 10,
      decision: 'pass'
    }),
    bom: S({
      status: 'done',
      endDate: '2025-06-22',
      items: []
    }),
    supplier: S({
      status: 'done',
      endDate: '2025-07-01',
      suppliers: []
    }),
    sampling: S({
      status: 'done',
      endDate: '2025-08-05',
      rounds: []
    }),
    cert: S({
      status: 'done',
      endDate: '2025-08-20'
    }),
    packaging: S({
      status: 'done',
      endDate: '2025-08-25',
      rounds: []
    }),
    visuals: S({
      status: 'done',
      endDate: '2025-09-08',
      rounds: []
    }),
    production: S({
      status: 'done',
      endDate: '2025-10-12',
      batches: []
    }),
    qc: S({
      status: 'done',
      endDate: '2025-10-25',
      records: []
    }),
    shipment: S({
      status: 'done',
      endDate: '2025-11-02',
      records: []
    }),
    keywords: S({
      status: 'done',
      endDate: '2025-10-25'
    }),
    listing: S({
      status: 'done',
      endDate: '2025-11-18',
      asin: 'B0BYY8X7W6'
    }),
    handover: S({
      status: 'done',
      endDate: '2025-11-20'
    }),
    promotion: S({
      status: 'done',
      endDate: '2025-12-15'
    }),
    reorder: S({
      status: 'done',
      records: []
    }),
    review: S({
      status: 'done',
      endDate: '2026-05-01'
    })
  },
  logs: [{
    id: 'l1',
    date: '2026-05-01',
    text: '复盘完成: 月销 2400 单, 净利率 24%, 评分 4.6, 列为 A 类'
  }]
}, {
  id: 'p007',
  name: '车载香薰扩散器',
  sku: 'CAR-AMB-001',
  category: '汽车 / 香薰',
  status: 'cancel',
  lead: '王芳',
  createdAt: '2026-01-25',
  currentStage: 'research',
  progress: 8,
  stages: {
    initiation: S({
      status: 'done',
      endDate: '2026-01-25'
    }),
    research: S({
      status: 'done',
      endDate: '2026-02-03'
    }),
    profit: S({
      status: 'idle',
      decision: 'reject'
    }),
    bom: S({
      status: 'idle',
      items: []
    }),
    supplier: S({
      status: 'idle',
      suppliers: []
    }),
    sampling: S({
      status: 'idle',
      rounds: []
    }),
    cert: S({
      status: 'idle'
    }),
    packaging: S({
      status: 'idle',
      rounds: []
    }),
    visuals: S({
      status: 'idle',
      rounds: []
    }),
    production: S({
      status: 'idle',
      batches: []
    }),
    qc: S({
      status: 'idle',
      records: []
    }),
    shipment: S({
      status: 'idle',
      records: []
    }),
    keywords: S({
      status: 'idle'
    }),
    listing: S({
      status: 'idle'
    }),
    handover: S({
      status: 'idle'
    }),
    promotion: S({
      status: 'idle'
    }),
    reorder: S({
      status: 'idle',
      records: []
    }),
    review: S({
      status: 'idle'
    })
  },
  logs: [{
    id: 'l1',
    date: '2026-02-10',
    text: '竞品 Top10 平均售价已跌至 $8.99, 利润空间不足, 否决'
  }]
}];

// helper: random ID
function uid() {
  return 'x' + Math.random().toString(36).slice(2, 9);
}

// Default FX rate (CNY per 1 USD) — editable per product
const DEFAULT_FX = 7.20;

// Apply defaults to existing products (fxRate field added in v3)
PRODUCTS.forEach(p => {
  if (p.fxRate == null) p.fxRate = DEFAULT_FX;
  if (p.stages?.profit && p.stages.profit.returnRate == null) p.stages.profit.returnRate = 5;
});

// helper: get end date alias (legacy `done` field)
function getDone(stage) {
  return stage && (stage.endDate || stage.doneDate || (stage.status === 'done' ? stage.startDate : '') || '');
}

// ====== 公共利润计算函数（list-view / table-view 共用）======
// 退货成本 = 售价 × 退货率（不含任何成本项）
// 产品成本用不含税金额参与计算，含税仅展示
function calcProfit(p) {
  const pr = p.stages?.profit;
  if (!pr || !Number(pr.targetPrice)) return null;
  const fx = Number(p.fxRate) || window.DEFAULT_FX || 7.20;
  const price = Number(pr.targetPrice) || 0; // 目标售价 $
  const cogsUsd = fx > 0 ? (Number(pr.cogs) || 0) / fx : 0; // 不含税产品成本 $
  const shipUsd = fx > 0 ? (Number(pr.shipping) || 0) / fx : 0; // 头程运费 $
  const otherUsd = fx > 0 ? (Number(pr.otherCost) || 0) / fx : 0; // 其他费用 $
  const fbaFee = Number(pr.fbaFee) || 0; // FBA费用 $
  const referral = price * (Number(pr.referralPct || 0) / 100); // 平台佣金 $
  const adFee = price * (Number(pr.adPct || 0) / 100); // 广告费 $
  const returnCost = price * (Number(pr.returnRate || 0) / 100); // 退货成本 = 售价×退货率 $
  const gross = price - fbaFee - shipUsd - cogsUsd;
  const net = gross - referral - adFee - returnCost - otherUsd;
  const margin = price ? net / price * 100 : 0;
  return {
    price,
    cogsUsd,
    shipUsd,
    otherUsd,
    fbaFee,
    referral,
    adFee,
    returnCost,
    gross,
    net,
    margin
  };
}
Object.assign(window, {
  STAGES,
  TABS,
  STAGE_STATUSES,
  STATUS_LABELS,
  PRODUCTS,
  S,
  uid,
  getDone,
  DEFAULT_FX,
  calcProfit
});