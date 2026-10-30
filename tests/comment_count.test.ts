import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const source = fs.readFileSync(new URL('../internal/assets/inject/api_client.js', import.meta.url), 'utf8');
const clientSource = source.slice(0, source.indexOf('// 自动初始化')) + source.slice(source.indexOf('window.__wx_selectors__ ='));

function loadedFlow(commentCount: unknown, workId = 'work-a') {
    return {
        commentCount, feed: { id: workId, commentCount },
        dataList: { fetching: false, noMore: commentCount === 0, items: commentCount === 0 ? [] : [{ commentId: 'first' }] },
    };
}

function fixture(stores: Map<string, unknown>, onWait = () => {}, workId = 'work-a') {
    let attempts = 0, refreshes = 0, opens = 0, scrolls = 0;
    let running = false;
    const dom = new JSDOM('<div id="app" data-v-app></div>', { url: 'https://channels.weixin.qq.com/web/pages/feed?oid=test' });
    const { window } = dom;
    window.__wx_channels_store__ = { profile: { id: workId } };
    window.scrollBy = () => { scrolls++; };
    window.__try_open_feed_comment_panel = () => { opens++; return true; };
    window.document.getElementById('app').__vueParentComponent = { appContext: {
        config: { globalProperties: { $pinia: { _s: stores } } },
    } };
    vm.runInNewContext(clientSource, {
        window, document: window.document,
        console: {
            log(message: string) {
                if (/get_comment_count 第\d+次尝试$/.test(message)) attempts++;
            },
            warn() {}, error() {},
        },
        setTimeout(fn: () => void) { if (running && attempts > 0) onWait(); fn(); return 0; },
        clearTimeout() {},
    });
    // 脚本会初始化解析器，加载后再安装计数，才能捕获真实的全页解析调用。
    window.__wx_parsers__.refreshAllDom = () => { refreshes++; };
    return {
        run: (binding = {}) => {
            running = true;
            return window.__wx_api_client.executeDomAction({ action: 'get_comment_count', ...binding }, 'count-test');
        },
        window,
        get opens() { return opens; },
        get attempts() { return attempts; },
        get refreshes() { return refreshes; },
        get scrolls() { return scrolls; },
        close: () => dom.window.close(),
    };
}

for (const value of [undefined, null, '', ' ', false, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 'invalid']) {
    test(`未就绪或非法评论总数不能当作零：${String(value)}`, async () => {
        const f = fixture(new Map([['feed', { home: { flowCommentList: loadedFlow(value) } }]]));
        try {
            assert.equal((await f.run()).success, false);
            assert.equal(f.attempts, 3, '缺失或非法值只允许有限重试');
        } finally { f.close(); }
    });
}

test('Pinia 已存在但没有评论 Store 时明确失败', async () => {
    const f = fixture(new Map());
    try { assert.equal((await f.run()).success, false); } finally { f.close(); }
});

for (const shape of ['direct', 'state', 'home', 'state-home', 'aliased'] as const) {
    test(`评论 Store 结构兼容且重复引用不算多个候选：${shape}`, async () => {
        const flow = loadedFlow(202);
        const store = shape === 'direct' ? { flowCommentList: flow }
            : shape === 'state' ? { $state: { flowCommentList: flow } }
            : shape === 'home' ? { home: { flowCommentList: flow } }
            : shape === 'state-home' ? { $state: { home: { flowCommentList: flow } } }
            : { flowCommentList: flow, $state: { flowCommentList: flow }, home: { flowCommentList: flow } };
        const f = fixture(new Map([['feed', store]]));
        try {
            const result = await f.run();
            assert.equal(result.success, true);
            assert.equal(result.ready, true);
            assert.equal(result.count, 202);
            assert.equal(result.page_instance_id, f.window.__wx_api_client.commentPageInstance());
            assert.equal(f.attempts, 1);
            assert.equal(f.refreshes, 0);
            assert.equal(f.scrolls, 0);
        } finally { f.close(); }
    });
}

