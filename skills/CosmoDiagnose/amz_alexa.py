"""
Amazon Alexa 深度反查脚本 —— cosmo-diagnose Skill Phase 1.2 专用
前置：先运行 amz_login.py 生成 data/amz_state.json
运行：python3 amz_alexa.py <ASIN> [问题数量，默认10]
输出：data/{ASIN}_alexa_qa.json
"""
import json, time, sys, os
from playwright.sync_api import sync_playwright

if len(sys.argv) < 2:
    print('用法：python3 amz_alexa.py <ASIN> [问题数量]')
    sys.exit(1)
ASIN = sys.argv[1]
NUM_QUESTIONS = int(sys.argv[2]) if len(sys.argv) > 2 else 10
BASE = os.path.dirname(os.path.abspath(__file__))
# 按 FBA2 登录用户名分区存储登录态（COSMO_FBA_USER 由 server.py 起子进程时注入）；
# 独立跑该脚本（不经过 FBA2）时退化为 default 子目录。
DATA_DIR = os.path.join(BASE, 'data', os.environ.get('COSMO_FBA_USER', 'default'))
os.makedirs(DATA_DIR, exist_ok=True)
STATE_FILE = os.path.join(DATA_DIR, 'amz_state.json')
OUTPUT_FILE = os.path.join(DATA_DIR, f'{ASIN}_alexa_qa.json')

QUESTIONS = [
    "Who is this product for? Describe the typical buyer persona.",
    "What are the top 3 pros and top 3 cons based on customer reviews?",
    "What are the most common questions buyers ask before purchasing this product?",
    "What are the top reasons customers return or complain about this product?",
    "How does this product compare to the best-selling alternative in the same category?",
    "What specific features do buyers mention most positively?",
    "Is there any safety concern or common defect mentioned by buyers?",
    "What room or space is this product best suited for?",
    "What do buyers say about the battery life or runtime of this product?",
    "What do buyers compare this product to when they describe it?",
]

ANSWER_MARKERS = [
    "I've looked", "I covered", "Here's", "Here is", "Based on", "Sure", "Great question",
    "Yes,", "No,", "Absolutely", "According", "Customers", "Buyers",
    "This product", "This ", "Looking at", "Top 3", "Top 3 Pros",
]


# ─── Cookie 有效性检查 ───────────────────────────────────────────────────────

def check_state_validity(state_file):
    """
    检查 amz_state.json 的有效性：
    - missing：文件不存在
    - expired：at-main Cookie 已过期
    - expiring_soon：7 天内到期（警告但继续）
    - valid：正常
    """
    if not os.path.exists(state_file):
        return 'missing'
    try:
        with open(state_file) as f:
            state = json.load(f)
        cookies = state.get('cookies', [])
        at_main = next((c for c in cookies if c['name'] == 'at-main'), None)
        if not at_main:
            return 'missing'
        expires = at_main.get('expires', 0)
        if expires <= 0:
            return 'valid'  # session cookie（无绝对过期时间），视为有效
        remaining = expires - time.time()
        if remaining < 0:
            return 'expired'
        if remaining < 7 * 86400:
            return 'expiring_soon'
        return 'valid'
    except Exception:
        return 'missing'


# ─── Alexa 交互核心 ──────────────────────────────────────────────────────────

def extract_answer(page):
    """精准提取 Alexa 回答：截断到 See more / Don't see 之前，剥离开头推荐 chip"""
    return page.evaluate('''(markers) => {
        const input = document.querySelector('input[placeholder*="Ask"]');
        if (!input) return null;
        let container = input.parentElement;
        for (let i = 0; i < 5; i++) {
            if (!container) break;
            if ((container.innerText || '').trim().length > 200) break;
            container = container.parentElement;
        }
        if (!container) return null;

        const clone = container.cloneNode(true);
        clone.querySelectorAll('input,textarea,script,style,svg,img,button').forEach(el => el.remove());
        let full = (clone.innerText || '').trim();

        // 截断结尾（重复内容 / 客户评论从这里开始）
        for (const cut of ['... See more', "Don't see what you're looking for?", 'Sorry, something went wrong']) {
            const idx = full.indexOf(cut);
            if (idx > 0) full = full.slice(0, idx);
        }

        // 剥离开头的推荐问题 chip，定位到第一个回答标记
        let startIdx = -1;
        for (const m of markers) {
            const i = full.indexOf(m);
            if (i >= 0 && (startIdx < 0 || i < startIdx)) startIdx = i;
        }
        if (startIdx > 0) full = full.slice(startIdx);

        return full.trim();
    }''', ANSWER_MARKERS)


