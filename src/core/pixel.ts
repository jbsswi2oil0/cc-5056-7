import type { CompositeOptions, SampleChain } from '../core/types';
import { integrateChainDetailed } from '../core/compositor';

export interface PixelEvaluation {
  result: import('../core/types').CompositeResult;
  events: import('../core/types').ChainEvent[];
}

/** Evaluate one pixel chain and always collect the event chain. */
export function evaluatePixel(chain: SampleChain, options: CompositeOptions = {}): PixelEvaluation {
  const out = integrateChainDetailed(chain, { ...options, collectEvents: true });
  return { result: out.result, events: out.events };
}