for (const mode of ['url', 'instance', 'work'] as const) {
    test(`绑定身份与当前页面不符时不能回显请求参数冒充校验：${mode}`, async () => {
        const f = fixture(new Map([['feed', { flowCommentList: loadedFlow(202) }]]));
        try {
            const binding = mode === 'url' ? { url: 'https://channels.weixin.qq.com/web/pages/feed?oid=other' }
                : mode === 'instance' ? { page_instance_id: 'other-page' } : { work_id: 'other-work' };
            const result = await f.run(binding);
            assert.equal(result.success, false);
            assert.equal(result.ready, false);
            assert.equal(result.count, undefined);
            assert.equal(result.reason, mode === 'work' ? 'work_mismatch' : 'page_changed');
            assert.equal(result.page_instance_id, f.window.__wx_api_client.commentPageInstance());
            assert.equal(result.work_id, 'work-a');
            assert.equal(f.attempts, 1);
            assert.equal(f.opens, 0);
            assert.equal(f.scrolls, 0);
        } finally { f.close(); }
    });
}

for (const mode of ['url', 'instance'] as const) {
    test(`等待期间页面变化立即停止，不接收迟到数量：${mode}`, async () => {
        const flow = loadedFlow(undefined);
        const f = fixture(new Map([['feed', { flowCommentList: flow }]]), () => {
            if (mode === 'url') f.window.history.replaceState({}, '', '?oid=other');
            else f.window.__sph_page_instance = 'replacement-page';
            Object.assign(flow, loadedFlow(999));
        });
        try {
            const result = await f.run();
            assert.equal(result.success, false);
            assert.equal(result.ready, false);
            assert.equal(result.reason, 'page_changed');
            assert.equal(result.count, undefined);
            assert.equal(f.attempts, 2);
        } finally { f.close(); }
    });
}

test('Pinia 未就绪时保留明确原因和身份，不返回伪造的零值', async () => {
    const f = fixture(new Map());
    delete f.window.document.getElementById('app').__vueParentComponent;
    try {
        const result = await f.run();
        assert.equal(result.success, false);
        assert.equal(result.ready, false);
        assert.equal(result.reason, 'pinia_not_ready');
        assert.equal(result.work_id, 'work-a');
        assert.ok(result.page_instance_id);
        assert.equal(result.count, undefined);
        assert.equal(f.attempts, 3);
        assert.equal(f.refreshes, 0);
        assert.equal(f.scrolls, 0);
    } finally { f.close(); }
});

test('页面作品信息仍显示非零时，评论 Store 的零值不能覆盖基线', async () => {
    const f = fixture(new Map([['feed', { flowCommentList: loadedFlow(0) }]]));
    f.window.__wx_channels_store__.profile.commentCount = 202;
    try {
        const result = await f.run();
        assert.equal(result.success, false);
        assert.equal(result.ready, false);
        assert.equal(result.reason, 'count_not_ready');
        assert.equal(result.count, undefined);
        assert.equal(f.attempts, 3);
    } finally { f.close(); }
});

for (const value of [0, 202, '202']) {
    test(`有效评论总数正常返回：${String(value)}`, async () => {
        const f = fixture(new Map([['feed', { home: { flowCommentList: loadedFlow(value) } }]]));
        try {
            const result = await f.run();
            assert.equal(result.success, true);
            assert.equal(result.count, Number(value));
            assert.equal(f.refreshes, 0, '评论总数只读 Store，不应触发全页 DOM 解析');
            assert.equal(f.opens, 0, '总数已就绪时不再打开评论面板');
        } finally { f.close(); }
    });
}

test('总数字段延迟出现时有限重试后取得真实值', async () => {
    const flow = loadedFlow(undefined);
    let waits = 0;
    const f = fixture(new Map([['feed', { home: { flowCommentList: flow } }]]), () => {
        if (++waits === 2) flow.commentCount = 202;
    });
    try {
        const result = await f.run();
        assert.equal(result.success, true);
        assert.equal(result.count, 202);
        assert.equal(f.attempts, 3);
    } finally { f.close(); }
});

test('评论区总数返回就绪、作品、页面实例和来源，不能只返回两个字段', async () => {
    const f = fixture(new Map([['feed', { home: { feed: { id: 'work-a' }, flowCommentList: loadedFlow(202) } }]]));
    try {
        const result = await f.run();
        assert.equal(result.success, true);
        assert.equal(result.ready, true);
        assert.equal(result.work_id, 'work-a');
        assert.ok(result.page_instance_id);
        assert.equal(result.source, 'comment_panel');
        assert.equal(result.count, 202);
    } finally { f.close(); }
});

