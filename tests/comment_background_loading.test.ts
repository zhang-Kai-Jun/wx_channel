import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../internal/handlers/script.go', import.meta.url), 'utf8');
function injected(name: string) {
    const start = source.indexOf(`func (h *ScriptHandler) ${name}() string {`);
    assert.ok(start >= 0);
    return source.slice(start).split('<script>')[1].split('</script>')[0];
}

function fixture(readyState = 'complete') {
    let now = 0, nextTimer = 0, loads = 0, subscriptions = 0;
    const timers = new Map<number, { at: number; repeat: number; callback: () => void }>();
    const events = new Map<string, () => void>();
    const items = [{ commentId: 'first', levelTwoComment: [] }];
    const store = {
        home: { feed: { awemeId: 'video-a' }, flowCommentList: {
            commentCount: 10, dataList: { items, buffers: { nextBuffer: 'next' } },
        } },
        $subscribe() { subscriptions++; return () => {}; },
        loadMoreComment() {
            loads++;
            if (loads === 1) items.push({ commentId: 'second', levelTwoComment: [] });
        },
    };
    const app = { __vueParentComponent: { appContext: { config: {
        globalProperties: { $pinia: { _s: new Map([['feed', store]]) } },
    } } } };
    const window: any = {
        location: { href: 'https://channels.weixin.qq.com/web/pages/feed', pathname: '/web/pages/feed' },
        __wx_channels_store__: { profile: { id: 'video-a' } },
        addEventListener(name: string, callback: () => void) { events.set(name, callback); },
        scrollTo() {},
    };
    const panel = { offsetParent: {}, scrollHeight: 500, clientHeight: 200, scrollTop: 0 };
    const document = {
        readyState,
        body: { scrollHeight: 500 },
        querySelector(selector: string) {
            if (selector === '[data-v-app]') return app;
            if (selector.includes('loading-icon')) return null;
            return panel;
        },
        querySelectorAll(selector: string) {
            return selector === '.comment-list' ? [panel] : [];
        },
        getElementById() { return app; },
    };
    function schedule(callback: () => void, delay: number, repeat = 0) {
        const id = ++nextTimer;
        timers.set(id, { at: now + delay, repeat, callback });
        return id;
    }
    const context = vm.createContext({
        window, document, console: { log() {}, warn() {}, error() {} },
        Date: class extends Date { static now() { return now; } },
        setTimeout: (callback: () => void, delay: number) => schedule(callback, delay),
        setInterval: (callback: () => void, delay: number) => schedule(callback, delay, delay),
        clearTimeout: (id: number) => timers.delete(id),
        clearInterval: (id: number) => timers.delete(id),
    });
    vm.runInContext(injected('getCommentCaptureScript'), context);
    vm.runInContext(injected('getFetchVideoCommentsScript'), context);
    return {
        window, timers, items, store,
        get loads() { return loads; },
        get subscriptions() { return subscriptions; },
        loaded() { events.get('load')?.(); },
        async advance(ms: number) {
            const end = now + ms;
            for (;;) {
                const entry = [...timers].filter(([, timer]) => timer.at <= end)
                    .sort((a, b) => a[1].at - b[1].at)[0];
                if (!entry) break;
                const [id, timer] = entry;
                now = timer.at;
                if (timer.repeat) timer.at += timer.repeat;
                else timers.delete(id);
                timer.callback();
                await Promise.resolve();
            }
            now = end;
            await Promise.resolve();
        },
    };
}

for (const state of ['complete', 'loading']) {
    test(`页面 ${state}：没有任务时不订阅 Store 或自动加载评论`, async () => {
        const f = fixture(state);
        f.loaded();
        await f.advance(6000);
        assert.equal(f.subscriptions, 0, '后台不应全量订阅、统计和格式化评论');
        assert.equal(f.loads, 0, '后台不应与任务重复加载');
        assert.equal(f.timers.size, 0, '后台不应留下加载或初始化定时器');
    });
}

test('显式批次仍能加载新评论，批次间等待不触发后台加载', async () => {
    const f = fixture();
    const pending = f.window.__sph_fetch_video_comments({ collection_id: 'collection' });
    await Promise.resolve();
    await f.advance(300);
    const result = await pending;
    assert.deepEqual(Array.from(result.raw_items, (item: any) => item.commentId), ['first', 'second']);
    assert.equal(f.loads, 1);
    await f.advance(6000);
    assert.equal(f.loads, 1);
    assert.equal(f.subscriptions, 0);
    assert.equal(f.timers.size, 0);
});

test('显式快照采集保留自身加载循环，停止后无后台加载', async () => {
    const f = fixture();
    const task: any = { stopped: false, timers: [], url: f.window.location.href,
        finish() { this.stopped = true; } };
    f.window.__wx_channels_start_comment_collection(task);
    const firstLoads = f.loads;
    await f.advance(3000);
    assert.ok(f.loads > firstLoads, '快照仍需由自身循环继续加载');
    task.stopped = true;
    for (const id of task.timers) f.timers.delete(id);
    f.window.__stop_feed_comment_collection();
    const stoppedLoads = f.loads;
    await f.advance(6000);
    assert.equal(f.loads, stoppedLoads);
    assert.equal(f.subscriptions, 0);
    assert.equal(f.timers.size, 0);
});
