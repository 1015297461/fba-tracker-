"""
Amazon 登录脚本 —— cosmo-diagnose Skill Phase 0 专用
弹出有头浏览器 → 用户手动登录 → 自动检测登录成功 → 保存 storage_state → 关闭浏览器
运行：python3 amz_login.py
输出：data/amz_state.json（供 amz_alexa.py 使用）
"""
import json, time, os, sys
from playwright.sync_api import sync_playwright

BASE = os.path.dirname(os.path.abspath(__file__))
# 按 FBA2 登录用户名分区存储登录态（COSMO_FBA_USER 由 server.py 起子进程时注入）；
# 独立跑该脚本（不经过 FBA2）时退化为 default 子目录。
DATA_DIR = os.path.join(BASE, 'data', os.environ.get('COSMO_FBA_USER', 'default'))
os.makedirs(DATA_DIR, exist_ok=True)
STATE_FILE = os.path.join(DATA_DIR, 'amz_state.json')
TIMEOUT_SECONDS = 300  # 最长等待 5 分钟


def is_logged_in(cookies):
    """检测登录成功的双重信号：at-main 或 sess-at-main Cookie 出现即为登录态"""
    names = {c['name'] for c in cookies}
    return 'at-main' in names or 'sess-at-main' in names


with sync_playwright() as p:
    browser = p.chromium.launch(
        headless=False,
        args=['--start-maximized']
    )
    ctx = browser.new_context(
        viewport={'width': 1280, 'height': 800},
        locale='en-US',
        extra_http_headers={'Accept-Language': 'en-US,en;q=0.9'}
    )
    page = ctx.new_page()

    # 打开美区英文登录页
    page.goto(
        'https://www.amazon.com/ap/signin'
        '?openid.pape.max_auth_age=0'
        '&openid.return_to=https%3A%2F%2Fwww.amazon.com%2F'
        '&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select'
        '&openid.assoc_handle=usflex'
        '&openid.mode=checkid_setup'
        '&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select'
        '&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0',
        wait_until='domcontentloaded'
    )

    print('\n========================================')
    print('✅ 浏览器已弹出，请在浏览器中完成亚马逊登录')
    print('   登录成功后脚本将自动检测并关闭浏览器')
    print('   （最长等待 5 分钟）')
    print('========================================\n')

    # 轮询检测登录成功
    start = time.time()
    logged_in = False
    while time.time() - start < TIMEOUT_SECONDS:
        cookies = ctx.cookies()
        if is_logged_in(cookies):
            logged_in = True
            break
        time.sleep(2)

    if not logged_in:
        print('❌ 登录超时（5 分钟），请重新运行脚本')
        browser.close()
        sys.exit(1)

    # 多等 1 秒让 Amazon 完成所有 Cookie 写入
    time.sleep(1)

    # 用 storage_state 保存完整登录态（含 cookies + localStorage）
    ctx.storage_state(path=STATE_FILE)

    # 取用户名用于提示
    try:
        nav = page.query_selector('#nav-link-accountList-nav-line-1')
        username = nav.inner_text().replace('Hello, ', '').strip() if nav else '用户'
    except Exception:
        username = '用户'

    cookie_count = len(ctx.cookies())
    browser.close()

    print(f'✅ 登录成功（{username}），已保存 {cookie_count} 条 Cookie')
    print(f'   状态文件：{STATE_FILE}')
    print('   浏览器已自动关闭，可运行 amz_alexa.py 开始反查')
