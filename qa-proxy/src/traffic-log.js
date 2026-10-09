export class TrafficLog {
    #capacity;
    #entries = [];
    #byId = new Map();
    // A hook can mark a request before mockttp's async 'request-initiated' event creates its entry
    // (always so for a short-circuiting `respond`); the marks wait here until the entry exists.
    #pendingMarks = new Map();
    #sequence = 0;

    constructor(capacity) {
        this.#capacity = capacity;
    }

    requestStarted(id, method, url) {
        this.#add(id, { kind: 'http', method, url, status: null });
    }

    responseCompleted(id, status) {
        const entry = this.#byId.get(id);
        if (entry) entry.status = status;
    }

    tlsFailure(id, hostname, cause) {
        this.#add(id, { kind: 'tls-error', hostname, cause });
    }

    socketEvent(id, direction, url, detail) {
        this.#add(`${id}:${this.#sequence}`, { kind: 'socket', direction, url, ...detail });
    }

    markModified(id, scenario) {
        const entry = this.#byId.get(id) ?? this.#pending(id);
        if (!entry.modifiedBy.includes(scenario)) entry.modifiedBy.push(scenario);
    }

    markError(id, scenario, error) {
        const entry = this.#byId.get(id) ?? this.#pending(id);
        entry.errors.push({ scenario, message: String(error?.message ?? error) });
    }

    entries({ limit, modifiedOnly }) {
        const filtered = modifiedOnly
            ? this.#entries.filter((entry) => entry.modifiedBy.length > 0 || entry.errors.length > 0 || entry.kind === 'tls-error')
            : this.#entries;
        return filtered.slice(-limit);
    }

    clear() {
        this.#entries = [];
        this.#byId.clear();
        this.#pendingMarks.clear();
    }

    #pending(id) {
        if (!this.#pendingMarks.has(id)) {
            if (this.#pendingMarks.size >= this.#capacity) this.#pendingMarks.delete(this.#pendingMarks.keys().next().value);
            this.#pendingMarks.set(id, { modifiedBy: [], errors: [] });
        }
        return this.#pendingMarks.get(id);
    }

    #add(id, fields) {
        const marks = this.#pendingMarks.get(id) ?? { modifiedBy: [], errors: [] };
        this.#pendingMarks.delete(id);
        const entry = { seq: ++this.#sequence, time: new Date().toISOString(), ...marks, ...fields };
        this.#entries.push(entry);
        this.#byId.set(id, entry);
        if (this.#entries.length > this.#capacity) {
            this.#entries.shift();
            this.#byId.delete(this.#byId.keys().next().value);
        }
    }
}
