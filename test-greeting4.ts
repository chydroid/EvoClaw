// Test the source file directly via tsx
import { matchSimpleGreeting, __test } from "./packages/gateway/src/weixin-plugin-adapter";

const { SIMPLE_GREETING_ENTRIES } = __test;

const tests = ["嗯", "嗯?", "哦", "哦?", "啊", "啊?", "呦", "咦", "呀", "嗨", "哈", "哈哈"];
for (const t of tests) {
  const r = matchSimpleGreeting(t);
  // Find which category matched
  const normalized = t.trim().toLowerCase().replace(/[？?。！!，,；;：:、\s]+/g, "");
  let cat = null;
  for (const entry of SIMPLE_GREETING_ENTRIES) {
    if (entry.pattern.test(normalized)) { cat = entry.category; break; }
  }
  console.log(JSON.stringify(t), "->", cat, "->", r ? "match" : "null");
}
