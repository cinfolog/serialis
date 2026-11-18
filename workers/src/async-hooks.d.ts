// Minimal declaration of `node:async_hooks` (available with the `nodejs_compat` flag); @types/node is not a dependency.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
