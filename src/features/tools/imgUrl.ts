/**
 * 亚马逊商品图片 CDN 的尺寸改写与预加载。
 *
 * 实测（2026-11-11，同一张图不同后缀）：
 *   _AC_SL1500_ → 898×1500 / 87 KB
 *   _AC_SL1200_ → 719×1200 / 62 KB
 *   _AC_SL800_  → 479×800  / 33 KB
 *   _AC_SL300_  → 180×300  / 7.9 KB
 * 后缀里的数字就是真实输出的最长边像素，不是同一张图加参数。
 * 所以缩略图降档只是少下像素、不影响观感；放大时才需要 SL1500。
 */
export type ImgSize = 200 | 300 | 500 | 800 | 1200 | 1500;

const AMAZON_IMG_HOST = /(?:media-amazon|images-amazon|ssl-images-amazon)\.com/i;
// 只认 `._任意前缀_SL<数字>_.jpg` 这一种；`_AC_UL300_SR300,200_` 等没有 SL 的格式原样返回
const SL_SUFFIX = /SL\d+_\.(?:jpe?g|png|webp)/i;

export function imgUrl(src: string | null | undefined, size: ImgSize = 1200): string {
  if (!src) return '';
  if (!/^https?:\/\//i.test(src) || !AMAZON_IMG_HOST.test(src) || !SL_SUFFIX.test(src)) {
    return src;                     // 本地/代理 URL、或格式不认识 → 绝不瞎改，避免 404
  }
  return src.replace(SL_SUFFIX, m => m.replace(/SL\d+_/i, `SL${size}_`));
}

const _preloaded = new Set<string>();

/** 用 new Image() 后台预热；去重、限量，不阻塞 UI。 */
export function preloadImages(urls: (string | null | undefined)[], limit = 8): void {
  let n = 0;
  for (const u of urls) {
    if (!u || n >= limit || _preloaded.has(u)) continue;
    _preloaded.add(u);
    n++;
    const im = new Image();
    im.decoding = 'async';
    im.src = u;
  }
}
