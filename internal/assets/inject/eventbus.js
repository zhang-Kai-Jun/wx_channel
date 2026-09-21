/**
 * @file 事件总线 - 参考 wx_channels_download 项目
 */
var WXE = (() => {
  var eventbus = mitt();
  var ChannelsEvents = {
    DOMContentLoaded: "DOMContentLoaded",
    DOMContentBeforeUnLoaded: "DOMContentBeforeUnLoaded",
    WindowLoaded: "WindowLoaded",
    WindowUnLoaded: "WindowUnLoaded",
    APILoaded: "APILoaded",
    UtilsLoaded: "UtilsLoaded",
    Init: "Init",
    PCFlowLoaded: "PCFlowLoaded",
    CategoryFeedsLoaded: "CategoryFeedsLoaded", // 分类视频列表（首页、美食、生活等）
    RecommendFeedsLoaded: "RecommendFeedsLoaded",
    InteractionedFeedsLoaded: "InteractionedFeedsLoaded", // 赞过/喜欢列表
    UserFeedsLoaded: "UserFeedsLoaded",
    UserLiveReplayLoaded: "UserLiveReplayLoaded", // 直播回放列表
    LiveUserFeedsLoaded: "LiveUserFeedsLoaded", // 与 wx_channels_download 对齐
    SearchResultLoaded: "SearchResultLoaded", // 搜索结果（包含动态、账号、直播）
    GotoNextFeed: "GotoNextFeed",
    GotoPrevFeed: "GotoPrevFeed",
    HomeFeedChanged: "HomeFeedChanged",
    FeedProfileLoaded: "OnFeedProfileLoaded",
    LiveProfileLoaded: "OnLiveProfileLoaded",
    JoinLive: "JoinLive",
    Feed: "Feed",
  };
  return {
    Events: ChannelsEvents,
    emit: eventbus.emit,
    onDOMContentLoaded(handler) {
      eventbus.on(ChannelsEvents.DOMContentLoaded, handler);
      return () => { eventbus.off(ChannelsEvents.DOMContentLoaded, handler); };
    },
    onDOMContentBeforeUnLoaded(handler) {
      eventbus.on(ChannelsEvents.DOMContentBeforeUnLoaded, handler);
      return () => { eventbus.off(ChannelsEvents.DOMContentBeforeUnLoaded, handler); };
    },
    onWindowLoaded(handler) {
      eventbus.on(ChannelsEvents.WindowLoaded, handler);
      return () => { eventbus.off(ChannelsEvents.WindowLoaded, handler); };
    },
    onWindowUnLoaded(handler) {
      eventbus.on(ChannelsEvents.WindowUnLoaded, handler);
      return () => { eventbus.off(ChannelsEvents.WindowUnLoaded, handler); };
    },
    onAPILoaded(handler) {
      eventbus.on(ChannelsEvents.APILoaded, handler);
      return () => { eventbus.off(ChannelsEvents.APILoaded, handler); };
    },
    onUtilsLoaded(handler) {
      eventbus.on(ChannelsEvents.UtilsLoaded, handler);
      return () => { eventbus.off(ChannelsEvents.UtilsLoaded, handler); };
    },
    onInit(handler) {
      eventbus.on(ChannelsEvents.Init, handler);
      return () => { eventbus.off(ChannelsEvents.Init, handler); };
    },
    onPCFlowLoaded(handler) {
      eventbus.on(ChannelsEvents.PCFlowLoaded, handler);
      return () => { eventbus.off(ChannelsEvents.PCFlowLoaded, handler); };
    },
    onCategoryFeedsLoaded(handler) {
      eventbus.on(ChannelsEvents.CategoryFeedsLoaded, handler);
      return () => { eventbus.off(ChannelsEvents.CategoryFeedsLoaded, handler); };
    },
    onGotoNextFeed(handler) {
      eventbus.on(ChannelsEvents.GotoNextFeed, handler);
      return () => { eventbus.off(ChannelsEvents.GotoNextFeed, handler); };
    },
    onGotoPrevFeed(handler) {
      eventbus.on(ChannelsEvents.GotoPrevFeed, handler);
      return () => { eventbus.off(ChannelsEvents.GotoPrevFeed, handler); };
    },
    onRecommendFeedsLoaded(handler) {
      eventbus.on(ChannelsEvents.RecommendFeedsLoaded, handler);
      return () => { eventbus.off(ChannelsEvents.RecommendFeedsLoaded, handler); };
    },
    onInteractionedFeedsLoaded(handler) {
      eventbus.on(ChannelsEvents.InteractionedFeedsLoaded, handler);
      return () => { eventbus.off(ChannelsEvents.InteractionedFeedsLoaded, handler); };
    },
    onUserFeedsLoaded(handler) {
      eventbus.on(ChannelsEvents.UserFeedsLoaded, handler);
      return () => { eventbus.off(ChannelsEvents.UserFeedsLoaded, handler); };
    },
    onUserLiveReplayLoaded(handler) {
      eventbus.on(ChannelsEvents.UserLiveReplayLoaded, handler);
      return () => { eventbus.off(ChannelsEvents.UserLiveReplayLoaded, handler); };
    },
    onLiveUserFeedsLoaded(handler) {
      eventbus.on(ChannelsEvents.LiveUserFeedsLoaded, handler);
      return () => { eventbus.off(ChannelsEvents.LiveUserFeedsLoaded, handler); };
    },
    onSearchResultLoaded(handler) {
      eventbus.on(ChannelsEvents.SearchResultLoaded, handler);
      return () => { eventbus.off(ChannelsEvents.SearchResultLoaded, handler); };
    },
    onHomeFeedChanged(handler) {
      eventbus.on(ChannelsEvents.HomeFeedChanged, handler);
      return () => { eventbus.off(ChannelsEvents.HomeFeedChanged, handler); };
    },
    onFetchFeedProfile(handler) {
      eventbus.on(ChannelsEvents.FeedProfileLoaded, handler);
      return () => { eventbus.off(ChannelsEvents.FeedProfileLoaded, handler); };
    },
    onFetchLiveProfile(handler) {
      eventbus.on(ChannelsEvents.LiveProfileLoaded, handler);
      return () => { eventbus.off(ChannelsEvents.LiveProfileLoaded, handler); };
    },
    onJoinLive(handler) {
      eventbus.on(ChannelsEvents.JoinLive, handler);
      return () => { eventbus.off(ChannelsEvents.JoinLive, handler); };
    },
    onFeed(handler) {
      eventbus.on(ChannelsEvents.Feed, handler);
      return () => { eventbus.off(ChannelsEvents.Feed, handler); };
    },
  };
})();

