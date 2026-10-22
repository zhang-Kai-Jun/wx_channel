package handlers

import (
	"context"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestAPILoadedInjectionDoesNotBreakNativeModule(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("需要 Node.js 执行生成的 JavaScript 模块")
	}
	const fixture = `const api$={finderSearch(){return "native"}};export{api$ as nativeAPI};globalThis.nativeBooted=true;`
	handler := &ScriptHandler{}
	generated, handled := handler.handleVirtualSvgIcons("/t/wx_fed/finder/web/web-finder/res/js/virtual_svg-icons-register.test.js", fixture)
	if !handled {
		t.Fatal("核心模块未经过实际重写函数")
	}
	for _, scenario := range []struct {
		name   string
		setup  string
		verify string
	}{
		{
			name: "success",
			setup: `globalThis.WXU={Events:{APILoaded:"APILoaded"},emit(event,methods){
				if(event!=="APILoaded"||methods.api$.finderSearch()!=="native")throw Error("wrong event");
				globalThis.published=methods.api$;
			}};`,
			verify: `if(globalThis.published!==api$)throw Error("API exports not published");`,
		},
		{name: "missing_utils"},
		{name: "missing_events", setup: `globalThis.WXU={emit(){throw Error("must be isolated")}};`},
		{name: "listener_throws", setup: `globalThis.WXU={Events:{APILoaded:"APILoaded"},emit(){throw Error("collector failed")}};`},
		{
			name: "error_reporting_also_throws",
			setup: `globalThis.WXU={Events:{APILoaded:"APILoaded"},emit(){throw Error("collector failed")}};
				globalThis.console={warn(){throw Error("logging failed")},error(){throw Error("logging failed")}};`,
		},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, node, "--input-type=module")
			command.Stdin = strings.NewReader(scenario.setup + generated + `
if(!globalThis.nativeBooted||api$.finderSearch()!=="native")throw Error("native module initialization interrupted");
` + scenario.verify)
			if output, err := command.CombinedOutput(); err != nil {
				t.Fatalf("微信核心模块未能继续初始化: %v\n%s", err, output)
			}
		})
	}
}
