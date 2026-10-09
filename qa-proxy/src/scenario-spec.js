export function parseScenarioSpec(spec) {
    const trimmed = (spec ?? '').trim();
    if (trimmed === '' || trimmed === 'none') return [];
    if (trimmed.startsWith('[')) return JSON.parse(trimmed);
    return trimmed
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            const [name, ...pairs] = entry.split(':');
            const params = Object.fromEntries(
                pairs.map((pair) => {
                    const separator = pair.indexOf('=');
                    if (separator <= 0) throw new Error(`"${pair}" in "${entry}" is not key=value`);
                    return [pair.slice(0, separator), parseValue(pair.slice(separator + 1))];
                }),
            );
            return { name, params };
        });
}

function parseValue(raw) {
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}
