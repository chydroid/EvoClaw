import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PersonaManager } from "./persona-manager";
import type { PersonaConfig } from "./config";

let tmpDir: string;
let storePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "persona-test-"));
  storePath = path.join(tmpDir, "personas.json");
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
});

const cfg = (over: Partial<PersonaConfig> = {}): PersonaConfig => ({
  name: "Test", title: "T", masterTerm: "owner", tone: "warm", introduction: "hi", ...over,
});

describe("PersonaManager", () => {
  it("首次加载时种子默认角色且其为激活态", () => {
    const pm = new PersonaManager(storePath);
    const list = pm.listPersonas();
    expect(list.length).toBe(1);
    expect(list[0].isActive).toBe(true);
    expect(list[0].name).toBe("EvoClaw小助手");
    expect(pm.getActivePersona()?.name).toBe("EvoClaw小助手");
  });

  it("createPersona 拒绝重名与空名", () => {
    const pm = new PersonaManager(storePath);
    expect(() => pm.createPersona(cfg({ name: "" }))).toThrow("required");
    expect(() => pm.createPersona(cfg({ name: "EvoClaw小助手" }))).toThrow("already exists");
    const p = pm.createPersona(cfg({ name: "Work" }));
    expect(p.id).toBe("Work");
    expect(p.isActive).toBe(false);
    expect(pm.listPersonas().length).toBe(2);
  });

  it("setActivePersona 切换激活态且只激活一个", () => {
    const pm = new PersonaManager(storePath);
    pm.createPersona(cfg({ name: "Work" }));
    pm.setActivePersona("Work");
    const actives = pm.listPersonas().filter((p) => p.isActive);
    expect(actives.length).toBe(1);
    expect(actives[0].name).toBe("Work");
    expect(pm.getActivePersona()?.name).toBe("Work");
  });

  it("updatePersona 可改名并同步激活指针", () => {
    const pm = new PersonaManager(storePath);
    pm.createPersona(cfg({ name: "Work" }));
    pm.setActivePersona("Work");
    const updated = pm.updatePersona("Work", { name: "Office" });
    expect(updated.name).toBe("Office");
    expect(pm.getActivePersona()?.name).toBe("Office");
  });

  it("updatePersona 不存在时抛错", () => {
    const pm = new PersonaManager(storePath);
    expect(() => pm.updatePersona("nope", { title: "x" })).toThrow("not found");
  });

  it("deletePersona 不允许删除最后一个", () => {
    const pm = new PersonaManager(storePath);
    expect(() => pm.deletePersona("EvoClaw小助手")).toThrow("last persona");
    pm.createPersona(cfg({ name: "Work" }));
    expect(pm.deletePersona("EvoClaw小助手")).toBe(true);
    expect(pm.listPersonas().length).toBe(1);
    expect(pm.getActivePersona()?.name).toBe("Work");
  });

  it("deletePersona 删除激活角色时回落到第一个", () => {
    const pm = new PersonaManager(storePath);
    pm.createPersona(cfg({ name: "Work" }));
    pm.createPersona(cfg({ name: "Play" }));
    pm.setActivePersona("Play");
    pm.deletePersona("Play");
    expect(pm.getActivePersona()?.name).toBe("EvoClaw小助手");
  });

  it("持久化：重启后恢复角色与激活态", () => {
    const pm = new PersonaManager(storePath);
    pm.createPersona(cfg({ name: "Work" }));
    pm.setActivePersona("Work");
    // 模拟重启
    const pm2 = new PersonaManager(storePath);
    expect(pm2.listPersonas().length).toBe(2);
    expect(pm2.getActivePersona()?.name).toBe("Work");
  });

  it("存储文件损坏时回落默认值", () => {
    fs.writeFileSync(storePath, "{ not valid json");
    const pm = new PersonaManager(storePath);
    expect(pm.listPersonas().length).toBe(1);
    expect(pm.getActivePersona()?.name).toBe("EvoClaw小助手");
  });

  it("getActivePersonaConfig 返回 PersonaConfig 形状", () => {
    const pm = new PersonaManager(storePath);
    const c = pm.getActivePersonaConfig();
    expect(c).toHaveProperty("name");
    expect(c).toHaveProperty("tone");
    expect(c).toHaveProperty("introduction");
  });
});