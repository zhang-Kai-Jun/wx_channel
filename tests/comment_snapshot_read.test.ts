import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';

const api = fs.readFileSync(new URL('../internal/assets/inject/api_client.js', import.meta.url), 'utf8');
const clientSource = api.slice(0, api.indexOf('// 自动初始化')) + api.slice(api.indexOf('window.__wx_selectors__ ='));
const script = fs.readFileSync(new URL('../internal/handlers/script.go', import.meta.url), 'utf8');
const helpers = script.slice(script.indexOf('function findFlowCommentListInStores()'), script.indexOf('\n\t// 格式化评论数据'));

function fixture() {
    const dom = new JSDOM('<div id="app" data-v-app></div>', { url: 'https://channels.weixin.qq.com/web/pages/feed?oid=a' });
    const window: any = dom.window;
    const feed = { id: 'work-a', objectDesc: { description: '作品标题', topicList: [{ topicName: '话题' }] }, contact: { nickname: '作者' } };
    const flow: any = { feed, commentCount: 10, dataList: { items: [], fetching: false } };
    const stores = new Map([['home', { flowCommentList: flow }]]);
    const app: any = window.document.getElementById('app');
    app.__vueParentComponent = { appContext: { config: { globalProperties: { $pinia: { _s: stores } } } } };
    window.__wx_channels_store__ = { profile: feed };
    window.WXU = { API: {}, API2: {} };
    let starts = 0, loads = 0;
    window.__start_feed_comment_collection_with_open_panel = () => { starts++; };
    window.__sph_tryTriggerStoreLoadMore = window.__sph_scrollCommentList = window.__sph_expandSecondaryComments = () => { loads++; };
    const sandbox = vm.createContext({ window, document: window.document, navigator: window.navigator,
        console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, clearInterval,
        fetch: async () => ({}) });
    vm.runInContext(clientSource, sandbox);
    vm.runInContext(helpers, sandbox);
    window.__sph_findFlowCommentListInStores = sandbox.findFlowCommentListInStores;
    window.__sph_extractStoreComments = sandbox.extractStoreComments;
    const client = window.__wx_api_client;
    const replies: any[] = [];
    client.sendResponse = (_id: string, data: any) => { replies.push(data); };
    const binding = { collection_id: 'collection', page_instance_id: client.commentPageInstance(), url: window.location.href };
    client.startCommentSnapshot({ ...binding, task_id: 'snapshot' });
    return { window, client, flow, stores, binding, replies,
        read: (id = 'snapshot_read_0', extra = {}) => client.readCommentSnapshot({ ...binding, task_id: id, ...extra }),
        get starts() { return starts; }, get loads() { return loads; }, close: () => dom.window.close() };
}

test('真实 API 分发返回只读评论批次，包含一级、二级评论及作品信息', async () => {
    const f = fixture();
    try {
        f.flow.dataList.items.push({ commentId: 'a', content: '一级', levelTwoComment: [{ commentId: 'b', content: '回复' }] });
        await f.client.handleAPICall({ id: 'request', key: 'key:channels:dom_action', body: {
            ...f.binding, action: 'read_comment_snapshot', task_id: 'snapshot_read_0' } });
        const result = f.replies[0];
        assert.equal(result.success, true, result.message);
        assert.deepEqual(Array.from(result.raw_items, (item: any) => [item.commentId, item.level, item.parentCommentId]),
            [['a', 'level1', ''], ['b', 'level2', 'a']]);
        assert.equal(result.raw_items[0].levelTwoComment, undefined);
        assert.equal(result.video_info.title, '作品标题');
        assert.equal(result.video_info.author_name, '作者');
        assert.equal(result.video_info.topics, '话题');
        assert.equal(f.starts, 1);
        assert.equal(f.loads, 0);
    } finally { f.close(); }
});

test('批次冻结并按编号重放，新编号返回后到回复且不重复已交付评论', () => {
    const f = fixture();
    try {
        const item = { commentId: 'a', authorContact: { nickname: '原昵称' }, levelTwoComment: [{ commentId: 'b' }] };
        f.flow.dataList.items.push(item);
        const first = f.read();
        item.authorContact.nickname = '已修改';
        item.levelTwoComment.push({ commentId: 'c' });
        assert.equal(f.read(), first);
        assert.equal(first.raw_items[0].authorContact.nickname, '原昵称');
        const next = f.read('snapshot_read_1');
        assert.deepEqual(Array.from(next.raw_items, (row: any) => row.commentId), ['c']);
        assert.equal(f.read(), first, '较早编号仍重放原批次');
        assert.equal(f.read('snapshot_read_2').raw_items.length, 0);
        f.client.stopCommentSnapshot('snapshot');
        f.flow.dataList.items.push({ commentId: 'last' });
        assert.equal(f.read('snapshot_read_3').raw_items[0].commentId, 'last');
    } finally { f.close(); }
});

test('Store 尚未加载时返回空批，后续编号可读取首批', () => {
    const f = fixture();
    try {
        assert.equal(f.read().raw_items.length, 0);
        f.flow.dataList.items.push({ commentId: 'a' });
        assert.equal(f.read('snapshot_read_1').raw_items[0].commentId, 'a');
        assert.equal(f.loads, 0);
    } finally { f.close(); }
});

for (const mode of ['collection', 'page', 'url', 'work', 'store', 'request', 'replaced'] as const) {
    test(`拒绝错误归属或缺少编号的增量读取：${mode}`, () => {
        const f = fixture();
        try {
            f.flow.dataList.items.push({ commentId: 'a' });
            f.read();
            const extra = mode === 'collection' ? { collection_id: 'wrong' }
                : mode === 'page' ? { page_instance_id: 'wrong' }
                : mode === 'url' ? { url: f.binding.url + '&changed=1' }
                : mode === 'request' ? { task_id: '' } : {};
            if (mode === 'work') f.window.__wx_channels_store__.profile = { id: 'work-b' };
            if (mode === 'store') f.flow.feed = { id: 'work-b' };
            if (mode === 'replaced') {
                f.client.stopCommentSnapshot('snapshot');
                f.client.startCommentSnapshot({ ...f.binding, task_id: 'next', collection_id: 'next-collection' });
            }
            assert.equal(f.read('snapshot_read_0', extra).success, false, '即使批次已缓存也须检查归属');
        } finally { f.close(); }
    });
}

test('Store 取数失败不确认批次，同编号重试仍可拿到评论', () => {
    const f = fixture();
    try {
        f.flow.dataList.items.push({ commentId: 'a' });
        const find = f.window.__sph_findFlowCommentListInStores;
        f.window.__sph_findFlowCommentListInStores = () => { throw new Error('Store 暂时不可读'); };
        assert.equal(f.read().success, false);
        f.window.__sph_findFlowCommentListInStores = find;
        assert.equal(f.read().raw_items[0].commentId, 'a');
    } finally { f.close(); }
});
