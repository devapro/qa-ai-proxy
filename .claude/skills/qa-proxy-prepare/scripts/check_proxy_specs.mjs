#!/usr/bin/env node
// Checks QA proxy scenario specs against the scenarios qa-proxy actually loads, using the proxy's own
// parser and registry so the check cannot drift from what `QA_PROXY_ACTIVE` / `PUT /active` accept.
//
//   node check_proxy_specs.mjs --cases <file>.test-cases.md     (Markdown or Jira wiki markup)
//   node check_proxy_specs.mjs 'billing-grace-period:daysAgo=3:store=PLAY_STORE' [...]
//   add --json for structured output
//   add --allow-specified-missing to exit 0 when the only problems are scenarios that do not exist
//       yet but are specified in the cases (see below) - the gate a case-writing skill passes
//
// A cases file may carry a "QA proxy scenarios" section specifying the scenarios it needs that do not
// exist yet, so the QA run can write them (`/qa-proxy-prepare`) without re-deriving the need:
//
//   ## QA proxy scenarios                          h3. QA proxy scenarios
//   ### `comments-pro-author`                      h4. {{comments-pro-author}}
//   - **State:** every comment author is Pro       * *State:* every comment author is Pro
//   - **Rewrites:** `GET /comments_api.php` → ...    * *Rewrites:* {{GET /comments_api.php}} → ...
//   - **Params:** `proUser` (default `true`)       * *Params:* {{proUser}} (default {{true}})
//   - **The app also needs:** ...                    * *The app also needs:* ...
//   - **Cases:** TC-1, TC-2                        * *Cases:* TC-1, TC-2
//
// A spec naming a scenario that neither the proxy nor that section knows is UNSPECIFIED_SCENARIO: the
// run could not write it from the cases alone.
//
// Exit codes: 0 every spec runnable (or none found), 1 a PROBLEM was found, 2 usage error.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

