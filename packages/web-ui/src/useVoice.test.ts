import { describe, it, expect } from "vitest";
import { isSpeechRecognitionSupported } from "./useVoice";

describe("isSpeechRecognitionSupported", () => {
  it("在 Node 环境中应返回 false", () => {
    expect(isSpeechRecognitionSupported()).toBe(false);
  });
});
