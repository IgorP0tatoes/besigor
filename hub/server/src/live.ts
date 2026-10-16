import { EventEmitter } from 'node:events';
import type { HostInfo, Sample } from './types.js';

export type LiveEvent =
  | { type: 'live'; serverId: string; sample: Sample }
  | { type: 'status'; serverId: string; online: boolean; at: number }
  | { type: 'hello'; serverId: string; host: HostInfo }
  | { type: 'probe'; serverId: string }
  | { type: 'servers' };

/** In-process fan-out of agent events to panel subscribers (SSE) and alerts. */
class LiveBus extends EventEmitter {
  publish(e: LiveEvent) {
    this.emit('event', e);
  }
  subscribe(fn: (e: LiveEvent) => void) {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export const bus = new LiveBus();
bus.setMaxListeners(1000);
