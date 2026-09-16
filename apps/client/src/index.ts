export { ApiClient, type ApiError, type ApiErrorKind, type ApiResult } from "./api-client.js";
export { ClientFlow, MAX_VOICE_SECONDS, type Screen } from "./flow.js";
export { MatchSocket, type SocketEvent } from "./match-socket.js";
export { DEFAULT_REQUEST_TIMEOUT_MS } from "./transport.js";
export {
  BrowserVoiceRecorder,
  clampSeconds,
  normalizedAudioType,
  type RecordedVoice,
  type VoiceRecorder,
} from "./browser/voice-recorder.js";
// 结算文案：两个浏览器客户端与 LayaAir 版共用一份，免得三处各写一套措辞。
export { fanListText, matchResultText, roundResultText, winLines, winSummaryText } from "./browser/result-text.js";
export type * from "./protocol.js";
export type {
  HttpTransport,
  HttpRequest,
  HttpResponse,
  SocketTransport,
  SocketTransportFactory,
  UploadTransport,
  UploadRequest,
  UploadResponse,
} from "./transport.js";
