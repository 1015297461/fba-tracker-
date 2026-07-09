import React, { useState, useCallback, useEffect } from 'react';

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

const BATCH_SIZE = 3;
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
function Lightbox({ images, initialIndex, onClose }: LightboxProps) {
  const [current, setCurrent] = useState(initialIndex);

  const prev = useCallback(() => setCurrent(i => (i - 1 + images.length) % images.length), [images.length]);
  const next = useCallback(() => setCurrent(i => (i + 1) % images.length), [images.length]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "ArrowLeft") prev();
      if (e.key === "ArrowRight") next();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [onClose, prev, next]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal ps-lightbox" onClick={e => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>✕</button>
        <div className="ps-lightbox-counter">{current + 1} / {images.length}</div>
        {images.length > 1 && (
          <button className="ps-lightbox-btn ps-lightbox-prev" onClick={e => { e.stopPropagation(); prev(); }}>
            ◀
          </button>
        )}
        <div className="ps-lightbox-img-wrap" onClick={e => e.stopPropagation()}>
          <img
            key={current}
            src={images[current]}
            alt={`Image ${current + 1}`}
            className="ps-lightbox-img"
            draggable={false}
          />
        </div>
        {images.length > 1 && (
          <>
            <button className="ps-lightbox-btn ps-lightbox-next" onClick={e => { e.stopPropagation(); next(); }}>
              ▶
            </button>
            <div className="ps-lightbox-thumbs" onClick={e => e.stopPropagation()}>
              {images.map((img, i) => (
                <button
                  key={i}
                  onClick={() => setCurrent(i)}
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
interface ScrapeTask {
  id: string; marketplace: string; total: number; success: number; failed: number;
  withReviews: boolean; status: string; createdAt: string;
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
async function apiRunScrape(asins: string[], marketplace: string, withReviews: boolean, taskId?: string, total?: number): Promise<{ taskId: string; products: ScrapedProduct[] }> {
  const r = await fetch('/api/scrape/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ asins, marketplace, withReviews, ...(taskId ? { taskId } : {}), ...(total != null ? { total } : {}) }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || '采集失败');
  }
  const data = await r.json();
  return { taskId: data.taskId, products: (data.results || []).map(normalizeRunResult) };
}
async function apiDeleteTask(id: string): Promise<void> {
  await fetch('/api/scrape/tasks?id=' + encodeURIComponent(id), { method: 'DELETE', headers: authHeaders() });
}

async function apiResetSession(marketplace: string): Promise<void> {
  await fetch('/api/scrape/reset-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ marketplace }),
  });
}

// 把 /api/scrape/run 直接返回的 snake_case 结果，转换为与历史任务一致的 camelCase 结构
function normalizeRunResult(r: any): ScrapedProduct {
  return {
    asin: r.asin, marketplace: r.marketplace,
    title: r.title, brand: r.brand, price: r.price,
    rating: r.rating, reviewCount: r.review_count, availability: r.availability,
    bulletPoints: r.bullet_points || [], description: r.description,
    mainImage: r.main_image, images: r.images || [], aplusImages: r.aplus_images || [],
    specifications: r.specifications || {}, productDetails: r.product_details || {},
    categories: r.categories, seller: r.seller,
    bestSellerRank: {
      mainCategory: r.bsr_main_category, mainRank: r.bsr_main_rank,
      subCategory: r.bsr_sub_category, subRank: r.bsr_sub_rank, rawText: r.bsr_raw_text,
    },
    customerReviews: {
      customersSay: r.customers_say,
      reviewImages: r.review_images || [],
      selectToLearnMore: r.select_to_learn_more || [],
    },
    status: r.status, errorMessage: r.error_message,
  };
}

// ---- Utilities ----
function fmtDateTime(iso: string): string {
  const m = iso.match(/\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]}` : iso;
}
function productUrl(asin: string, marketplace: string): string {
  return `https://${mkInfo(marketplace).domain}/dp/${asin}`;
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
  const [progress, setProgress]       = React.useState({ completed: 0, total: 0, batch: 0, totalBatches: 0 });
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
  const [exportQueued, setExportQueued] = React.useState(false);

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

  // Retry failed products
  const failedProducts = React.useMemo(() => products.filter(p => p.status === 'failed'), [products]);
  const [retrying, setRetrying] = React.useState(false);

  async function handleResetSession() {
    if (!confirm('确定刷新会话？将清空当前站点Cookie和浏览器指纹。')) return;
    try { await apiResetSession(marketplace); setErr('会话已刷新，请重试采集'); }
    catch (e: any) { setErr(e.message || '刷新失败'); }
  }

  async function handleRetryFailed() {
    if (failedProducts.length === 0) return;
    if (!confirm(`确定重试 ${failedProducts.length} 个失败的ASIN？\n\n系统将：\n1. 刷新会话\n2. 重新采集失败项\n3. 合并到现有结果`)) return;

    setRetrying(true);
    setErr('');
    try {
      await apiResetSession(marketplace);
      const failedAsins = failedProducts.map(p => p.asin);

      const batches: string[][] = [];
      for (let i = 0; i < failedAsins.length; i += BATCH_SIZE) batches.push(failedAsins.slice(i, i + BATCH_SIZE));
      setProgress({ completed: 0, total: failedAsins.length, batch: 0, totalBatches: batches.length });

      let retryTaskId: string | undefined;
      for (let i = 0; i < batches.length; i++) {
        setProgress(p => ({ ...p, batch: i + 1 }));
        const { taskId, products: batchProducts } = await apiRunScrape(batches[i], marketplace, withReviews, retryTaskId, failedAsins.length);
        retryTaskId = taskId;
        setProducts(prev => {
          const merged = [...prev];
          for (const np of batchProducts) {
            const idx = merged.findIndex(p => p.asin === np.asin);
            if (idx >= 0) merged[idx] = np; else merged.push(np);
          }
          return merged;
        });
        setProgress(p => ({ ...p, completed: p.completed + batches[i].length }));
      }

      await reloadTasks();
    } catch (e: any) { setErr(e.message || '重试失败'); }
    finally { setRetrying(false); setProgress({ completed: 0, total: 0, batch: 0, totalBatches: 0 }); }
  }

  async function reloadTasks() {
    try { setTasks(await apiGetTasks()); setLoadErr(''); }
    catch (e: any) { setLoadErr(e.message || '加载失败'); }
  }
  React.useEffect(() => { reloadTasks(); }, []);

  async function runScrape() {
    if (!validAsins.length) { setErr('请输入有效的 ASIN（10 位字母数字）'); return; }
    setErr(''); setRunning(true); setProducts([]); setActiveTaskId(null); setPage(1);

    const batches: string[][] = [];
    for (let i = 0; i < validAsins.length; i += BATCH_SIZE) batches.push(validAsins.slice(i, i + BATCH_SIZE));
    setProgress({ completed: 0, total: validAsins.length, batch: 0, totalBatches: batches.length });

    const all: ScrapedProduct[] = [];
    let taskId: string | undefined;
    try {
      for (let i = 0; i < batches.length; i++) {
        setProgress(p => ({ ...p, batch: i + 1 }));
        const res = await apiRunScrape(batches[i], marketplace, withReviews, taskId, validAsins.length);
        taskId = res.taskId;
        all.push(...res.products);
        setProducts([...all]);
        setProgress(p => ({ ...p, completed: p.completed + batches[i].length }));
      }
      if (taskId) setActiveTaskId(taskId);
    } catch (e: any) {
      setErr(e.message || '采集失败');
    } finally {
      await reloadTasks();
      setRunning(false);
      setProgress({ completed: 0, total: 0, batch: 0, totalBatches: 0 });
    }
  }

  function clearResults() {
    setProducts([]); setAsinInput(''); setActiveTaskId(null); setErr('');
    setPage(1); setSearchQuery(''); setSelectedAsins(new Set());
  }

  async function viewTask(t: ScrapeTask) {
    setActiveTaskId(t.id); setErr(''); setPage(1); setSearchQuery(''); setSelectedAsins(new Set());
    try { setProducts(await apiGetProducts(t.id)); }
    catch (e: any) { setErr(e.message || '加载失败'); setProducts([]); }
  }

  async function removeTask(t: ScrapeTask) {
    if (!confirm(`删除任务（${mkInfo(t.marketplace).flag} ${mkInfo(t.marketplace).name} · ${t.total} 个 ASIN）及其结果？`)) return;
    await apiDeleteTask(t.id);
    setTasks(ts => ts.filter(x => x.id !== t.id));
    if (activeTaskId === t.id) { setProducts([]); setActiveTaskId(null); setSelectedAsins(new Set()); }
  }

  const successCount = products.filter(p => p.status === 'success').length;
  const failedCount  = products.filter(p => p.status === 'failed').length;
  const progressPct  = progress.total > 0 ? Math.round((progress.completed / progress.total) * 100) : 0;

  const filteredProducts = React.useMemo(() => {
    const q = searchQuery.trim().toUpperCase();
    if (!q) return products;
    return products.filter(p => p.asin.includes(q));
  }, [products, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / pageSize));
  React.useEffect(() => { if (page > totalPages) setPage(totalPages); }, [totalPages]);
  React.useEffect(() => { setPage(1); }, [searchQuery, pageSize]);
  const pagedProducts = filteredProducts.slice((page - 1) * pageSize, page * pageSize);

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
          <select className="ps-select" value={marketplace} onChange={e => setMarketplace(e.target.value)} disabled={running || retrying}>
            {MARKETPLACES.map(m => <option key={m.code} value={m.code}>{m.flag} {m.name}</option>)}
          </select>
        </div>

        <div className="ps-field">
          <label className="ps-label">ASIN（每行一个，支持逗号/空格分隔）</label>
          <textarea className="ps-textarea" rows={8} value={asinInput}
            onChange={e => setAsinInput(e.target.value)}
            placeholder={'B0XXXXXXXXX\nB0YYYYYYYYY'} disabled={running || retrying} />
          <div className="ps-asin-count">
            已输入 {asins.length} 个，有效 {validAsins.length} 个
            {asins.length > validAsins.length && <span className="ps-asin-bad"> · {asins.length - validAsins.length} 个无效</span>}
          </div>
        </div>

        <label className="ps-check">
          <input type="checkbox" checked={withReviews} onChange={e => setWithReviews(e.target.checked)} disabled={running || retrying} />
          <span>抓取评论数据（速度较慢）</span>
        </label>

        {err && <div className="ps-err">{err}</div>}

        <div className="ps-actions">
          <button className="btn btn-primary btn-sm" onClick={runScrape} disabled={running || retrying || !validAsins.length}>
            {running ? '采集中…' : '开始采集'}
          </button>
          <button className="btn btn-sm" onClick={clearResults} disabled={running || retrying}>清空</button>
          <button className="btn btn-sm" onClick={handleResetSession} disabled={running || retrying}>刷新会话</button>
        </div>

        {(running || retrying) && progress.total > 0 && (
          <div className="ps-progress">
            <div className="ps-progress-row">
              <span>第 {progress.batch}/{progress.totalBatches} 批</span>
              <span>{progress.completed}/{progress.total}（{progressPct}%）</span>
            </div>
            <div className="ps-progress-bar"><div className="ps-progress-fill" style={{ width: progressPct + '%' }} /></div>
          </div>
        )}

        <div className="ps-history">
          <div className="ps-history-head">历史任务</div>
          {loadErr && <div className="ps-err">{loadErr}</div>}
          {!tasks.length && !loadErr && <div className="ps-empty">暂无历史任务</div>}
          {tasks.map(t => (
            <div key={t.id} className="ps-task" data-active={t.id === activeTaskId}>
              <button className="ps-task-main" onClick={() => viewTask(t)}>
                <div className="ps-task-top">
                  <span>{mkInfo(t.marketplace).flag} {mkInfo(t.marketplace).name}</span>
                  <span className="ps-task-time">{fmtDateTime(t.createdAt)}</span>
                </div>
                <div className="ps-task-sub">
                  <span>共 {t.total}</span>
                  <span className="ps-ok">成功 {t.success}</span>
                  {t.failed > 0 && <span className="ps-fail">失败 {t.failed}</span>}
                  {t.withReviews && <span>含评论</span>}
                </div>
              </button>
              <button className="btn btn-sm ps-del" onClick={() => removeTask(t)}>删除</button>
            </div>
          ))}
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
                <button className="btn btn-sm" onClick={handleRetryFailed} disabled={running || retrying}>
                  {retrying ? '重试中…' : `重试失败 (${failedCount})`}
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
                  <th className="ps-col-asin">ASIN</th>
                  <th className="ps-col-title">标题</th>
                  <th>品牌</th>
                  <th>价格</th>
                  <th>评分</th>
                  <th className="ps-col-cat">分类路径</th>
                  <th>大类排名</th>
                  <th>小类排名</th>
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

