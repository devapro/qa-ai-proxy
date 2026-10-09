import { parseScenarioSpec } from './scenario-spec.js';

const controlUrl = process.env.QA_PROXY_URL ?? `http://127.0.0.1:${process.env.QA_PROXY_CONTROL_PORT ?? 8090}`;
const entries = parseScenarioSpec(process.argv[2]);

const response = await fetch(`${controlUrl}/active`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(entries),
});
const result = await response.json();
if (!response.ok) {
    console.error(`qa-proxy rejected the scenario list: ${result.error}`);
    process.exit(1);
}
const summary = result.map(({ name, params }) => `${name} ${JSON.stringify(params)}`);
console.log(summary.length > 0 ? `Active scenarios: ${summary.join(', ')}` : 'No active scenarios (pass-through)');
