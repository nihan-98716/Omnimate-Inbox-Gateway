export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  
  private readonly failureThreshold: number;
  private readonly cooldownWindowMs: number;

  constructor(failureThreshold = 5, cooldownWindowMs = 30000) {
    this.failureThreshold = failureThreshold;
    this.cooldownWindowMs = cooldownWindowMs;
  }

  async execute<T>(action: () => Promise<T>): Promise<T> {
    this.updateState();

    if (this.state === CircuitState.OPEN) {
      throw new Error(`Circuit Breaker is OPEN. Execution blocked.`);
    }

    try {
      const result = await action();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private updateState() {
    if (this.state === CircuitState.OPEN) {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.cooldownWindowMs) {
        this.state = CircuitState.HALF_OPEN;
        console.warn('⚡ Circuit Breaker transitioned to HALF_OPEN (probing...)');
      }
    }
  }

  private onSuccess() {
    this.failureCount = 0;
    if (this.state !== CircuitState.CLOSED) {
      this.state = CircuitState.CLOSED;
      console.log('⚡ Circuit Breaker transitioned to CLOSED (healthy)');
    }
  }

  private onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    if (this.state !== CircuitState.OPEN && this.failureCount >= this.failureThreshold) {
      this.state = CircuitState.OPEN;
      console.error(`⚡ Circuit Breaker transitioned to OPEN (tripped after ${this.failureCount} failures)`);
    }
  }

  getState(): CircuitState {
    this.updateState();
    return this.state;
  }

  reset() {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = 0;
  }
}

const breakers = new Map<string, CircuitBreaker>();

export function getCircuitBreaker(key: string): CircuitBreaker {
  let cb = breakers.get(key);
  if (!cb) {
    cb = new CircuitBreaker();
    breakers.set(key, cb);
  }
  return cb;
}