document.addEventListener("DOMContentLoaded", function () {
  WXE.emit(WXE.Events.DOMContentLoaded, { href: window.location.href });
});
window.addEventListener("beforeunload", function () {
  WXE.emit(WXE.Events.DOMContentBeforeUnLoaded, { href: window.location.href });
});
window.addEventListener("load", function () {
  WXE.emit(WXE.Events.WindowLoaded, { href: window.location.href });
});
window.addEventListener("unload", function () {
  WXE.emit(WXE.Events.WindowUnLoaded, { href: window.location.href });
});

WXE.onGotoNextFeed((feed) => {
  console.log("[eventbus.js]onGotoNextFeed", feed);
  WXE.emit(WXE.Events.Feed, feed);
});
WXE.onGotoPrevFeed((feed) => {
  console.log("[eventbus.js]onGotoPrevFeed", feed);
  WXE.emit(WXE.Events.Feed, feed);
});
WXE.onHomeFeedChanged((feed) => {
  console.log("[eventbus.js]onHomeFeedChanged", feed);
  WXE.emit(WXE.Events.Feed, feed);
});
WXE.onFetchFeedProfile((feed) => {
  console.log("[eventbus.js]onFetchFeedProfile", feed);
  WXE.emit(WXE.Events.Feed, feed);
});
var home_recommend_mounted = false;
WXE.onPCFlowLoaded((feeds) => {
  if (home_recommend_mounted) return;
  home_recommend_mounted = true;
  // console.log("[eventbus.js]onPCFlowLoaded", feeds);
  WXE.emit(WXE.Events.Feed, feeds[0]);
});
