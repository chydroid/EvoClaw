/**
 * verify — 项目验证系统（对标 hermes-agent agent/verify/）
 *
 * recipes.ts    — 静态检测项目框架/build/test/start/port/readiness
 * runner.ts     — 运行验证：bootstrap → build → test → start → readiness → teardown
 * environment.ts — 用户可编辑的 .evoclaw/environment.json manifest
 */

export {
  detectRecipe,
  recipeToDict,
  recipeFromDict,
  type Recipe,
} from "./recipes";

export {
  runVerify,
  phaseOk,
  verifyOk,
  type RunVerifyOptions,
  type PhaseResult,
  type ReadinessResult,
  type VerifyResult,
} from "./runner";

export {
  manifestPath,
  loadManifest,
  saveManifest,
  getRecipe,
} from "./environment";
