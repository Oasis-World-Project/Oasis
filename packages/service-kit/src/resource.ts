/** 服务持有的一项外部依赖（数据库、事件总线等）。 */
export interface ServiceResource {
  readonly name: string;
  /** 依赖可用时正常返回，否则抛错。/ready 会调用它。 */
  ready(): Promise<void>;
  /** 优雅关闭时调用；多个依赖按创建顺序的倒序关闭。 */
  close(): Promise<void>;
}
