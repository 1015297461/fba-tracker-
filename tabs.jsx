/* eslint-disable no-undef */
// Tabs: 供应商/打样, 内容设计, 生产出货, 上架运营, 返单复盘 — fully editable

// ============ TAB: SKU 变体管理 ============
function TabVariants({ p }) {
  const { addVariant, updateVariant, removeVariant } = useProducts();
  const variants = p.variants || [];
  return (
    <div className="stage-card">
      <div className="stage-card-hdr">
        <div className="stage-card-bar" style={{background:'#3b82f6'}}></div>
        <span className="stage-card-title">SKU 变体管理</span>
        <span style={{marginLeft:'auto', fontSize:11, color:'var(--ink-4)'}}>
          {variants.length ? variants.length + ' 个变体' : '单 SKU（无变体）'}
        </span>
      </div>
      <div className="stage-card-body">
        {variants.length === 0 ? (
          <p className="variants-empty-hint">
            当前为单 SKU 模式。添加变体后，利润测算、BOM、打样、Listing、推广将支持按变体独立记录；生产订单可同时包含多个 SKU。
          </p>
        ) : (
          <table className="variant-list-table">
            <thead>
              <tr>
                <th style={{width:36}}>#</th>
                <th>变体名称</th>
                <th>子 SKU / 型号</th>
                <th>颜色 / 尺寸 / 配置</th>
                <th style={{width:36}}></th>
              </tr>
            </thead>
            <tbody>
              {variants.map((v, idx) => (
                <tr key={v.id}>
                  <td className="variant-list-no">{idx + 1}</td>
                  <td><input className="cell" value={v.name}
                    onChange={e => updateVariant(p.id, v.id, { name: e.target.value })} /></td>
                  <td><input className="cell mono" value={v.sku}
                    onChange={e => updateVariant(p.id, v.id, { sku: e.target.value })} /></td>
                  <td><input className="cell" value={v.colorOrSize}
                    onChange={e => updateVariant(p.id, v.id, { colorOrSize: e.target.value })} /></td>
                  <td>
                    <button className="row-del" onClick={() => {
                      if (_variantInUse(p, v.id)) { alert('该变体已在订单/出货/返单中被引用，无法删除。'); return; }
                      if (confirm('确定删除变体「' + (v.name || v.sku || 'SKU ' + (idx+1)) + '」？')) removeVariant(p.id, v.id);
                    }}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{marginTop:12}}>
          <AddRecordButton label="添加变体" onClick={() => addVariant(p.id, { name:'', sku:'', colorOrSize:'' })} />
        </div>
      </div>
    </div>
  );
}

// ============ TAB: 供应商/打样 ============
function TabSup({ p }) {
  const { updateStage, addRecord, updateRecord, removeRecord,
          updateVariantStage, addVariantRecord, updateVariantRecord, removeVariantRecord } = useProducts();
  const sup = p.stages.supplier || { suppliers:[] };
  const sampling = p.stages.sampling || { rounds:[] };
  const cert = p.stages.cert || {};
  const variants = p.variants || [];
  const hasVariants = variants.length > 0;
  const [samplingVId, setSamplingVId] = React.useState(variants[0]?.id || null);
  const selectedSV = variants.find(v => v.id === samplingVId) || variants[0] || null;
  const samplingData = hasVariants ? (selectedSV?.stages?.sampling || { rounds:[] }) : sampling;
  const samplingRounds = samplingData.rounds || [];

  const doAddRound = (data) => hasVariants
    ? addVariantRecord(p.id, selectedSV.id, 'sampling', 'rounds', data)
    : addRecord(p.id, 'sampling', 'rounds', data);
  const doUpdateRound = (rid, patch) => hasVariants
    ? updateVariantRecord(p.id, selectedSV.id, 'sampling', 'rounds', rid, patch)
    : updateRecord(p.id, 'sampling', 'rounds', rid, patch);
  const doRemoveRound = (rid) => hasVariants
    ? removeVariantRecord(p.id, selectedSV.id, 'sampling', 'rounds', rid)
    : removeRecord(p.id, 'sampling', 'rounds', rid);
  const doSetFinal = (rid, checked) => {
    const next = samplingRounds.map(x => ({ ...x, isFinal: x.id === rid ? checked : (checked ? false : x.isFinal) }));
    hasVariants
      ? updateVariantStage(p.id, selectedSV.id, 'sampling', { rounds: next })
      : updateStage(p.id, 'sampling', { rounds: next });
  };

  return (
    <>
      <StageCard stage={STAGES[4]} productId={p.id} stageKey="supplier" stageData={sup}>
        <table className="sup-table editable">
          <thead>
            <tr>
              <th style={{width:'18%'}}>供应商</th>
              <th style={{width:'20%'}}>联系方式</th>
              <th style={{textAlign:'right'}}>报价(¥)</th>
              <th style={{textAlign:'right'}}>MOQ</th>
              <th style={{textAlign:'right'}}>周期(天)</th>
              <th style={{textAlign:'right'}}>评分</th>
              <th style={{width:'20%'}}>备注</th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {(sup.suppliers || []).map(s => (
              <tr key={s.id} className={s.selected ? 'selected' : ''}>
                <td><input className="cell" value={s.name} onChange={e => updateRecord(p.id, 'supplier', 'suppliers', s.id, { name:e.target.value })} /></td>
                <td><input className="cell mono" style={{fontSize:11}} value={s.contact} onChange={e => updateRecord(p.id, 'supplier', 'suppliers', s.id, { contact:e.target.value })} /></td>
                <td className="num"><input className="cell mono" type="number" step="0.01" value={s.price} onChange={e => updateRecord(p.id, 'supplier', 'suppliers', s.id, { price:Number(e.target.value) })} /></td>
                <td className="num"><input className="cell mono" type="number" value={s.moq} onChange={e => updateRecord(p.id, 'supplier', 'suppliers', s.id, { moq:Number(e.target.value) })} /></td>
                <td className="num"><input className="cell mono" type="number" value={s.lead} onChange={e => updateRecord(p.id, 'supplier', 'suppliers', s.id, { lead:Number(e.target.value) })} /></td>
                <td className="num"><input className="cell mono" type="number" value={s.score} onChange={e => updateRecord(p.id, 'supplier', 'suppliers', s.id, { score:Number(e.target.value) })} /></td>
                <td><input className="cell" value={s.remark||''} placeholder="备注" onChange={e => updateRecord(p.id, 'supplier', 'suppliers', s.id, { remark:e.target.value })} /></td>
                <td>
                  {s.selected
                    ? <span style={{color:'var(--blue)',fontWeight:600,fontSize:11}}>✓ 已选定</span>
                    : <button className="btn btn-sm" onClick={() => {
                        const next = (sup.suppliers || []).map(x => ({ ...x, selected: x.id === s.id }));
                        updateStage(p.id, 'supplier', { suppliers: next });
                      }}>选定</button>}
                </td>
                <td><button className="row-del" onClick={() => removeRecord(p.id, 'supplier', 'suppliers', s.id)}>✕</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{marginTop:10}}>
          <AddRecordButton label="添加供应商" onClick={() => addRecord(p.id, 'supplier', 'suppliers', { name:'', contact:'', price:0, moq:0, lead:0, score:0, remark:'', selected:false })} />
        </div>
        <div style={{marginTop:12}}>
          <EditField label="最终确认备注 (账期/质保/包装要求)" multi wide value={sup.finalNote}
            onChange={v => updateStage(p.id, 'supplier', { finalNote:v })} />
        </div>
      </StageCard>

      <StageCard stage={STAGES[5]} productId={p.id} stageKey="sampling" stageData={p.stages.sampling || {}}>
        {hasVariants && <VariantSelector p={p} selectedId={selectedSV?.id} onSelect={setSamplingVId} />}
        <div className="record-list">
          {samplingRounds.map((r, idx) => (
            <RecordCard key={r.id} index={r.round || idx+1} title={`打样轮次 #${r.round || idx+1}`}
              color={STAGES[5].color}
              status={r.status}
              isFinal={r.isFinal}
              onStatusChange={v => doUpdateRound(r.id, { status:v })}
              onRemove={() => doRemoveRound(r.id)}>
              <div className="fieldgrid cols-4">
                <EditField label="下单日期" type="date" mono value={r.orderDate}
                  onChange={v => doUpdateRound(r.id, { orderDate:v })} />
                <EditField label="数量" type="number" mono value={r.qty} suffix="pcs"
                  onChange={v => doUpdateRound(r.id, { qty:v })} />
                <EditField label="费用 (¥)" type="number" mono prefix="¥" value={r.cost}
                  onChange={v => doUpdateRound(r.id, { cost:v })} />
                <EditField label="收样日期" type="date" mono value={r.receivedDate}
                  onChange={v => doUpdateRound(r.id, { receivedDate:v })} />
                <EditField label="评审结果" wide multi value={r.result}
                  onChange={v => doUpdateRound(r.id, { result:v })} />
              </div>
              <label className="final-toggle">
                <input type="checkbox" checked={!!r.isFinal}
                  onChange={e => doSetFinal(r.id, e.target.checked)} />
                <span>标记为最终版本</span>
              </label>
            </RecordCard>
          ))}
        </div>
        <div style={{marginTop:10}}>
          <AddRecordButton label="添加打样轮次" onClick={() => {
            const nextRound = (samplingRounds.reduce((m, r) => Math.max(m, r.round || 0), 0)) + 1;
            doAddRound({ round: nextRound, orderDate:'', qty:0, cost:0, receivedDate:'', result:'', isFinal:false });
          }} />
        </div>
      </StageCard>

      <StageCard stage={STAGES[6]} productId={p.id} stageKey="cert" stageData={cert}>
        <div className="fieldgrid cols-3">
          <EditField label="认证类型" value={cert.types}
            onChange={v => updateStage(p.id, 'cert', { types:v })} />
          <EditField label="检测机构" value={cert.agency}
            onChange={v => updateStage(p.id, 'cert', { agency:v })} />
          <EditField label="费用 (¥)" type="number" mono prefix="¥" value={cert.cost}
            onChange={v => updateStage(p.id, 'cert', { cost:v })} />
          <EditField label="预计完成" type="date" mono value={cert.expectedDate}
            onChange={v => updateStage(p.id, 'cert', { expectedDate:v })} />
          <EditField label="实际完成" type="date" mono value={cert.doneDate}
            onChange={v => updateStage(p.id, 'cert', { doneDate:v })} />
        </div>
      </StageCard>
    </>
  );
}

// ============ VOC 分析卡片 ============
function VocCard({ p }) {
  const { updateStage } = useProducts();
  const voc = p.stages.voc || {};

  const add = (key, defaults) => {
    const cur = voc[key] || [];
    updateStage(p.id, 'voc', { [key]: [...cur, { id: Date.now().toString(36), ...defaults }] });
  };
  const upd = (key, id, patch) => {
    updateStage(p.id, 'voc', { [key]: (voc[key] || []).map(x => x.id === id ? { ...x, ...patch } : x) });
  };
  const rem = (key, id) => {
    updateStage(p.id, 'voc', { [key]: (voc[key] || []).filter(x => x.id !== id) });
  };

  const VocSection = ({ secKey, secName, addLabel, children }) => (
    <div className="voc-section">
      <div className="voc-sec-hdr">
        <span className="voc-sec-name">{secName}</span>
        <button className="btn btn-sm" onClick={() => add(secKey, addLabel === '场景' ? { title:'', detail:'' } : addLabel === '人群' ? { title:'', detail:'' } : { title:'', detail:'', priority:'', appliedTo:'' })}>+ 添加{addLabel}</button>
      </div>
      {(voc[secKey] || []).length > 0 && children}
    </div>
  );

  return (
    <div className="voc-card">
      <datalist id="voc-apply-opts">
        <option value="标题" />
        <option value="五点描述" />
        <option value="A+" />
        <option value="广告文案" />
        <option value="品牌故事" />
      </datalist>
      <div className="voc-card-hdr">
        <span className="voc-card-title">VOC 分析</span>
        <span className="voc-card-sub">用户场景 · 目标人群 · 核心卖点</span>
        <div className="voc-card-meta">
          <StatusSelect value={voc.status} onChange={v => updateStage(p.id, 'voc', { status: v })} size="sm" />
          <span className="voc-meta-sep">开始</span>
          <input className="cell mono voc-date" type="date" value={voc.startDate || ''} onChange={e => updateStage(p.id, 'voc', { startDate: e.target.value })} />
          <span className="voc-meta-sep">结束</span>
          <input className="cell mono voc-date" type="date" value={voc.endDate || ''} onChange={e => updateStage(p.id, 'voc', { endDate: e.target.value })} />
        </div>
      </div>
      <div className="voc-card-body">

        <VocSection secKey="useCases" secName="使用场景" addLabel="场景">
          <table className="sup-table editable">
            <thead><tr><th style={{width:'28%'}}>场景</th><th>详情</th><th></th></tr></thead>
            <tbody>
              {(voc.useCases || []).map(item => (
                <tr key={item.id}>
                  <td><input className="cell" value={item.title || ''} placeholder="场景名称" onChange={e => upd('useCases', item.id, { title: e.target.value })} /></td>
                  <td><input className="cell" value={item.detail || ''} placeholder="场景描述" onChange={e => upd('useCases', item.id, { detail: e.target.value })} /></td>
                  <td><button className="row-del" onClick={() => rem('useCases', item.id)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </VocSection>

        <VocSection secKey="audiences" secName="使用人群" addLabel="人群">
          <table className="sup-table editable">
            <thead><tr><th style={{width:'28%'}}>人群</th><th>详情</th><th></th></tr></thead>
            <tbody>
              {(voc.audiences || []).map(item => (
                <tr key={item.id}>
                  <td><input className="cell" value={item.title || ''} placeholder="人群类型" onChange={e => upd('audiences', item.id, { title: e.target.value })} /></td>
                  <td><input className="cell" value={item.detail || ''} placeholder="人群描述" onChange={e => upd('audiences', item.id, { detail: e.target.value })} /></td>
                  <td><button className="row-del" onClick={() => rem('audiences', item.id)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </VocSection>

        <VocSection secKey="sellingPoints" secName="核心卖点" addLabel="卖点">
          <table className="sup-table editable">
            <thead>
              <tr>
                <th style={{width:'22%'}}>卖点</th>
                <th>详情</th>
                <th style={{width:'72px', textAlign:'center'}}>优先级</th>
                <th style={{width:'96px'}}>应用于</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(voc.sellingPoints || []).map(item => (
                <tr key={item.id}>
                  <td><input className="cell" value={item.title || ''} placeholder="卖点名称" onChange={e => upd('sellingPoints', item.id, { title: e.target.value })} /></td>
                  <td><input className="cell" value={item.detail || ''} placeholder="卖点描述" onChange={e => upd('sellingPoints', item.id, { detail: e.target.value })} /></td>
                  <td className="num">
                    <select className="cell mono" style={{textAlign:'center'}} value={item.priority || ''} onChange={e => upd('sellingPoints', item.id, { priority: e.target.value })}>
                      <option value="">—</option>
                      {[1,2,3,4,5].map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </td>
                  <td>
                    <input className="cell" list="voc-apply-opts" value={item.appliedTo || ''} placeholder="应用于…"
                      onChange={e => upd('sellingPoints', item.id, { appliedTo: e.target.value })} />
                  </td>
                  <td><button className="row-del" onClick={() => rem('sellingPoints', item.id)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </VocSection>

      </div>
    </div>
  );
}

// ============ TAB: 内容设计 ============
function TabDesign({ p }) {
  const { updateStage, addRecord, updateRecord, removeRecord } = useProducts();
  const pack = p.stages.packaging || { rounds:[] };
  const vis = p.stages.visuals || { rounds:[] };

  return (
    <>
      <VocCard p={p} />
      <StageCard stage={STAGES[7]} productId={p.id} stageKey="packaging" stageData={pack}>
        <div className="record-list">
          {(pack.rounds || []).map((r, idx) => (
            <RecordCard key={r.id} index={r.round || idx+1} title={`包装设计 #${r.round || idx+1}`}
              color={STAGES[7].color} status={r.status} isFinal={r.isFinal}
              onStatusChange={v => updateRecord(p.id, 'packaging', 'rounds', r.id, { status:v })}
              onRemove={() => removeRecord(p.id, 'packaging', 'rounds', r.id)}>
              <div className="fieldgrid cols-4">
                <EditField label="需求提交日" type="date" mono value={r.briefDate}
                  onChange={v => updateRecord(p.id, 'packaging', 'rounds', r.id, { briefDate:v })} />
                <EditField label="设计师" value={r.designer}
                  onChange={v => updateRecord(p.id, 'packaging', 'rounds', r.id, { designer:v })} />
                <EditField label="初稿完成" type="date" mono value={r.draftDate}
                  onChange={v => updateRecord(p.id, 'packaging', 'rounds', r.id, { draftDate:v })} />
                <EditField label="确认日期" type="date" mono value={r.confirmDate}
                  onChange={v => updateRecord(p.id, 'packaging', 'rounds', r.id, { confirmDate:v })} />
                <EditField label="包装尺寸 (L×W×H cm)" value={r.pkgSize}
                  onChange={v => updateRecord(p.id, 'packaging', 'rounds', r.id, { pkgSize:v })} />
                <EditField label="包装重量 (kg)" type="number" mono value={r.pkgWeight}
                  onChange={v => updateRecord(p.id, 'packaging', 'rounds', r.id, { pkgWeight:v })} />
                <EditField label="FBA尺寸分级" value={r.fbaSizeTier}
                  onChange={v => updateRecord(p.id, 'packaging', 'rounds', r.id, { fbaSizeTier:v })} />
                <EditField label="FBA费用 ($)" type="number" mono prefix="$" value={r.fbaFee}
                  onChange={v => updateRecord(p.id, 'packaging', 'rounds', r.id, { fbaFee:v })} />
              </div>
              <label className="final-toggle">
                <input type="checkbox" checked={!!r.isFinal}
                  onChange={e => updateRecord(p.id, 'packaging', 'rounds', r.id, { isFinal: e.target.checked })} />
                <span>标记为最终版本</span>
              </label>
            </RecordCard>
          ))}
        </div>
        <div style={{marginTop:10}}>
          <AddRecordButton label="添加包装轮次" onClick={() => {
            const next = ((pack.rounds || []).reduce((m, r) => Math.max(m, r.round || 0), 0)) + 1;
            addRecord(p.id, 'packaging', 'rounds', { round: next, briefDate:'', designer:'', draftDate:'', confirmDate:'', pkgSize:'', pkgWeight:'', fbaSizeTier:'', fbaFee:'', isFinal:false });
          }} />
        </div>
      </StageCard>

      <StageCard stage={STAGES[8]} productId={p.id} stageKey="visuals" stageData={vis}>
        <div className="record-list">
          {(vis.rounds || []).map((r, idx) => (
            <RecordCard key={r.id} index={r.round || idx+1} title={`视觉素材 #${r.round || idx+1}`}
              color={STAGES[8].color} status={r.status} isFinal={r.isFinal}
              onStatusChange={v => updateRecord(p.id, 'visuals', 'rounds', r.id, { status:v })}
              onRemove={() => removeRecord(p.id, 'visuals', 'rounds', r.id)}>
              <div className="fieldgrid cols-4">
                <EditField label="需求提交日" type="date" mono value={r.briefDate}
                  onChange={v => updateRecord(p.id, 'visuals', 'rounds', r.id, { briefDate:v })} />
                <EditField label="摄影/设计" value={r.designer}
                  onChange={v => updateRecord(p.id, 'visuals', 'rounds', r.id, { designer:v })} />
                <EditField label="拍摄日期" type="date" mono value={r.shootDate}
                  onChange={v => updateRecord(p.id, 'visuals', 'rounds', r.id, { shootDate:v })} />
                <EditField label="主图数量" type="number" mono value={r.mainImgCount}
                  onChange={v => updateRecord(p.id, 'visuals', 'rounds', r.id, { mainImgCount:v })} />
                <EditField label="A+ 完成日" type="date" mono value={r.aPlusDate}
                  onChange={v => updateRecord(p.id, 'visuals', 'rounds', r.id, { aPlusDate:v })} />
              </div>
              <label className="final-toggle">
                <input type="checkbox" checked={!!r.isFinal}
                  onChange={e => updateRecord(p.id, 'visuals', 'rounds', r.id, { isFinal: e.target.checked })} />
                <span>标记为最终版本</span>
              </label>
            </RecordCard>
          ))}
        </div>
        <div style={{marginTop:10}}>
          <AddRecordButton label="添加视觉轮次" onClick={() => {
            const next = ((vis.rounds || []).reduce((m, r) => Math.max(m, r.round || 0), 0)) + 1;
            addRecord(p.id, 'visuals', 'rounds', { round: next, briefDate:'', designer:'', shootDate:'', mainImgCount:0, aPlusDate:'', isFinal:false });
          }} />
        </div>
      </StageCard>
    </>
  );
}

// ============ TAB: 生产出货 ============
function TabProd({ p }) {
  const { addRecord, updateRecord, removeRecord,
          addBatchItem, updateBatchItem, removeBatchItem,
          addBatchExtra, updateBatchExtra, removeBatchExtra } = useProducts();
  const prod = p.stages.production || { batches:[] };
  const qc = p.stages.qc || { records:[] };
  const variants = p.variants || [];
  const hasVariants = variants.length > 0;

  return (
    <>
      <StageCard stage={STAGES[9]} productId={p.id} stageKey="production" stageData={prod}>
        <div className="record-list">
          {(prod.batches || []).map((b, idx) => {
            const skuSubtotal = hasVariants && (b.items||[]).length > 0
              ? (b.items||[]).reduce((s,i) => s + (Number(i.qty)||0)*(Number(i.unitPrice)||0), 0)
              : (Number(b.qty)||0) * (Number(b.unitPrice)||0);
            const extraSubtotal = (b.extraCosts||[]).reduce((s,c) => s + (Number(c.qty)||0)*(Number(c.unitPrice)||0), 0);
            const skuTotal = skuSubtotal + extraSubtotal;
            const depositPct  = Number(b.depositPct) || 0;
            const balancePct  = b.balancePct != null ? Number(b.balancePct) : Math.max(0, 100 - depositPct);
            const theorDeposit = +(skuTotal * depositPct  / 100).toFixed(2);
            const theorBalance = +(skuTotal * balancePct  / 100).toFixed(2);
            return (
              <RecordCard key={b.id} index={b.batchNo || ('B'+(idx+1))} title={`生产批次 ${b.batchNo || 'B'+(idx+1)}`}
                color={STAGES[9].color} status={b.status}
                onStatusChange={v => updateRecord(p.id, 'production', 'batches', b.id, { status:v })}
                onRemove={() => removeRecord(p.id, 'production', 'batches', b.id)}>

                {/* 基本信息 */}
                <div className="fieldgrid cols-4">
                  <EditField label="批次号" value={b.batchNo}
                    onChange={v => updateRecord(p.id, 'production', 'batches', b.id, { batchNo:v })} />
                  {(() => {
                    const supNames = (p.stages.supplier?.suppliers || []).map(s => s.name).filter(Boolean);
                    return supNames.length > 0 ? (
                      <EditField label="工厂" value={b.factory || ''}
                        options={[{ value:'', label:'— 选择供应商 —' }, ...supNames.map(n => ({ value:n, label:n }))]}
                        onChange={v => updateRecord(p.id, 'production', 'batches', b.id, { factory:v })} />
                    ) : (
                      <EditField label="工厂" value={b.factory || ''}
                        onChange={v => updateRecord(p.id, 'production', 'batches', b.id, { factory:v })} />
                    );
                  })()}
                  <EditField label="下单日期" type="date" mono value={b.orderDate}
                    onChange={v => updateRecord(p.id, 'production', 'batches', b.id, { orderDate:v })} />
                  <EditField label="预计出货" type="date" mono value={b.expectedShip}
                    onChange={v => updateRecord(p.id, 'production', 'batches', b.id, { expectedShip:v })} />
                </div>

                {/* 单SKU：数量 + 单价 + SKU小计 */}
                {!hasVariants && (
                  <div className="fieldgrid cols-4" style={{marginTop:8}}>
                    <EditField label="数量" type="number" mono suffix="pcs" value={b.qty}
                      onChange={v => updateRecord(p.id, 'production', 'batches', b.id, { qty:v })} />
                    <EditField label="单价 (¥)" type="number" mono prefix="¥" value={b.unitPrice}
                      onChange={v => updateRecord(p.id, 'production', 'batches', b.id, { unitPrice:v })} />
                    <div />
                    <div className="calc-field">
                      <span className="calc-field-label">SKU 小计</span>
                      <span className="calc-field-value mono">¥{skuSubtotal.toFixed(2)}</span>
                    </div>
                  </div>
                )}

                {/* 多SKU：明细表 + 总金额汇总 */}
                {hasVariants && (
                  <div className="sku-items-block">
                    <div className="sku-items-hdr">
                      <span className="sku-items-title">SKU 明细</span>
                      <span className="sku-items-sum mono">
                        共 {(b.items||[]).reduce((s,i)=>s+(Number(i.qty)||0),0)} pcs
                        &nbsp;·&nbsp;SKU 小计 <strong>¥{skuSubtotal.toFixed(2)}</strong>
                      </span>
                      <button className="btn btn-sm btn-add" onClick={() => {
                        const v0 = variants[0];
                        addBatchItem(p.id, b.id, { variantId:v0?.id||'', variantName:v0?.name||v0?.sku||'SKU', qty:0, unitPrice:0 });
                      }}>+ 添加 SKU</button>
                    </div>
                    <table className="sku-items-table">
                      <thead><tr><th>变体</th><th className="num">数量</th><th className="num">单价(¥)</th><th className="num">小计(¥)</th><th></th></tr></thead>
                      <tbody>
                        {(b.items||[]).map(item => (
                          <tr key={item.id}>
                            <td>
                              <select className="cell" value={item.variantId}
                                onChange={e => {
                                  const v = variants.find(v => v.id === e.target.value);
                                  updateBatchItem(p.id, b.id, item.id, { variantId:v?.id||'', variantName:v?.name||v?.sku||'SKU' });
                                }}>
                                {variants.map(v => <option key={v.id} value={v.id}>{v.name||v.colorOrSize||v.sku||'SKU'}</option>)}
                              </select>
                            </td>
                            <td className="num"><input className="cell mono" type="number" value={item.qty} onChange={e => updateBatchItem(p.id, b.id, item.id, { qty:Number(e.target.value) })} /></td>
                            <td className="num"><input className="cell mono" type="number" step="0.01" value={item.unitPrice} onChange={e => updateBatchItem(p.id, b.id, item.id, { unitPrice:Number(e.target.value) })} /></td>
                            <td className="num">¥{((Number(item.qty)||0)*(Number(item.unitPrice)||0)).toFixed(2)}</td>
                            <td><button className="row-del" onClick={() => removeBatchItem(p.id, b.id, item.id)}>✕</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* 其他费用（代采配件/运费等） */}
                <div className="sku-items-block">
                  <div className="sku-items-hdr">
                    <span className="sku-items-title">其他费用</span>
                    <span className="sku-items-sum mono">
                      {(b.extraCosts||[]).length > 0
                        ? <>小计 <strong>¥{extraSubtotal.toFixed(2)}</strong></>
                        : '代采配件 / 运费 / 其他'}
                    </span>
                    <button className="btn btn-sm btn-add" onClick={() =>
                      addBatchExtra(p.id, b.id, { name:'', qty:1, unitPrice:0 })
                    }>+ 添加费用</button>
                  </div>
                  {(b.extraCosts||[]).length > 0 && (
                    <table className="sku-items-table">
                      <thead>
                        <tr>
                          <th style={{width:'40%'}}>名称</th>
                          <th className="num">数量</th>
                          <th className="num">单价(¥)</th>
                          <th className="num">小计(¥)</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {(b.extraCosts||[]).map(c => (
                          <tr key={c.id}>
                            <td><input className="cell" value={c.name} placeholder="费用名称"
                              onChange={e => updateBatchExtra(p.id, b.id, c.id, { name:e.target.value })} /></td>
                            <td className="num"><input className="cell mono" type="number" value={c.qty}
                              onChange={e => updateBatchExtra(p.id, b.id, c.id, { qty:Number(e.target.value) })} /></td>
                            <td className="num"><input className="cell mono" type="number" step="0.01" value={c.unitPrice}
                              onChange={e => updateBatchExtra(p.id, b.id, c.id, { unitPrice:Number(e.target.value) })} /></td>
                            <td className="num">¥{((Number(c.qty)||0)*(Number(c.unitPrice)||0)).toFixed(2)}</td>
                            <td><button className="row-del" onClick={() => removeBatchExtra(p.id, b.id, c.id)}>✕</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* 付款条款 */}
                <div className="payment-section">
                  <div className="payment-section-title">付款条款</div>
                  <div className="fieldgrid cols-4">
                    <div className="calc-field">
                      <span className="calc-field-label">订单总金额</span>
                      <span className="calc-field-value mono" style={{fontWeight:600,color:'var(--blue)'}}>¥{skuTotal.toFixed(2)}</span>
                    </div>
                    <div /><div /><div />
                    <EditField label="预付款比例" type="number" mono suffix="%" value={b.depositPct}
                      onChange={v => updateRecord(p.id, 'production', 'batches', b.id, { depositPct:v })} />
                    <div className="calc-field">
                      <span className="calc-field-label">理论预付款</span>
                      <span className="calc-field-value mono">¥{theorDeposit.toFixed(2)}</span>
                    </div>
                    <EditField label="实际预付款 (¥)" type="number" mono prefix="¥" value={b.depositActual||0}
                      onChange={v => updateRecord(p.id, 'production', 'batches', b.id, { depositActual:v })} />
                    <EditField label="预付款日期" type="date" mono value={b.depositDate||''}
                      onChange={v => updateRecord(p.id, 'production', 'batches', b.id, { depositDate:v })} />
                    <EditField label="尾款比例" type="number" mono suffix="%" value={balancePct}
                      onChange={v => updateRecord(p.id, 'production', 'batches', b.id, { balancePct:Number(v) })} />
                    <div className="calc-field">
                      <span className="calc-field-label">理论尾款</span>
                      <span className="calc-field-value mono">¥{theorBalance.toFixed(2)}</span>
                    </div>
                    <EditField label="实际尾款 (¥)" type="number" mono prefix="¥" value={b.balanceAmt||0}
                      onChange={v => updateRecord(p.id, 'production', 'batches', b.id, { balanceAmt:v })} />
                    <EditField label="尾款支付日期" type="date" mono value={b.balanceDate||''}
                      onChange={v => updateRecord(p.id, 'production', 'batches', b.id, { balanceDate:v })} />
                  </div>
                </div>

                <div className="fieldgrid cols-4" style={{marginTop:8}}>
                  <EditField label="批次备注" wide multi value={b.note}
                    onChange={v => updateRecord(p.id, 'production', 'batches', b.id, { note:v })} />
                </div>
              </RecordCard>
            );
          })}
        </div>
        <div style={{marginTop:10}}>
          <AddRecordButton label="添加生产批次" onClick={() => {
            const idx = (prod.batches || []).length + 1;
            addRecord(p.id, 'production', 'batches', {
              batchNo: 'B'+idx, orderDate: '', factory: '', qty: 0, unitPrice: 0,
              depositPct: 30, depositActual: 0, depositDate: '',
              balancePct: 70, balanceAmt: 0, balanceDate: '',
              expectedShip: '', note: '', items: [], extraCosts: [],
            });
          }} />
        </div>
      </StageCard>

      <StageCard stage={STAGES[10]} productId={p.id} stageKey="qc" stageData={qc}>
        <div className="record-list">
          {(qc.records || []).map((r, idx) => (
            <RecordCard key={r.id} index={'QC' + (idx+1)} title={`验货记录 ${idx+1}`}
              color={STAGES[10].color} status={r.status}
              onStatusChange={v => updateRecord(p.id, 'qc', 'records', r.id, { status:v })}
              onRemove={() => removeRecord(p.id, 'qc', 'records', r.id)}>
              <div className="fieldgrid cols-3">
                <EditField label="验货日期" type="date" mono value={r.date}
                  onChange={v => updateRecord(p.id, 'qc', 'records', r.id, { date:v })} />
                <EditField label="验货人员" value={r.inspector}
                  onChange={v => updateRecord(p.id, 'qc', 'records', r.id, { inspector:v })} />
                <EditField label="结论" value={r.result}
                  options={['通过','有条件通过','不通过']}
                  onChange={v => updateRecord(p.id, 'qc', 'records', r.id, { result:v })} />
                <EditField label="问题/备注" wide multi value={r.issues}
                  onChange={v => updateRecord(p.id, 'qc', 'records', r.id, { issues:v })} />
              </div>
            </RecordCard>
          ))}
        </div>
        <div style={{marginTop:10}}>
          <AddRecordButton label="添加验货记录" onClick={() => addRecord(p.id, 'qc', 'records', { date:'', inspector:'', result:'通过', issues:'' })} />
        </div>
      </StageCard>

    </>
  );
}

// ============ TAB: 上架运营 ============
function TabOps({ p }) {
  const { updateStage, updateVariantStage } = useProducts();
  const variants = p.variants || [];
  const hasVariants = variants.length > 0;
  const [listingVId, setListingVId] = React.useState(variants[0]?.id || null);
  const [promoVId, setPromoVId] = React.useState(variants[0]?.id || null);
  const selectedLV = variants.find(v => v.id === listingVId) || variants[0] || null;
  const selectedPV = variants.find(v => v.id === promoVId) || variants[0] || null;

  const set = (k, patch) => updateStage(p.id, k, patch);
  const kw = p.stages.keywords || {};
  const ho = p.stages.handover || {};
  const lst = hasVariants ? (selectedLV?.stages?.listing || {}) : (p.stages.listing || {});
  const pr = hasVariants ? (selectedPV?.stages?.promotion || {}) : (p.stages.promotion || {});
  const setLst = (patch) => hasVariants
    ? updateVariantStage(p.id, selectedLV.id, 'listing', patch)
    : updateStage(p.id, 'listing', patch);
  const setPr = (patch) => hasVariants
    ? updateVariantStage(p.id, selectedPV.id, 'promotion', patch)
    : updateStage(p.id, 'promotion', patch);

  return (
    <>
      <StageCard stage={STAGES[12]} productId={p.id} stageKey="keywords" stageData={kw}>
        <div className="fieldgrid cols-3">
          <EditField label="关键词工具" value={kw.tool}
            options={['Helium 10','Cerebro','卖家精灵','Jungle Scout','其他']}
            onChange={v => set('keywords', { tool:v })} />
          <EditField label="主关键词" value={kw.mainKw} onChange={v => set('keywords', { mainKw:v })} />
          <EditField label="关键词数量" type="number" mono value={kw.kwCount} onChange={v => set('keywords', { kwCount:v })} />
        </div>
      </StageCard>

      <StageCard stage={STAGES[13]} productId={p.id} stageKey="listing" stageData={p.stages.listing || {}}>
        {hasVariants && <VariantSelector p={p} selectedId={selectedLV?.id} onSelect={setListingVId} />}
        <div className="fieldgrid cols-3">
          <EditField label="ASIN" mono value={lst.asin} onChange={v => setLst({ asin:v })} />
          <EditField label="父 ASIN" mono value={lst.parentAsin} onChange={v => setLst({ parentAsin:v })} />
          <EditField label="SKU" mono value={hasVariants ? (selectedLV?.sku || p.sku) : p.sku} onChange={() => {}} />
          <EditField label="上架日期" type="date" mono value={lst.launchDate} onChange={v => setLst({ launchDate:v })} />
          <EditField label="售价 ($)" type="number" mono prefix="$" value={lst.price} onChange={v => setLst({ price:v })} />
        </div>
        <EditField label="Listing 标题" wide multi value={lst.title} onChange={v => setLst({ title:v })} />
      </StageCard>

      <StageCard stage={STAGES[14]} productId={p.id} stageKey="handover" stageData={ho}>
        <div className="fieldgrid cols-3">
          <EditField label="交接日期" type="date" mono value={ho.endDate}
            onChange={v => set('handover', { endDate:v })} />
          <EditField label="移交方" value={ho.from} onChange={v => set('handover', { from:v })} />
          <EditField label="接收方" value={ho.to} onChange={v => set('handover', { to:v })} />
          <EditField label="交接文档" wide multi value={ho.docs} onChange={v => set('handover', { docs:v })} />
        </div>
      </StageCard>

      <StageCard stage={STAGES[15]} productId={p.id} stageKey="promotion" stageData={p.stages.promotion || {}}>
        {hasVariants && <VariantSelector p={p} selectedId={selectedPV?.id} onSelect={setPromoVId} />}
        <div className="fieldgrid cols-3">
          <EditField label="广告开始" type="date" mono value={pr.adStartDate}
            onChange={v => setPr({ adStartDate:v })} />
          <EditField label="日预算 ($)" type="number" mono prefix="$" value={pr.adBudget}
            onChange={v => setPr({ adBudget:v })} />
          <EditField label="Vine 投放日" type="date" mono value={pr.vineDate}
            onChange={v => setPr({ vineDate:v })} />
          <EditField label="Vine 数量" type="number" mono value={pr.vineUnits}
            onChange={v => setPr({ vineUnits:v })} />
          <EditField label="首条评价日" type="date" mono value={pr.firstReviewDate}
            onChange={v => setPr({ firstReviewDate:v })} />
          <EditField label="广告策略" wide multi value={pr.strategy}
            onChange={v => setPr({ strategy:v })} />
        </div>
      </StageCard>
    </>
  );
}

// ============ TAB: 物流与复盘 ============
function TabReview({ p }) {
  const { updateStage, addRecord, updateRecord, removeRecord, addSubShipment, updateSubShipment, removeSubShipment, addLog } = useProducts();
  const prod = p.stages.production || { batches: [] };
  const ro = p.stages.reorder || { records:[] };
  const rv = p.stages.review || {};

  return (
    <>
      <StageCard stage={STAGES[16]} productId={p.id} stageKey="reorder" stageData={ro}>
        <div className="record-list">
          {(ro.records || []).map((r, idx) => {
            // auto-compute total
            const total = (Number(r.qty)||0) * (Number(r.unitPrice)||0);
            const taxIncl = r.unitPrice ? +(r.unitPrice * (1 + (Number(r.taxRate)||0)/100)).toFixed(4) : 0;
            const subQty = (r.subShipments||[]).reduce((s, x) => s + (Number(x.qty)||0), 0);
            const splitOk = !r.subShipments?.length || subQty === Number(r.qty);
            return (
              <div key={r.id} className="reorder-card">
                <div className="record-hdr">
                  <div className="record-num" style={{background: STAGES[16].color, color:'#fff'}}>#{idx+1}</div>
                  <span className="record-title">{r.orderNo || '物流订单 ' + (idx+1)}</span>
                  <span className="record-dates">{r.orderDate || '—'} · {r.qty || 0} pcs · ¥{total.toFixed(0)}</span>
                  <StatusSelect value={r.status} size="sm"
                    onChange={v => updateRecord(p.id, 'reorder', 'records', r.id, { status:v })} />
                  <button className="record-remove" onClick={() => removeRecord(p.id, 'reorder', 'records', r.id)}>✕</button>
                </div>
                <div className="record-body">
                  <div className="fieldgrid cols-4">
                    <EditField label="关联生产批次" value={r.batchRef || ''}
                      options={[
                        { value: '', label: '— 不关联 —' },
                        ...(prod.batches || []).map(b => ({
                          value: b.id,
                          label: (b.batchNo || 'B?') + (b.factory ? ' · ' + b.factory : '') + (b.expectedShip ? ' (' + b.expectedShip + ')' : ''),
                        })),
                      ]}
                      onChange={v => {
                        const patch = { batchRef: v };
                        if (v) {
                          const batch = (prod.batches || []).find(b => b.id === v);
                          if (batch) {
                            const bQty = batch.items?.length > 0
                              ? batch.items.reduce((s, i) => s + (Number(i.qty)||0), 0)
                              : (Number(batch.qty) || 0);
                            if (bQty) patch.qty = bQty;
                            if (Number(batch.unitPrice)) patch.unitPrice = Number(batch.unitPrice);
                          }
                        }
                        updateRecord(p.id, 'reorder', 'records', r.id, patch);
                      }} />
                    <EditField label="物流单号" value={r.orderNo}
                      onChange={v => updateRecord(p.id, 'reorder', 'records', r.id, { orderNo:v })} />
                    <EditField label="供应商" value={r.supplier}
                      onChange={v => updateRecord(p.id, 'reorder', 'records', r.id, { supplier:v })} />
                    <EditField label="下单时间" type="date" mono value={r.orderDate}
                      onChange={v => updateRecord(p.id, 'reorder', 'records', r.id, { orderDate:v })} />
                    <EditField label="触发库存" type="number" mono value={r.triggerInv}
                      onChange={v => updateRecord(p.id, 'reorder', 'records', r.id, { triggerInv:v })} />
                    <EditField label="数量" type="number" mono suffix="pcs" value={r.qty}
                      onChange={v => updateRecord(p.id, 'reorder', 'records', r.id, { qty:v })} />
                    <EditField label="单价 (¥)" type="number" mono prefix="¥" value={r.unitPrice}
                      onChange={v => updateRecord(p.id, 'reorder', 'records', r.id, { unitPrice:v })} />
                    <EditField label="税点" type="number" mono suffix="%" value={r.taxRate}
                      onChange={v => updateRecord(p.id, 'reorder', 'records', r.id, { taxRate:v })} />
                    <EditField label="含税单价 (¥)" type="number" mono prefix="¥" value={taxIncl}
                      onChange={v => {
                        const incl = Number(v);
                        const rate = Number(r.taxRate || 0);
                        const base = +(incl / (1 + rate/100)).toFixed(4);
                        updateRecord(p.id, 'reorder', 'records', r.id, { taxIncl: incl, unitPrice: base });
                      }} />
                    <EditField label="总金额 (¥)" type="number" mono prefix="¥" value={total.toFixed(2)} onChange={() => {}} />
                    <EditField label="物流方式" value={r.method}
                      options={['海运','空运','空+派','快递','卡车']}
                      onChange={v => updateRecord(p.id, 'reorder', 'records', r.id, { method:v })} />
                    <EditField label="服务商" value={r.carrier}
                      onChange={v => updateRecord(p.id, 'reorder', 'records', r.id, { carrier:v })} />
                    <EditField label="ATD (实际出货)" type="date" mono value={r.shipDate}
                      onChange={v => updateRecord(p.id, 'reorder', 'records', r.id, { shipDate:v })} />
                    <EditField label="ETA (预计到货)" type="date" mono value={r.etaDate}
                      onChange={v => updateRecord(p.id, 'reorder', 'records', r.id, { etaDate:v })} />
                    <EditField label="ATA (实际到货)" type="date" mono value={r.actualEta}
                      onChange={v => updateRecord(p.id, 'reorder', 'records', r.id, { actualEta:v })} />
                  </div>

                  {/* 分批出货明细 */}
                  <div className="sub-ship-block">
                    <div className="sub-ship-hdr">
                      <span className="sub-ship-title">分批出货明细</span>
                      <span className={"sub-ship-sum mono" + (!splitOk ? ' warn' : '')}>
                        {subQty} / {r.qty || 0} pcs {splitOk ? '' : '· 数量不一致'}
                      </span>
                      <button className="btn btn-sm btn-add" onClick={() => {
                        const letter = String.fromCharCode(65 + (r.subShipments||[]).length);
                        addSubShipment(p.id, r.id, { batchNo: letter, qty:0, etd:'', shipDate:'', method:r.method||'海运', carrier:'', tracking:'', fbaShipId:'', etaDate:'', actualEta:'' });
                      }}>+ 添加批次</button>
                    </div>
                    <table className="ss-table">
                      <thead>
                        <tr>
                          <th>批次</th>
                          <th>数量</th>
                          <th>ETD</th>
                          <th>ATD</th>
                          <th>物流方式</th>
                          <th>服务商</th>
                          <th>运单号</th>
                          <th>FBA 入仓编号</th>
                          <th>ETA</th>
                          <th>ATA</th>
                          <th>状态</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {(r.subShipments || []).map(ss => (
                          <tr key={ss.id}>
                            <td><input className="cell" style={{width:36, textAlign:'center'}} value={ss.batchNo} onChange={e => updateSubShipment(p.id, r.id, ss.id, { batchNo: e.target.value })} /></td>
                            <td><input className="cell mono" type="number" value={ss.qty} onChange={e => updateSubShipment(p.id, r.id, ss.id, { qty: Number(e.target.value) })} /></td>
                            <td><input className="cell mono" type="date" value={ss.etd||''} onChange={e => updateSubShipment(p.id, r.id, ss.id, { etd: e.target.value })} /></td>
                            <td><input className="cell mono" type="date" value={ss.shipDate||''} onChange={e => updateSubShipment(p.id, r.id, ss.id, { shipDate: e.target.value })} /></td>
                            <td>
                              <select className="cell" value={ss.method||''} onChange={e => updateSubShipment(p.id, r.id, ss.id, { method: e.target.value })}>
                                <option value="">—</option>
                                <option>海运</option><option>空运</option><option>空+派</option><option>快递</option><option>卡车</option>
                              </select>
                            </td>
                            <td><input className="cell" value={ss.carrier||''} onChange={e => updateSubShipment(p.id, r.id, ss.id, { carrier: e.target.value })} /></td>
                            <td><input className="cell mono" style={{fontSize:11}} value={ss.tracking||''} onChange={e => updateSubShipment(p.id, r.id, ss.id, { tracking: e.target.value })} /></td>
                            <td><input className="cell mono" style={{fontSize:11}} value={ss.fbaShipId||''} onChange={e => updateSubShipment(p.id, r.id, ss.id, { fbaShipId: e.target.value })} /></td>
                            <td><input className="cell mono" type="date" value={ss.etaDate||''} onChange={e => updateSubShipment(p.id, r.id, ss.id, { etaDate: e.target.value })} /></td>
                            <td><input className="cell mono" type="date" value={ss.actualEta||''} onChange={e => updateSubShipment(p.id, r.id, ss.id, { actualEta: e.target.value })} /></td>
                            <td><StatusSelect value={ss.status} size="sm" onChange={v => updateSubShipment(p.id, r.id, ss.id, { status:v })} /></td>
                            <td><button className="row-del" onClick={() => removeSubShipment(p.id, r.id, ss.id)}>✕</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{marginTop:10}}>
          <AddRecordButton label="添加物流订单" onClick={() => addRecord(p.id, 'reorder', 'records', {
            orderNo: 'RO-' + new Date().toISOString().slice(0,7),
            batchRef:'', supplier:'', orderDate:'', triggerInv:0, qty:0, unitPrice:0, taxRate:13, totalAmount:0,
            shipDate:'', method:'海运', carrier:'', etaDate:'', actualEta:'',
            items:[], subShipments:[],
          })} />
        </div>
      </StageCard>

      <StageCard stage={STAGES[17]} productId={p.id} stageKey="review" stageData={rv}>
        <div className="fieldgrid cols-3">
          <EditField label="复盘日期" type="date" mono value={rv.endDate}
            onChange={v => updateStage(p.id, 'review', { endDate:v })} />
          <EditField label="3 月销量" type="number" mono value={rv.monthSales3}
            onChange={v => updateStage(p.id, 'review', { monthSales3:v })} />
          <EditField label="实际净利率" type="number" mono suffix="%" value={rv.actualMargin}
            onChange={v => updateStage(p.id, 'review', { actualMargin:v })} />
          <EditField label="平均评分" type="number" mono value={rv.rating}
            onChange={v => updateStage(p.id, 'review', { rating:v })} />
          <EditField label="成功点" wide multi value={rv.successPoints}
            onChange={v => updateStage(p.id, 'review', { successPoints:v })} />
          <EditField label="问题点" wide multi value={rv.issues}
            onChange={v => updateStage(p.id, 'review', { issues:v })} />
          <EditField label="改进方向" wide multi value={rv.improvements}
            onChange={v => updateStage(p.id, 'review', { improvements:v })} />
        </div>
      </StageCard>

      <div className="stage-card">
        <div className="stage-card-hdr">
          <div className="stage-card-bar" style={{background:'var(--ink-3)'}}></div>
          <span className="stage-card-title">动态日志</span>
          <span style={{marginLeft:'auto', fontSize:11, color:'var(--ink-4)'}}>{p.logs?.length || 0} 条记录</span>
        </div>
        <div className="stage-card-body">
          <div className="logs-list">
            {(p.logs || []).map(l => (
              <div key={l.id} className="log-row">
                <span className="date">{l.date}</span>
                <span className="text">{l.text}</span>
              </div>
            ))}
          </div>
          <LogAdder onAdd={text => addLog(p.id, text)} />
        </div>
      </div>
    </>
  );
}

function LogAdder({ onAdd }) {
  const [v, setV] = React.useState('');
  return (
    <div style={{marginTop:12, display:'flex', gap:8}}>
      <input className="input"
        value={v} onChange={e => setV(e.target.value)}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter' && v.trim()) { onAdd(v.trim()); setV(''); }
        }}
        placeholder="添加一条日志…(回车提交)"
        style={{flex:1, height:30, padding:'0 10px', border:'1px solid var(--border)', borderRadius:4, background:'var(--bg)', color:'var(--ink)', fontSize:12.5, outline:'none'}} />
      <button className="btn btn-sm btn-primary" onClick={() => { if (v.trim()) { onAdd(v.trim()); setV(''); } }}>添加</button>
    </div>
  );
}

// ============ DETAIL ============
function Detail({ p }) {
  const { update, duplicateProduct, removeProduct, exportProduct } = useProducts();
  const [tab, setTab] = React.useState('eval');
  if (!p) return <div className="detail"><div className="empty-hint" style={{margin:40}}>请从左侧选择一个产品</div></div>;

  const tabCounts = {
    variants: (p.variants || []).length,
    eval: STAGES.filter(s => s.tab === 'eval').length,
    sup: STAGES.filter(s => s.tab === 'sup').length,
    design: STAGES.filter(s => s.tab === 'design').length,
    prod: STAGES.filter(s => s.tab === 'prod').length,
    ops: STAGES.filter(s => s.tab === 'ops').length,
    review: STAGES.filter(s => s.tab === 'review').length,
  };

  return (
    <div className="detail" data-screen-label="Product detail">
      <div className="detail-hdr">
        <div className="detail-hdr-top">
          <div className="detail-title-wrap">
            <div className="detail-title">
              <input className="title-edit"
                value={p.name}
                onChange={e => update(p.id, prev => ({ ...prev, name: e.target.value }))} />
              <select className="status-edit"
                value={p.status}
                onChange={e => update(p.id, prev => ({ ...prev, status: e.target.value }))}>
                <option value="active">进行中</option>
                <option value="hold">已暂停</option>
                <option value="done">已完成</option>
                <option value="cancel">已取消</option>
              </select>
            </div>
            <div className="detail-meta">
              <span className="detail-meta-item"><span className="lbl">SKU</span>
                <input className="meta-edit mono" value={p.sku}
                  onChange={e => update(p.id, prev => ({ ...prev, sku: e.target.value }))} />
              </span>
              <span className="detail-meta-item"><span className="lbl">品类</span>
                <input className="meta-edit" value={p.category}
                  onChange={e => update(p.id, prev => ({ ...prev, category: e.target.value }))} />
              </span>
              <span className="detail-meta-item"><span className="lbl">负责人</span>
                <input className="meta-edit" value={p.lead}
                  onChange={e => update(p.id, prev => ({ ...prev, lead: e.target.value }))} />
              </span>
              <span className="detail-meta-item"><span className="lbl">立项</span>
                <input className="meta-edit mono" type="date" value={p.createdAt}
                  onChange={e => update(p.id, prev => ({ ...prev, createdAt: e.target.value }))} />
              </span>
              <span className="detail-meta-item"><span className="lbl">当前阶段</span>
                <select className="meta-edit"
                  value={p.currentStage}
                  onChange={e => update(p.id, prev => ({ ...prev, currentStage: e.target.value }))}>
                  {STAGES.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
                </select>
              </span>
            </div>
          </div>
          <div style={{display:'flex', gap:6}}>
            <button className="btn btn-sm" onClick={() => duplicateProduct(p.id)}>📋 复制</button>
            <button className="btn btn-sm" onClick={() => exportProduct(p.id)}>↓ 导出</button>
            <button className="btn btn-sm" style={{color:'var(--red)'}}
              onClick={() => {
                if (confirm(`确定删除产品「${p.name}」？\n此操作不可恢复（但可通过导入 JSON 恢复）。`)) {
                  removeProduct(p.id);
                }
              }}>🗑 删除</button>
          </div>
        </div>
        <div className="detail-progressbar">
          {STAGES.map(s => {
            const sd = p.stages[s.key] || {};
            const isDone = sd.status === 'done';
            const isActive = sd.status === 'active';
            const isHold = sd.status === 'hold';
            return (
              <div key={s.key} className="seg"
                title={`${s.name} · ${STAGE_STATUSES.find(x=>x.value===(sd.status||'idle'))?.label}`}
                style={{
                  background: isDone || isActive ? s.color : isHold ? '#9333ea' : 'var(--border)',
                  opacity: isDone ? 1 : isActive ? 0.75 : isHold ? 0.55 : 0.35,
                }}></div>
            );
          })}
          <div className="progress-edit">
            <input type="range" min={0} max={100} value={p.progress}
              onChange={e => update(p.id, prev => ({ ...prev, progress: Number(e.target.value) }))} />
            <input type="number" min={0} max={100} className="pct-input mono" value={p.progress}
              onChange={e => update(p.id, prev => ({ ...prev, progress: Math.max(0, Math.min(100, Number(e.target.value))) }))} />
            <span>%</span>
          </div>
        </div>

        <div className="detail-tabs">
          {TABS.map(t => (
            <button key={t.key} className="detail-tab"
              data-active={tab === t.key}
              onClick={() => setTab(t.key)}>
              <span className="ic">{t.icon}</span>
              <span>{t.name}</span>
              <span className="num">{tabCounts[t.key]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="detail-body">
        {tab === 'eval' && <TabEval p={p} />}
        {tab === 'variants' && <TabVariants p={p} />}
        {tab === 'sup' && <TabSup p={p} />}
        {tab === 'design' && <TabDesign p={p} />}
        {tab === 'prod' && <TabProd p={p} />}
        {tab === 'ops' && <TabOps p={p} />}
        {tab === 'review' && <TabReview p={p} />}
      </div>
    </div>
  );
}

window.Detail = Detail;
window.TabVariants = TabVariants;
window.TabSup = TabSup;
window.TabDesign = TabDesign;
window.TabProd = TabProd;
window.TabOps = TabOps;
window.TabReview = TabReview;
