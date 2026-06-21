/**
 * Vosk 可选依赖的类型存根。
 * 运行时通过动态 import 加载 vosk；若未安装则优雅降级。
 * 该声明仅用于编译期类型检查，不引入实际依赖。
 */
declare module "vosk" {
  export class Model {
    constructor(modelPath: string);
  }
}
