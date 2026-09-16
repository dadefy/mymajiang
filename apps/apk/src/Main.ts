import { ApiClient, ClientFlow } from "@mianyang-mahjong/client";
import { runtimeConfig } from "./runtime-config.js";
import { LayaHttpTransport, LayaSocketTransportFactory, LayaUploadTransport } from "./laya-transports.js";
import { ScreenHost } from "./ui/ScreenHost.js";
import { DESIGN_HEIGHT, DESIGN_WIDTH, THEME } from "./ui/widgets.js";

const { regClass, property } = Laya;

/**
 * 游戏入口：搭建传输层 → 客户端业务核心 → 页面渲染。
 *
 * 业务逻辑全部在 @mianyang-mahjong/client 里（不依赖引擎）；
 * 这里只做三件事：配置舞台、实例化三个 LayaAir 适配器（HTTP / 实时通道 / 图片直传）、
 * 把 Screen 交给 ScreenHost。
 */
@regClass()
export class Main extends Laya.Script {

    onStart() {
        this.setupStage();
        const config = runtimeConfig();
        const api = new ApiClient(new LayaHttpTransport(config.apiBaseUrl));
        const flow = new ClientFlow(api, new LayaSocketTransportFactory(), config.socketUrl, new LayaUploadTransport());
        const host = new ScreenHost(flow, api, Laya.stage);
        flow.onChange((screen) => host.render(screen));
        host.render(flow.current);
    }

    /** 固定竖屏设计分辨率，整体等比缩放居中；页面内部按 750×1334 绝对坐标布局。 */
    private setupStage(): void {
        const stage = Laya.stage;
        stage.bgColor = THEME.pageBg;
        stage.designWidth = DESIGN_WIDTH;
        stage.designHeight = DESIGN_HEIGHT;
        stage.scaleMode = Laya.Stage.SCALE_SHOWALL;
        stage.alignH = "center";
        stage.alignV = "middle";
    }
}