for (const mode of ['missing-work', 'stale-store', 'ambiguous-store'] as const) {
    test(`不能把未确认作品的评论总数当作有效基线：${mode}`, async () => {
        const stores = new Map<string, unknown>([['feed', { home: {
            feed: { id: mode === 'stale-store' ? 'other-work' : 'work-a' },
            flowCommentList: loadedFlow(202),
        } }]]);
        if (mode === 'ambiguous-store') stores.set('old', { home: { flowCommentList: loadedFlow(999) } });
        const f = fixture(stores, () => {}, mode === 'missing-work' ? '' : 'work-a');
        try {
            const result = await f.run();
            assert.equal(result.success, false);
            assert.equal(result.ready, false);
            assert.equal(result.count, undefined);
        } finally { f.close(); }
    });
}

for (const mode of ['fetching-zero', 'fetching-positive', 'initial-zero', 'initial-positive', 'missing-loading', 'missing-list', 'zero-with-items', 'zero-with-positive-feed', 'wrong-flow-feed', 'missing-flow-feed'] as const) {
    test(`初始化或归属不明的总数不得覆盖基线：${mode}`, async () => {
        const flow: any = loadedFlow(0);
        if (mode === 'fetching-zero' || mode === 'fetching-positive') flow.dataList.fetching = true;
        if (mode === 'fetching-positive') flow.commentCount = 7394;
        if (mode === 'initial-zero') { flow.dataList.noMore = false; flow.dataList.fetchCount = 0; }
        if (mode === 'initial-positive') { flow.commentCount = 7394; flow.dataList.noMore = false; }
        if (mode === 'missing-loading') delete flow.dataList.fetching;
        if (mode === 'missing-list') delete flow.dataList;
        if (mode === 'zero-with-items') flow.dataList.items.push({ commentId: 'existing' });
        if (mode === 'zero-with-positive-feed') flow.feed.commentCount = 7394;
        if (mode === 'wrong-flow-feed') flow.feed.id = 'work-b';
        if (mode === 'missing-flow-feed') delete flow.feed;
        const f = fixture(new Map([['feed', { home: { feed: { id: 'work-a' }, flowCommentList: flow } }]]));
        try {
            const result = await f.run();
            assert.equal(result.success, false);
            assert.equal(result.ready, false);
            assert.equal(result.count, undefined);
            assert.equal(f.attempts, 3);
            assert.equal(f.refreshes, 0);
            assert.ok(f.opens <= 1, '单次探查最多尝试打开一次，不启动滚动');
        } finally { f.close(); }
    });
}

for (const count of [0, 7394]) {
    test(`首批请求完成后重读取真实总数：${count}`, async () => {
        const flow = loadedFlow(0);
        flow.dataList.fetching = true;
        flow.dataList.noMore = false;
        const f = fixture(new Map([['feed', { flowCommentList: flow }]]), () => {
            Object.assign(flow, loadedFlow(count));
        });
        try {
            const result = await f.run();
            assert.equal(result.success, true);
            assert.equal(result.count, count);
            assert.equal(f.attempts, 2, '必须等待首批请求，不可直接返回初始化零值');
            assert.equal(f.opens, 1);
        } finally { f.close(); }
    });
}

test('存在旧作品 Store 时只采用当前评论 Store 自身的总数', async () => {
    const f = fixture(new Map([
        ['old', { flowCommentList: loadedFlow(999, 'work-b') }],
        ['current', { flowCommentList: loadedFlow(202) }],
    ]));
    try {
        const result = await f.run();
        assert.equal(result.success, true);
        assert.equal(result.count, 202);
    } finally { f.close(); }
});

test('等待首批请求期间切换作品，停止读取且不采用新作品总数', async () => {
    const flow = loadedFlow(0);
    flow.dataList.fetching = true;
    const f = fixture(new Map([['feed', { flowCommentList: flow }]]), () => {
        f.window.__wx_channels_store__.profile.id = 'work-b';
        Object.assign(flow, loadedFlow(999, 'work-b'));
    });
    try {
        const result = await f.run();
        assert.equal(result.success, false);
        assert.equal(result.reason, 'work_mismatch');
        assert.equal(f.attempts, 2);
    } finally { f.close(); }
});
