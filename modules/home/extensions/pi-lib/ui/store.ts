export type StoreListener<T> = (value: T) => void;

export interface StoreSubscription {
	unsubscribe(): void;
}

export interface ReadableStore<T> {
	get(): T;
	subscribe(listener: StoreListener<T>, options?: { emitImmediately?: boolean }): StoreSubscription;
}

export interface WritableStore<T> extends ReadableStore<T> {
	set(value: T): void;
	update(updater: (value: T) => T): void;
}

export function createStore<T>(initial: T): WritableStore<T> {
	let value = initial;
	const listeners = new Set<StoreListener<T>>();

	function emit(): void {
		for (const listener of [...listeners]) listener(value);
	}

	return {
		get: () => value,
		set(next) {
			if (Object.is(value, next)) return;
			value = next;
			emit();
		},
		update(updater) {
			this.set(updater(value));
		},
		subscribe(listener, options) {
			listeners.add(listener);
			if (options?.emitImmediately) listener(value);
			return {
				unsubscribe() {
					listeners.delete(listener);
				},
			};
		},
	};
}
