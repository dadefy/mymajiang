export { ApiClient, type ApiError, type ApiErrorKind, type ApiResult } from "./api-client.js";
export { ClientFlow, MAX_VOICE_SECONDS, type Screen } from "./flow.js";
export { MatchSocket, type SocketEvent } from "./match-socket.js";
export { DEFAULT_REQUEST_TIMEOUT_MS, jsonBodyFor } from "./transport.js";
export {
  BrowserVoiceRecorder,
  clampSeconds,
  normalizedAudioType,
  type RecordedVoice,
  type VoiceRecorder,
} from "./browser/voice-recorder.js";
// 结算文案：两个浏览器客户端与 LayaAir 版共用一份，免得三处各写一套措辞。
// `roundLabel` 也在这里 —— 「第 N/8 小场」只该有一处拼法，否则必然出现
// 「第 3 局」「第 3 小场」混着显示，玩家看不出是不是同一件事。
export { clockText, durationText, fanListText, matchResultText, matchTimeText, roundLabel, roundReasonText, roundResultText, signed, winLines, winSummaryText } from "./browser/result-text.js";
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
