import React from 'react';
import { STAGES, TABS, STAGE_STATUSES } from '../../data/constants';
import { useProducts, _variantInUse } from '../../context/ProductContext';
import { StatusSelect, EditField, StageCard, RecordCard, AddRecordButton, VariantSelector } from '../../components';
import { TabEval } from '../list-view';
import { uid } from '../../data/products';

function TabVariants({ p }: { p: any }) {
  const { addVariant, updateVariant, removeVariant } = useProducts() as any;
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
              {variants.map((v: any, idx: number) => (
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

function TabSup({ p }: { p: any }) {
  const { updateStage, addRecord, updateRecord, removeRecord,
          updateVariantStage, addVariantRecord, updateVariantRecord, removeVariantRecord } = useProducts() as any;
  const sup = p.stages.supplier || { suppliers:[] };
  const sampling = p.stages.sampling || { rounds:[] };
  const cert = p.stages.cert || {};
  const variants = p.variants || [];
  const hasVariants = variants.length > 0;
  const [samplingVId, setSamplingVId] = React.useState(variants[0]?.id || null);
  const selectedSV = variants.find((v: any) => v.id === samplingVId) || variants[0] || null;
  const samplingData = hasVariants ? (selectedSV?.stages?.sampling || { rounds:[] }) : sampling;
  const samplingRounds = samplingData.rounds || [];

  const doAddRound = (data: any) => hasVariants
    ? addVariantRecord(p.id, selectedSV.id, 'sampling', 'rounds', data)
    : addRecord(p.id, 'sampling', 'rounds', data);
  const doUpdateRound = (rid: string, patch: any) => hasVariants
    ? updateVariantRecord(p.id, selectedSV.id, 'sampling', 'rounds', rid, patch)
    : updateRecord(p.id, 'sampling', 'rounds', rid, patch);
  const doRemoveRound = (rid: string) => hasVariants
    ? removeVariantRecord(p.id, selectedSV.id, 'sampling', 'rounds', rid)
    : removeRecord(p.id, 'sampling', 'rounds', rid);
  const doSetFinal = (rid: string, checked: boolean) => {
    const next = samplingRounds.map((x: any) => ({ ...x, isFinal: x.id === rid ? checked : (checked ? false : x.isFinal) }));
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
            {(sup.suppliers || []).map((s: any) => (
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
                        const next = (sup.suppliers || []).map((x: any) => ({ ...x, selected: x.id === s.id }));
                        updateStage(p.id, 'supplier', { suppliers: next });
                      }}>选定</button>}
                </td>
                <td><button className="row-del" onClick={() => { if (confirm('确定删除该供应商？')) removeRecord(p.id, 'supplier', 'suppliers', s.id); }}>✕</button></td>
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
          {samplingRounds.map((r: any, idx: number) => (
            <RecordCard key={r.id} index={r.round || idx+1} title={`打样轮次 #${r.round || idx+1}`}
              color={STAGES[5].color}
              status={r.status}
              isFinal={r.isFinal}
              onStatusChange={v => doUpdateRound(r.id, { status:v })}
              onRemove={() => { if (confirm('确定删除该打样轮次？')) doRemoveRound(r.id); }}>
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
            const nextRound = (samplingRounds.reduce((m: number, r: any) => Math.max(m, r.round || 0), 0)) + 1;
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

function VocSection({ secName, addLabel, items, onAdd, children }: {
  secName: string; addLabel: string; items: any[]; onAdd: () => void; children?: React.ReactNode;
}) {
  return (
    <div className="voc-section">
      <div className="voc-sec-hdr">
        <span className="voc-sec-name">{secName}</span>
        <button className="btn btn-sm" onClick={onAdd}>+ 添加{addLabel}</button>
      </div>
      {items.length > 0 && children}
    </div>
  );
}

function VocCard({ p }: { p: any }) {
  const { updateStage } = useProducts() as any;
  const voc = p.stages.voc || {};

  const add = (key: string, defaults: any) => {
    const cur = voc[key] || [];
    updateStage(p.id, 'voc', { [key]: [...cur, { id: Date.now().toString(36), ...defaults }] });
  };
  const upd = (key: string, id: string, patch: any) => {
    updateStage(p.id, 'voc', { [key]: (voc[key] || []).map((x: any) => x.id === id ? { ...x, ...patch } : x) });
  };
  const rem = (key: string, id: string) => {
    updateStage(p.id, 'voc', { [key]: (voc[key] || []).filter((x: any) => x.id !== id) });
  };

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

        <VocSection secName="使用场景" addLabel="场景" items={voc.useCases || []}
          onAdd={() => add('useCases', { title:'', detail:'' })}>
          <table className="sup-table editable">
            <thead><tr><th style={{width:'28%'}}>场景</th><th>详情</th><th></th></tr></thead>
            <tbody>
              {(voc.useCases || []).map((item: any) => (
                <tr key={item.id}>
                  <td><input className="cell" value={item.title || ''} placeholder="场景名称" onChange={e => upd('useCases', item.id, { title: e.target.value })} /></td>
                  <td><input className="cell" value={item.detail || ''} placeholder="场景描述" onChange={e => upd('useCases', item.id, { detail: e.target.value })} /></td>
                  <td><button className="row-del" onClick={() => { if (confirm('确定删除该使用场景？')) rem('useCases', item.id); }}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </VocSection>

        <VocSection secName="使用人群" addLabel="人群" items={voc.audiences || []}
          onAdd={() => add('audiences', { title:'', detail:'' })}>
          <table className="sup-table editable">
            <thead><tr><th style={{width:'28%'}}>人群</th><th>详情</th><th></th></tr></thead>
            <tbody>
              {(voc.audiences || []).map((item: any) => (
                <tr key={item.id}>
                  <td><input className="cell" value={item.title || ''} placeholder="人群类型" onChange={e => upd('audiences', item.id, { title: e.target.value })} /></td>
                  <td><input className="cell" value={item.detail || ''} placeholder="人群描述" onChange={e => upd('audiences', item.id, { detail: e.target.value })} /></td>
                  <td><button className="row-del" onClick={() => { if (confirm('确定删除该使用人群？')) rem('audiences', item.id); }}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </VocSection>

        <VocSection secName="核心卖点" addLabel="卖点" items={voc.sellingPoints || []}
          onAdd={() => add('sellingPoints', { title:'', detail:'', priority:'', appliedTo:'' })}>
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
              {(voc.sellingPoints || []).map((item: any) => (
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
                  <td><button className="row-del" onClick={() => { if (confirm('确定删除该核心卖点？')) rem('sellingPoints', item.id); }}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </VocSection>

      </div>
    </div>
  );
}

function TabDesign({ p }: { p: any }) {
  const { addRecord, updateRecord, removeRecord } = useProducts() as any;
  const pack = p.stages.packaging || { rounds:[] };
  const vis = p.stages.visuals || { rounds:[] };

  return (
    <>
      <VocCard p={p} />
      <StageCard stage={STAGES[7]} productId={p.id} stageKey="packaging" stageData={pack}>
        <div className="record-list">
          {(pack.rounds || []).map((r: any, idx: number) => (
            <RecordCard key={r.id} index={r.round || idx+1} title={`包装设计 #${r.round || idx+1}`}
              color={STAGES[7].color} status={r.status} isFinal={r.isFinal}
              onStatusChange={v => updateRecord(p.id, 'packaging', 'rounds', r.id, { status:v })}
              onRemove={() => { if (confirm('确定删除该包装设计轮次？')) removeRecord(p.id, 'packaging', 'rounds', r.id); }}>
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
            const next = ((pack.rounds || []).reduce((m: number, r: any) => Math.max(m, r.round || 0), 0)) + 1;
            addRecord(p.id, 'packaging', 'rounds', { round: next, briefDate:'', designer:'', draftDate:'', confirmDate:'', pkgSize:'', pkgWeight:'', fbaSizeTier:'', fbaFee:'', isFinal:false });
          }} />
        </div>
      </StageCard>

      <StageCard stage={STAGES[8]} productId={p.id} stageKey="visuals" stageData={vis}>
        <div className="record-list">
          {(vis.rounds || []).map((r: any, idx: number) => (
            <RecordCard key={r.id} index={r.round || idx+1} title={`视觉素材 #${r.round || idx+1}`}
              color={STAGES[8].color} status={r.status} isFinal={r.isFinal}
              onStatusChange={v => updateRecord(p.id, 'visuals', 'rounds', r.id, { status:v })}
              onRemove={() => { if (confirm('确定删除该视觉素材轮次？')) removeRecord(p.id, 'visuals', 'rounds', r.id); }}>
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
            const next = ((vis.rounds || []).reduce((m: number, r: any) => Math.max(m, r.round || 0), 0)) + 1;
            addRecord(p.id, 'visuals', 'rounds', { round: next, briefDate:'', designer:'', shootDate:'', mainImgCount:0, aPlusDate:'', isFinal:false });
          }} />
        </div>
      </StageCard>
    </>
  );
}

function TabProd({ p }: { p: any }) {
  const { addRecord, updateRecord, removeRecord,
          addBatchItem, updateBatchItem, removeBatchItem,
          addBatchExtra, updateBatchExtra, removeBatchExtra,
          addBalancePayment, updateBalancePayment, removeBalancePayment,
          addBatchShipment, updateBatchShipment, removeBatchShipment } = useProducts() as any;
  const prod = p.stages.production || { batches:[] };
  const qc = p.stages.qc || { records:[] };
  const variants = p.variants || [];
  const hasVariants = variants.length > 0;
  const [collapsedSections, setCollapsedSections] = React.useState<Set<string>>(new Set());
  const toggleSection = (key: string) => setCollapsedSections(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  const isCollapsed = (key: string) => collapsedSections.has(key);

  // 跨批次汇总：总下单量 + SKU 明细 + 总结算金额
  const allBatches = prod.batches || [];
  const totalOrderQty = allBatches.reduce((sum: number, b: any) => {
    if (hasVariants && (b.items||[]).length > 0)
      return sum + (b.items||[]).reduce((s: number, i: any) => s + (Number(i.qty)||0), 0);
    return sum + (Number(b.qty)||0);
  }, 0);

  const skuQtyMap: Record<string, { name: string; qty: number }> = {};
  if (hasVariants) {
    for (const b of allBatches) {
      for (const item of (b.items || [])) {
        const vid = item.variantId || item.id;
        if (!skuQtyMap[vid]) skuQtyMap[vid] = { name: item.variantName || item.variantId || 'SKU', qty: 0 };
        skuQtyMap[vid].qty += Number(item.qty) || 0;
      }
    }
  }

  const totalSettlement = allBatches.reduce((sum: number, b: any) => {
    const skuSub = hasVariants && (b.items||[]).length > 0
      ? (b.items||[]).reduce((s: number, i: any) => s + (Number(i.qty)||0)*(Number(i.unitPrice)||0), 0)
      : (Number(b.qty)||0) * (Number(b.unitPrice)||0);
    const extraSub = (b.extraCosts||[]).reduce((s: number, c: any) => s + (Number(c.qty)||0)*(Number(c.unitPrice)||0), 0);
    const skuTotal = skuSub + extraSub;
    const validShip = (b.shipments||[]).filter((sh: any) => !!sh.shipDate);
    const shipped = validShip.reduce((s: number, sh: any) => {
      if (hasVariants) return s + (sh.items||[]).reduce((ss: number, si: any) => {
        const bi = (b.items||[]).find((x: any) => x.variantId === si.variantId);
        return ss + (Number(si.qty)||0) * (Number(bi?.unitPrice)||0);
      }, 0);
      return s + (Number(sh.qty)||0) * (Number(b.unitPrice)||0);
    }, 0);
    return sum + (shipped > 0 ? shipped : skuTotal);
  }, 0);

  const skuEntries = Object.values(skuQtyMap).filter(e => e.qty > 0);
  const prodHeaderExtra = totalOrderQty > 0 ? (
    <div className="stage-hdr-stats">
      <span className="shs-item">
        <span className="shs-lbl">总下单</span>
        <span className="shs-val">{totalOrderQty} pcs</span>
        {skuEntries.length > 0 && (
          <span className="shs-tooltip">
            <span className="shs-tooltip-inner">
              {skuEntries.map(e => (
                <span key={e.name} className="shs-tooltip-row">
                  <span className="shs-tooltip-name">{e.name}</span>
                  <span className="shs-tooltip-qty">{e.qty} pcs</span>
                </span>
              ))}
            </span>
          </span>
        )}
      </span>
      {totalSettlement > 0 && (
        <span className="shs-item">
          <span className="shs-lbl">总结算</span>
          <span className="shs-val mono">¥{totalSettlement.toFixed(2)}</span>
        </span>
      )}
    </div>
  ) : null;

  return (
    <>
      <StageCard stage={STAGES[9]} productId={p.id} stageKey="production" stageData={prod} titleExtra={prodHeaderExtra}>
        <div className="record-list">
          {(prod.batches || []).map((b: any, idx: number) => {
            const skuSubtotal = hasVariants && (b.items||[]).length > 0
              ? (b.items||[]).reduce((s: number, i: any) => s + (Number(i.qty)||0)*(Number(i.unitPrice)||0), 0)
              : (Number(b.qty)||0) * (Number(b.unitPrice)||0);
            const extraSubtotal = (b.extraCosts||[]).reduce((s: number, c: any) => s + (Number(c.qty)||0)*(Number(c.unitPrice)||0), 0);
            const skuTotal = skuSubtotal + extraSubtotal;
            const depositPct  = Number(b.depositPct) || 0;
            const balancePct  = b.balancePct != null ? Number(b.balancePct) : Math.max(0, 100 - depositPct);
            const theorDeposit = +(skuTotal * depositPct  / 100).toFixed(2);
            const theorBalance = +(skuTotal * balancePct  / 100).toFixed(2);
            const orderQty = hasVariants && (b.items||[]).length > 0
              ? (b.items||[]).reduce((s: number, i: any) => s + (Number(i.qty)||0), 0)
              : (Number(b.qty)||0);
            const validShipments = (b.shipments||[]).filter((sh: any) => !!sh.shipDate);
            const shippedQty = validShipments.reduce((sum: number, sh: any) => {
              if (hasVariants) return sum + (sh.items||[]).reduce((s: number, i: any) => s + (Number(i.qty)||0), 0);
              return sum + (Number(sh.qty)||0);
            }, 0);
            const actualShippedValue = validShipments.reduce((sum: number, sh: any) => {
              if (hasVariants) return sum + (sh.items||[]).reduce((s: number, si: any) => {
                const bi = (b.items||[]).find((x: any) => x.variantId === si.variantId);
                return s + (Number(si.qty)||0) * (Number(bi?.unitPrice)||0);
              }, 0);
              return sum + (Number(sh.qty)||0) * (Number(b.unitPrice)||0);
            }, 0);
            const effectiveTotal = actualShippedValue > 0 ? actualShippedValue : skuTotal;
            const pendingQty = orderQty - shippedQty;
            const pendingClass = pendingQty < 0 ? 'rmc-warn' : pendingQty === 0 && orderQty > 0 ? 'rmc-done' : 'rmc-pending';
            // payment status
            const bpsForMeta = b.balancePayments || [];
            const effBpsMeta = bpsForMeta.length > 0 ? bpsForMeta
              : (Number(b.balanceAmt) || 0) > 0
                ? [{ id: b.id + '-bp0', amount: Number(b.balanceAmt) || 0, date: b.balanceDate || '', note: '' }]
                : [];
            const tailPaidMeta = effBpsMeta.reduce((s: number, bp: any) => s + (Number(bp.amount)||0), 0);
            const actualTotalPaidMeta = (Number(b.depositActual)||0) + tailPaidMeta;
            const paidComplete = effectiveTotal > 0 && actualTotalPaidMeta >= effectiveTotal;
            const paidClass = paidComplete ? 'rmc-done' : actualTotalPaidMeta > 0 ? 'rmc-pending' : 'rmc-warn';
            const batchMeta = (
              <>
                {orderQty > 0 && <span className="record-meta-chip"><span className="rmc-lbl">下单</span><span className="rmc-val">{orderQty} pcs</span></span>}
                {shippedQty > 0 && <span className="record-meta-chip"><span className="rmc-lbl">已出</span><span className="rmc-val">{shippedQty} pcs</span></span>}
                {orderQty > 0 && <span className={"record-meta-chip " + pendingClass}>
                  <span className="rmc-lbl">待出</span>
                  <span className="rmc-val">{pendingQty > 0 ? pendingQty + ' pcs' : pendingQty < 0 ? '超出' + Math.abs(pendingQty) : '✓'}</span>
                </span>}
                {effectiveTotal > 0 && <span className={"record-meta-chip " + paidClass}>
                  <span className="rmc-val">{paidComplete ? '已付清' : actualTotalPaidMeta > 0 ? '未付清 ¥' + (effectiveTotal - actualTotalPaidMeta).toFixed(2) : '未付款'}</span>
                </span>}
                {actualShippedValue > 0 && actualShippedValue !== skuTotal && (
                  <span className="record-meta-chip"><span className="rmc-lbl">结算</span><span className="rmc-val">¥{actualShippedValue.toFixed(2)}</span></span>
                )}
                {b.orderDate && <span className="record-meta-chip"><span className="rmc-lbl">下单日</span><span className="rmc-val">{b.orderDate}</span></span>}
              </>
            );
            return (
              <RecordCard key={b.id} index={b.batchNo || ('B'+(idx+1))} title={`生产批次 ${b.batchNo || 'B'+(idx+1)}`}
                color={STAGES[9].color} status={b.status}
                meta={batchMeta}
                defaultOpen={(prod.batches||[]).length <= 1}
                onStatusChange={v => updateRecord(p.id, 'production', 'batches', b.id, { status:v })}
                onRemove={() => { if (confirm('确定删除该生产批次？')) removeRecord(p.id, 'production', 'batches', b.id); }}>

                <div className="fieldgrid cols-4">
                  <EditField label="批次号" value={b.batchNo}
                    onChange={v => updateRecord(p.id, 'production', 'batches', b.id, { batchNo:v })} />
                  {(() => {
                    const supNames = (p.stages.supplier?.suppliers || []).map((s: any) => s.name).filter(Boolean);
                    return supNames.length > 0 ? (
                      <EditField label="工厂" value={b.factory || ''}
                        options={[{ value:'', label:'— 选择供应商 —' }, ...supNames.map((n: string) => ({ value:n, label:n }))]}
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

                {hasVariants && (
                  <div className="sku-items-block">
                    <div className="sku-items-hdr" style={{cursor:'pointer'}} onClick={() => toggleSection(b.id+'|sku')}>
                      <button className="sec-toggle" onClick={e => { e.stopPropagation(); toggleSection(b.id+'|sku'); }}>{isCollapsed(b.id+'|sku') ? '▸' : '▾'}</button>
                      <span className="sku-items-title">SKU 明细</span>
                      <span className="sku-items-sum mono">
                        共 {(b.items||[]).reduce((s: number, i: any) => s+(Number(i.qty)||0), 0)} pcs
                        {(() => {
                          const totalRcvd = (b.items||[]).reduce((ts: number, it: any) => ts + validShipments.reduce((s: number, sh: any) => s + ((sh.items||[]).find((si: any) => si.variantId === it.variantId)?.qty || 0), 0), 0);
                          return totalRcvd > 0 ? <>&nbsp;·&nbsp;已到 <strong>{totalRcvd} pcs</strong></> : null;
                        })()}
                        &nbsp;·&nbsp;SKU 小计 <strong>¥{skuSubtotal.toFixed(2)}</strong>
                      </span>
                      <button className="btn btn-sm btn-add" onClick={e => { e.stopPropagation(); const v0 = variants[0]; addBatchItem(p.id, b.id, { variantId:v0?.id||'', variantName:v0?.name||v0?.sku||'SKU', qty:0, unitPrice:0 }); }}>+ 添加 SKU</button>
                    </div>
                    {!isCollapsed(b.id+'|sku') && <table className="sku-items-table">
                      <thead><tr><th>变体</th><th className="num">下单数量</th><th className="num">实际到货</th><th className="num">待出货</th><th className="num">单价(¥)</th><th className="num">小计(¥)</th><th></th></tr></thead>
                      <tbody>
                        {(b.items||[]).map((item: any) => {
                          const itemReceived = validShipments.reduce((s: number, sh: any) =>
                            s + ((sh.items||[]).find((si: any) => si.variantId === item.variantId)?.qty || 0), 0);
                          const itemPending = (Number(item.qty)||0) - itemReceived;
                          return (
                          <tr key={item.id}>
                            <td>
                              <select className="cell" value={item.variantId}
                                onChange={e => {
                                  const v = variants.find((v: any) => v.id === e.target.value);
                                  updateBatchItem(p.id, b.id, item.id, { variantId:v?.id||'', variantName:v?.name||v?.sku||'SKU' });
                                }}>
                                {variants.map((v: any) => <option key={v.id} value={v.id}>{v.name||v.colorOrSize||v.sku||'SKU'}</option>)}
                              </select>
                            </td>
                            <td className="num"><input className="cell mono" type="number" value={item.qty} onChange={e => updateBatchItem(p.id, b.id, item.id, { qty:Number(e.target.value) })} /></td>
                            <td className="num" style={{color: itemReceived > Number(item.qty) ? 'var(--red)' : itemReceived > 0 ? 'var(--green)' : 'var(--ink-4)'}}>{itemReceived || 0} pcs</td>
                            <td className="num" style={{color: itemPending < 0 ? 'var(--red)' : itemPending === 0 && Number(item.qty) > 0 ? 'var(--green)' : 'var(--ink)'}}>{itemPending} pcs</td>
                            <td className="num"><input className="cell mono" type="number" step="0.01" value={item.unitPrice} onChange={e => updateBatchItem(p.id, b.id, item.id, { unitPrice:Number(e.target.value) })} /></td>
                            <td className="num">¥{((Number(item.qty)||0)*(Number(item.unitPrice)||0)).toFixed(2)}</td>
                            <td><button className="row-del" onClick={() => { if (confirm('确定删除该 SKU 明细？')) removeBatchItem(p.id, b.id, item.id); }}>✕</button></td>
                          </tr>
                        );})}
                      </tbody>
                    </table>}
                  </div>
                )}

                <div className="sku-items-block">
                  <div className="sku-items-hdr" style={{cursor:'pointer'}} onClick={() => toggleSection(b.id+'|extra')}>
                    <button className="sec-toggle" onClick={e => { e.stopPropagation(); toggleSection(b.id+'|extra'); }}>{isCollapsed(b.id+'|extra') ? '▸' : '▾'}</button>
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
                  {!isCollapsed(b.id+'|extra') && (b.extraCosts||[]).length > 0 && (
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
                        {(b.extraCosts||[]).map((c: any) => (
                          <tr key={c.id}>
                            <td><input className="cell" value={c.name} placeholder="费用名称"
                              onChange={e => updateBatchExtra(p.id, b.id, c.id, { name:e.target.value })} /></td>
                            <td className="num"><input className="cell mono" type="number" value={c.qty}
                              onChange={e => updateBatchExtra(p.id, b.id, c.id, { qty:Number(e.target.value) })} /></td>
                            <td className="num"><input className="cell mono" type="number" step="0.01" value={c.unitPrice}
                              onChange={e => updateBatchExtra(p.id, b.id, c.id, { unitPrice:Number(e.target.value) })} /></td>
                            <td className="num">¥{((Number(c.qty)||0)*(Number(c.unitPrice)||0)).toFixed(2)}</td>
                            <td><button className="row-del" onClick={() => { if (confirm('确定删除该笔费用？')) removeBatchExtra(p.id, b.id, c.id); }}>✕</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {(() => {
                  const bps = b.balancePayments || [];
                  const effBps = bps.length > 0 ? bps
                    : (Number(b.balanceAmt) || 0) > 0
                      ? [{ id: b.id + '-bp0', amount: Number(b.balanceAmt) || 0, date: b.balanceDate || '', note: '' }]
                      : [];
                  const tailPaid = effBps.reduce((s: number, bp: any) => s + (Number(bp.amount)||0), 0);
                  const tailRemain = theorBalance - tailPaid;
                  const actualTotalPaid = (Number(b.depositActual)||0) + tailPaid;
                  const payKey = b.id + '|pay';
                  return (
                <div className="payment-section">
                  <div className="payment-section-title" style={{cursor:'pointer'}} onClick={() => toggleSection(payKey)}>
                    <button className="sec-toggle" onClick={e => { e.stopPropagation(); toggleSection(payKey); }}>{isCollapsed(payKey) ? '▸' : '▾'}</button>
                    <span>付款条款</span>
                    {effectiveTotal > 0 && (
                      <span className="payment-hdr-summary" style={{marginLeft:12, fontSize:11.5, fontFamily:'var(--font-mono)'}}>
                        已付 <strong style={actualTotalPaid >= effectiveTotal ? {color:'var(--green)'} : {color:'var(--orange)'}}>¥{actualTotalPaid.toFixed(2)}</strong>
                        &nbsp;/&nbsp;¥{effectiveTotal.toFixed(2)}
                        {actualTotalPaid >= effectiveTotal
                          ? <>&nbsp;·&nbsp;<strong style={{color:'var(--green)'}}>✓ 已付清</strong></>
                          : actualTotalPaid > 0
                            ? <>&nbsp;·&nbsp;待付 <strong style={{color:'var(--orange)'}}>¥{(effectiveTotal - actualTotalPaid).toFixed(2)}</strong></>
                            : <>&nbsp;·&nbsp;<span style={{color:'var(--orange)',fontWeight:600}}>未付款</span></>
                        }
                      </span>
                    )}
                  </div>
                  {!isCollapsed(payKey) && <>
                  <div className="fieldgrid cols-4">
                    <div className="calc-field">
                      <span className="calc-field-label">订单金额</span>
                      <span className="calc-field-value mono" style={{fontWeight:600,color:'var(--blue)'}}>¥{skuTotal.toFixed(2)}</span>
                    </div>
                    {actualShippedValue > 0 ? (
                      <div className="calc-field">
                        <span className="calc-field-label">实际出货结算</span>
                        <span className="calc-field-value mono" style={{fontWeight:600,color: actualShippedValue !== skuTotal ? 'var(--orange)' : 'var(--green)'}}>¥{actualShippedValue.toFixed(2)}</span>
                      </div>
                    ) : <div />}
                    <div /><div />
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
                      <span className="calc-field-label">应结尾款</span>
                      <span className="calc-field-value mono">¥{Math.max(0, effectiveTotal - (Number(b.depositActual)||0)).toFixed(2)}</span>
                    </div>
                    <div className="calc-field">
                      <span className="calc-field-label">已付总金额</span>
                      <span className="calc-field-value mono" style={actualTotalPaid >= effectiveTotal ? {color:'var(--green)',fontWeight:600} : {color:'var(--orange)',fontWeight:600}}>¥{actualTotalPaid.toFixed(2)}</span>
                    </div>
                    <div />
                  </div>

                  <div className="sku-items-block" style={{marginTop:12}}>
                    <div className="sku-items-hdr">
                      <span className="sku-items-title">尾款支付记录</span>
                      <button className="btn btn-sm btn-add" onClick={() =>
                        addBalancePayment(p.id, b.id, { amount: 0, date: '', note: '' })
                      }>+ 添加尾款</button>
                    </div>
                    {effBps.length > 0 && (
                      <table className="sku-items-table">
                        <thead>
                          <tr>
                            <th className="num">金额(¥)</th>
                            <th className="num">支付日期</th>
                            <th>关联出货</th>
                            <th>备注</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          {effBps.map((bp: any) => (
                            <tr key={bp.id}>
                              <td className="num"><input className="cell mono" type="number" step="0.01" value={bp.amount||0}
                                onChange={e => updateBalancePayment(p.id, b.id, bp.id, { amount: Number(e.target.value) })} /></td>
                              <td className="num"><input className="cell mono" type="date" value={bp.date||''}
                                onChange={e => updateBalancePayment(p.id, b.id, bp.id, { date: e.target.value })} /></td>
                              <td>
                                <select className="cell" value={bp.shipmentRef||''}
                                  onChange={e => updateBalancePayment(p.id, b.id, bp.id, { shipmentRef: e.target.value })}>
                                  <option value="">—</option>
                                  {(b.shipments||[]).map((sh: any, si: number) => (
                                    <option key={sh.id} value={sh.id}>#{si+1} {sh.shipDate||sh.expectedShip||'未填'} · {hasVariants ? (sh.items||[]).reduce((s: number, sii: any) => s+(Number(sii.qty)||0),0) : (Number(sh.qty)||0)}pcs</option>
                                  ))}
                                </select>
                              </td>
                              <td><input className="cell" value={bp.note||''} placeholder="备注"
                                onChange={e => updateBalancePayment(p.id, b.id, bp.id, { note: e.target.value })} /></td>
                              <td><button className="row-del" onClick={() => { if (confirm('确定删除该笔尾款？')) removeBalancePayment(p.id, b.id, bp.id); }}>✕</button></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                  </>}
                </div>
                  );
                })()}

                {(() => {
                  const batchTotalQty = hasVariants && (b.items||[]).length > 0
                    ? (b.items||[]).reduce((s: number, i: any) => s + (Number(i.qty)||0), 0)
                    : (Number(b.qty)||0);
                  const shippedQty = (b.shipments||[]).filter((sh: any) => !!sh.shipDate).reduce((sum: number, sh: any) => {
                    if (hasVariants) return sum + (sh.items||[]).reduce((s: number, i: any) => s + (Number(i.qty)||0), 0);
                    return sum + (Number(sh.qty)||0);
                  }, 0);
                  const isOver = batchTotalQty > 0 && shippedQty > batchTotalQty;
                  return (
                    <div className="batch-ship-block">
                      <div className="batch-ship-block-hdr" style={{cursor:'pointer'}} onClick={() => toggleSection(b.id+'|ship')}>
                        <button className="sec-toggle" onClick={e => { e.stopPropagation(); toggleSection(b.id+'|ship'); }}>{isCollapsed(b.id+'|ship') ? '▸' : '▾'}</button>
                        <span className="batch-ship-block-title">出货明细</span>
                        <span className={'batch-ship-block-sum' + (isOver ? ' warn' : '')}>
                          {(b.shipments||[]).length > 0
                            ? <>{shippedQty} / {batchTotalQty} pcs 已出{isOver ? ' · 超出订单数量!' : ''}</>
                            : '尚无出货记录'}
                        </span>
                        <button className="btn btn-sm btn-add" onClick={e => { e.stopPropagation();
                          addBatchShipment(p.id, b.id, {
                            expectedShip: '', shipDate: '', qty: 0,
                            items: hasVariants
                              ? ((b.items||[]).length > 0
                                  ? (b.items||[]).map((bi: any) => {
                                      const v = variants.find((x: any) => x.id === bi.variantId);
                                      return { id: uid(), variantId: bi.variantId, variantName: v ? (v.name || v.colorOrSize || v.sku || 'SKU') : (bi.variantName || 'SKU'), qty: 0 };
                                    })
                                  : variants.map((v: any) => ({ id: uid(), variantId: v.id, variantName: v.name || v.colorOrSize || v.sku || 'SKU', qty: 0 }))
                                )
                              : [],
                            method: '海运', carrier: '', tracking: '', fbaShipId: '', etaDate: '', note: '',
                          })
                        }}>+ 添加出货</button>
                      </div>
                      {!isCollapsed(b.id+'|ship') && (b.shipments||[]).map((sh: any, shIdx: number) => {
                        const shSettlement = hasVariants
                          ? (sh.items||[]).reduce((s: number, si: any) => {
                              const bi = (b.items||[]).find((x: any) => x.variantId === si.variantId);
                              return s + (Number(si.qty)||0) * (Number(bi?.unitPrice)||0);
                            }, 0)
                          : (Number(sh.qty)||0) * (Number(b.unitPrice)||0);
                        const shQty = hasVariants
                          ? (sh.items||[]).reduce((s: number, i: any) => s + (Number(i.qty)||0), 0)
                          : (Number(sh.qty)||0);
                        const shVariantNames = hasVariants && (sh.items||[]).length > 0
                          ? (sh.items||[]).map((si: any) => {
                              const v = variants.find((vx: any) => vx.id === si.variantId);
                              return (v ? (v.name || v.colorOrSize || v.sku) : (si.variantName || 'SKU')) + (si.qty ? ' ×' + si.qty : '');
                            }).join(' / ')
                          : '';
                        return (
                          <div key={sh.id} className="batch-ship-entry">
                            <div className="batch-ship-entry-hdr" style={{cursor:'pointer'}} onClick={() => toggleSection(b.id+'|sh|'+sh.id)}>
                              <button className="sec-toggle" onClick={e => { e.stopPropagation(); toggleSection(b.id+'|sh|'+sh.id); }}>{isCollapsed(b.id+'|sh|'+sh.id) ? '▸' : '▾'}</button>
                              <span className="batch-ship-no">#{shIdx + 1}</span>
                              <span className="batch-ship-info">
                                {(sh.shipDate || sh.expectedShip) || '日期未填'}{shVariantNames ? ' · ' + shVariantNames : ''} · {shQty} pcs{shSettlement > 0 ? <>&nbsp;·&nbsp;结算 <strong>¥{shSettlement.toFixed(2)}</strong></> : ''} · {sh.method || '—'}{sh.carrier ? ' · ' + sh.carrier : ''}
                              </span>
                              <StatusSelect value={sh.status} size="sm"
                                onChange={v => updateBatchShipment(p.id, b.id, sh.id, { status: v })} />
                              <button className="row-del" onClick={e => { e.stopPropagation(); if (confirm('确定删除该出货记录？')) removeBatchShipment(p.id, b.id, sh.id); }}>✕</button>
                            </div>
                            {!isCollapsed(b.id+'|sh|'+sh.id) && <div className="batch-ship-entry-body">
                              <div className="fieldgrid cols-4">
                                <EditField label="预计出货日期" type="date" mono value={sh.expectedShip||''}
                                  onChange={v => updateBatchShipment(p.id, b.id, sh.id, { expectedShip: v })} />
                                <EditField label="实际出货日期" type="date" mono value={sh.shipDate||''}
                                  onChange={v => updateBatchShipment(p.id, b.id, sh.id, { shipDate: v })} />
                                <EditField label="发货方式" value={sh.method||''}
                                  options={['海运','空运','空+派','快递','卡车']}
                                  onChange={v => updateBatchShipment(p.id, b.id, sh.id, { method: v })} />
                                {!hasVariants && (
                                  <EditField label="出货数量" type="number" mono suffix="pcs" value={sh.qty||0}
                                    onChange={v => updateBatchShipment(p.id, b.id, sh.id, { qty: v })} />
                                )}
                                <EditField label="备注" value={sh.note||''}
                                  onChange={v => updateBatchShipment(p.id, b.id, sh.id, { note: v })} />
                              </div>
                              {hasVariants && (
                                <div style={{marginTop:10}}>
                                  <div style={{display:'flex', alignItems:'center', gap:8, marginBottom:6}}>
                                    <span style={{fontSize:11, color:'var(--ink-4)', flex:1}}>
                                      共 {(sh.items||[]).reduce((s: number, i: any) => s+(Number(i.qty)||0), 0)} pcs
                                    </span>
                                    <button className="btn btn-sm btn-add" onClick={() => {
                                      const v0 = variants[0];
                                      const newItems = [...(sh.items||[]), { id: uid(), variantId: v0?.id||'', variantName: v0?.name||v0?.colorOrSize||v0?.sku||'SKU', qty: 0 }];
                                      updateBatchShipment(p.id, b.id, sh.id, { items: newItems });
                                    }}>+ 添加 SKU</button>
                                  </div>
                                  <table className="sku-items-table">
                                    <thead>
                                      <tr>
                                        <th>变体 SKU</th>
                                        <th className="num">出货数量 (pcs)</th>
                                        <th style={{width:36}}></th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {(sh.items||[]).map((item: any) => {
                                        const vr = variants.find((v: any) => v.id === item.variantId);
                                        return (
                                          <tr key={item.id}>
                                            <td>
                                              <select className="cell" value={item.variantId}
                                                onChange={e => {
                                                  const v = variants.find((vx: any) => vx.id === e.target.value);
                                                  const newItems = (sh.items||[]).map((x: any) =>
                                                    x.id === item.id ? { ...x, variantId: v?.id||'', variantName: v?.name||v?.colorOrSize||v?.sku||'SKU' } : x
                                                  );
                                                  updateBatchShipment(p.id, b.id, sh.id, { items: newItems });
                                                }}>
                                                {variants.map((v: any) => <option key={v.id} value={v.id}>{v.name||v.colorOrSize||v.sku||'SKU'}</option>)}
                                              </select>
                                            </td>
                                            <td className="num">
                                              <input className="cell mono" type="number" min={0} value={item.qty||0}
                                                onChange={e => {
                                                  const newItems = (sh.items||[]).map((x: any) =>
                                                    x.id === item.id ? { ...x, qty: Number(e.target.value) } : x
                                                  );
                                                  updateBatchShipment(p.id, b.id, sh.id, { items: newItems });
                                                }} />
                                            </td>
                                            <td>
                                              <button className="row-del" onClick={() => {
                                                if (confirm('确定删除该 SKU 出货明细？')) {
                                                  const newItems = (sh.items||[]).filter((x: any) => x.id !== item.id);
                                                  updateBatchShipment(p.id, b.id, sh.id, { items: newItems });
                                                }
                                              }}>✕</button>
                                            </td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}

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
          {(qc.records || []).map((r: any, idx: number) => (
            <RecordCard key={r.id} index={'QC' + (idx+1)} title={`验货记录 ${idx+1}`}
              color={STAGES[10].color} status={r.status}
              onStatusChange={v => updateRecord(p.id, 'qc', 'records', r.id, { status:v })}
              onRemove={() => { if (confirm('确定删除该验货记录？')) removeRecord(p.id, 'qc', 'records', r.id); }}>
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

function TabOps({ p }: { p: any }) {
  const { updateStage, updateVariantStage } = useProducts() as any;
  const variants = p.variants || [];
  const hasVariants = variants.length > 0;
  const [listingVId, setListingVId] = React.useState(variants[0]?.id || null);
  const [promoVId, setPromoVId] = React.useState(variants[0]?.id || null);
  const selectedLV = variants.find((v: any) => v.id === listingVId) || variants[0] || null;
  const selectedPV = variants.find((v: any) => v.id === promoVId) || variants[0] || null;

  const set = (k: string, patch: any) => updateStage(p.id, k, patch);
  const kw = p.stages.keywords || {};
  const ho = p.stages.handover || {};
  const lst = hasVariants ? (selectedLV?.stages?.listing || {}) : (p.stages.listing || {});
  const pr = hasVariants ? (selectedPV?.stages?.promotion || {}) : (p.stages.promotion || {});
  const setLst = (patch: any) => hasVariants
    ? updateVariantStage(p.id, selectedLV.id, 'listing', patch)
    : updateStage(p.id, 'listing', patch);
  const setPr = (patch: any) => hasVariants
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

function TabReview({ p }: { p: any }) {
  const { updateStage, addRecord, updateRecord, removeRecord, addSubShipment, updateSubShipment, removeSubShipment, addLog, updateLog, removeLog } = useProducts() as any;
  const prod = p.stages.production || { batches: [] };
  const ro = p.stages.reorder || { records:[] };
  const rv = p.stages.review || {};

  return (
    <>
      <StageCard stage={STAGES[16]} productId={p.id} stageKey="reorder" stageData={ro}>
        <div className="record-list">
          {(ro.records || []).map((r: any, idx: number) => {
            const total = (Number(r.qty)||0) * (Number(r.unitPrice)||0);
            const taxIncl = r.unitPrice ? +(r.unitPrice * (1 + (Number(r.taxRate)||0)/100)).toFixed(4) : 0;
            const subQty = (r.subShipments||[]).reduce((s: number, x: any) => s + (Number(x.qty)||0), 0);
            const splitOk = !r.subShipments?.length || subQty === Number(r.qty);
            return (
              <div key={r.id} className="reorder-card">
                <div className="record-hdr">
                  <div className="record-num" style={{background: STAGES[16].color, color:'#fff'}}>#{idx+1}</div>
                  <span className="record-title">{r.orderNo || '物流订单 ' + (idx+1)}</span>
                  <span className="record-dates">{r.orderDate || '—'} · {r.qty || 0} pcs · ¥{total.toFixed(2)}</span>
                  <StatusSelect value={r.status} size="sm"
                    onChange={v => updateRecord(p.id, 'reorder', 'records', r.id, { status:v })} />
                  <button className="record-remove" onClick={() => { if (confirm('确定删除该物流订单？')) removeRecord(p.id, 'reorder', 'records', r.id); }}>✕</button>
                </div>
                <div className="record-body">
                  <div className="fieldgrid cols-4">
                    <EditField label="关联生产批次" value={r.batchRef || ''}
                      options={[
                        { value: '', label: '— 不关联 —' },
                        ...(prod.batches || []).map((b: any) => ({
                          value: b.id,
                          label: (b.batchNo || 'B?') + (b.factory ? ' · ' + b.factory : '') + (b.expectedShip ? ' (' + b.expectedShip + ')' : ''),
                        })),
                      ]}
                      onChange={v => {
                        const patch: any = { batchRef: v };
                        if (v) {
                          const batch = (prod.batches || []).find((b: any) => b.id === v);
                          if (batch) {
                            const bQty = batch.items?.length > 0
                              ? batch.items.reduce((s: number, i: any) => s + (Number(i.qty)||0), 0)
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
                          <th>批次</th><th>数量</th><th>ETD</th><th>ATD</th><th>物流方式</th>
                          <th>服务商</th><th>运单号</th><th>FBA 入仓编号</th><th>ETA</th><th>ATA</th><th>状态</th><th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {(r.subShipments || []).map((ss: any) => (
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
                            <td><button className="row-del" onClick={() => { if (confirm('确定删除该分批出货记录？')) removeSubShipment(p.id, r.id, ss.id); }}>✕</button></td>
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
            {(p.logs || []).map((l: any) => (
              <LogRow key={l.id} log={l} productId={p.id}
                onUpdate={(patch: any) => updateLog(p.id, l.id, patch)}
                onRemove={() => { if (confirm('确定删除该日志？')) removeLog(p.id, l.id); }} />
            ))}
          </div>
          <LogAdder onAdd={(text: string) => addLog(p.id, text)} />
        </div>
      </div>
    </>
  );
}

function LogRow({ log, productId, onUpdate, onRemove }: {
  log: any; productId: string; onUpdate: (patch: any) => void; onRemove: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [val, setVal] = React.useState(log.text);
  const [showEditor, setShowEditor] = React.useState(false);
  React.useEffect(() => { setVal(log.text); }, [log.text]);
  const commit = () => {
    if (val.trim() && val !== log.text) onUpdate({ text: val.trim() });
    setEditing(false);
    setShowEditor(false);
  };
  return (
    <div className={"log-row" + (editing ? ' editing' : '')}
      onMouseEnter={() => setShowEditor(true)}
      onMouseLeave={() => { if (!editing) setShowEditor(false); }}>
      <span className="date">{log.date}</span>
      {editing ? (
        <input className="log-edit-input"
          value={val} onChange={e => setVal(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') { setEditing(false); setShowEditor(false); setVal(log.text); }
          }}
          autoFocus />
      ) : (
        <span className="text">{log.text}</span>
      )}
      {showEditor && (
        <span className="log-actions">
          <button className="log-btn" title="编辑" onClick={() => { setEditing(true); setShowEditor(true); }}>✏️</button>
          <button className="log-btn" title="删除" onClick={onRemove}>✕</button>
        </span>
      )}
    </div>
  );
}

function LogAdder({ onAdd }: { onAdd: (text: string) => void }) {
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

export function Detail({ p }: { p: any }) {
  const { update, duplicateProduct, removeProduct, exportProduct } = useProducts() as any;
  const [tab, setTab] = React.useState('eval');
  if (!p) return <div className="detail"><div className="empty-hint" style={{margin:40}}>请从左侧选择一个产品</div></div>;

  const tabCounts: Record<string, number> = {
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
                onChange={e => update(p.id, (prev: any) => ({ ...prev, name: e.target.value }))} />
              <select className="status-edit"
                value={p.status}
                onChange={e => update(p.id, (prev: any) => ({ ...prev, status: e.target.value }))}>
                <option value="active">进行中</option>
                <option value="hold">已暂停</option>
                <option value="done">已完成</option>
                <option value="cancel">已取消</option>
              </select>
            </div>
            <div className="detail-meta">
              <span className="detail-meta-item"><span className="lbl">SKU</span>
                <input className="meta-edit mono" value={p.sku}
                  onChange={e => update(p.id, (prev: any) => ({ ...prev, sku: e.target.value }))} />
              </span>
              <span className="detail-meta-item"><span className="lbl">品类</span>
                <input className="meta-edit" value={p.category}
                  onChange={e => update(p.id, (prev: any) => ({ ...prev, category: e.target.value }))} />
              </span>
              <span className="detail-meta-item"><span className="lbl">负责人</span>
                <input className="meta-edit" value={p.lead}
                  onChange={e => update(p.id, (prev: any) => ({ ...prev, lead: e.target.value }))} />
              </span>
              <span className="detail-meta-item"><span className="lbl">立项</span>
                <input className="meta-edit mono" type="date" value={p.createdAt}
                  onChange={e => update(p.id, (prev: any) => ({ ...prev, createdAt: e.target.value }))} />
              </span>
              <span className="detail-meta-item"><span className="lbl">当前阶段</span>
                <select className="meta-edit"
                  value={p.currentStage}
                  onChange={e => update(p.id, (prev: any) => ({ ...prev, currentStage: e.target.value }))}>
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
                title={`${s.name} · ${STAGE_STATUSES.find(x => x.value === (sd.status||'idle'))?.label}`}
                style={{
                  background: isDone || isActive ? s.color : isHold ? '#9333ea' : 'var(--border)',
                  opacity: isDone ? 1 : isActive ? 0.75 : isHold ? 0.55 : 0.35,
                }}></div>
            );
          })}
          <div className="progress-edit">
            <input type="range" min={0} max={100} value={p.progress}
              onChange={e => update(p.id, (prev: any) => ({ ...prev, progress: Number(e.target.value) }))} />
            <input type="number" min={0} max={100} className="pct-input mono" value={p.progress}
              onChange={e => update(p.id, (prev: any) => ({ ...prev, progress: Math.max(0, Math.min(100, Number(e.target.value))) }))} />
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