def ask_one(page, alexa_input, question, timeout=45):
    """提交单个问题，等流式生成完成后返回完整回答"""
    alexa_input.scroll_into_view_if_needed()
    time.sleep(0.4)
    alexa_input.click()
    time.sleep(0.2)
    alexa_input.fill('')
    alexa_input.fill(question)
    time.sleep(0.2)
    alexa_input.press('Enter')

    start = time.time()
    prev = ''
    stable = 0

    while time.time() - start < timeout:
        alexa_input.scroll_into_view_if_needed()
        # 展开 See more 获取完整回答
        try:
            sm = page.query_selector('text="See more"')
            if sm and sm.is_visible():
                sm.click()
                time.sleep(1)
        except Exception:
            pass

        ans = extract_answer(page) or ''
        has_content = any(m in ans for m in ANSWER_MARKERS)
        if has_content and len(ans) > 100:
            if ans == prev:
                stable += 1
                if stable >= 2:
                    return ans
            else:
                stable = 0
            prev = ans
        time.sleep(1)

    # 超时：返回当前已有内容（如有）
    return prev if len(prev) > 100 else None


# ─── 主流程 ──────────────────────────────────────────────────────────────────

def main():
    # 前置：检查登录态
    status = check_state_validity(STATE_FILE)
    if status == 'missing':
        print('⚠️ 未找到登录状态，请先运行 amz_login.py 完成登录')
        sys.exit(1)
    if status == 'expired':
        print('⚠️ 登录已过期，请重新运行 amz_login.py 登录')
        sys.exit(1)
    if status == 'expiring_soon':
        print('⚠️ 登录将在 7 天内过期，建议近期重新运行 amz_login.py 刷新')

    with sync_playwright() as p:
        print(f'[1/4] 启动无头浏览器，加载登录状态...')
        browser = p.chromium.launch(
            headless=True,
            args=['--no-sandbox', '--disable-blink-features=AutomationControlled']
        )
        ctx = browser.new_context(
            storage_state=STATE_FILE,
            viewport={'width': 1280, 'height': 900},
            locale='en-US',
            extra_http_headers={'Accept-Language': 'en-US,en;q=0.9'},
            user_agent='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                       'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        )
        page = ctx.new_page()
        page.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined});")

        print(f'[2/4] 打开产品页 {ASIN}...')
        page.goto(f'https://www.amazon.com/dp/{ASIN}?language=en_US&th=1',
                  wait_until='domcontentloaded', timeout=30000)

        nav = page.query_selector('#nav-link-accountList-nav-line-1')
        login_text = nav.inner_text() if nav else 'unknown'
        print(f'    登录状态: {login_text}')
        if 'sign in' in login_text.lower():
            print('⚠️ 登录已过期，请重新运行 amz_login.py')
            browser.close()
            sys.exit(1)

        print('[3/4] 滚动触发 Alexa 懒加载...')
        for pos in [1000, 2000, 3000, 4000, 5000, 6000]:
            page.evaluate(f'window.scrollTo(0,{pos})')
            time.sleep(0.4)
        time.sleep(2)

        alexa_input = page.query_selector('input[placeholder*="Ask"]')
        if not alexa_input:
            print(f'⚠️ 该 ASIN（{ASIN}）未提供 Alexa 问答面板，跳过本步骤')
            browser.close()
            sys.exit(0)
        print('    ✅ 找到 Alexa 输入框')

        questions = QUESTIONS[:NUM_QUESTIONS]
        print(f'[4/4] 开始逐条提问（共 {len(questions)} 个问题）...\n')
        results = []
        for i, q in enumerate(questions, 1):
            print(f'  Q{i}: {q[:55]}...')
            try:
                ans = ask_one(page, alexa_input, q)
                if ans:
                    print(f'  A{i} ({len(ans)}字): {ans[:65]}...\n')
                    results.append({'q': q, 'a': ans, 'status': 'ok'})
                else:
                    print(f'  ⚠️ Q{i} Alexa 响应超时，已记录 N/A\n')
                    results.append({'q': q, 'a': None, 'status': 'timeout'})
                time.sleep(1)
                alexa_input = page.query_selector('input[placeholder*="Ask"]') or alexa_input
            except Exception as e:
                print(f'  ⚠️ Q{i} 出错，已记录 N/A：{e}\n')
                results.append({'q': q, 'a': None, 'status': f'error: {e}'})

        with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
            json.dump({'asin': ASIN, 'source': 'Amazon Alexa', 'results': results},
                      f, ensure_ascii=False, indent=2)

        ok = sum(1 for r in results if r['status'] == 'ok')
        print(f'✅ 完成！成功 {ok}/{len(questions)} 条 → {OUTPUT_FILE}')
        browser.close()


if __name__ == '__main__':
    main()