// A spec sits in backticks (Markdown) or `{{...}}` (Jira wiki) shortly after the words "QA proxy";
// further specs on the same line are chained with `+`.
const SPEC_AFTER_QA_PROXY = /QA proxy[^`{]{0,40}(?:`([^`]+)`|\{\{([^}]+)\}\})/gi;
const CHAINED_SPEC = /^\s*\+\s*(?:`([^`]+)`|\{\{([^}]+)\}\})/;

// Headings in either markup: `## Title` / `h3. Title`.
const HEADING = /^(?:(#{1,6})|h([1-6])\.)\s+(.*?)\s*$/;
const SPECIFICATION_SECTION = /^QA proxy scenarios\b/i;
// An entry heading names the scenario, in backticks, `{{...}}`, or bare.
const ENTRY_NAME = /^(?:`([a-z0-9-]+)`|\{\{([a-z0-9-]+)\}\}|([a-z0-9-]+))$/;
// `- **State:** ...` / `* *State:* ...`, the colon inside or outside the bold.
const ENTRY_FIELD = /^\s*(?:[-*]\s+)?\*{1,2}(State|Rewrites|Params|The app also needs|Cases)\s*:?\*{1,2}\s*:?\s*(.*)$/i;
const FIELD_KEYS = { state: 'state', rewrites: 'rewrites', params: 'params', 'the app also needs': 'needs', cases: 'cases' };

function parseArgs(argv) {
    const args = {
        specs: [],
        cases: null,
        proxyDir: path.join(repoRoot, 'qa-proxy'),
        json: false,
        allowSpecifiedMissing: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--cases') args.cases = argv[++i];
        else if (arg === '--proxy-dir') args.proxyDir = argv[++i];
        else if (arg === '--json') args.json = true;
        else if (arg === '--allow-specified-missing') args.allowSpecifiedMissing = true;
        else if (arg.startsWith('--')) usage(`unknown option ${arg}`);
        else args.specs.push({ spec: arg, source: 'argument' });
    }
    if (!args.cases && args.specs.length === 0) usage('pass --cases <file> or at least one spec');
    return args;
}

function usage(message) {
    console.error(`check_proxy_specs: ${message}`);
    console.error(
        'usage: check_proxy_specs.mjs [--cases <file>] [--proxy-dir <dir>] [--json] [--allow-specified-missing] [spec ...]',
    );
    process.exit(2);
}

// An HTTP route (`POST /assistant/v1/chat`) names the request a case needs rewritten,
// not a scenario: it describes a scenario still to be written.
function isRoute(spec) {
    return /\s/.test(spec) && spec.includes('/');
}

export function specsFromCases(text, file) {
    const found = new Map();
    const add = (spec, index) => {
        const trimmed = spec.trim();
        if (trimmed === '' || found.has(trimmed)) return;
        const line = text.slice(0, index).split('\n').length;
        found.set(trimmed, { spec: trimmed, source: `${path.basename(file)}:${line}`, route: isRoute(trimmed) });
    };
    for (const match of text.matchAll(SPEC_AFTER_QA_PROXY)) {
        add(match[1] ?? match[2], match.index);
        let offset = match.index + match[0].length;
        let chained;
        while ((chained = CHAINED_SPEC.exec(text.slice(offset))) !== null) {
            add(chained[1] ?? chained[2], offset);
            offset += chained[0].length;
        }
    }
    return [...found.values()];
}

function headingOf(line) {
    const match = HEADING.exec(line);
    if (!match) return null;
    return { level: match[1] ? match[1].length : Number(match[2]), title: match[3] };
}

function stripMarkup(value) {
    return value.replace(/`([^`]*)`/g, '$1').replace(/\{\{([^}]*)\}\}/g, '$1').trim();
}

// The scenarios a cases file specifies for the run to write: one entry per heading under
// "QA proxy scenarios", with whichever of the five fields it fills in.
export function specificationsFromCases(text, file) {
    const lines = text.split('\n');
    const specifications = [];
    let section = null;
    let entry = null;
    const closeEntry = () => {
        if (!entry) return;
        entry.cases = stripMarkup(entry.cases ?? '').match(/TC-\d+/g) ?? [];
        specifications.push(entry);
        entry = null;
    };
    lines.forEach((line, index) => {
        const heading = headingOf(line);
        if (heading) {
            if (!section) {
                if (SPECIFICATION_SECTION.test(heading.title)) section = heading;
                return;
            }
            if (heading.level <= section.level) {
                closeEntry();
                section = null;
                return;
            }
            const name = ENTRY_NAME.exec(heading.title);
            closeEntry();
            if (name) {
                entry = {
                    name: name[1] ?? name[2] ?? name[3],
                    source: `${path.basename(file)}:${index + 1}`,
                    state: '',
                    rewrites: '',
                    params: '',
                    needs: '',
                    cases: '',
                };
            }
            return;
        }
        if (!entry) return;
        const field = ENTRY_FIELD.exec(line);
        if (field) entry[FIELD_KEYS[field[1].toLowerCase()]] = field[2].trim();
    });
    closeEntry();
    return specifications;
}

// Params a scenario reads: its declared defaults plus every `params.x` / `params?.x` / `params['x']`
// in its source. A param outside that set is silently ignored by the proxy, so the state it was meant
// to arrange never happens.
function paramsRead(scenario, source) {
    const read = new Set(Object.keys(scenario.params ?? {}));
    for (const match of source.matchAll(/params\??\.([A-Za-z_$][\w$]*)|params\[['"]([^'"]+)['"]\]/g)) {
        read.add(match[1] ?? match[2]);
    }
    return read;
}

async function loadScenarios(proxyDir) {
    const src = path.join(proxyDir, 'src');
    const scenariosDir = path.join(proxyDir, 'scenarios');
    const { parseScenarioSpec } = await import(pathToFileURL(path.join(src, 'scenario-spec.js')).href);
    const { ScenarioRegistry } = await import(pathToFileURL(path.join(src, 'scenario-registry.js')).href);

    const registry = new ScenarioRegistry(scenariosDir);
    const loadProblems = [];
    try {
        await registry.load();
    } catch (error) {
        loadProblems.push({ kind: 'BROKEN_SCENARIO', detail: error.message });
    }
    const known = new Map();
    for (const { name } of registry.list()) {
        const file = path.join(scenariosDir, `${name}.js`);
        const { default: scenario } = await import(pathToFileURL(file).href);
        known.set(name, { scenario, read: paramsRead(scenario, await readFile(file, 'utf8')) });
    }
    return { parseScenarioSpec, scenariosDir, known, loadProblems };
}

// Param names a specification's "Params" field declares: the identifiers it sets in code spans,
// e.g. `proUser` (default `true`) → proUser. A default's value is never a name.
function specifiedParams(specification) {
    const names = new Set();
    if (!specification?.params) return names;
    for (const match of specification.params.matchAll(/`([^`]+)`|\{\{([^}]+)\}\}/g)) {
        const token = (match[1] ?? match[2]).trim();
        const before = specification.params.slice(0, match.index).trimEnd();
        if (/^[A-Za-z_$][\w$]*$/.test(token) && !/default$/i.test(before)) names.add(token);
    }
    return names;
}

