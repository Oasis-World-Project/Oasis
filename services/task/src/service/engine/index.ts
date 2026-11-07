// 组装工作流引擎：各块拿到同一个 Engine 对象，互相调用时才去取（先建对象，再把各块装进去）。
import { createPlanning } from '../planning-service.ts';
import { createAdvance } from './advance.ts';
import { createChecks } from './checks.ts';
import { createFinish } from './finish.ts';
import { createOutside } from './outside.ts';
import { createRevisions } from './revisions.ts';
import type { Engine, EngineDeps } from './shared.ts';

export function createEngine(deps: EngineDeps): Engine {
  const engine = { deps } as Engine;
  engine.planning = createPlanning({
    store: deps.store,
    harness: deps.harness,
    agent: deps.agent,
    modelGateway: deps.modelGateway,
    engine: {
      transact: (taskId, decide) => engine.transact(taskId, decide),
      schedule: (snapshot, w, fx) => engine.schedule(snapshot, w, fx),
    },
    config: deps.planning,
    logger: deps.logger,
  });
  return Object.assign(
    engine,
    createOutside(engine),
    createAdvance(engine),
    createFinish(engine),
    createChecks(engine),
    createRevisions(engine),
  );
}

export { toRunBody, toTaskBody, isRevising } from './bodies.ts';
export { ACTIVE, FINAL, type Engine, type EngineDeps } from './shared.ts';
