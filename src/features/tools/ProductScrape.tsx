import React, { useState, useCallback, useEffect, useRef } from 'react';

const AUTH_TOKEN_KEY = 'fba-auth-v1';
function authHeaders(): Record<string, string> {
  const t = localStorage.getItem(AUTH_TOKEN_KEY) || '';
  return t ? { Authorization: 'Bearer ' + t } : {};
}

const MARKETPLACES = [
  { code: 'US', flag: '🇺🇸', name: '美国',     domain: 'www.amazon.com' },
  { code: 'UK', flag: '🇬🇧', name: '英国',     domain: 'www.amazon.co.uk' },
  { code: 'DE', flag: '🇩🇪', name: '德国',     domain: 'www.amazon.de' },
  { code: 'FR', flag: '🇫🇷', name: '法国',     domain: 'www.amazon.fr' },
  { code: 'IT', flag: '🇮🇹', name: '意大利',   domain: 'www.amazon.it' },
  { code: 'ES', flag: '🇪🇸', name: '西班牙',   domain: 'www.amazon.es' },
  { code: 'JP', flag: '🇯🇵', name: '日本',     domain: 'www.amazon.co.jp' },
  { code: 'CA', flag: '🇨🇦', name: '加拿大',   domain: 'www.amazon.ca' },
  { code: 'AU', flag: '🇦🇺', name: '澳大利亚', domain: 'www.amazon.com.au' },
  { code: 'IN', flag: '🇮🇳', name: '印度',     domain: 'www.amazon.in' },
  { code: 'MX', flag: '🇲🇽', name: '墨西哥',   domain: 'www.amazon.com.mx' },
  { code: 'BR', flag: '🇧🇷', name: '巴西',     domain: 'www.amazon.com.br' },
  { code: 'SG', flag: '🇸🇬', name: '新加坡',   domain: 'www.amazon.sg' },
  { code: 'AE', flag: '🇦🇪', name: '阿联酋',   domain: 'www.amazon.ae' },
  { code: 'SA', flag: '🇸🇦', name: '沙特阿拉伯', domain: 'www.amazon.sa' },
  { code: 'NL', flag: '🇳🇱', name: '荷兰',     domain: 'www.amazon.nl' },
  { code: 'SE', flag: '🇸🇪', name: '瑞典',     domain: 'www.amazon.se' },
  { code: 'PL', flag: '🇵🇱', name: '波兰',     domain: 'www.amazon.pl' },
  { code: 'BE', flag: '🇧🇪', name: '比利时',   domain: 'www.amazon.com.be' },
  { code: 'TR', flag: '🇹🇷', name: '土耳其',   domain: 'www.amazon.com.tr' },
];
function mkInfo(code: string) {
  return MARKETPLACES.find(m => m.code === code) || { code, flag: '', name: code, domain: 'www.amazon.com' };
}

// 前端不再自己分批：采集由服务端后台执行器驱动，一次提交全部 ASIN，
// 分批与并发由 product_fetcher 的 SCRAPER_BATCH_SIZE / SCRAPER_CONCURRENCY 决定。
const PAGE_SIZE_OPTIONS = [50, 100, 150];