function checkSpec({ spec, source, route }, { parseScenarioSpec, scenariosDir, known }, specifications) {
    const result = { spec, source, entries: [], problems: [] };
    if (route) {
        result.problems.push({
            kind: 'DESCRIBED_NEED',
            detail: `"${spec}" is an HTTP route, not a scenario spec - a scenario that rewrites it has to be written`,
        });
        return result;
    }
    let entries;
    try {
        entries = parseScenarioSpec(spec);
    } catch (error) {
        result.problems.push({ kind: 'SYNTAX', detail: error.message });
        return result;
    }
    for (const { name, params } of entries) {
        const entry = known.get(name);
        const specification = specifications.get(name);
        if (!entry) {
            if (name.includes('=')) {
                result.problems.push({
                    kind: 'SYNTAX',
                    scenario: name,
                    detail: `"${name}" is a param, not a scenario - params are joined with ':' (e.g. billing-grace-period:daysAgo=3:store=PLAY_STORE); ',' starts a new scenario`,
                });
            } else if (specification) {
                result.problems.push({
                    kind: 'MISSING_SCENARIO',
                    scenario: name,
                    specified: true,
                    detail:
                        `no scenario "${name}" in ${path.relative(repoRoot, scenariosDir)}/ - specified in the cases ` +
                        `(${specification.source}): rewrites ${stripMarkup(specification.rewrites) || '<not stated>'}`,
                });
            } else {
                result.problems.push({
                    kind: 'UNSPECIFIED_SCENARIO',
                    scenario: name,
                    specified: false,
                    detail:
                        `no scenario "${name}" in ${path.relative(repoRoot, scenariosDir)}/ (known: ${[...known.keys()].join(', ') || 'none'}) ` +
                        'and no entry for it under "QA proxy scenarios" - add one (State / Rewrites / Params / The app also needs / Cases) so the run can write it',
                });
            }
            continue;
        }
        const unread = Object.keys(params).filter((param) => !entry.read.has(param));
        const specified = specifiedParams(specification);
        for (const param of unread) {
            result.problems.push({
                kind: 'UNREAD_PARAM',
                scenario: name,
                param,
                specified: specified.has(param),
                detail: specified.has(param)
                    ? `"${name}" never reads param "${param}" (reads: ${[...entry.read].join(', ') || 'none'}) - specified in the cases (${specification.source}) as an extension of the scenario`
                    : `"${name}" never reads param "${param}" (reads: ${[...entry.read].join(', ') || 'none'}) - the proxy would ignore it`,
            });
        }
        if (unread.length === 0) result.entries.push({ name, params: { ...(entry.scenario.params ?? {}), ...params } });
    }
    return result;
}

// Problems a scenario preparation step resolves from the cases alone: a specified scenario to write,
// or a specified param to add to an existing one.
function isPreparable(problem) {
    return problem.specified === true && (problem.kind === 'MISSING_SCENARIO' || problem.kind === 'UNREAD_PARAM');
}

export async function checkSpecs(specs, proxyDir, specifications = []) {
    const loaded = await loadScenarios(proxyDir);
    const byName = new Map(specifications.map((specification) => [specification.name, specification]));
    const results = specs.map((spec) => checkSpec(spec, loaded, byName));
    const problems = results.flatMap((result) => result.problems);
    const ok = loaded.loadProblems.length === 0 && problems.length === 0;
    const preparable = loaded.loadProblems.length === 0 && problems.every(isPreparable);
    return { ok, preparable, loadProblems: loaded.loadProblems, specifications, specs: results };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const specs = [...args.specs];
    let specifications = [];
    if (args.cases) {
        const text = await readFile(args.cases, 'utf8');
        specs.push(...specsFromCases(text, args.cases));
        specifications = specificationsFromCases(text, args.cases);
    }

    const report = await checkSpecs(specs, args.proxyDir, specifications);
    if (args.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        for (const problem of report.loadProblems) console.log(`PROBLEM: ${problem.kind} ${problem.detail}`);
        if (report.specs.length === 0) console.log('No QA proxy spec found - nothing to check.');
        for (const result of report.specs) {
            console.log(`SPEC ${result.spec}  (${result.source})`);
            for (const entry of result.entries) console.log(`  OK ${entry.name} ${JSON.stringify(entry.params)}`);
            for (const problem of result.problems) console.log(`  PROBLEM: ${problem.kind} ${problem.detail}`);
        }
        for (const specification of report.specifications) {
            console.log(`SPECIFIED ${specification.name}  (${specification.source}) cases: ${specification.cases.join(', ') || 'none listed'}`);
        }
        console.log(report.ok ? 'RUNNABLE: True' : 'RUNNABLE: False');
        if (!report.ok) {
            console.log(
                report.preparable
                    ? 'PREPARABLE: True - every problem is a specified scenario or param the QA run writes before the proxy starts'
                    : 'PREPARABLE: False',
            );
        }
    }
    const pass = report.ok || (args.allowSpecifiedMissing && report.preparable);
    process.exit(pass ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
