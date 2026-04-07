# 视频在线播放功能说明

## 重要--
这个接口请求回来的数据，然后就可以让视频处理出来在线预览的视频链接
http://127.0.0.1:2026/api/channels/feed/profile?object_id=14872512324576287124&nonce_id=27367036622216232_0_140_0_0

## 概述

项目支持通过 `/api/video/play` 接口实现在线流式播放微信视频号视频，无需下载即可直接播放。

## 前端调用方式

前端通过 `resolveVideoUrl` 函数生成播放链接，核心代码位于 `hub_server/frontend/src/views/UserProfile.vue`：

```javascript
const resolveVideoUrl = async (video) => {
    const res = await clientStore.remoteCall('api_call', {
        key: 'key:channels:feed_profile',
        body: { object_id: video.id, nonce_id: video.nonceId }
    })
    
    let actual = {}
    if (res.data && res.data.object) {
        actual = res.data.object
    } else if (res.data && res.data.data && res.data.data.object) {
        actual = res.data.data.object
    } else {
        actual = (res.data || {})
    }

    const mediaArray = (actual.objectDesc && actual.objectDesc.media) || actual.media || []
    const media = mediaArray[0]
    
    if (!media || !media.url) throw new Error("无法获取视频地址")
    
    let videoUrl = media.url + (media.urlToken || '')
    const decryptKey = media.decodeKey || ''
    
    if (media.spec && media.spec.length > 0) {
        const lowestSpec = media.spec.reduce((prev, curr) => {
            return (curr.bitRate || 99999) < (prev.bitRate || 99999) ? curr : prev
        })
        if (lowestSpec.fileFormat) {
            videoUrl += `&X-snsvideoflag=${lowestSpec.fileFormat}`
        }
    }
    
    let finalUrl = `/api/video/play?url=${encodeURIComponent(videoUrl)}`
    if (decryptKey) finalUrl += `&key=${decryptKey}`
    
    return finalUrl
}
```

## URL 生成步骤

根据视频详情数据，按以下步骤生成播放链接：

### 1. 获取视频详情

调用 `key:channels:feed_profile` 接口获取视频详情数据，关键字段位于：
- `data.data.object.objectDesc.media[0]` - 视频媒体信息

### 2. 提取关键字段

从 media 对象中提取：
- `url` - 视频基础URL
- `urlToken` - 视频Token（可选，用于完整播放）
- `decodeKey` - 解密密钥
- `spec` - 视频规格数组（可选，用于选择清晰度）

### 3. 组装播放URL

```
videoUrl = url + urlToken + "&X-snsvideoflag=" + lowestSpec.fileFormat
playUrl = "/api/video/play?url=" + encodeURIComponent(videoUrl) + "&key=" + decodeKey
```

### 4. 完整播放链接格式

```
http://localhost:2025/api/video/play?url=<编码后的视频URL>&key=<解密密钥>
```

## API 接口说明

### 请求

```
GET /api/video/play?url=<视频URL>&key=<解密密钥>
```

### 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| url  | 是   | 视频源URL（需要URL编码） |
| key  | 否   | 解密密钥，uint64格式，仅用于加密视频 |

### 响应

返回视频流，支持：
- Range 请求（视频拖动播放）
- 加密视频解密

## 手动生成播放链接

如果需要手动测试，可以使用以下 Node.js 脚本生成播放链接：

```javascript
// 视频数据（从接口获取）
const media = {
    url: "https://finder.video.qq.com/251/20302/stodownload?encfilekey=...",
    urlToken: "&token=...",
    decodeKey: "1014774250",
    spec: [
        { fileFormat: "xWT111", bitRate: 131 },
        { fileFormat: "xWT156", bitRate: 81 }
    ]
};

const port = 2025;

// 1. 组合 URL
let videoUrl = media.url + (media.urlToken || '');

// 2. 可选：添加最低码率标识
if (media.spec && media.spec.length > 0) {
    const lowestSpec = media.spec.reduce((prev, curr) => {
        return (curr.bitRate || 99999) < (prev.bitRate || 99999) ? curr : prev
    });
    if (lowestSpec.fileFormat) {
        videoUrl += `&X-snsvideoflag=${lowestSpec.fileFormat}`;
    }
}

// 3. 生成播放链接
let playUrl = `http://localhost:${port}/api/video/play?url=${encodeURIComponent(videoUrl)}`;
if (media.decodeKey) {
    playUrl += `&key=${media.decodeKey}`;
}

console.log(playUrl);
```

## 注意事项

1. **Token 有效期** - 视频URL中的token有时效性，过期后需要重新获取
2. **解密密钥** - 部分视频需要传入正确的 `decodeKey` 才能正常播放
3. **端口配置** - 默认端口为 2025（从 config.yaml 中读取）
4. **CORS** - 接口已配置 CORS，支持跨域请求
