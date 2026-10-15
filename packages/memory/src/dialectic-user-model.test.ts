import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DialecticUserModeler, extractClaims } from "./dialectic-user-model";

describe("extractClaims（启发式抽取）", () => {
  it("抽取肯定偏好并归入主题桶", () => {
    const claims = extractClaims("我喜欢用 TypeScript 写严格模式的代码");
    expect(claims.length).toBeGreaterThanOrEqual(1);
    const first = claims[0];
    expect(first.stance).toBe("affirm");
    expect(first.topic).toBe("语言偏好");
    expect(first.content).toContain("TypeScript");
  });

  it("否定立场优先于肯定（「我不喜欢」不被判成「喜欢」）", () => {
    const claims = extractClaims("我不喜欢啰嗦的回复");
    expect(claims).toHaveLength(1);
    expect(claims[0].stance).toBe("deny");
    expect(claims[0].topic).toBe("沟通风格");
  });

  it("英文否定/肯定均可抽取", () => {
    const deny = extractClaims("Don't use npm, it is slow here");
    expect(deny.some(c => c.stance === "deny")).toBe(true);

    const affirm = extractClaims("I prefer pnpm for all my projects");
    expect(affirm.some(c => c.stance === "affirm")).toBe(true);
  });

  it("无模式命中的消息返回空", () => {
    expect(extractClaims("今天天气怎么样")).toEqual([]);
  });

  it("指令式偏好（以后…要…/记住：）判为肯定立场（2026-10-14 评测回归）", () => {
    const task4 =
      "记住：以后回答我要更简洁，直接给结论，不要啰嗦，能一句话说清的不要写三段。";
    const claims = extractClaims(task4);
    expect(claims).toHaveLength(1);
    expect(claims[0].stance).toBe("affirm"); // 混合句：语义主体是正面指令
    expect(claims[0].topic).toBe("沟通风格");
    expect(claims[0].content).toContain("更简洁");
  });

  it("弱否定（别啰嗦类行为禁令）在无肯定标记时判为否定", () => {
    const claims = extractClaims("回答我的时候别啰嗦");
    expect(claims).toHaveLength(1);
    expect(claims[0].stance).toBe("deny");
  });

  it("强否定仍优先于肯定（我不喜欢 不被判成 喜欢）", () => {
    const claims = extractClaims("我不喜欢长篇大论，但我喜欢代码里多写注释");
    expect(claims[0].stance).toBe("deny");
  });

  it("每轮最多 5 条，过滤过短句子", () => {
    const long = Array.from({ length: 10 }, (_, i) => `我喜欢工具${i}号`).join("。");
    expect(extractClaims(long).length).toBeLessThanOrEqual(5);
    expect(extractClaims("ok")).toEqual([]);
  });
});

describe("DialecticUserModeler", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dialectic-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createModeler(userId = "default"): DialecticUserModeler {
    return new DialecticUserModeler(tmpDir, userId);
  }

  it("observeTurn 抽取 claim 并综合出信念", async () => {
    const m = createModeler();
    const affected = await m.observeTurn("s1", "我喜欢用 pnpm 管理依赖");
    expect(affected).toHaveLength(1);
    expect(affected[0].status).toBe("synthesized");

    const beliefs = m.getBeliefs();
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0].topic).toBe("工具偏好");
    expect(beliefs[0].belief).toContain("pnpm");
    expect(beliefs[0].confidence).toBeGreaterThan(0);
  });

  it("重复主张走证据加成而非重复计数", async () => {
    const m = createModeler();
    await m.observeTurn("s1", "我喜欢用 pnpm 管理依赖");
    await m.observeTurn("s2", "我喜欢用 pnpm 管理依赖");
    expect(m.getClaims()).toHaveLength(1);
    expect(m.getBeliefs()[0].evidenceCount).toBe(1);
    expect(m.getClaims()[0].sessionIds).toEqual(["s1", "s2"]);
    expect(m.getClaims()[0].confidence).toBeGreaterThan(0.6);
  });

  it("辩证：对立主张让旧主张 challenged，新主张综合为信念", async () => {
    const m = createModeler();
    await m.observeTurn("s1", "我喜欢用 npm 管理依赖");
    await m.observeTurn("s2", "我不喜欢用 npm，太慢了");

    const claims = m.getClaims();
    const challenged = claims.filter(c => c.status === "challenged");
    const synthesized = claims.filter(c => c.status === "synthesized");
    expect(challenged).toHaveLength(1);
    expect(challenged[0].stance).toBe("affirm");
    expect(synthesized).toHaveLength(1);
    expect(synthesized[0].stance).toBe("deny");

    const belief = m.getBeliefs()[0];
    expect(belief.stance).toBe("deny");
    expect(belief.dialecticAdjusted).toBe(true);
    // 辩证折减后置信度应低于未折减基线
    expect(belief.confidence).toBeLessThan(0.6);
  });

  it("跨 topic 不互相挑战", async () => {
    const m = createModeler();
    await m.observeTurn("s1", "我喜欢简洁的回复");
    await m.observeTurn("s2", "我喜欢用 docker 部署");
    expect(m.getClaims().every(c => c.status === "synthesized")).toBe(true);
    expect(m.getBeliefs()).toHaveLength(2);
  });

  it("renderModel 产出带 fence 风格头的画像文本，空模型为空串", async () => {
    const m = createModeler();
    expect(m.renderModel()).toBe("");
    await m.observeTurn("s1", "我喜欢用 vim 编辑代码");
    const rendered = m.renderModel();
    expect(rendered).toContain("[辩证用户模型]");
    expect(rendered).toContain("[工具偏好]");
  });

  it("持久化：新实例从磁盘恢复 claims 与 beliefs", async () => {
    const m1 = createModeler();
    await m1.observeTurn("s1", "我喜欢用 vim 编辑代码");
    await m1.flush();

    const filePath = path.join(tmpDir, "memory", "dialectic", "default.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const m2 = createModeler();
    expect(m2.getClaims()).toHaveLength(1);
    expect(m2.getBeliefs()).toHaveLength(1);
    expect(m2.renderModel()).toContain("vim");
  });

  it("userId 隔离：不同用户写不同文件", async () => {
    const a = createModeler("alice");
    const b = createModeler("bob");
    await a.observeTurn("s1", "我喜欢用 rust 写服务");
    await a.flush();
    expect(b.getClaims()).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir, "memory", "dialectic", "alice.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "memory", "dialectic", "bob.json"))).toBe(false);
  });

  it("export 包含 version/userId/claims/beliefs", async () => {
    const m = createModeler("carol");
    await m.observeTurn("s1", "我喜欢详细的技术解释");
    const exported = m.export();
    expect(exported.version).toBe(1);
    expect(exported.userId).toBe("carol");
    expect(exported.claims).toHaveLength(1);
    expect(exported.beliefs).toHaveLength(1);
  });
});
