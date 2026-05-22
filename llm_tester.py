#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
🦞 EvoClaw LLM 通用测试工具
==============================
图形界面输入 API Key，测试各大 LLM 服务商：
- 连通性测试（能否正常工作）
- 响应时间（总耗时、首Token时间 TTFT）
- 生成速度（tokens/s）
- Token 用量统计
- 多轮测试取平均值

支持：OpenAI / DeepSeek / 通义千问 / 月之暗面 / 智谱GLM / 零一万物 / 百度千帆 / 自定义
"""

import sys
import json
import time
import threading
import requests
from datetime import datetime

try:
    from PyQt5.QtWidgets import (
        QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
        QLabel, QLineEdit, QPushButton, QComboBox, QSpinBox, QTextEdit,
        QGroupBox, QGridLayout, QCheckBox, QMessageBox, QSplitter,
        QTabWidget, QTableWidget, QTableWidgetItem, QHeaderView,
        QFileDialog, QProgressBar, QFrame
    )
    from PyQt5.QtCore import Qt, QThread, pyqtSignal, QMutex, QMutexLocker
    from PyQt5.QtGui import QFont, QPalette, QColor, QTextCursor
except ImportError:
    print("❌ 请安装 PyQt5: pip install PyQt5")
    sys.exit(1)

# ============================================================
# 服务商配置
# ============================================================
PROVIDERS = {
    "OpenAI": {
        "endpoint": "https://api.openai.com/v1",
        "models": ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4", "gpt-3.5-turbo"],
        "default_model": "gpt-4o-mini"
    },
    "DeepSeek": {
        "endpoint": "https://api.deepseek.com/v1",
        "models": ["deepseek-chat", "deepseek-reasoner"],
        "default_model": "deepseek-chat"
    },
    "通义千问 (Qwen)": {
        "endpoint": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "models": ["qwen-plus", "qwen-max", "qwen-turbo", "qwen-long", "qwen2.5-72b-instruct"],
        "default_model": "qwen-plus"
    },
    "月之暗面 (Moonshot)": {
        "endpoint": "https://api.moonshot.cn/v1",
        "models": ["moonshot-v1-8k", "moonshot-v1-32k", "moonshot-v1-128k"],
        "default_model": "moonshot-v1-8k"
    },
    "智谱 (GLM)": {
        "endpoint": "https://open.bigmodel.cn/api/paas/v4",
        "models": ["glm-4-plus", "glm-4-flash", "glm-4-air", "glm-4-airx", "glm-4-long"],
        "default_model": "glm-4-flash"
    },
    "零一万物 (Yi)": {
        "endpoint": "https://api.lingyiwanwu.com/v1",
        "models": ["yi-lightning", "yi-large", "yi-medium", "yi-vision"],
        "default_model": "yi-lightning"
    },
    "百度千帆": {
        "endpoint": "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat",
        "models": ["ERNIE-4.0", "ERNIE-3.5", "ERNIE-Speed", "ERNIE-Lite"],
        "default_model": "ERNIE-Speed"
    },
    "自定义": {
        "endpoint": "",
        "models": ["自定义模型"],
        "default_model": "自定义模型"
    }
}

# 测试提示词模板
PROMPT_TEMPLATES = {
    "简短问答": "请用一句话回答：什么是人工智能？",
    "短文生成": "请用100字左右介绍深度学习的基本概念。",
    "逻辑推理": "如果所有的A都是B，所有的B都是C，那么所有的A都是C吗？请解释你的推理过程。",
    "代码生成": "请用Python写一个快速排序算法，并附上注释。",
    "翻译任务": "请将以下英文翻译成中文：'The quick brown fox jumps over the lazy dog.'",
    "长文本": "请详细介绍神经网络的发展历史，包括感知机、多层感知机、CNN、RNN、Transformer等关键里程碑，不少于300字。"
}


# ============================================================
# 测试线程
# ============================================================
class TestThread(QThread):
    """多线程执行 LLM 测试"""
    log_signal = pyqtSignal(str, str)  # (type, message)
    result_signal = pyqtSignal(dict)
    progress_signal = pyqtSignal(int, int)
    finished_signal = pyqtSignal()

    def __init__(self, config, parent=None):
        super().__init__(parent)
        self.config = config
        self._stop_flag = False
        self.mutex = QMutex()

    def stop(self):
        with QMutexLocker(self.mutex):
            self._stop_flag = True

    def is_stopped(self):
        with QMutexLocker(self.mutex):
            return self._stop_flag

    def run(self):
        config = self.config
        provider = config["provider"]
        api_key = config["api_key"]
        model = config["model"]
        endpoint = config["endpoint"]
        prompt = config["prompt"]
        rounds = config["rounds"]
        stream = config["stream"]
        timeout = config["timeout"]

        results = []
        success_count = 0
        fail_count = 0

        for i in range(1, rounds + 1):
            if self.is_stopped():
                self.log_signal.emit("warn", f"⏹ 测试已手动停止（第 {i} 轮）")
                break

            self.progress_signal.emit(i, rounds)
            self.log_signal.emit("info", f"\n{'='*50}")
            self.log_signal.emit("info", f"📌 第 {i}/{rounds} 轮测试开始...")
            self.log_signal.emit("info", f"  服务商: {provider}")
            self.log_signal.emit("info", f"  模型: {model}")
            self.log_signal.emit("info", f"  端点: {endpoint}")
            self.log_signal.emit("info", f"  流式: {'是' if stream else '否'}")
            self.log_signal.emit("info", f"  超时: {timeout}s")
            self.log_signal.emit("info", f"  提示词: {prompt[:80]}{'...' if len(prompt) > 80 else ''}")

            result = self._test_single_round(provider, api_key, model, endpoint, prompt, stream, timeout)

            if result["success"]:
                success_count += 1
                self.log_signal.emit("success",
                    f"✅ 第 {i} 轮成功 | 总耗时: {result['total_time_ms']:.0f}ms | "
                    f"TTFT: {result.get('ttft_ms', 0):.0f}ms | "
                    f"速度: {result.get('speed_tok_s', 0):.1f} tok/s | "
                    f"输出Tokens: {result.get('output_tokens', 0)}"
                )
            else:
                fail_count += 1
                self.log_signal.emit("error",
                    f"❌ 第 {i} 轮失败: {result.get('error', '未知错误')}"
                )

            self.result_signal.emit(result)
            results.append(result)

            if i < rounds and not self.is_stopped():
                time.sleep(0.5)

        # 汇总
        summary = self._generate_summary(results, success_count, fail_count)
        self.log_signal.emit("info", f"\n{'='*50}")
        self.log_signal.emit("info", "📊 测试汇总:")
        for line in summary["lines"]:
            self.log_signal.emit(line["type"], line["text"])

        self.finished_signal.emit()

    def _test_single_round(self, provider, api_key, model, endpoint, prompt, stream, timeout):
        result = {
            "success": False,
            "total_time_ms": 0,
            "ttft_ms": 0,
            "speed_tok_s": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "response_text": "",
            "error": "",
            "timestamp": datetime.now().strftime("%H:%M:%S")
        }

        try:
            headers = {
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}"
            }

            payload = {
                "model": model,
                "messages": [{"role": "user", "content": prompt}],
                "stream": stream,
                "max_tokens": 2048
            }

            url = endpoint
            if provider == "百度千帆":
                access_token = self._get_baidu_access_token(api_key)
                if not access_token:
                    result["error"] = "获取百度千帆 access_token 失败"
                    return result
                url = f"{endpoint}/completions?access_token={access_token}"
                headers = {"Content-Type": "application/json"}
                payload = {
                    "messages": [{"role": "user", "content": prompt}],
                    "stream": stream
                }

            start_time = time.time()
            first_token_time = None

            if stream:
                response = requests.post(
                    url, headers=headers, json=payload,
                    stream=True, timeout=timeout
                )

                if response.status_code != 200:
                    result["error"] = f"HTTP {response.status_code}: {response.text[:200]}"
                    result["total_time_ms"] = (time.time() - start_time) * 1000
                    return result

                full_content = ""
                output_tokens = 0
                for chunk in response.iter_lines():
                    if self.is_stopped():
                        break
                    if chunk:
                        chunk_str = chunk.decode('utf-8', errors='ignore')
                        if chunk_str.startswith("data: "):
                            data_str = chunk_str[6:]
                            if data_str.strip() == "[DONE]":
                                break
                            try:
                                data = json.loads(data_str)
                                choices = data.get("choices", [])
                                if choices:
                                    delta = choices[0].get("delta", {})
                                    content = delta.get("content", "")
                                    if content:
                                        if first_token_time is None:
                                            first_token_time = time.time()
                                            ttft = (first_token_time - start_time) * 1000
                                            result["ttft_ms"] = round(ttft, 1)
                                        full_content += content
                                        output_tokens += 1
                            except json.JSONDecodeError:
                                continue

                end_time = time.time()
                total_time = (end_time - start_time) * 1000
                result["total_time_ms"] = round(total_time, 1)
                result["response_text"] = full_content
                result["output_tokens"] = output_tokens
                result["input_tokens"] = len(prompt)
                result["total_tokens"] = result["input_tokens"] + output_tokens

                if total_time > 0 and output_tokens > 0:
                    result["speed_tok_s"] = round(output_tokens / (total_time / 1000), 1)

                result["success"] = True

            else:
                response = requests.post(
                    url, headers=headers, json=payload,
                    timeout=timeout
                )

                end_time = time.time()
                total_time = (end_time - start_time) * 1000
                result["total_time_ms"] = round(total_time, 1)

                if response.status_code == 200:
                    data = response.json()
                    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                    usage = data.get("usage", {})

                    result["response_text"] = content
                    result["input_tokens"] = usage.get("prompt_tokens", len(prompt))
                    result["output_tokens"] = usage.get("completion_tokens", len(content))
                    result["total_tokens"] = usage.get("total_tokens",
                                                        result["input_tokens"] + result["output_tokens"])

                    if result["output_tokens"] > 0 and total_time > 0:
                        result["speed_tok_s"] = round(
                            result["output_tokens"] / (total_time / 1000), 1)

                    result["success"] = True
                else:
                    result["error"] = f"HTTP {response.status_code}: {response.text[:200]}"

        except requests.exceptions.Timeout:
            result["error"] = f"请求超时 ({timeout}s)"
            result["total_time_ms"] = timeout * 1000
        except requests.exceptions.ConnectionError as e:
            result["error"] = f"连接失败: {str(e)[:100]}"
        except Exception as e:
            result["error"] = f"异常: {str(e)[:200]}"
            if result["total_time_ms"] == 0:
                result["total_time_ms"] = round((time.time() - start_time) * 1000, 1)

        return result

    def _get_baidu_access_token(self, api_key):
        try:
            parts = api_key.split("|")
            if len(parts) != 2:
                self.log_signal.emit("warn", "⚠️ 百度千帆 API Key 格式应为: client_id|client_secret")
                return None
            client_id, client_secret = parts[0].strip(), parts[1].strip()
            url = "https://aip.baidubce.com/oauth/2.0/token"
            params = {
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret
            }
            resp = requests.get(url, params=params, timeout=10)
            if resp.status_code == 200:
                return resp.json().get("access_token")
            return None
        except Exception as e:
            self.log_signal.emit("error", f"获取百度 access_token 失败: {str(e)[:100]}")
            return None

    def _generate_summary(self, results, success_count, fail_count):
        lines = []
        total_rounds = len(results)
        lines.append({"type": "info", "text": f"  总轮次: {total_rounds} | 成功: {success_count} | 失败: {fail_count}"})

        success_results = [r for r in results if r["success"]]
        if success_results:
            avg_total = sum(r["total_time_ms"] for r in success_results) / len(success_results)
            avg_ttft = sum(r.get("ttft_ms", 0) for r in success_results) / len(success_results)
            avg_speed = sum(r.get("speed_tok_s", 0) for r in success_results) / len(success_results)
            avg_output = sum(r.get("output_tokens", 0) for r in success_results) / len(success_results)

            lines.append({"type": "success", "text": f"  ✅ 平均总耗时: {avg_total:.0f}ms"})
            if avg_ttft > 0:
                lines.append({"type": "success", "text": f"  ✅ 平均TTFT: {avg_ttft:.0f}ms"})
            if avg_speed > 0:
                lines.append({"type": "success", "text": f"  ✅ 平均生成速度: {avg_speed:.1f} tok/s"})
            lines.append({"type": "success", "text": f"  ✅ 平均输出长度: {avg_output:.0f} tokens"})

        return {"lines": lines}


# ============================================================
# 主窗口
# ============================================================
class LLMTesterWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.test_thread = None
        self.results = []
        self.init_ui()

    def init_ui(self):
        self.setWindowTitle("🦞 EvoClaw LLM 通用测试工具")
        self.setMinimumSize(1100, 750)
        self.setStyleSheet(self._get_dark_style())

        central = QWidget()
        self.setCentralWidget(central)
        main_layout = QHBoxLayout(central)
        main_layout.setSpacing(10)
        main_layout.setContentsMargins(10, 10, 10, 10)

        # ===== 左侧配置面板 =====
        left_panel = QWidget()
        left_panel.setFixedWidth(400)
        left_layout = QVBoxLayout(left_panel)
        left_layout.setSpacing(8)

        # 服务商配置
        gb_provider = QGroupBox("🔧 服务商配置")
        gb_layout = QGridLayout(gb_provider)

        gb_layout.addWidget(QLabel("服务商:"), 0, 0)
        self.cb_provider = QComboBox()
        self.cb_provider.addItems(PROVIDERS.keys())
        self.cb_provider.currentTextChanged.connect(self._on_provider_changed)
        gb_layout.addWidget(self.cb_provider, 0, 1)

        gb_layout.addWidget(QLabel("API Key:"), 1, 0)
        key_layout = QHBoxLayout()
        self.le_api_key = QLineEdit()
        self.le_api_key.setEchoMode(QLineEdit.Password)
        self.le_api_key.setPlaceholderText("输入您的 API Key...")
        key_layout.addWidget(self.le_api_key)
        self.cb_show_key = QCheckBox("显示")
        self.cb_show_key.stateChanged.connect(
            lambda: self.le_api_key.setEchoMode(
                QLineEdit.Normal if self.cb_show_key.isChecked() else QLineEdit.Password
            )
        )
        key_layout.addWidget(self.cb_show_key)
        gb_layout.addLayout(key_layout, 1, 1)

        gb_layout.addWidget(QLabel("模型:"), 2, 0)
        self.cb_model = QComboBox()
        gb_layout.addWidget(self.cb_model, 2, 1)

        gb_layout.addWidget(QLabel("API端点:"), 3, 0)
        self.le_endpoint = QLineEdit()
        self.le_endpoint.setPlaceholderText("API 端点 URL")
        gb_layout.addWidget(self.le_endpoint, 3, 1)

        left_layout.addWidget(gb_provider)

        # 测试参数
        gb_params = QGroupBox("⚙️ 测试参数")
        params_layout = QGridLayout(gb_params)

        params_layout.addWidget(QLabel("测试轮数:"), 0, 0)
        self.spin_rounds = QSpinBox()
        self.spin_rounds.setRange(1, 20)
        self.spin_rounds.setValue(3)
        self.spin_rounds.setSuffix(" 轮")
        params_layout.addWidget(self.spin_rounds, 0, 1)

        params_layout.addWidget(QLabel("超时(秒):"), 1, 0)
        self.spin_timeout = QSpinBox()
        self.spin_timeout.setRange(5, 300)
        self.spin_timeout.setValue(60)
        self.spin_timeout.setSuffix(" s")
        params_layout.addWidget(self.spin_timeout, 1, 1)

        self.cb_stream = QCheckBox("流式输出 (Stream)")
        self.cb_stream.setChecked(True)
        params_layout.addWidget(self.cb_stream, 2, 0, 1, 2)

        left_layout.addWidget(gb_params)

        # 提示词
        gb_prompt = QGroupBox("📝 测试提示词")
        prompt_layout = QVBoxLayout(gb_prompt)

        self.cb_prompt_template = QComboBox()
        self.cb_prompt_template.addItems(PROMPT_TEMPLATES.keys())
        self.cb_prompt_template.currentTextChanged.connect(self._on_prompt_template_changed)
        prompt_layout.addWidget(self.cb_prompt_template)

        self.te_prompt = QTextEdit()
        self.te_prompt.setMaximumHeight(120)
        self.te_prompt.setPlainText(PROMPT_TEMPLATES["简短问答"])
        prompt_layout.addWidget(self.te_prompt)

        left_layout.addWidget(gb_prompt)

        # 控制按钮
        btn_layout = QHBoxLayout()
        self.btn_start = QPushButton("🚀 开始测试")
        self.btn_start.setMinimumHeight(40)
        self.btn_start.setObjectName("btn_start")
        self.btn_start.clicked.connect(self._start_test)
        btn_layout.addWidget(self.btn_start)

        self.btn_stop = QPushButton("⏹ 停止")
        self.btn_stop.setMinimumHeight(40)
        self.btn_stop.setObjectName("btn_stop")
        self.btn_stop.setEnabled(False)
        self.btn_stop.clicked.connect(self._stop_test)
        btn_layout.addWidget(self.btn_stop)

        left_layout.addLayout(btn_layout)

        # 进度条
        self.progress_bar = QProgressBar()
        self.progress_bar.setVisible(False)
        left_layout.addWidget(self.progress_bar)

        # 导出按钮
        self.btn_export = QPushButton("💾 导出测试报告")
        self.btn_export.clicked.connect(self._export_report)
        left_layout.addWidget(self.btn_export)

        left_layout.addStretch()

        # ===== 右侧日志面板 =====
        right_panel = QWidget()
        right_layout = QVBoxLayout(right_panel)
        right_layout.setSpacing(5)

        gb_log = QGroupBox("📋 测试日志")
        log_layout = QVBoxLayout(gb_log)

        self.te_log = QTextEdit()
        self.te_log.setReadOnly(True)
        self.te_log.setFont(QFont("Consolas", 10))
        log_layout.addWidget(self.te_log)

        btn_clear = QPushButton("🗑 清空日志")
        btn_clear.clicked.connect(lambda: self.te_log.clear())
        log_layout.addWidget(btn_clear)

        right_layout.addWidget(gb_log)

        # 分割器
        splitter = QSplitter(Qt.Horizontal)
        splitter.addWidget(left_panel)
        splitter.addWidget(right_panel)
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        main_layout.addWidget(splitter)

        # 初始化
        self._on_provider_changed(self.cb_provider.currentText())

    def _on_provider_changed(self, provider):
        config = PROVIDERS.get(provider, PROVIDERS["自定义"])
        self.cb_model.clear()
        self.cb_model.addItems(config["models"])
        if config["default_model"] in config["models"]:
            self.cb_model.setCurrentText(config["default_model"])

        if provider == "自定义":
            self.le_endpoint.setPlaceholderText("输入自定义 API 端点 URL")
            self.le_endpoint.setText("")
            self.le_endpoint.setReadOnly(False)
        else:
            self.le_endpoint.setText(config["endpoint"])
            self.le_endpoint.setReadOnly(True)

        if provider == "百度千帆":
            self.le_api_key.setPlaceholderText("输入 client_id|client_secret")
        else:
            self.le_api_key.setPlaceholderText("输入您的 API Key...")

    def _on_prompt_template_changed(self, template):
        if template in PROMPT_TEMPLATES:
            self.te_prompt.setPlainText(PROMPT_TEMPLATES[template])

    def _log(self, msg_type, message):
        colors = {
            "info": "#89b4fa",
            "success": "#a6e3a1",
            "error": "#f38ba8",
            "warn": "#fab387"
        }
        color = colors.get(msg_type, "#cdd6f4")
        timestamp = datetime.now().strftime("%H:%M:%S")
        html = f'<span style="color: #6c7086;">[{timestamp}]</span> <span style="color: {color};">{message}</span><br>'
        self.te_log.append(html)
        cursor = self.te_log.textCursor()
        cursor.movePosition(QTextCursor.End)
        self.te_log.setTextCursor(cursor)

    def _start_test(self):
        api_key = self.le_api_key.text().strip()
        if not api_key:
            QMessageBox.warning(self, "提示", "请输入 API Key！")
            return

        provider = self.cb_provider.currentText()
        model = self.cb_model.currentText()
        endpoint = self.le_endpoint.text().strip()
        prompt = self.te_prompt.toPlainText().strip()

        if not prompt:
            QMessageBox.warning(self, "提示", "请输入测试提示词！")
            return

        if provider == "自定义" and not endpoint:
            QMessageBox.warning(self, "提示", "自定义模式请输入 API 端点 URL！")
            return

        config = {
            "provider": provider,
            "api_key": api_key,
            "model": model,
            "endpoint": endpoint,
            "prompt": prompt,
            "rounds": self.spin_rounds.value(),
            "stream": self.cb_stream.isChecked(),
            "timeout": self.spin_timeout.value()
        }

        self.results = []
        self.te_log.clear()

        self.btn_start.setEnabled(False)
        self.btn_stop.setEnabled(True)
        self.progress_bar.setVisible(True)
        self.progress_bar.setMaximum(config["rounds"])
        self.progress_bar.setValue(0)

        self.test_thread = TestThread(config)
        self.test_thread.log_signal.connect(self._log)
        self.test_thread.result_signal.connect(self._on_result)
        self.test_thread.progress_signal.connect(self._on_progress)
        self.test_thread.finished_signal.connect(self._on_test_finished)
        self.test_thread.start()

        self._log("info", f"🚀 开始测试 | {provider} → {model} | {config['rounds']} 轮")

    def _stop_test(self):
        if self.test_thread and self.test_thread.isRunning():
            self.test_thread.stop()
            self._log("warn", "⏹ 正在停止测试...")

    def _on_result(self, result):
        self.results.append(result)

    def _on_progress(self, current, total):
        self.progress_bar.setValue(current)

    def _on_test_finished(self):
        self.btn_start.setEnabled(True)
        self.btn_stop.setEnabled(False)
        self.progress_bar.setVisible(False)

        success_count = sum(1 for r in self.results if r["success"])
        total = len(self.results)
        self._log("info", f"\n🏁 测试完成！成功: {success_count}/{total}")

    def _export_report(self):
        if not self.results:
            QMessageBox.information(self, "提示", "暂无测试结果可导出。")
            return

        filepath, _ = QFileDialog.getSaveFileName(
            self, "保存测试报告",
            f"llm_test_report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json",
            "JSON Files (*.json)"
        )
        if not filepath:
            return

        report = {
            "tool": "🦞 EvoClaw LLM 通用测试工具",
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "config": {
                "provider": self.cb_provider.currentText(),
                "model": self.cb_model.currentText(),
                "endpoint": self.le_endpoint.text(),
                "rounds": self.spin_rounds.value(),
                "stream": self.cb_stream.isChecked(),
                "prompt": self.te_prompt.toPlainText()
            },
            "summary": {
                "total": len(self.results),
                "success": sum(1 for r in self.results if r["success"]),
                "fail": sum(1 for r in self.results if not r["success"])
            },
            "results": self.results
        }

        try:
            with open(filepath, "w", encoding="utf-8") as f:
                json.dump(report, f, ensure_ascii=False, indent=2)
            self._log("success", f"✅ 报告已导出: {filepath}")
        except Exception as e:
            self._log("error", f"❌ 导出失败: {str(e)[:100]}")

    def _get_dark_style(self):
        return """
        QMainWindow, QWidget {
            background-color: #1e1e2e;
            color: #cdd6f4;
        }
        QGroupBox {
            font-weight: bold;
            border: 1px solid #45475a;
            border-radius: 8px;
            margin-top: 12px;
            padding-top: 16px;
            font-size: 13px;
            background-color: #181825;
        }
        QGroupBox::title {
            subcontrol-origin: margin;
            left: 12px;
            padding: 0 6px;
        }
        QLabel {
            color: #a6adc8;
            font-size: 12px;
        }
        QLineEdit, QTextEdit, QComboBox, QSpinBox {
            background-color: #313244;
            color: #cdd6f4;
            border: 1px solid #45475a;
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 12px;
        }
        QLineEdit:focus, QTextEdit:focus, QComboBox:focus, QSpinBox:focus {
            border-color: #89b4fa;
        }
        QComboBox::drop-down {
            border: none;
            padding-right: 8px;
        }
        QComboBox QAbstractItemView {
            background-color: #313244;
            color: #cdd6f4;
            selection-background-color: #45475a;
            border: 1px solid #45475a;
        }
        QPushButton {
            background-color: #45475a;
            color: #cdd6f4;
            border: none;
            border-radius: 6px;
            padding: 8px 16px;
            font-size: 13px;
            font-weight: bold;
        }
        QPushButton:hover {
            background-color: #585b70;
        }
        QPushButton:pressed {
            background-color: #313244;
        }
        QPushButton:disabled {
            background-color: #313244;
            color: #6c7086;
        }
        QPushButton#btn_start {
            background-color: #a6e3a1;
            color: #1e1e2e;
        }
        QPushButton#btn_start:hover {
            background-color: #94e2d5;
        }
        QPushButton#btn_stop {
            background-color: #f38ba8;
            color: #1e1e2e;
        }
        QPushButton#btn_stop:hover {
            background-color: #eba0ac;
        }
        QCheckBox {
            color: #a6adc8;
            font-size: 12px;
        }
        QCheckBox::indicator {
            width: 16px;
            height: 16px;
            border-radius: 3px;
            border: 1px solid #45475a;
            background-color: #313244;
        }
        QCheckBox::indicator:checked {
            background-color: #89b4fa;
            border-color: #89b4fa;
        }
        QProgressBar {
            border: 1px solid #45475a;
            border-radius: 4px;
            text-align: center;
            color: #cdd6f4;
            background-color: #313244;
            height: 20px;
        }
        QProgressBar::chunk {
            background-color: #89b4fa;
            border-radius: 3px;
        }
        QScrollBar:vertical {
            background-color: #1e1e2e;
            width: 10px;
            border: none;
        }
        QScrollBar::handle:vertical {
            background-color: #45475a;
            border-radius: 5px;
            min-height: 20px;
        }
        QScrollBar::handle:vertical:hover {
            background-color: #585b70;
        }
        QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
            height: 0px;
        }
        """


# ============================================================
# 入口
# ============================================================
def main():
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    window = LLMTesterWindow()
    window.show()
    sys.exit(app.exec_())


if __name__ == "__main__":
    main()