// ============================================================
// ProductDetailDialog (must be defined before ProductScrape)
// ============================================================
interface ProductDetailProps {
  product: ScrapedProduct | null;
  open: boolean;
  onClose: () => void;
}
function ProductDetailDialog({ product, open, onClose }: ProductDetailProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxImages, setLightboxImages] = useState<string[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);

  if (!product) return null;

  const bsr = product.bestSellerRank;
  const cr = product.customerReviews;
  const aplusImages = product.aplusImages || [];
  const productImages = [product.mainImage, ...product.images].filter((img): img is string => !!img);
  const reviewImages = (cr?.reviewImages || []).filter((img): img is string => !!img);

  const REVIEW_RELATED_KEYS = /customer.?review|number.?of.?review|rating|评分|评论/i;

  const filteredProductDetails = Object.fromEntries(
    Object.entries(product.productDetails || {}).filter(([k]) => !REVIEW_RELATED_KEYS.test(k))
  );
  const filteredSpecifications = Object.fromEntries(
    Object.entries(product.specifications || {}).filter(([k]) => !REVIEW_RELATED_KEYS.test(k))
  );

  const openLightbox = (images: string[], index: number) => {
    setLightboxImages(images);
    setLightboxIndex(index);
    setLightboxOpen(true);
  };

  return (
    <>
      {open && (
        <div className="modal-backdrop" onClick={onClose}>
          <div className="modal ps-detail-modal" onClick={e => e.stopPropagation()}>
            <div className="ps-detail-header">
              <div className="ps-detail-header-info">
                <div className="ps-detail-title">
                  {product.title || "未获取标题"}
                </div>
                <div className="ps-detail-meta">ASIN: {product.asin}</div>
              </div>
              <a href={productUrl(product.asin, product.marketplace)} target="_blank" rel="noopener noreferrer" className="btn btn-sm">
                查看
              </a>
            </div>

            <div className="ps-detail-body">
              {/* Images */}
              {productImages.length > 0 && (
                <div className="ps-detail-section">
                  <div className="ps-detail-section-head">
                    <h4>产品图片 ({productImages.length})</h4>
                  </div>
                  <div className="ps-detail-img-grid">
                    {productImages.map((img, i) => (
                      <div key={i} className="ps-detail-img-card" onClick={() => openLightbox(productImages, i)}>
                        <img src={img} alt={`Product ${i + 1}`} />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Basic info */}
              <div className="ps-detail-section ps-info-grid">
                {product.brand && <div><span className="ps-label">品牌</span><span>{product.brand}</span></div>}
                {product.price && <div><span className="ps-label">价格</span><span className="ps-val-amazon">{product.price}</span></div>}
                {product.rating && (
                  <div><span className="ps-label">评分</span>
                    <span>{product.rating} <span className="ps-star">★</span> ({product.reviewCount})</span>
                  </div>
                )}
                {product.availability && <div><span className="ps-label">库存</span><span>{product.availability}</span></div>}
                {product.seller && <div><span className="ps-label">卖家</span><span>{product.seller}</span></div>}
              </div>

              {/* BSR */}
              {bsr?.mainCategory || bsr?.subCategory ? (
                <div className="ps-detail-section">
                  <h4>销售排名</h4>
                  <div className="ps-bsr-grid">
                    {bsr.mainCategory && (
                      <div className="ps-bsr-card">
                        <span className="ps-bsr-label">大类</span>
                        <span title={bsr.mainCategory} className="ps-bsr-val">{bsr.mainCategory}</span>
                        {bsr.mainRank != null && <span className="ps-bsr-rank">#{bsr.mainRank.toLocaleString()}</span>}
                      </div>
                    )}
                    {bsr.subCategory && (
                      <div className="ps-bsr-card">
                        <span className="ps-bsr-label">小类</span>
                        <span title={bsr.subCategory} className="ps-bsr-val">{bsr.subCategory}</span>
                        {bsr.subRank != null && <span className="ps-bsr-rank">#{bsr.subRank.toLocaleString()}</span>}
                      </div>
                    )}
                  </div>
                </div>
              ) : null}

              {/* Bullet points */}
              {product.bulletPoints.length > 0 && (
                <div className="ps-detail-section">
                  <h4>五点描述</h4>
                  <ul className="ps-bullet-list">
                    {product.bulletPoints.map((p, i) => <li key={i}><span>•</span>{p}</li>)}
                  </ul>
                </div>
              )}

              {/* Description */}
              {product.description && (
                <div className="ps-detail-section">
                  <h4>产品描述</h4>
                  <p className="ps-desc">{product.description}</p>
                </div>
              )}

              {/* A+ Images */}
              {aplusImages.length > 0 && (
                <div className="ps-detail-section">
                  <div className="ps-detail-section-head">
                    <h4>A+ 内容图片 ({aplusImages.length})</h4>
                  </div>
                  <div className="ps-detail-img-grid ps-grid-3">
                    {aplusImages.map((img, i) => (
                      <div key={i} className="ps-detail-img-card" onClick={() => openLightbox(aplusImages, i)}>
                        <img src={img} alt={`A+ ${i + 1}`} />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Customer reviews */}
              {cr?.customersSay ? (
                <div className="ps-detail-section">
                  <h4>顾客评价</h4>
                  <div className="ps-customer-say">{cr.customersSay}</div>
                  {cr.selectToLearnMore && cr.selectToLearnMore.length > 0 && (
                    <div className="ps-tags">
                      {cr.selectToLearnMore.map((t, i) => <span key={i} className="ps-tag">{t}</span>)}
                    </div>
                  )}
                  {reviewImages.length > 0 && (
                    <div className="ps-detail-section">
                      <div className="ps-detail-section-head">
                        <h4>顾客图片 ({reviewImages.length} 张)</h4>
                      </div>
                      <div className="ps-detail-img-grid">
                        {reviewImages.slice(0, 10).map((img, i) => (
                          <div key={i} className="ps-detail-img-card" onClick={() => openLightbox(reviewImages, i)}>
                            <img src={img} alt={`Review ${i + 1}`} />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : null}

              {/* Specifications */}
              {Object.keys(filteredSpecifications).length > 0 && (
                <div className="ps-detail-section">
                  <h4>产品规格</h4>
                  <div className="ps-spec-list">
                    {Object.entries(filteredSpecifications).map(([k, v]) => (
                      <div key={k} className="ps-spec-item">
                        <span className="ps-spec-key">{k}</span>
                        <span className="ps-spec-val">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Product details */}
              {Object.keys(filteredProductDetails).length > 0 && (
                <div className="ps-detail-section">
                  <h4>产品详情</h4>
                  <div className="ps-spec-list">
                    {Object.entries(filteredProductDetails).map(([k, v]) => (
                      <div key={k} className="ps-spec-item">
                        <span className="ps-spec-key">{k}</span>
                        <span className="ps-spec-val">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {lightboxOpen && (
        <Lightbox
          images={lightboxImages}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </>
  );
}

// ============================================================
// Lightbox component
// ============================================================
interface LightboxProps {
  images: string[];
  initialIndex: number;
  onClose: () => void;
}

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5];

function Lightbox({ images, initialIndex, onClose }: LightboxProps) {
  const [current, setCurrent] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef({ active: false, sx: 0, sy: 0, sl: 0, st: 0 });

  const prev = useCallback(() => { setCurrent(i => (i - 1 + images.length) % images.length); setZoom(1); }, [images.length]);
  const next = useCallback(() => { setCurrent(i => (i + 1) % images.length); setZoom(1); }, [images.length]);

  const zoomIn = useCallback(() => setZoom(z => {
    const s = ZOOM_STEPS.find(v => v > z + 0.01);
    return s ?? Math.min(z * 1.5, 5);
  }), []);

  const zoomOut = useCallback(() => setZoom(z => {
    const s = [...ZOOM_STEPS].reverse().find(v => v < z - 0.01);
    return s ?? Math.max(z / 1.5, 0.25);
  }), []);

  const resetZoom = useCallback(() => setZoom(1), []);

  /* keyboard */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
      if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomIn(); }
      if (e.key === "-") { e.preventDefault(); zoomOut(); }
      if (e.key === "0") resetZoom();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onClose, prev, next, zoomIn, zoomOut, resetZoom]);

  /* mouse-wheel zoom */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY < 0) zoomIn(); else zoomOut();
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [zoomIn, zoomOut]);

  /* drag-to-pan */
  const onDragStart = useCallback((e: React.MouseEvent) => {
    if (zoom <= 1) return;
    const el = wrapRef.current;
    if (!el) return;
    dragRef.current = { active: true, sx: e.clientX, sy: e.clientY, sl: el.scrollLeft, st: el.scrollTop };
  }, [zoom]);

  const onDragMove = useCallback((e: React.MouseEvent) => {
    const d = dragRef.current;
    if (!d.active) return;
    const el = wrapRef.current;
    if (!el) return;
    el.scrollLeft = d.sl - (e.clientX - d.sx);
    el.scrollTop = d.st - (e.clientY - d.sy);
  }, []);

  const onDragEnd = useCallback(() => { dragRef.current.active = false; }, []);

  const isZoomed = zoom > 1;
  const pct = Math.round(zoom * 100);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal ps-lightbox" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="ps-lightbox-counter">{current + 1} / {images.length}</div>

        {/* zoom toolbar */}
        <div className="ps-lightbox-zoom">
          <button onClick={e => { e.stopPropagation(); zoomOut(); }} title="缩小 (−)">−</button>
          <span className="ps-lightbox-zoom-pct">{pct}%</span>
          <button onClick={e => { e.stopPropagation(); zoomIn(); }} title="放大 (+)">+</button>
          <button onClick={e => { e.stopPropagation(); resetZoom(); }} title="适应窗口 (0)">⟳</button>
        </div>

        {images.length > 1 && (
          <button className="ps-lightbox-btn ps-lightbox-prev" onClick={e => { e.stopPropagation(); prev(); }}>◀</button>
        )}
        <div
          ref={wrapRef}
          className={`ps-lightbox-img-wrap${isZoomed ? ' ps-lightbox-zoomed' : ''}`}
          onClick={e => e.stopPropagation()}
          onMouseDown={onDragStart}
          onMouseMove={onDragMove}
          onMouseUp={onDragEnd}
          onMouseLeave={onDragEnd}
        >
          <img
            key={current}
            src={images[current]}
            alt={`Image ${current + 1}`}
            className={`ps-lightbox-img${!isZoomed ? ' ps-lightbox-fit' : ''}`}
            draggable={false}
            style={{ width: `${pct}%` }}
          />
        </div>
        {images.length > 1 && (
          <>
            <button className="ps-lightbox-btn ps-lightbox-next" onClick={e => { e.stopPropagation(); next(); }}>▶</button>
            <div className="ps-lightbox-thumbs" onClick={e => e.stopPropagation()}>
              {images.map((img, i) => (
                <button
                  key={i}
                  onClick={() => { setCurrent(i); setZoom(1); }}
                  className={`ps-thumb ${i === current ? 'ps-thumb-active' : ''}`}
                >
                  <img src={img} alt={`Thumb ${i + 1}`} />
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Main ProductScrape component
// ============================================================
interface BestSellerRank {
  mainCategory: string | null; mainRank: number | null;
  subCategory: string | null; subRank: number | null; rawText: string | null;
}
interface CustomerReviews {
  customersSay: string | null; reviewImages: string[]; selectToLearnMore: string[];
}
interface ScrapedProduct {
  id?: number;
  asin: string; marketplace: string;
  title: string | null; brand: string | null; price: string | null;
  rating: string | null; reviewCount: string | null; availability: string | null;
  bulletPoints: string[]; description: string | null;
  mainImage: string | null; images: string[]; aplusImages: string[];
  specifications: Record<string, string>; productDetails: Record<string, string>;
  categories: string | null; seller: string | null;
  bestSellerRank: BestSellerRank; customerReviews: CustomerReviews;
  status: string; errorMessage: string | null; scrapedAt?: string;
}
// status 取值（由服务端后台执行器维护）：
//   running / paused / completed / partial / cancelled / error
interface ScrapeTask {
  id: string; marketplace: string; name: string | null; total: number; success: number; failed: number;
  withReviews: boolean; status: string; createdAt: string;
  asins: string[]; startedAt: string | null; endedAt: string | null; error: string | null;
}

// ---- API ----
async function apiGetTasks(): Promise<ScrapeTask[]> {
  const r = await fetch('/api/scrape/tasks', { headers: authHeaders() });
  if (!r.ok) throw new Error('加载历史任务失败');
  return (await r.json()).tasks || [];
}
async function apiGetProducts(taskId: string): Promise<ScrapedProduct[]> {
  const r = await fetch('/api/scrape/products?taskId=' + encodeURIComponent(taskId), { headers: authHeaders() });
  if (!r.ok) throw new Error('加载采集结果失败');
  return (await r.json()).products || [];
}
// 提交即返回 taskId，真正的抓取在服务端后台线程里跑——所以刷新页面不会中断任务
async function apiStartScrape(asins: string[], marketplace: string, withReviews: boolean, taskId?: string): Promise<string> {
  const r = await fetch('/api/scrape/start', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ asins, marketplace, withReviews, ...(taskId ? { taskId } : {}) }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || '提交采集失败');
  }
  return (await r.json()).taskId;
}
async function apiGetProgress(taskId: string): Promise<{ task: ScrapeTask; stopping: boolean; run: { done: number; total: number } | null }> {
  const r = await fetch('/api/scrape/progress?taskId=' + encodeURIComponent(taskId), { headers: authHeaders() });
  if (!r.ok) throw new Error('读取采集进度失败');
  const d = await r.json();
  // stopping：停止信号已发出、线程还没退出。用来把按钮显示成「正在暂停…」，
  // 避免用户以为没点上而反复点。
  // run：「本轮」进度（分母=本轮工作集，首次=全部 ASIN、重试=未成功的那些）。
  // 重试失败项时任务累计口径（success+failed）会一开跑就 100%，只有 run 才准确。
  return { task: d.task, stopping: !!d.stopping, run: d.run || null };
}
// 暂停与取消都只是给服务端线程一个停止信号，线程在检查点退出，已抓到的结果一条不丢。
// 暂停停在断点、可随时「继续」；取消是终止本次执行，结果同样保留、也能再「继续」。
async function apiStopScrape(action: 'pause' | 'cancel', taskId: string): Promise<void> {
  const r = await fetch(`/api/scrape/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ taskId }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || (action === 'pause' ? '暂停失败' : '取消失败'));
  }
}
// 继续：服务端按 task_id 起重线程，待跑 = 全部 ASIN − 已成功，自动跳过跑过的
async function apiResumeScrape(taskId: string): Promise<void> {
  const r = await fetch('/api/scrape/resume', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ taskId }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || '继续采集失败');
  }
}
async function apiDeleteTask(id: string): Promise<void> {
  const r = await fetch('/api/scrape/tasks?id=' + encodeURIComponent(id), { method: 'DELETE', headers: authHeaders() });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || '删除失败');
  }
}
async function apiUpdateTaskName(id: string, name: string): Promise<void> {
  const r = await fetch('/api/scrape/tasks', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ id, name }),
  });
  if (!r.ok) throw new Error('重命名失败');
}

async function apiResetSession(marketplace: string): Promise<void> {
  await fetch('/api/scrape/reset-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ marketplace }),
  });
}

// ---- Utilities ----
function fmtDateTime(iso: string): string {
  const m = iso.match(/\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : iso;
}
function productUrl(asin: string, marketplace: string): string {
  return `https://${mkInfo(marketplace).domain}/dp/${asin}`;
}
// 任务状态 → 中文文案（历史任务卡副行展示）
function taskStatusText(t: ScrapeTask): string {
  switch (t.status) {
    case 'running':   return '采集中';
    case 'paused':    return '已暂停';
    case 'completed': return '已完成';
    case 'partial':   return '部分完成';
    case 'cancelled': return '已取消';
    case 'error':     return '错误';
    default:          return '';
  }
}

// 历史任务的每页条数档位
const HIST_PAGE_SIZES = [10, 15, 25, 50];
// 任务数超过这个阈值才显示搜索/筛选（少量任务时不必堆控件）
const HIST_CHROME_MIN = 8;

// 历史任务按「今天 / 昨天 / 更早」分组，用于列表里的小标题。
// createdAt 是服务端 ISO 字符串（_now_iso），按本地自然日切分。
function dayGroup(iso?: string): string {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) return '更早';
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= startToday) return '今天';
  if (t >= startToday - 86400000) return '昨天';
  return '更早';
}
// 亚马逊详情页的「Date First Available」（上架时间）。
// 落点不固定：多数站点在 productDetails、个别在 specifications；键名大小写不一，
// 值前后常夹带 RTL 控制符（‏ ‎ 等），所以按「包含 date first available」匹配并清洗。
function findDateFirstAvailable(p: ScrapedProduct): string {
  const pick = (obj?: Record<string, string>): string => {
    if (!obj) return '';
    const key = Object.keys(obj).find(k => /date\s*first\s*available/i.test(k));
    const val = key ? obj[key] : '';
    return String(val || '').replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim();
  };
  return pick(p.productDetails) || pick(p.specifications);
}
// 上架时间排序用时间戳；解析不了给 Infinity（排序逻辑里按「缺值恒沉底」处理）。
function dateFirstAvailableTs(p: ScrapedProduct): number {
  const s = findDateFirstAvailable(p);
  const t = s ? Date.parse(s) : NaN;
  return isNaN(t) ? Infinity : t;
}

function exportCSV(products: ScrapedProduct[], marketplace: string) {
  const headers = [
    'ASIN', '站点', '标题', '品牌', '价格', '评分', '评论数', '可用性',
    '五点描述', '产品描述', '主图链接', '所有图片链接',
    '产品规格', '产品详情', '分类路径', '大类', '大类排名', '小类', '小类排名',
    '卖家', 'Customers say', '状态', '链接',
  ];
  const rows = products.map(p => {
    const bsr = p.bestSellerRank, cr = p.customerReviews;
    return [
      p.asin, p.marketplace, p.title || '', p.brand || '', p.price || '',
      p.rating || '', p.reviewCount || '', p.availability || '',
      (p.bulletPoints || []).join(' | '), p.description || '',
      p.mainImage || '', (p.images || []).join(' | '),
      Object.entries(p.specifications || {}).map(([k, v]) => `${k}: ${v}`).join(' | '),
      Object.entries(p.productDetails || {}).map(([k, v]) => `${k}: ${v}`).join(' | '),
      p.categories || '', bsr.mainCategory || '', bsr.mainRank != null ? String(bsr.mainRank) : '',
      bsr.subCategory || '', bsr.subRank != null ? String(bsr.subRank) : '',
      p.seller || '', cr.customersSay || '',
      p.status === 'success' ? '成功' : '失败',
      productUrl(p.asin, p.marketplace || marketplace),
    ];
  });
  const BOM = '﻿';
  const csv = BOM + [
    headers.map(h => `"${h}"`).join(','),
    ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
  ].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `amazon_products_${marketplace}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function createExportJob(
  taskId: string,
  label: string,
  onDone: () => void,
  asins: string[] | null = null,
) {
  const token = localStorage.getItem('fba-auth-v1') || '';
  const date = new Date().toISOString().slice(0, 10);
  try {
    const res = await fetch('/api/exports/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        type: 'scrape_xlsx',
        label,
        fileName: `amazon_products_${date}.xlsx`,
        params: { taskId, asins },
      }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert(d.error || '创建导出任务失败，请重试');
      return;
    }
    onDone();
  } catch {
    alert('网络错误，请检查服务是否正常');
  }
}

// ---- Main View ----
export function ProductScrape() {
  const [asinInput, setAsinInput]     = React.useState('');
  const [marketplace, setMarketplace] = React.useState('US');
  const [withReviews, setWithReviews] = React.useState(false);
  const [products, setProducts]       = React.useState<ScrapedProduct[]>([]);
  const [running, setRunning]         = React.useState(false);
  // 「本轮」进度：进度条用它。分母=本轮工作集（首次=全部 ASIN；重试/续跑=未成功的那些），
  // 取自服务端 /progress 的 run 字段——重试时用任务累计口径会一开跑就 100% 且不动。
  const [progress, setProgress]       = React.useState({ completed: 0, total: 0 });
  // 任务累计进度（次要显示）：成功 success / 总数 total
  const [taskProgress, setTaskProgress] = React.useState({ success: 0, total: 0 });
  // 已发出暂停/取消信号、等待服务端线程退出——用于把按钮显示成「正在暂停…」
  const [stopping, setStopping]       = React.useState(false);
  const [tasks, setTasks]             = React.useState<ScrapeTask[]>([]);
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
  const [err, setErr]                 = React.useState('');
  const [loadErr, setLoadErr]         = React.useState('');
  const [selectedProduct, setSelectedProduct] = React.useState<ScrapedProduct | null>(null);
  const [detailOpen, setDetailOpen] = React.useState(false);
  const [page, setPage] = React.useState(1);
  const [pageSize, setPageSize] = React.useState(50);
  const [pageInput, setPageInput] = React.useState('');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [selectedAsins, setSelectedAsins] = React.useState<Set<string>>(new Set());
  const [hoverPreview, setHoverPreview] = React.useState<{ src: string; top: number; left: number } | null>(null);
  const [sortKey, setSortKey] = React.useState<'asin' | 'price' | 'rating' | 'mainRank' | 'subRank' | 'launch' | null>(null);
  const [sortAsc, setSortAsc] = React.useState(true);
  const [editingTaskId, setEditingTaskId] = React.useState<string | null>(null);
  const [editingName, setEditingName] = React.useState('');
  const [exportQueued, setExportQueued] = React.useState(false);
  // 历史任务列表：检索 / 筛选 / 分页（纯前端，tasks 一次全量拉回，最多 100 条）
  const [histQuery, setHistQuery] = React.useState('');
  const [histFilter, setHistFilter] = React.useState<'all' | 'active' | 'failed'>('all');
  const [histPage, setHistPage] = React.useState(1);
  const [histPageSize, setHistPageSize] = React.useState(15);

  function showThumbPreview(e: React.MouseEvent<HTMLImageElement>, src: string) {
    const rect = e.currentTarget.getBoundingClientRect();
    const size = 200;
    const gap = 8;
    let left = rect.right + gap;
    if (left + size > window.innerWidth) left = rect.left - size - gap;
    let top = rect.top;
    if (top + size > window.innerHeight) top = window.innerHeight - size - gap;
    setHoverPreview({ src, top, left });
  }

  const asins = React.useMemo(() =>
    asinInput.split(/[\n,;\s]+/).map(a => a.trim().toUpperCase()).filter(Boolean),
    [asinInput]);
  const validAsins = React.useMemo(() => asins.filter(a => /^[A-Z0-9]{10}$/.test(a)), [asins]);

  // 失败项（「重试失败项」按钮用）
  const failedProducts = React.useMemo(() => products.filter(p => p.status === 'failed'), [products]);

  // ---- 历史任务：筛选 + 检索 + 分页（全在前端算，tasks 已在内存）----
  const histFiltered = React.useMemo(() => {
    let arr = tasks;
    if (histFilter === 'active') arr = arr.filter(t => t.status === 'running' || t.status === 'paused');
    else if (histFilter === 'failed') arr = arr.filter(t => (t.failed || 0) > 0);
    const q = histQuery.trim().toLowerCase();
    if (q) {
      arr = arr.filter(t => {
        const info = mkInfo(t.marketplace);
        const name = t.name || `${info.flag} ${info.name} · ${fmtDateTime(t.createdAt)}`;
        return [name, info.name, t.marketplace || '', t.createdAt || '']
          .some(s => String(s).toLowerCase().includes(q));
      });
    }
    return arr;
  }, [tasks, histFilter, histQuery]);

  const histTotalPages = Math.max(1, Math.ceil(histFiltered.length / histPageSize));
  // 页码可能因筛选/检索后结果变少而越界：先夹到有效范围再切片，避免「越界 → 列表空白一帧」的闪烁，
  // 随后再把 state 同步回来（见下方 effect）。
  const histSafePage = Math.min(histPage, histTotalPages);
  const histPaged = React.useMemo(
    () => histFiltered.slice((histSafePage - 1) * histPageSize, histSafePage * histPageSize),
    [histFiltered, histSafePage, histPageSize]);
  React.useEffect(() => { setHistPage(1); }, [histQuery, histFilter, histPageSize]);
  React.useEffect(() => { if (histPage !== histSafePage) setHistPage(histSafePage); }, [histPage, histSafePage]);

  // ---- 采集任务轮询 ----
  // 执行权在服务端：提交后前端只负责按秒读进度。刷新页面时组件重建，
  // 下面的挂载逻辑会重新发现 running 任务并接上，所以刷新不再丢任务。
  const pollRef = React.useRef<number | null>(null);
  const stopPolling = React.useCallback(() => {
    if (pollRef.current != null) { window.clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const reloadTasks = React.useCallback(async () => {
    try { setTasks(await apiGetTasks()); setLoadErr(''); }
    catch (e: any) { setLoadErr(e.message || '加载失败'); }
  }, []);

  // 跟踪用户当前在看哪个任务：轮询结束时不要覆盖用户主动切过去查看的历史任务
  const activeTaskRef = React.useRef<string | null>(null);
  React.useEffect(() => { activeTaskRef.current = activeTaskId; }, [activeTaskId]);

  const startPolling = React.useCallback((taskId: string) => {
    stopPolling();
    setRunning(true);
    setStopping(false);
    setActiveTaskId(taskId);
    const tick = async () => {
      try {
        const { task: t, stopping: isStopping, run } = await apiGetProgress(taskId);
        setStopping(isStopping);
        setTaskProgress({ success: t.success, total: t.total });
        if (run && run.total > 0) {
          // 本轮进度：首次=已处理/全部；重试=本轮已成功/待重试数
          setProgress({ completed: run.done, total: run.total });
        } else {
          // 基线未就绪（start 刚返回的瞬间）或无活跃执行：回退到任务累计口径
          setProgress({ completed: t.success + t.failed, total: t.total });
        }
        // 只有 running 才算还在跑：paused / cancelled / completed / partial / error
        // 都是终态或待续跑状态，轮询到此为止（暂停后用户可点「继续」再起一轮）。
        if (t.status !== 'running') {
          stopPolling();
          setRunning(false);
          setStopping(false);
          await reloadTasks();
          const viewing = activeTaskRef.current;
          if (viewing === null || viewing === taskId) {
            setProducts(await apiGetProducts(taskId));
          }
        }
      } catch (e: any) {
        stopPolling();
        setRunning(false);
        setStopping(false);
        setErr(e.message || '读取采集进度失败');
      }
    };
    tick();
    pollRef.current = window.setInterval(tick, 2000);
  }, [stopPolling, reloadTasks]);

  // 进入页面：拉任务列表；若有正在跑的任务就自动接上（「刷新不丢」的关键一步）
  React.useEffect(() => {
    (async () => {
      try {
        const list = await apiGetTasks();
        setTasks(list);
        setLoadErr('');
        const live = list.find(t => t.status === 'running');
        if (live) {
          try { setProducts(await apiGetProducts(live.id)); } catch { /* 结果稍后轮询会补上 */ }
          startPolling(live.id);
        }
      } catch (e: any) { setLoadErr(e.message || '加载失败'); }
    })();
  }, [startPolling]);

  React.useEffect(() => () => stopPolling(), [stopPolling]);

  async function handleResetSession() {
    if (!confirm('确定刷新会话？将清空当前站点Cookie和浏览器指纹。')) return;
    try { await apiResetSession(marketplace); setErr('会话已刷新，请重试采集'); }
    catch (e: any) { setErr(e.message || '刷新失败'); }
  }

  // 重试失败项：本质是「往同一个任务里补跑没成功的 ASIN」，服务端会自动跳过已成功项
  async function handleRetryFailed() {
    if (failedProducts.length === 0 || !activeTaskId) return;
    if (!confirm(`确定重试 ${failedProducts.length} 个失败的 ASIN？\n\n系统将刷新会话，然后只补跑这些失败项，已成功的不会重复采集。`)) return;
    setErr('');
    try {
      await apiResetSession(marketplace);
      await apiStartScrape(failedProducts.map(p => p.asin), marketplace, withReviews, activeTaskId);
      // 立即切到本轮口径（待重试数），避免闪现上一轮残留的 100%
      setProgress({ completed: 0, total: failedProducts.length });
      startPolling(activeTaskId);
    } catch (e: any) { setErr(e.message || '提交重试失败'); }
  }

  async function runScrape() {
    if (!validAsins.length) { setErr('请输入有效的 ASIN（10 位字母数字）'); return; }
    setErr(''); setProducts([]); setActiveTaskId(null); setPage(1);
    setProgress({ completed: 0, total: validAsins.length });
    try {
      const taskId = await apiStartScrape(validAsins, marketplace, withReviews);
      startPolling(taskId);
    } catch (e: any) {
      setErr(e.message || '提交采集失败');
      setRunning(false);
    }
  }

  // 继续：服务端按 task_id 起重线程，只补没跑完的（断点续跑）
  async function resumeTask(t: ScrapeTask) {
    if (!t.asins?.length) { setErr('该任务没有记录 ASIN 列表，无法继续'); return; }
    setErr(''); setPage(1);
    try {
      await apiResumeScrape(t.id);
      startPolling(t.id);
    } catch (e: any) { setErr(e.message || '继续采集失败'); }
  }

  // 暂停：线程在检查点退出并落成 paused，已抓到的结果保留，之后可点「继续」
  async function handlePause() {
    if (!activeTaskId || stopping) return;
    setStopping(true); setErr('');
    try { await apiStopScrape('pause', activeTaskId); }
    catch (e: any) { setStopping(false); setErr(e.message || '暂停失败'); }
  }

  // 取消：终止本次执行。结果同样保留，任务卡上仍可点「继续」接着跑
  async function handleCancelScrape() {
    if (!activeTaskId || stopping) return;
    if (!confirm('确定取消当前采集？\n\n已采集的结果会保留，之后可在任务卡上点「继续」从断点接着跑。')) return;
    setStopping(true); setErr('');
    try { await apiStopScrape('cancel', activeTaskId); }
    catch (e: any) { setStopping(false); setErr(e.message || '取消失败'); }
  }

  function clearResults() {
    setProducts([]); setAsinInput(''); setActiveTaskId(null); setErr('');
    setPage(1); setSearchQuery(''); setSelectedAsins(new Set()); setSortKey(null);
  }

  async function viewTask(t: ScrapeTask) {
    setActiveTaskId(t.id); setErr(''); setPage(1); setSearchQuery(''); setSelectedAsins(new Set());
    try { setProducts(await apiGetProducts(t.id)); }
    catch (e: any) { setErr(e.message || '加载失败'); setProducts([]); }
  }

  async function removeTask(t: ScrapeTask) {
    if (!confirm(`删除任务（${mkInfo(t.marketplace).flag} ${mkInfo(t.marketplace).name} · ${t.total} 个 ASIN）及其结果？`)) return;
    try { await apiDeleteTask(t.id); }
    catch (e: any) { setErr(e.message || '删除失败'); return; }
    setTasks(ts => ts.filter(x => x.id !== t.id));
    if (activeTaskId === t.id) { setProducts([]); setActiveTaskId(null); setSelectedAsins(new Set()); }
  }

  function startRename(t: ScrapeTask) {
    setEditingTaskId(t.id);
    setEditingName(t.name || `${mkInfo(t.marketplace).flag} ${mkInfo(t.marketplace).name} · ${fmtDateTime(t.createdAt)}`);
  }

  async function commitRename() {
    if (!editingTaskId) return;
    const name = editingName.trim();
    await apiUpdateTaskName(editingTaskId, name);
    setTasks(ts => ts.map(t => t.id === editingTaskId ? { ...t, name: name || null } : t));
    setEditingTaskId(null);
  }

  const successCount = products.filter(p => p.status === 'success').length;
  const failedCount  = products.filter(p => p.status === 'failed').length;
  const progressPct  = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;

  const filteredProducts = React.useMemo(() => {
    const q = searchQuery.trim().toUpperCase();
    if (!q) return products;
    return products.filter(p => p.asin.includes(q));
  }, [products, searchQuery]);

  const parsePrice = (s: string | undefined): number => {
    if (!s) return Infinity;
    const n = parseFloat(s.replace(/[^0-9.]/g, ''));
    return isNaN(n) ? Infinity : n;
  };
  const parseRating = (s: string | undefined): number => {
    if (!s) return -1;
    const n = parseFloat(s.replace(/ out of.*/i, ''));
    return isNaN(n) ? -1 : n;
  };

  const sortedProducts = React.useMemo(() => {
    if (!sortKey) return filteredProducts;
    return [...filteredProducts].sort((a, b) => {
      if (sortKey === 'asin') {
        const cmp = a.asin.localeCompare(b.asin);
        return sortAsc ? cmp : -cmp;
      }
      let va: number, vb: number;
      if (sortKey === 'price') {
        va = parsePrice(a.price); vb = parsePrice(b.price);
      } else if (sortKey === 'rating') {
        va = parseRating(a.rating); vb = parseRating(b.rating);
      } else if (sortKey === 'mainRank') {
        va = a.bestSellerRank.mainRank ?? Infinity; vb = b.bestSellerRank.mainRank ?? Infinity;
      } else if (sortKey === 'launch') {
        va = dateFirstAvailableTs(a); vb = dateFirstAvailableTs(b);
      } else {
        va = a.bestSellerRank.subRank ?? Infinity; vb = b.bestSellerRank.subRank ?? Infinity;
      }
      // 缺上架时间的恒沉底（不随升降序翻转）：否则默认「最新在前」（降序）时，
      // x - Infinity = -Infinity 会把空值顶到最上面。
      if (sortKey === 'launch') {
        const aMissing = va === Infinity, bMissing = vb === Infinity;
        if (aMissing !== bMissing) return aMissing ? 1 : -1;
        if (aMissing && bMissing) return 0;
      }
      return sortAsc ? va - vb : vb - va;
    });
  }, [filteredProducts, sortKey, sortAsc]);

  const totalPages = Math.max(1, Math.ceil(sortedProducts.length / pageSize));
  React.useEffect(() => { if (page > totalPages) setPage(totalPages); }, [totalPages]);
  React.useEffect(() => { setPage(1); }, [searchQuery, pageSize]);
  const pagedProducts = sortedProducts.slice((page - 1) * pageSize, page * pageSize);

  // ---- 多选辅助 ----
  const pagedAsins = pagedProducts.map(p => p.asin);
  const isAllPageSelected = pagedAsins.length > 0 && pagedAsins.every(a => selectedAsins.has(a));
  const isIndeterminate   = !isAllPageSelected && pagedAsins.some(a => selectedAsins.has(a));

  function toggleOne(asin: string) {
    setSelectedAsins(prev => {
      const next = new Set(prev);
      next.has(asin) ? next.delete(asin) : next.add(asin);
      return next;
    });
  }
  function togglePage() {
    if (isAllPageSelected) {
      setSelectedAsins(prev => { const n = new Set(prev); pagedAsins.forEach(a => n.delete(a)); return n; });
    } else {
      setSelectedAsins(prev => { const n = new Set(prev); pagedAsins.forEach(a => n.add(a)); return n; });
    }
  }
  function selectAll()   { setSelectedAsins(new Set(filteredProducts.map(p => p.asin))); }
  function clearSelect() { setSelectedAsins(new Set()); }

  function jumpPage(val: string) {
    const n = parseInt(val);
    if (!isNaN(n) && n >= 1 && n <= totalPages) setPage(n);
    setPageInput('');
  }

  return (
    <div className="ps-root">
      {/* Left: input + history */}
      <div className="ps-side">
        <div className="ps-field">
          <label className="ps-label">站点</label>
          <select className="ps-select" value={marketplace} onChange={e => setMarketplace(e.target.value)} disabled={running}>
            {MARKETPLACES.map(m => <option key={m.code} value={m.code}>{m.flag} {m.name}</option>)}
          </select>
        </div>

        <div className="ps-field">
          <label className="ps-label">ASIN（每行一个，支持逗号/空格分隔）</label>
          <textarea className="ps-textarea" rows={8} value={asinInput}
            onChange={e => setAsinInput(e.target.value)}
            placeholder={'B0XXXXXXXXX\nB0YYYYYYYYY'} disabled={running} />
          <div className="ps-asin-count">
            已输入 {asins.length} 个，有效 {validAsins.length} 个
            {asins.length > validAsins.length && <span className="ps-asin-bad"> · {asins.length - validAsins.length} 个无效</span>}
          </div>
        </div>

        <label className="ps-check">
          <input type="checkbox" checked={withReviews} onChange={e => setWithReviews(e.target.checked)} disabled={running} />
          <span>抓取评论数据（速度较慢）</span>
        </label>

        {err && <div className="ps-err">{err}</div>}

        <div className="ps-actions">
          <button className="btn btn-primary btn-sm" onClick={runScrape} disabled={running || !validAsins.length}>
            {running ? '采集中…' : '开始采集'}
          </button>
          <button className="btn btn-sm" onClick={clearResults} disabled={running}>清空</button>
          <button className="btn btn-sm" onClick={handleResetSession} disabled={running}>刷新会话</button>
        </div>

        {running && (
          <div className="ps-progress">
            <div className="ps-progress-row">
              <span>{stopping ? '正在停止…' : '采集中'}</span>
              <span>
                {progress.total > 0 ? `${progress.completed}/${progress.total}（${progressPct}%）` : ''}
                {taskProgress.total > 0 && (
                  <span className="ps-progress-sub">成功 {taskProgress.success}/{taskProgress.total}</span>
                )}
              </span>
            </div>
            {progress.total > 0 && (
              <div className="ps-progress-bar"><div className="ps-progress-fill" style={{ width: progressPct + '%' }} /></div>
            )}
            <div className="ps-progress-actions">
              <button className="btn btn-sm" onClick={handlePause} disabled={stopping}>暂停</button>
              <button className="btn btn-sm" onClick={handleCancelScrape} disabled={stopping}>取消采集</button>
            </div>
          </div>
        )}

        <div className="ps-history">
          <div className="ps-hist-head">
            <span className="ps-hist-title">历史任务</span>
            <span className="ps-hist-count">
              {histFiltered.length}{histFiltered.length !== tasks.length ? ` / ${tasks.length}` : ''} 条
            </span>
          </div>
          {loadErr && <div className="ps-err">{loadErr}</div>}
          {!tasks.length && !loadErr && <div className="ps-empty">暂无历史任务</div>}

          {tasks.length > HIST_CHROME_MIN && (
            <>
              <input className="ps-hist-search" placeholder="搜索名称 / 站点 / 日期…"
                value={histQuery} onChange={e => setHistQuery(e.target.value)} />
              <div className="ps-hist-filters">
                {([['all', '全部'], ['active', '进行中'], ['failed', '有失败']] as const).map(([k, label]) => (
                  <button key={k} className="ps-hist-chip" data-on={histFilter === k}
                    onClick={() => setHistFilter(k)}>{label}</button>
                ))}
              </div>
            </>
          )}

          <div className="ps-hist-list">
            {tasks.length > 0 && histFiltered.length === 0 && <div className="ps-empty">没有匹配的任务</div>}
            {histPaged.map((t, i) => {
              const g = dayGroup(t.createdAt);
              const prevG = i > 0 ? dayGroup(histPaged[i - 1].createdAt) : null;
              const hint = t.error || '';
              const info = mkInfo(t.marketplace);
              const displayName = t.name || `${info.flag} ${info.name} · ${fmtDateTime(t.createdAt)}`;
              const fullTip = `${displayName}\n创建 ${fmtDateTime(t.createdAt)} · 共 ${t.total} · 成功 ${t.success} · 失败 ${t.failed}`
                + `${taskStatusText(t) ? ` · ${taskStatusText(t)}` : ''}${t.withReviews ? ' · 含评论' : ''}`;
              return (
                <React.Fragment key={t.id}>
                  {g !== prevG && <div className="ps-hist-group">{g}</div>}
                  <div className="ps-task" data-active={t.id === activeTaskId} title={fullTip}>
                    <span className="ps-task-dot" data-st={t.status} />
                    <button className="ps-task-main" onClick={() => { if (editingTaskId !== t.id) viewTask(t); }}>
                      <span className="ps-task-line">
                        {editingTaskId === t.id ? (
                          <input
                            className="ps-task-rename-input"
                            value={editingName}
                            onChange={e => setEditingName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingTaskId(null); }}
                            onBlur={commitRename}
                            onClick={e => e.stopPropagation()}
                            autoFocus
                          />
                        ) : (
                          <span className="ps-task-name">{displayName}</span>
                        )}
                        <span className="ps-task-stats" data-warn={t.failed > 0}>{t.total}/{t.success}</span>
                      </span>
                      {hint && <span className="ps-task-hint">{hint}</span>}
                    </button>
                    <div className="ps-task-actions">
                      {(t.status === 'paused' || t.status === 'cancelled' || t.status === 'error') && (
                        <button className="btn btn-sm" onClick={() => resumeTask(t)} disabled={running}>继续</button>
                      )}
                      <button className="btn btn-sm" onClick={() => startRename(t)} title="重命名">✎</button>
                      <button className="btn btn-sm ps-del" onClick={() => removeTask(t)} title="删除">删除</button>
                    </div>
                  </div>
                </React.Fragment>
              );
            })}
          </div>

          {histTotalPages > 1 && (
            <div className="ps-hist-pager">
              <select className="ps-hist-size" value={histPageSize} title="每页条数"
                onChange={e => setHistPageSize(Number(e.target.value))}>
                {HIST_PAGE_SIZES.map(n => <option key={n} value={n}>{n}/页</option>)}
              </select>
              <button className="btn btn-sm" title="上一页" disabled={histSafePage <= 1}
                onClick={() => setHistPage(Math.max(1, histSafePage - 1))}>‹</button>
              <span className="ps-hist-pagenum">{histSafePage} / {histTotalPages}</span>
              <button className="btn btn-sm" title="下一页" disabled={histSafePage >= histTotalPages}
                onClick={() => setHistPage(Math.min(histTotalPages, histSafePage + 1))}>›</button>
            </div>
          )}
        </div>
      </div>

      {/* Right: results table */}
      <div className="ps-main">
        <div className="ps-main-head">
          <div className="ps-main-title">
            采集结果
            {products.length > 0 && (
              <span className="ps-badge">
                {searchQuery.trim() ? `${filteredProducts.length}/${products.length}` : products.length} 条
              </span>
            )}
            {products.length > 0 && (
              <span className="ps-stats">
                <span className="ps-ok">成功 {successCount}</span>
                {failedCount > 0 && <span className="ps-fail">失败 {failedCount}</span>}
              </span>
            )}
          </div>
          {products.length > 0 && (
            <div className="ps-main-actions">
              <input
                className="ps-search-input"
                type="text"
                placeholder="搜索 ASIN…"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
              {failedCount > 0 && (
                <button className="btn btn-sm" onClick={handleRetryFailed} disabled={running}>
                  重试失败 ({failedCount})
                </button>
              )}
              <button className="btn btn-sm" onClick={() => exportCSV(
                selectedAsins.size > 0 ? products.filter(p => selectedAsins.has(p.asin)) : products,
                marketplace
              )}>
                导出 CSV{selectedAsins.size > 0 ? `（已选 ${selectedAsins.size}）` : ''}
              </button>
              <button
                className="btn btn-sm"
                disabled={exportQueued || !activeTaskId}
                onClick={async () => {
                  if (!activeTaskId) return;
                  setExportQueued(true);
                  const exportAsins = selectedAsins.size > 0 ? [...selectedAsins] : null;
                  const count = exportAsins ? exportAsins.length : products.length;
                  const label = `产品采集 · ${count} 个ASIN`;
                  await createExportJob(activeTaskId, label, () => {
                    alert('导出任务已创建，请在「我的导出」中查看进度');
                  }, exportAsins);
                  setExportQueued(false);
                }}
              >{exportQueued ? '提交中…' : `导出 Excel${selectedAsins.size > 0 ? `（已选 ${selectedAsins.size}）` : '（含主图）'}`}</button>
            </div>
          )}
          {selectedAsins.size > 0 && (
            <div className="ps-select-bar">
              <span>已选 <strong>{selectedAsins.size}</strong> 条</span>
              <button className="ps-select-link" onClick={selectAll}>全选所有 {filteredProducts.length} 条</button>
              <button className="ps-select-link ps-select-clear" onClick={clearSelect}>取消选择</button>
            </div>
          )}
        </div>

        {!products.length ? (
          <div className="ps-empty ps-empty-lg">
            {running ? '正在采集中…' : '输入 ASIN 并点击「开始采集」，或在左侧选择历史任务查看结果'}
          </div>
        ) : (
          <>
          <div className="ps-table-wrap">
            <table className="ps-table">
              <thead>
                <tr>
                  <th className="ps-col-chk">
                    <input
                      type="checkbox"
                      checked={isAllPageSelected}
                      ref={el => { if (el) el.indeterminate = isIndeterminate; }}
                      onChange={togglePage}
                      title="选择当前页"
                    />
                  </th>
                  <th className="ps-col-img">图片</th>
                  <th className="ps-col-asin ps-sortable" onClick={() => { if (sortKey === 'asin') setSortAsc(v => !v); else { setSortKey('asin'); setSortAsc(true); } }} data-active={sortKey === 'asin'}>
                    ASIN{sortKey === 'asin' && <span className="ps-sort-arrow">{sortAsc ? '↑' : '↓'}</span>}
                  </th>
                  <th className="ps-col-title">标题</th>
                  <th>品牌</th>
                  <th className="ps-sortable" onClick={() => { if (sortKey === 'price') setSortAsc(v => !v); else { setSortKey('price'); setSortAsc(true); } }} data-active={sortKey === 'price'}>
                    价格{sortKey === 'price' && <span className="ps-sort-arrow">{sortAsc ? '↑' : '↓'}</span>}
                  </th>
                  <th className="ps-sortable" onClick={() => { if (sortKey === 'rating') setSortAsc(v => !v); else { setSortKey('rating'); setSortAsc(false); } }} data-active={sortKey === 'rating'}>
                    评分{sortKey === 'rating' && <span className="ps-sort-arrow">{sortAsc ? '↑' : '↓'}</span>}
                  </th>
                  <th className="ps-col-launch ps-sortable" onClick={() => { if (sortKey === 'launch') setSortAsc(v => !v); else { setSortKey('launch'); setSortAsc(false); } }} data-active={sortKey === 'launch'}>
                    上架时间{sortKey === 'launch' && <span className="ps-sort-arrow">{sortAsc ? '↑' : '↓'}</span>}
                  </th>
                  <th className="ps-col-cat">分类路径</th>
                  <th className="ps-sortable" onClick={() => { if (sortKey === 'mainRank') setSortAsc(v => !v); else { setSortKey('mainRank'); setSortAsc(true); } }} data-active={sortKey === 'mainRank'}>
                    大类排名{sortKey === 'mainRank' && <span className="ps-sort-arrow">{sortAsc ? '↑' : '↓'}</span>}
                  </th>
                  <th className="ps-sortable" onClick={() => { if (sortKey === 'subRank') setSortAsc(v => !v); else { setSortKey('subRank'); setSortAsc(true); } }} data-active={sortKey === 'subRank'}>
                    小类排名{sortKey === 'subRank' && <span className="ps-sort-arrow">{sortAsc ? '↑' : '↓'}</span>}
                  </th>
                  <th>状态</th>
                  <th className="ps-col-ops">操作</th>
                </tr>
              </thead>
              <tbody>
                {pagedProducts.map((p, i) => (
                  <tr key={p.asin + i} data-selected={selectedAsins.has(p.asin)}>
                    <td className="ps-col-chk">
                      <input
                        type="checkbox"
                        checked={selectedAsins.has(p.asin)}
                        onChange={() => toggleOne(p.asin)}
                      />
                    </td>
                    <td className="ps-col-img">
                      {p.mainImage
                        ? <img className="ps-thumb" src={p.mainImage} alt=""
                            style={{ cursor: 'pointer' }}
                            onClick={() => { setSelectedProduct(p); setDetailOpen(true); }}
                            onMouseEnter={e => showThumbPreview(e, p.mainImage!)}
                            onMouseLeave={() => setHoverPreview(null)} />
                        : <div className="ps-thumb ps-thumb-empty" />}
                    </td>
                    <td className="ps-col-asin"><span className="mono">{p.asin}</span></td>
                    <td className="ps-col-title" title={p.title || ''}>
                      {p.title || <span className="ps-muted">无标题</span>}
                    </td>
                    <td>{p.brand || '—'}</td>
                    <td>{p.price || '—'}</td>
                    <td>{p.rating ? p.rating.replace(/ out of.*/i, '') : '—'}</td>
                    <td className="ps-col-launch" title={findDateFirstAvailable(p)}>{findDateFirstAvailable(p) || '—'}</td>
                    <td className="ps-col-cat" title={p.categories || ''}>{p.categories || '—'}</td>
                    <td>
                      {p.bestSellerRank.mainRank != null
                        ? <>#{p.bestSellerRank.mainRank.toLocaleString()} <span className="ps-muted">{p.bestSellerRank.mainCategory}</span></>
                        : '—'}
                    </td>
                    <td>
                      {p.bestSellerRank.subRank != null
                        ? <>#{p.bestSellerRank.subRank.toLocaleString()} <span className="ps-muted">{p.bestSellerRank.subCategory}</span></>
                        : '—'}
                    </td>
                    <td>
                      {p.status === 'success'
                        ? <span className="ps-status ps-status-ok">成功</span>
                        : <span className="ps-status ps-status-fail" title={p.errorMessage || '未知错误'}>失败</span>}
                    </td>
                    <td className="ps-col-ops">
                      <button className="btn btn-sm ps-btn-detail" onClick={() => { setSelectedProduct(p); setDetailOpen(true); }}>详情</button>
                      <a className="btn btn-sm" href={productUrl(p.asin, p.marketplace || marketplace)} target="_blank" rel="noopener noreferrer">查看</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="ps-pagination">
            <span className="ps-page-info">
              共 {filteredProducts.length} 条{searchQuery.trim() ? `（全部 ${products.length} 条）` : ''}
            </span>
            <div className="ps-page-btns">
              <button className="btn btn-sm" onClick={() => setPage(1)} disabled={page <= 1}>首页</button>
              <button className="btn btn-sm" onClick={() => setPage(p => p - 1)} disabled={page <= 1}>上一页</button>
              <span className="ps-page-num">第 {page} / {totalPages} 页</span>
              <button className="btn btn-sm" onClick={() => setPage(p => p + 1)} disabled={page >= totalPages}>下一页</button>
              <button className="btn btn-sm" onClick={() => setPage(totalPages)} disabled={page >= totalPages}>末页</button>
            </div>
            <div className="ps-page-tools">
              <span className="ps-page-label">每页</span>
              <select
                className="ps-page-size-select"
                value={pageSize}
                onChange={e => setPageSize(Number(e.target.value))}
              >
                {PAGE_SIZE_OPTIONS.map(n => (
                  <option key={n} value={n}>{n} 条</option>
                ))}
              </select>
              <span className="ps-page-label">跳至</span>
              <input
                className="ps-page-jump"
                type="number"
                min={1}
                max={totalPages}
                value={pageInput}
                placeholder={String(page)}
                onChange={e => setPageInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') jumpPage(pageInput); }}
                onBlur={() => { if (pageInput) jumpPage(pageInput); }}
              />
              <span className="ps-page-label">页</span>
            </div>
          </div>
          </>
        )}
      </div>

      {detailOpen && (
        <ProductDetailDialog
          product={selectedProduct}
          open={detailOpen}
          onClose={() => { setDetailOpen(false); setSelectedProduct(null); }}
        />
      )}

      {hoverPreview && (
        <div className="ps-thumb-preview" style={{ top: hoverPreview.top, left: hoverPreview.left }}>
          <img src={hoverPreview.src} alt="" />
        </div>
      )}
    </div>
  );
}

export { ProductDetailDialog };

