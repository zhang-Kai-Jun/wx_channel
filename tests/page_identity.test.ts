import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const source = fs.readFileSync(new URL('../internal/assets/inject/api_client.js', import.meta.url), 'utf8');
const clientSource = source.slice(0, source.indexOf('// 自动初始化')) + source.slice(source.indexOf('window.__wx_selectors__ ='));
const url = 'https://channels.weixin.qq.com/web/pages/feed?oid=A';
const binding = { page_instance_id: 'doc-A', url, work_id: 'work-A' };
const form = '<button aria-label="评论，1"></button><div class="input-box"><textarea class="weui-textarea"></textarea><button aria-label="发送" role="button">发送</button></div>';

function fixture(html = '', onWait = (_window: any, _ms: number) => {}) {
    const dom = new JSDOM(html, { url });
    const { window } = dom;
    window.scrollBy = () => {};
    window.__sph_page_instance = 'doc-A';
    window.__wx_channels_store__ = { profile: { id: 'work-A' } };
    window.WXU = { API: {}, API2: {} };
    window.HTMLElement.prototype.getClientRects = () => [{ width: 10, height: 10 }];
    vm.runInNewContext(clientSource, {
        window, document: window.document, URL,
        Event: window.Event, InputEvent: window.InputEvent, MouseEvent: window.MouseEvent,
        HTMLTextAreaElement: window.HTMLTextAreaElement,
        console: { log() {}, warn() {}, error() {} },
        fetch: async () => ({}),
        setTimeout(fn: () => void, ms: number) { onWait(window, ms); fn(); return 0; },
        clearTimeout() {},
    });
    return { window, close: () => window.close(), run: (action: string, fields = {}) =>
        window.__wx_api_client.executeDomAction({ action, content: 'test', ...binding, ...fields }, 'request-A') };
}

function changeWork(window: any) {
    window.history.replaceState({}, '', '/web/pages/feed?oid=B');
    window.__wx_channels_store__.profile.id = 'work-B';
}

test('WXU 初始化等待后重新验证身份，不能派发到跳转后的作品', async () => {
    const f = fixture('', window => { changeWork(window); window.WXU = { API: {}, API2: {} }; });
    let executions = 0, response: any;
    try {
        f.window.WXU = null;
        f.window.__wx_api_client.executeDomAction = async () => { executions++; return { success: true }; };
        f.window.__wx_api_client.sendResponse = (_id: string, result: any) => { response = result; };
        await f.window.__wx_api_client.handleAPICall({ id: 'request-A', key: 'key:channels:dom_action', body: { action: 'do_like', ...binding } });
        assert.equal(executions, 0);
        assert.equal(response.success, false);
        assert.equal(response.retryable, false);
    } finally { f.close(); }
});

for (const action of ['do_like', 'do_follow', 'do_follow_on_profile']) {
    test(`${action} 重试等待期间页面变化后不点击`, async () => {
        let changed = false, clicks = 0;
        const f = fixture('<div class="bottom-area"><button class="follow-btn">关注</button></div><div class="opr-area"><button>关注</button></div><button aria-label="喜欢"></button>', window => {
            if (!changed) { changed = true; changeWork(window); }
        });
        try {
            f.window.__wx_parsers__.isLiked = () => false;
            f.window.__wx_parsers__.getUnlikeBtn = () => f.window.document.querySelector('button');
            f.window.__wx_parsers__.isFollowed = () => false;
            f.window.document.querySelectorAll('button').forEach((button: any) => { button.innerText = '关注'; button.onclick = () => clicks++; });
            const result = await f.run(action);
            assert.equal(result.success, false);
            assert.equal(result.retryable, false);
            assert.equal(clicks, 0);
        } finally { f.close(); }
    });
}

for (const afterSend of [false, true]) {
    test(`评论${afterSend ? '发送后' : '填写后发送前'}跳页，不重复发送`, async () => {
        let sends = 0, changed = false;
        const f = fixture(form, (window, ms) => {
            const typed = window.document.querySelector('textarea').value === 'test';
            if (!changed && (afterSend ? sends > 0 : typed && ms === 800)) { changed = true; changeWork(window); }
        });
        try {
            f.window.document.querySelector('[aria-label="发送"]').onclick = () => sends++;
            const result = await f.run('do_comment');
            assert.equal(result.success, false);
            assert.equal(sends, afterSend ? 1 : 0);
            if (afterSend) assert.equal(result.resultUnknown, true);
            else assert.equal(result.retryable, false);
        } finally { f.close(); }
    });
}

for (const text of ['关注', '已关注', '互相关注']) {
    test(`主页状态查询复用主页按钮：${text}`, async () => {
        const f = fixture('<div class="opr-area"><button></button></div>');
        let clicks = 0;
        try {
            const button = f.window.document.querySelector('button');
            button.innerText = text;
            button.onclick = () => clicks++;
            const result = await f.run('get_profile_status');
            assert.equal(result.success, true);
            assert.equal(result.isFollowed, text !== '关注');
            assert.equal(clicks, 0);
        } finally { f.close(); }
    });
}
