/// <reference types="vite/client" />

// 全局 Window 接口扩展，避免 (window as any) 类型安全绕过
declare global {
  interface Window {
    /** EvoClaw API 基础 URL 前缀，由宿主环境注入 */
    __EVOCLAW_API__?: string;
    /** Canvas 页面与宿主交互的动作回调 */
    openclawSendUserAction?: (payload: { action: string; elementId?: string; value?: unknown }) => void;
  }
}

export {};