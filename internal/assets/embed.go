package assets

import (
	_ "embed"
)

//go:embed certs/SunnyRoot.cer
var CertData []byte

//go:embed inject/core.js
var CoreJS []byte

//go:embed inject/home.js
var HomeJS []byte

//go:embed inject/feed.js
var FeedJS []byte

//go:embed inject/profile.js
var ProfileJS []byte

//go:embed inject/search.js
var SearchJS []byte

//go:embed inject/lib/mitt.umd.js
var MittJS []byte

//go:embed inject/eventbus.js
var EventbusJS []byte

//go:embed inject/utils.js
var UtilsJS []byte

//go:embed inject/api_client.js
var APIClientJS []byte

//go:embed inject/keep_alive.js
var KeepAliveJS []byte
