#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EvoClaw LLM 通用测试工具
========================
在图形界面中输入大模型的 API Key 等参数，
即可测试其是否能正常工作、响应时间及相关性能指标。

支持: OpenAI / DeepSeek / 通义千问 / 月之暗面 / 智谱GLM / 零一万物 / 百度千帆 / 自定义
"""

import json
import time
import threading
import tkinter as tk
from tkinter import ttk, scrolledtext, messagebox
from datetime import datetime
from typing import Optional, Dict, Any, List

try:
    import requests
except ImportError:
    requests = None  # type: ignore


# ============================================================
#  配置：各厂商 API 端点与模型列表
# ============================================================

PROVIDERS: Dict[str, Dict[str, Any]] = {
    "OpenAI": {
        "endpoint": "https://api.openai.com/v1",
        "models": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
    },
    "DeepSeek": {
        "endpoint": "https://api.deepseek.com",
        "models": ["deepseek-chat", "deepseek-reasoner"],
    },
    "通义千问 (Qwen)": {
        "endpoint": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "models": ["qwen-plus", "qwen-max", "qwen-turbo", "qwen2.5-72b-instruct"],
    },
    "月之暗面 (Moonshot)": {
        "endpoint": "https://api.moonshot.cn/v1",
        "models": ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
    },
    "智谱 (GLM)": {
        "endpoint": "https://open.bigmodel.cn/api/paas/v4",
        "models": ["glm-4-plus", "glm-4", "glm-4-flash", "glm-4-air"],
    },
    "零一万物 (Yi)": {
        "endpoint": "https://api.lingyiwanwu.com/v1",
        "models": ["yi-lightning", "yi-large", "yi-medium"],
    },
    "百度千帆": {
        "endpoint": "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat",
        "models": ["ERNIE-4.0-8K", "ERNIE-3.5-8K", "ERNIE-Speed-8K"],
        "note": "百度千帆需先通过 API Key/Secret 获取 access_token",
    },
    "自定义": {
        "endpoint": "",
        "models": ["custom-model"],
    },
}

DEFAULT_TEST_PROMPT = "请用一句话介绍你自己，并说明你能做什么。"


# ============================================================
#  LLM 调用核心
# ============================================================

class LLMTester:
    """封装 LLM 调用与计时逻辑"""

    def __init__(self):
        self.session = requests.Session() if requests else None
        self._stop_flag = False

    def stop(self):
        self._stop_flag = True

    def reset_stop(self):
        self._stop_flag = False

    @staticmethod
    def _now_ms() -> float:
        return time.time() * 1000

    def _call_openai_compat(
        self,
        endpoint: str,
        api_key: str,
        model: str,
        prompt: str,
        stream: bool = True,
        timeout: int = 60,
    ) -> Dict[str, Any]:
        """通用 OpenAI 兼容接口调用"""
        if not self.session:
            raise RuntimeError("依赖库 requests 未安装，请执行: pip install requests")

        url = f"{endpoint.rstrip('/')}/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stream": stream,
            "max_tokens": 1024,
        }

        start_time = self._now_ms()
        first_token_time: Optional[float] = None
        collected_content = ""
        total_input_tokens = 0
        total_output_tokens = 0

        if stream:
            # ---- 流式模式 ----
            resp = self.session.post(
                url, headers=headers, json=payload,
                stream=True, timeout=timeout
            )
            resp.raise_for_status()

            for line in resp.iter_lines(decode_unicode=True):
                if self._stop_flag:
                    break
                if not line or not line.startswith("data: "):
                    continue
                data_str = line[6:].strip()
                if data_str == "[DONE]":
                    break
                try:
                    chunk = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                # 首 token 计时
                if first_token_time is None:
                    delta = chunk.get("choices", [{}])[0].get("delta", {})
                    if delta.get("content"):
                        first_token_time = self._now_ms()

                # 收集内容
                choice = chunk.get("choices", [{}])[0]
                delta = choice.get("delta", {})
                content_piece = delta.get("content", "")
                collected_content += content_piece

                # token 用量（通常只在最后一条非流式 chunk 中有）
                usage = chunk.get("usage")
                if usage:
                    total_input_tokens = usage.get("prompt_tokens", 0)
                    total_output_tokens = usage.get("completion_tokens", 0)

            end_time = self._now_ms()

            # 如果流式没返回 usage，尝试估算
            if total_output_tokens == 0 and collected_content:
                total_output_tokens = max(1, len(collected_content) // 2)

        else:
            # ---- 非流式模式 ----
            resp = self.session.post(
                url, headers=headers, json=payload,
                timeout=timeout
            )
            resp.raise_for_status()
            data = resp.json()
            end_time = self._now_ms()

            choice = data.get("choices", [{}])[0]
            collected_content = choice.get("message", {}).get("content", "")
            usage = data.get("usage", {})
            total_input_tokens = usage.get("prompt_tokens", 0)
            total_output_tokens = usage.get("completion_tokens", 0)
            first_token_time = start_time  # 非流式首 token ≈ 总时间

        total_time_ms = end_time - start_time
        ttft_ms = (first_token_time - start_time) if first_token_time else total_time_ms
        output_tokens = total_output_tokens or max(1, len(collected_content) // 2)
        tokens_per_sec = output_tokens / (total_time_ms / 1000) if total_time_ms > 0 else 0

        return {
            "success": True,
            "content": collected_content,
            "total_time_ms": round(total_time_ms, 2),
            "ttft_ms": round(ttft_ms, 2),
            "input_tokens": total_input_tokens,
            "output_tokens": output_tokens,
            "tokens_per_second": round(tokens_per_sec, 2),
            "model": model,
            "stream": stream,
        }

    def test_once(
        self,
        provider: str,
        endpoint: str,
        api_key: str,
        model: str,
        prompt: str,
        stream: bool = True,
        timeout: int = 60,
    ) -> Dict[str, Any]:
        """执行单次测试"""
        self.reset_stop()
        try:
            return self._call_openai_compat(endpoint, api_key, model, prompt, stream, timeout)
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "total_time_ms": 0,
                "ttft_ms": 0,
                "input_tokens": 0,
                "output_tokens": 0,
                "tokens_per_second": 0,
                "model": model,
                "stream": stream,
            }


# ============================================================
#  GUI 界面
# ============================================================

class LLMTesterApp:
    """Tkinter 图形界面"""

    # 颜色主题
    BG_DARK = "#1e1e2e"
    BG_CARD = "#2a2a3e"
    FG_LIGHT = "#cdd6f4"
    FG_MUTED = "#a6adc8"
    ACCENT = "#89b4fa"
    SUCCESS = "#a6e3a1"
    ERROR = "#f38ba8"
    WARN = "#f9e2af"
    BORDER = "#45475a"
    ENTRY_BG = "#313244"

    def __init__(self, root: tk.Tk):
        self.root = root
        self.tester = LLMTester()
        self._testing = False
        self._test_results: List[Dict[str, Any]] = []

        self._build_ui()
        self._on_provider_change()

    # ---------- UI 构建 ----------

    def _build_ui(self):
        root = self.root
        root.title("🦞 EvoClaw LLM 通用测试工具")
        root.geometry("1100x780")
        root.configure(bg=self.BG_DARK)
        root.minsize(900, 650)

        style = ttk.Style()
        style.theme_use("clam")
        style.configure("TLabel", background=self.BG_DARK, foreground=self.FG_LIGHT, font=("Segoe UI", 10))
        style.configure("TButton", background=self.ACCENT, foreground=self.BG_DARK, font=("Segoe UI", 10, "bold"),
                        borderwidth=0, focuscolor="none")
        style.map("TButton", background=[("active", "#74c7ec")])
        style.configure("TCheckbutton", background=self.BG_DARK, foreground=self.FG_LIGHT, font=("Segoe UI", 10))
        style.configure("TFrame", background=self.BG_DARK)
        style.configure("TLabelframe", background=self.BG_DARK, foreground=self.FG_LIGHT, bordercolor=self.BORDER)
        style.configure("TLabelframe.Label", background=self.BG_DARK, foreground=self.ACCENT, font=("Segoe UI", 10, "bold"))
        style.configure("TRadiobutton", background=self.BG_DARK, foreground=self.FG_LIGHT, font=("Segoe UI", 10))
        style.configure("TCombobox", fieldbackground=self.ENTRY_BG, background=self.BG_CARD,
                        foreground=self.FG_LIGHT, arrowcolor=self.FG_LIGHT, bordercolor=self.BORDER)

        # ---- 主容器 ----
        main_frame = tk.Frame(root, bg=self.BG_DARK)
        main_frame.pack(fill=tk.BOTH, expand=True, padx=16, pady=12)

        # ========== 标题 ==========
        title_lbl = tk.Label(
            main_frame, text="🦞 EvoClaw LLM 通用测试工具",
            font=("Segoe UI", 18, "bold"), bg=self.BG_DARK, fg=self.ACCENT
        )
        title_lbl.pack(anchor=tk.W, pady=(0, 12))

        # ========== 参数区域 (两列) ==========
        param_frame = tk.Frame(main_frame, bg=self.BG_DARK)
        param_frame.pack(fill=tk.X, pady=(0, 10))

        # ---- 左列 ----
        left = tk.Frame(param_frame, bg=self.BG_DARK)
        left.pack(side=tk.LEFT, fill=tk.BOTH, expand=True, padx=(0, 8))

        # 服务商
        row1 = tk.Frame(left, bg=self.BG_DARK)
        row1.pack(fill=tk.X, pady=3)
        tk.Label(row1, text="服务商:", width=12, anchor=tk.W,
                 bg=self.BG_DARK, fg=self.FG_LIGHT, font=("Segoe UI", 10)).pack(side=tk.LEFT)
        self.provider_var = tk.StringVar(value="OpenAI")
        self.provider_menu = ttk.Combobox(
            row1, textvariable=self.provider_var,
            values=list(PROVIDERS.keys()), state="readonly", width=22
        )
        self.provider_menu.pack(side=tk.LEFT, padx=4)
        self.provider_menu.bind("<<ComboboxSelected>>", lambda e: self._on_provider_change())

        # API Endpoint
        row2 = tk.Frame(left, bg=self.BG_DARK)
        row2.pack(fill=tk.X, pady=3)
        tk.Label(row2, text="API 端点:", width=12, anchor=tk.W,
                 bg=self.BG_DARK, fg=self.FG_LIGHT, font=("Segoe UI", 10)).pack(side=tk.LEFT)
        self.endpoint_var = tk.StringVar()
        self.endpoint_entry = tk.Entry(
            row2, textvariable=self.endpoint_var, bg=self.ENTRY_BG, fg=self.FG_LIGHT,
            insertbackground=self.FG_LIGHT, relief=tk.FLAT, font=("Segoe UI", 10),
            highlightthickness=1, highlightbackground=self.BORDER, highlightcolor=self.ACCENT
        )
        self.endpoint_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=4)

        # API Key
        row3 = tk.Frame(left, bg=self.BG_DARK)
        row3.pack(fill=tk.X, pady=3)
        tk.Label(row3, text="API Key:", width=12, anchor=tk.W,
                 bg=self.BG_DARK, fg=self.FG_LIGHT, font=("Segoe UI", 10)).pack(side=tk.LEFT)
        self.api_key_var = tk.StringVar()
        self.api_key_entry = tk.Entry(
            row3, textvariable=self.api_key_var, bg=self.ENTRY_BG, fg=self.FG_LIGHT,
            insertbackground=self.FG_LIGHT, relief=tk.FLAT, font=("Segoe UI", 10),
            highlightthickness=1, highlightbackground=self.BORDER, highlightcolor=self.ACCENT,
            show="*"
        )
        self.api_key_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=4)

        # 显示/隐藏 Key
        self.show_key_var = tk.BooleanVar(value=False)
        def toggle_key():
            self.api_key_entry.config(show="" if self.show_key_var.get() else "*")
        tk.Checkbutton(row3, text="显示", variable=self.show_key_var,
                       command=toggle_key, bg=self.BG_DARK, fg=self.FG_MUTED,
                       selectcolor=self.BG_CARD, font=("Segoe UI", 9),
                       activebackground=self.BG_DARK, activeforeground=self.FG_LIGHT).pack(side=tk.LEFT)

        # ---- 右列 ----
        right = tk.Frame(param_frame, bg=self.BG_DARK)
        right.pack(side=tk.RIGHT, fill=tk.BOTH, expand=True, padx=(8, 0))

        # 模型
        row4 = tk.Frame(right, bg=self.BG_DARK)
        row4.pack(fill=tk.X, pady=3)
        tk.Label(row4, text="模型:", width=12, anchor=tk.W,
                 bg=self.BG_DARK, fg=self.FG_LIGHT, font=("Segoe UI", 10)).pack(side=tk.LEFT)
        self.model_var = tk.StringVar()
        self.model_menu = ttk.Combobox(
            row4, textvariable=self.model_var, values=[], state="readonly", width=22
        )
        self.model_menu.pack(side=tk.LEFT, padx=4)

        # 测试轮数
        row5 = tk.Frame(right, bg=self.BG_DARK)
        row5.pack(fill=tk.X, pady=3)
        tk.Label(row5, text="测试轮数:", width=12, anchor=tk.W,
                 bg=self.BG_DARK, fg=self.FG_LIGHT, font=("Segoe UI", 10)).pack(side=tk.LEFT)
        self.rounds_var = tk.StringVar(value="1")
        rounds_spin = tk.Spinbox(
            row5, from_=1, to=10, textvariable=self.rounds_var, width=6,
            bg=self.ENTRY_BG, fg=self.FG_LIGHT, insertbackground=self.FG_LIGHT,
            buttonbackground=self.BG_CARD, relief=tk.FLAT, font=("Segoe UI", 10),
            highlightthickness=1, highlightbackground=self.BORDER, highlightcolor=self.ACCENT
        )
        rounds_spin.pack(side=tk.LEFT, padx=4)
        tk.Label(row5, text="次", bg=self.BG_DARK, fg=self.FG_MUTED,
                 font=("Segoe UI", 10)).pack(side=tk.LEFT)

        # 超时
        row6 = tk.Frame(right, bg=self.BG_DARK)
        row6.pack(fill=tk.X, pady=3)
        tk.Label(row6, text="超时(秒):", width=12, anchor=tk.W,
                 bg=self.BG_DARK, fg=self.FG_LIGHT, font=("Segoe UI", 10)).pack(side=tk.LEFT)
        self.timeout_var = tk.StringVar(value="60")
        timeout_spin = tk.Spinbox(
            row6, from_=10, to=300, textvariable=self.timeout_var, width=6,
            bg=self.ENTRY_BG, fg=self.FG_LIGHT, insertbackground=self.FG_LIGHT,
            buttonbackground=self.BG_CARD, relief=tk.FLAT, font=("Segoe UI", 10),
            highlightthickness=1, highlightbackground=self.BORDER, highlightcolor=self.ACCENT
        )
        timeout_spin.pack(side=tk.LEFT, padx=4)
        tk.Label(row6, text="秒", bg=self.BG_DARK, fg=self.FG_MUTED,
                 font=("Segoe UI", 10)).pack(side=tk.LEFT)

        # 流式开关
        row7 = tk.Frame(right, bg=self.BG_DARK)
        row7.pack(fill=tk.X, pady=3)
        self.stream_var = tk.BooleanVar(value=True)
        tk.Checkbutton(row7, text="启用流式输出 (Stream)", variable=self.stream_var,
                       bg=self.BG_DARK, fg=self.FG_LIGHT, selectcolor=self.BG_CARD,
                       font=("Segoe UI", 10), activebackground=self.BG_DARK,
                       activeforeground=self.FG_LIGHT).pack(side=tk.LEFT, padx=(12, 0))

        # ========== 测试提示词 ==========
        prompt_frame = tk.LabelFrame(main_frame, text="测试提示词", bg=self.BG_DARK,
                                     fg=self.ACCENT, font=("Segoe UI", 10, "bold"),
                                     padx=8, pady=6)
        prompt_frame.pack(fill=tk.X, pady=(0, 10))

        self.prompt_text = tk.Text(
            prompt_frame, height=3, bg=self.ENTRY_BG, fg=self.FG_LIGHT,
            insertbackground=self.FG_LIGHT, relief=tk.FLAT, font=("Segoe UI", 10),
            highlightthickness=1, highlightbackground=self.BORDER, highlightcolor=self.ACCENT,
            padx=8, pady=6
        )
        self.prompt_text.insert("1.0", DEFAULT_TEST_PROMPT)
        self.prompt_text.pack(fill=tk.X)

        # ========== 操作按钮 ==========
        btn_frame = tk.Frame(main_frame, bg=self.BG_DARK)
        btn_frame.pack(fill=tk.X, pady=(0, 10))

        self.start_btn = self._make_btn(btn_frame, "▶ 开始测试", self._on_start_test,
                                        bg="#40a02b", fg="white", width=14)
        self.start_btn.pack(side=tk.LEFT, padx=(0, 8))

        self.stop_btn = self._make_btn(btn_frame, "⏹ 停止", self._on_stop_test,
                                       bg="#d20f39", fg="white", width=10, state=tk.DISABLED)
        self.stop_btn.pack(side=tk.LEFT, padx=4)

        self.clear_btn = self._make_btn(btn_frame, "🗑 清空结果", self._on_clear,
                                        bg=self.BG_CARD, fg=self.FG_LIGHT, width=12)
        self.clear_btn.pack(side=tk.LEFT, padx=4)

        # ========== 输出区域 ==========
        out_frame = tk.LabelFrame(main_frame, text="测试结果输出", bg=self.BG_DARK,
                                  fg=self.ACCENT, font=("Segoe UI", 10, "bold"),
                                  padx=8, pady=6)
        out_frame.pack(fill=tk.BOTH, expand=True)

        self.output_text = scrolledtext.ScrolledText(
            out_frame, bg="#11111b", fg=self.FG_LIGHT,
            insertbackground=self.FG_LIGHT, font=("Consolas", 10),
            relief=tk.FLAT, highlightthickness=1,
            highlightbackground=self.BORDER, highlightcolor=self.ACCENT,
            padx=10, pady=8, state=tk.DISABLED
        )
        self.output_text.pack(fill=tk.BOTH, expand=True)

        # 配置文本 tag
        self.output_text.tag_configure("info", foreground=self.ACCENT)
        self.output_text.tag_configure("success", foreground=self.SUCCESS)
        self.output_text.tag_configure("error", foreground=self.ERROR)
        self.output_text.tag_configure("warn", foreground=self.WARN)
        self.output_text.tag_configure("bold", font=("Consolas", 10, "bold"))
        self.output_text.tag_configure("header", foreground=self.ACCENT,
                                       font=("Consolas", 11, "bold"))
        self.output_text.tag_configure("dim", foreground=self.FG_MUTED)
        self.output_text.tag_configure("result_bg", background="#1e1e2e")

        # ========== 状态栏 ==========
        self.status_var = tk.StringVar(value="就绪 ✅")
        status_bar = tk.Label(
            main_frame, textvariable=self.status_var, bg=self.BG_CARD, fg=self.FG_MUTED,
            font=("Segoe UI", 9), anchor=tk.W, padx=10, pady=4
        )
        status_bar.pack(fill=tk.X, pady=(4, 0))

    @staticmethod
    def _make_btn(parent, text, command, bg, fg, width=10, state=tk.NORMAL):
        btn = tk.Button(
            parent, text=text, command=command, bg=bg, fg=fg,
            font=("Segoe UI", 10, "bold"), relief=tk.FLAT,
            padx=12, pady=6, cursor="hand2", borderwidth=0,
            activebackground=bg, activeforeground=fg, width=width,
            state=state
        )
        return btn

    # ---------- 事件 ----------

    def _on_provider_change(self):
        provider = self.provider_var.get()
        info = PROVIDERS.get(provider, PROVIDERS["自定义"])

        # 更新端点
        self.endpoint_var.set(info.get("endpoint", ""))

        # 更新模型列表
        models = info.get("models", ["custom-model"])
        self.model_menu["values"] = models
        self.model_var.set(models[0] if models else "")

        # 提示
        note = info.get("note", "")
        if note:
            self._append_output(f"ℹ️ {note}\n", "warn")

    def _on_start_test(self):
        if self._testing:
            return

        # 校验参数
        api_key = self.api_key_var.get().strip()
        if not api_key:
            messagebox.showwarning("参数缺失", "请输入 API Key")
            return

        endpoint = self.endpoint_var.get().strip()
        if not endpoint:
            messagebox.showwarning("参数缺失", "请输入 API 端点地址")
            return

        model = self.model_var.get().strip()
        if not model:
            messagebox.showwarning("参数缺失", "请选择模型")
            return

        try:
            rounds = int(self.rounds_var.get())
            if rounds < 1:
                rounds = 1
        except ValueError:
            rounds = 1

        try:
            timeout = int(self.timeout_var.get())
            if timeout < 10:
                timeout = 10
        except ValueError:
            timeout = 60

        prompt = self.prompt_text.get("1.0", tk.END).strip()
        if not prompt:
            prompt = DEFAULT_TEST_PROMPT

        stream = self.stream_var.get()
        provider = self.provider_var.get()

        # 开始测试
        self._testing = True
        self._test_results = []
        self.start_btn.config(state=tk.DISABLED)
        self.stop_btn.config(state=tk.NORMAL)
        self.status_var.set(f"🔄 正在测试 ({provider} / {model}) ...")

        self._append_output(
            f"\n{'='*60}\n"
            f"🚀 开始测试 | {provider} | 模型: {model} | 轮数: {rounds}\n"
            f"  端点: {endpoint}\n"
            f"  流式: {'是' if stream else '否'} | 超时: {timeout}s\n"
            f"  提示词: {prompt[:60]}{'...' if len(prompt) > 60 else ''}\n"
            f"{'='*60}\n",
            "header"
        )

        # 在子线程中执行
        def run():
            for i in range(1, rounds + 1):
                if self.tester._stop_flag:
                    break
                self._run_single_test(i, rounds, provider, endpoint, api_key, model, prompt, stream, timeout)

            # 汇总
            self.root.after(0, self._show_summary)

        threading.Thread(target=run, daemon=True).start()

    def _run_single_test(self, idx, total, provider, endpoint, api_key, model, prompt, stream, timeout):
        self.root.after(0, lambda: self._append_output(
            f"\n--- 第 {idx}/{total} 轮测试 ---\n", "bold"
        ))

        start_t = time.time()
        result = self.tester.test_once(provider, endpoint, api_key, model, prompt, stream, timeout)
        elapsed = time.time() - start_t

        self._test_results.append(result)

        if result["success"]:
            content = result.get("content", "")
            self.root.after(0, lambda: self._append_output(
                f"✅ 响应内容 ({len(content)} 字符):\n{content[:300]}{'...' if len(content) > 300 else ''}\n",
                "success"
            ))
            self.root.after(0, lambda: self._append_output(
                f"📊 性能指标:\n"
                f"   总响应时间: {result['total_time_ms']:.1f} ms\n"
                f"   首 Token 时间 (TTFT): {result['ttft_ms']:.1f} ms\n"
                f"   输出 Token 数: {result['output_tokens']}\n"
                f"   输入 Token 数: {result['input_tokens']}\n"
                f"   生成速度: {result['tokens_per_second']:.1f} tokens/s\n"
                f"   实际耗时: {elapsed:.2f} s\n",
                "info"
            ))
        else:
            self.root.after(0, lambda: self._append_output(
                f"❌ 测试失败: {result.get('error', '未知错误')}\n", "error"
            ))

    def _show_summary(self):
        self._testing = False
        self.start_btn.config(state=tk.NORMAL)
        self.stop_btn.config(state=tk.DISABLED)
        self.tester.reset_stop()

        results = self._test_results
        if not results:
            self.status_var.set("测试已停止 ⏹")
            self._append_output("\n⚠️ 测试已中断，无汇总数据\n", "warn")
            return

        success_results = [r for r in results if r["success"]]
        fail_results = [r for r in results if not r["success"]]

        self._append_output(f"\n{'='*60}\n📋 测试汇总\n{'='*60}\n", "header")

        if success_results:
            total_times = [r["total_time_ms"] for r in success_results]
            ttft_times = [r["ttft_ms"] for r in success_results]
            speeds = [r["tokens_per_second"] for r in success_results]
            output_tokens = [r["output_tokens"] for r in success_results]

            avg_total = sum(total_times) / len(total_times)
            avg_ttft = sum(ttft_times) / len(ttft_times)
            avg_speed = sum(speeds) / len(speeds)
            avg_output = sum(output_tokens) / len(output_tokens)

            self._append_output(
                f"✅ 成功: {len(success_results)}/{len(results)} 轮\n\n"
                f"📊 平均性能指标:\n"
                f"   ├─ 平均总响应时间: {avg_total:.1f} ms\n"
                f"   ├─ 平均首 Token 时间: {avg_ttft:.1f} ms\n"
                f"   ├─ 平均生成速度: {avg_speed:.1f} tokens/s\n"
                f"   ├─ 平均输出 Token: {avg_output:.0f}\n"
                f"   └─ 最快/最慢: {min(total_times):.0f} / {max(total_times):.0f} ms\n",
                "success"
            )
        else:
            self._append_output("❌ 所有测试均失败\n", "error")

        if fail_results:
            self._append_output(f"\n⚠️ 失败详情 ({len(fail_results)} 轮):\n", "warn")
            for i, r in enumerate(fail_results, 1):
                self._append_output(f"  {i}. {r.get('error', '未知')}\n", "error")

        self.status_var.set(f"测试完成 ✅ 成功 {len(success_results)}/{len(results)} 轮")

    def _on_stop_test(self):
        self.tester.stop()
        self.status_var.set("正在停止... ⏹")
        self._append_output("\n⏹ 用户请求停止测试\n", "warn")

    def _on_clear(self):
        self.output_text.config(state=tk.NORMAL)
        self.output_text.delete("1.0", tk.END)
        self.output_text.config(state=tk.DISABLED)
        self._test_results = []
        self.status_var.set("已清空 ✅")

    def _append_output(self, text: str, tag: Optional[str] = None):
        self.output_text.config(state=tk.NORMAL)
        if tag:
            self.output_text.insert(tk.END, text, tag)
        else:
            self.output_text.insert(tk.END, text)
        self.output_text.see(tk.END)
        self.output_text.config(state=tk.DISABLED)


# ============================================================
#  入口
# ============================================================

def main():
    if requests is None:
        print("=" * 50)
        print("  ⚠️  缺少依赖库: requests")
        print("  请执行: pip install requests")
        print("=" * 50)
        return

    root = tk.Tk()
    app = LLMTesterApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
