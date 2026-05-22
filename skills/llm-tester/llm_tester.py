#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EvoClaw LLM 通用测试工具 v1.0
==============================
图形界面测试各大 LLM 服务商的 API 连通性、响应时间、Token 吞吐量等性能指标。

运行方式:
    pip install PyQt5 requests sseclient-py
    python llm_tester.py
"""

import sys
import json
import time
import threading
from datetime import datetime
from typing import Optional, Dict, List, Tuple

from PyQt5.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QLabel, QLineEdit, QPushButton, QComboBox, QTextEdit, QSpinBox,
    QGroupBox, QGridLayout, QTabWidget, QTableWidget, QTableWidgetItem,
    QHeaderView, QMessageBox, QSplitter, QFrame, QCheckBox, QProgressBar
)
from PyQt5.QtCore import Qt, QTimer, pyqtSignal, QObject
from PyQt5.QtGui import QFont, QPalette, QColor, QTextCursor

import requests


# ============================================================
# 服务商配置
# ============================================================
PROVIDERS = {
    "OpenAI": {
        "base_url": "https://api.openai.com/v1",
        "models": ["gpt-4o", "gpt-4-turbo", "gpt-4", "gpt-3.5-turbo"],
        "default_model": "gpt-4o-mini",
        "need_api_key": True,
    },
    "DeepSeek": {
        "base_url": "https://api.deepseek.com/v1",
        "models": ["deepseek-chat", "deepseek-reasoner"],
        "default_model": "deepseek-chat",
        "need_api_key": True,
    },
    "通义千问 (Qwen)": {
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "models": ["qwen-plus", "qwen-max", "qwen-turbo", "qwen2.5-72b-instruct", "qwen2.5-32b-instruct"],
        "default_model": "qwen-plus",
        "need_api_key": True,
    },
    "月之暗面 (Moonshot)": {
        "base_url": "https://api.moonshot.cn/v1",
        "models": ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
        "default_model": "moonshot-v1-8k",
        "need_api_key": True,
    },
    "智谱 (GLM)": {
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "models": ["glm-4-plus", "glm-4-flash", "glm-4-air", "glm-4-airx"],
        "default_model": "glm-4-flash",
        "need_api_key": True,
    },
    "零一万物 (Yi)": {
        "base_url": "https://api.lingyiwanwu.com/v1",
        "models": ["yi-lightning", "yi-large", "yi-medium", "yi-vision"],
        "default_model": "yi-lightning",
        "need_api_key": True,
    },
    "百度千帆": {
        "base_url": "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat",
        "models": ["ernie-4.0", "ernie-3.5", "ernie-speed", "ernie-speed-128k"],
        "default_model": "ernie-speed",
        "need_api_key": True,
    },
    "自定义": {
        "base_url": "",
        "models": ["custom-model"],
        "default_model": "custom-model",
        "need_api_key": True,
    },
}


# ============================================================
# 信号中继（跨线程安全）
# ============================================================
class LogSignal(QObject):
    """用于跨线程安全地更新 GUI 日志"""
    append = pyqtSignal(str, str)  # text, level
    progress = pyqtSignal(int)
    done = pyqtSignal(dict)


# ============================================================
# 主窗口
# ============================================================
class LLMTesterWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.log_signal = LogSignal()
        self.log_signal.append.connect(self._append_log_safe)
        self.log_signal.progress.connect(self._update_progress_safe)
        self.log_signal.done.connect(self._on_test_done_safe)
        self.test_results: List[dict] = []
        self._testing = False
        self._stop_requested = False
        self.init_ui()

    # ---------- UI 构建 ----------
    def init_ui(self):
        self.setWindowTitle("🦞 EvoClaw LLM 通用测试工具")
        self.setMinimumSize(1000, 720)
        self.setStyleSheet(self._get_stylesheet())

        central = QWidget()
        self.setCentralWidget(central)
        main_layout = QVBoxLayout(central)
        main_layout.setSpacing(8)
        main_layout.setContentsMargins(12, 12, 12, 12)

        # ---- 顶部标题 ----
        title = QLabel("🦞 EvoClaw LLM 通用测试工具")
        title.setObjectName("titleLabel")
        title.setAlignment(Qt.AlignCenter)
        main_layout.addWidget(title)

        # ---- 配置区域 ----
        config_group = QGroupBox("🔧 API 配置")
        config_layout = QGridLayout(config_group)

        # 服务商选择
        config_layout.addWidget(QLabel("服务商:"), 0, 0)
        self.provider_combo = QComboBox()
        self.provider_combo.addItems(PROVIDERS.keys())
        self.provider_combo.currentTextChanged.connect(self.on_provider_changed)
        config_layout.addWidget(self.provider_combo, 0, 1)

        # API Key
        config_layout.addWidget(QLabel("API Key:"), 0, 2)
        key_layout = QHBoxLayout()
        self.api_key_input = QLineEdit()
        self.api_key_input.setPlaceholderText("sk-... 输入您的 API Key")
        self.api_key_input.setEchoMode(QLineEdit.Password)
        key_layout.addWidget(self.api_key_input)
        self.toggle_key_btn = QPushButton("👁")
        self.toggle_key_btn.setFixedWidth(36)
        self.toggle_key_btn.setToolTip("显示/隐藏 API Key")
        self.toggle_key_btn.clicked.connect(self.toggle_api_key_visibility)
        key_layout.addWidget(self.toggle_key_btn)
        config_layout.addLayout(key_layout, 0, 3)

        # 模型选择
        config_layout.addWidget(QLabel("模型:"), 1, 0)
        self.model_combo = QComboBox()
        self.model_combo.setEditable(True)
        config_layout.addWidget(self.model_combo, 1, 1)

        # 自定义 Base URL
        config_layout.addWidget(QLabel("Base URL (可选):"), 1, 2)
        self.base_url_input = QLineEdit()
        self.base_url_input.setPlaceholderText("留空使用默认地址")
        config_layout.addWidget(self.base_url_input, 1, 3)

        # 测试参数
        config_layout.addWidget(QLabel("测试轮数:"), 2, 0)
        self.rounds_spin = QSpinBox()
        self.rounds_spin.setRange(1, 10)
        self.rounds_spin.setValue(3)
        self.rounds_spin.setSuffix(" 轮")
        config_layout.addWidget(self.rounds_spin, 2, 1)

        config_layout.addWidget(QLabel("超时(秒):"), 2, 2)
        self.timeout_spin = QSpinBox()
        self.timeout_spin.setRange(5, 120)
        self.timeout_spin.setValue(60)
        self.timeout_spin.setSuffix(" s")
        config_layout.addWidget(self.timeout_spin, 2, 3)

        # 温度
        config_layout.addWidget(QLabel("Temperature:"), 3, 0)
        self.temp_input = QLineEdit("0.7")
        self.temp_input.setFixedWidth(80)
        config_layout.addWidget(self.temp_input, 3, 1)

        # 最大 Token
        config_layout.addWidget(QLabel("Max Tokens:"), 3, 2)
        self.max_tokens_spin = QSpinBox()
        self.max_tokens_spin.setRange(16, 16384)
        self.max_tokens_spin.setValue(512)
        config_layout.addWidget(self.max_tokens_spin, 3, 3)

        main_layout.addWidget(config_group)

        # ---- 测试内容 ----
        content_group = QGroupBox("📝 测试提示词")
        content_layout = QVBoxLayout(content_group)
        self.prompt_input = QTextEdit()
        self.prompt_input.setPlaceholderText(
            "输入测试用的提示词...\n例如：请用50字以内介绍一下你自己。"
        )
        self.prompt_input.setMaximumHeight(80)
        self.prompt_input.setText("请用20字以内回答：世界上最高的山是什么？")
        content_layout.addWidget(self.prompt_input)

        # 按钮行
        btn_layout = QHBoxLayout()
        self.test_btn = QPushButton("🚀 开始测试")
        self.test_btn.setObjectName("primaryBtn")
        self.test_btn.clicked.connect(self.start_test)
        btn_layout.addWidget(self.test_btn)

        self.stop_btn = QPushButton("⏹ 停止")
        self.stop_btn.setObjectName("dangerBtn")
        self.stop_btn.setEnabled(False)
        self.stop_btn.clicked.connect(self.request_stop)
        btn_layout.addWidget(self.stop_btn)

        self.clear_btn = QPushButton("🗑 清空日志")
        self.clear_btn.clicked.connect(self.clear_log)
        btn_layout.addWidget(self.clear_btn)

        self.export_btn = QPushButton("💾 导出结果")
        self.export_btn.clicked.connect(self.export_results)
        btn_layout.addWidget(self.export_btn)

        btn_layout.addStretch()
        content_layout.addLayout(btn_layout)
        main_layout.addWidget(content_group)

        # ---- 进度条 ----
        self.progress_bar = QProgressBar()
        self.progress_bar.setVisible(False)
        main_layout.addWidget(self.progress_bar)

        # ---- 日志与结果 ----
        splitter = QSplitter(Qt.Vertical)

        # 日志输出
        log_group = QGroupBox("📋 测试日志")
        log_layout = QVBoxLayout(log_group)
        self.log_output = QTextEdit()
        self.log_output.setReadOnly(True)
        self.log_output.setFont(QFont("Consolas", 10))
        log_layout.addWidget(self.log_output)
        splitter.addWidget(log_group)

        # 结果表格
        result_group = QGroupBox("📊 测试结果汇总")
        result_layout = QVBoxLayout(result_group)
        self.result_table = QTableWidget(0, 7)
        self.result_table.setHorizontalHeaderLabels([
            "轮次", "模型", "状态", "总耗时(s)", "首Token(ms)",
            "生成速度(t/s)", "Token数"
        ])
        self.result_table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.result_table.setEditTriggers(QTableWidget.NoEditTriggers)
        result_layout.addWidget(self.result_table)
        splitter.addWidget(result_group)

        main_layout.addWidget(splitter, 1)

        # 初始化模型列表
        self.on_provider_changed(self.provider_combo.currentText())

    # ---------- 事件处理 ----------
    def on_provider_changed(self, provider: str):
        """服务商切换"""
        info = PROVIDERS.get(provider, PROVIDERS["自定义"])
        self.model_combo.clear()
        self.model_combo.addItems(info["models"])
        if info["base_url"]:
            self.base_url_input.setText(info["base_url"])
            self.base_url_input.setEnabled(provider == "自定义")
        else:
            self.base_url_input.setText("")
            self.base_url_input.setEnabled(True)

    def toggle_api_key_visibility(self):
        """切换 API Key 可见性"""
        if self.api_key_input.echoMode() == QLineEdit.Password:
            self.api_key_input.setEchoMode(QLineEdit.Normal)
            self.toggle_key_btn.setText("🙈")
        else:
            self.api_key_input.setEchoMode(QLineEdit.Password)
            self.toggle_key_btn.setText("👁")

    def clear_log(self):
        self.log_output.clear()

    def request_stop(self):
        self._stop_requested = True
        self.log("⏹ 用户请求停止测试...", "warn")

    # ---------- 日志 ----------
    def log(self, text: str, level: str = "info"):
        """线程安全地追加日志"""
        self.log_signal.append.emit(text, level)

    def _append_log_safe(self, text: str, level: str):
        """在主线程中追加日志"""
        timestamp = datetime.now().strftime("%H:%M:%S")
        color_map = {
            "info": "#00BFFF",
            "success": "#00FF7F",
            "warn": "#FFD700",
            "error": "#FF4444",
            "highlight": "#FF69B4",
        }
        color = color_map.get(level, "#FFFFFF")
        html = f'<span style="color:#888;">[{timestamp}]</span> '
        html += f'<span style="color:{color};">{text}</span><br>'
        self.log_output.insertHtml(html)
        # 自动滚到底部
        cursor = self.log_output.textCursor()
        cursor.movePosition(QTextCursor.End)
        self.log_output.setTextCursor(cursor)

    def _update_progress_safe(self, value: int):
        self.progress_bar.setValue(value)

    def _on_test_done_safe(self, result: dict):
        """单轮测试完成后的回调"""
        self.test_results.append(result)
        self._add_table_row(result)
        self.log(
            f"✅ 第{result['round']}轮完成 | 耗时:{result['total_time']:.2f}s | "
            f"首Token:{result.get('ttft', 0)*1000:.0f}ms | "
            f"速度:{result.get('speed', 0):.1f} t/s",
            "success"
        )

    # ---------- 表格操作 ----------
    def _add_table_row(self, result: dict):
        row = self.result_table.rowCount()
        self.result_table.insertRow(row)
        items = [
            str(result.get("round", "")),
            result.get("model", ""),
            result.get("status", ""),
            f'{result.get("total_time", 0):.3f}',
            f'{result.get("ttft", 0)*1000:.0f}',
            f'{result.get("speed", 0):.1f}',
            str(result.get("total_tokens", 0)),
        ]
        for col, text in enumerate(items):
            item = QTableWidgetItem(text)
            item.setTextAlignment(Qt.AlignCenter)
            if result.get("status") == "失败":
                item.setForeground(QColor("#FF4444"))
            elif result.get("status") == "成功":
                item.setForeground(QColor("#00FF7F"))
            self.result_table.setItem(row, col, item)

    # ---------- 核心测试逻辑 ----------
    def start_test(self):
        """启动测试（在子线程中执行）"""
        # 参数校验
        api_key = self.api_key_input.text().strip()
        if not api_key:
            QMessageBox.warning(self, "参数错误", "请输入 API Key！")
            return

        provider = self.provider_combo.currentText()
        model = self.model_combo.currentText().strip()
        base_url = self.base_url_input.text().strip()
        prompt = self.prompt_input.toPlainText().strip()
        if not prompt:
            prompt = "请用20字以内回答：世界上最高的山是什么？"

        rounds = self.rounds_spin.value()
        timeout = self.timeout_spin.value()
        max_tokens = self.max_tokens_spin.value()

        try:
            temperature = float(self.temp_input.text().strip())
        except ValueError:
            temperature = 0.7

        # 重置状态
        self.test_results.clear()
        self.result_table.setRowCount(0)
        self._stop_requested = False
        self._testing = True
        self.test_btn.setEnabled(False)
        self.stop_btn.setEnabled(True)
        self.progress_bar.setVisible(True)
        self.progress_bar.setMaximum(rounds)
        self.progress_bar.setValue(0)
        self.log(f"\n{'='*60}", "highlight")
        self.log(f"🚀 开始测试 | 服务商: {provider} | 模型: {model}", "highlight")
        self.log(f"   测试轮数: {rounds} | 超时: {timeout}s | Max Tokens: {max_tokens}", "info")
        self.log(f"   提示词: {prompt[:60]}{'...' if len(prompt)>60 else ''}", "info")
        self.log(f"{'='*60}", "highlight")

        # 启动测试线程
        thread = threading.Thread(
            target=self._run_tests,
            args=(provider, model, api_key, base_url, prompt, rounds, timeout, max_tokens, temperature),
            daemon=True
        )
        thread.start()

    def _run_tests(self, provider, model, api_key, base_url, prompt, rounds, timeout, max_tokens, temperature):
        """在子线程中执行多轮测试"""
        for i in range(1, rounds + 1):
            if self._stop_requested:
                self.log("⏹ 测试已停止", "warn")
                break

            self.log(f"\n--- 第 {i}/{rounds} 轮测试开始 ---", "info")
            result = self._test_single(
                provider, model, api_key, base_url, prompt,
                timeout, max_tokens, temperature, round_num=i
            )
            self.log_signal.done.emit(result)
            self.log_signal.progress.emit(i)

            if result["status"] == "失败" and i < rounds:
                self.log("⏳ 等待 2 秒后重试...", "warn")
                time.sleep(2)

        # 测试完成，输出汇总
        self._print_summary()
        self.log_signal.append.emit(f"\n{'='*60}", "highlight")
        self.log_signal.append.emit("🏁 全部测试完成！", "highlight")

        # 恢复 UI
        self.log_signal.append.emit("__DONE__", "done")

        # 恢复按钮状态（在主线程中执行）
        QTimer.singleShot(0, self._reset_ui)

    def _test_single(self, provider, model, api_key, base_url, prompt,
                     timeout, max_tokens, temperature, round_num) -> dict:
        """单轮测试"""
        result = {
            "round": round_num,
            "model": model,
            "provider": provider,
            "status": "失败",
            "total_time": 0,
            "ttft": 0,
            "speed": 0,
            "total_tokens": 0,
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "error": "",
        }

        # 构建 URL
        if not base_url:
            info = PROVIDERS.get(provider, PROVIDERS["自定义"])
            base_url = info["base_url"]

        # 百度千帆特殊处理（使用 access_token）
        if provider == "百度千帆":
            url = f"{base_url}/completions?access_token={api_key}"
            headers = {"Content-Type": "application/json"}
        else:
            url = f"{base_url.rstrip('/')}/chat/completions"
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }

        payload = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": True,
        }

        # 百度千帆的 payload 略有不同
        if provider == "百度千帆":
            payload = {
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": max_tokens,
                "temperature": temperature,
                "stream": True,
            }

        start_time = time.time()
        first_token_time = None
        total_content = ""
        total_tokens = 0

        try:
            self.log(f"📡 发送请求到 {url}", "info")

            response = requests.post(
                url,
                headers=headers,
                json=payload,
                stream=True,
                timeout=timeout,
            )

            if response.status_code != 200:
                error_msg = f"HTTP {response.status_code}: {response.text[:200]}"
                self.log(f"❌ {error_msg}", "error")
                result["error"] = error_msg
                return result

            # 处理流式响应
            for line in response.iter_lines(decode_unicode=True):
                if self._stop_requested:
                    break

                if not line:
                    continue
                if line.startswith("data: "):
                    data_str = line[6:].strip()
                    if data_str == "[DONE]":
                        break
                    try:
                        data = json.loads(data_str)
                        choices = data.get("choices", [])
                        if not choices:
                            continue

                        delta = choices[0].get("delta", {})
                        content = delta.get("content", "")
                        if content:
                            if first_token_time is None:
                                first_token_time = time.time()
                                ttft = first_token_time - start_time
                                result["ttft"] = ttft
                                self.log(
                                    f"⚡ 首 Token 到达: {ttft*1000:.0f}ms",
                                    "success"
                                )
                            total_content += content

                        # Token 统计
                        if "usage" in data:
                            usage = data["usage"]
                            total_tokens = usage.get("total_tokens", 0)
                            result["prompt_tokens"] = usage.get("prompt_tokens", 0)
                            result["completion_tokens"] = usage.get("completion_tokens", 0)

                    except json.JSONDecodeError:
                        continue

            end_time = time.time()
            total_time = end_time - start_time
            result["total_time"] = total_time

            if first_token_time:
                generation_time = end_time - first_token_time
                char_count = len(total_content)
                # 粗略估算 tokens（中文约 1.5 字/token，英文约 4 字母/token）
                estimated_tokens = max(1, char_count // 2)
                speed = estimated_tokens / max(generation_time, 0.001)
                result["speed"] = speed
                result["total_tokens"] = total_tokens or estimated_tokens
            else:
                result["speed"] = 0
                result["total_tokens"] = 0

            if total_content:
                result["status"] = "成功"
                preview = total_content[:100]
                self.log(f"💬 回复预览: {preview}{'...' if len(total_content)>100 else ''}", "info")
            else:
                result["status"] = "失败"
                result["error"] = "返回内容为空"
                self.log("⚠️ 模型返回内容为空", "warn")

        except requests.exceptions.Timeout:
            result["error"] = f"请求超时 ({timeout}s)"
            self.log(f"⏰ 请求超时 ({timeout}s)", "error")
        except requests.exceptions.ConnectionError as e:
            result["error"] = f"连接失败: {str(e)[:100]}"
            self.log(f"🔌 连接失败: {str(e)[:100]}", "error")
        except Exception as e:
            result["error"] = str(e)[:200]
            self.log(f"❌ 异常: {str(e)[:200]}", "error")

        return result

    def _print_summary(self):
        """输出测试汇总"""
        if not self.test_results:
            return

        success_results = [r for r in self.test_results if r["status"] == "成功"]
        failed_results = [r for r in self.test_results if r["status"] == "失败"]

        self.log(f"\n{'='*60}", "highlight")
        self.log("📊 测试汇总", "highlight")
        self.log(f"{'='*60}", "highlight")
        self.log(f"总轮次: {len(self.test_results)} | 成功: {len(success_results)} | 失败: {len(failed_results)}", "info")

        if success_results:
            avg_time = sum(r["total_time"] for r in success_results) / len(success_results)
            avg_ttft = sum(r["ttft"] for r in success_results if r["ttft"]) / max(len([r for r in success_results if r["ttft"]]), 1)
            avg_speed = sum(r["speed"] for r in success_results) / len(success_results)

            self.log(f"📈 平均总耗时: {avg_time:.3f}s", "success")
            self.log(f"📈 平均首 Token: {avg_ttft*1000:.0f}ms", "success")
            self.log(f"📈 平均生成速度: {avg_speed:.1f} tokens/s", "success")

            min_time = min(r["total_time"] for r in success_results)
            max_time = max(r["total_time"] for r in success_results)
            self.log(f"📈 耗时范围: {min_time:.3f}s ~ {max_time:.3f}s", "info")

    def _reset_ui(self):
        self._testing = False
        self.test_btn.setEnabled(True)
        self.stop_btn.setEnabled(False)
        self.progress_bar.setVisible(False)
        self.progress_bar.setValue(0)

    # ---------- 导出 ----------
    def export_results(self):
        """导出测试结果为 JSON 文件"""
        if not self.test_results:
            QMessageBox.information(self, "提示", "暂无测试结果可导出")
            return

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f"llm_test_result_{timestamp}.json"
        try:
            with open(filename, "w", encoding="utf-8") as f:
                json.dump({
                    "test_time": datetime.now().isoformat(),
                    "provider": self.provider_combo.currentText(),
                    "model": self.model_combo.currentText(),
                    "total_rounds": len(self.test_results),
                    "results": self.test_results,
                }, f, ensure_ascii=False, indent=2)
            self.log(f"💾 结果已导出到: {filename}", "success")
            QMessageBox.information(self, "导出成功", f"结果已保存到:\n{filename}")
        except Exception as e:
            QMessageBox.critical(self, "导出失败", str(e))

    # ---------- 样式 ----------
    def _get_stylesheet(self) -> str:
        return """
        QMainWindow, QWidget {
            background-color: #1a1a2e;
            color: #e0e0e0;
        }
        QGroupBox {
            font-size: 13px;
            font-weight: bold;
            color: #00BFFF;
            border: 1px solid #2a2a4e;
            border-radius: 8px;
            margin-top: 12px;
            padding: 12px 8px 8px 8px;
        }
        QGroupBox::title {
            subcontrol-origin: margin;
            left: 12px;
            padding: 0 6px;
        }
        QLabel {
            color: #ccc;
            font-size: 12px;
        }
        #titleLabel {
            font-size: 20px;
            font-weight: bold;
            color: #00BFFF;
            padding: 6px;
        }
        QLineEdit, QTextEdit, QSpinBox, QComboBox {
            background-color: #16213e;
            color: #e0e0e0;
            border: 1px solid #2a2a4e;
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 12px;
        }
        QLineEdit:focus, QTextEdit:focus {
            border: 1px solid #00BFFF;
        }
        QPushButton {
            background-color: #0f3460;
            color: #e0e0e0;
            border: 1px solid #2a2a4e;
            border-radius: 4px;
            padding: 6px 16px;
            font-size: 12px;
        }
        QPushButton:hover {
            background-color: #1a4a8a;
            border-color: #00BFFF;
        }
        #primaryBtn {
            background-color: #0066cc;
            color: white;
            font-weight: bold;
            font-size: 14px;
            padding: 8px 24px;
        }
        #primaryBtn:hover {
            background-color: #0088ff;
        }
        #dangerBtn {
            background-color: #8b0000;
            color: white;
        }
        #dangerBtn:hover {
            background-color: #cc0000;
        }
        QPushButton:disabled {
            background-color: #333;
            color: #666;
        }
        QTableWidget {
            background-color: #16213e;
            color: #e0e0e0;
            border: 1px solid #2a2a4e;
            gridline-color: #2a2a4e;
            font-size: 12px;
        }
        QTableWidget::item {
            padding: 4px;
        }
        QHeaderView::section {
            background-color: #0f3460;
            color: #00BFFF;
            border: 1px solid #2a2a4e;
            padding: 4px;
            font-weight: bold;
        }
        QProgressBar {
            border: 1px solid #2a2a4e;
            border-radius: 4px;
            text-align: center;
            color: white;
            background-color: #16213e;
        }
        QProgressBar::chunk {
            background-color: #00BFFF;
            border-radius: 4px;
        }
        QScrollBar:vertical {
            background: #16213e;
            width: 10px;
        }
        QScrollBar::handle:vertical {
            background: #0f3460;
            border-radius: 5px;
        }
        """


# ============================================================
# 程序入口
# ============================================================
def main():
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    window = LLMTesterWindow()
    window.show()
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()
