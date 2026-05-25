/* eslint-disable no-undef */
// Tabs: 供应商/打样, 内容设计, 生产出货, 上架运营, 返单复盘 — fully editable

// ============ TAB: 供应商/打样 ============
function TabSup({
  p
}) {
  const {
    updateStage,
    addRecord,
    updateRecord,
    removeRecord
  } = useProducts();
  const sup = p.stages.supplier || {
    suppliers: []
  };
  const sampling = p.stages.sampling || {
    rounds: []
  };
  const cert = p.stages.cert || {};
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(StageCard, {
    stage: STAGES[4],
    productId: p.id,
    stageKey: "supplier",
    stageData: sup
  }, /*#__PURE__*/React.createElement("table", {
    className: "sup-table editable"
  }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", {
    style: {
      width: '22%'
    }
  }, "\u4F9B\u5E94\u5546"), /*#__PURE__*/React.createElement("th", {
    style: {
      width: '24%'
    }
  }, "\u8054\u7CFB\u65B9\u5F0F"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'right'
    }
  }, "\u62A5\u4EF7(\xA5)"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'right'
    }
  }, "MOQ"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'right'
    }
  }, "\u5468\u671F(\u5929)"), /*#__PURE__*/React.createElement("th", {
    style: {
      textAlign: 'right'
    }
  }, "\u8BC4\u5206"), /*#__PURE__*/React.createElement("th", null), /*#__PURE__*/React.createElement("th", null))), /*#__PURE__*/React.createElement("tbody", null, (sup.suppliers || []).map(s => /*#__PURE__*/React.createElement("tr", {
    key: s.id,
    className: s.selected ? 'selected' : ''
  }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("input", {
    className: "cell",
    value: s.name,
    onChange: e => updateRecord(p.id, 'supplier', 'suppliers', s.id, {
      name: e.target.value
    })
  })), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("input", {
    className: "cell mono",
    style: {
      fontSize: 11
    },
    value: s.contact,
    onChange: e => updateRecord(p.id, 'supplier', 'suppliers', s.id, {
      contact: e.target.value
    })
  })), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, /*#__PURE__*/React.createElement("input", {
    className: "cell mono",
    type: "number",
    step: "0.01",
    value: s.price,
    onChange: e => updateRecord(p.id, 'supplier', 'suppliers', s.id, {
      price: Number(e.target.value)
    })
  })), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, /*#__PURE__*/React.createElement("input", {
    className: "cell mono",
    type: "number",
    value: s.moq,
    onChange: e => updateRecord(p.id, 'supplier', 'suppliers', s.id, {
      moq: Number(e.target.value)
    })
  })), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, /*#__PURE__*/React.createElement("input", {
    className: "cell mono",
    type: "number",
    value: s.lead,
    onChange: e => updateRecord(p.id, 'supplier', 'suppliers', s.id, {
      lead: Number(e.target.value)
    })
  })), /*#__PURE__*/React.createElement("td", {
    className: "num"
  }, /*#__PURE__*/React.createElement("input", {
    className: "cell mono",
    type: "number",
    value: s.score,
    onChange: e => updateRecord(p.id, 'supplier', 'suppliers', s.id, {
      score: Number(e.target.value)
    })
  })), /*#__PURE__*/React.createElement("td", null, s.selected ? /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--blue)',
      fontWeight: 600,
      fontSize: 11
    }
  }, "\u2713 \u5DF2\u9009\u5B9A") : /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: () => {
      const next = (sup.suppliers || []).map(x => ({
        ...x,
        selected: x.id === s.id
      }));
      updateStage(p.id, 'supplier', {
        suppliers: next
      });
    }
  }, "\u9009\u5B9A")), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("button", {
    className: "row-del",
    onClick: () => removeRecord(p.id, 'supplier', 'suppliers', s.id)
  }, "\u2715")))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement(AddRecordButton, {
    label: "\u6DFB\u52A0\u4F9B\u5E94\u5546",
    onClick: () => addRecord(p.id, 'supplier', 'suppliers', {
      name: '',
      contact: '',
      price: 0,
      moq: 0,
      lead: 0,
      score: 0,
      selected: false
    })
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12
    }
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "\u6700\u7EC8\u786E\u8BA4\u5907\u6CE8 (\u8D26\u671F/\u8D28\u4FDD/\u5305\u88C5\u8981\u6C42)",
    multi: true,
    wide: true,
    value: sup.finalNote,
    onChange: v => updateStage(p.id, 'supplier', {
      finalNote: v
    })
  }))), /*#__PURE__*/React.createElement(StageCard, {
    stage: STAGES[5],
    productId: p.id,
    stageKey: "sampling",
    stageData: sampling
  }, /*#__PURE__*/React.createElement("div", {
    className: "record-list"
  }, (sampling.rounds || []).map((r, idx) => /*#__PURE__*/React.createElement(RecordCard, {
    key: r.id,
    index: r.round || idx + 1,
    title: `打样轮次 #${r.round || idx + 1}`,
    color: STAGES[5].color,
    status: r.status,
    isFinal: r.isFinal,
    onStatusChange: v => updateRecord(p.id, 'sampling', 'rounds', r.id, {
      status: v
    }),
    onRemove: () => removeRecord(p.id, 'sampling', 'rounds', r.id)
  }, /*#__PURE__*/React.createElement("div", {
    className: "fieldgrid cols-4"
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "\u4E0B\u5355\u65E5\u671F",
    type: "date",
    mono: true,
    value: r.orderDate,
    onChange: v => updateRecord(p.id, 'sampling', 'rounds', r.id, {
      orderDate: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u6570\u91CF",
    type: "number",
    mono: true,
    value: r.qty,
    suffix: "pcs",
    onChange: v => updateRecord(p.id, 'sampling', 'rounds', r.id, {
      qty: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u8D39\u7528 (\xA5)",
    type: "number",
    mono: true,
    prefix: "\xA5",
    value: r.cost,
    onChange: v => updateRecord(p.id, 'sampling', 'rounds', r.id, {
      cost: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u6536\u6837\u65E5\u671F",
    type: "date",
    mono: true,
    value: r.receivedDate,
    onChange: v => updateRecord(p.id, 'sampling', 'rounds', r.id, {
      receivedDate: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u8BC4\u5BA1\u7ED3\u679C",
    wide: true,
    multi: true,
    value: r.result,
    onChange: v => updateRecord(p.id, 'sampling', 'rounds', r.id, {
      result: v
    })
  })), /*#__PURE__*/React.createElement("label", {
    className: "final-toggle"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: !!r.isFinal,
    onChange: e => {
      const next = (sampling.rounds || []).map(x => ({
        ...x,
        isFinal: x.id === r.id ? e.target.checked : e.target.checked ? false : x.isFinal
      }));
      updateStage(p.id, 'sampling', {
        rounds: next
      });
    }
  }), /*#__PURE__*/React.createElement("span", null, "\u6807\u8BB0\u4E3A\u6700\u7EC8\u7248\u672C"))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement(AddRecordButton, {
    label: "\u6DFB\u52A0\u6253\u6837\u8F6E\u6B21",
    onClick: () => {
      const nextRound = (sampling.rounds || []).reduce((m, r) => Math.max(m, r.round || 0), 0) + 1;
      addRecord(p.id, 'sampling', 'rounds', {
        round: nextRound,
        orderDate: '',
        qty: 0,
        cost: 0,
        receivedDate: '',
        result: '',
        isFinal: false
      });
    }
  }))), /*#__PURE__*/React.createElement(StageCard, {
    stage: STAGES[6],
    productId: p.id,
    stageKey: "cert",
    stageData: cert
  }, /*#__PURE__*/React.createElement("div", {
    className: "fieldgrid cols-3"
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "\u8BA4\u8BC1\u7C7B\u578B",
    value: cert.types,
    onChange: v => updateStage(p.id, 'cert', {
      types: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u68C0\u6D4B\u673A\u6784",
    value: cert.agency,
    onChange: v => updateStage(p.id, 'cert', {
      agency: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u8D39\u7528 (\xA5)",
    type: "number",
    mono: true,
    prefix: "\xA5",
    value: cert.cost,
    onChange: v => updateStage(p.id, 'cert', {
      cost: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u9884\u8BA1\u5B8C\u6210",
    type: "date",
    mono: true,
    value: cert.expectedDate,
    onChange: v => updateStage(p.id, 'cert', {
      expectedDate: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u5B9E\u9645\u5B8C\u6210",
    type: "date",
    mono: true,
    value: cert.doneDate,
    onChange: v => updateStage(p.id, 'cert', {
      doneDate: v
    })
  }))));
}

// ============ TAB: 内容设计 ============
function TabDesign({
  p
}) {
  const {
    updateStage,
    addRecord,
    updateRecord,
    removeRecord
  } = useProducts();
  const pack = p.stages.packaging || {
    rounds: []
  };
  const vis = p.stages.visuals || {
    rounds: []
  };
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(StageCard, {
    stage: STAGES[7],
    productId: p.id,
    stageKey: "packaging",
    stageData: pack
  }, /*#__PURE__*/React.createElement("div", {
    className: "record-list"
  }, (pack.rounds || []).map((r, idx) => /*#__PURE__*/React.createElement(RecordCard, {
    key: r.id,
    index: r.round || idx + 1,
    title: `包装设计 #${r.round || idx + 1}`,
    color: STAGES[7].color,
    status: r.status,
    isFinal: r.isFinal,
    onStatusChange: v => updateRecord(p.id, 'packaging', 'rounds', r.id, {
      status: v
    }),
    onRemove: () => removeRecord(p.id, 'packaging', 'rounds', r.id)
  }, /*#__PURE__*/React.createElement("div", {
    className: "fieldgrid cols-4"
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "\u9700\u6C42\u63D0\u4EA4\u65E5",
    type: "date",
    mono: true,
    value: r.briefDate,
    onChange: v => updateRecord(p.id, 'packaging', 'rounds', r.id, {
      briefDate: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u8BBE\u8BA1\u5E08",
    value: r.designer,
    onChange: v => updateRecord(p.id, 'packaging', 'rounds', r.id, {
      designer: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u521D\u7A3F\u5B8C\u6210",
    type: "date",
    mono: true,
    value: r.draftDate,
    onChange: v => updateRecord(p.id, 'packaging', 'rounds', r.id, {
      draftDate: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u786E\u8BA4\u65E5\u671F",
    type: "date",
    mono: true,
    value: r.confirmDate,
    onChange: v => updateRecord(p.id, 'packaging', 'rounds', r.id, {
      confirmDate: v
    })
  })), /*#__PURE__*/React.createElement("label", {
    className: "final-toggle"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: !!r.isFinal,
    onChange: e => updateRecord(p.id, 'packaging', 'rounds', r.id, {
      isFinal: e.target.checked
    })
  }), /*#__PURE__*/React.createElement("span", null, "\u6807\u8BB0\u4E3A\u6700\u7EC8\u7248\u672C"))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement(AddRecordButton, {
    label: "\u6DFB\u52A0\u5305\u88C5\u8F6E\u6B21",
    onClick: () => {
      const next = (pack.rounds || []).reduce((m, r) => Math.max(m, r.round || 0), 0) + 1;
      addRecord(p.id, 'packaging', 'rounds', {
        round: next,
        briefDate: '',
        designer: '',
        draftDate: '',
        confirmDate: '',
        isFinal: false
      });
    }
  }))), /*#__PURE__*/React.createElement(StageCard, {
    stage: STAGES[8],
    productId: p.id,
    stageKey: "visuals",
    stageData: vis
  }, /*#__PURE__*/React.createElement("div", {
    className: "record-list"
  }, (vis.rounds || []).map((r, idx) => /*#__PURE__*/React.createElement(RecordCard, {
    key: r.id,
    index: r.round || idx + 1,
    title: `视觉素材 #${r.round || idx + 1}`,
    color: STAGES[8].color,
    status: r.status,
    isFinal: r.isFinal,
    onStatusChange: v => updateRecord(p.id, 'visuals', 'rounds', r.id, {
      status: v
    }),
    onRemove: () => removeRecord(p.id, 'visuals', 'rounds', r.id)
  }, /*#__PURE__*/React.createElement("div", {
    className: "fieldgrid cols-4"
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "\u9700\u6C42\u63D0\u4EA4\u65E5",
    type: "date",
    mono: true,
    value: r.briefDate,
    onChange: v => updateRecord(p.id, 'visuals', 'rounds', r.id, {
      briefDate: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u6444\u5F71/\u8BBE\u8BA1",
    value: r.designer,
    onChange: v => updateRecord(p.id, 'visuals', 'rounds', r.id, {
      designer: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u62CD\u6444\u65E5\u671F",
    type: "date",
    mono: true,
    value: r.shootDate,
    onChange: v => updateRecord(p.id, 'visuals', 'rounds', r.id, {
      shootDate: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u4E3B\u56FE\u6570\u91CF",
    type: "number",
    mono: true,
    value: r.mainImgCount,
    onChange: v => updateRecord(p.id, 'visuals', 'rounds', r.id, {
      mainImgCount: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "A+ \u5B8C\u6210\u65E5",
    type: "date",
    mono: true,
    value: r.aPlusDate,
    onChange: v => updateRecord(p.id, 'visuals', 'rounds', r.id, {
      aPlusDate: v
    })
  })), /*#__PURE__*/React.createElement("label", {
    className: "final-toggle"
  }, /*#__PURE__*/React.createElement("input", {
    type: "checkbox",
    checked: !!r.isFinal,
    onChange: e => updateRecord(p.id, 'visuals', 'rounds', r.id, {
      isFinal: e.target.checked
    })
  }), /*#__PURE__*/React.createElement("span", null, "\u6807\u8BB0\u4E3A\u6700\u7EC8\u7248\u672C"))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement(AddRecordButton, {
    label: "\u6DFB\u52A0\u89C6\u89C9\u8F6E\u6B21",
    onClick: () => {
      const next = (vis.rounds || []).reduce((m, r) => Math.max(m, r.round || 0), 0) + 1;
      addRecord(p.id, 'visuals', 'rounds', {
        round: next,
        briefDate: '',
        designer: '',
        shootDate: '',
        mainImgCount: 0,
        aPlusDate: '',
        isFinal: false
      });
    }
  }))));
}

// ============ TAB: 生产出货 ============
function TabProd({
  p
}) {
  const {
    addRecord,
    updateRecord,
    removeRecord
  } = useProducts();
  const prod = p.stages.production || {
    batches: []
  };
  const qc = p.stages.qc || {
    records: []
  };
  const ship = p.stages.shipment || {
    records: []
  };
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(StageCard, {
    stage: STAGES[9],
    productId: p.id,
    stageKey: "production",
    stageData: prod
  }, /*#__PURE__*/React.createElement("div", {
    className: "record-list"
  }, (prod.batches || []).map((b, idx) => /*#__PURE__*/React.createElement(RecordCard, {
    key: b.id,
    index: b.batchNo || 'B' + (idx + 1),
    title: `生产批次 ${b.batchNo || 'B' + (idx + 1)}`,
    color: STAGES[9].color,
    status: b.status,
    onStatusChange: v => updateRecord(p.id, 'production', 'batches', b.id, {
      status: v
    }),
    onRemove: () => removeRecord(p.id, 'production', 'batches', b.id)
  }, /*#__PURE__*/React.createElement("div", {
    className: "fieldgrid cols-4"
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "\u6279\u6B21\u53F7",
    value: b.batchNo,
    onChange: v => updateRecord(p.id, 'production', 'batches', b.id, {
      batchNo: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u5DE5\u5382",
    value: b.factory,
    onChange: v => updateRecord(p.id, 'production', 'batches', b.id, {
      factory: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u4E0B\u5355\u65E5\u671F",
    type: "date",
    mono: true,
    value: b.orderDate,
    onChange: v => updateRecord(p.id, 'production', 'batches', b.id, {
      orderDate: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u9884\u8BA1\u51FA\u8D27",
    type: "date",
    mono: true,
    value: b.expectedShip,
    onChange: v => updateRecord(p.id, 'production', 'batches', b.id, {
      expectedShip: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u6570\u91CF",
    type: "number",
    mono: true,
    suffix: "pcs",
    value: b.qty,
    onChange: v => updateRecord(p.id, 'production', 'batches', b.id, {
      qty: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u5355\u4EF7 (\xA5)",
    type: "number",
    mono: true,
    prefix: "\xA5",
    value: b.unitPrice,
    onChange: v => updateRecord(p.id, 'production', 'batches', b.id, {
      unitPrice: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u9884\u4ED8\u6B3E\u6BD4\u4F8B",
    type: "number",
    mono: true,
    suffix: "%",
    value: b.depositPct,
    onChange: v => updateRecord(p.id, 'production', 'batches', b.id, {
      depositPct: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u9884\u4ED8\u6B3E\u91D1\u989D (\xA5)",
    type: "number",
    mono: true,
    prefix: "\xA5",
    value: b.depositAmt,
    onChange: v => updateRecord(p.id, 'production', 'batches', b.id, {
      depositAmt: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u6279\u6B21\u5907\u6CE8",
    wide: true,
    multi: true,
    value: b.note,
    onChange: v => updateRecord(p.id, 'production', 'batches', b.id, {
      note: v
    })
  }))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement(AddRecordButton, {
    label: "\u6DFB\u52A0\u751F\u4EA7\u6279\u6B21",
    onClick: () => {
      const idx = (prod.batches || []).length + 1;
      addRecord(p.id, 'production', 'batches', {
        batchNo: 'B' + idx,
        orderDate: '',
        factory: '',
        qty: 0,
        unitPrice: 0,
        depositPct: 30,
        depositAmt: 0,
        expectedShip: '',
        note: ''
      });
    }
  }))), /*#__PURE__*/React.createElement(StageCard, {
    stage: STAGES[10],
    productId: p.id,
    stageKey: "qc",
    stageData: qc
  }, /*#__PURE__*/React.createElement("div", {
    className: "record-list"
  }, (qc.records || []).map((r, idx) => /*#__PURE__*/React.createElement(RecordCard, {
    key: r.id,
    index: 'QC' + (idx + 1),
    title: `验货记录 ${idx + 1}`,
    color: STAGES[10].color,
    status: r.status,
    onStatusChange: v => updateRecord(p.id, 'qc', 'records', r.id, {
      status: v
    }),
    onRemove: () => removeRecord(p.id, 'qc', 'records', r.id)
  }, /*#__PURE__*/React.createElement("div", {
    className: "fieldgrid cols-3"
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "\u9A8C\u8D27\u65E5\u671F",
    type: "date",
    mono: true,
    value: r.date,
    onChange: v => updateRecord(p.id, 'qc', 'records', r.id, {
      date: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u9A8C\u8D27\u4EBA\u5458",
    value: r.inspector,
    onChange: v => updateRecord(p.id, 'qc', 'records', r.id, {
      inspector: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u7ED3\u8BBA",
    value: r.result,
    options: ['通过', '有条件通过', '不通过'],
    onChange: v => updateRecord(p.id, 'qc', 'records', r.id, {
      result: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u95EE\u9898/\u5907\u6CE8",
    wide: true,
    multi: true,
    value: r.issues,
    onChange: v => updateRecord(p.id, 'qc', 'records', r.id, {
      issues: v
    })
  }))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement(AddRecordButton, {
    label: "\u6DFB\u52A0\u9A8C\u8D27\u8BB0\u5F55",
    onClick: () => addRecord(p.id, 'qc', 'records', {
      date: '',
      inspector: '',
      result: '通过',
      issues: ''
    })
  }))), /*#__PURE__*/React.createElement(StageCard, {
    stage: STAGES[11],
    productId: p.id,
    stageKey: "shipment",
    stageData: ship
  }, /*#__PURE__*/React.createElement("div", {
    className: "record-list"
  }, (ship.records || []).map((r, idx) => /*#__PURE__*/React.createElement(RecordCard, {
    key: r.id,
    index: 'SH' + (idx + 1),
    title: `出货记录 ${idx + 1}`,
    color: STAGES[11].color,
    status: r.status,
    onStatusChange: v => updateRecord(p.id, 'shipment', 'records', r.id, {
      status: v
    }),
    onRemove: () => removeRecord(p.id, 'shipment', 'records', r.id)
  }, /*#__PURE__*/React.createElement("div", {
    className: "fieldgrid cols-4"
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "\u51FA\u8D27\u65E5\u671F",
    type: "date",
    mono: true,
    value: r.shipDate,
    onChange: v => updateRecord(p.id, 'shipment', 'records', r.id, {
      shipDate: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u7269\u6D41\u65B9\u5F0F",
    value: r.method,
    options: ['海运', '空运', '快递', '卡车'],
    onChange: v => updateRecord(p.id, 'shipment', 'records', r.id, {
      method: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u670D\u52A1\u5546",
    value: r.carrier,
    onChange: v => updateRecord(p.id, 'shipment', 'records', r.id, {
      carrier: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u8FD0\u5355\u53F7",
    mono: true,
    value: r.tracking,
    onChange: v => updateRecord(p.id, 'shipment', 'records', r.id, {
      tracking: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u6570\u91CF",
    type: "number",
    mono: true,
    suffix: "pcs",
    value: r.qty,
    onChange: v => updateRecord(p.id, 'shipment', 'records', r.id, {
      qty: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u5230\u6E2F ETA",
    type: "date",
    mono: true,
    value: r.etaPort,
    onChange: v => updateRecord(p.id, 'shipment', 'records', r.id, {
      etaPort: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u5165\u4ED3 ETA",
    type: "date",
    mono: true,
    value: r.etaFBA,
    onChange: v => updateRecord(p.id, 'shipment', 'records', r.id, {
      etaFBA: v
    })
  }))))), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement(AddRecordButton, {
    label: "\u6DFB\u52A0\u51FA\u8D27\u8BB0\u5F55",
    onClick: () => addRecord(p.id, 'shipment', 'records', {
      shipDate: '',
      method: '海运',
      carrier: '',
      tracking: '',
      qty: 0,
      etaPort: '',
      etaFBA: ''
    })
  }))));
}

// ============ TAB: 上架运营 ============
function TabOps({
  p
}) {
  const {
    updateStage
  } = useProducts();
  const set = (k, patch) => updateStage(p.id, k, patch);
  const kw = p.stages.keywords || {};
  const lst = p.stages.listing || {};
  const ho = p.stages.handover || {};
  const pr = p.stages.promotion || {};
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(StageCard, {
    stage: STAGES[12],
    productId: p.id,
    stageKey: "keywords",
    stageData: kw
  }, /*#__PURE__*/React.createElement("div", {
    className: "fieldgrid cols-3"
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "\u5173\u952E\u8BCD\u5DE5\u5177",
    value: kw.tool,
    options: ['Helium 10', 'Cerebro', '卖家精灵', 'Jungle Scout', '其他'],
    onChange: v => set('keywords', {
      tool: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u4E3B\u5173\u952E\u8BCD",
    value: kw.mainKw,
    onChange: v => set('keywords', {
      mainKw: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u5173\u952E\u8BCD\u6570\u91CF",
    type: "number",
    mono: true,
    value: kw.kwCount,
    onChange: v => set('keywords', {
      kwCount: v
    })
  }))), /*#__PURE__*/React.createElement(StageCard, {
    stage: STAGES[13],
    productId: p.id,
    stageKey: "listing",
    stageData: lst
  }, /*#__PURE__*/React.createElement("div", {
    className: "fieldgrid cols-3"
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "ASIN",
    mono: true,
    value: lst.asin,
    onChange: v => set('listing', {
      asin: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u7236 ASIN",
    mono: true,
    value: lst.parentAsin,
    onChange: v => set('listing', {
      parentAsin: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "SKU",
    mono: true,
    value: p.sku,
    onChange: () => {}
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u4E0A\u67B6\u65E5\u671F",
    type: "date",
    mono: true,
    value: lst.launchDate,
    onChange: v => set('listing', {
      launchDate: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u552E\u4EF7 ($)",
    type: "number",
    mono: true,
    prefix: "$",
    value: lst.price,
    onChange: v => set('listing', {
      price: v
    })
  })), /*#__PURE__*/React.createElement(EditField, {
    label: "Listing \u6807\u9898",
    wide: true,
    multi: true,
    value: lst.title,
    onChange: v => set('listing', {
      title: v
    })
  })), /*#__PURE__*/React.createElement(StageCard, {
    stage: STAGES[14],
    productId: p.id,
    stageKey: "handover",
    stageData: ho
  }, /*#__PURE__*/React.createElement("div", {
    className: "fieldgrid cols-3"
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "\u4EA4\u63A5\u65E5\u671F",
    type: "date",
    mono: true,
    value: ho.endDate,
    onChange: v => set('handover', {
      endDate: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u79FB\u4EA4\u65B9",
    value: ho.from,
    onChange: v => set('handover', {
      from: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u63A5\u6536\u65B9",
    value: ho.to,
    onChange: v => set('handover', {
      to: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u4EA4\u63A5\u6587\u6863",
    wide: true,
    multi: true,
    value: ho.docs,
    onChange: v => set('handover', {
      docs: v
    })
  }))), /*#__PURE__*/React.createElement(StageCard, {
    stage: STAGES[15],
    productId: p.id,
    stageKey: "promotion",
    stageData: pr
  }, /*#__PURE__*/React.createElement("div", {
    className: "fieldgrid cols-3"
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "\u5E7F\u544A\u5F00\u59CB",
    type: "date",
    mono: true,
    value: pr.adStartDate,
    onChange: v => set('promotion', {
      adStartDate: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u65E5\u9884\u7B97 ($)",
    type: "number",
    mono: true,
    prefix: "$",
    value: pr.adBudget,
    onChange: v => set('promotion', {
      adBudget: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "Vine \u6295\u653E\u65E5",
    type: "date",
    mono: true,
    value: pr.vineDate,
    onChange: v => set('promotion', {
      vineDate: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "Vine \u6570\u91CF",
    type: "number",
    mono: true,
    value: pr.vineUnits,
    onChange: v => set('promotion', {
      vineUnits: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u9996\u6761\u8BC4\u4EF7\u65E5",
    type: "date",
    mono: true,
    value: pr.firstReviewDate,
    onChange: v => set('promotion', {
      firstReviewDate: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u5E7F\u544A\u7B56\u7565",
    wide: true,
    multi: true,
    value: pr.strategy,
    onChange: v => set('promotion', {
      strategy: v
    })
  }))));
}

// ============ TAB: 返单复盘 ============
function TabReview({
  p
}) {
  const {
    updateStage,
    addRecord,
    updateRecord,
    removeRecord,
    addSubShipment,
    updateSubShipment,
    removeSubShipment,
    addLog
  } = useProducts();
  const ro = p.stages.reorder || {
    records: []
  };
  const rv = p.stages.review || {};
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(StageCard, {
    stage: STAGES[16],
    productId: p.id,
    stageKey: "reorder",
    stageData: ro
  }, /*#__PURE__*/React.createElement("div", {
    className: "record-list"
  }, (ro.records || []).map((r, idx) => {
    // auto-compute total
    const total = (Number(r.qty) || 0) * (Number(r.unitPrice) || 0);
    const taxIncl = r.unitPrice ? +(r.unitPrice * (1 + (Number(r.taxRate) || 0) / 100)).toFixed(4) : 0;
    const subQty = (r.subShipments || []).reduce((s, x) => s + (Number(x.qty) || 0), 0);
    const splitOk = !r.subShipments?.length || subQty === Number(r.qty);
    return /*#__PURE__*/React.createElement("div", {
      key: r.id,
      className: "reorder-card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "record-hdr"
    }, /*#__PURE__*/React.createElement("div", {
      className: "record-num",
      style: {
        background: STAGES[16].color,
        color: '#fff'
      }
    }, "#", idx + 1), /*#__PURE__*/React.createElement("span", {
      className: "record-title"
    }, r.orderNo || '返单 ' + (idx + 1)), /*#__PURE__*/React.createElement("span", {
      className: "record-dates"
    }, r.orderDate || '—', " \xB7 ", r.qty || 0, " pcs \xB7 \xA5", total.toFixed(0)), /*#__PURE__*/React.createElement(StatusSelect, {
      value: r.status,
      size: "sm",
      onChange: v => updateRecord(p.id, 'reorder', 'records', r.id, {
        status: v
      })
    }), /*#__PURE__*/React.createElement("button", {
      className: "record-remove",
      onClick: () => removeRecord(p.id, 'reorder', 'records', r.id)
    }, "\u2715")), /*#__PURE__*/React.createElement("div", {
      className: "record-body"
    }, /*#__PURE__*/React.createElement("div", {
      className: "fieldgrid cols-4"
    }, /*#__PURE__*/React.createElement(EditField, {
      label: "\u8FD4\u5355\u5355\u53F7",
      value: r.orderNo,
      onChange: v => updateRecord(p.id, 'reorder', 'records', r.id, {
        orderNo: v
      })
    }), /*#__PURE__*/React.createElement(EditField, {
      label: "\u4F9B\u5E94\u5546",
      value: r.supplier,
      onChange: v => updateRecord(p.id, 'reorder', 'records', r.id, {
        supplier: v
      })
    }), /*#__PURE__*/React.createElement(EditField, {
      label: "\u8FD4\u5355\u65F6\u95F4",
      type: "date",
      mono: true,
      value: r.orderDate,
      onChange: v => updateRecord(p.id, 'reorder', 'records', r.id, {
        orderDate: v
      })
    }), /*#__PURE__*/React.createElement(EditField, {
      label: "\u89E6\u53D1\u5E93\u5B58",
      type: "number",
      mono: true,
      value: r.triggerInv,
      onChange: v => updateRecord(p.id, 'reorder', 'records', r.id, {
        triggerInv: v
      })
    }), /*#__PURE__*/React.createElement(EditField, {
      label: "\u6570\u91CF",
      type: "number",
      mono: true,
      suffix: "pcs",
      value: r.qty,
      onChange: v => updateRecord(p.id, 'reorder', 'records', r.id, {
        qty: v
      })
    }), /*#__PURE__*/React.createElement(EditField, {
      label: "\u5355\u4EF7 (\xA5)",
      type: "number",
      mono: true,
      prefix: "\xA5",
      value: r.unitPrice,
      onChange: v => updateRecord(p.id, 'reorder', 'records', r.id, {
        unitPrice: v
      })
    }), /*#__PURE__*/React.createElement(EditField, {
      label: "\u7A0E\u70B9",
      type: "number",
      mono: true,
      suffix: "%",
      value: r.taxRate,
      onChange: v => updateRecord(p.id, 'reorder', 'records', r.id, {
        taxRate: v
      })
    }), /*#__PURE__*/React.createElement(EditField, {
      label: "\u542B\u7A0E\u5355\u4EF7 (\xA5)",
      type: "number",
      mono: true,
      prefix: "\xA5",
      value: taxIncl,
      onChange: v => {
        const incl = Number(v);
        const rate = Number(r.taxRate || 0);
        const base = +(incl / (1 + rate / 100)).toFixed(4);
        updateRecord(p.id, 'reorder', 'records', r.id, {
          taxIncl: incl,
          unitPrice: base
        });
      }
    }), /*#__PURE__*/React.createElement(EditField, {
      label: "\u603B\u91D1\u989D (\xA5)",
      type: "number",
      mono: true,
      prefix: "\xA5",
      value: total.toFixed(2),
      onChange: () => {}
    }), /*#__PURE__*/React.createElement(EditField, {
      label: "\u7269\u6D41\u65B9\u5F0F",
      value: r.method,
      options: ['海运', '空运', '空+派', '快递', '卡车'],
      onChange: v => updateRecord(p.id, 'reorder', 'records', r.id, {
        method: v
      })
    }), /*#__PURE__*/React.createElement(EditField, {
      label: "\u51FA\u8D27\u65F6\u95F4",
      type: "date",
      mono: true,
      value: r.shipDate,
      onChange: v => updateRecord(p.id, 'reorder', 'records', r.id, {
        shipDate: v
      })
    }), /*#__PURE__*/React.createElement(EditField, {
      label: "\u670D\u52A1\u5546",
      value: r.carrier,
      onChange: v => updateRecord(p.id, 'reorder', 'records', r.id, {
        carrier: v
      })
    }), /*#__PURE__*/React.createElement(EditField, {
      label: "\u9884\u8BA1\u5230\u8D27",
      type: "date",
      mono: true,
      value: r.etaDate,
      onChange: v => updateRecord(p.id, 'reorder', 'records', r.id, {
        etaDate: v
      })
    }), /*#__PURE__*/React.createElement(EditField, {
      label: "\u5B9E\u9645\u5230\u8D27",
      type: "date",
      mono: true,
      value: r.actualEta,
      onChange: v => updateRecord(p.id, 'reorder', 'records', r.id, {
        actualEta: v
      })
    })), /*#__PURE__*/React.createElement("div", {
      className: "sub-ship-block"
    }, /*#__PURE__*/React.createElement("div", {
      className: "sub-ship-hdr"
    }, /*#__PURE__*/React.createElement("span", {
      className: "sub-ship-title"
    }, "\u5206\u6279\u5230\u8D27\u660E\u7EC6"), /*#__PURE__*/React.createElement("span", {
      className: "sub-ship-sum mono" + (!splitOk ? ' warn' : '')
    }, subQty, " / ", r.qty || 0, " pcs ", splitOk ? '' : '· 数量不一致'), /*#__PURE__*/React.createElement("button", {
      className: "btn btn-sm btn-add",
      onClick: () => {
        const letter = String.fromCharCode(65 + (r.subShipments || []).length);
        addSubShipment(p.id, r.id, {
          batchNo: letter,
          qty: 0,
          shipDate: '',
          method: r.method || '海运',
          carrier: '',
          tracking: '',
          etaDate: '',
          actualEta: ''
        });
      }
    }, "+ \u6DFB\u52A0\u6279\u6B21")), /*#__PURE__*/React.createElement("table", {
      className: "ss-table"
    }, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement("th", null, "\u6279\u6B21"), /*#__PURE__*/React.createElement("th", null, "\u6570\u91CF"), /*#__PURE__*/React.createElement("th", null, "\u51FA\u8D27\u65E5\u671F"), /*#__PURE__*/React.createElement("th", null, "\u7269\u6D41\u65B9\u5F0F"), /*#__PURE__*/React.createElement("th", null, "\u670D\u52A1\u5546"), /*#__PURE__*/React.createElement("th", null, "\u8FD0\u5355\u53F7"), /*#__PURE__*/React.createElement("th", null, "\u9884\u8BA1\u5230\u8D27"), /*#__PURE__*/React.createElement("th", null, "\u5B9E\u9645\u5230\u8D27"), /*#__PURE__*/React.createElement("th", null, "\u72B6\u6001"), /*#__PURE__*/React.createElement("th", null))), /*#__PURE__*/React.createElement("tbody", null, (r.subShipments || []).map(ss => /*#__PURE__*/React.createElement("tr", {
      key: ss.id
    }, /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("input", {
      className: "cell",
      style: {
        width: 36,
        textAlign: 'center'
      },
      value: ss.batchNo,
      onChange: e => updateSubShipment(p.id, r.id, ss.id, {
        batchNo: e.target.value
      })
    })), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("input", {
      className: "cell mono",
      type: "number",
      value: ss.qty,
      onChange: e => updateSubShipment(p.id, r.id, ss.id, {
        qty: Number(e.target.value)
      })
    })), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("input", {
      className: "cell mono",
      type: "date",
      value: ss.shipDate,
      onChange: e => updateSubShipment(p.id, r.id, ss.id, {
        shipDate: e.target.value
      })
    })), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("select", {
      className: "cell",
      value: ss.method,
      onChange: e => updateSubShipment(p.id, r.id, ss.id, {
        method: e.target.value
      })
    }, /*#__PURE__*/React.createElement("option", {
      value: ""
    }, "\u2014"), /*#__PURE__*/React.createElement("option", null, "\u6D77\u8FD0"), /*#__PURE__*/React.createElement("option", null, "\u7A7A\u8FD0"), /*#__PURE__*/React.createElement("option", null, "\u7A7A+\u6D3E"), /*#__PURE__*/React.createElement("option", null, "\u5FEB\u9012"), /*#__PURE__*/React.createElement("option", null, "\u5361\u8F66"))), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("input", {
      className: "cell",
      value: ss.carrier,
      onChange: e => updateSubShipment(p.id, r.id, ss.id, {
        carrier: e.target.value
      })
    })), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("input", {
      className: "cell mono",
      style: {
        fontSize: 11
      },
      value: ss.tracking,
      onChange: e => updateSubShipment(p.id, r.id, ss.id, {
        tracking: e.target.value
      })
    })), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("input", {
      className: "cell mono",
      type: "date",
      value: ss.etaDate,
      onChange: e => updateSubShipment(p.id, r.id, ss.id, {
        etaDate: e.target.value
      })
    })), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("input", {
      className: "cell mono",
      type: "date",
      value: ss.actualEta,
      onChange: e => updateSubShipment(p.id, r.id, ss.id, {
        actualEta: e.target.value
      })
    })), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement(StatusSelect, {
      value: ss.status,
      size: "sm",
      onChange: v => updateSubShipment(p.id, r.id, ss.id, {
        status: v
      })
    })), /*#__PURE__*/React.createElement("td", null, /*#__PURE__*/React.createElement("button", {
      className: "row-del",
      onClick: () => removeSubShipment(p.id, r.id, ss.id)
    }, "\u2715")))))))));
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 10
    }
  }, /*#__PURE__*/React.createElement(AddRecordButton, {
    label: "\u6DFB\u52A0\u8FD4\u5355",
    onClick: () => addRecord(p.id, 'reorder', 'records', {
      orderNo: 'RO-' + new Date().toISOString().slice(0, 7).replace('-', '-'),
      supplier: '',
      orderDate: '',
      triggerInv: 0,
      qty: 0,
      unitPrice: 0,
      taxRate: 13,
      totalAmount: 0,
      shipDate: '',
      method: '海运',
      carrier: '',
      etaDate: '',
      actualEta: '',
      subShipments: []
    })
  }))), /*#__PURE__*/React.createElement(StageCard, {
    stage: STAGES[17],
    productId: p.id,
    stageKey: "review",
    stageData: rv
  }, /*#__PURE__*/React.createElement("div", {
    className: "fieldgrid cols-3"
  }, /*#__PURE__*/React.createElement(EditField, {
    label: "\u590D\u76D8\u65E5\u671F",
    type: "date",
    mono: true,
    value: rv.endDate,
    onChange: v => updateStage(p.id, 'review', {
      endDate: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "3 \u6708\u9500\u91CF",
    type: "number",
    mono: true,
    value: rv.monthSales3,
    onChange: v => updateStage(p.id, 'review', {
      monthSales3: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u5B9E\u9645\u51C0\u5229\u7387",
    type: "number",
    mono: true,
    suffix: "%",
    value: rv.actualMargin,
    onChange: v => updateStage(p.id, 'review', {
      actualMargin: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u5E73\u5747\u8BC4\u5206",
    type: "number",
    mono: true,
    value: rv.rating,
    onChange: v => updateStage(p.id, 'review', {
      rating: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u6210\u529F\u70B9",
    wide: true,
    multi: true,
    value: rv.successPoints,
    onChange: v => updateStage(p.id, 'review', {
      successPoints: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u95EE\u9898\u70B9",
    wide: true,
    multi: true,
    value: rv.issues,
    onChange: v => updateStage(p.id, 'review', {
      issues: v
    })
  }), /*#__PURE__*/React.createElement(EditField, {
    label: "\u6539\u8FDB\u65B9\u5411",
    wide: true,
    multi: true,
    value: rv.improvements,
    onChange: v => updateStage(p.id, 'review', {
      improvements: v
    })
  }))), /*#__PURE__*/React.createElement("div", {
    className: "stage-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stage-card-hdr"
  }, /*#__PURE__*/React.createElement("div", {
    className: "stage-card-bar",
    style: {
      background: 'var(--ink-3)'
    }
  }), /*#__PURE__*/React.createElement("span", {
    className: "stage-card-title"
  }, "\u52A8\u6001\u65E5\u5FD7"), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 'auto',
      fontSize: 11,
      color: 'var(--ink-4)'
    }
  }, p.logs?.length || 0, " \u6761\u8BB0\u5F55")), /*#__PURE__*/React.createElement("div", {
    className: "stage-card-body"
  }, /*#__PURE__*/React.createElement("div", {
    className: "logs-list"
  }, (p.logs || []).map(l => /*#__PURE__*/React.createElement("div", {
    key: l.id,
    className: "log-row"
  }, /*#__PURE__*/React.createElement("span", {
    className: "date"
  }, l.date), /*#__PURE__*/React.createElement("span", {
    className: "text"
  }, l.text)))), /*#__PURE__*/React.createElement(LogAdder, {
    onAdd: text => addLog(p.id, text)
  }))));
}
function LogAdder({
  onAdd
}) {
  const [v, setV] = React.useState('');
  return /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 12,
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("input", {
    className: "input",
    value: v,
    onChange: e => setV(e.target.value),
    onKeyDown: e => {
      if (e.key === 'Enter' && v.trim()) {
        onAdd(v.trim());
        setV('');
      }
    },
    placeholder: "\u6DFB\u52A0\u4E00\u6761\u65E5\u5FD7\u2026(\u56DE\u8F66\u63D0\u4EA4)",
    style: {
      flex: 1,
      height: 30,
      padding: '0 10px',
      border: '1px solid var(--border)',
      borderRadius: 4,
      background: 'var(--bg)',
      color: 'var(--ink)',
      fontSize: 12.5,
      outline: 'none'
    }
  }), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm btn-primary",
    onClick: () => {
      if (v.trim()) {
        onAdd(v.trim());
        setV('');
      }
    }
  }, "\u6DFB\u52A0"));
}

// ============ DETAIL ============
function Detail({
  p
}) {
  const {
    update,
    duplicateProduct,
    removeProduct,
    exportProduct
  } = useProducts();
  const [tab, setTab] = React.useState('eval');
  if (!p) return /*#__PURE__*/React.createElement("div", {
    className: "detail"
  }, /*#__PURE__*/React.createElement("div", {
    className: "empty-hint",
    style: {
      margin: 40
    }
  }, "\u8BF7\u4ECE\u5DE6\u4FA7\u9009\u62E9\u4E00\u4E2A\u4EA7\u54C1"));
  const tabCounts = {
    eval: STAGES.filter(s => s.tab === 'eval').length,
    sup: STAGES.filter(s => s.tab === 'sup').length,
    design: STAGES.filter(s => s.tab === 'design').length,
    prod: STAGES.filter(s => s.tab === 'prod').length,
    ops: STAGES.filter(s => s.tab === 'ops').length,
    review: STAGES.filter(s => s.tab === 'review').length
  };
  return /*#__PURE__*/React.createElement("div", {
    className: "detail",
    "data-screen-label": "Product detail"
  }, /*#__PURE__*/React.createElement("div", {
    className: "detail-hdr"
  }, /*#__PURE__*/React.createElement("div", {
    className: "detail-hdr-top"
  }, /*#__PURE__*/React.createElement("div", {
    className: "detail-title-wrap"
  }, /*#__PURE__*/React.createElement("div", {
    className: "detail-title"
  }, /*#__PURE__*/React.createElement("input", {
    className: "title-edit",
    value: p.name,
    onChange: e => update(p.id, prev => ({
      ...prev,
      name: e.target.value
    }))
  }), /*#__PURE__*/React.createElement("select", {
    className: "status-edit",
    value: p.status,
    onChange: e => update(p.id, prev => ({
      ...prev,
      status: e.target.value
    }))
  }, /*#__PURE__*/React.createElement("option", {
    value: "active"
  }, "\u8FDB\u884C\u4E2D"), /*#__PURE__*/React.createElement("option", {
    value: "hold"
  }, "\u5DF2\u6682\u505C"), /*#__PURE__*/React.createElement("option", {
    value: "done"
  }, "\u5DF2\u5B8C\u6210"), /*#__PURE__*/React.createElement("option", {
    value: "cancel"
  }, "\u5DF2\u53D6\u6D88"))), /*#__PURE__*/React.createElement("div", {
    className: "detail-meta"
  }, /*#__PURE__*/React.createElement("span", {
    className: "detail-meta-item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "SKU"), /*#__PURE__*/React.createElement("input", {
    className: "meta-edit mono",
    value: p.sku,
    onChange: e => update(p.id, prev => ({
      ...prev,
      sku: e.target.value
    }))
  })), /*#__PURE__*/React.createElement("span", {
    className: "detail-meta-item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "\u54C1\u7C7B"), /*#__PURE__*/React.createElement("input", {
    className: "meta-edit",
    value: p.category,
    onChange: e => update(p.id, prev => ({
      ...prev,
      category: e.target.value
    }))
  })), /*#__PURE__*/React.createElement("span", {
    className: "detail-meta-item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "\u8D1F\u8D23\u4EBA"), /*#__PURE__*/React.createElement("input", {
    className: "meta-edit",
    value: p.lead,
    onChange: e => update(p.id, prev => ({
      ...prev,
      lead: e.target.value
    }))
  })), /*#__PURE__*/React.createElement("span", {
    className: "detail-meta-item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "\u7ACB\u9879"), /*#__PURE__*/React.createElement("input", {
    className: "meta-edit mono",
    type: "date",
    value: p.createdAt,
    onChange: e => update(p.id, prev => ({
      ...prev,
      createdAt: e.target.value
    }))
  })), /*#__PURE__*/React.createElement("span", {
    className: "detail-meta-item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "lbl"
  }, "\u5F53\u524D\u9636\u6BB5"), /*#__PURE__*/React.createElement("select", {
    className: "meta-edit",
    value: p.currentStage,
    onChange: e => update(p.id, prev => ({
      ...prev,
      currentStage: e.target.value
    }))
  }, STAGES.map(s => /*#__PURE__*/React.createElement("option", {
    key: s.key,
    value: s.key
  }, s.name)))))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: () => duplicateProduct(p.id)
  }, "\uD83D\uDCCB \u590D\u5236"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    onClick: () => exportProduct(p.id)
  }, "\u2193 \u5BFC\u51FA"), /*#__PURE__*/React.createElement("button", {
    className: "btn btn-sm",
    style: {
      color: 'var(--red)'
    },
    onClick: () => {
      if (confirm(`确定删除产品「${p.name}」？\n此操作不可恢复（但可通过导入 JSON 恢复）。`)) {
        removeProduct(p.id);
      }
    }
  }, "\uD83D\uDDD1 \u5220\u9664"))), /*#__PURE__*/React.createElement("div", {
    className: "detail-progressbar"
  }, STAGES.map(s => {
    const sd = p.stages[s.key] || {};
    const isDone = sd.status === 'done';
    const isActive = sd.status === 'active';
    const isHold = sd.status === 'hold';
    return /*#__PURE__*/React.createElement("div", {
      key: s.key,
      className: "seg",
      title: `${s.name} · ${STAGE_STATUSES.find(x => x.value === (sd.status || 'idle'))?.label}`,
      style: {
        background: isDone || isActive ? s.color : isHold ? '#9333ea' : 'var(--border)',
        opacity: isDone ? 1 : isActive ? 0.75 : isHold ? 0.55 : 0.35
      }
    });
  }), /*#__PURE__*/React.createElement("div", {
    className: "progress-edit"
  }, /*#__PURE__*/React.createElement("input", {
    type: "range",
    min: 0,
    max: 100,
    value: p.progress,
    onChange: e => update(p.id, prev => ({
      ...prev,
      progress: Number(e.target.value)
    }))
  }), /*#__PURE__*/React.createElement("input", {
    type: "number",
    min: 0,
    max: 100,
    className: "pct-input mono",
    value: p.progress,
    onChange: e => update(p.id, prev => ({
      ...prev,
      progress: Math.max(0, Math.min(100, Number(e.target.value)))
    }))
  }), /*#__PURE__*/React.createElement("span", null, "%"))), /*#__PURE__*/React.createElement("div", {
    className: "detail-tabs"
  }, TABS.map(t => /*#__PURE__*/React.createElement("button", {
    key: t.key,
    className: "detail-tab",
    "data-active": tab === t.key,
    onClick: () => setTab(t.key)
  }, /*#__PURE__*/React.createElement("span", {
    className: "ic"
  }, t.icon), /*#__PURE__*/React.createElement("span", null, t.name), /*#__PURE__*/React.createElement("span", {
    className: "num"
  }, tabCounts[t.key]))))), /*#__PURE__*/React.createElement("div", {
    className: "detail-body"
  }, tab === 'eval' && /*#__PURE__*/React.createElement(TabEval, {
    p: p
  }), tab === 'sup' && /*#__PURE__*/React.createElement(TabSup, {
    p: p
  }), tab === 'design' && /*#__PURE__*/React.createElement(TabDesign, {
    p: p
  }), tab === 'prod' && /*#__PURE__*/React.createElement(TabProd, {
    p: p
  }), tab === 'ops' && /*#__PURE__*/React.createElement(TabOps, {
    p: p
  }), tab === 'review' && /*#__PURE__*/React.createElement(TabReview, {
    p: p
  })));
}
window.Detail = Detail;
window.TabSup = TabSup;
window.TabDesign = TabDesign;
window.TabProd = TabProd;
window.TabOps = TabOps;
window.TabReview = TabReview;